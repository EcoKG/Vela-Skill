# ⛵ Vela Engine v4.1 — Sandbox Development System

**Vela**(돛자리)는 Claude Code를 완전히 감싸는 샌드박스 엔진이다.
Claude Code는 독자적으로 작동할 수 없으며, 모든 행위는 Vela의 파이프라인을 통해서만 진행된다.

---

## 사상 (Philosophy)

### 1. ⛵ 통제된 자유 (Controlled Autonomy)
AI 코딩 도구는 강력하지만, 통제 없는 자유는 위험하다. Vela는 **"언제, 어떤 순서로, 누구의 검증을 거쳐 할 수 있는가"**를 강제한다.

### 2. 🌟 이중 방어 (Defense in Depth)
- **Gate Keeper** + **Gate Guard** — SDK 콜백 레벨 이중 차단 (Fail-closed: 예외 발생 시 도구 차단)
- **Reviewer** (SDK Opus 단일) — 고품질 독립 평가
- **Permission deny/allow** — settings.local.json deny 패턴으로 절대 차단, allow 패턴으로 읽기 도구 자동 허용
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
- SDK 오케스트레이터가 단계별 Agent를 spawn하여 완전 무인 실행
- 도구 실패 시 자동 기록, API 에러 시 상태 자동 보존

### 4. 업데이트

```bash
# Claude Code 내부에서 (권장)
/vela update

# 또는 터미널에서 직접
# 글로벌만
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/update.sh | bash

# 글로벌 + 현재 프로젝트
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/update.sh | bash -s -- --local
```

`/vela update`는 현재 워크스페이스에 `.vela/`가 있으면 자동으로 `--local`을 포함해 로컬도 함께 업데이트한다.

**자동 업데이트 알림:** Vela는 설치 시 Claude Code의 `SessionStart` 훅에 버전 체크 스크립트를 등록한다. 세션을 시작할 때마다 로컬 버전과 GitHub 최신 버전을 비교하고(24시간 캐시, 2초 타임아웃), 새 버전이 있으면 Claude가 사용자에게 "지금 업데이트할까요?"라고 묻는다. "지금 업데이트"를 선택하면 `/vela update`가 바로 실행된다.

---

## 메커니즘

```
✦──────────────────────────────────────────────────────────✦
│                    ⛵ VELA SANDBOX                        │
│                                                           │
│  ⛵ Gate Keeper   🌟 Gate Guard   🧭 Orchestrator        │
│  R/W 모드 강제    파이프라인 순서   SDK 단계별 Agent spawn  │
│                                                           │
│  ⛵ PROMPT OPTIMIZER ────────────────────────────        │
│  모든 모드에서 최우선 실행. 불충분한 프롬프트 자동 감지     │
│  AskUserQuestion으로 대상/범위/목적/맥락 보완 유도          │
│                                                           │
│  🧭 PIPELINE ────────────────────────────────────        │
│  init → research → plan → plan-check → checkpoint        │
│       → branch → execute → verify → diff-summary         │
│       → learning → commit → finalize                     │
│                                                           │
│  🔌 SDK ORCHESTRATOR (vela-pipeline.js) ─────────        │
│  review:     Opus 단일 리뷰                               │
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
  4차) PM이 이해 확인(Reflection) 출력 — 대상/작업/범위 요약
  5차) AskUserQuestion으로 "맞다 — 진행" / "수정 필요" 확인 → 승인 시 scale 선택
```

**충분한 프롬프트는 바로 진행** — "이대로 진행 (Recommended)"으로 스킵 가능.

---

## 파이프라인

| 종류 | 단계 | 선택 |
|------|------|------|
| **standard** | init → research → plan → plan-check → checkpoint → branch → execute → verify → diff-summary → learning → commit → finalize | `--scale large` |
| **quick** | init → plan → execute → verify → commit → finalize | `--scale medium` |
| **trivial** | init → execute → commit → finalize | `--scale small` |
| **ralph** | init → execute ↔ verify (반복) → commit → finalize | `--scale ralph` |
| **hotfix** | init → execute → commit | `--scale hotfix` |

`--scale` 필수. 미지정 시 AskUserQuestion으로 사용자에게 선택 요구.

### Ralph 모드
테스트 통과까지 execute → verify를 최대 10회 자동 반복. 버그 수정/TDD에 적합.

### Hotfix 모드
비-소스 변경(문서, 설정, README)용 최소 파이프라인. 리뷰 스킵.

### Diff-Summary / Learning 단계
standard 파이프라인에서 verify 성공 후 commit 전에 실행되는 후처리 단계:
- **diff-summary**: Opus가 전체 diff를 5차원(consistency/completeness/doc-sync/regression/coherence)으로 통합 검토하여 `diff-summary.md` 생성
- **learning**: Haiku가 파이프라인 실행에서 패턴을 추출하여 `learning.md` 생성 및 `learnings.json` 누적

두 단계 모두 non-fatal — SDK 실패 시 경고만 남기고 파이프라인은 계속 진행.

### Verify 재시도 루프
standard 파이프라인에서 verify 실패 시 execute → code-review → verify 사이클을 `max_revisions`(기본 3)까지 자동 반복. 재시도마다 verification.md의 실패 내용을 execute에 주입. 반복 소진 시 `escalate_to_pm`으로 파이프라인 중단.

### Pipeline 템플릿
`templates/presets.json`에 사전 정의된 패턴: auth, api-crud, bugfix, refactor, migration, docs

---

## SDK 오케스트레이터 — vela-pipeline.js

M010에서 도입된 SDK 오케스트레이터는 `@anthropic-ai/claude-agent-sdk`의 `query()` API를 사용하여 파이프라인 단계별 Agent를 직접 spawn한다. 기존 18개 훅 기반 간접 제어에서, 엔진이 SDK로 에이전트를 직접 spawn하는 직접 제어로 전환되었다.

### 아키텍처

```
vela-pipeline.js (오케스트레이터)
  ├── vela-engine.js (상태 머신: init/transition/record)  ← CLI bridge 호출
  ├── sdk-runner.js (SDK 인프라: 인증/폴백/rate limit/격리)
  ├── sdk-reviewer.js (Opus 단일 리뷰)
  ├── sdk-learning.js (Haiku 파이프라인 학습 축적)
  ├── sdk-plan-checker.js (plan 검증)
  ├── sdk-researcher.js (3관점 분석)
  ├── sdk-executor.js (코드 구현)
  └── SDK hooks 콜백 (Gate Keeper/Guard 역할)
       ├── createBashGuard() — R/W 모드 Bash 차단
       ├── createSensitiveFileGuard() — 민감 파일 보호
       ├── createSecretGuard() — 시크릿 패턴 차단
       ├── createProtectedBranchGuard() — 보호 브랜치 차단
       └── createArtifactPathGuard() — rw-artifact 모드 Write 경로 제한 (M023)
```

### 핵심 설계 결정

- **CLI bridge 패턴**: vela-pipeline.js가 vela-engine.js의 상태 전이를 `execFileSync('node', ['vela-engine.js', ...])` 호출로 위임. 상태 머신이 단일 소스로 유지됨.
- **bypassPermissions 필수**: `permissionMode: 'dontAsk'`도 Read 도구에 퍼미션 프롬프트를 발생시킴. 자동 파이프라인에서는 `bypassPermissions` + `allowDangerouslySkipPermissions: true` 조합만 사용.
- **settingSources: []**: 모든 SDK query() 호출에 명시적으로 전달. SDK Agent에 Vela 설정이 로드되지 않음 (재귀 방지).
- **SDK 미설치 폴백**: SDK가 없으면 기존 Subagent/Teammate 방식으로 자동 폴백.

### SDK 모드 vs 비-SDK 모드

| 항목 | SDK 모드 | 비-SDK 모드 |
|------|----------|------------|
| 리뷰 | Opus 단일 리뷰 | PM → Reviewer Subagent |
| 리서치 | Haiku × 3 병렬 (비용 ~70%↓) | PM → Researcher Subagent |
| plan-check | Haiku 자동 검증 | PM 직접 검증 |
| 실행 | SDK Executor (Sonnet) | PM → Executor Subagent |
| PM 코드 작성 | 구조적으로 차단 | 프롬프트 규칙으로 차단 |
| 인증 | Claude Code 세션 인증 상속 | 동일 |
| 훅 오버헤드 | 0 (파이프라인 밖) | 동일 |

### SDK 커맨드

```bash
# SDK 오케스트레이터 실행
node .vela/cli/vela-pipeline.js run "OAuth 인증 추가" --scale large

# 엔진 직접 호출 (SDK 단계별)
node .vela/cli/vela-engine.js review      # Opus 단일 리뷰
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
scripts/shared/
├── sdk-runner.js        ← 공통 인프라 (인증, 폴백, rate limit 재시도, hook 격리)
├── sdk-reviewer.js      ← Opus 단일 리뷰
├── sdk-learning.js      ← Haiku 파이프라인 학습 축적 (패턴 추출 + learnings.json 누적)
├── sdk-plan-checker.js  ← Haiku plan.md 구조 검증
├── sdk-researcher.js    ← 3관점 병렬 분석 (architecture/security/quality)
├── sdk-executor.js      ← Sonnet TDD 실행 (inlined executor.md + tdd.md)
├── sdk-analyzer.js      ← 5관점 병렬 코드 분석 (security/bugs/performance/code-quality/architecture)
├── sdk-diff-summary.js  ← Opus 전체 diff 통합 검토 (5차원: consistency/completeness/doc-sync/regression/coherence)
├── sdk-custom-tools.js  ← MCP 커스텀 도구 서버 팩토리 (3 tools)
├── dep-analyzer.js      ← npm audit/outdated 의존성 분석 (SDK 불필요)
├── change-surface.js    ← 참조 무결성 검증 (diff 기반 cross-file reference 분석)
└── constants.js         ← 가드 패턴 (SAFE_BASH_READ, SECRET_PATTERNS 등)
```

각 SDK 모듈은 동일한 CJS 패턴을 따른다:
- `settingSources: []` — SDK 에이전트에 Vela 설정이 로드되지 않음 (격리)
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

Playwright HTML→PDF로 생성. 타이틀 페이지, severity별 색상 코딩(critical=빨강, high=주황, moderate=노랑, low=파랑), outdated 패키지, 코드 분석 관점별 findings 포함. 부분 실패 허용 — 하나의 분석기가 실패해도 나머지 결과로 PDF를 생성한다.

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

- **SDK 모드**: sdk-reviewer.js가 Opus 단일 리뷰 → review-{step}.md + approval-{step}.json 자동 생성
- **비-SDK 모드**: Reviewer (Subagent, Sonnet) → `review-{step}.md` → PM → `approval-{step}.json`
- 엔진 exit gate가 파일 확인 → 없으면 transition 차단

---

## Auto 모드

Auto 모드(`/vela auto` 또는 `--auto`)는 파이프라인을 완전 무인으로 실행한다.

### SDK 오케스트레이터 자동화

| 메커니즘 | 동작 |
|---------|------|
| **단계별 Agent spawn** | vela-pipeline.js가 각 파이프라인 단계(research/plan/execute/review)에 맞는 SDK Agent를 spawn. 단계별 도구 화이트리스트와 시스템 프롬프트가 코드로 제어됨 |
| **권한 제어** | `permissionMode: 'bypassPermissions'` + `disallowedTools`로 단계별 도구 접근 제어. PM/user 단계는 자동 진행 |
| **실패 복구** | SDK Agent 실패 시 상태 보존 + 에러 기록. Rate limit 시 exponential backoff 재시도 |
| **리뷰** | Opus 단일 리뷰 — 점수 ≥ 20/25 → 승인, 미달 → 거부 |
| **상태 보존** | API 에러 시 파이프라인 상태 스냅샷을 artifact 디렉토리에 보존 |

### 자동 품질 검사

| 메커니즘 | 동작 |
|---------|------|
| **SDK 리뷰** | sdk-reviewer.js가 review 단계에서 Opus 단일 리뷰 수행 |
| **SDK plan-check** | sdk-plan-checker.js가 plan.md 구조를 자동 검증 |
| **exit gate** | 엔진이 단계별 필수 산출물(review-*.md, approval-*.json) 존재를 확인 → 없으면 transition 차단 |

---

## 방어 시스템

### ⛵ Gate Keeper

SDK 오케스트레이터의 PreToolUse 콜백으로 구현. 모든 SDK Agent의 도구 호출을 검사한다.

| 게이트 | 코드 | 규칙 |
|--------|------|------|
| Bash 차단 | VK-01, VK-02 | Vela CLI 외 차단. 안전한 읽기 명령은 모든 모드 허용. 파이프라인 활성 시 git/gh 허용 |
| 모드 강제 | VK-03, VK-04 | 읽기전용에서 Write/Edit 차단 |
| 민감파일 보호 | VK-05 | .env, credentials.json, config.json 차단 |
| 시크릿 감지 | VK-06 | 15개 패턴 차단 |
| PM 속독 | VK-07 | PM은 Read/Glob/Grep 허용, Write/Edit 차단. delegation.json 검증 |
| 체인 연산자 차단 | VK-08 | SAFE_BASH_READ 명령에서 체인 연산자(&&, \|\|, ;, \|) 차단. `ls && rm -rf /` 방지 |

### 🌟 Gate Guard

SDK 오케스트레이터가 단계별 도구 화이트리스트와 `disallowedTools`로 파이프라인 순서를 강제한다.

| 가드 | 코드 | 규칙 |
|------|------|------|
| GUARD 0 | VG-00 | 파이프라인 중 TaskCreate/TaskUpdate 차단 |
| GUARD 1 | VG-01 | research.md 없이 plan.md 불가 |
| GUARD 2 | VG-02 | execute 전 소스코드 수정 불가 + pipeline-state.json 보호 + config.json 쓰기 차단 (VG-05) |
| GUARD 3 | VG-03 | 빌드/테스트 실패 시 commit 불가. corrupt signals file 시 복구 안내 |
| GUARD 5 | VG-05 | pipeline-state.json 직접 수정 불가 |
| GUARD 7 | VG-07 | execute/commit/finalize에서만 git commit 허용 |
| GUARD 8 | VG-08 | verify 완료 전 git push 차단 |
| GUARD 11 | VG-11 | 비-team 단계에서 approval/review 작성 차단 |
| GUARD 12 | VG-12 | execute 단계 PM 직접 소스 수정 차단 — 위임 강제 |

### 차단 시 자동 복구 (Block Recovery)

```
SDK Agent: src/auth.js 수정 시도
  ↓
Guard: 🌟 [Vela] ✦ BLOCKED [VG-02]: Source code modification before execute step.
       Recovery: Complete steps first: research → plan → execute
  ↓
오케스트레이터: 차단 감지 → 올바른 단계로 전이
```

### Permission Deny (절대 차단)

`rm -rf`, `git push --force`, `git reset --hard`, `git commit --no-verify`, `git clean -f`

이 규칙들은 settings.local.json의 deny 패턴으로 등록되어 SDK와 무관하게 Claude Code 레벨에서 절대 차단된다.

### Permission Allow (읽기 도구 자동 허용)

`Read(*)`, `Glob(*)`, `Grep(*)` — PM이 소스 코드를 읽을 때 퍼미션 프롬프트 없이 진행.
VK-07 규칙(PM은 Read/Glob/Grep 허용)과 일치하도록 settings.local.json에 자동 등록된다.

### Fail-Closed 보안 모델

Gate Keeper와 Gate Guard의 모든 오류 경로는 fail-closed로 동작한다:
- 잘못된 입력 → 도구 차단
- 미처리 예외 → 도구 차단

정상 허용만 통과. 오류 발생 시 안전한 방향(차단)으로 동작.

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
.vela/artifacts/{YYYYMMDD}T{HHmmss}-{slug}/
├── meta.json, pipeline-state.json
├── research.md, review-research.md, approval-research.json
├── plan.md, review-plan.md, approval-plan.json
├── plan-check.md
├── review-execute.md, approval-execute.json
├── verification.md, report.md, diff.patch, trace.jsonl
├── escalation.json (에스컬레이션 발생 시, 일회성)
```

---

## 설치 구조

```
$HOME/.claude/skills/vela/       ← 글로벌 스킬 (curl 설치 시)
  ├── SKILL.md                   ← 스킬 진입점
  ├── package.json               ← optionalDependencies: @anthropic-ai/claude-agent-sdk
  ├── scripts/
  │   ├── shared/                ← SDK 모듈 + 공유 유틸리티
  │   │   ├── sdk-runner.js        ← SDK 인프라 (인증/폴백/rate limit/격리)
  │   │   ├── sdk-reviewer.js      ← Opus 단일 리뷰
  │   │   ├── sdk-learning.js      ← Haiku 파이프라인 학습 축적
  │   │   ├── sdk-plan-checker.js  ← Haiku plan.md 구조 검증
  │   │   ├── sdk-researcher.js    ← 3관점 병렬 분석
  │   │   ├── sdk-executor.js      ← Sonnet TDD 실행
  │   │   ├── sdk-analyzer.js      ← 5관점 코드 분석 (security/bugs/perf/quality/arch)
  │   │   ├── sdk-custom-tools.js  ← MCP 커스텀 도구 서버 팩토리
  │   │   ├── dep-analyzer.js      ← npm audit/outdated 의존성 분석
  │   │   ├── change-surface.js    ← 참조 무결성 검증 (diff 기반)
  │   │   └── constants.js         ← 가드 패턴 상수
  │   ├── cli/                   ← vela-engine, vela-pipeline, vela-cost, vela-report, vela-analyze, vela-wave
  │   ├── agents/                ← vela.md, researcher, planner, executor, reviewer, conflict-manager, leader
  │   ├── cache/                 ← TreeNode SQLite
  │   ├── guidelines/            ← coding-standards, error-handling, testing-strategy
  │   ├── tests/                 ← 21개 계약 테스트 스위트
  │   ├── install.js             ← 설치/검증/복구/upgrade/orphan cleanup
  │   └── statusline.sh          ← ⛵ 하단 바
  ├── templates/                 ← pipeline.json, config.json, presets.json
  └── references/                ← interactive-ui.md, gates-and-guards.md, cli-reference.md

your-project/                    ← /vela init 실행 후
  ├── .vela/                     ← 프로젝트별 설치 (cli, shared, agents, templates 복사)
  ├── .claude/
  │   ├── settings.local.json    ← permission deny/allow + agent + spinner + statusLine
  │   └── agents/vela.md         ← 기본 에이전트
  └── CLAUDE.md                  ← Vela 규칙
```

### install.js 명령어

| 명령 | 설명 |
|------|------|
| `node .vela/install.js` | 권한 설정 + 유효성 검증 |
| `node .vela/install.js verify` | 설치 검증만 (JSON 출력: `--json`) |
| `node .vela/install.js upgrade` | FILE_MANIFEST 기반으로 모든 파일을 최신 버전으로 갱신 (config.json 제외) + orphan cleanup |
| `node .vela/install.js status` | 현재 설치 상태 확인 |
| `node .vela/install.js uninstall` | Vela 설정 제거 (레거시 훅 정리 포함) |

---

## 엔진 명령어

```bash
# SDK 오케스트레이터
vela-pipeline.js run "설명" --scale <small|medium|large|ralph|hotfix>
vela-pipeline.js status
vela-pipeline.js cancel

# 상태 머신 (vela-engine.js)
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
vela-engine review                               # SDK Opus 단일 리뷰
vela-engine plan-check                           # SDK plan.md 구조 검증 (Haiku)
vela-engine research                             # SDK 3-관점 병렬 리서치 (Haiku × 3)
vela-engine execute                              # SDK 단일 실행 (Sonnet)

# 유틸리티
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

# SDK 오케스트레이터 E2E (파이프라인 전 단계)
bash scripts/tests/test-pipeline-e2e.sh

# 분석 보고서 E2E (22 assertions)
bash scripts/tests/test-analyze-e2e.sh

# SDK 분석 엔진 (27 assertions)
bash scripts/tests/test-sdk-analyzer.sh

# 보안 강화 테스트 (M008)
bash scripts/tests/test-fail-closed.sh        # 7 assertions — Fail-closed 게이트
bash scripts/tests/test-chain-operators.sh     # 13 assertions — 체인 연산자 차단
bash scripts/tests/test-s03-relaxation.sh      # 21 assertions — 파이프라인 완화
bash scripts/tests/test-s04-hardening.sh       # 21 assertions — 코드 품질 강화

# 구조 검증 테스트 (M023)
bash scripts/tests/test-pipeline-consistency.sh # pipeline.json invariant 검증
bash scripts/tests/test-gate-keeper.sh          # VK-01~VK-12 게이트 규칙 검증
bash scripts/tests/test-researcher-modes.sh     # project_mode 계약 검증

# 개별 테스트 스위트
bash scripts/tests/test-sdk-runner.sh       # 14 assertions — SDK 인프라
bash scripts/tests/test-sdk-reviewer.sh     # 18 assertions — Opus 단일 리뷰
bash scripts/tests/test-sdk-plan-checker.sh # 13 assertions — plan.md 검증
bash scripts/tests/test-sdk-researcher.sh   # 26 assertions — 3관점 분석 (Opus 파라미터 검증 포함)
bash scripts/tests/test-sdk-executor.sh     # 13 assertions — 코드 실행
bash scripts/tests/test-sdk-custom-tools.sh # MCP 커스텀 도구 서버 팩토리
bash scripts/tests/test-gate-vk07.sh        # Gate Keeper 규칙
bash scripts/tests/test-auto-mode.sh        # Auto 모드 (16 assertions)
bash scripts/tests/test-wave-poc.sh         # Wave 병렬 그룹화 PoC
bash scripts/tests/test-change-surface.sh   # 17 assertions — 참조 무결성 검증
bash scripts/tests/test-sdk-diff-summary.sh # 20 assertions — Opus 전체 diff 통합 검토
bash scripts/tests/test-sdk-learning.sh     # 20 assertions — Haiku 학습 축적
```

⚠️ SDK 테스트 스위트들은 공유 mock 디렉토리를 사용하므로 **순차 실행** 필수 (병렬 실행 시 mock collision 발생).

---

## 커스텀 어조 — persona.md

`.vela/persona.md` 파일에 어조 규칙을 작성하면 모든 세션에 자동 주입된다.

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
| v3.0 | M003 | Agent SDK 통합, 5개 SDK 모듈, SDK 리뷰, PM 코드 작성 구조 차단 |
| v3.1 | M004 | 분석 보고서, dep-analyzer + sdk-analyzer, vela-analyze CLI, PDF 생성, `/vela analyze` |
| v3.1 | M005 | UI 세계관 고도화 — statusline 컬러 그라데이션+유니코드 프로그레스 바, Orchestrator 박스 드로잉 |
| v3.1 | M006 | 글로벌 오염 정리 — ~/.claude/ 잔여물 회수, 서브스킬 플랫 복사 제거, install.js 자기 치유 가드 |
| v3.1 | M007 | 프로젝트 전수 검수 — 코드베이스 ~14,500줄 정밀 감사. AUDIT-001~059 (High 8, Medium 24, Low 27) |
| v3.2 | M008 | 전수 수정 — Fail-closed 게이트, 체인 연산자 차단(VK-08), 파이프라인 완화(trivial/hotfix exit_gate:[]), execFileSync 전환(35+ callers), SQL parameterization, SDK null guards. 21개 테스트 스위트 230/230 PASS |
| v3.2 | M009 | 배포 고도화 — FILE_MANIFEST 단일화, orphan cleanup, 버전 일원화, config migration |
| v3.3 | M010 | **SDK 오케스트레이터 전환** — 18개 훅 → SDK query() 기반 vela-pipeline.js 오케스트레이터. 훅 전면 제거, SDK callbacks로 Gate Keeper/Guard 구현. 파이프라인 밖 훅 오버헤드 0 |
| v3.3 | M011 | README + GitHub 문서 최신화 — SDK 오케스트레이터 전환 이후 문서-코드 불일치 전면 해소 |
| v3.3 | M012 | 전수 조사 + 발전 방향 수립 — UPGRADE-REPORT.md (P0~P5 우선순위 매트릭스, M013~M016 마일스톤 제안) |
| v4.0 | M013 | **v4.0 전면 고도화** — sdk-custom-tools.js MCP 서버 팩토리, vela-wave.js PoC, SDK structured output 이중 추출, 레거시 훅 잔재 전면 제거, SDK mock 안정화, install.js 14개 감사 지적 반영. 18개 테스트 스위트 PASS |
| v4.0 | M014 | .md 전수 최신화 — M010~M013 변경 사항을 README/SKILL/next-step 등에 전수 반영, vela-analyze.js stale 경로 버그 수정, dead 정리 후 push |
| v4.0 | M015 | CSA 참조 무결성 자동 검증 — change-surface.js 순수 모듈로 exit_gate 자동 차단, 사라진 토큰 교차 참조 감지 |
| v4.0 | M016 | 개발 환경 정리 — Vela 설치 잔재(.vela/, .claude/) 및 홈 디렉토리 오염 완전 제거, GSD 전용 환경 확립 |
| v4.0 | M017 | SDK/모델/예산 버그픽스 — 8건 SDK 관련 버그픽스 전수 자동화 검증 |
| v4.0 | M018 | change-surface.js 범용 토큰 확장 — JS/TS 전용 → 범용 식별자 변경 교차 참조 감지 |
| v4.0 | M019 | PDF 한글 + config 경로 + 글로벌 설치 — PDF 한글 깨짐 해결, config.json 경로 불일치 수정, npm 글로벌 설치 전환 |
| v4.0 | M020 | 퍼미션 마찰 제거 — PM GSD식 이해 확인, 읽기 도구 퍼미션 프롬프트 제거, 파이프라인 시작 시 퍼미션 안내 |
| v4.0 | M021 | PM 오케스트레이터 지시 단절 수정 — vela.md·pipeline-flow.md가 vela-pipeline.js run을 유일한 실행 인터페이스로 지시, SDK Guard 콜백·도구 추적·비용/시간 추적 전면 활성화 |
| v4.0 | M022 | 리뷰 시스템 + 오케스트레이터 복원력 강화 — 단계별 채점 기준 분기, ESM globalImport 수정, escalate_to_pm graceful 종료, approval _source provenance, report_md_exists 게이트, sub_phase 추적 |
| v4.0 | M023 | SDK 오케스트레이터 Research 실패 복구 + 관찰 가능성 강화 — rw-artifact mode + artifactDir-scoped Write guard, project_mode 주입(bootstrap/targeted/exploratory), cost 보존 + denied-tools.json artifact + Turns used 로그, sdk-failure-recovery.md, pipeline-consistency invariant 테스트 |
| v4.1 | M024 | maxTurns 상한 제거 — SDK 에이전트 자율 턴 소비, turn-config.js 삭제, 6개 SDK 모듈에서 maxTurns 코드 21곳 제거 |

---

## 확장 읽을거리

- **[나만의 Claude Code 만들기 — 탐구 가이드](docs/custom-claude-code-guide.md)** — Claude Agent SDK로 자체 CLI/TUI 에이전트를 만드는 방법, 3가지 구현 옵션, Ink/Textual/MCP 활용법 정리

---

## 라이선스

MIT License — Copyright (c) 2026 EcoKG
