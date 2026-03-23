# Research Map — 7개 레포에서 뭘 가져올지

각 Open Seed v2 패키지별로, 어떤 레포의 어떤 파일/패턴을 참고해서 구현할지 정리.

---

## 1. `packages/core` — 공유 타입, 이벤트, 설정, OAuth

### types.py — PipelineState, TaskResult, AgentMessage

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| `PipelineState` TypedDict 패턴 | LangGraph | `research/langgraph/libs/langgraph/langgraph/types.py` | LangGraph StateGraph에 직접 쓰일 state 스키마. `Annotated[list, operator.add]` 리듀서 패턴 |
| Message 타입들 (UserMessage, AssistantMessage, ResultMessage) | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/types.py` (1300줄) | Claude 출력 파싱에 필요한 모든 메시지 타입. TextBlock, ToolUseBlock, ThinkingBlock 등 |
| `MemoryItem`, `MemoryConfig` 타입 | mem0 | `research/mem0/mem0/configs/base.py` | Memory 패키지와 동일한 인터페이스 유지 |

### events.py — 이벤트 버스

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| `asyncio.Queue` 기반 이벤트 버스 | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/handler.ts` | 이벤트 타입별 디스패치 패턴 (session.idle, session.error 등). Python asyncio.Queue로 재구현 |
| SSE/WebSocket 스트리밍 이벤트 프로토콜 | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/_internal/message_parser.py` | NDJSON 스트리밍 파싱 패턴 |

### config.py — Pydantic 설정 모델

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Pydantic config 구조 | mem0 | `research/mem0/mem0/configs/base.py` | MemoryConfig, EmbedderConfig 등 Pydantic 모델 패턴 |
| YAML + env override 패턴 | OpenClaw | `research/openclaw/src/config/` | Zod → Pydantic으로 변환. env override + defaults.yaml 로딩 |
| TOML 에이전트 정의 로더 | Subagents | `research/awesome-codex-subagents/categories/` | 136개 .toml 파일 파싱 구조. `name`, `model`, `sandbox_mode`, `instructions.text` |

### auth/ — OAuth

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Claude OAuth (keychain 읽기) | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py` | CLI가 알아서 OAuth 처리하는 구조. 우리는 CLI 존재 + 인증 상태만 확인 |
| OpenAI OAuth (keychain + auth.json) | Codex | `research/codex/codex-rs/rmcp-client/src/oauth.rs` | `StoredOAuthTokens`, keychain service name `"Codex MCP Credentials"`, refresh 로직. Python keyring으로 재구현 |
| Platform keychain 추상화 | Codex | `research/codex/codex-rs/rmcp-client/src/oauth.rs` | macOS Keychain, Linux secret-service, Windows Credential Manager 분기 |

---

## 2. `packages/brain` — LangGraph 오케스트레이션

### graph.py — 메인 StateGraph

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| StateGraph 정의 패턴 | LangGraph | `research/langgraph/libs/langgraph/langgraph/graph/state.py` | `StateGraph(PipelineState)` + `add_node()` + `add_edge()` + `add_conditional_edges()` 정확한 API |
| `Send()` 병렬 디스패치 | LangGraph | `research/langgraph/libs/langgraph/langgraph/types.py` | `Send("node_name", {"arg": val})` 로 동적 병렬 실행 |
| `Command()` 고급 제어 | LangGraph | `research/langgraph/libs/langgraph/langgraph/types.py` | `Command(update={}, goto=Send(...))` 로 상태 업데이트 + 라우팅 동시에 |
| 체크포인트 (중단/재개) | LangGraph | `research/langgraph/libs/checkpoint/` | SQLite 체크포인터로 파이프라인 중단 시 상태 저장, 재개 가능 |

### nodes/ — 파이프라인 노드들

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Intent Gate (intake 노드) | OmO | `research/oh-my-openagent/src/agents/sisyphus.ts` (lines 95-164) | Phase 0 Intent Verbalization 패턴. "I detect [type] intent because [reason]" |
| 태스크 분해 (plan 노드) | Subagents | `research/awesome-codex-subagents/categories/09-meta-orchestration/task-distributor.toml` | task-distributor의 지침 구조: 명확한 소유권, 분리된 write scope, 의존성 순서 |
| 병렬 분석 디스패치 | LangGraph | `research/langgraph/examples/` | `Send()` 로 여러 분석 에이전트를 동시에 실행하는 패턴 |

### routing.py — 조건부 라우팅

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| 조건부 엣지 함수 패턴 | LangGraph | `research/langgraph/libs/langgraph/langgraph/graph/_branch.py` | `add_conditional_edges(source, route_func)` — route_func가 AI 호출로 라우팅 결정 |
| Category-based 라우팅 | OmO | `research/oh-my-openagent/src/tools/delegate-task/category-resolver.ts` | 카테고리별 모델/에이전트 매핑. ultrabrain=Opus, quick=Sonnet 등 |

---

## 3. `packages/left_hand` — Claude 에이전트

### agent.py — ClaudeAgent

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| `ClaudeSDKClient` 사용법 | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/client.py` (499줄) | `async with ClaudeSDKClient(options) as client:` → `client.query()` → `client.receive_response()` |
| `query()` 단방향 모드 | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/query.py` (124줄) | 간단한 fire-and-forget. `async for message in query(prompt=...):` |
| subprocess transport | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py` | CLI 경로 탐색 (bundled → PATH → npm → brew), 프로세스 생명주기 |

### roles.py — AgentDefinition

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| `AgentDefinition` 데이터클래스 | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/types.py` (lines 43-54) | `description`, `prompt`, `tools`, `model`, `skills`, `memory` 필드 |
| 역할별 에이전트 예제 | Claude SDK | `research/claude-code-sdk-python/examples/agents.py` | code-reviewer, doc-writer 등 역할 정의 + 오케스트레이션 |

### model_select.py — Opus/Sonnet 선택

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Extended Thinking | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/types.py` | `ThinkingConfigEnabled(type="enabled", budget_tokens=10000)` |
| 동적 모델 전환 | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/client.py` | `await client.set_model('claude-sonnet-4-5')` 런타임 모델 변경 |

---

## 4. `packages/right_hand` — Codex 에이전트

### agent.py — CodexAgent

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| CLI subprocess 패턴 | Codex | `research/codex/codex-rs/core/src/agent/mod.rs` | spawn depth 추적, config 상속, role 적용 |
| `--full-auto` 모드 | Codex | `research/codex/codex-rs/tui/src/lib.rs` | `SandboxMode::WorkspaceWrite` + `AskForApproval::OnRequest` |
| JSON-RPC 통신 | Codex | `research/codex/sdk/` | subprocess stdout으로 JSON-RPC 스트리밍 |

### parallel.py — 병렬 코드 생성

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Multi-agent spawn | Codex | `research/codex/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs` | `spawn_agent_with_metadata()` + role override + config 상속 |
| 병렬 도구 실행 (RwLock) | Codex | `research/codex/codex-rs/core/src/tools/parallel.rs` | `supports_parallel=true` → read lock (동시), false → write lock (배타) |
| Wait + 동기화 | Codex | `research/codex/codex-rs/core/src/tools/handlers/multi_agents/wait.rs` | 타임아웃 있는 에이전트 완료 대기 |

### sandbox.py — 샌드박스

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Workspace-write 정책 | Codex | `research/codex/codex-rs/core/src/sandboxing/` | `FileSystemSandboxPolicy` — read/write/none 접근 레벨 분리 |

---

## 5. `packages/qa_gate` — QA 게이트

### agent_loader.py — TOML 에이전트 로더

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| TOML 에이전트 정의 포맷 | Subagents | `research/awesome-codex-subagents/categories/04-quality-security/reviewer.toml` | `name`, `model`, `sandbox_mode`, `model_reasoning_effort`, `instructions.text` |
| 전체 136개 에이전트 목록 | Subagents | `research/awesome-codex-subagents/categories/` | 10개 카테고리. 우리가 쓸 핵심 15개 선별 |
| CONTRIBUTING 가이드 (커스텀 에이전트 작성법) | Subagents | `research/awesome-codex-subagents/CONTRIBUTING.md` | instruction 구조: Working mode → Focus on → Quality checks → Return → Do not |

### gate.py — QA 게이트 실행

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| 병렬 에이전트 스폰 패턴 | Subagents | `research/awesome-codex-subagents/categories/09-meta-orchestration/multi-agent-coordinator.toml` | 디스조인트 write scope, 의존성 wait point, integration contract |
| workflow-orchestrator | Subagents | `research/awesome-codex-subagents/categories/09-meta-orchestration/workflow-orchestrator.toml` | discovery → implementation → validation → integration 4단계 |

### synthesizer.py — 결과 통합

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| knowledge-synthesizer 패턴 | Subagents | `research/awesome-codex-subagents/categories/09-meta-orchestration/knowledge-synthesizer.toml` | claim 정규화, 중복 제거, 충돌 처리, confidence 기반 우선순위 |

### verdict.py — 합격/불합격 판정

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| 없음 — LLM이 판단 | — | — | severity가 critical이면 block, medium이면 warn, low면 pass — 이것도 AI가 결정 |

---

## 6. `packages/sisyphus` — 무한 완성 루프

### loop.py — 메인 재시도 루프

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| TODO continuation enforcer | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/idle-event.ts` (190줄) | session.idle 감지 → 체크 게이트 (recovering? abort? background?) → cooldown → inject continuation |
| Session state machine | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/session-state.ts` (257줄) | `SessionState` 인터페이스: stagnationCount, consecutiveFailures, lastInjectedAt, inFlight 등 |
| Continuation injection | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/continuation-injection.ts` (189줄) | 프롬프트 빌드 + 주입 로직 |

### progress.py — 진행 추적

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| `trackContinuationProgress()` | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/session-state.ts` (lines 117-192) | 이전 incomplete count vs 현재 비교, 스냅샷 변경 감지, stagnation 카운트 |
| 상수들 | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/constants.ts` | `CONTINUATION_COOLDOWN_MS=5000`, `MAX_CONSECUTIVE_FAILURES=5`, `MAX_STAGNATION_COUNT=3` |

### stagnation.py — 정체 감지

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| 3사이클 정체 → 중단 | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/session-state.ts` | `stagnationCount >= MAX_STAGNATION_COUNT` → 더 이상 injection 안 함 |

### backoff.py — 지수 백오프

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| 지수 백오프 공식 | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/idle-event.ts` | `cooldown = BASE * 2^min(failures, 5)` — 최대 160초 |
| LangGraph RetryPolicy | LangGraph | `research/langgraph/libs/langgraph/langgraph/pregel/_retry.py` | `RetryPolicy(initial_interval=0.5, backoff_factor=2.0, max_interval=128.0, max_attempts=3)` |

### oracle.py — Oracle 에스컬레이션

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Oracle 에이전트 정의 | OmO | `research/oh-my-openagent/src/agents/oracle.ts` (278줄) | read-only 고추론 advisor. 사용 시점: 아키텍처 결정, 2+ 실패, 미지 패턴 |
| 에스컬레이션 체인 | OmO | `research/oh-my-openagent/src/agents/sisyphus.ts` (lines 348-365) | 3 failures → STOP → REVERT → DOCUMENT → CONSULT ORACLE → ASK USER |

### evidence.py — 증거 기반 검증

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Completion gate | OmO | `research/oh-my-openagent/src/hooks/atlas/verification-reminders.ts` (lines 12-121) | "완료" 주장하면 파일 직접 읽어서 확인. 체크박스 마크 → 파일 재읽기 → 변경 확인 |
| 노트패드 기반 학습 | OmO | `research/oh-my-openagent/src/hooks/atlas/verification-reminders.ts` | 서브에이전트가 learnings.md, issues.md에 발견 기록 |

---

## 7. `packages/body` — 배포 + 퍼블리시

### deployer.py — 배포 오케스트레이터

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| 배포 전략 패턴 | OpenClaw | `research/openclaw/src/infra/` | git push, npm publish, docker build + push 로직 |
| 멀티채널 딜리버리 | OpenClaw | `research/openclaw/src/agents/tools/message-tool.ts` | 여러 채널로 결과 전달 (webhook, git, npm) |

### channels/git.py — Git 배포

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Git 커밋 + 푸시 | OpenClaw | `research/openclaw/src/infra/git-root.ts` | git repo root 찾기, 커밋, 푸시 |
| 업데이트 체크 | OpenClaw | `research/openclaw/src/infra/update-check.ts` | GitHub API로 최신 버전 확인 |

### cron.py — 크론 스케줄러

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| CronService 전체 구조 | OpenClaw | `research/openclaw/src/cron/service.ts` | 스케줄 파싱, 딜리버리, 재시도, heartbeat |
| Job 상태 머신 | OpenClaw | `research/openclaw/src/cron/service/state.ts` | 잡 저장, 실행 로그, 헬스체크 |
| Isolated agent run | OpenClaw | `research/openclaw/src/cron/isolated-agent.ts` | 크론 잡을 격리된 에이전트 세션으로 실행 |

### channels/webhook.py — Webhook

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Webhook ingress 패턴 | OpenClaw | `research/openclaw/src/hooks/` | `/hooks/wake`, `/hooks/agent`, 커스텀 매핑 |
| Bearer token 인증 | OpenClaw | `research/openclaw/docs/automation/webhook.md` | `Authorization: Bearer <token>` |

---

## 8. `packages/memory` — 장기 기억

### store.py — MemoryStore

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| `Memory` 클래스 전체 API | mem0 | `research/mem0/mem0/memory/main.py` (104KB) | `add()`, `search()`, `update()`, `delete()`, `get_all()`, `history()` |
| LLM 기반 fact 추출 | mem0 | `research/mem0/mem0/configs/prompts.py` | `FACT_RETRIEVAL_PROMPT` + `get_update_memory_messages()` |
| 메모리 업데이트 결정 (ADD/UPDATE/DELETE/NONE) | mem0 | `research/mem0/mem0/memory/main.py` (lines 458-679) | LLM이 기존 메모리 vs 새 팩트 비교해서 결정 |

### backends/qdrant.py — Qdrant 벡터 DB

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Qdrant 벡터 스토어 | mem0 | `research/mem0/mem0/vector_stores/qdrant.py` | 컬렉션 생성, 임베딩 저장, 필터 검색 |
| 고급 필터 | mem0 | `research/mem0/mem0/memory/main.py` (lines 862-877) | `AND`, `OR`, `NOT`, `gt`, `contains` 등 |

### backends/sqlite.py — SQLite 히스토리

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| `SQLiteManager` | mem0 | `research/mem0/mem0/memory/storage.py` (7.5KB) | `history` 테이블: id, memory_id, old_memory, new_memory, event, created_at |

### failure.py — 실패 패턴 학습

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| Procedural memory | mem0 | `research/mem0/mem0/configs/enums.py` | `MemoryType.PROCEDURAL` — 워크플로우 패턴 저장 |
| 히스토리 기반 패턴 분석 | mem0 | `research/mem0/mem0/memory/storage.py` | `event="DELETE"` + `is_deleted=1` 로 실패 추적, 시맨틱 검색으로 유사 실패 찾기 |

---

## 9. `packages/cli` — CLI + API 서버

### main.py — Click CLI

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| CLI 구조 | OpenClaw | `research/openclaw/src/commands/` | `openseed run`, `openseed auth`, `openseed doctor` 등 커맨드 구조 |
| Rich 콘솔 출력 | OmO | `research/oh-my-openagent/src/hooks/todo-continuation-enforcer/countdown.ts` | 진행 토스트, 카운트다운 패턴 → Python Rich로 재구현 |

### api_server.py — FastAPI

| 가져올 것 | 소스 | 파일 | 이유 |
|-----------|------|------|------|
| WebSocket 프로토콜 | OpenClaw | `research/openclaw/src/gateway/protocol/` | 메서드 스키마, 이벤트 타입 |
| SSE 스트리밍 | Claude SDK | `research/claude-code-sdk-python/src/claude_agent_sdk/_internal/query.py` | NDJSON 스트리밍 패턴 → FastAPI StreamingResponse로 |

---

## 가져오지 않는 것 (명시적 제외)

| 레포 | 제외 | 이유 |
|------|------|------|
| LangGraph | `libs/sdk-js/`, `libs/sdk-py/` | LangGraph Cloud SDK — 우리는 로컬 실행 |
| Codex | `codex-cli/` (TypeScript 레거시) | Rust 버전만 사용 |
| Codex | `codex-rs/tui/` | TUI는 우리가 직접 만듦 (web + CLI) |
| OpenClaw | `apps/` (macOS/iOS/Android) | 네이티브 앱은 v2 범위 밖 |
| OpenClaw | `extensions/` (82개 플러그인) | 채널 통합은 Body에서 최소한만 |
| OmO | `src/agents/prometheus.ts` | 인터뷰 모드 — 우리는 Brain의 intake 노드가 처리 |
| Subagents | 136개 중 121개 | 핵심 15개만 선별 (reviewer, security-auditor, test-automator, performance-engineer, code-reviewer, architect-reviewer, knowledge-synthesizer, multi-agent-coordinator, task-distributor, backend-developer, frontend-developer, code-mapper, docs-researcher, qa-expert, refactoring-specialist) |
| mem0 | `server/` | 클라우드 API 서버 — 우리는 로컬 OSS 모드만 |
| mem0 | Graph memory (Neo4j) | v2 초기에는 벡터 + SQLite만. Neo4j는 나중에 |

---

## 구현 우선순위

```
Phase 1 (구조 + 핵심):
  core → brain → left_hand → right_hand

Phase 2 (검증 + 루프):
  qa_gate → sisyphus

Phase 3 (배포 + 기억):
  body → memory

Phase 4 (UI + CLI):
  cli → web
```

각 Phase가 끝나면 통합 테스트 → 커밋 → 푸시.
