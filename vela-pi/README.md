# ⛵ Vela Engine — Pi SDK Edition

**Vela**는 Pi SDK(`@gsd/pi-coding-agent`) 위에서 동작하는 결정론적 샌드박스 개발 엔진이다.
모든 AI 코딩 행위는 Vela의 파이프라인을 통해서만 진행된다.

> **v5.0**: Claude Code SKILL.md + Hook 기반 시스템에서 Pi SDK 기반 독립형 npm CLI 패키지(`vela-pi`)로 전면 이전.

---

## 사상 (Philosophy)

### 1. ⛵ 통제된 자유 (Controlled Autonomy)
AI 코딩 도구는 강력하지만, 통제 없는 자유는 위험하다. Vela는 **"언제, 어떤 순서로, 누구의 검증을 거쳐 할 수 있는가"**를 강제한다.

### 2. 🌟 이중 방어 (Defense in Depth)
- **Gate Keeper (VK)** + **Gate Guard (VG)** — Pi SDK `checkToolCall` 레벨 이중 차단 (Fail-closed)
- **독립 Reviewer 에이전트** — `dispatch.ts`의 `reviewer` 역할, 격리된 inMemory 세션
- **VG-00**: 파이프라인 중 TaskCreate/TaskUpdate/TodoWrite 차단
- **pipeline-state.json + config.json 보호**: 직접 수정 불가 (VG-05)

### 3. 🔭 추적 가능한 개발 (Traceable Development)
산출물(research.md, plan.md, review-execute.md, approval-execute.json), artifact 디렉토리, git 커밋에 파이프라인 참조.

### 4. ✦ 구조로 강제 (Enforce by Structure)
지시는 무시된다. 산출물이 없으면 전이 차단. approval 없으면 다음 단계 불가. `--scale` 미지정 시 init 거부.

---

## 빠른 시작

### 설치

```bash
npm install -g vela-pi
```

### 실행

```bash
vela
```

또는 Pi 세션 내에서 슬래시 커맨드:

```
/vela start "OAuth 인증 추가" --scale large
```

---

## 메커니즘

```
✦──────────────────────────────────────────────────────────✦
│                    ⛵ VELA SANDBOX (Pi SDK)               │
│                                                           │
│  ⛵ Gate Keeper (VK)    🌟 Gate Guard (VG)               │
│  모드 기반 도구 차단      파이프라인 상태 기반 게이트        │
│  checkToolCall()          checkGateGuard()                │
│                                                           │
│  🧭 PIPELINE ────────────────────────────────────        │
│  init → research → plan → plan-check → checkpoint        │
│       → branch → execute → verify → diff-summary         │
│       → learning → commit → finalize                     │
│                                                           │
│  🔌 DISPATCH (dispatch.ts) ───────────────────────        │
│  researcher:    read-only 분석 → research.md              │
│  planner:       구현 계획 → plan.md                       │
│  plan-checker:  plan 구조 검증 → plan-check.md            │
│  executor:      TDD 코드 구현 → task-summary.md           │
│  reviewer:      코드 리뷰 → review-execute.md             │
│  diff-summary:  diff 요약 → diff-summary.md               │
│  learning:      패턴 추출 → learning.md                   │
│  finalizer:     최종 보고서 → report.md                   │
│  sprint-planner: 스프린트 분해 → sprint-plan.json         │
│  ↳ 각 역할은 SessionManager.inMemory() 격리 세션          │
│                                                           │
│  🗂 SPRINT (sprint.ts) ────────────────────────────       │
│  /vela sprint run <request> → 슬라이스 분해 → 자동 실행   │
│  슬라이스 FSM: planned → queued → running → done/failed  │
│  의존성 DAG + Kahn's 알고리즘 사이클 감지                  │
✦──────────────────────────────────────────────────────────✦
```

### Explore / Develop 듀얼 모드

| 모드 | 상태 | 허용 | 차단 |
|------|------|------|------|
| **⛵ Explore** (`read`) | 파이프라인 없음 | 읽기, 탐색 | 쓰기, TaskCreate |
| **🧭 Develop** (`write`/`readwrite`) | 파이프라인 활성 | 단계에 따름 | 단계 건너뛰기, TaskCreate |

---

## 파이프라인

| 종류 | 단계 | 선택 |
|------|------|------|
| **standard** | init → research → plan → plan-check → checkpoint → branch → execute → verify → diff-summary → learning → commit → finalize | `--scale large` |
| **quick** | init → plan → execute → verify → commit → finalize | `--scale medium` |
| **trivial** | init → execute → commit → finalize | `--scale small` |
| **ralph** | init → execute ↔ verify (반복, 최대 10회) → commit → finalize | `--scale ralph` |
| **hotfix** | init → execute → commit | `--scale hotfix` |

`--scale` 필수. 미지정 시 AskUserQuestion으로 사용자에게 선택 요구.

### Ralph 모드
테스트 통과까지 execute → verify를 최대 10회 자동 반복. 버그 수정/TDD에 적합.

### Hotfix 모드
비-소스 변경(문서, 설정, README)용 최소 파이프라인. 리뷰 스킵.

### Verify 재시도 루프
standard 파이프라인에서 verify 실패 시 execute → verify 사이클을 `max_revisions`(기본 3)까지 자동 반복. 반복 소진 시 파이프라인 중단.

---

## Sub-Agent Dispatch

`dispatch.ts`는 파이프라인 단계별 격리 AI 에이전트를 생성한다. 각 역할은 `SessionManager.inMemory(cwd)`를 사용하는 독립 세션으로 실행된다.

### 역할 목록

| 역할 | 출력 파일 | 도구셋 | 설명 |
|------|-----------|--------|------|
| `researcher` | research.md | read-only | 코드베이스 분석 |
| `planner` | plan.md | coding | 구현 계획 수립 |
| `plan-checker` | plan-check.md | read-only | plan.md 구조 검증 |
| `executor` | task-summary.md | coding | TDD 코드 구현 |
| `reviewer` | review-execute.md | read-only | 코드 리뷰 (APPROVE/REJECT + 점수) |
| `diff-summary` | diff-summary.md | read-only | diff 통합 요약 |
| `learning` | learning.md | read-only | 파이프라인 패턴 추출 |
| `finalizer` | report.md | coding | 최종 파이프라인 보고서 |
| `sprint-planner` | sprint-plan.json | read-only | 요청을 슬라이스 DAG로 분해 |

### 수동 디스패치

```
/vela dispatch researcher "OAuth 인증 분석"
/vela dispatch planner "OAuth 인증 추가"
```

---

## 스프린트 오케스트레이션

`/vela sprint`는 대형 작업을 병렬 가능한 슬라이스로 분해하여 자동 실행한다.

### 슬라이스 FSM

```
planned → queued → running → done
                          ↘ failed
         ↘ skipped
```

### 커맨드

```
/vela sprint run <request>   # 새 스프린트 시작 (sprint-planner가 슬라이스 분해)
/vela sprint status          # 현재 스프린트 진행 상황
/vela sprint resume          # 중단된 스프린트 재개
/vela sprint cancel          # 활성 스프린트 취소
```

### 스프린트 아티팩트

```
.vela/sprints/{id}/
├── sprint.json          # 스프린트 플랜 + 슬라이스 상태
└── sprint-summary.md    # 슬라이스 진행 테이블 + 통계
```

---

## 방어 시스템

### ⛵ Gate Keeper (VK — 모드 기반)

Pi SDK `checkToolCall()` 내에서 동기적으로 실행. 모드에 따라 도구 호출을 차단한다.

| 게이트 | 코드 | 규칙 |
|--------|------|------|
| Bash 읽기전용 차단 | VK-01 | `read`/`rw-artifact` 모드에서 쓰기 Bash 차단 |
| Bash allowlist | VK-02 | `read` 모드에서 `SAFE_BASH_READ` 외 Bash 차단 |
| 모드 강제 | VK-03, VK-04 | `read` 모드에서 Write/Edit 차단 |
| 민감파일 보호 | VK-05 | `.env`, `credentials.json`, 개인키 등 쓰기 차단 |
| 시크릿 감지 | VK-06 | AWS 키, GitHub PAT, Anthropic 키 등 15개 패턴 차단 |
| PM 속독 | VK-07 | delegation.json 없이 PM 직접 소스 수정 차단 |
| 체인 연산자 차단 | VK-08 | `&&`, `\|\|`, `;`, `\|` — `ls && rm -rf /` 방지 |

### 🌟 Gate Guard (VG — 파이프라인 상태 기반)

Pi SDK `checkGateGuard()` 내에서 `pipeline-state.json`을 읽어 파이프라인 순서를 강제한다.

| 가드 | 코드 | 규칙 |
|------|------|------|
| TodoWrite 차단 | VG-00 | 파이프라인 중 TaskCreate/TaskUpdate/TaskList/TodoWrite 차단 |
| 실행 전 소스 수정 차단 | VG-02 | execute 단계 전 소스코드 Write/Edit 차단 |
| 보고서 순서 | VG-04 | verification.md 없이 report.md 작성 차단 |
| 상태 파일 보호 | VG-05 | pipeline-state.json 직접 수정 차단 |
| git commit 제한 | VG-07 | execute/commit/finalize 단계에서만 git commit 허용 |
| git push 제한 | VG-08 | verify 완료 전 push 차단, --force 항상 차단 |
| 비-팀 단계 승인 차단 | VG-11 | team 단계 외 approval/review 작성 차단 |
| executor 위임 | VG-12 | execute 단계에 delegation.json 필요 |
| 파괴적 명령 차단 | VG-DESTROY | `rm -rf`, `git reset --hard` 차단 |

### Fail-Closed 보안 모델

모든 오류 경로는 fail-closed로 동작한다:
- 잘못된 입력 → 도구 차단
- 미처리 예외 → 도구 차단

---

## 슬래시 커맨드 레퍼런스

```
/vela start "<request>" [--scale small|medium|large|ralph|hotfix]
/vela status                                    # 현재 파이프라인 상태
/vela transition                                # 다음 단계로 전이
/vela record pass|fail|reject [--summary TEXT]  # 단계 결과 기록
/vela sub-transition                            # TDD 서브페이즈 전진
/vela branch [--mode auto|prompt|none]          # 피처 브랜치 생성
/vela commit [--message TEXT]                   # 파이프라인 커밋
/vela history                                   # 파이프라인 이력
/vela dispatch <role> <request>                 # 서브에이전트 수동 디스패치
/vela sprint run|status|resume|cancel [args]    # 스프린트 오케스트레이션
/vela auto                                      # Auto 모드 토글
/vela cancel                                    # 파이프라인 취소
/vela help                                      # 도움말
```

---

## CLI 플래그

`vela` 바이너리는 `dist/loader.ts` → `dist/cli.ts`를 통해 Pi SDK를 직접 초기화한다.

```
vela [options]

Options:
  --print              Print mode (non-interactive)
  --mode text|json|rpc Output format (print mode에서)
  --model <id>         사용할 모델 ID 지정
  --continue           이전 세션 이어서 시작
  --no-session         세션 없이 시작
  --list-models        사용 가능한 모델 목록 출력
  --verbose            상세 로그 출력
  --version            버전 출력
  --help               도움말
```

---

## 산출물 구조

```
.vela/
├── pipeline-state.json              # 현재 파이프라인 상태 (엔진 관리)
├── config.json                      # 프로젝트별 설정
├── artifacts/{YYYYMMDD}T{HHmmss}-{slug}/
│   ├── meta.json
│   ├── pipeline-state.json
│   ├── research.md
│   ├── plan.md, plan-check.md
│   ├── task-summary.md
│   ├── review-execute.md, approval-execute.json
│   ├── verification.md
│   ├── diff.patch, diff-summary.md, approval-diff-summary.json
│   ├── learning.md
│   └── report.md
└── sprints/{sprint-id}/
    ├── sprint.json
    └── sprint-summary.md
```

---

## 패키지 구조

```
vela-pi/
├── package.json                     # name: vela-pi, bin: vela → dist/loader.js
├── src/
│   ├── loader.ts                    # 진입점 — Pi SDK 환경 변수 설정, GSD_BUNDLED_EXTENSION_PATHS
│   ├── cli.ts                       # Standalone Pi SDK CLI (gsd-pi 의존성 없음)
│   └── resources/extensions/vela/
│       ├── index.ts                 # 익스텐션 등록 (registerVelaCommands, checkToolCall)
│       ├── pipeline.ts              # 파이프라인 상태 머신 (vela-engine.js 포트)
│       ├── commands.ts              # /vela 슬래시 커맨드 핸들러
│       ├── dispatch.ts              # Sub-agent 디스패처 (sdk-runner.js 포트)
│       ├── guards.ts                # VK/VG 게이트 강제
│       ├── git.ts                   # Git 헬퍼 (push, stash, branch 감지 등)
│       ├── sprint.ts                # 스프린트 오케스트레이션 (sprint-manager.js 포트)
│       └── templates/
│           └── pipeline.json        # 파이프라인 타입 정의 (standard/quick/trivial/ralph/hotfix)
└── dist/                            # tsc 빌드 출력
```

### 핵심 환경 변수

| 변수 | 값 | 설명 |
|------|----|------|
| `GSD_BUNDLED_EXTENSION_PATHS` | `dist/resources/extensions/vela/index.js` | Vela 익스텐션만 로드 (GSD 익스텐션 제외) |
| `PI_PACKAGE_DIR` | `vela-pi/pkg/` | Pi 설정 디렉토리 |
| `PI_APP_NAME` | `vela` | Pi 앱 식별자 |

---

## 빌드

```bash
npm run build    # tsc + copy-assets (templates 복사)
npm run dev      # --experimental-strip-types로 직접 실행
```

Node.js ≥ 22.0.0 필요.

---

## 버전 이력

| 버전 | 마일스톤 | 주요 변경 |
|------|---------|----------|
| v1.0 | — | Gate Keeper + Gate Guard + Orchestrator, 5종 파이프라인 |
| v2.0 | M001 | Auto 모드, PM 속독, persona.md |
| v2.5 | M002 | Hook 4→18개 |
| v3.0 | M003 | Claude Agent SDK 통합, 5개 SDK 모듈 |
| v3.1 | M004 | `/vela analyze` — 분석 보고서 + PDF 생성 |
| v3.2 | M008 | Fail-closed 게이트, 체인 연산자 차단(VK-08), 21개 테스트 스위트 |
| v3.3 | M010 | 18개 훅 → SDK 오케스트레이터(vela-pipeline.js) 전환 |
| v4.0 | M013 | MCP 커스텀 도구 팩토리, SDK structured output, 레거시 훅 제거 |
| v4.0 | M015 | change-surface.js — 참조 무결성 자동 검증 |
| v4.0 | M024 | maxTurns 상한 제거 — SDK 에이전트 자율 턴 소비 |
| **v5.0** | **Pi Migration** | **SKILL.md + Hook 시스템 → Pi SDK 독립형 npm CLI 패키지 전면 이전** |
| v5.0 | Phase 1 | vela-pi 패키지 구조 초기화 (tsconfig, loader.ts, index.ts) |
| v5.0 | Phase 2 | pipeline.ts — vela-engine.js 전체 TypeScript 포트 |
| v5.0 | Phase 3 | dispatch.ts — Pi SDK inMemory 세션 기반 Sub-agent 디스패처 |
| v5.0 | Phase 4 | guards.ts — VK-01~VK-08 + VG-00~VG-12 게이트 통합 |
| v5.0 | Phase 5 | git.ts — 타입 안전 Git 헬퍼 모듈 |
| v5.0 | Phase 6 | sprint.ts — 스프린트 오케스트레이션 + /vela sprint 커맨드 |
| v5.0 | Phase 7 | cli.ts — gsd-pi 의존성 없는 독립형 Pi SDK CLI 진입점 |

---

## 라이선스

MIT License — Copyright (c) 2026 EcoKG
