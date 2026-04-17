# ⛵ Vela Engine v7.2 — Sandbox Development System

**Vela**(돛자리)는 Claude Code를 완전히 감싸는 샌드박스 엔진이다.
Claude Code는 독자적으로 작동할 수 없으며, 모든 행위는 Vela의 파이프라인을 통해서만 진행된다.

---

## 사상 (Philosophy)

### 1. ⛵ 통제된 자유 (Controlled Autonomy)
AI 코딩 도구는 강력하지만, 통제 없는 자유는 위험하다. Vela는 **"언제, 어떤 순서로, 누구의 검증을 거쳐 할 수 있는가"**를 강제한다.

### 2. 🌟 이중 방어 (Defense in Depth)
- **Gate Keeper** + **Gate Guard** — PreToolUse 훅 이중 차단 (Fail-closed: 예외 발생 시 도구 차단)
- **Reviewer Agent** (vela-reviewer) — 고품질 독립 평가 (5차원 20+/25)
- **Permission deny/allow** — settings.local.json deny 패턴으로 절대 차단, allow 패턴으로 읽기 도구 자동 허용
- **GUARD 3/13/14/15**: 커밋 차단(VG-03), pipeline.json 보호(VG-13), 시크릿 감지(VG-14), 서킷 브레이커(VG-15)
- **pipeline-state.json + config.json 보호**: 직접 수정 불가

### 3. 🔭 추적 가능한 개발 (Traceable Development)
산출물(research.md, plan.md, review-*.md, approval-*.json), git 커밋에 파이프라인 참조, TreeNode 캐시.

### 4. ✦ 구조로 강제 (Enforce by Structure)
지시는 무시된다. 산출물이 없으면 전이 차단. approval 없으면 다음 단계 불가. PM은 코드를 직접 작성할 수 없다 — 모든 코드 실행은 Executor 에이전트를 통해서만 가능하다.

---

## 빠른 시작

### 1. 설치 (1회)

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/install.sh | bash
```

설치 후 **slash 명령**으로 파이프라인을 시작한다 (환경이 없으면 자동 구축).

```
/vela:fix     — Target-First 정밀 수정 (v7.0, 기본 추천)   (surgical, 8단계)
/vela:small   — 단일 파일/오타/한 줄 수정                  (trivial, 5단계)
/vela:medium  — 명확한 기능 추가                          (quick, 7단계)
/vela:large   — 신규 모듈/광범위 리팩토링/critical          (standard, 13단계)
/vela:ralph   — TDD 루프 버그 수정                        (ralph, 5+루프)
/vela:hotfix  — 문서/설정 수정                            (hotfix, 4단계)
```

`/vela:start`는 v6.1부터 deprecated이며 v7.0에서 제거된다. 호환성을 위해 현재는 `/vela:medium`으로 자동 폴백된다.

**v7.0 surgical(`/vela:fix`)**이 일상 작업의 새 기본 추천이다. locate → research(targeted) → **spec**(patch-spec.md) → **patch** → verify 흐름으로 결정론적 수정 + scope creep 방지 + audit trail을 제공한다. 같은 request → 같은 patch-spec.md → 같은 patch가 보장된다.

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
- PM이 Agent 도구로 역할별 에이전트를 순서대로 소환하여 완전 무인 실행
- 스텝 실패 시 자동 기록, 상태 자동 보존

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
│                  ⛵ VELA SANDBOX  V6                      │
│                                                           │
│  ⛵ Gate Keeper   🌟 Gate Guard   🧭 PM Agent            │
│  R/W 모드 강제    파이프라인 순서   Agent 도구로 직접 소환   │
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
│  🤖 ROLE AGENTS (Native Claude Code) ────────────        │
│  vela-researcher:   /vela:analyze 전용 (research/merge/analyze)│
│  vela-planner:      plan + self-check 통합 (research 흡수)│
│  vela-executor:     TDD 구현 (test→implement→refactor)   │
│  vela-reviewer:     review + verify + diff-summary 통합  │
│                                                           │
│  ✦ ARCHITECTURE ─────────────────────────────────        │
│  Plan Gate: Architecture/ClassSpec/TestStrategy 필수      │
│  Execute: TDD (test → implement → refactor)              │
│  산출물 없으면 전이 차단 (vela-engine.js)                  │
✦──────────────────────────────────────────────────────────✦
```

### Explore / Develop 듀얼 모드

| 모드 | 상태 | 허용 | 차단 |
|------|------|------|------|
| **⛵ Explore** | 파이프라인 없음 | 읽기, 탐색 | 쓰기 (Gate Keeper 차단) |
| **🧭 Develop** | 파이프라인 활성 | 단계에 따름 | 단계 건너뛰기, 직접 소스 수정 |

### Research 모드 (Explore에서)

깊은 분석 요청 시 AskUserQuestion으로 방식 선택:
- **Solo** — 직접 분석, 가장 빠름
- **Subagent** (Sonnet) — 독립 리서처 (vela-researcher 에이전트)

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

모든 파이프라인은 **v6.1 Universal Locate** 단계를 공통으로 갖는다 — 결정론적 좌표 식별(LLM 0)로 모든 scale에서 일관된 결과물 품질을 보장한다.

| 종류 | 단계 | 선택 |
|------|------|------|
| **surgical** (v7.0) | init → **locate** → research(targeted) → **spec** → **patch** → verify → commit → finalize | `/vela:fix` |
| **standard** | init → **locate** → research → plan → plan-check → checkpoint → branch → execute → verify → diff-summary → learning → commit → finalize | `/vela:large` |
| **quick** | init → **locate** → plan → execute → verify → commit → finalize | `/vela:medium` |
| **trivial** | init → **locate** → execute → commit → finalize | `/vela:small` |
| **ralph** | init → **locate** → execute ↔ verify (반복) → commit → finalize | `/vela:ralph` |
| **hotfix** | init → **locate** → execute → commit | `/vela:hotfix` |

v6.1부터 slash 명령이 scale을 명시한다. `--scale` 미지정 시 `medium`으로 폴백 + deprecation 경고 (v7.0에서 에러로 전환 예정). `autoDetectScale()` 단어 수 기반 임의 분류는 v6.1에서 deprecated.

### Locate 단계 (v6.1, 모든 scale 공통)
`node .vela/cli/vela-engine.js locate`는 ripgrep + git ls-files 기반 결정론적 좌표 식별. LLM 호출 0. `targets.json`(primary/tests/blast_radius/confidence)을 생성해 후속 에이전트(research/plan/execute)에게 전달. confidence: high → `project_mode: targeted`로 research가 자동으로 좁은 범위 분석, confidence: low → exploratory 폴백 또는 사용자 질문.

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

## V6 오케스트레이터 — PM(vela.md) + Agent 도구

V6에서 PM은 Claude Code 네이티브 Agent 도구로 각 역할 에이전트를 직접 소환한다. 외부 SDK 없음.

### 아키텍처

```
PM (vela.md agent)
  ├── vela-engine.js (상태 머신: init/transition/record/commit)  ← CLI 호출
  ├── Agent(vela-planner, mode=plan|spec)  → plan.md (research + self-check 통합) 또는 patch-spec.md
  ├── Agent(vela-executor)                 → 코드 구현 (TDD; v7.2 M6 worktree opt-in)
  ├── Agent(vela-reviewer, mode=review)    → review-{step}.md
  ├── Agent(vela-reviewer, mode=verify)    → verification.md (테스트+린트+diff 요약 통합)
  └── Agent(vela-researcher, mode=analyze) → analysis.md (`/vela:analyze` 전용)

Hooks (글로벌 등록 — ~/.vela/hooks/ → ~/.claude/settings.json):
  ├── vela-gate-keeper.js        (VK-01~08: 모드별 도구 제한)      [PreToolUse]
  ├── vela-gate-guard.js         (VG-03~15: 단계 순서 강제)        [PreToolUse]
  ├── vela-stop.js               (auto 모드 중 중단 방지)           [Stop]
  ├── vela-review-gate.js        (APPROVE 후 N회 재검증 강제)       [Stop]
  └── vela-subagent-stop.js      (v7.2 M8: 에이전트별 텔레메트리)   [SubagentStop]
```

### 핵심 설계 결정

- **Agent 도구 직접 오케스트레이션**: PM이 `Agent(subagent_type="vela-researcher")` 등으로 역할 에이전트를 순서대로 소환. Node.js 프로세스나 외부 API 호출 없음.
- **vela-engine.js 순수 상태 머신**: JSON 기반 파이프라인 상태 추적. SDK 의존 없음.
- **Fail-closed 훅**: 오류 발생 시 허용(0)이 아닌 차단(2)으로 폴백.

### V6 CLI 커맨드

```bash
# 파이프라인 초기화 (PM이 호출)
node .vela/cli/vela-engine.js init "OAuth 인증 추가" --scale large

# 분석 / 마찰 리포트 (v7.3-M1b: PDF 파이프라인 제거, markdown 출력)
# /vela:analyze 스킬이 AskUserQuestion으로 항목 선택 후 npm audit + vela-researcher(mode=analyze) 호출.
node .vela/cli/vela-friction.js                                  # gate-events.jsonl 집계 (VK/VG 코드 분포 + 정책 제안)
node .vela/cli/vela-friction.js --limit 100 --json               # 기계 판독 JSON
```

### 공유 유틸 구조

```
scripts/shared/
├── change-surface.js    ← 참조 무결성 검증 (diff 기반 cross-file reference 분석)
├── project-env.js       ← 프로젝트 환경 정보 수집
├── worktree-manager.js  ← M4-M6 격리 실행용
└── constants.js         ← 가드 패턴 (SAFE_BASH_READ, SECRET_PATTERNS 등)
```

### 리뷰 판정

vela-reviewer Agent — 점수 ≥ 20/25 → APPROVE, < 20 또는 CRITICAL → REJECT.
REJECT 시 피드백을 executor에게 전달하여 재작업. max_revisions 소진 시 PM이 사용자에게 에스컬레이션.

---

## 분석 — `/vela:analyze` (v7.3-M1b: 경량 markdown)

프로젝트 의존성과 코드를 선택적으로 분석하고 markdown 요약을 `.vela/artifacts/<ts>/analysis.md`에 저장한다. PDF가 필요하면 Claude Code에서 브라우저 출력으로 해결.

### 분석 항목

| 항목 | 방식 | 비용 |
|------|------|------|
| 📦 의존성 (deps) | skill 내부에서 `npm audit --json` + `npm outdated --json` 직접 실행 후 Claude 요약 | 무료 |
| 🔒 보안 (security) | `Agent(vela-researcher, mode=analyze)` | 토큰 |
| 🐛 버그 (bugs) | `Agent(vela-researcher, mode=analyze)` | 토큰 |
| ⚡ 성능 (performance) | `Agent(vela-researcher, mode=analyze)` | 토큰 |
| 📐 코드 품질 (code-quality) | `Agent(vela-researcher, mode=analyze)` | 토큰 |
| 🏗️ 아키텍처 (architecture) | `Agent(vela-researcher, mode=analyze)` | 토큰 |

v7.3-M2a: vela-analyzer가 vela-researcher(multi-mode)로 흡수됨. v8.0 후속에서 `/simplify` 위임 검토.

### Friction Report (분석과 분리)

훅 마찰 집계는 독립 CLI로 운영된다:

```bash
node .vela/cli/vela-friction.js [--limit 500] [--json]
```

`.vela/state/gate-events.jsonl`을 읽어 상위 VK/VG 코드, 단계별 분포, 정책 조정 제안을 출력한다.

---

## 에이전트 아키텍처

### 모델 선택 전략

품질 크리티컬 단계는 Sonnet, 기계적 검사는 Haiku로 **각 에이전트 frontmatter에 고정**한다.
공식 기본값 `inherit`에 의존하면 부모 세션의 모델(Opus 등)이 상속되어 비용 예측이 불가능해지기 때문이다.

| 작업 유형 | 모델 | 역할 | 근거 |
|----------|------|------|------|
| 설계/구현/리뷰/검증 | **Sonnet** | Researcher, Planner, Executor, Reviewer, Verifier, Sprint-planner | 공식 *"Sonnet handles most coding tasks well"* |
| 기계적 검사 (non-fatal) | **Haiku** (`effort: low`) | Plan-checker, Diff-summary, Learning | 공식 *"For simple subagent tasks, specify `model: haiku`"* |
| 분석 보고서 | (사용자 선택) | Analyzer | `/vela:analyze` 커맨드에서 `--model` 로 지정 |

### 에이전트 소환 패턴 (V6)

PM은 `Agent(subagent_type="vela-{role}")` 단일 호출로 역할 에이전트를 소환한다.
V6에서 Teammate/TeamCreate/SendMessage는 사용하지 않는다.

| 작업 | subagent_type | 모델 |
|------|--------------|------|
| /vela:analyze 분석 | `vela-researcher` (mode=analyze) | haiku |
| 구현 계획 (research+self-check 통합) | `vela-planner` | opus 4.7 (adaptive) |
| 코드 구현 | `vela-executor` | sonnet (effort: xhigh) |
| 품질 리뷰 + 검증 + diff 요약 | `vela-reviewer` (mode=review\|verify) | sonnet |

### 승인 메커니즘 — 파일 기반

- PM이 `Agent(subagent_type="vela-reviewer")`를 호출 → `review-{step}.md` + `approval-{step}.json` 자동 생성
- 엔진 exit gate가 파일 확인 → 없으면 transition 차단

---

## Auto 모드

Auto 모드(`/vela auto` 또는 `--auto`)는 파이프라인을 완전 무인으로 실행한다.

### V6 Auto 자동화

| 메커니즘 | 동작 |
|---------|------|
| **단계별 Agent 소환** | PM이 각 파이프라인 단계에서 `Agent(subagent_type=...)` 직접 호출. 훅이 도구 접근 제어 |
| **실패 복구** | 에이전트 실패 시 PM이 상태를 보존하고 사용자에게 에스컬레이션 |
| **리뷰** | vela-reviewer Agent — 점수 ≥ 20/25 → 승인, 미달 → 거부 |
| **상태 보존** | vela-engine.js가 pipeline-state.json으로 단계별 상태 기록 |

### 자동 품질 검사

| 메커니즘 | 동작 |
|---------|------|
| **리뷰** | `Agent(vela-reviewer, mode=review)` → review-{step}.md 작성 (5차원 채점) |
| **plan self-check** | planner의 `## Self-Check` 섹션에서 자체 검증 (구 plan-checker 흡수) |
| **검증** | `Agent(vela-reviewer, mode=verify)` → verification.md (테스트+린트+타입체크+diff 요약 통합) |
| **exit gate** | 엔진이 단계별 필수 산출물(review-*.md, approval-*.json, verification.md) 존재를 확인 → 없으면 transition 차단 |

---

## 방어 시스템

### ⛵ Gate Keeper

`vela-gate-keeper.js`가 Claude Code PreToolUse 훅으로 동작. 모든 도구 호출 전에 실행된다 (VK-01~08).

| 게이트 | 코드 | 규칙 |
|--------|------|------|
| Bash 차단 | VK-01, VK-02 | Vela CLI 외 차단. 안전한 읽기 명령은 모든 모드 허용. 파이프라인 활성 시 git/gh 허용 |
| 모드 강제 | VK-03, VK-04 | 읽기전용에서 Write/Edit 차단 |
| 민감파일 보호 | VK-05 | .env, credentials.json, config.json 차단 |
| 시크릿 감지 | VK-06 | 15개 패턴 차단 |
| PM 속독 | VK-07 | PM은 Read/Glob/Grep 허용, Write/Edit 차단. delegation.json 검증 |
| 체인 연산자 차단 | VK-08 | SAFE_BASH_READ 명령에서 체인 연산자(&&, \|\|, ;, \|) 차단. `ls && rm -rf /` 방지 |

### 🌟 Gate Guard

`vela-gate-guard.js`가 Claude Code PreToolUse 훅으로 동작. 파이프라인 단계 순서와 PM 역할 경계를 강제한다.

| 가드 | 코드 | 규칙 |
|------|------|------|
| GUARD 3 | VG-03 | 빌드/테스트 실패 시 git commit 불가. corrupt tracker-signals.json 시 복구 안내 |
| GUARD 13 | VG-13 | `.vela/templates/pipeline.json` 직접 수정 차단 — vela-engine CLI만 허용 |
| GUARD 14 | VG-14 | Write 도구 내용에 시크릿 패턴 감지 시 차단 |
| GUARD 15 | VG-15 | 연속 실패 5회 초과 시 circuit breaker 발동 — 모든 도구 차단 |

### 차단 시 자동 복구 (Block Recovery)

```
vela-executor: src/auth.js 수정 시도 (execute 단계 전)
  ↓
Gate Guard: 🌟 [Vela] ✦ BLOCKED [VG-02]: Source code modification before execute step.
            Recovery: Complete steps first: research → plan → execute
  ↓
PM: 차단 감지 → 올바른 단계로 전이
```

### Permission Deny (절대 차단)

`rm -rf`, `git push --force`, `git reset --hard`, `git commit --no-verify`, `git clean -f`

이 규칙들은 settings.local.json의 deny 패턴으로 등록되어 Claude Code 레벨에서 절대 차단된다.

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
| Research 방식 | Solo / Subagent (vela-researcher) |
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
├── diff-summary.md, approval-diff-summary.json
├── learning.md
```

---

## 설치 구조

```
$HOME/.claude/skills/vela/       ← 글로벌 스킬 (curl 설치 시)
  ├── SKILL.md                   ← 스킬 진입점
  ├── package.json               ← v6.0.0 (SDK 의존성 없음)
  ├── scripts/
  │   ├── shared/                ← 공유 유틸리티 (SDK 없음)
  │   │   ├── change-surface.js    ← 참조 무결성 검증 (diff 기반)
  │   │   ├── project-env.js       ← 프로젝트 환경 정보 수집
  │   │   ├── worktree-manager.js  ← 격리 실행용
  │   │   └── constants.js         ← 가드 패턴 상수
  │   ├── cli/                   ← vela-engine, vela-cost, vela-report, vela-friction
  │   ├── agents/                ← vela.md (PM) + 10개 역할 에이전트 (vela-researcher.md 등)
  │   │                             pm/ (pipeline-flow.md, model-strategy.md 등 서브트리)
  │   ├── hooks/                 ← 4개 훅 (gate-keeper, gate-guard, stop, review-gate) — ~/.vela/hooks/에 글로벌 배포
  │   ├── cache/                 ← TreeNode SQLite
  │   ├── guidelines/            ← coding-standards, error-handling, testing-strategy
  │   ├── tests/                 ← 게이트/훅 단위 테스트
  │   ├── install.js             ← 설치/검증/복구/upgrade/orphan cleanup
  │   └── statusline.sh          ← ⛵ 하단 바
  ├── templates/                 ← pipeline.json, config.json, presets.json
  └── references/                ← interactive-ui.md, gates-and-guards.md, cli-reference.md

your-project/                    ← /vela:{small|medium|large|...} 실행 후 자동 구축
  ├── .vela/                     ← 프로젝트별 설치 (cli, shared, agents, templates 복사)
  ├── .claude/
  │   ├── settings.local.json    ← permission deny/allow + agent + spinner + statusLine
  │   └── agents/                ← vela.md + 10개 역할 에이전트 (vela-researcher.md 등)
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
# 상태 머신 (vela-engine.js) — V6 PM이 직접 호출
vela-engine init "설명" --scale <small|medium|large|ralph|hotfix>
vela-engine init "설명" --scale large --auto   # Auto 모드
vela-engine state
vela-engine transition
vela-engine record pass|fail
vela-engine branch [--mode auto|prompt|none]
vela-engine commit [--message TEXT]
vela-engine cancel
vela-engine history

# 유틸리티
vela-cost                                        # 파이프라인 비용/메트릭
vela-report [--html output.html]                 # 파이프라인 리포트/대시보드
vela-friction [--limit 500] [--json]             # gate-events.jsonl 집계 (v7.3-M1b)
# /vela:analyze 스킬이 deps(npm audit 인라인) + perspectives(vela-researcher mode=analyze)를 오케스트레이션
```

---

## 테스트

훅/게이트 단위 테스트로 Vela의 핵심 보안 메커니즘을 검증한다.

```bash
# 보안 게이트 테스트
bash scripts/tests/test-fail-closed.sh        # Fail-closed 게이트
bash scripts/tests/test-chain-operators.sh     # 체인 연산자 차단 (VK-08)
bash scripts/tests/test-s03-relaxation.sh      # 파이프라인 완화
bash scripts/tests/test-gate-keeper.sh         # VK-01~VK-08 게이트 규칙 검증
bash scripts/tests/test-gate-vk07.sh           # Gate Keeper VK-07

# Auto 모드
bash scripts/tests/test-auto-mode.sh           # Auto 모드 (16 assertions)
bash scripts/tests/test-change-surface.sh   # 17 assertions — 참조 무결성 검증
```

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

전체 마일스톤 이력은 **[CHANGELOG.md](CHANGELOG.md)**를 참조. 커밋별 상세는 `git log`.

**현재 — v7.3 (v8.0 전환)**: Opus 4.7 기준 슬림화. 파이프라인 13→6, 에이전트 10+→4, 명령 6→3, 총 -9,000 LOC.

---

## v7.2 Configuration

v7.2에서 `.vela/config.json`에 4개 신규 섹션이 추가됐다. **모든 플래그 기본값은 V7 호환 동작**이므로 업데이트만으로 바뀌는 것은 없다. 아래는 선택 활성화 가이드.

### `cache` — 프롬프트 캐싱 정책 (M1/M3)

```json
"cache": {
  "enabled": true,
  "ttl": "1h",
  "read_cache": { "enabled": true, "warn_threshold": 4 }
}
```

- `ttl: "1h" | "5m" | "off"` — 1h는 long-running 파이프라인에 최적. **env 필수**: Claude Code 실행 전에 `export ENABLE_PROMPT_CACHING_1H=1`. 미설정 시 `vela-session-start.js`가 경고만 출력.
- `read_cache` — ~~`vela-file-read-cache.js`~~ v7.3-M4에서 훅 제거됨. Claude Code v2026 내장 파일 캐시가 역할 대체 (config.read_cache는 레거시 설정으로 남았으나 기능 없음).

### `models` — 역할별 모델 라우팅 (M2)

```json
"models": {
  "default": "sonnet",
  "research": "opus",
  "plan": "opus",
  "plan_check": "haiku",
  "execute": "sonnet",
  "verify": "haiku",
  "review": "sonnet",
  "learning": "haiku",
  "diff_summary": "haiku",
  "analyze": "sonnet"
}
```

엔진 `state` 명령이 현재 단계 기준 `recommended_model` 필드를 반환. PM이 `Agent()` 호출 시 `model` 파라미터로 전달. 미정의 단계는 `default`로 폴백.

### `execution` — 병렬화 & 격리 (M4/M5/M6/M7/M12)

```json
"execution": {
  "parallelism": false,
  "isolation": "inline",
  "background_post_steps": false,
  "ralph_sentinel": false
}
```

- `parallelism: true` — execute 후 reviewer+verifier 병렬 호출, research 단계에서 architecture/security/quality 3관점 병렬 spawn 후 `vela-researcher`(mode=merge)로 통합.
- `isolation: "worktree"` — executor를 `.vela/worktrees/{slug}/` git worktree에서 실행. 실패해도 main working tree 무변경.
- `background_post_steps: true` — learning/diff-summary를 `run_in_background`로 호출, 즉시 commit으로 진행.
- `ralph_sentinel: true` — ralph 루프를 `ScheduleWakeup` sentinel prompt (`<<autonomous-loop-dynamic>>`)로 자율화.

### `mcp.context7` — Docs 조회 (M11)

```json
"mcp": {
  "context7": { "enabled": true }
}
```

`vela-researcher`가 외부 라이브러리 API 언급 시 `mcp__claude_ai_Context7__resolve-library-id` → `query-docs`로 버전별 정확한 docs를 먼저 조회. 미지원 환경에서는 WebSearch 폴백.

### `gate_policy` — 게이트 3-way 정책 (v7.2 harness)

```json
"gate_policy": {
  "chain_operator": "block",
  "web_in_write": "block",
  "researcher_scope": "block",
  "event_log": true
}
```

각 키 값: `"block" | "ask" | "allow"`. `event_log: true`면 모든 결정이 `.vela/state/gate-events.jsonl`에 append되어 `/vela:analyze friction`에서 훅 마찰 지점 분석에 사용.

### 선택 활성화 체크리스트

업데이트 후 실제로 v7.2 기능을 켜려면:

- [ ] `export ENABLE_PROMPT_CACHING_1H=1` 을 shell rc(.bashrc/.zshrc)에 추가
- [ ] `.vela/config.json`의 `cache.ttl`을 `"1h"`로 유지 (기본값)
- [ ] 병렬화를 원하면 `execution.parallelism: true` (단, 체감 효과는 large 파이프라인에서 가장 큼)
- [ ] 실험적 기능은 **한 번에 하나씩** 켜고 vela-cost로 차이 측정 권장
- [ ] 외부 CI에서 파이프라인 트리거하려면 `docs/managed-agents.md` 참조 (M15)
- [ ] nightly learning 집계를 원하면 `CronCreate("0 2 * * *", "<<autonomous-loop>> node .vela/cli/vela-nightly.js")` 등록 (M14)

---

## 라이선스

MIT License — Copyright (c) 2026 EcoKG
