---
name: vela
description: "⛵ Vela 샌드박스 엔진. /vela:init 으로 프로젝트에 Vela 환경을 구축하고, /vela:start 로 바로 파이프라인을 시작한다 (init이 안 되어 있으면 자동으로 init 먼저 수행). Claude Code의 모든 행위를 파이프라인 기반으로 통제하는 샌드박스 시스템. 사용자가 프로젝트 환경 구축, 개발 파이프라인 설정, 코드 수정, 리팩토링, 기능 추가 등을 요청할 때 이 스킬을 사용해야 한다. Vela, 벨라, 샌드박스, 파이프라인, 시작, start, init 등의 키워드가 언급되면 이 스킬을 트리거한다."
---

# ⛵ Vela Engine v2.0 — Sandbox Development System

Vela는 Claude Code를 완전히 감싸는 샌드박스 엔진이다.

## /vela 호출 시

`$ARGUMENTS`를 확인한다:
- `$ARGUMENTS`가 `init` → `/vela:init` 절차 실행
- `$ARGUMENTS`가 `start` 또는 `start <작업설명>` → `/vela:start` 절차 실행
- `$ARGUMENTS`가 `status` → 현재 파이프라인 상태를 보여준다:
  ```bash
  node .vela/cli/vela-engine.js state
  ```
  결과를 예쁘게 포맷하여 표시:
  ```
  ⛵ Vela Pipeline Status
  🧭 standard │ Step: execute (7/10) │ Task: 인증 시스템 추가
  ✦ Branch: vela/auth-system-1358
  🌟 Completed: init → research → plan → plan-check → checkpoint → branch
  ```
  파이프라인이 없으면: `⛵ Vela — Explore 모드. 활성 파이프라인 없음.`
- `$ARGUMENTS`가 비어있음 → AskUserQuestion으로 선택:

```json
{
  "questions": [{
    "question": "⛵ Vela — 무엇을 하시겠습니까?",
    "header": "⛵ Vela",
    "options": [
      {
        "label": "파이프라인 시작 (Recommended)",
        "description": "작업을 시작합니다. Vela 환경이 없으면 자동으로 구축합니다."
      },
      {
        "label": "환경 구축만",
        "description": "이 프로젝트에 Vela 환경(.vela/)을 설치합니다. 파이프라인은 시작하지 않습니다."
      }
    ],
    "multiSelect": false
  }]
}
```

- "파이프라인 시작" → `/vela:start` 절차
- "환경 구축만" → `/vela:init` 절차

---

## /vela:start — 파이프라인 바로 시작

이 커맨드가 호출되면 Vela 파이프라인을 즉시 시작한다.
init이 안 되어 있으면 자동으로 init을 먼저 수행한 후 파이프라인을 시작한다.

### 절차

1. **Vela 설치 확인 (자동 init)**
   `.vela/config.json`이 존재하는지 확인한다.
   - 있으면 → 바로 2단계로
   - 없으면 → `/vela:init` 절차를 먼저 수행한 후 2단계로 진행

2. **작업 내용 수집 + 프롬프트 최적화**
   `$ARGUMENTS`가 있으면 그것을 원본 요청으로 사용한다.
   예: `/vela:start 인증 시스템에 OAuth 추가` → "인증 시스템에 OAuth 추가"
   `$ARGUMENTS`가 비어있으면 사용자에게 "⛵ 어떤 작업을 진행할까요?" 질문한다.

   원본 요청을 확보한 후 **프롬프트 최적화** 절차를 실행한다 (vela.md 참조):
   - 프롬프트 분석 → AskUserQuestion으로 보완 항목 선택
   - 보완이 필요하면 세부 정보 수집
   - PM이 수집 정보를 조립하여 명확한 프롬프트 작성
   - 조립된 프롬프트를 사용자에게 보여주고 확인
   - 승인된 프롬프트가 `vela-engine init`의 request가 된다

3. **파이프라인 규모 선택**
   사용자에게 선택지를 제시한다:
   - ⛵ **small**: trivial (init → execute → commit → finalize) — 단일 파일, 10줄 이하
   - 🧭 **medium**: quick (init → plan → execute → verify → commit → finalize) — 3파일 이하
   - ✦ **large**: standard (full 10-step with research, plan, team review) — 대규모 작업
   - 🔄 **ralph**: ralph (테스트 통과까지 자동 반복) — 버그 수정, TDD
   - 🔧 **hotfix**: hotfix (init → execute → commit) — 문서, 설정 등 비-소스 수정

4. **파이프라인 시작**
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale <small|medium|large|ralph|hotfix> --type <code|code-bug|code-refactor|docs>
   ```

5. **파이프라인 진행**
   `.vela/agents/vela.md`의 지시사항에 따라 파이프라인 단계를 순서대로 진행한다.
   - standard: Research=Teammate(Opus) + Plan=Subagent(Opus) + Execute=Subagent/Teammate(Sonnet) + Reviewer(Subagent)
   - quick: Subagent 기반 + Reviewer(Subagent)
   - trivial: PM 직접 수행

---

## /vela:init — 환경 구축

이 커맨드가 호출되면 현재 프로젝트에 Vela 환경을 구축한다.

### 초기화 절차

1. **언어 선택 질문**
   사용자에게 CLI 도구의 스크립트 언어를 질문한다 (Node.js 또는 Python).
   가장 빠른 처리가 가능한 것을 추천하되 최종 선택은 사용자가 한다.

2. **디렉토리 구조 생성**
   프로젝트 루트에 `.vela/` 디렉토리를 생성한다:
   ```
   .vela/
   ├── config.json              ← Vela 설정
   ├── hooks/                   ← 훅 스크립트
   │   ├── vela-gate-keeper.js  ← 수문장 (PreToolUse)
   │   ├── vela-gate-guard.js   ← 가이드라인 (PreToolUse)
   │   ├── vela-orchestrator.js ← 상태주입 (UserPromptSubmit)
   │   ├── vela-tracker.js      ← 추적기 (PostToolUse)
   │   └── shared/
   │       ├── constants.js
   │       └── pipeline.js
   ├── cli/                     ← 커스텀 CLI 도구
   │   ├── vela-engine.js       ← 파이프라인 엔진
   │   ├── vela-read.js         ← 읽기 도구
   │   └── vela-write.js        ← 쓰기 도구
   ├── cache/                   ← TreeNode SQLite 캐시
   │   └── treenode.js          ← 캐시 관리자
   ├── templates/
   │   └── pipeline.json        ← 파이프라인 정의
   └── artifacts/               ← 파이프라인 실행 산출물
   ```

3. **스크립트 배포**
   이 스킬의 `scripts/` 디렉토리에 있는 파일들을 `.vela/`로 복사한다:
   - `scripts/hooks/*` → `.vela/hooks/`
   - `scripts/cli/*` → `.vela/cli/`
   - `scripts/cache/*` → `.vela/cache/`
   - `scripts/install.js` → `.vela/install.js`
   - `templates/*` → `.vela/templates/`

4. **훅 등록**
   `.vela/install.js`를 실행하여 Claude Code의 `~/.claude/settings.json`에 훅을 등록한다:
   ```bash
   node .vela/install.js
   ```

5. **훅 검증**
   ```bash
   node .vela/install.js verify
   ```

6. **초기화 확인**
   사용자에게 설치 결과를 보고한다.

### 없는 도구 생성 프로토콜

파이프라인 실행 중 필요한 CLI 도구가 없을 경우:
1. 사용자에게 "이 도구가 필요합니다. 만들어도 될까요?" 질문
2. 사용자가 승인하면 언어 선택 질문 (Node.js vs Python, 속도 기준 추천)
3. 도구 생성 후 `.vela/cli/`에 배치
4. 사용법을 사용자에게 안내

---

## 파이프라인 시스템

모든 작업은 크기와 관계없이 파이프라인을 따른다. 간단한 한 줄 수정도 예외 없이 파이프라인을 통과한다.

### 파이프라인 종류

| 종류 | 단계 | 조건 |
|------|------|------|
| **standard** | init → research → plan → plan-check → checkpoint → **branch** → execute → verify → **commit** → finalize | 6+ 파일, 300+ 라인 |
| **quick** | init → plan → execute → verify → **commit** → finalize | 3 파일 이하, 100 라인 이하 |
| **trivial** | init → execute → **commit** → finalize | 1 파일, 10 라인 이하 |

규모는 요청 내용을 분석하여 자동 감지한다.

### 각 단계의 모드

| 단계 | 모드 | 팀 | 설명 |
|------|------|-----|------|
| init | read | — | 초기화, git 상태 스냅샷, dirty tree 체크 |
| research | read | Researcher(Teammate) → Reviewer(Subagent) → PM | 경쟁가설 디버깅, 프로젝트 분석 |
| plan | write | Planner(Subagent) → Reviewer(Subagent) → PM | 구현 계획 작성 |
| plan-check | read | — | 계획 검증 (plan-check.md 생성) |
| checkpoint | read | — | 사용자 승인 대기 |
| **branch** | read | — | feature 브랜치 생성 (git) |
| execute | readwrite | Executor/Teammate → Reviewer → PM 판단 | 구현 |
| verify | read | — | 독립 검증 |
| **commit** | read | — | 변경사항 원자적 커밋 (git) |
| finalize | write | — | 보고서 생성, 선택적 PR |

### 엔진 명령어

모든 파이프라인 조작은 엔진 CLI를 통해서만 이루어진다:

```bash
node .vela/cli/vela-engine.js init "작업 설명"     # 파이프라인 시작 (git 상태 체크)
node .vela/cli/vela-engine.js state                 # 현재 상태
node .vela/cli/vela-engine.js transition            # 다음 단계로 전이
node .vela/cli/vela-engine.js dispatch --role ROLE  # 에이전트 스펙 조회
node .vela/cli/vela-engine.js record pass           # 결과 기록
node .vela/cli/vela-engine.js branch                # 브랜치 생성 (branch 단계)
node .vela/cli/vela-engine.js commit                # 변경사항 커밋 (commit 단계)
node .vela/cli/vela-engine.js sub-transition         # execute sub-phase 전진
node .vela/cli/vela-engine.js cancel                # 파이프라인 취소 (복구 안내 포함)
```

---

## 아키텍처 기반 개발 (Standard Pipeline)

Standard 파이프라인에서는 추상적 원칙("Clean Architecture를 따라라")이 아닌
**구체적 설계 명세서**를 기반으로 개발한다.

### Plan 단계 — 구체적 명세서 작성

Planner는 plan.md에 반드시 다음 섹션을 포함해야 한다.
**섹션이 없거나 200bytes 미만이면 엔진이 transition을 차단한다.**

```markdown
## Architecture
레이어 구조, 의존성 방향, 모듈 분리 설계

## Class Specification
구체적 인터페이스, 클래스, 메서드 정의:

Interface: ProductRepository
  - findById(id: string): Promise<Product>
  - save(product: Product): Promise<void>

Class: CreateProductUseCase
  - constructor(repo: ProductRepository)
  - execute(command: CreateProductCommand): Promise<Product>

## Test Strategy
테스트 케이스 목록:
- "should create product with valid data"
- "should throw when name is empty"
```

이 명세서는 Executor에게 "설계도"로 전달된다.
추상적 원칙이 아닌 구체적 스펙이므로 무시하기 어렵다.

### Execute 단계 — TDD Sub-Phase

Standard 파이프라인의 execute는 세 개의 sub-phase를 순서대로 진행한다:

```
test-write (Red)    → 테스트 먼저 작성
implement (Green)   → 테스트 통과하는 코드 작성
refactor (Refactor) → 구조 정리, 아키텍처 정렬
```

```bash
# sub-phase 확인
node .vela/cli/vela-engine.js state

# sub-phase 전진
node .vela/cli/vela-engine.js sub-transition
```

### 3단계 검증 — Subagent/Teammate 기반

Vela는 Claude Code의 **Agent/Subagent/Teams**를 작업 유형에 따라 구분하여 소환한다.

#### 검증 흐름

```
PM이 Worker 소환 (Teammate 또는 Subagent, 모델은 작업별 선택)
  → Worker: 작업 수행 → 산출물 작성 → PM에게 완료 보고
  → PM이 Reviewer subagent 소환 (Sonnet)
  → Reviewer: 산출물만 읽고 review-{step}.md 작성 → 결과 반환 (Subagent)
  → PM이 review 기반으로 approve/reject 판단 → approval-{step}.json 작성
     ├─ approve → transition 호출
     └─ reject → Worker에게 피드백 전달 → 재작업
```

#### 에이전트 소환 — 목차 기반 로딩

에이전트 MD 파일은 TOC 기반 구조. 전체를 읽지 않고 필요한 섹션만 읽는다.

```
Agent 도구:
  name: "executor"
  model: "sonnet"
  prompt: ".vela/agents/executor.md의 목차(첫 15줄)를 읽고,
           필요한 섹션만 선택적으로 읽으세요.
           담당 파일: {files}
           태스크: {task_list}
           아티팩트 경로: {artifact_dir}"
```

에이전트 지시사항 (`.vela/agents/`):
- `researcher.md` (Opus, Teammate) — 경쟁가설 디버깅, research.md 작성
- `planner.md` (Opus, Subagent) — 아키텍처 설계, plan.md 작성
- `executor.md` (Sonnet, Subagent/Teammate) — TDD 기반 코드 구현
- `reviewer.md` (Sonnet, Subagent) — 독립 품질 점검, review-{step}.md 작성
- `leader.md` — PM 승인 판단 가이드 (별도 에이전트 아님)
- `conflict-manager.md` (Sonnet, Teammate) — git 충돌 관리, 병합

#### 승인 메커니즘 — 파일 기반

PM이 Reviewer 리포트를 읽고 `approval-{step}.json`을 작성한다:
```json
{
  "step": "plan",
  "decision": "approve",
  "reviewer_score": "22/25",
  "justification": "모든 critical 이슈 해결됨",
  "timestamp": "2026-03-22T..."
}
```
엔진의 exit gate가 이 파일의 `decision`을 확인한다.
`approval-{step}.json`이 없거나 `decision`이 `approve`가 아니면 transition 차단.

#### reject 루프

PM이 reject하면:
1. `approval-{step}.json`에 `decision: "reject"`, `feedback: "..."` 작성
2. Worker에게 피드백과 함께 재작업 요청
3. Worker가 산출물 수정 → Reviewer 재소환 → PM 재판단
4. approve될 때까지 반복

---

## Git 형상관리

Vela는 파이프라인에 git 형상관리를 통합한다.

### Init 시 Git 상태 체크

파이프라인 시작 시 자동으로:
1. git 저장소 여부 확인
2. 현재 브랜치, base branch, HEAD hash 기록
3. **dirty tree 차단** — 미커밋 변경이 있으면 파이프라인 시작 불가 (`--force`로 스킵 가능)
4. `.gitignore`에 `.vela/` 내부 파일 자동 추가 (ghost commit 방지)

### Branch 단계

checkpoint 승인 후, execute 전에 feature 브랜치를 생성한다.

```bash
node .vela/cli/vela-engine.js branch              # auto 모드 (기본)
node .vela/cli/vela-engine.js branch --mode prompt # 명령어만 제안
node .vela/cli/vela-engine.js branch --mode none   # 브랜치 생성 안함
```

- 브랜치명: `vela/<slug>-<HHMM>` (예: `vela/api-보안-강화-1358`)
- 보호 브랜치(main/master/develop)에 있을 때만 생성
- 이미 feature 브랜치에 있으면 현재 브랜치 유지
- 비-코드 작업(분석, 문서)은 스킵

### Commit 단계

verify 완료 후 변경사항을 원자적으로 커밋한다.

```bash
node .vela/cli/vela-engine.js commit              # 자동 메시지 생성
node .vela/cli/vela-engine.js commit --message "custom message"
```

- **Conventional Commits** 포맷 자동 적용:
  `feat(slug): 설명` / `fix(slug): 설명` / `refactor(slug): 설명`
- 커밋 본문에 파이프라인 참조 포함 (`Vela-Pipeline: <artifact-dir>`)
- `.vela/` 내부 파일은 커밋에서 자동 제외
- `diff.patch` 아티팩트 자동 생성
- commit hash를 pipeline-state.json에 기록

### Cancel 시 복구

파이프라인 취소 시 체크포인트 hash와 복구 명령어를 안내한다:
- `git diff <checkpoint>..HEAD` — 파이프라인 중 변경 확인
- `git checkout <base-branch> && git branch -d <pipeline-branch>` — 브랜치 정리

### Gate Guard Git 규칙

| 가드 | 규칙 |
|------|------|
| GUARD 7 | execute/commit/finalize 단계에서만 `git commit` 허용 |
| GUARD 8 | verify 완료 전 `git push` 차단 |
| GUARD 9 | 보호 브랜치 직접 커밋 경고 |

### Permission Deny 규칙 (절대 차단)

- `git push --force/--force-with-lease/-f`, `git push origin +*`
- `git reset --hard`
- `git commit --no-verify/-n`
- `git clean -f/-fd`

---

## 에이전트 모델 선택

| 작업 유형 | 모델 | 역할 |
|----------|------|------|
| 파일 탐색/검색 | **Haiku** | 탐색 전용 subagent |
| 코드 구현/리뷰 | **Sonnet** | Executor, Reviewer, Conflict Manager |
| 설계/디버깅/분석 | **Opus** | Researcher, Planner |

## Teammate vs Subagent 구분

**Teammate** = 에이전트 간 소통(SendMessage)이 필요한 작업.
**Subagent** = 독립적, 단일 결과물 생산. 소통 불필요.

| 조건 | 방식 | model 파라미터 |
|------|------|---------------|
| 경쟁가설 디버깅 (리서치) | **Teammate** | `"opus"` |
| 다중 파일/CrossLayer 동시 수정 | **Teammate** | `"sonnet"` |
| 독립 리뷰/점검 | **Subagent** | `"sonnet"` |
| 단일 모듈 수정 | **Subagent** | `"sonnet"` |
| 파일 탐색 | **Subagent** | `"haiku"` |
| 설계/디버깅 분석 | **Subagent** | `"opus"` |

## 팀 구성 규칙

- **팀 크기**: 3~5명 (개발 팀원 + Conflict Manager 1명)
- **태스크 배분**: 팀원당 5~6개
- **파일 소유권**: 각 팀원에게 담당 파일/디렉토리 명시 부여. 동일 파일 중복 수정 금지

### 에이전트 소환 — 목차 기반 로딩

에이전트 MD 파일은 **목차(TOC) 기반**으로 구성. 전체를 읽지 않고 필요한 섹션만 선택적으로 읽는다.

```
Agent 도구:
  name: "executor"
  model: "sonnet"
  prompt: ".vela/agents/executor.md의 목차(첫 15줄)를 읽고,
           현재 작업에 필요한 섹션만 선택적으로 읽으세요.
           담당 파일: {files}
           태스크: {task_list}
           아티팩트 경로: {artifact_dir}"
```

### CrossLayer Development

다중 계층 작업 시 Teammate + Conflict Manager + Git Worktree 활용:

```
TeamCreate: "vela-pipeline"

Teammate "frontend-dev" (Sonnet) — 담당: src/components/, src/pages/
Teammate "backend-dev" (Sonnet)  — 담당: src/api/, src/services/
Teammate "db-dev" (Sonnet)       — 담당: sql/, src/repositories/
Teammate "conflict-manager" (Sonnet) — 인터페이스 감시 + 병합
```

각 팀원은 `isolation: "worktree"`로 격리 실행. 팀원 간 SendMessage로 인터페이스 조율.

### 리서치 — 경쟁가설 디버깅

Research 단계에서 경쟁가설 디버깅 적용:
가설 생성(3~5개) → 증거 수집 → 가설 제거 → 생존 가설 검증 → 결론.
디테일하되 과하지 않게: 반박 증거 발견 시 신속히 탈락.

### 승인/거부 — 파일 기반

- **Reviewer** (Subagent, Sonnet): `review-{step}.md` 작성 (X/25 점수)
- **PM**: review 기반으로 `approval-{step}.json` 작성 (`approve`/`reject`)
- 엔진 exit gate가 `approval-{step}.json`의 `decision`을 확인
- 파일이 없거나 `approve`가 아니면 transition 차단

---

## 상세 레퍼런스

Gate Keeper/Guard 규칙, CLI 명령어, TreeNode 캐시 상세는 `references/` 디렉토리를 참조한다:
- `references/gates-and-guards.md` — 전체 게이트/가드 규칙 목록
- `references/cli-reference.md` — CLI 명령어 전체 레퍼런스
