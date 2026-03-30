---
name: vela
description: "⛵ Vela 샌드박스 엔진. /vela:init 으로 프로젝트에 Vela 환경을 구축하고, /vela:start 로 바로 파이프라인을 시작한다 (init이 안 되어 있으면 자동으로 init 먼저 수행). /vela:git-clean 으로 프로젝트 git 정리. Claude Code의 모든 행위를 파이프라인 기반으로 통제하는 샌드박스 시스템. 사용자가 프로젝트 환경 구축, 개발 파이프라인 설정, 코드 수정, 리팩토링, 기능 추가, git 정리 등을 요청할 때 이 스킬을 사용해야 한다. Vela, 벨라, 샌드박스, 파이프라인, 시작, start, init, git-clean, git 정리 등의 키워드가 언급되면 이 스킬을 트리거한다."
---

# ⛵ Vela Engine v3.0 — Sandbox Development System

Vela는 Claude Code를 완전히 감싸는 샌드박스 엔진이다.

## /vela 호출 시

`$ARGUMENTS`를 확인한다:
- `$ARGUMENTS`가 `init` → `/vela:init` 절차 실행
- `$ARGUMENTS`가 `start` 또는 `start <작업설명>` → `/vela:start` 절차 실행
- `$ARGUMENTS`가 `auto` (인자 없음) → 활성 파이프라인이 있으면 auto 모드 토글:
  ```bash
  node .vela/cli/vela-engine.js auto
  ```
  활성 파이프라인이 없으면 `/vela:auto` 절차 실행 (새 파이프라인 시작)
- `$ARGUMENTS`가 `auto <작업설명>` → `/vela:auto` 절차 실행
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
- `$ARGUMENTS`가 `git-clean` → `/vela:git-clean` 절차 실행. `skills/git-clean/SKILL.md`를 읽고 지시대로 수행한다.
- `$ARGUMENTS`가 `analyze` → `/vela:analyze` 절차 실행
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
   - ⛵ **small**: 간단한 작업 — 단일 파일, 설정 변경, 소소한 수정
   - 🧭 **medium**: 보통 작업 — 여러 파일, 계획 후 구현
   - ✦ **large**: 대규모 작업 — 리서치, 설계, 팀 리뷰 포함

   type은 선택 사항 (기본값: code):
   - `code`: 기능 추가/구현
   - `code-bug`: 버그 수정 (테스트 통과까지 자동 반복)
   - `code-refactor`: 리팩토링
   - `docs`: 문서/설정/비-소스 수정

   scale + type 조합으로 파이프라인이 자동 결정된다:
   - small + code → trivial (init → execute → commit → finalize)
   - small + code-bug → ralph (자동 반복)
   - small + docs → hotfix (init → execute → commit)
   - medium + code → quick (init → plan → execute → verify → commit → finalize)
   - large + code → standard (full 10-step)

4. **파이프라인 시작**
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale <small|medium|large> --type <code|code-bug|code-refactor|docs>
   ```

5. **파이프라인 진행**
   `.vela/agents/vela.md`의 지시사항에 따라 파이프라인 단계를 순서대로 진행한다.
   - standard: Research=Subagent(Sonnet) + Plan=Subagent(Sonnet) + Execute=Subagent/Teammate(Sonnet) + Reviewer(Subagent)
   - quick: Subagent 기반 + Reviewer(Subagent)
   - trivial: PM 직접 수행

---

## /vela:auto — 자동 진행 파이프라인 (토글)

`/vela auto` (또는 `/vela:auto`)는 두 가지 동작을 한다:

### 1. 활성 파이프라인이 있을 때 → Auto 모드 토글

이미 파이프라인이 진행 중이면 auto 모드를 켜거나 끈다:
```bash
node .vela/cli/vela-engine.js auto
```
- Auto ON → OFF: 수동 모드로 전환. 각 단계를 직접 진행해야 한다.
- Auto OFF → ON: 자동 모드로 전환. reject 카운터가 초기화된다.

### 2. 활성 파이프라인이 없을 때 → Auto 모드로 새 파이프라인 시작

`/vela:start`와 동일하되 `--auto` 플래그를 추가한다:

1~3단계는 `/vela:start`와 동일.

4. **파이프라인 시작 (auto 플래그 추가)**
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale <small|medium|large> --type <code|code-bug|code-refactor|docs> --auto
   ```

5. **자동 진행**
   Orchestrator가 매 프롬프트에 `⚡ AUTO` directive를 주입한다.
   - 일반 단계: 현재 단계를 완료한 뒤 즉시 transition 호출
   - checkpoint 단계: plan-check 통과 확인 → record pass → transition 호출

### Auto 모드 중단 조건

- `record reject`가 **2회 연속** 발생하면 auto 모드가 자동 비활성화된다.
- Orchestrator가 `⚠ AUTO SUSPENDED` directive를 주입하여 PM에게 알린다.
- 이후 사용자가 수동으로 개입하여 문제를 해결해야 한다.

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
   │   ├── vela-notification.js ← 데스크톱 알림 (Notification)
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
           { "label": "Sonnet", "description": "더 정밀한 분석. 비용 ↑" }
         ],
         "multiSelect": false
       }
     ]
   }
   ```

   - "Haiku" → `--model haiku`
   - "Sonnet" → `--model sonnet`
   - Dependencies만 선택 시 → `--model` 생략 (기본값 haiku 사용)

4. **CLI 실행**

   ```bash
   node .vela/cli/vela-analyze.js full --items <comma-separated-items> --model <selected-model> --output ./vela-analysis-report.pdf
   ```

   예시:
   ```bash
   # deps + security + bugs 선택, haiku 모델
   node .vela/cli/vela-analyze.js full --items deps,security,bugs --model haiku --output ./vela-analysis-report.pdf

   # deps만 선택 (모델 선택 스킵)
   node .vela/cli/vela-analyze.js full --items deps --output ./vela-analysis-report.pdf
   ```

5. **결과 표시**

   - 성공 시: `📊 분석 완료! PDF 보고서: ./vela-analysis-report.pdf` + 선택된 항목 요약
   - 실패 시: 에러 메시지를 사용자에게 표시하고 원인 안내

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
| research | read | Researcher(Subagent) → Reviewer(Subagent) → PM | 프로젝트 분석 |
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
node .vela/cli/vela-engine.js init "작업" --auto   # auto 모드로 시작 (전 단계 자동 진행)
node .vela/cli/vela-engine.js state                 # 현재 상태
node .vela/cli/vela-engine.js transition            # 다음 단계로 전이
node .vela/cli/vela-engine.js dispatch --role ROLE  # 에이전트 스펙 조회
node .vela/cli/vela-engine.js record pass           # 결과 기록
node .vela/cli/vela-engine.js branch                # 브랜치 생성 (branch 단계)
node .vela/cli/vela-engine.js commit                # 변경사항 커밋 (commit 단계)
node .vela/cli/vela-engine.js sub-transition         # execute sub-phase 전진
node .vela/cli/vela-engine.js cancel                # 파이프라인 취소 (복구 안내 포함)
node .vela/cli/vela-engine.js review                # SDK 3단계 코드 리뷰 (Haiku→Sonnet→Opus)
node .vela/cli/vela-engine.js plan-check            # SDK plan.md 구조 검증 (Haiku)
node .vela/cli/vela-engine.js research              # SDK 3-관점 병렬 리서치 (Haiku)
node .vela/cli/vela-engine.js execute               # SDK 단일 실행 (Sonnet)
```

**옵션:**
| 옵션 | 설명 |
|------|------|
| `--scale <size>` | 파이프라인 규모 (small/medium/large) |
| `--type <type>` | 작업 유형 (code/code-bug/code-refactor/docs) |
| `--auto` | auto 모드 — 각 단계 완료 후 자동 transition. reject 2회 연속 시 중단. |
| `--force` | dirty tree 체크 스킵 |

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

### 3단계 검증 — SDK 기반

Vela는 `@anthropic-ai/claude-agent-sdk`를 사용하여 리뷰, 리서치, 계획 검증, 실행을 엔진 CLI에서 직접 수행한다.

#### SDK 모드 검증 흐름

```
엔진이 SDK Review 직접 실행 (review 커맨드)
  → Stage 1 (Haiku): 빠른 초기 리뷰, 점수 ≥ 20 → pass
  → Stage 2 (Sonnet): 심층 리뷰 (점수 15-19일 때 에스컬레이션)
  → Stage 3 (Opus): 최종 에스컬레이션 (점수 < 15)
  → review-{step}.md 작성 → approval-{step}.json 자동 생성
     ├─ approve → transition 호출
     └─ reject → Worker에게 피드백 전달 → 재작업
```

#### SDK 커맨드

| 커맨드 | 모델 | 설명 |
|--------|------|------|
| `review` | Haiku→Sonnet→Opus (3단계) | 코드/산출물 리뷰, 점수 기반 에스컬레이션 |
| `plan-check` | Haiku | plan.md 구조 검증 (필수 섹션 + 200byte 최소 분량) |
| `research` | Haiku × 3 (병렬) | 아키텍처/보안/품질 3-관점 병렬 분석 |
| `execute` | Sonnet | TDD 기반 코드 구현 (readwrite 권한) |

각 커맨드는 `runSdkAgent()`를 통해 SDK를 호출한다:
- `settingSources: []` — SDK 에이전트에 Vela 훅이 로드되지 않음 (훅 격리)
- `permissionMode: 'bypassPermissions'` — 엔진 제어 하에 자동 실행
- 인증은 `process.env.ANTHROPIC_API_KEY` 상속

#### 비-SDK 폴백 모드

SDK가 설치되지 않은 환경(`@anthropic-ai/claude-agent-sdk` 미설치)에서는 기존 Subagent/Teammate 방식으로 자동 폴백한다:

```
PM이 Worker 소환 (Teammate 또는 Subagent)
  → Worker: 작업 수행 → 산출물 작성
  → PM이 Reviewer 소환 (Sonnet)
  → Reviewer: review-{step}.md 작성
  → PM이 approve/reject 판단
```

SDK 설치 여부는 `install.sh` 실행 시 자동 감지되며, 실패 시 경고만 출력하고 설치를 중단하지 않는다.

#### 에이전트 지시사항 (`.vela/agents/`)

- `researcher.md` (Sonnet, Subagent) — 프로젝트 분석, research.md 작성
- `planner.md` (Sonnet, Subagent) — 아키텍처 설계, plan.md 작성
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
| 설계/디버깅/분석 | **Sonnet** (에스컬레이션 시 Opus) | Researcher, Planner |

## Teammate vs Subagent 구분

**Teammate** = 에이전트 간 소통(SendMessage)이 필요한 작업.
**Subagent** = 독립적, 단일 결과물 생산. 소통 불필요.

| 조건 | 방식 | model 파라미터 |
|------|------|---------------|
| 프로젝트 분석 (리서치) | **Subagent** | `"sonnet"` |
| 다중 파일/CrossLayer 동시 수정 | **Teammate** | `"sonnet"` |
| 독립 리뷰/점검 | **Subagent** | `"sonnet"` |
| 단일 모듈 수정 | **Subagent** | `"sonnet"` |
| 파일 탐색 | **Subagent** | `"haiku"` |
| 설계/디버깅 분석 | **Subagent** | `"sonnet"` |

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

### 리서치 — 프로젝트 분석

Research 단계에서 Subagent(Sonnet)가 단독으로 프로젝트 분석을 수행한다:
요구사항 파악 → 코드베이스 탐색 → 의존성/제약 분석 → 결론.
에스컬레이션 조건 충족 시 Opus로 자동 전환 (model-strategy.md 참조).

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

## 훅 목록 (18개)

Vela는 Claude Code의 hook event에 18개의 훅을 등록한다.

| # | Hook ID | Event | 유형 | 설명 |
|---|---------|-------|------|------|
| 1 | vela-gate-keeper | PreToolUse | command | 수문장 — 파이프라인 규칙 위반 차단 |
| 2 | vela-gate-guard | PreToolUse | command | 가이드라인 — 코딩 규칙 안내 |
| 3 | vela-orchestrator | UserPromptSubmit | command | 상태 주입 — 파이프라인 컨텍스트 주입 |
| 4 | vela-tracker | PostToolUse | command | 추적기 — 도구 사용 기록 |
| 5 | vela-stop | Stop | command | 정지 제어 — auto 모드 중단 방지 |
| 6 | vela-session-start | SessionStart | command | 세션 시작 시 상태 복구 |
| 7 | vela-compact | PreCompact | command | 컴팩트 전 상태 보존 |
| 8 | vela-compact | PostCompact | command | 컴팩트 후 상태 복원 |
| 9 | vela-subagent-start | SubagentStart | command | 서브에이전트 시작 추적 |
| 10 | vela-task-completed | TaskCompleted | command | 태스크 완료 기록 |
| 11 | vela-subagent-stop | SubagentStop | command | 서브에이전트 종료 + 산출물 수확 |
| 12 | vela-permission | PermissionRequest | command | 파일 쓰기 권한 자동 승인 |
| 13 | vela-failure | PostToolUseFailure | command | 도구 실패 추적 + 연속 실패 경고 |
| 14 | vela-stop-failure | StopFailure | command | 비정상 종료 시 파이프라인 스냅샷 |
| 15 | vela-teammate-idle | TeammateIdle | command | 유휴 팀원 알림 |
| 16 | vela-review-prompt | PostToolUse | prompt | 코드 변경 자동 리뷰 |
| 17 | vela-test-async | PostToolUse | command | 관련 테스트 비동기 실행 |
| 18 | vela-notification | Notification | command | 데스크톱 알림 전송 (macOS/Linux) |

### if 조건 최적화

`PermissionRequest` 이벤트의 `vela-permission` 훅에는 `if: 'Write(*)|Edit(*)|NotebookEdit(*)'` 조건이 적용된다. Claude Code는 이 조건에 매칭되는 도구 호출에서만 훅 프로세스를 spawn하므로, Bash/Read 등 비-파일수정 도구 사용 시 불필요한 프로세스 생성이 방지된다.

### Notification Hook (vela-notification)

`Notification` 이벤트 수신 시 OS 네이티브 데스크톱 알림을 전송한다:
- **macOS**: `osascript display notification`
- **Linux**: `notify-send` (freedesktop.org)
- **기타 플랫폼**: silent no-op

알림 실패는 항상 무시되며 exit code에 영향을 주지 않는다. 자체 완결형 훅으로 pipeline.js나 config 의존성 없음.

---

## 상세 레퍼런스

Gate Keeper/Guard 규칙, CLI 명령어, TreeNode 캐시 상세는 `references/` 디렉토리를 참조한다:
- `references/gates-and-guards.md` — 전체 게이트/가드 규칙 목록
- `references/cli-reference.md` — CLI 명령어 전체 레퍼런스
