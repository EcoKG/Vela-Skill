---
name: vela
description: "⛵ Vela 샌드박스 엔진. /vela:start 로 파이프라인 시작, /vela:analyze 로 분석 보고서, /vela:git-clean 으로 git 정리, /vela:update 로 엔진 업데이트. Claude Code의 모든 행위를 파이프라인 기반으로 통제하는 샌드박스 시스템. Vela, 벨라, 샌드박스, 파이프라인, 시작, start, analyze, git-clean, update 등의 키워드가 언급되면 이 스킬을 트리거한다."
---

# ⛵ Vela Engine v4.1 — Sandbox Development System (Enhanced Harness)

Vela는 Claude Code를 완전히 감싸는 샌드박스 엔진이다.

## /vela 호출 시

`$ARGUMENTS`를 확인한다:
- `$ARGUMENTS`가 `start` 또는 `start <작업설명>` → `/vela:start` 절차 실행
- `$ARGUMENTS`가 `status` → 현재 파이프라인 상태를 보여준다:
  ```bash
  node .vela/cli/vela-engine.js state
  ```
  결과를 예쁘게 포맷하여 표시:
  ```
  ⛵ Vela Pipeline Status
  🧭 standard │ Step: execute (7/12) │ Task: 인증 시스템 추가
  ✦ Branch: vela/auth-system-1358
  🌟 Completed: init → research → plan → plan-check → checkpoint → branch
  ```
  파이프라인이 없으면: `⛵ Vela — Explore 모드. 활성 파이프라인 없음.`
- `$ARGUMENTS`가 `git-clean` → `/vela:git-clean` 절차 실행. `skills/git-clean/SKILL.md`를 읽고 지시대로 수행한다.
- `$ARGUMENTS`가 `analyze` → `/vela:analyze` 절차 실행
- `$ARGUMENTS`가 `sprint` 또는 `sprint <args>` → `/vela:sprint` 절차 실행
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
      }
    ],
    "multiSelect": false
  }]
}
```

- "파이프라인 시작" → `/vela:start` 절차

---

## /vela:start — 파이프라인 바로 시작

이 커맨드가 호출되면 Vela 파이프라인을 즉시 시작한다.
`.vela/`가 없으면 자동으로 환경을 구축한 후 파이프라인을 시작한다.

### 절차

1. **Vela 설치 확인 (자동 구축)**
   `.vela/config.json`이 존재하는지 확인한다.
   - 있으면 → 바로 2단계로
   - 없으면 → `.vela/` 환경을 자동 구축 (`curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/install.sh | bash`) 후 2단계로 진행

2. **작업 내용 수집 + 프롬프트 최적화**
   `$ARGUMENTS`가 있으면 그것을 원본 요청으로 사용한다.
   예: `/vela:start 인증 시스템에 OAuth 추가` → "인증 시스템에 OAuth 추가"
   `$ARGUMENTS`가 비어있으면 사용자에게 "⛵ 어떤 작업을 진행할까요?" 질문한다.

   원본 요청을 확보한 후 **프롬프트 최적화** 절차를 실행한다 (vela.md 참조):
   - 프롬프트 분석 → AskUserQuestion으로 보완 항목 선택
   - 보완이 필요하면 세부 정보 수집
   - PM이 수집 정보를 조립하여 명확한 프롬프트 작성
   - PM이 이해 확인(Reflection) 출력 — 대상/작업/범위 요약
   - AskUserQuestion으로 "맞다 — 진행" / "수정 필요" 확인
   - 승인된 프롬프트가 `vela-engine.js init`의 request가 되고, PM이 Agent 도구로 파이프라인을 진행한다

3. **작업 유형 선택**
   type은 선택 사항 (기본값: code):
   - `code`: 기능 추가/구현
   - `code-bug`: 버그 수정 (테스트 통과까지 자동 반복)
   - `code-refactor`: 리팩토링
   - `docs`: 문서/설정/비-소스 수정

   모든 요청은 standard 12-step 파이프라인을 거친다.

4. **파이프라인 초기화**
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale <small|medium|large>
   ```

5. **파이프라인 진행**
   PM이 `vela-engine.js`로 상태를 추적하며, Agent 도구로 역할별 에이전트를 순서대로 소환한다.
   - research 단계: `Agent(subagent_type="vela-researcher")` → `Agent(subagent_type="vela-reviewer")`
   - plan 단계: `Agent(subagent_type="vela-planner")` → 리뷰
   - execute 단계: `Agent(subagent_type="vela-executor")` → 리뷰
   - verify 단계: `Agent(subagent_type="vela-verifier")`
   - 각 단계 완료 후 `node .vela/cli/vela-engine.js transition`으로 전이

---

## /vela:sprint — 멀티 슬라이스 스프린트

`/vela sprint` (또는 `/vela:sprint`)은 대규모 작업을 여러 슬라이스로 분해하여 순차 실행하는 스프린트 오케스트레이션이다.

### 절차 (V6)

1. **스프린트 계획**: PM이 `Agent(subagent_type="vela-sprint-planner")`를 호출하여 요청을 의존성 그래프 기반 슬라이스로 분해한다 → `sprint-{timestamp}.json` 생성.
2. **순차 실행**: 각 슬라이스를 독립 파이프라인으로 PM이 직접 실행한다 (Agent 도구 체인).
3. **컨텍스트 전달**: 완료된 의존 슬라이스의 결과(artifacts)를 후속 슬라이스 프롬프트에 포함한다.
4. **상태 추적**: `sprint-manager.js`가 스프린트 FSM 상태와 슬라이스별 진행률을 `.vela/sprints/sprint-*.json`에 기록한다.

### 실행 모드 결정 — 파이프라인 vs 스프린트

| 조건 | 실행 방식 |
|------|----------|
| 단일 작업, 명확한 범위 | `/vela:start` — 단일 파이프라인 |
| 여러 독립 기능, 복합 요청 | `/vela:sprint` — 멀티 슬라이스 스프린트 |

PM이 사용자 요청의 복잡도를 분석하여 적절한 실행 방식을 제안한다.

---

## /vela:analyze — 프로젝트 분석 + PDF 보고서

이 커맨드가 호출되면 프로젝트의 의존성, 보안, 버그, 성능, 코드 품질, 아키텍처를 선택적으로 분석하고 PDF 보고서를 생성한다.

### 절차

1. **분석 항목 선택**

   사용자에게 분석할 항목을 다중 선택으로 질문한다:

   ```json
   {
     "questions": [
       {
         "question": "📊 분석할 항목을 선택하세요:",
         "header": "📊 Analyze",
         "options": [
           { "label": "Dependencies (Recommended)", "description": "npm audit + outdated 기반 의존성 취약점/업데이트 분석" },
           { "label": "Security", "description": "인증 취약점, 인젝션, 자격증명 노출, 데이터 유출 분석" },
           { "label": "Bugs", "description": "로직 에러, 레이스 컨디션, null 참조, 에러 핸들링 분석" },
           { "label": "Performance", "description": "N+1 쿼리, 메모리 릭, 알고리즘 복잡도, I/O 병목 분석" },
           { "label": "Code Quality", "description": "네이밍, 중복, 결합도, 가독성, 데드코드 분석" },
           { "label": "Architecture", "description": "레이어 분리, 의존성 방향, 추상화, 모듈 경계 분석" }
         ],
         "multiSelect": true
       }
     ]
   }
   ```

2. **선택 항목 매핑**

   선택된 라벨을 CLI `--items` 값으로 변환한다:

   | 선택 라벨 | CLI 값 |
   |----------|--------|
   | Dependencies | `deps` |
   | Security | `security` |
   | Bugs | `bugs` |
   | Performance | `performance` |
   | Code Quality | `code-quality` |
   | Architecture | `architecture` |

3. **모델 선택 (SDK 분석 항목이 있을 때만)**

   Dependencies만 선택된 경우 모델 선택을 건너뛴다 (deps는 npm CLI 기반이므로 모델 불필요).
   Security, Bugs, Performance, Code Quality, Architecture 중 하나라도 선택되었으면 모델을 질문한다:

   ```json
   {
     "questions": [
       {
         "question": "분석 모델을 선택하세요 (Dependencies는 모델 불필요):",
         "header": "🤖 Model",
         "options": [
           { "label": "Haiku (Recommended)", "description": "빠르고 저렴한 분석. 대부분의 경우 충분" },
           { "label": "Sonnet", "description": "더 정밀한 분석. 비용 ↑" },
           { "label": "Opus", "description": "최고 정밀도. 복잡한 코드베이스에 적합" }
         ],
         "multiSelect": false
       }
     ]
   }
   ```

   - "Haiku" → `--model haiku`
   - "Sonnet" → `--model sonnet`
   - "Opus" → `--model opus`
   - Dependencies만 선택 시 → `--model` 생략 (기본값 haiku 사용)

4. **분석 실행**

   `deps` 항목: `vela-analyze.js`로 npm 의존성 분석
   ```bash
   node .vela/cli/vela-analyze.js deps --output ./vela-analysis-report.pdf
   ```

   코드 분석 항목(security/bugs/performance/code-quality/architecture): `vela-analyzer` Agent로 실행
   ```
   Agent(subagent_type="vela-analyzer", prompt="
     items: {comma-separated-items}
     프로젝트를 분석하고 결과를 반환하라.
   ")
   ```

   둘 다 선택된 경우: deps CLI 먼저 실행 후 analyzer Agent 실행, 결과 통합

5. **결과 표시**

   - 성공 시: `📊 분석 완료! PDF 보고서: ./vela-analysis-report.pdf` + 선택된 항목 요약
   - 실패 시: 에러 메시지를 사용자에게 표시하고 원인 안내

---

## 파이프라인 시스템

모든 작업은 크기와 관계없이 파이프라인을 따른다. 간단한 한 줄 수정도 예외 없이 파이프라인을 통과한다.

### 파이프라인 종류

| 종류 | 단계 | 조건 |
|------|------|------|
| **standard** | init → research → plan → plan-check → checkpoint → **branch** → execute → verify → diff-summary → learning → **commit** → finalize | 모든 요청 |

### 각 단계의 모드

| 단계 | 모드 | 팀 | 설명 |
|------|------|-----|------|
| init | read | — | 초기화, git 상태 스냅샷, dirty tree 체크 |
| research | rw-artifact | Researcher(Subagent) → Reviewer(Subagent) → PM | 프로젝트 분석 (research.md 생성, artifactDir scope Write 허용) |
| plan | write | Planner(Subagent) → Reviewer(Subagent) → PM | 구현 계획 작성 |
| plan-check | read | — | 계획 검증 (plan-check.md 생성) |
| checkpoint | read | — | 사용자 승인 대기 |
| **branch** | read | — | feature 브랜치 생성 (git) |
| execute | readwrite | Executor(Subagent) → Reviewer → PM 판단 | 구현 |
| verify | rw-artifact | — | 독립 검증 (verification.md 생성, artifactDir scope Write 허용) |
| **commit** | read | — | 변경사항 원자적 커밋 (git) |
| finalize | write | — | 보고서 생성, 선택적 PR |

**rw-artifact 모드 (M023 신규)**: `read` 모드 기반에 artifactDir scope의 Write만 추가로 허용. `createArtifactPathGuard(artifactDir)` PreToolUse 훅이 separator-aware prefix check로 Write 경로를 제한. Edit/NotebookEdit는 차단 유지. research/verify 단계가 artifact를 쓰면서도 코드 변경은 차단된다.

### 엔진 명령어 (V6 — PM이 직접 사용)

**V6에서 PM은 `vela-engine.js`를 직접 호출한다. `vela-pipeline.js`는 제거되었다.**

```bash
node .vela/cli/vela-engine.js init "작업 설명" [--scale small|medium|large|ralph|hotfix]
node .vela/cli/vela-engine.js state                 # 현재 상태 조회
node .vela/cli/vela-engine.js transition            # 다음 단계로 전이
node .vela/cli/vela-engine.js record pass           # 단계 성공 기록
node .vela/cli/vela-engine.js record reject         # 단계 실패 기록
node .vela/cli/vela-engine.js branch                # 브랜치 생성 (branch 단계)
node .vela/cli/vela-engine.js commit                # 변경사항 커밋 (commit 단계)
node .vela/cli/vela-engine.js cancel                # 파이프라인 취소
```

**옵션:**
| 옵션 | 설명 |
|------|------|
| `--scale <scale>` | 파이프라인 규모 (small/medium/large/ralph/hotfix) |
| `--auto` | auto 모드 활성화 |
| `--force` | dirty tree 체크 스킵 |

### 스프린트 (V6)

스프린트는 PM이 직접 처리한다:
1. `Agent(subagent_type="vela-sprint-planner")` → sprint-plan.json 생성
2. sprint-manager.js CLI로 슬라이스 상태 관리
3. PM이 각 슬라이스를 독립 파이프라인으로 순차 실행

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
# sub-phase 확인 (state에 sub_phase 필드로 노출됨)
node .vela/cli/vela-engine.js state
```

### 3단계 검증 — Agent 도구 기반 (V6)

PM이 Claude Code 네이티브 Agent 도구로 역할 에이전트를 직접 소환하여 각 단계를 실행한다.

#### V6 검증 흐름

```
PM → Agent(subagent_type="vela-reviewer", prompt="step: {step}, artifactDir: {dir}")
  → review-{step}.md 작성 → approval-{step}.json 자동 생성
     ├─ APPROVE (점수 ≥ 20/25) → PM이 vela-engine transition 호출
     └─ REJECT → Worker에게 피드백 전달 → 재작업 → 리뷰 재실행
```

#### 역할 에이전트 목록

| 에이전트 | 역할 | 산출물 |
|---------|------|--------|
| `vela-researcher` | 아키텍처/보안/품질 3관점 분석 | `research.md` |
| `vela-planner` | plan.md 작성 | `plan.md` |
| `vela-plan-checker` | plan.md 구조 검증 | `plan-check.md` |
| `vela-executor` | TDD 기반 코드 구현 | `task-summary.md` |
| `vela-reviewer` | 5차원 채점 (≥20/25 승인) | `review-{step}.md` |
| `vela-verifier` | 테스트/린트/타입 체크 | `verification.md` |
| `vela-diff-summary` | diff 5차원 통합 검토 | `diff-summary.md` |
| `vela-learning` | 학습 패턴 추출 | `learning.md` |

#### 에이전트 지시사항 (`.vela/agents/`)

V6 에이전트 파일은 모두 `vela-{role}.md` 형식이다. 위 역할 에이전트 목록 참조.

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
3. Worker가 산출물 수정 → 리뷰 재실행 → PM 재판단
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

## 에이전트 소환 패턴 (V6)

PM은 `Agent(subagent_type="vela-{role}")` 단일 호출로 역할 에이전트를 소환한다.
V6에서 Teammate/TeamCreate/SendMessage는 사용하지 않는다.

| 작업 | subagent_type | model 파라미터 |
|------|--------------|---------------|
| 프로젝트 분석 | `vela-researcher` | `"sonnet"` |
| 구현 계획 | `vela-planner` | `"sonnet"` |
| 코드 구현 | `vela-executor` | `"sonnet"` |
| 품질 리뷰 | `vela-reviewer` | `"sonnet"` |
| 테스트 검증 | `vela-verifier` | `"sonnet"` |

### 에이전트 소환 예시

```
Agent(
  subagent_type="vela-executor",
  prompt="
    request: {요청}
    artifactDir: {artifactDir}
    planPath: {artifactDir}/plan.md
    <task>
      <role>executor</role>
      <action>plan.md의 Class Specification에 따라 TDD로 구현한다.</action>
      <verify>npm test</verify>
      <done>모든 테스트 통과 + task-summary.md 생성</done>
    </task>
  "
)
```

### 리서치 — 프로젝트 분석

Research 단계에서 Subagent(Sonnet)가 단독으로 프로젝트 분석을 수행한다:
요구사항 파악 → 코드베이스 탐색 → 의존성/제약 분석 → 결론.
Opus + effort:high + thinking:adaptive로 직접 분석 (model-strategy.md 참조).

### 승인/거부 — 파일 기반

- **Reviewer** (Subagent, Sonnet): `review-{step}.md` 작성 (X/25 점수)
- **PM**: review 기반으로 `approval-{step}.json` 작성 (`approve`/`reject`)
- 엔진 exit gate가 `approval-{step}.json`의 `decision`을 확인
- 파일이 없거나 `approve`가 아니면 transition 차단

---

## 커스텀 어조 — persona.md

`.vela/persona.md` 파일에 어조 규칙을 작성하면 Orchestrator가 모든 세션에 자동 주입한다.

- 파이프라인 활성 여부와 무관하게 항상 주입된다
- 파일이 없거나 비어있으면 아무것도 출력하지 않는다
- Session Health Check 직후, Pipeline State Injection 직전에 출력된다

예시 (`.vela/persona.md`):
```markdown
- 한국어로 답변하라
- 간결하고 명확하게 말하라
- 코드 주석은 영어로 작성하라
```

---

## V6 오케스트레이션 구조

Vela V6는 Claude Code 네이티브 Agent 도구로 파이프라인을 제어한다. 외부 SDK 의존성 없음.

### 아키텍처

```
PM (vela.md agent)
  ├── vela-engine.js (상태 머신: init/transition/record)  ← CLI 호출
  ├── Agent(vela-researcher) → research.md
  ├── Agent(vela-planner)    → plan.md
  ├── Agent(vela-plan-checker) → plan-check.md
  ├── Agent(vela-executor)   → 코드 구현 (TDD)
  ├── Agent(vela-reviewer)   → review-{step}.md
  ├── Agent(vela-verifier)   → verification.md
  ├── Agent(vela-diff-summary) → diff-summary.md
  └── Agent(vela-learning)   → learning.md

Hooks (글로벌 등록 — ~/.vela/hooks/ → ~/.claude/settings.json):
  ├── vela-gate-keeper.js  (VK-01~08: 모드별 도구 제한)   [PreToolUse]
  ├── vela-gate-guard.js   (VG-03~15: 단계 순서 강제)     [PreToolUse]
  ├── vela-stop.js          (auto 모드 중 중단 방지)       [Stop]
  └── vela-review-gate.js  (APPROVE 후 N회 재검증 강제)   [Stop]
```

### 보안 규칙 (훅 기반)

| 훅 | 역할 | 규칙 |
|----|------|------|
| `vela-gate-keeper.js` | 모드별 Bash/Write/Edit 차단 | VK-01~08 |
| `vela-gate-guard.js` | 단계 순서 강제, PM 직접 수정 차단 | VG-03~15 |
| `vela-stop.js` | auto 모드 중 Stop 차단 | (Stop hook — 단일 규칙) |
| `vela-review-gate.js` | APPROVE 후 N회 재검증 강제 | review_gate.validation_rounds |

---

## 상세 레퍼런스

Gate Keeper/Guard 규칙, CLI 명령어, TreeNode 캐시 상세는 `references/` 디렉토리를 참조한다:
- `references/gates-and-guards.md` — 전체 게이트/가드 규칙 목록
- `references/cli-reference.md` — CLI 명령어 전체 레퍼런스
