# ⛵ Vela Engine v3.2 — Sandbox Development System

**Vela**(돛자리)는 Claude Code를 완전히 감싸는 샌드박스 엔진이다.
Claude Code는 독자적으로 작동할 수 없으며, 모든 행위는 Vela의 파이프라인을 통해서만 진행된다.

---

## 사상 (Philosophy)

### 1. ⛵ 통제된 자유 (Controlled Autonomy)
AI 코딩 도구는 강력하지만, 통제 없는 자유는 위험하다. Vela는 **"언제, 어떤 순서로, 누구의 검증을 거쳐 할 수 있는가"**를 강제한다.

### 2. 🌟 이중 방어 (Defense in Depth)
- **Gate Keeper** + **Gate Guard** — 훅 레벨 이중 차단 (Fail-closed: 예외 발생 시 exit(2)로 도구 차단)
- **HMAC-SHA256 서명 체인** — delegation.json, review-*.md 위조 방지. 미서명/변조 시 게이트에서 거부
- **Reviewer** (SDK 3단계: Haiku→Sonnet→Opus) — 비용 효율적 독립 평가
- **Permission deny** + **Hook exit(2)** — 시스템 + 코드 레벨
- **GUARD 0**: 파이프라인 중 TaskCreate 차단
- **pipeline-state.json + config.json 보호**: 직접 수정 불가

### 3. 🔭 추적 가능한 개발 (Traceable Development)
산출물(research.md, plan.md, review-*.md, approval-*.json), git 커밋에 파이프라인 참조, TreeNode 캐시.

### 4. ✦ 구조로 강제 (Enforce by Structure)
지시는 무시된다. 산출물이 없으면 전이 차단. approval 없으면 다음 단계 불가. `--scale` 미지정 시 init 거부. PM은 코드를 직접 작성할 수 없다 — 모든 코드 실행은 SDK Executor를 통해서만 가능하다.

---

## 빠른 시작

### 1. 설치 (1회)

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/install.sh | bash
```

설치 시 Claude Agent SDK도 선택적으로 설치된다 (실패해도 기존 방식으로 정상 동작).

### 2. 프로젝트에서 사용

```
/vela
```

선택지 표시:
- **파이프라인 시작** → 작업 설명 입력 → 규모 선택 → 파이프라인 진행
- **환경 구축만** → `.vela/` 설치만

직접 시작: `/vela start OAuth 인증 추가`

### 3. Auto 모드 (무인 실행)

```
/vela auto OAuth 인증 추가
```

Auto 모드에서는:
- 파이프라인 전 단계 자동 진행 (checkpoint 포함)
- Stop hook이 파이프라인 미완료 시 세션 종료를 물리적으로 차단
- PermissionRequest hook이 Write/Edit 권한을 안전한 컨텍스트에서 자동 승인
- 도구 실패 시 자동 기록, API 에러 시 상태 자동 보존

### 4. 업데이트

```bash
# 글로벌만
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/update.sh | bash

# 글로벌 + 현재 프로젝트
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/update.sh | bash -s -- --local
```

---

## 메커니즘

```
✦──────────────────────────────────────────────────────────✦
│                    ⛵ VELA SANDBOX                        │
│                                                           │
│  ⛵ Gate Keeper   🌟 Gate Guard   🧭 Orchestrator        │
│  R/W 모드 강제    파이프라인 순서   매 턴 상태 주입         │
│                                                           │
│  ⛵ PROMPT OPTIMIZER ────────────────────────────        │
│  모든 모드에서 최우선 실행. 불충분한 프롬프트 자동 감지     │
│  AskUserQuestion으로 대상/범위/목적/맥락 보완 유도          │
│                                                           │
│  🧭 PIPELINE ────────────────────────────────────        │
│  init → research → plan → plan-check → checkpoint        │
│       → branch → execute → verify → commit → finalize    │
│                                                           │
│  🔌 SDK ENGINE ──────────────────────────────────        │
│  review:     Haiku→Sonnet→Opus 3단계 리뷰                 │
│  plan-check: Haiku 구조 검증                               │
│  research:   Haiku × 3 병렬 분석 (아키텍처/보안/품질)      │
│  execute:    Sonnet 코드 구현 (TDD)                        │
│  ↳ SDK 미설치 → 기존 Subagent/Teammate 방식 자동 폴백     │
│                                                           │
│  🌟 TEAM ────────────────────────────────────────        │
│  Subagent: 독립 작업 (Haiku/Sonnet/Opus)                   │
│  Teammate: 소통 필요 (Research 경쟁가설/CrossLayer)           │
│  TeamCreate/Delete는 Teammate 사용 시에만                   │
│                                                           │
│  ✦ ARCHITECTURE ─────────────────────────────────        │
│  Plan Gate: Architecture/ClassSpec/TestStrategy 필수      │
│  Execute: TDD (test → implement → refactor)              │
│  approval-{step}.json 없으면 전이 차단                    │
✦──────────────────────────────────────────────────────────✦
```

### Explore / Develop 듀얼 모드

| 모드 | 상태 | 허용 | 차단 |
|------|------|------|------|
| **⛵ Explore** | 파이프라인 없음 | 읽기, 탐색 | 쓰기, TaskCreate(파이프라인 중) |
| **🧭 Develop** | 파이프라인 활성 | 단계에 따름 | 단계 건너뛰기, TaskCreate |

### Research 모드 (Explore에서)

깊은 분석 요청 시 AskUserQuestion으로 방식 선택:
- **Solo** — 직접 분석, 가장 빠름
- **Subagent** (Sonnet) — 독립 리서처 1명
- **Teammate 3명** (Opus) — 경쟁가설 디버깅, 서로 가설 반박/검증

분석 후 수정 필요 시 → 파이프라인 시작 / 추가 조사 / 완료 선택

---

## 프롬프트 최적화

모든 모드에서 **사용자 요청이 들어오면 프롬프트를 먼저 분석**한다.
대상/범위/목적/기술적 맥락이 부족하면 AskUserQuestion으로 보완을 유도.

```
사용자: "코드 수정해줘"

⛵ Vela Prompt Optimizer:
  1차) 보완 항목 선택 (이대로 진행/대상 지정/범위 좁히기/문제 상세)
  2차) 선택 항목의 세부 정보 수집
  3차) PM이 수집 정보를 조립하여 명확한 프롬프트 작성
  4차) 조립된 프롬프트를 사용자에게 보여주고 확인
  5차) 승인 → 조립된 프롬프트로 파이프라인 시작
```

**충분한 프롬프트는 바로 진행** — "이대로 진행 (Recommended)"으로 스킵 가능.

---

## 파이프라인

| 종류 | 단계 | 선택 |
|------|------|------|
| **standard** | init → research → plan → plan-check → checkpoint → branch → execute → verify → commit → finalize | `--scale large` |
| **quick** | init → plan → execute → verify → commit → finalize | `--scale medium` |
| **trivial** | init → execute → commit → finalize | `--scale small` |
| **ralph** | init → execute ↔ verify (반복) → commit → finalize | `--scale ralph` |
| **hotfix** | init → execute → commit | `--scale hotfix` |

`--scale` 필수. 미지정 시 AskUserQuestion으로 사용자에게 선택 요구.

### Ralph 모드
테스트 통과까지 execute → verify를 최대 10회 자동 반복. 버그 수정/TDD에 적합.

### Hotfix 모드
비-소스 변경(문서, 설정, README)용 최소 파이프라인. 리뷰 스킵.

### Pipeline 템플릿
`templates/presets.json`에 사전 정의된 패턴: auth, api-crud, bugfix, refactor, migration, docs

---

## Hook 시스템 (18개)

Vela는 Claude Code Hook API를 활용하여 18개 hook으로 개발 행위를 물리적으로 통제한다.

### Hook 목록

| Hook | 이벤트 | 타입 | 역할 |
|------|--------|------|------|
| **Gate Keeper** | PreToolUse | command | R/W 모드 강제, Bash/시크릿 차단 |
| **Gate Guard** | PreToolUse | command | 파이프라인 순서 강제 (GUARD 0~12) |
| **Orchestrator** | UserPromptSubmit | command | 매 턴 상태/directive 주입, 에스컬레이션 소비 |
| **Tracker** | PostToolUse | command | 도구 사용 기록, trace.jsonl |
| **Stop** | Stop | command | 파이프라인 미완료 시 `decision:block`으로 세션 종료 차단 |
| **SessionStart** | SessionStart | command | 중단된 파이프라인 자동 재개 |
| **Compact** (Pre/Post) | PreCompact / PostCompact | command | 컨텍스트 압축 시 상태 보존/복원 |
| **SubagentStart** | SubagentStart | command | 서브에이전트 위임 설정 (delegation.json) |
| **SubagentStop** | SubagentStop | command | 서브에이전트 출력 수확, 에스컬레이션 감지 |
| **TaskCompleted** | TaskCompleted | command | 소통 이력 검증 |
| **Permission** | PermissionRequest | command | Auto+execute+delegation 시 Write/Edit 자동 승인 |
| **Failure** | PostToolUseFailure | command | 도구 실패 로깅, 연속 3회 경고 |
| **StopFailure** | StopFailure | command | API 에러 시 상태 스냅샷 보존 |
| **TeammateIdle** | TeammateIdle | command | 멈춘 Teammate 감지 알림 |
| **ReviewPrompt** | PostToolUse | prompt | Write/Edit 후 경량 코드 검사 |
| **TestAsync** | PostToolUse | async | 백그라운드 테스트 실행 + 결과 systemMessage |
| **Notification** | Notification | command | 데스크톱 알림 (macOS/Linux) |

### Hook 타입

| 타입 | 설명 |
|------|------|
| **command** | Node.js 스크립트 실행. stdin JSON → stdout JSON + exit code |
| **prompt** | 인라인 프롬프트. 모델이 직접 검사 수행 |
| **async** | 비동기 실행. Claude가 기다리지 않고 결과는 다음 턴에 systemMessage로 전달 |

### if 조건 최적화

tool 이벤트 hook에 `if` 필드로 실행 대상을 제한하여 불필요한 hook spawn을 감소시킨다:
- Permission hook: `if: "Write(*)|Edit(*)|NotebookEdit(*)"` — 파일 수정 도구에만 반응
- 비-tool 이벤트(Stop, Notification 등)에는 if 조건 적용 불가 (적용 시 hook이 절대 실행되지 않음)

---

## SDK 엔진 — Agent SDK 통합

Vela는 `@anthropic-ai/claude-agent-sdk`를 사용하여 리뷰, 리서치, 계획 검증, 실행을 엔진 CLI에서 직접 수행한다. PM이 Subagent를 소환하는 간접 제어에서, 엔진이 SDK로 에이전트를 직접 spawn하는 직접 제어로 전환한다.

### SDK 모드 vs 비-SDK 모드

| 항목 | SDK 모드 | 비-SDK 모드 |
|------|----------|------------|
| 리뷰 | Haiku→Sonnet→Opus 3단계 (비용 ~80%↓) | PM → Reviewer Subagent |
| 리서치 | Haiku × 3 병렬 (비용 ~70%↓) | PM → Researcher Subagent |
| plan-check | Haiku 자동 검증 | PM 직접 검증 |
| 실행 | SDK Executor (Sonnet) | PM → Executor Subagent |
| PM 코드 작성 | 구조적으로 차단 | 프롬프트 규칙으로 차단 |
| 인증 | Claude Code 세션 인증 상속 | 동일 |

SDK 미설치 시 자동 폴백 — 기존 Subagent/Teammate 방식으로 동작한다.

### SDK 커맨드

```bash
node .vela/cli/vela-engine.js review      # Haiku→Sonnet→Opus 3단계 리뷰
node .vela/cli/vela-engine.js plan-check   # Haiku plan.md 구조 검증
node .vela/cli/vela-engine.js research     # 3-관점 병렬 리서치 (Haiku × 3)
node .vela/cli/vela-engine.js execute      # Sonnet TDD 코드 구현

# 분석 보고서
node .vela/cli/vela-analyze.js deps                              # 의존성 분석 (무료)
node .vela/cli/vela-analyze.js run --perspectives security,bugs  # SDK 코드 분석
node .vela/cli/vela-analyze.js full --items deps,security        # 통합 분석 → PDF
node .vela/cli/vela-analyze.js report --input data.json          # JSON → PDF
```

### SDK 모듈 구조

```
scripts/hooks/shared/
├── sdk-runner.js        ← 공통 인프라 (인증, 폴백, rate limit 재시도, hook 격리)
├── sdk-reviewer.js      ← 3단계 Haiku→Sonnet→Opus 리뷰 + HMAC 서명
├── sdk-plan-checker.js  ← Haiku plan.md 구조 검증
├── sdk-researcher.js    ← 3관점 병렬 분석 (architecture/security/quality)
├── sdk-executor.js      ← Sonnet TDD 실행 (inlined executor.md + tdd.md)
├── sdk-analyzer.js      ← 5관점 병렬 코드 분석 (security/bugs/performance/code-quality/architecture)
├── dep-analyzer.js      ← npm audit/outdated 의존성 분석 (SDK 불필요)
└── hmac.js              ← HMAC-SHA256 서명/검증 (delegation.json, review-*.md)
```

각 모듈은 동일한 CJS 패턴을 따른다:
- `settingSources: []` — SDK 에이전트에 Vela 훅이 로드되지 않음 (hook 격리)
- `permissionMode: 'bypassPermissions'` — 엔진 제어 하에 자동 실행
- SDK 미설치 시 `{ ok: false, error: 'sdk_not_available' }` 반환 — graceful fallback
- Rate limit 발생 시 exponential backoff 자동 재시도 (maxRetries: 3)

### 에스컬레이션

리뷰 점수 기반 자동 에스컬레이션:
- Haiku 점수 ≥ 20 → 즉시 pass (단일 모델, ~$0.05)
- Haiku 점수 15-19 → Sonnet 심층 리뷰 (~$0.15)
- Haiku 점수 < 15 → Opus rescue (~$0.30)
- Sonnet 점수 < 20 → Opus rescue
- Opus도 실패 → reject + escalation.json

---

## 분석 보고서 — `/vela analyze`

프로젝트의 의존성과 코드를 분석하여 PDF 보고서를 생성한다. 6개 분석 항목을 체크박스로 선택하고, SDK 관점이 포함되면 모델(Haiku/Sonnet)을 선택한다.

### 분석 항목

| 항목 | 방식 | 비용 |
|------|------|------|
| 📦 의존성 (deps) | npm audit/outdated CLI | **무료** |
| 🔒 보안 (security) | SDK Haiku/Sonnet | 토큰 과금 |
| 🐛 버그 (bugs) | SDK Haiku/Sonnet | 토큰 과금 |
| ⚡ 성능 (performance) | SDK Haiku/Sonnet | 토큰 과금 |
| 📐 코드 품질 (code-quality) | SDK Haiku/Sonnet | 토큰 과금 |
| 🏗️ 아키텍처 (architecture) | SDK Haiku/Sonnet | 토큰 과금 |

### CLI 사용법

```bash
# 의존성만 분석 (무료)
node .vela/cli/vela-analyze.js deps

# JSON → PDF 변환
node .vela/cli/vela-analyze.js report --input results.json --output report.pdf

# SDK 코드 분석 (관점 선택)
node .vela/cli/vela-analyze.js run --perspectives security,bugs --model haiku

# 통합 분석 — 의존성 + SDK 분석 → PDF
node .vela/cli/vela-analyze.js full --items deps,security,performance --model sonnet --output report.pdf
```

### 분석 모듈

- **dep-analyzer.js**: npm audit/outdated를 실행하여 취약점·outdated 패키지를 정규화된 JSON으로 반환. SDK 불필요.
- **sdk-analyzer.js**: 5개 관점으로 코드를 병렬 분석. extractFindings()의 3단계 JSON 추출(code block → bare JSON → text fallback)으로 SDK 응답을 정규화.

### PDF 보고서

pdfkit으로 생성. 타이틀 페이지, severity별 색상 코딩(critical=빨강, high=주황, moderate=노랑, low=파랑), outdated 패키지, 코드 분석 관점별 findings 포함. 부분 실패 허용 — 하나의 분석기가 실패해도 나머지 결과로 PDF를 생성한다.

---

## 팀 메커니즘

### 모델 선택 전략

| 작업 유형 | 모델 | 역할 |
|----------|------|------|
| 파일 탐색/검색 | **Haiku** | 탐색 전용 subagent |
| 코드 구현/리뷰 | **Sonnet** | Executor, Reviewer, Conflict Manager |
| 설계/디버깅/분석 | **Sonnet** (기본) | Researcher, Planner (에스컬레이션 시 Opus) |

### Teammate vs Subagent

| 조건 | 방식 | model |
|------|------|-------|
| 경쟁가설 디버깅 (리서치) | **Teammate** | `"opus"` |
| CrossLayer/다중 파일 동시 수정 | **Teammate** | `"sonnet"` |
| 독립 리뷰/점검 | **Subagent** | `"sonnet"` |
| 단일 모듈 수정 | **Subagent** | `"sonnet"` |
| 파일 탐색 | **Subagent** | `"haiku"` |
| 설계/분석 | **Subagent** | `"sonnet"` → 에스컬레이션 시 `"opus"` |

### 팀 규칙

- **팀 크기**: 3~5명 (개발 팀원 + Conflict Manager 1명)
- **태스크 배분**: 팀원당 5~6개
- **파일 소유권**: 각 팀원에게 담당 파일 명시 부여
- **에이전트 MD**: 목차(TOC) 기반 로딩 — 필요한 섹션만 선택적으로 읽기

### CrossLayer Development

다중 계층 작업 시 Teammate + Conflict Manager + Git Worktree:
```
TeamCreate → frontend-dev(Sonnet) + backend-dev(Sonnet) + db-dev(Sonnet) + conflict-manager(Sonnet)
각 팀원: isolation: "worktree" + 담당 파일 + 5~6개 태스크
팀원 간 SendMessage로 인터페이스 조율
Conflict Manager가 최종 병합 + 충돌 해결
```

### 승인 메커니즘 — 파일 기반

- **SDK 모드**: sdk-reviewer.js가 3단계 리뷰 → review-{step}.md + approval-{step}.json 자동 생성
- **비-SDK 모드**: Reviewer (Subagent, Sonnet) → `review-{step}.md` → PM → `approval-{step}.json`
- 엔진 exit gate가 파일 확인 → 없으면 transition 차단

---

## Auto 모드

Auto 모드(`/vela auto` 또는 `--auto`)는 파이프라인을 완전 무인으로 실행한다.

### 물리적 강제 (Hard Automation)

| 메커니즘 | Hook | 동작 |
|---------|------|------|
| **세션 종료 차단** | Stop | 파이프라인 미완료 시 `decision:block` 반환. `stop_hook_active` 가드로 무한루프 방지 |
| **권한 자동 승인** | Permission | Auto+execute+delegation+WRITE_TOOLS 4조건 AND 게이트로 Write/Edit 자동 승인 |
| **실패 복구** | Failure | 연속 3회 도구 실패 시 additionalContext 경고. 카운터 자동 리셋 |
| **상태 보존** | StopFailure | API rate limit/server error 시 파이프라인 상태 스냅샷을 artifact 디렉토리에 보존 |
| **에스컬레이션** | SubagentStop + Orchestrator | Reviewer 점수 미달 → escalation.json → Opus 재소환 directive |

### 자동 품질 검사

| 메커니즘 | Hook | 동작 |
|---------|------|------|
| **경량 코드 리뷰** | ReviewPrompt (prompt) | Write/Edit 후 즉석 코드 검사 |
| **백그라운드 테스트** | TestAsync (async) | 변경 파일의 관련 테스트를 비동기 실행, systemMessage로 결과 보고 |
| **데스크톱 알림** | Notification | permission_prompt, idle_prompt 등 사용자 주의 필요 이벤트 알림 |

---

## 방어 시스템

### ⛵ Gate Keeper (PreToolUse)

| 게이트 | 코드 | 규칙 |
|--------|------|------|
| Bash 차단 | VK-01, VK-02 | Vela CLI 외 차단. 안전한 읽기 명령은 모든 모드 허용. 파이프라인 활성 시 git/gh 허용 |
| 모드 강제 | VK-03, VK-04 | 읽기전용에서 Write/Edit 차단 |
| 민감파일 보호 | VK-05 | .env, credentials.json, config.json 차단 |
| 시크릿 감지 | VK-06 | 15개 패턴 차단 |
| PM 속독 + HMAC | VK-07 | PM은 Read/Glob/Grep 허용, Write/Edit 차단. delegation.json HMAC 검증 (미서명/변조 시 exit 2) |
| 체인 연산자 차단 | VK-08 | SAFE_BASH_READ 명령에서 체인 연산자(&&, \|\|, ;, \|) 차단. `ls && rm -rf /` 방지 |

### 🌟 Gate Guard (PreToolUse)

| 가드 | 코드 | 규칙 |
|------|------|------|
| GUARD 0 | VG-00 | 파이프라인 중 TaskCreate/TaskUpdate 차단 |
| GUARD 1 | VG-01 | research.md 없이 plan.md 불가 |
| GUARD 2 | VG-02 | execute 전 소스코드 수정 불가 + pipeline-state.json 보호 + config.json 쓰기 차단 (VG-05) |
| GUARD 3 | VG-03 | 빌드/테스트 실패 시 commit 불가. corrupt signals file 시 exit(2) + 복구 안내 |
| GUARD 5 | VG-05 | pipeline-state.json 직접 수정 불가 |
| GUARD 7 | VG-07 | execute/commit/finalize에서만 git commit 허용 |
| GUARD 8 | VG-08 | verify 완료 전 git push 차단 |
| GUARD 11 | VG-11 | 비-team 단계에서 approval/review 작성 차단 |
| GUARD 12 | VG-12 | execute 단계 PM 직접 소스 수정 차단 — 위임 강제. delegation.json HMAC 검증 (trivial 면제) |

### 차단 시 자동 복구 (Block Recovery)

```
Claude: src/auth.js 수정 시도
  ↓
Hook: 🌟 [Vela] ✦ BLOCKED [VG-02]: Source code modification before execute step.
      Recovery: Complete steps first: research → plan → execute
  ↓
Claude: [VG-02] → 복구 테이블 참조 → vela-engine transition 실행
```

### Permission Deny (절대 차단)

`rm -rf`, `git push --force`, `git reset --hard`, `git commit --no-verify`, `git clean -f`

### 🔐 HMAC 서명 체인

Vela는 HMAC-SHA256 서명으로 보안 관련 아티팩트의 위조를 방지한다.

| 대상 | 서명 시점 | 검증 시점 | 서명 방식 |
|------|----------|----------|----------|
| delegation.json | SubagentStart hook | Gate Keeper (VK-07), Gate Guard (VG-12), Permission hook | JSON canonical form (sorted keys, `_hmac` 필드) |
| review-*.md | sdk-reviewer.js 작성 후 | vela-engine exit gate | Companion `.hmac` sidecar 파일 |
| config.json | — | Gate Keeper (VK-05), Gate Guard (VG-05) | 쓰기 자체 차단 (서명 불필요) |

- **키 생성**: `vela-engine init` 시 `.vela/state/hmac-key` 자동 생성
- **검증 실패 시**: exit(2)로 도구 차단 (fail-closed)
- **키 없는 환경**: graceful skip (HMAC 도입 전 파이프라인 호환)
- **정리**: step transition/cancel 시 delegation.json 자동 삭제

### Fail-Closed 보안 모델

Gate Keeper와 Gate Guard의 모든 오류 경로는 fail-closed로 동작한다:
- Corrupt stdin → exit(2) — 도구 차단
- 빈 stdin → exit(2) — 도구 차단
- 미처리 예외 → exit(2) — 도구 차단
- HMAC 검증 실패 → exit(2) — 도구 차단

정상 허용만 exit(0)을 반환한다. 오류 발생 시 안전한 방향(차단)으로 동작.

---

## 인터랙티브 UI (AskUserQuestion)

| 단계 | 선택 UI |
|------|---------|
| `/vela` 호출 | 파이프라인 시작 / 환경 구축만 |
| Research 방식 | Solo / Subagent / Teammate 3명 (경쟁가설) |
| 파이프라인 규모 | Small / Medium / Large |
| **Checkpoint** | 승인 / 변경 요청 / 취소 |
| **Commit** | 이 메시지 / 수정 / diff 확인 |
| **Finalize** | PR 생성 / 생성 안 함 |

---

## 산출물 구조

```
.vela/artifacts/{date}_{id}_{slug}/
├── meta.json, pipeline-state.json
├── research.md, review-research.md, approval-research.json
├── plan.md, review-plan.md, approval-plan.json
├── plan-check.md
├── review-execute.md, approval-execute.json
├── verification.md, report.md, diff.patch, trace.jsonl
├── escalation.json (에스컬레이션 발생 시, 일회성)
├── subagent-{agent_id}.md (서브에이전트 출력 수확)
├── stop-failure-{timestamp}.json (API 에러 상태 스냅샷)
```

---

## 설치 구조

```
$HOME/.claude/skills/vela/       ← 글로벌 스킬 (curl 설치 시)
  ├── SKILL.md                   ← 스킬 진입점
  ├── package.json               ← optionalDependencies: @anthropic-ai/claude-agent-sdk
  ├── scripts/
  │   ├── hooks/                 ← 18 hooks
  │   │   └── shared/            ← pipeline.js, constants.js, hmac.js, 6개 SDK 모듈
  │   │       ├── sdk-runner.js        ← SDK 인프라 (인증/폴백/rate limit/hook 격리)
  │   │       ├── sdk-reviewer.js      ← 3단계 Haiku→Sonnet→Opus 리뷰 + HMAC 서명
  │   │       ├── sdk-plan-checker.js  ← Haiku plan.md 구조 검증
  │   │       ├── sdk-researcher.js    ← 3관점 병렬 분석
  │   │       ├── sdk-executor.js      ← Sonnet TDD 실행
  │   │       ├── sdk-analyzer.js      ← 5관점 코드 분석 (security/bugs/perf/quality/arch)
  │   │       ├── dep-analyzer.js      ← npm audit/outdated 의존성 분석
  │   │       └── hmac.js              ← HMAC-SHA256 서명/검증 (delegation.json, review-*.md)
  │   ├── cli/                   ← vela-engine, vela-read, vela-write, vela-cost, vela-report, vela-analyze
  │   ├── agents/                ← vela.md, researcher, planner, executor, reviewer, conflict-manager, leader
  │   ├── cache/                 ← TreeNode SQLite
  │   ├── guidelines/            ← coding-standards, error-handling, testing-strategy
  │   ├── tests/                 ← 14개 계약 테스트 스위트
  │   ├── install.js             ← 설치/검증/복구/upgrade
  │   └── statusline.sh          ← ⛵ 하단 바
  ├── templates/                 ← pipeline.json, config.json, presets.json
  └── references/                ← interactive-ui.md, gates-and-guards.md, cli-reference.md

your-project/                    ← /vela init 실행 후
  ├── .vela/                     ← 프로젝트별 설치 (hooks, cli, agents, templates 복사)
  ├── .claude/
  │   ├── settings.local.json    ← 18 hooks + permission + agent + spinner + statusLine
  │   └── agents/vela.md         ← 기본 에이전트
  └── CLAUDE.md                  ← Vela 규칙
```

### install.js 명령어

| 명령 | 설명 |
|------|------|
| `node .vela/install.js` | 18개 훅 설치 + 유효성 검증 |
| `node .vela/install.js verify` | 설치 검증만 (JSON 출력: `--json`) |
| `node .vela/install.js upgrade` | 모든 파일을 최신 버전으로 갱신 (config.json 제외) |
| `node .vela/install.js status` | 현재 훅 상태 확인 |
| `node .vela/install.js uninstall` | Vela 훅 제거 |

---

## 엔진 명령어

```bash
vela-engine init "설명" --scale <small|medium|large|ralph|hotfix>
vela-engine init "설명" --scale large --auto   # Auto 모드
vela-engine state
vela-engine transition
vela-engine record pass|fail
vela-engine sub-transition
vela-engine branch [--mode auto|prompt|none]
vela-engine commit [--message TEXT]
vela-engine cancel
vela-engine history
vela-engine review                               # SDK 3단계 리뷰 (Haiku→Sonnet→Opus)
vela-engine plan-check                           # SDK plan.md 구조 검증 (Haiku)
vela-engine research                             # SDK 3-관점 병렬 리서치 (Haiku × 3)
vela-engine execute                              # SDK 단일 실행 (Sonnet)
vela-cost                                        # 파이프라인 비용/메트릭
vela-report [--html output.html]                 # 파이프라인 리포트/대시보드
vela-analyze deps                                # 의존성 분석 (무료, npm audit/outdated)
vela-analyze run --perspectives <list> [--model]  # SDK 코드 분석
vela-analyze full --items <list> [--model] [--output] # 통합 분석 → PDF
vela-analyze report --input <file> [--output]    # JSON → PDF 변환
```

---

## 테스트

21개 계약 테스트 스위트로 Vela의 핵심 메커니즘을 검증한다.

```bash
# 전체 SDK 통합 테스트 (81 assertions)
bash scripts/tests/test-sdk-integration.sh

# 분석 보고서 E2E (22 assertions)
bash scripts/tests/test-analyze-e2e.sh

# SDK 분석 엔진 (27 assertions)
bash scripts/tests/test-sdk-analyzer.sh

# 보안 강화 테스트 (M008)
bash scripts/tests/test-fail-closed.sh        # 7 assertions — Fail-closed 게이트
bash scripts/tests/test-chain-operators.sh     # 13 assertions — 체인 연산자 차단
bash scripts/tests/test-hmac-signing.sh        # 13 assertions — HMAC 서명 체인
bash scripts/tests/test-s03-relaxation.sh      # 21 assertions — 파이프라인 완화
bash scripts/tests/test-s04-hardening.sh       # 21 assertions — 코드 품질 강화

# 개별 테스트 스위트
bash scripts/tests/test-sdk-runner.sh       # 14 assertions — SDK 인프라
bash scripts/tests/test-sdk-reviewer.sh     # 18 assertions — 3단계 리뷰
bash scripts/tests/test-sdk-plan-checker.sh # 13 assertions — plan.md 검증
bash scripts/tests/test-sdk-researcher.sh   # 23 assertions — 3관점 분석
bash scripts/tests/test-sdk-executor.sh     # 13 assertions — 코드 실행
bash scripts/tests/test-gate-vk07.sh        # Gate Keeper 규칙
bash scripts/tests/test-auto-mode.sh        # Auto 모드 (16 assertions)
bash scripts/tests/test-stop-hook.sh        # Stop hook
bash scripts/tests/test-subagent-stop.sh    # SubagentStop + 에스컬레이션
bash scripts/tests/test-permission-hook.sh  # PermissionRequest 자동 승인
bash scripts/tests/test-failure-hooks.sh    # Failure/StopFailure/TeammateIdle
bash scripts/tests/test-prompt-async-hooks.sh # ReviewPrompt + TestAsync
bash scripts/tests/test-notification-hook.sh  # 데스크톱 알림
```

⚠️ SDK 테스트 스위트들은 공유 mock 디렉토리를 사용하므로 **순차 실행** 필수 (병렬 실행 시 mock collision 발생).

---

## 커스텀 어조 — persona.md

`.vela/persona.md` 파일에 어조 규칙을 작성하면 Orchestrator가 모든 세션에 자동 주입한다.

- 파이프라인 활성 여부와 무관하게 항상 주입된다
- 파일이 없거나 비어있으면 아무것도 출력하지 않는다

예시 (`.vela/persona.md`):
```markdown
- 한국어로 답변하라
- 간결하고 명확하게 말하라
- 코드 주석은 영어로 작성하라
```

---

## 버전 이력

| 버전 | 마일스톤 | 주요 변경 |
|------|---------|----------|
| v1.0 | — | Gate Keeper + Gate Guard + Orchestrator + Tracker 기본 4 hook, 5종 파이프라인 |
| v2.0 | M001 | 비용 최적화(Opus→Sonnet), Auto 모드, PM 속독, Bash 완화, persona.md |
| v2.5 | M002 | Hook 4→18개, Stop/SubagentStop/Permission/Failure/Prompt/Async/Notification |
| v3.0 | M003 | Agent SDK 통합, 5개 SDK 모듈, 3단계 리뷰, PM 코드 작성 구조 차단 |
| v3.1 | M004 | 분석 보고서, dep-analyzer + sdk-analyzer, vela-analyze CLI, PDF 생성, `/vela analyze` |
| v3.1 | M005 | UI 세계관 고도화 — statusline 컬러 그라데이션+유니코드 프로그레스 바, Orchestrator 박스 드로잉, 18개 hook description 항해 세계관 통합 |
| v3.1 | M006 | 글로벌 오염 정리 — ~/.claude/ 잔여물 회수, 서브스킬 플랫 복사 제거, install.js 자기 치유 가드 |
| v3.1 | M007 | 프로젝트 전수 검수 — 코드베이스 ~14,500줄 정밀 감사. AUDIT-001~059 (High 8, Medium 24, Low 27) |
| v3.2 | M008 | 전수 수정 — Fail-closed 게이트, HMAC-SHA256 서명 체인, 체인 연산자 차단(VK-08), 파이프라인 완화(trivial/hotfix exit_gate:[]), execFileSync 전환(35+ callers), SQL parameterization, SDK null guards. 21개 테스트 스위트 230/230 PASS |

---

## 라이선스

MIT License — Copyright (c) 2026 EcoKG
