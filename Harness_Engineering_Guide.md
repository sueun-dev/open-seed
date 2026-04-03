# Harness Engineering 완전 가이드

---

## 1. Harness Engineering이란?

### 1.1 정의

**Agent = Model + Harness**

Harness는 AI 에이전트에서 모델 자체를 제외한 모든 것을 의미한다. Constraints, tools, feedback loops, documentation, verification systems를 설계해서 AI 에이전트가 신뢰할 수 있는 소프트웨어를 생산하도록 만드는 분야다.

Martin Fowler의 정의에 따르면, harness는 "에이전트 주변에 구축한 외부 시스템과 제어 장치로, 에이전트 출력에 대한 신뢰도를 높이는 역할"을 한다.

핵심 전환: 사람이 코드를 직접 쓰는 것에서, **사람이 AI가 안전하게 동작하는 환경을 설계하는 것**으로 패러다임이 바뀌었다.

### 1.2 패러다임 진화

| 구분 | Prompt Engineering | Context Engineering | Harness Engineering |
|------|-------------------|--------------------|--------------------|
| 정의 | 단일 턴 지시 최적화 | 에이전트가 "보는 것" 최적화 | 에이전트가 "실행되는 방식" 최적화 |
| 강점 | 빠른 데모 | 단기 hallucination 감소 | 모델 변경 없이 시스템 신뢰성 확보 |
| 한계 | 멀티스텝에서 붕괴 | 긴 체인/복잡 도메인에서 실패 | 초기 투자 높음 |
| 투자 수준 | 낮음 | 중간 | 높음 (upfront) |
| 스코프 | 단일 인터랙션 | 모델 컨텍스트 윈도우 | 전체 에이전트 시스템 |

Context Engineering은 harness에 가이드와 센서를 제공하는 수단이다. Harness Engineering은 Context Engineering을 포함하되, 시스템 레벨에서 동작한다.

### 1.3 증거: 이게 실제로 작동하는가?

**OpenAI 내부 실험 (2025.08 ~ 2026.01)**
- 3명으로 시작, 7명으로 확장
- 5개월간 100만+ 줄의 프로덕션 코드 생성
- 수동으로 작성한 코드: **0줄**
- ~1,500개 PR merged
- 예상 개발 시간의 약 **1/10**로 완료
- 각 엔지니어가 3~10x 생산성 (7명 = 21~70명 규모)

**LangChain 팀**
- Terminal Bench 2.0 스코어: 52.8% → 66.5%
- Top 30에서 Top 5로 도약
- **모델을 바꾸지 않았다.** Harness만 개선해서 달성.

**Stripe "Minions" 시스템**
- 주당 1,000+ PR merged
- 개발자가 Slack에 태스크 포스팅 → 에이전트가 코드 작성 → CI 통과 → PR 오픈 → 사람이 리뷰/머지
- 1~5단계 사이에 개발자 개입 없음

---

## 2. Harness의 구조: Feedforward + Feedback

Martin Fowler 프레임워크에 따르면, harness의 제어 시스템은 두 가지 방향으로 나뉜다.

### 2.1 Guides (Feedforward Controls)

에이전트가 행동하기 **전에** 원치 않는 행동을 예방한다. 첫 시도에서 품질 높은 결과가 나올 확률을 높인다.

### 2.2 Sensors (Feedback Controls)

에이전트가 행동한 **후에** 관찰하고 자가 수정을 가능하게 한다. 특히 LLM 소비에 최적화된 신호를 생성할 때 강력하다 (예: linter 에러 메시지에 수정 지시를 포함).

### 2.3 핵심 원칙: 균형

> "피드백만 있으면 에이전트가 같은 실수를 반복하고, 피드포워드만 있으면 규칙은 인코딩하지만 작동 여부를 알 수 없다."

두 방향 모두 **Computational(결정론적)** 실행과 **Inferential(추론적)** 실행으로 나뉜다.

### 2.4 제어 매트릭스

| 제어 유형 | 방향 | 실행 타입 | 예시 |
|-----------|------|-----------|------|
| 코딩 컨벤션 | Feedforward | Inferential | AGENTS.md, Skills |
| Code mods | Feedforward | Computational | OpenRewrite recipes, codemods |
| Structural tests | Feedback | Computational | ArchUnit 테스트, 모듈 경계 검증 |
| Review instructions | Feedback | Inferential | 에이전트 코드 리뷰 스킬 |
| Linters/formatters | Feedback | Computational | ESLint, Biome, Prettier |
| Agent PR review | Feedback | Inferential | 에이전트가 다른 에이전트 PR 리뷰 |

**Computational Controls**: CPU에서 실행, 밀리초~초 단위, 결과가 결정론적이고 신뢰할 수 있음.

**Inferential Controls**: GPU/NPU에서 실행, 느리고 비용이 높음, 비결정론적이지만 결정론적 도구로는 불가능한 시맨틱 분석 가능.

---

## 3. Harness Engineering의 4대 핵심 기능

모든 harness 시스템은 네 가지 기능을 수행해야 한다:

### 3.1 Constrain: 에이전트가 할 수 있는 것을 제한

아키텍처 경계와 의존성 규칙을 기계적으로 강제한다.

**의존성 레이어링 예시:**
```
Types → Config → Repo → Service → Runtime → UI
```
각 레이어는 왼쪽 레이어에서만 import 가능. structural tests와 CI가 위반을 차단한다.

**강제 도구:**
- 결정론적 linter with custom rules
- LLM 기반 auditor (에이전트가 다른 에이전트 코드 리뷰)
- Structural tests (ArchUnit 스타일)
- Pre-commit hooks

**반직관적 효과:** 솔루션 공간을 제한하면 에이전트가 더 생산적이 된다. 명확한 경계가 dead end 탐색에 낭비되는 토큰을 줄인다.

**OpenAI의 구체적 사례:**
커스텀 linter 에러 메시지가 remediation instruction을 겸한다. 에이전트가 아키텍처 규칙을 위반하면, 에러 메시지가 위반 사실뿐 아니라 **수정 방법까지** 알려준다. 도구가 에이전트를 가르치면서 동시에 작동한다.

### 3.2 Inform: 에이전트가 해야 할 것을 알린다

에이전트에게 올바른 정보를 올바른 시점에 제공한다.

**Static Context:**
- Repository-local documentation (아키텍처 스펙, API 계약, 스타일 가이드)
- `AGENTS.md` / `CLAUDE.md` 파일
- Cross-linked 설계 문서 (linter가 일관성 검증)

**Dynamic Context:**
- Observability 데이터 (logs, metrics, traces) → 에이전트가 접근 가능
- 디렉토리 구조 매핑 (에이전트 시작 시)
- CI/CD 파이프라인 상태와 테스트 결과

**OpenAI의 핵심 교훈:**

> "Codex에게 지도를 줘라, 1,000페이지짜리 매뉴얼이 아니라. AGENTS.md는 목차여야 한다, 백과사전이 아니라."

**필수 원칙: Repository가 single source of truth다.** Google Docs, Slack, 사람 머릿속에만 있는 지식은 에이전트 시스템에 보이지 않는다.

### 3.3 Verify: 에이전트가 올바르게 했는지 검증

결정론적 + AI 기반 검증을 조합한다.

**Deterministic:**
- linters, type checkers, unit test generators
- CI/CD 파이프라인 자동 검증
- structural tests (모듈 경계, 의존성 방향)

**AI-driven:**
- 에이전트가 다른 에이전트의 PR 리뷰
- mutation testing
- 시맨틱 코드 분석

**OpenAI의 검증 루프:**
```
실패 발생
  → 사람이 "어떤 capability가 부족한가?" 분석
  → Codex에게 자체 변경사항 로컬 리뷰 지시
  → 추가 에이전트 리뷰 요청 (로컬 + 클라우드)
  → 피드백에 대응
  → 모든 에이전트 리뷰어가 만족할 때까지 loop
```

### 3.4 Correct: 에이전트가 잘못했을 때 수정 (Garbage Collection)

에이전트가 생성한 코드는 사람이 쓴 코드와 **다른 패턴으로** cruft가 쌓인다.

**Garbage Collection 에이전트가 하는 일:**
- 문서 일관성 에이전트: docs가 현재 코드와 일치하는지 검증
- constraint 위반 스캐너: 이전 체크를 우회한 코드 발견
- 패턴 강제 에이전트: 확립된 패턴에서 벗어난 부분 식별
- 의존성 감사: circular/불필요한 의존성 추적 및 해결
- dead code 제거

**실행 주기:** daily, weekly, 또는 event-triggered.

**OpenAI의 비유:**

> "기술 부채는 고금리 대출이다. 큰 덩어리로 한번에 갚으려 하기보다, 작은 단위로 지속적으로 갚는 것이 거의 항상 낫다."

---

## 4. 세 가지 규제 영역

Harness는 세 가지 차원에서 시스템 상태를 규제한다.

### 4.1 Maintainability Harness (유지보수성)

내부 코드 품질과 유지보수성을 다룬다. 현재 가장 성숙한 영역.

**Computational sensors가 잘 잡는 것:**
- 중복 코드, 순환 복잡도, 누락된 테스트 커버리지, 아키텍처 드리프트, 스타일 위반

**LLM이 부분적으로 잡는 것 (비싸고 확률적):**
- 시맨틱 중복 코드, 중복 테스트, brute-force 수정, 과도한 엔지니어링

**둘 다 안정적으로 못 잡는 것:**
- 이슈의 오진(misdiagnosis), 불필요한 기능 추가, 잘못 이해된 지시

### 4.2 Architecture Fitness Harness (아키텍처 적합성)

Fitness Functions을 구현한다.

예시:
- 성능 요구사항을 제공하는 Skills + 성능 테스트를 통한 피드백
- observability 코딩 컨벤션을 설명하는 Skills + 로그 품질에 대한 반성(reflection)을 촉발하는 디버깅 지시

### 4.3 Behaviour Harness (행동 검증)

가장 어려운 영역. "방 안의 코끼리."

**현재 접근:**
- Feedforward: 기능 스펙 (짧은 프롬프트 ~ 멀티파일 설명)
- Feedback: AI 생성 테스트 스위트 통과 확인, 커버리지 측정, mutation testing, 수동 테스트

**문제:**

> "AI가 생성한 테스트에 너무 많은 신뢰를 두고 있다. 아직 충분하지 않다."

아직 해결해야 할 부분이 많다. supervision과 수동 테스트를 줄일 만큼 confidence를 높이는 행동 검증 harness는 현재진행형이다.

---

## 5. Timing: 제어의 시점

Continuous Integration 원칙을 에이전트 생성 코드에 적용한다.

### 5.1 Pre-Integration (커밋 전/중)
빠른 체크: linters, 빠른 테스트 스위트, 기본 코드 리뷰 에이전트.

### 5.2 Post-Integration Pipeline (통합 후)
비싼 제어: mutation testing, 종합적 코드 리뷰. 빠른 체크도 반복.

### 5.3 Continuous Monitoring (변경 라이프사이클 외)
축적된 드리프트 감시:
- Dead code, 테스트 품질 퇴화, 의존성 취약점
- Runtime 피드백: SLO 퇴화, 응답 품질 샘플링, 로그 이상 감지

---

## 6. Harnessability: 모든 코드베이스가 동등하지 않다

**Ambient Affordances**: "에이전트가 동작하기에 legible하고, navigable하고, tractable하게 만드는 환경 자체의 구조적 속성"

- 강타입 언어 → type-checking이 자연스러운 sensor
- 명확한 모듈 경계 → 아키텍처 제약 규칙 적용 가능
- Spring 같은 프레임워크 → 에이전트가 신경 쓸 필요 없는 세부사항 추상화

**Greenfield vs Legacy:**
- Greenfield 팀: day one부터 harnessability를 설계에 포함 가능
- Legacy 팀: harness가 가장 필요한 곳이 구축이 가장 어려운 곳

---

## 7. 실전 구현 레벨

### Level 1: Basic Harness (개인 개발자)

**셋업 시간:** 1~2시간

**구성요소:**
- `AGENTS.md` / `CLAUDE.md` 파일에 프로젝트 컨벤션 기술
- Pre-commit hooks로 lint/format 강제
- 에이전트가 자가 검증에 사용할 테스트 스위트
- 명확한 디렉토리 구조와 일관된 네이밍

### Level 2: Team Harness (3~10명)

**셋업 시간:** 1~2일

**Level 1에 추가:**
- `AGENTS.md`에 팀 공통 컨벤션 기술
- CI로 아키텍처 제약 강제
- 공통 태스크를 위한 공유 프롬프트 템플릿
- Documentation-as-code (linter가 검증)
- 에이전트 생성 PR 전용 코드 리뷰 체크리스트

### Level 3: Production Harness (엔지니어링 조직)

**셋업 시간:** 1~2주

**Level 2에 추가:**
- 커스텀 미들웨어 레이어 (루프 감지, 추론 최적화)
- Observability 통합 (에이전트가 로그/메트릭 읽기)
- 스케줄 기반 entropy management 에이전트
- Harness 버전 관리 및 A/B 테스트
- 에이전트 성능 모니터링 대시보드
- 막힌 에이전트 위한 에스컬레이션 정책

---

## 8. OpenAI의 8가지 핵심 원칙

OpenAI가 5개월간 100만 줄 프로젝트를 통해 추출한 원칙들:

### 원칙 1: "No Manual Code" Forcing Function
Greenfield 모듈에 수동 코드 작성 금지 제약을 건다. 이 제약이 harness의 부족한 부분을 즉시 드러낸다.

### 원칙 2: 지도를 줘라, 매뉴얼 말고
AGENTS.md는 목차(table of contents)여야지 백과사전이면 안 된다. 에이전트에게 필요한 최소한의 맥락만 제공한다.

### 원칙 3: Depth-First Working
큰 목표를 작은 빌딩 블록으로 분해 (설계, 코드, 리뷰, 테스트 등) → 에이전트에게 블록 구축 지시 → 이 블록들로 더 복잡한 태스크 해제.

### 원칙 4: 기계적 강제
Linter, CI validation, structural tests로 아키텍처 경계를 강제한다. 사람의 수동 감시에 의존하지 않는다.

### 원칙 5: 수정을 영구 Constraint로 전환
한번 고친 실패 모드는 lint rule이나 sub-agent로 인코딩해서 재발을 기계적으로 방지한다.

### 원칙 6: 에이전트가 에이전트를 리뷰
Codex가 자체 변경사항을 리뷰하고, 추가 에이전트 리뷰를 받고, 피드백에 대응하고, 모두 만족할 때까지 loop한다.

### 원칙 7: Observability-Driven Development
텔레메트리(logs, metrics, spans)로 앱 성능을 모니터링하고, 격리된 개발 환경에서 버그를 재현한다.

### 원칙 8: 지속적 Garbage Collection
주기적으로 에이전트를 돌려 불일치와 위반을 찾고, 수정 제안을 받아 코드베이스 엔트로피를 관리한다.

---

## 9. 엔지니어 역할의 변화

| 역할 | 기존 | Harness Engineering |
|------|------|-------------------|
| 코드 작성 | 주된 업무 | 안 함 |
| 아키텍처 설계 | 업무의 일부 | **주된 업무** |
| 문서 작성 | 후순위 | **핵심 인프라** |
| PR 리뷰 | 코드 리뷰 | 에이전트 출력 + harness 효과성 리뷰 |
| 디버깅 | 코드 읽기 | 에이전트 행동 패턴 분석 |
| 테스트 | 테스트 작성 | 에이전트가 실행할 테스트 전략 설계 |

---

## 10. AGENTS.md 완전 가이드

### 10.1 정의

에이전트를 위한 README. 프로젝트의 빌드/테스트 방법, 코딩 컨벤션, 아키텍처 맥락을 에이전트에게 전달하는 표준 마크다운 파일.

Linux Foundation 산하 Agentic AI Foundation이 관리. OpenAI Codex, GitHub Copilot, Cursor, Google Jules 등 25+ 플랫폼 지원.

### 10.2 핵심 철학: 5가지 원칙

**원칙 1: Minimal by Design**

ETH Zurich 연구(Gloaguen et al., 2026)에 따르면:
- LLM이 생성한 context 파일은 에이전트 태스크 성공률을 **감소**시키고 추론 비용을 20%+ 증가시킴
- 사람이 쓴 최소한의 파일은 4% 정도 개선 (정확할 때만)
- **불필요한 제약은 에이전트 성능을 적극적으로 해친다**

**원칙 2: Toolchain First**

> "제약이 다른 곳(linter, formatter, type checker, CI gate)에서 결정론적으로 강제될 수 있다면, agents.md에 써서는 안 된다."

도구 자체가 강제 메커니즘이다. 재진술은 유지보수 부채를 만들고 신호를 희석한다.

| 타입 | 예시 | 소속 |
|------|------|------|
| Toolchain-enforced | `var` 금지, import 순서, 포매팅 | biome.json / eslint / tsconfig |
| Judgment/architectural | composition 선호, 의존성 논의 | agents.md |
| Session-scoped persona | Critic, Builder | skill 파일 |
| Task-specific style | API naming conventions | 스펙/PBI |

**원칙 3: Pink Elephant 문제 회피**

에이전트에게 "하지 말라"고 지시하면 오히려 그 개념이 attention 메커니즘에서 활성화된다. "tRPC 쓰지 마" → `tRPC`가 컨텍스트 윈도우에서 활성 상태로 유지됨.

대응: agents.md를 구조적 마찰을 드러내는 진단 도구로 취급. 근본 원인 수정 (레거시 유틸 삭제, linter rule 추가) → 지시 제거.

**원칙 4: Context Anchor (장기 기억)**

에이전트는 stateless. 매 세션마다 일반 훈련 기본값으로 리셋. agents.md가 AI 협업을 위한 영속적 제도적 판단을 전달한다: 모호함 해소, 사전 동의 요구사항, 아키텍처 가치관.

자주 바뀌는 agents.md 내용은 다른 곳에 속한다는 신호.

**원칙 5: Context is Code**

agents.md를 프로덕션 소프트웨어 수준의 엄격함으로 취급:
- Version Controlled: git과 PR로 추적
- Falsifiable: 테스트 가능한 행동 기대치 포함
- Optimized: 최대 signal-to-noise ratio를 위한 구조

### 10.3 플랫폼별 파일명

| Tool | Expected Filename | 비고 |
|------|-------------------|------|
| Codex | `AGENTS.md` | Native support |
| Cursor | `.cursorrules` | `AGENTS.md`도 읽음 |
| Windsurf | `.windsurfrules` | `AGENTS.md`도 읽음 |
| Claude Code | `CLAUDE.md` | Case-sensitive; `AGENTS.md` 안 읽음 |
| VS Code / Copilot | `AGENTS.md` | `chat.useAgentsMdFile` 설정 필요 |
| Zed | `.rules` | 우선순위 기반 파일 매칭 |

**Multi-tool 전략: symlink로 통일**
```bash
ln -s AGENTS.md CLAUDE.md
```

Claude Code는 `CLAUDE.local.md`도 지원 (개인 프리퍼런스, VCS 제외).

### 10.4 파일 배치 전략과 Discovery

```
~/.codex/
├── AGENTS.md                  # 글로벌 (모든 프로젝트 공통)
├── AGENTS.override.md         # 글로벌 임시 오버라이드
└── config.toml                # Codex 설정

your-repo/
├── AGENTS.md                  # 프로젝트 루트
├── apps/
│   ├── web/
│   │   └── AGENTS.md          # 프론트엔드 전용
│   └── api/
│       └── AGENTS.md          # API 전용
├── packages/
│   ├── core/
│   │   └── AGENTS.md          # 코어 로직 전용
│   └── db/
│       └── AGENTS.md          # DB 레이어 전용
└── infra/
    └── AGENTS.md              # 인프라 전용
```

**Discovery 우선순위:**
1. `~/.codex/AGENTS.override.md` (글로벌 오버라이드)
2. `~/.codex/AGENTS.md` (글로벌)
3. Git root → 현재 디렉토리까지 walk (가까운 파일이 우선)
4. 유저 chat prompt가 모든 것을 override

**사이즈 제한:** 32 KiB (config.toml에서 `project_doc_max_bytes`로 조정 가능). 빈 파일은 건너뜀.

단일 루트 파일은 **150줄까지** 유효. 그 이상이면 디렉토리별로 분할.

### 10.5 AGENTS.md 섹션 구조 (Anatomy)

#### Section 1: Mission (프로젝트 컨텍스트)

에이전트가 코드에서 추론할 수 없는 도메인 컨텍스트. 2~4문장.

```markdown
> **Project:** ZenTask — a minimalist productivity app.
> **Core constraint:** Local-first data architecture; offline support is non-negotiable.
```

#### Section 2: Toolchain Registry

비표준 도구와 실행 방법의 최소한 참조. 도구 강제 방법은 설명하지 않는다 (config 파일에 있으니까).

```markdown
## Key Commands
| Intent | Command | Notes |
|--------|---------|-------|
| Build | `pnpm build` | Outputs to `dist/` |
| Test | `pnpm test:unit` | Flags: --watch=false |
| Lint | `pnpm lint --fix` | Biome (see `biome.json`) |
| Type check | `pnpm typecheck` | tsconfig.json is the authority |
| E2E | `pnpm test:e2e` | Playwright |
```

#### Section 3: Judgment Boundaries (판단 경계)

Toolchain으로 표현 불가능한 행동 규칙. 에이전트 추론을 형성하는 조향 제약. 세 단계로 분류:

```markdown
## Boundaries

### NEVER (Hard limits)
- Never commit secrets, tokens, or `.env` files
- Never add external dependencies without discussion
- Never guess on ambiguous specifications — pause and ask
- Never use `_` to ignore errors
- Never force push to main or protected branches

### ASK (Human-in-the-loop triggers)
- Ask before running database migrations
- Ask before deleting files
- Ask before adding new external dependencies
- Ask before modifying CI/CD configuration

### ALWAYS (Proactive requirements)
- Explain your plan before writing code
- Handle all errors explicitly — never silently suppress exceptions
- Run lint and typecheck before considering a task done
- Run the test suite before marking any task complete
```

**핵심:** toolchain이나 harness가 이미 강제하는 규칙은 여기서 제거해야 한다.

#### Section 4: Available Personas (Registry Only)

멀티 페르소나 프로젝트에서, invocation 이름만 나열. 전체 정의는 skill/workflow 파일에 둔다. 매 세션마다 모든 페르소나 정의를 로드하면 리소스 낭비.

```markdown
## Personas
Invoke via skill: @Lead, @Dev, @Designer, @Critic
Definitions: `.claude/skills/`
```

싱글 페르소나 프로젝트:
```markdown
## Identity
Senior Backend Engineer — Node.js 22, Fastify, PostgreSQL.
Favor explicit error handling and composition over inheritance.
```

#### Section 5: Context Map

프로젝트 구조가 복잡하거나 에이전트가 파일 위치를 자주 못 찾을 때만 사용. 연구에 따르면, "디렉토리 맵은 구현 중 파일 탐색을 의미 있게 가속하지 않는다." Context Map의 가치는 아키텍처 오리엔테이션, 스펙 작성, 에러 분류, ADR 작성에 있다.

프레임워크 기본 폴더는 제외. 컨벤션에서 벗어난 것만 포함.

```yaml
monorepo: pnpm workspaces

packages:
  apps/web: Next.js frontend (App Router)
  apps/api: Fastify REST API, used by apps/web and mobile app
  packages/ui: shared component library (consumed by web)
  packages/db: Prisma schema, client, migrations — import from here, not direct prisma calls
  packages/types: shared TypeScript types

notable:
  scripts/: repo-wide dev tooling, not shipped
  .env.example: canonical env vars reference
```

### 10.6 AGENTS.md 실전 작성 예시 (범용, 완전판)

```markdown
# AGENTS.md

> **Project:** TeamFlow — a real-time team collaboration platform.
> **Core constraint:** Offline-first with CRDT-based sync. All state mutations must be conflict-free.

## Key Commands
| Intent | Command | Notes |
|--------|---------|-------|
| Install | `pnpm install` | pnpm only, never npm |
| Build | `pnpm build` | Turborepo, outputs to dist/ |
| Dev | `pnpm dev` | Runs all packages concurrently |
| Test (unit) | `pnpm test:unit` | Vitest, --watch=false in CI |
| Test (e2e) | `pnpm test:e2e` | Playwright |
| Lint | `pnpm lint` | Biome (see biome.json) |
| Type check | `pnpm typecheck` | tsc --noEmit |
| DB migrate | `pnpm --filter db migrate` | Prisma migrate |

## Architecture Constraints
- Dependency flow: types → db → core → api → web (no reverse imports)
- All DB access through packages/db repository layer only
- API endpoints validate all input with zod schemas
- CRDT operations isolated in packages/core/sync/ — never in UI layer
- WebSocket messages typed in packages/types/ws.ts

## Code Style
- TypeScript strict mode. No `any`, no `as` assertions without justifying comment.
- Named exports only. No default exports except Next.js pages/layouts.
- Error handling: Result<T, E> pattern for business logic. No throwing for expected failures.
- API errors: RFC 7807 Problem Details format.
- Logging: structured JSON via pino. No console.log in production code.

## Non-Obvious Patterns
- The `api` client methods (`client.api`, `client.apiVoid`) never throw.
  They return `ApiResult<T>` containing either response or error with ResponseStatus.
  Using try/catch around client.api calls is always wrong.
- WebSocket reconnection is handled by packages/core/sync/reconnect.ts.
  Do not implement reconnection logic anywhere else.
- Feature flags live in packages/core/flags.ts and are resolved at startup.
  Never check environment variables directly for feature toggling.

## Testing Rules
- Unit tests for all business logic in packages/core/ (vitest)
- API endpoints: integration tests with supertest, test both success and error paths
- UI components: React Testing Library. No snapshot tests.
- Minimum coverage: 80% line coverage on packages/core/
- All tests must be deterministic and isolated. Mock external dependencies.

## Boundaries

### NEVER
- Commit secrets, tokens, or .env files
- Add external dependencies without discussion
- Force push to main or protected branches
- Modify vendor/, dist/, or build/ directories
- Use console.log in production code

### ASK
- Before adding new npm packages
- Before running database migrations
- Before deleting files
- Before modifying CI/CD configuration

### ALWAYS
- Explain your plan before writing code
- Run `pnpm lint && pnpm typecheck && pnpm test:unit` before marking task complete
- Handle all errors explicitly

## Personas
Invoke via skill: @Lead, @Dev, @Critic
Definitions: `.claude/skills/`

## Context Map
```yaml
monorepo: pnpm workspaces

packages:
  apps/web: Next.js 15 frontend (App Router + Server Components)
  apps/api: Fastify REST + WebSocket server
  packages/core: business logic, CRDT sync engine
  packages/db: Prisma schema, client, migrations
  packages/types: shared TypeScript types + WebSocket message schemas
  packages/ui: shared React component library

notable:
  scripts/: repo-wide dev tooling, not shipped
  docs/adr/: architecture decision records
  .env.example: canonical env vars reference
```
```

### 10.7 글로벌 AGENTS.md (~/.codex/AGENTS.md)

```markdown
# Global AGENTS.md

## General Preferences
- Language: TypeScript (prefer over JavaScript in all cases)
- Package manager: pnpm (never npm or yarn)
- Always run lint and typecheck before considering a task done
- Commit messages in English, conventional commit format

## Security (Global)
- Never write secrets, API keys, or credentials into any file
- Never disable eslint/biome rules with inline comments without justification

## Quality
- No TODO comments without a linked issue number
- Remove unused imports and dead code before committing
- Prefer composition over inheritance
- Keep functions under 40 lines when possible
```

### 10.8 하위 디렉토리 AGENTS.md 예시

**apps/api/AGENTS.md:**
```markdown
# AGENTS.md (apps/api/)

## Scope
HTTP API route handlers and middleware for Fastify.

## Rules
- Every route file exports a Fastify plugin
- Request/response schemas: zod → JSON Schema for Swagger
- Middleware order: auth → rate-limit → validation → handler
- No business logic here; delegate to packages/core/ services
- All responses follow envelope: { data, error, meta }

## Testing
- Run: `pnpm --filter api test`
- Use supertest for integration. Mock external services with msw.
- Test both success and error paths for every endpoint.
```

**packages/db/AGENTS.md:**
```markdown
# AGENTS.md (packages/db/)

## Scope
Prisma schema, database client, and migration management.

## Rules
- All database queries live here as repository functions
- Use parameterized queries only; no string concatenation for SQL
- Transactions must use prisma.$transaction with explicit isolation level
- New tables require an ADR in docs/adr/ before creation

## Migrations
- `pnpm --filter db migrate` to apply
- Never edit existing migration files; create new ones
- Migration names: YYYYMMDD_description (e.g., 20260401_add_user_roles)
```

### 10.9 정기 감사: 제거해야 할 것

주기적으로 agents.md를 리뷰해서 이미 이전된 내용을 제거:
- linter가 이제 강제하는 스타일 규칙 → 제거
- tsconfig/ESLint가 강제하는 라이브러리 제한 → 제거
- skill 파일로 이동된 페르소나 정의 → registry 한 줄로 교체
- README에서 복사된 코드베이스 개요 → 제거 (에이전트가 README를 읽을 수 있다)
- `/init` 커맨드로 LLM이 생성한 섹션 → 초안 취급, Toolchain First 원칙 적용

### 10.10 config.toml 설정

```toml
# ~/.codex/config.toml
project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]
project_doc_max_bytes = 65536
```

---

## 11. Codex App Server: Harness의 기술 아키텍처

Codex harness의 실행 엔진. 모든 Codex 경험(CLI, VS Code Extension, Web App)을 하나의 안정적 API로 구동한다.

### 11.1 아키텍처 구성요소

```
┌────────────────────────────────────────────────────┐
│                  Codex App Server                   │
│                                                    │
│  ┌──────────┐  ┌──────────────────┐  ┌──────────┐ │
│  │  Stdio   │→│ Message Processor │→│  Thread   │ │
│  │  Reader  │  │ (JSON-RPC ↔      │  │  Manager  │ │
│  │          │  │  Internal Ops)   │  │          │ │
│  └──────────┘  └──────────────────┘  └────┬─────┘ │
│                                           │       │
│                    ┌──────────────────────┤       │
│                    │                      │       │
│              ┌─────┴─────┐  ┌──────┴──────┐      │
│              │ Core      │  │ Core        │      │
│              │ Thread 1  │  │ Thread N    │      │
│              │ (dialogue,│  │             │      │
│              │  tools,   │  │             │      │
│              │  events)  │  │             │      │
│              └───────────┘  └─────────────┘      │
└────────────────────────────────────────────────────┘
```

- **Stdio Reader**: stdin의 JSON-RPC 메시지를 관찰하고 프레이밍
- **Message Processor**: 클라이언트 요청을 harness에 대한 내부 연산으로 변환. 내부 이벤트를 JSON-RPC 메시지로 역변환.
- **Thread Manager**: 영속 세션(thread) 관리. 세션 시작, 재개, fork, 아카이브.
- **Core Threads**: 각 thread가 진행 중인 에이전트 세션의 컨테이너. dialogue, tool 실행 상태, event streaming 추적.

### 11.2 JSON-RPC 2.0 프로토콜

Transport: stdio (기본, newline-delimited JSON) 또는 WebSocket (실험적).

**양방향(bidirectional):** 클라이언트와 서버 모두 요청을 시작할 수 있다. 에이전트가 approval 같은 입력이 필요하면, 서버가 요청을 보내고 클라이언트가 응답할 때까지 turn을 일시정지한다.

```
Request:      { "method": "...", "id": 10, "params": {...} }
Response:     { "id": 10, "result": {...} }
Notification: { "method": "...", "params": {...} }  // no id
```

### 11.3 핵심 Primitives

- **Thread**: 사용자와 에이전트 간 대화. 여러 turn 포함.
- **Turn**: 단일 사용자 요청 + 에이전트 작업. items와 streaming 업데이트 포함.
- **Item**: 원자적 단위. 유저 메시지, 에이전트 메시지, 커맨드 실행, 파일 변경, 도구 호출 등.

### 11.4 초기화 핸드셰이크

```json
// 1. Client → Server
{ "method": "initialize", "id": 0,
  "params": {
    "clientInfo": {
      "name": "my_product",
      "title": "My Product",
      "version": "0.1.0"
    }
  }
}

// 2. Client → Server (notification)
{ "method": "initialized", "params": {} }

// 3. 이후 thread/turn 연산 가능
```

### 11.5 Thread 라이프사이클

```
thread/start   → 새 대화 시작 (model, cwd, approval policy, sandbox 설정)
thread/resume  → 기존 thread 재개
thread/fork    → 기존 thread 분기 (히스토리 보존)
thread/read    → 저장된 thread 조회 (재개/구독 없이)
thread/list    → thread 목록 (필터: archived, modelProviders, cwd)
thread/archive → 아카이브로 이동
thread/rollback → 마지막 N개 turn 제거
thread/compact/start → 수동 대화 히스토리 압축
```

### 11.6 Turn 연산

```json
// Turn 시작
{ "method": "turn/start", "id": 30,
  "params": {
    "threadId": "thr_123",
    "input": [{ "type": "text", "text": "Add user authentication" }],
    "model": "o3",
    "effort": "medium"
  }
}

// Turn 중 추가 입력
{ "method": "turn/steer", ... }

// Turn 취소
{ "method": "turn/interrupt", ... }
```

Input 타입: `text`, `image`, `localImage`, `skill`

Turn-level 오버라이드: `model`, `effort`, `personality`, `cwd`, `sandboxPolicy`, `outputSchema`, `approvalPolicy`

### 11.7 Sandbox Policies

| Policy | 설명 |
|--------|------|
| `dangerFullAccess` | 제한 없는 실행 |
| `readOnly` | 읽기 전용 + optional restricted roots |
| `workspaceWrite` | 지정 root에 쓰기 허용 |
| `externalSandbox` | Codex sandbox 건너뜀, 클라이언트가 격리 처리 |

### 11.8 Approvals 시스템

**커맨드 실행 승인 흐름:**
```
item/started (pending command)
  → item/commandExecution/requestApproval (서버 → 클라이언트)
  → 클라이언트 응답: accept | acceptForSession | decline | cancel
  → serverRequest/resolved
  → item/completed
```

**파일 변경 승인 흐름:**
```
item/started (fileChange with proposed changes)
  → item/fileChange/requestApproval
  → 클라이언트 응답: accept | acceptForSession | decline | cancel
  → serverRequest/resolved
  → item/completed
```

### 11.9 Node.js 클라이언트 통합 예시

```javascript
import { spawn } from "node:child_process";
import readline from "node:readline";

const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const rl = readline.createInterface({ input: proc.stdout });

const send = (message) => {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
};

let threadId = null;

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1 && msg.result?.thread?.id && !threadId) {
    threadId = msg.result.thread.id;
    send({
      method: "turn/start",
      id: 2,
      params: {
        threadId,
        input: [{ type: "text", text: "Summarize this repo." }],
      },
    });
  }
});

// Initialize → Thread start
send({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: {
      name: "my_product",
      title: "My Product",
      version: "0.1.0",
    },
  },
});
send({ method: "initialized", params: {} });
send({ method: "thread/start", id: 1, params: { model: "o3" } });
```

---

## 12. docs/ 폴더 구조 (Harness Documentation)

OpenAI 내부에서 사용한 계층적 문서 구조. 에이전트의 single source of truth.

```
docs/
├── architecture/
│   ├── overview.md            # 시스템 전체 아키텍처
│   ├── dependency-graph.md    # 모듈 간 의존성 규칙
│   └── adr/                   # Architecture Decision Records
│       ├── 001-auth-design.md
│       ├── 002-db-migration-strategy.md
│       └── 003-crdt-sync-engine.md
├── maps/
│   ├── execution-plan.md      # 에이전트 실행 계획
│   └── module-map.md          # 코드베이스 맵
├── specs/
│   ├── user-management.md     # 기능 스펙
│   ├── notification-system.md
│   └── sync-protocol.md
└── conventions/
    ├── api-style.md           # API 설계 컨벤션
    ├── typescript-style.md    # 언어별 컨벤션
    └── testing-strategy.md    # 테스트 전략
```

Linter가 문서와 코드 간 일관성을 기계적으로 검증한다.

---

## 13. 미들웨어 패턴 (LangChain 사례)

```
Agent Request
  → LocalContextMiddleware    (코드베이스 매핑)
  → LoopDetectionMiddleware   (반복 방지)
  → ReasoningSandwichMiddleware (추론 최적화)
  → PreCompletionChecklistMiddleware (검증 강제)
  → Agent Response
```

각 레이어가 코어 에이전트 로직을 수정하지 않고 특정 capability를 추가한다. Harness를 테스트 가능하고 진화 가능하게 만든다.

---

## 14. 흔한 실수와 해결

### 실수 1: Over-Engineering the Control Flow
모델은 빠르게 개선된다. "rippable" harness를 만들어라. 모델이 충분히 능력이 생기면 제거할 수 있는 "smart" 로직.

### 실수 2: Harness를 Static으로 취급
Harness는 모델 업데이트에 따라 진화해야 한다. 추론 최적화 미들웨어가 개선된 모델에서는 오히려 역효과 날 수 있다.

### 실수 3: Documentation Layer 무시
> "가장 영향력 있는 harness 개선은 종종 가장 단순하다: 더 나은 문서."

모호한 AGENTS.md → 모호한 에이전트 출력. 문서는 정확하고 machine-readable해야 한다.

### 실수 4: Feedback Loop 부재
> "피드백 없는 harness는 가이드가 아니라 감옥이다."

필수 구축 항목:
- 태스크 완료 전 자가 검증 단계
- 에이전트 워크플로우의 일부로 테스트 실행
- 태스크 유형별 에이전트 성공률 메트릭

### 실수 5: Auto-generated AGENTS.md
`/init` 커맨드나 LLM 자동 생성은 사용하지 마라. 성능이 떨어지면서 비용은 더 나간다.

### 실수 6: Context Bloat
규칙이 시간이 지남에 따라 제거 없이 쌓인다. 모든 실수가 새 규칙 추가를 트리거한다. 의도적으로 최소하게 유지.

### 실수 7: Stale Structural References
아키텍처 문서가 코드베이스 변경 시 오해를 야기. 레포지토리 구조를 문서화하지 마라 (에이전트가 스스로 탐색 가능).

---

## 15. 처음 전략을 짜는 6단계

### Step 1: Forcing Function 설정
Greenfield 모듈에 "no manual code" constraint. 에이전트가 모든 코드를 작성하도록 강제하면, harness의 부족한 부분이 즉시 드러난다.

### Step 2: Intent를 Declarative하게 정의

low-level 구현 지시 대신 specs, ADRs, schemas로 의도를 선언한다.

```markdown
## Intent: Add Team Invitation System
- Email-based invite flow with 7-day expiry
- Role assignment at invite time (admin, member, viewer)
- Invited user sees pending invites on first login
- Must pass: unit tests for invite logic, integration tests for email send
- Constraints: no new DB tables without ADR approval
```

### Step 3: Traceability 계측
에이전트의 모든 스텝을 로그하고, failure 패턴을 클러스터링한다.

### Step 4: 수정사항을 영구 Constraint로 전환

```
예: "에이전트가 API endpoint에 input validation 빼먹음"
→ eslint/biome custom rule 추가: route handler에 zod schema 필수
→ CI에서 자동 검출
→ agents.md에서 관련 지시 제거 (도구가 이제 강제하니까)
```

### Step 5: Hybrid Checks (Rule + LLM)
- Deterministic: vitest, eslint, tsc --noEmit, biome
- AI-driven: 에이전트가 다른 에이전트의 PR 리뷰
- 두 가지를 조합해서 verification pipeline 구축

### Step 6: Entropy 모니터링
주기적으로 refactoring 에이전트를 돌려서 dead code 제거, 컨벤션 드리프트 방지.

---

## 16. 필수 기술 역량

1. **Systems thinking** — constraints, feedback loops, documentation이 어떻게 상호작용하는지 이해
2. **Architecture design** — 강제 가능하면서 생산적인 경계 정의
3. **Specification writing** — 에이전트가 안정적으로 실행할 만큼 정확하게 의도를 표현
4. **Observability** — 에이전트 행동 패턴을 드러내는 모니터링 구축
5. **Iteration speed** — harness 설정을 빠르게 테스트하고 정제

---

## 17. 미해결 과제 (Open Questions)

1. **Harness Coherence**: guides와 sensors가 늘어날 때, 서로 모순되지 않게 일관성을 어떻게 유지하나?
2. **Agent Trade-offs**: 지시와 피드백 신호가 충돌할 때, 에이전트가 얼마나 안정적으로 탐색할 수 있나?
3. **Sensor Coverage**: sensor가 한 번도 트리거 안 되면, 높은 품질인가 감지 메커니즘이 부족한가?
4. **Quality Measurement**: harness 시스템 자체의 코드 커버리지/mutation testing에 해당하는 평가 방법론이 필요
5. **Behaviour Verification**: AI 생성 테스트에 대한 신뢰도를 높여 수동 테스트/supervision을 줄이는 방법

> "이 외부 harness 구축은 일회성 설정이 아니라, 지속적인 엔지니어링 프랙티스로 떠오르고 있다."

---

## 18. 검증 & 트러블슈팅

**설정 확인:**
```bash
codex --ask-for-approval never "Summarize current instructions"
```

**자주 발생하는 문제:**
- Stale instructions → Codex 재시작 (매 실행마다 rebuild)
- 잘못된 guidance → 숨겨진 `AGENTS.override.md` 파일 확인
- 잘림 현상 → `project_doc_max_bytes` 올리거나 디렉토리별 분할
- 빈 파일 → Codex가 무시함, 내용 존재 확인
- 로그 확인: `~/.codex/log/codex-tui.log`

---

## Sources
- [Harness Engineering (Martin Fowler)](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html)
- [Harness Engineering: Leveraging Codex in an Agent-First World (OpenAI)](https://openai.com/index/harness-engineering/)
- [Unlocking the Codex Harness: How We Built the App Server (OpenAI)](https://openai.com/index/unlocking-the-codex-harness/)
- [Custom Instructions with AGENTS.md (OpenAI Developers)](https://developers.openai.com/codex/guides/agents-md)
- [App Server (OpenAI Developers)](https://developers.openai.com/codex/app-server)
- [AGENTS.md Specification](https://agents.md/)
- [AGENTS.md Specification: A Research-Backed Guide (ASDLC.io)](https://asdlc.io/practices/agents-md-spec/)
- [How to Build Your AGENTS.md (Augment Code)](https://www.augmentcode.com/guides/how-to-build-agents-md)
- [Harness Engineering Complete Guide (NxCode)](https://www.nxcode.io/resources/news/harness-engineering-complete-guide-ai-agent-codex-2026)
- [Harness Engineering in 2026 (agent-engineering.dev)](https://www.agent-engineering.dev/article/harness-engineering-in-2026-the-discipline-that-makes-ai-agents-production-ready)
- [OpenAI Introduces Harness Engineering (InfoQ)](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex/)
- [ETH Zurich: Evaluating AGENTS.md (Gloaguen et al., 2026)](https://agents.md/)
