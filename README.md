# ⛵ Vela Engine v3.0 — Sandbox Development System

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
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/install.sh | bash
```

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

## 팀 메커니즘

### 모델 선택 전략

| 작업 유형 | 모델 | 역할 |
|----------|------|------|
| 파일 탐색/검색 | **Haiku** | 탐색 전용 subagent |
| 코드 구현/리뷰 | **Sonnet** | Executor, Reviewer, Conflict Manager |
| 설계/디버깅/분석 | **Sonnet** (기본) | Researcher, Planner (에스컬레이션 시 Opus) |

### 에스컬레이션

Sonnet 에이전트가 품질 미달 시 자동으로 Opus로 재시도:
- Reviewer 점수 15/25 미만 → SubagentStop hook이 `escalation.json` 생성
- Orchestrator가 일회성 Opus 에스컬레이션 directive 주입 후 flag 삭제
- PM reject 2회 연속 → Auto 모드 자동 중단

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

- **Reviewer** (Subagent, Sonnet) → `review-{step}.md` (X/25 점수 + 이슈)
- **PM** → `approval-{step}.json` (`decision: "approve"/"reject"`)
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
| 민감파일 보호 | VK-05 | .env, credentials.json 차단 |
| 시크릿 감지 | VK-06 | 15개 패턴 차단 |
| PM 속독 | VK-07 | PM은 Read/Glob/Grep 허용, Write/Edit 차단 |

### 🌟 Gate Guard (PreToolUse)

| 가드 | 코드 | 규칙 |
|------|------|------|
| GUARD 0 | VG-00 | 파이프라인 중 TaskCreate/TaskUpdate 차단 |
| GUARD 1 | VG-01 | research.md 없이 plan.md 불가 |
| GUARD 2 | VG-02 | execute 전 소스코드 수정 불가 + pipeline-state.json 보호 |
| GUARD 3 | VG-03 | 빌드/테스트 실패 시 commit 불가 |
| GUARD 5 | VG-05 | pipeline-state.json 직접 수정 불가 |
| GUARD 7 | VG-07 | execute/commit/finalize에서만 git commit 허용 |
| GUARD 8 | VG-08 | verify 완료 전 git push 차단 |
| GUARD 11 | VG-11 | 비-team 단계에서 approval/review 작성 차단 |
| GUARD 12 | VG-12 | execute 단계 PM 직접 소스 수정 차단 — 위임 강제 |

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
  ├── scripts/
  │   ├── hooks/                 ← 18 hooks
  │   │   └── shared/            ← pipeline.js, constants.js
  │   ├── cli/                   ← vela-engine, vela-read, vela-write, vela-cost, vela-report
  │   ├── agents/                ← vela.md, researcher, planner, executor, reviewer, conflict-manager, leader
  │   ├── cache/                 ← TreeNode SQLite
  │   ├── guidelines/            ← coding-standards, error-handling, testing-strategy
  │   ├── tests/                 ← 7개 계약 테스트 스위트 (149 assertions)
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
vela-cost                                        # 파이프라인 비용/메트릭
vela-report [--html output.html]                 # 파이프라인 리포트/대시보드
```

---

## 라이선스

MIT License — Copyright (c) 2026 EcoKG
