# ⛵ Vela Engine v2.0 — Sandbox Development System

**Vela**(돛자리)는 Claude Code를 완전히 감싸는 샌드박스 엔진이다.
Claude Code는 독자적으로 작동할 수 없으며, 모든 행위는 Vela의 파이프라인을 통해서만 진행된다.

---

## 사상 (Philosophy)

### 1. ⛵ 통제된 자유 (Controlled Autonomy)
AI 코딩 도구는 강력하지만, 통제 없는 자유는 위험하다. Vela는 **"언제, 어떤 순서로, 누구의 검증을 거쳐 할 수 있는가"**를 강제한다.

### 2. 🌟 이중 방어 (Defense in Depth)
- **Gate Keeper** + **Gate Guard** — 훅 레벨 이중 차단
- **Reviewer** (독립 subagent) — 편향 없는 독립 평가
- **Permission deny** + **Hook exit(2)** — 시스템 + 코드 레벨
- **GUARD 0**: 파이프라인 중 TaskCreate 차단
- **pipeline-state.json 보호**: 직접 수정 불가

### 3. 🔭 추적 가능한 개발 (Traceable Development)
산출물(research.md, plan.md, review-*.md, approval-*.json), git 커밋에 파이프라인 참조, TreeNode 캐시.

### 4. ✦ 구조로 강제 (Enforce by Structure)
지시는 무시된다. 산출물이 없으면 전이 차단. approval 없으면 다음 단계 불가. `--scale` 미지정 시 init 거부.

---

## 빠른 시작

### 1. 설치 (1회)

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/vela/main/install.sh | bash
```

### 2. 프로젝트에서 사용

```
/vela
```

선택지 표시:
- **파이프라인 시작** → 작업 설명 입력 → 규모 선택 → 파이프라인 진행
- **환경 구축만** → `.vela/` 설치만

직접 시작: `/vela start OAuth 인증 추가`

### 3. 업데이트

```bash
# 글로벌만
curl -fsSL https://raw.githubusercontent.com/EcoKG/vela/main/update.sh | bash

# 글로벌 + 현재 프로젝트
curl -fsSL https://raw.githubusercontent.com/EcoKG/vela/main/update.sh | bash -s -- --local
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
- **Subagent** (Opus) — 독립 리서처 1명
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
       ⛵ 최적화된 프롬프트:
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       UserService의 이메일 검증 로직에서
       중복 체크 누락 버그 수정. ...
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

## 팀 메커니즘

### 모델 선택 전략

| 작업 유형 | 모델 | 역할 |
|----------|------|------|
| 파일 탐색/검색 | **Haiku** | 탐색 전용 subagent |
| 코드 구현/리뷰 | **Sonnet** | Executor, Reviewer, Conflict Manager |
| 설계/디버깅/분석 | **Opus** | Researcher, Planner |

### Teammate vs Subagent

**Teammate** = 에이전트 간 소통(SendMessage) 필요.
**Subagent** = 독립 단일 작업, 결과만 반환.

| 조건 | 방식 | model |
|------|------|-------|
| 경쟁가설 디버깅 (리서치) | **Teammate** | `"opus"` |
| CrossLayer/다중 파일 동시 수정 | **Teammate** | `"sonnet"` |
| 독립 리뷰/점검 | **Subagent** | `"sonnet"` |
| 단일 모듈 수정 | **Subagent** | `"sonnet"` |
| 파일 탐색 | **Subagent** | `"haiku"` |
| 설계/분석 | **Subagent** | `"opus"` |

### 팀 규칙

- **팀 크기**: 3~5명 (개발 팀원 + Conflict Manager 1명)
- **태스크 배분**: 팀원당 5~6개
- **파일 소유권**: 각 팀원에게 담당 파일 명시 부여
- **에이전트 MD**: 목차(TOC) 기반 로딩 — 필요한 섹션만 선택적으로 읽기
- **UI 템플릿**: AskUserQuestion JSON은 `.vela/references/interactive-ui.md`에 분리 (vela.md 토큰 38% 절감)

### CrossLayer Development

다중 계층 작업 시 Teammate + Conflict Manager + Git Worktree:
```
TeamCreate → frontend-dev(Sonnet) + backend-dev(Sonnet) + db-dev(Sonnet) + conflict-manager(Sonnet)
각 팀원: isolation: "worktree" + 담당 파일 + 5~6개 태스크
팀원 간 SendMessage로 인터페이스 조율
Conflict Manager가 최종 병합 + 충돌 해결
```

### Standard Pipeline 에이전트 흐름

```
TeamCreate → Research: Teammate 3명(Opus, 경쟁가설 디버깅)
           → Plan: Subagent(Opus)
           → Execute: Subagent(Sonnet) 또는 Teammate(CrossLayer)
           → 각 단계: Reviewer Subagent(Sonnet) + PM approve/reject
           → TeamDelete
```

### 리서치 — 경쟁가설 디버깅

가설 생성(3~5개) → 가설 공유(SendMessage) → 증거 수집 → 교차 검증 → 가설 제거 → 결론.
디테일하되 과하지 않게. Teammate 간 소통으로 가설 경쟁.

**소통 프로토콜**: 가설 수립 직후 공유 → 증거 발견 시 반박 공유 → 분석 완료 시 PM 보고.
관점별 가이드(보안/아키텍처/품질)가 `researcher.md`에 정의되어 있음.

**소통 검증**: Tracker가 SendMessage 사용을 추적 (`teammate-comms.json`).
Research 단계 완료 시 TaskCompleted 훅이 소통 이력을 확인.

### 승인 메커니즘 — 파일 기반

- **Reviewer** (Subagent, Sonnet) → `review-{step}.md` (X/25 점수 + 이슈)
- **PM** → `approval-{step}.json` (`decision: "approve"/"reject"`)
- 엔진 exit gate가 파일 확인 → 없으면 transition 차단

---

## 인터랙티브 UI (AskUserQuestion)

모든 사용자 선택은 **방향키로 선택 가능한 UI**를 사용한다.

| 단계 | 선택 UI |
|------|---------|
| `/vela` 호출 | 파이프라인 시작 / 환경 구축만 |
| Research 방식 | Solo / Subagent / Teammate 3명 (경쟁가설) |
| 파이프라인 규모 | Small / Medium / Large |
| Research 후 | 파이프라인 시작 / 추가 조사 / 완료 |
| 기존 Research 활용 | 기존 활용 / 보충 / 처음부터 |
| **Checkpoint** | 승인 / 변경 요청 / 취소 |
| **Commit** | 이 메시지 / 수정 / diff 확인 |
| **Finalize** | PR 생성 / 생성 안 함 |
| **Cancel** | 취소 진행 / 계속 |
| **PM 거부 시** | 자동 수정 / 직접 가이드 / 무시 승인 / 취소 |

---

## 방어 시스템

### ⛵ Gate Keeper (PreToolUse)

| 게이트 | 코드 | 규칙 |
|--------|------|------|
| Bash 차단 | VK-01, VK-02 | Vela CLI 외 차단. 안전한 읽기 명령은 모든 모드 허용. 파이프라인 활성 시 git/gh 허용 |
| 모드 강제 | VK-03, VK-04 | 읽기전용에서 Write/Edit 차단 |
| 민감파일 보호 | VK-05 | .env, credentials.json 차단 |
| 시크릿 감지 | VK-06 | 15개 패턴 차단 |

### 🌟 Gate Guard (PreToolUse)

| 가드 | 코드 | 규칙 |
|------|------|------|
| GUARD 0 | VG-00 | 파이프라인 중 TaskCreate/TaskUpdate 차단 |
| GUARD 0.5 | — | 비-research에서 5회 이상 Read 경고 |
| GUARD 1 | VG-01 | research.md 없이 plan.md 불가 |
| GUARD 2 | VG-02 | execute 전 소스코드 수정 불가 + pipeline-state.json 보호 |
| GUARD 3 | VG-03 | 빌드/테스트 실패 시 commit 불가 |
| GUARD 4 | VG-04 | verification.md 없이 report.md 불가 |
| GUARD 5 | VG-05 | pipeline-state.json 직접 수정 불가 |
| GUARD 6 | VG-06 | 리비전 한도 초과 차단 |
| GUARD 7 | VG-07 | execute/commit/finalize에서만 git commit 허용 |
| GUARD 8 | VG-08 | verify 완료 전 git push 차단 |
| GUARD 9 | — | 보호 브랜치 직접 커밋 경고 |
| **GUARD 11** | **VG-11** | **비-team 단계에서 approval/review 작성 차단** — team 단계에서만 허용 |
| **GUARD 12** | **VG-12** | **execute 단계 PM 직접 소스 수정 차단** — SubAgent(단일 모듈) 또는 Teammate(다중 파일) 위임 강제 |

### 차단 시 자동 복구 (Block Recovery)

훅이 `BLOCKED [코드]` 메시지를 반환하면, Claude는 차단 코드를 읽고 `vela.md`의 복구 테이블에 따라 즉시 올바른 행동으로 전환한다. 같은 행동을 재시도하지 않는다.

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

---

## 아키텍처 기반 개발 (Standard)

- **Plan**: `## Architecture`, `## Class Specification`, `## Test Strategy` 필수 (200bytes 이상)
- **Execute**: TDD Sub-Phase (test-write → implement → refactor)
- **Reviewer**: 구체적 스펙 대 구현 대조 (X/25 점수)

---

## ⛵ Vela Identity

### 하단 바 (StatusLine)

```
⛵ Vela ✦ Explore │ Opus 4.6 42%
⛵ Vela ✦ standard 🧭 research [===>----] 2/10 │ task… │ 35%
```

### Spinner Verbs

```
⛵ Navigating… / 🧭 Charting… / ✦ Stargazing… / 🔭 Observing…
⚓ Anchoring… / 🌟 Reading Stars… / ⛵ Setting Sail…
```

### Hook 실행 중

```
⛵ Checking harbor clearance...     (Gate Keeper)
🌟 Verifying navigation chart...    (Gate Guard)
🧭 Plotting current position...     (Orchestrator)
🔭 Logging voyage data...           (Tracker)
⛵ Checking active voyage...        (Stop)
⛵ Scanning for interrupted voyages... (SessionStart)
✦ Preserving navigation state...    (PreCompact)
✦ Restoring navigation state...     (PostCompact)
⛵ Briefing crew member...          (SubagentStart)
✦ Verifying voyage milestone...     (TaskCompleted)
```

### 시작 시 메시지

```
⛵ Vela Engine — 별자리가 항해를 안내합니다. /vela:start 로 파이프라인을 시작하세요.
```

### 커밋 Attribution

```
⛵ Managed by Vela Engine (https://github.com/EcoKG/vela)
```

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
```

예: `.vela/artifacts/2026-03-24_a3f2_auth-system/`

---

## Git 형상관리

- **Init**: dirty tree 차단, .gitignore 자동
- **Branch**: `vela/<slug>-<HHMM>` (auto/prompt/none)
- **Artifact**: `.vela/artifacts/{date}_{id}_{slug}/` (플랫 구조)
- **Commit**: Conventional Commits + `Vela-Pipeline:` 참조
- **Cancel**: 체크포인트 hash + 복구 안내

---

## 설치 구조

```
your-project/
├── .vela/
│   ├── hooks/          ← 10 hooks (Gate Keeper, Guard, Orchestrator, Tracker, Stop, SessionStart, Compact, SubagentStart)
│   ├── cli/            ← vela-engine, vela-read, vela-write
│   ├── agents/         ← vela.md, researcher, planner, executor, reviewer, conflict-manager, leader(판단가이드)
│   ├── references/     ← interactive-ui.md, gates-and-guards.md, cli-reference.md, messages-en.md
│   ├── cache/          ← TreeNode SQLite
│   ├── templates/      ← pipeline.json, config.json
│   ├── statusline.sh   ← ⛵ 하단 바
│   └── install.js      ← 설치/검증/복구/upgrade
├── .claude/
│   ├── settings.local.json  ← 훅 + permission + agent + spinner + statusLine
│   └── agents/vela.md       ← 기본 에이전트
├── CLAUDE.md                ← Vela 규칙
└── (프로젝트 파일)
```

### install.js 명령어

| 명령 | 설명 |
|------|------|
| `node .vela/install.js` | 훅 설치 + 유효성 검증 |
| `node .vela/install.js verify` | 설치 검증만 |
| `node .vela/install.js upgrade` | 모든 파일을 최신 버전으로 갱신 (config.json 제외) |
| `node .vela/install.js status` | 현재 훅 상태 확인 |
| `node .vela/install.js uninstall` | Vela 훅 제거 |

---

## 엔진 명령어

```bash
vela-engine init "설명" --scale <small|medium|large>
vela-engine state
vela-engine transition
vela-engine record pass|fail
vela-engine sub-transition
vela-engine branch [--mode auto|prompt|none]
vela-engine commit [--message TEXT]
vela-engine cancel
vela-engine history
vela-cost                                            # 파이프라인 비용/메트릭
vela-report [--html output.html]                     # 파이프라인 리포트/대시보드
```

---

## 라이선스

MIT License — Copyright (c) 2026 EcoKG
