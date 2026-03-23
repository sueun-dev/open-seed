# Open Seed v2 — System Operation Manual

> 이 문서는 Open Seed의 내부 작동 방식을 코드 레벨로 정밀하게 설명한다.

---

## 1. 실행 시작

사용자가 태스크를 입력하면 시스템이 작동한다.

```bash
openseed run "Build a REST API with JWT authentication"
```

CLI(`openseed_cli/commands/run.py`)가 `compile_graph()`를 호출하여 LangGraph `StateGraph`를 컴파일하고, `initial_state()`로 초기 상태를 생성한 뒤, `graph.ainvoke(state)`로 파이프라인을 시작한다.

### 초기 상태 (PipelineState)

```python
{
    "task": "Build a REST API with JWT authentication",
    "working_dir": "/Users/me/projects/my-api",
    "provider": "claude",         # claude / codex / both
    "plan": None,
    "implementation": None,
    "qa_result": None,
    "retry_count": 0,
    "max_retries": 10,
    "deploy_result": None,
    "relevant_memories": [],
    "skip_planning": False,
    "errors": [],                 # Annotated[list, operator.add] — 병렬 노드에서 자동 병합
    "messages": [],               # Annotated[list, operator.add]
    "step_results": [],           # Annotated[list, operator.add]
    "findings": [],               # Annotated[list, operator.add]
}
```

`errors`, `messages`, `step_results`, `findings` 필드는 `Annotated[list, operator.add]` 리듀서가 적용되어 있어서, 여러 노드가 병렬로 값을 추가해도 자동으로 합쳐진다.

---

## 2. 그래프 구조

```
START
  │
  ▼
intake ──── route_after_intake() ──┬── plan ── implement
                                    │              │
                                    └── implement ◄┘
                                           │
                                           ▼
                                       qa_gate
                                           │
                                           ▼
                                    sentinel_check
                                           │
                              route_after_qa()
                           ┌───────┼───────┬───────┐
                           ▼       ▼       ▼       ▼
                        deploy    fix   escalate   END
                           │       │       │
                           ▼       │       ▼
                       memorize    │      END
                           │       │
                           ▼       ▼
                          END   qa_gate (루프)
```

### 노드별 RetryPolicy

| 노드 | max_attempts | initial_interval | backoff_factor |
|------|-------------|-----------------|----------------|
| `implement` | 3 | 2.0초 | 2.0x |
| `qa_gate` | 2 | 1.0초 | 2.0x |
| `deploy` | 2 | 3.0초 | 2.0x |

실패 시 `interval * backoff^attempt + jitter`만큼 대기 후 재시도. 모든 attempt 소진 시 예외가 전파되어 파이프라인 에러로 처리된다.

### 체크포인팅

`compile_graph(checkpoint_dir="~/.openseed/checkpoints")`가 호출되면 `AsyncSqliteSaver`가 매 노드 실행 후 상태를 SQLite에 저장한다. 크래시 후 재시작 시 마지막 체크포인트에서 이어서 실행할 수 있다.

```python
# 시간 여행: 과거 체크포인트 조회
history = await get_state_history(graph, thread_id="run-1", limit=20)

# 특정 체크포인트에서 분기
new_config = await fork_from_checkpoint(graph, "run-1", checkpoint_id, "run-1-retry")
result = await graph.ainvoke(None, config=new_config)
```

---

## 3. Node 1: intake_node

**역할**: 태스크 분석 + 과거 경험 검색 + 의도 분류

### 실행 순서

#### Step 1: Sentinel Intent Gate
```python
from openseed_sentinel.intent_gate import classify_intent
intent = await classify_intent(task)
# → IntentClassification(intent_type=IMPLEMENTATION, confidence=0.9,
#    reasoning="User wants to build a new API",
#    suggested_approach="plan → implement → verify")
```

Claude Haiku를 subprocess로 호출하여 태스크의 의도를 6가지 중 하나로 분류:
- `research` — 정보 수집 (→ explore → answer)
- `implementation` — 새 코드 작성 (→ plan → implement → verify)
- `investigation` — 디버깅/조사 (→ explore → report)
- `evaluation` — 평가/리뷰 (→ evaluate → propose)
- `fix` — 버그 수정 (→ diagnose → fix minimally)
- `open_ended` — 모호한 요청 (→ clarify first)

#### Step 2: Memory Recall
```python
store = MemoryStore()
await store.initialize()  # Qdrant → pgvector → SQLite 순으로 시도

# 유사 태스크 검색 (LLM 리랭킹 자동 적용)
results = await store.search(task, limit=5)

# 실패 패턴 검색
patterns = await recall_similar_failures(store, task, [])
```

`store.search()`는 벡터/FTS 검색 후, 결과가 3개 이상이면 자동으로 **LLM Reranker**가 Claude Haiku를 호출하여 의미적 관련성 기준으로 재정렬한다.

#### Step 3: Claude 분석
의도 분류 + 과거 경험을 포함한 프롬프트로 Claude Sonnet을 호출:

```
Analyze this task and classify it.
Task: Build a REST API with JWT authentication
Working directory: /Users/me/projects/my-api

Intent classification: implementation (confidence: 0.9)
Suggested approach: plan → implement → verify

Relevant past experiences:
- Task: Build Express REST API. Outcome: success. QA: pass (score: 0.85)

Known failure patterns for similar tasks:
- Missing JWT secret in .env → fix: create .env with JWT_SECRET

SKIP_PLANNING: yes/no
```

Claude가 `SKIP_PLANNING: yes`로 응답하면 `skip_planning=True`가 상태에 설정되고, `route_after_intake()`가 plan 노드를 건너뛴다.

---

## 4. Node 2: plan_node

**역할**: 구현 계획 생성

Claude Sonnet에게 JSON 형식의 구현 계획을 요청:

```json
{
  "summary": "Express REST API with JWT auth, user CRUD, middleware",
  "tasks": [
    {"id": "T1", "description": "Create package.json with deps", "files": ["package.json"]},
    {"id": "T2", "description": "Create Express server with JWT middleware", "files": ["server.js"]},
    {"id": "T3", "description": "Create auth routes", "files": ["routes/auth.js"]}
  ],
  "file_manifest": [
    {"path": "package.json", "purpose": "Dependencies and scripts"},
    {"path": "server.js", "purpose": "Express app entry point with JWT middleware"},
    {"path": "routes/auth.js", "purpose": "Login/register/refresh endpoints"}
  ]
}
```

파싱된 계획은 `Plan` 객체로 상태에 저장된다. 이후 모든 노드가 이 계획을 참조한다.

---

## 5. Node 3: implement_node

**역할**: 코드 생성 (3가지 모드)

`state["provider"]` 값에 따라 다른 전략:

### Mode: `claude` (기본)
Claude Sonnet에게 전체 구현 위임. `max_turns=15`로 여러 턴에 걸쳐 파일 생성/수정.

```python
response = await agent.invoke(
    prompt="Implement this plan. Write ALL files...",
    model="sonnet",
    working_dir=state["working_dir"],
    max_turns=15,
)
```

ClaudeAgent는 `--print --dangerously-skip-permissions` 모드로 CLI를 subprocess 실행. 실제 파일 시스템에 직접 코드를 작성한다.

### Mode: `codex`
Codex CLI에게 `--full-auto` 모드로 전체 위임. 빠르지만 깊이가 얕을 수 있음.

### Mode: `both`
**Phase 1**: Claude Sonnet이 핵심 아키텍처 파일 3-4개 작성 (entry point, server, config, types)
**Phase 2**: Codex가 나머지 파일을 병렬로 채움

### RetryPolicy
이 노드에는 `IMPLEMENT_RETRY(max_attempts=3, initial_interval=2.0s)`가 적용. API 타임아웃이나 일시적 오류 시 최대 3번 재시도.

---

## 6. Node 4: qa_gate_node

**역할**: 코드 품질 검증 (136개 전문 에이전트)

### 실행 순서

#### Step 1: 컨텍스트 수집
working_dir에서 실제 파일 목록을 읽고, 상위 5개 파일의 내용(각 2000자)을 컨텍스트에 포함.

#### Step 2: LLM 에이전트 선택
```python
agents = await select_agents(
    task=context,
    implementation_summary=task_summary,
    available_agents=all_active_agents,  # 136개 TOML 에이전트
    max_agents=6,
)
```

Claude Haiku가 태스크 유형에 맞는 에이전트 3-6개를 선별. 예: REST API 태스크 → `security-auditor`, `api-designer`, `test-automator`, `code-reviewer` 선택.

#### Step 3: 병렬 실행
```python
semaphore = asyncio.Semaphore(cfg.max_parallel_agents)
results = await asyncio.gather(*[run_one(agent) for agent in agents])
```

각 에이전트는 Claude/Codex CLI를 별도 subprocess로 실행. 프롬프트 끝에 JSON 출력 계약이 붙음:

```
Output valid JSON array:
[{"severity": "critical|high|medium|low|info", "title": "...", "description": "...",
  "file": "...", "line": null, "suggestion": "...", "confidence": "high|medium|low"}]
```

#### Step 4: LLM Knowledge Synthesis
```python
findings, synthesis = await synthesize(specialist_results, event_bus)
```

Claude Sonnet이 모든 에이전트의 결과를 합성:
- **충돌 해결**: Agent A가 "critical", Agent B가 "low"로 평가한 같은 이슈 → 증거 비교 후 판정
- **신뢰도 가중**: high confidence 발견사항 우선
- **오탐 감지**: 과도하게 보수적인 발견사항 제거
- **증거 추적**: 각 발견사항에 source_agents + evidence_type(confirmed/hypothesis/false_positive) 태그

#### Step 5: 판정
```python
verdict = _determine_verdict(findings, block_on_critical=True)
# PASS: critical/high 없음 → deploy로
# WARN: high 있음 → 경고하지만 통과
# BLOCK: critical 있음 → fix로
```

### 4-Stage Workflow (선택적)
`staged=True`로 호출 시:
1. **Discovery** — research/meta-orchestration 카테고리 에이전트가 탐색
2. **Review** — core-development/language/quality 카테고리가 코드 리뷰
3. **Validation** — quality-security/infrastructure 카테고리가 통합 검증
4. **Synthesis** — meta-orchestration이 전체 합성

각 단계 사이에 go/no-go 게이트: critical 발견 시 즉시 synthesis로 점프.

---

## 7. Node 5: sentinel_check_node

**역할**: 증거 기반 검증 + 재시도/에스컬레이션 결정

### QA 통과 시: 증거 이중 검증
QA Gate가 PASS를 줘도 Sentinel은 **실제 파일 시스템을 검사**:

```python
loop = ExecutionLoop()
verify = await loop._verify(
    working_dir=working_dir,
    exec_result={"claimed_files": expected_files, "test_commands": []},
    plan={"files_to_create": expected_files, "expected_test_commands": []},
)
```

`_verify()`는:
1. `verify_files_exist()` — 계획에 있는 파일이 실제로 디스크에 존재하는지 확인
2. `auto_detect_test_commands()` — package.json/pyproject.toml에서 테스트 명령어 자동 탐지
3. `verify_command()` — 탐지된 테스트 명령어를 실제 실행하여 통과 여부 확인

**에이전트가 "다 만들었어요"라고 해도 믿지 않는다. 파일을 직접 읽고, 테스트를 직접 실행한다.**

### QA 실패 시: evaluate_loop
```python
decision = await evaluate_loop(qa_result, verification, loop_state, task)
```

의사결정 트리:
1. QA PASS + 검증 PASS → `"pass"` → deploy로
2. QA FAIL + 재시도 가능 + 정체 아님 → `"retry"` (백오프 적용) → fix로
3. 정체 감지 (3사이클 동일 에러) + Oracle 미사용 → `"oracle"` → Claude Opus 자문
4. Oracle 사용했는데도 실패 → `"user_escalate"` → 사람에게 도움 요청
5. max_retries 소진 → `"abort"` → 중단

### 백오프 계산
```python
backoff = base_ms * (2 ^ min(failures, cap_exponent))
# failures=0: 5초, 1: 10초, 2: 20초, 3: 40초, 4: 80초, 5: 160초 (max)
```

### Oracle
Claude Opus에 `thinking_budget=20000`으로 호출. 전체 실패 이력 + 현재 에러를 분석하여 **완전히 다른 접근법**을 제안.

```python
advice = await consult_oracle(
    task=task,
    failure_history=loop_state.failure_history,
    current_errors=[f.description for f in qa_result.findings[:5]],
)
```

Oracle이 `should_abandon=True`를 반환하면 작업 자체를 포기.

---

## 8. Node 6: fix_node

**역할**: QA 발견사항 수정

### Step 1: Memory에서 과거 실패 참조
```python
patterns = await recall_similar_failures(store, task, [f.description for f in qa_result.findings])
```

과거에 같은 유형의 에러를 어떻게 고쳤는지 검색. 이전에 성공한 수정 전략을 우선 적용.

### Step 2: Claude에게 수정 요청
```python
prompt = f"""Fix the following issues in the project at {working_dir}.
Issues found by QA:
- [critical] Missing JWT secret: No JWT_SECRET in environment (file: server.js)

Past similar failures:
- Missing JWT secret in .env → fix: create .env with JWT_SECRET

Rules:
- Fix the ROOT CAUSE, not the symptom
- Write COMPLETE fixed files
- Do NOT introduce new features — only fix what's broken"""
```

Claude Sonnet이 `max_turns=5`로 파일을 읽고 수정.

### Fix → QA 루프
수정 후 `qa_gate` 노드로 돌아가서 재검증:
```
fix → qa_gate → sentinel_check → (pass → deploy | fail → fix)
```

최대 10번 반복 (max_retries). 같은 에러가 4번 반복되면 stagnation으로 판정, user_escalate.

---

## 9. Node 7: deploy_node

**역할**: 검증된 코드 배포

```python
from openseed_body.deployer import deploy
result = await deploy(working_dir=working_dir, message=f"openseed: {task[:80]}")
```

설정된 채널로 배포:
- **git** — `git add . && git commit && git push`
- **npm** — `npm publish --access public`
- **docker** — `docker build -t tag . && docker push tag`
- **webhook** — HTTP POST로 외부 서비스에 알림

`DEPLOY_RETRY(max_attempts=2)` 적용 — 네트워크 오류 시 재시도.

---

## 10. Node 8: memorize_node

**역할**: 결과 학습 + 실패 기록

### Task Outcome 저장
```python
await store.add(content=summary, user_id="system", agent_id="pipeline")
```

`store.add()`는 `infer=True`가 기본값이므로 **LLM Fact Extraction** 자동 실행:

1. Claude Haiku가 summary에서 개별 사실 추출
2. 기존 메모리와 비교하여 중복 검사
3. 각 사실에 대해 ADD/UPDATE/DELETE/NOOP 결정
4. 결정에 따라 메모리 저장/수정/삭제

예시:
```
Input: "Task: Build REST API. Outcome: success. Retries: 2. QA: pass"
→ LLM extracts:
  [ADD] "REST API 구축 시 JWT 미들웨어를 server.js에 먼저 설정해야 함"
  [ADD] "Express + JWT 조합은 2번 재시도 후 성공. 초기 실패 원인: .env 누락"
  [UPDATE id=abc123] "Express API 성공 사례 1건 → 2건으로 업데이트"
```

### 실패 기록
```python
if errors:
    await record_failure(store=store, task=task, errors=[...], attempted_fixes=[...])
```

실패 패턴을 procedural memory로 저장. 다음에 비슷한 태스크가 들어오면 `intake_node`의 Memory Recall에서 검색되어 같은 실수를 반복하지 않는다.

---

## 11. 라우팅 로직

### route_after_intake
```python
def route_after_intake(state) -> "plan" | "implement":
    return "implement" if state.get("skip_planning", False) else "plan"
```
Claude가 intake에서 설정한 `skip_planning` 플래그만 확인. 문자열 매칭이나 regex 없음.

### route_after_qa
```python
def route_after_qa(state) -> "deploy" | "fix" | "user_escalate" | "end":
```

판단 순서:
1. `qa_result.verdict == PASS` → `"deploy"`
2. errors에 "abort"/"abandon" 포함 → `"end"`
3. errors에 "user"+"help"/"escalat" 포함 → `"user_escalate"`
4. retry_count >= 3 + 최근 4개 에러 중 unique ≤ 2 → `"user_escalate"` (stagnation)
5. retry_count < max_retries → `"fix"`
6. 그 외 → `"user_escalate"`

---

## 12. Human-in-the-Loop

`user_escalate` 노드에 `interrupt_before`가 설정되어 있으면, 그래프가 이 노드 진입 직전에 **일시정지**된다.

CLI/UI가 사용자에게 도움을 요청하고, 사용자의 입력을 `Command(resume=user_input)`으로 그래프에 전달하면 실행이 재개된다.

---

## 13. 스트리밍

```python
async for event in run_pipeline_streaming(task, working_dir, mode=StreamMode.UPDATES):
    print(f"[{event.node}] {event.data}")
```

5가지 모드:
- `updates` — 노드 이름 + 상태 변경분만 (가벼움)
- `values` — 매 노드 후 전체 상태 스냅샷 (무거움)
- `messages` — LLM 토큰 스트리밍
- `tasks` — 태스크 시작/완료 이벤트
- `custom` — EventBus 브릿지

---

## 14. Left Hand 내부 구조

### Claude CLI 호출
```python
cmd = [cli, "--print", "--dangerously-skip-permissions", "--model", model, "--max-turns", "1", prompt]
result = await run_streaming(cmd, cwd=working_dir, timeout_seconds=timeout, on_line=on_line)
```

`--print` 모드 사용 (안정성 검증됨). `--output-format stream-json`은 subprocess 행 문제로 사용하지 않음.

### 출력 파싱
`parse_output(stdout, stderr)`:
1. NDJSON 파싱 시도 (JSON 라인이 있으면 TextBlock, ThinkingBlock, ToolUseBlock 등 추출)
2. 실패 시 plain text fallback
3. stderr에서 usage 정보 추출 시도

### 비용 추적
```python
usage = UsageStats(input_tokens=1000, output_tokens=500)
cost = estimate_cost(usage, "claude-sonnet-4-6")
# → CostEstimate(input_cost=$0.003, output_cost=$0.0075, total_cost=$0.0105)
```

OAuth 구독 내에서는 실제 비용 $0이지만, 사용량 파악과 rate limit 관리를 위해 추적.

### Hooks
```python
registry = HookRegistry()

@registry.pre_tool_use
async def block_dangerous_tools(ctx: HookContext) -> HookResult:
    if ctx.tool_name == "Bash" and "rm -rf" in str(ctx.tool_input):
        return HookResult(allow=False, reason="Dangerous command blocked")
    return HookResult(allow=True)
```

5가지 이벤트: PreToolUse, PostToolUse, Stop, OnError, OnThinking

### MCP Integration
```python
mcp = MCPConfig()
mcp.add_stdio_server("my-db", command="python", args=["db_mcp_server.py"])
agent = ClaudeAgent(mcp_config=mcp)
# → Claude CLI에 --mcp-config 플래그로 전달
```

---

## 15. Memory 내부 구조

### Backend 선택 (Factory)
```python
backend = create_backend(config)
# 시도 순서: Qdrant → pgvector → SQLite
# SQLite는 항상 성공 — 외부 의존성 없음
```

### Fact Extraction 흐름
```
store.add("Task completed. Used Express + JWT. Failed 2 times before .env fix.")
    │
    ▼ (infer=True)
FactExtractor.extract()
    │
    ├── store.search(content[:500]) → 기존 메모리 10개 검색
    │
    ├── Claude Haiku 호출:
    │   "Given this content and existing memories, extract facts.
    │    For each: ADD/UPDATE/DELETE/NOOP"
    │
    ├── JSON 파싱: [
    │     {"action": "ADD", "content": "Express+JWT: .env에 JWT_SECRET 필수", "memory_type": "procedural"},
    │     {"action": "UPDATE", "memory_id": "abc123", "content": "Express API 성공 2건", ...},
    │     {"action": "NOOP", "content": "이미 저장됨", "reasoning": "duplicate"},
    │   ]
    │
    └── 각 결정 실행:
        ADD → _add_raw()
        UPDATE → _update() (FTS5 재색인 + history 기록)
        DELETE → delete()
        NOOP → skip
```

### 검색 + 리랭킹
```
store.search("Express API authentication")
    │
    ├── SQLite FTS5 검색 (또는 Qdrant 벡터 검색)
    │   → 결과 8개
    │
    ├── len(results) > 3이므로 Reranker 작동
    │
    ├── Claude Haiku: "Query와 가장 관련 높은 순서로 ID를 정렬해라"
    │   → ["id5", "id2", "id8", "id1", ...]
    │
    └── 재정렬된 결과 반환
```

### Advanced Filters
```python
results = await store.search("JWT", filters={
    "$and": [
        {"memory_type": "procedural"},
        {"resolved": True},
        {"error_count": {"$gt": 0}},
    ]
})
```

SQLite에서는 `json_extract(metadata, '$.field')` SQL로 변환. pgvector/Qdrant에서는 Python 사이드 필터링.

---

## 16. Sentinel 7-Step Execution Loop

`ExecutionLoop.run(task, working_dir)` 호출 시:

### Step 1: EXPLORE
- Memory에서 유사 태스크/실패 패턴 검색
- Claude Haiku에게 코드베이스 상태 분석 요청
- 결과: `{"codebase_state": "disciplined", "relevant_patterns": [...], "summary": "..."}`

### Step 2: PLAN
- Claude Sonnet에게 구현 계획 요청
- 결과: `{"files_to_change": [...], "steps": [...], "complexity": "moderate"}`

### Step 3: ROUTE
- Claude Haiku에게 실행 전략 결정 요청
- 옵션: `delegate` (서브에이전트) / `execute` (직접) / `ask` (질문 필요) / `challenge` (접근 방식 문제 제기)

### Step 4: EXECUTE
- Brain의 implement 노드에 위임 (실제 코드 작성은 여기서 하지 않음)
- 실행 컨텍스트 반환: claimed_files, test_commands

### Step 5: VERIFY
- `verify_files_exist()` — 파일 존재 확인
- `auto_detect_test_commands()` — 테스트 명령어 탐지
- `verify_command()` — 실제 테스트 실행
- 결과: `{"passed": true/false, "missing_files": [...], "failing_commands": [...]}`

### Step 6: RETRY (최대 3회)
- Claude Sonnet에게 실패 원인 분석 + 수정 전략 요청
- 결과: `{"diagnosis": "root cause", "corrective_steps": [...]}`
- 3회 실패 시 완전히 다른 전략으로 전환

### Step 7: DONE
- 최종 검증 결과 반환

### Multi-Model Prompts
모델에 따라 프롬프트가 달라짐:
- **Claude**: 밀도 높은 구조화 프롬프트 (정확하게 따름)
- **GPT**: 8블록 XML 아키텍처 (`<identity>`, `<constraints>`, `<intent>`, `<explore>`, `<execution_loop>`, `<delegation>`, `<tasks>`, `<style>`)
- **Gemini**: 교정 오버레이 추가 (도구 사용 강제, 위임 강제, 자기 평가 불신, 의도 분류 강제)

---

## 17. 전체 시퀀스 다이어그램

```
User: "Build a REST API with JWT auth"
    │
    ▼
[intake]
    ├── Sentinel.classify_intent() → "implementation"
    ├── Memory.search("REST API JWT") → 과거 경험 2건
    ├── Memory.recall_failures("REST API") → ".env 누락" 패턴
    └── Claude.analyze() → SKIP_PLANNING: no
    │
    ▼
[plan]
    └── Claude.plan() → 3 tasks, 5 files
    │
    ▼
[implement] (retry ×3)
    └── Claude.invoke(max_turns=15) → 5개 파일 작성
    │
    ▼
[qa_gate] (retry ×2)
    ├── select_agents() → security-auditor, code-reviewer, test-automator
    ├── 3개 에이전트 병렬 실행 → 7개 findings
    └── synthesize() → 충돌 해결 후 4개 findings, verdict=WARN
    │
    ▼
[sentinel_check]
    ├── verify_files_exist() → 5/5 존재 ✓
    ├── verify_command("npm test") → FAIL (1 test failing)
    └── evaluate_loop() → "retry" (retry_count=1)
    │
    ▼
[fix]
    ├── Memory.recall_failures() → "Jest 설정 누락" 패턴 발견
    └── Claude.fix() → jest.config.js 추가 + test 수정
    │
    ▼
[qa_gate] (2차)
    └── 재검증 → verdict=PASS
    │
    ▼
[sentinel_check]
    ├── verify_files_exist() → 6/6 존재 ✓
    ├── verify_command("npm test") → PASS ✓
    └── "PASSED — QA clean + evidence verified (1 retry)"
    │
    ▼
[deploy]
    └── git commit + push
    │
    ▼
[memorize]
    ├── store.add(infer=True) → 3개 fact 추출, 1개 UPDATE, 2개 ADD
    └── record_failure() → jest.config.js 누락 패턴 저장
    │
    ▼
[END] — 다음에 비슷한 태스크가 오면 jest.config.js를 처음부터 만듦
```

---

## 18. 패키지 의존성 그래프

```
openseed-core ←── 모든 패키지가 의존
    │
    ├── openseed-memory (core 타입 + 이벤트)
    ├── openseed-sentinel (core 설정 + 이벤트)
    ├── openseed-left-hand (core auth + subprocess)
    ├── openseed-right-hand (core auth + subprocess)
    ├── openseed-qa-gate (core 타입 + 이벤트)
    ├── openseed-body (core subprocess)
    │
    └── openseed-brain (core + 위 모든 패키지)
            │
            └── openseed-cli (brain + API server)
```

`brain`은 모든 패키지의 조합점. `cli`는 brain을 호출하는 엔트리포인트.
