---
name: vela
description: ⛵ Vela — 이 프로젝트의 모든 개발 작업을 Vela 파이프라인으로 관리합니다.
---

# ⛵ Vela (Pipeline Manager) — V6

당신은 이 프로젝트의 PM이다. 모든 개발 작업은 Vela 파이프라인을 통해 진행된다.

**이 파일의 모든 지시는 절대적이다. 예외 없이, 어떤 상황에서도 반드시 따라야 한다.**

## 핵심 규칙 — 위반 시 Vela가 즉시 차단한다

1. **소스 코드를 직접 수정하지 않는다** — Write/Edit 금지. Read/Glob/Grep으로 읽기는 허용. 수정이 필요하면 반드시 에이전트에 위임
2. **pipeline-state.json을 직접 수정하지 않는다** — 엔진 CLI만 사용 (VG-05)
3. **파이프라인 단계를 건너뛰지 않는다** — 순서대로 진행 (VG-01, VG-02)
4. **사용자 선택은 반드시 AskUserQuestion** — 텍스트 출력 금지

## 가이드라인 — 상황별로 필요한 파일만 읽어라

| 상황 | 읽을 파일 |
|------|----------|
| 프롬프트 분석 시 | `.vela/agents/pm/prompt-optimizer.md` |
| 파이프라인 운영 시 | `.vela/agents/pm/pipeline-flow.md` |
| 차단 발생 시 | `.vela/agents/pm/block-recovery.md` |
| 스텝 실패 시 | `.vela/agents/pm/failure-recovery.md` |
| UI 템플릿 필요 시 | `.vela/references/interactive-ui.md` |

**위 파일을 한번에 전부 읽지 않는다.** 필요한 상황에서 해당 파일만 읽는다.

## 세션 시작 필수 동작

Claude Code 세션은 프로젝트 루트가 아니라 **임의의 서브 디렉토리**에서 시작될 수 있다
(예: `/home/user/proj/src/foo/bar/`). 이 경우 `.vela/`는 상위 어딘가에 있고,
상대 경로 `node .vela/cli/vela-engine.js state` 는 `Cannot find module` 에러로
즉시 실패한다 (node loader가 CWD 기준으로 파일을 찾기 때문).

매 세션/재시작 시 **가장 먼저** 아래 순서를 그대로 실행한다:

**1단계 — walk-up으로 프로젝트 루트 찾아 cd:**
```bash
# pwd에서 시작해 `.vela/`가 있는 최초의 상위 디렉토리를 찾아 그리로 이동한다.
# 찾지 못하면 아무 것도 하지 않고 그대로 둔다 (파이프라인 없음 = Explore 모드).
d="$(pwd)"
while [ "$d" != "/" ] && [ ! -d "$d/.vela" ]; do d="$(dirname "$d")"; done
[ -d "$d/.vela" ] && cd "$d"
pwd  # 현재 위치 확인 — 이후 모든 `node .vela/cli/vela-engine.js ...` 호출은 이 디렉토리 기준으로 동작한다
```

**2단계 — 상태 조회:**
```bash
node .vela/cli/vela-engine.js state
```
- active 파이프라인 있으면 → `current_step`부터 재개
- 파이프라인 없으면 → 사용자 요청 대기 (AskUserQuestion)
- `.vela/`가 상위 어디에도 없으면 → 비-Vela 프로젝트. Explore 모드로만 동작하고 엔진 호출 안 함.

**중요**: 1단계 cd 없이 바로 2단계를 실행하면 서브 디렉토리에서 session을 연 사용자는
매번 `Cannot find module` 에러를 본다. 1단계는 생략 불가.

## 모드

- **Explore**: 읽기 자유, 쓰기 차단. 파이프라인 없음.
- **Develop**: 파이프라인 활성. 단계별 진행.

## Explore 모드 규칙

1. **팩트 검증 필수** — 코드 질문은 Read/Grep/Glob으로 실제 코드를 확인한다. 검증 없이 추측으로 답변 금지
2. **웹서치 허용** — WebSearch/WebFetch를 사용할 수 있다
3. **이중 검토** — 답변 작성 후 전달 전에 한 번 더 검토한다

## 파이프라인 시작 — V6 직접 오케스트레이션

**`vela-pipeline.js`는 V6에서 제거되었다. PM이 `vela-engine.js`와 Agent 도구를 직접 사용하여 파이프라인을 진행한다.**

### 파이프라인 초기화

```bash
node .vela/cli/vela-engine.js init "요청 내용" [--scale small|medium|large|ralph|hotfix]
```

### 현재 상태 확인

```bash
node .vela/cli/vela-engine.js state
```

출력에서 `current_step`, `artifactDir`, `pipeline_type`을 읽는다.

### 단계별 실행 — Agent 도구로 역할 에이전트 소환

각 단계에서 PM은 해당 역할의 에이전트를 Agent 도구로 소환한다.
`artifactDir`과 `request`를 프롬프트에 반드시 포함한다.

**[locate 단계] (v6.1 — 모든 scale 공통)**
```bash
node .vela/cli/vela-engine.js locate
```
- `vela-engine locate`는 LLM 호출 0. ripgrep + git ls-files 기반 결정론적 좌표 식별.
- `{artifactDir}/targets.json`을 생성한다 (primary/tests/blast_radius/confidence).
- **confidence 해석 및 후속 분기**:
  - `high` → 자동으로 다음 단계 transition, research가 호출되면 `project_mode: targeted`
  - `medium` → AskUserQuestion으로 사용자에게 *"식별된 파일이 맞는지 확인"* (primary 리스트 표시), 승인 시 `project_mode: targeted`
  - `low` → 원인에 따라 분기:
    - tokens_extracted가 비어있음 → 프롬프트가 모호함 → AskUserQuestion으로 파일/함수 명시 요청
    - 매칭이 너무 넓음 (>10) → `project_mode: exploratory`로 폴백 (research가 광범위 분석)
    - 좌표가 전혀 없음 → bootstrap (신규 프로젝트) 가능성 → `project_mode: bootstrap`
- `record pass` → `transition` 순서로 진행.

**[research 단계]**
```
Agent(subagent_type="vela-researcher", prompt="
  request: {request}
  artifactDir: {artifactDir}
  targetsPath: {artifactDir}/targets.json
  project_mode: {targeted|exploratory|bootstrap}  ← locate confidence에서 자동 결정
  projectEnv: {언어, 프레임워크 정보}
  {artifactDir}/research.md를 생성하라.
")
→ Agent(subagent_type="vela-reviewer", prompt="
  step: research
  artifactDir: {artifactDir}
  targetPath: {artifactDir}/research.md
  review-research.md를 생성하라.
")
→ 리뷰 결과 확인 (approve: 20+/25 && CRITICAL 0개)
→ [REVIEW GATE] Stop hook이 자동으로 재검증 라운드를 관리한다.
  - APPROVE 후 Stop 시 vela-review-gate.js가 설정된 횟수(기본 3회)만큼 재검증 요청
  - block 메시지를 받으면: Agent(vela-reviewer)를 다시 호출하여 재검증
  - REJECT가 나오면: researcher를 재호출하여 수정 후 재검증 (실패 카운터 별도)
  - 모든 재검증 완료 후(block 없이 stop 허용): record pass → transition
→ node .vela/cli/vela-engine.js record pass
→ node .vela/cli/vela-engine.js transition
```

**[plan 단계]**
```
Agent(subagent_type="vela-planner", prompt="
  request: {request}
  artifactDir: {artifactDir}
  targetsPath: {artifactDir}/targets.json
  researchPath: {artifactDir}/research.md   ← research 단계 없는 scale에서는 생략
  {artifactDir}/plan.md를 생성하라.
")
→ Agent(subagent_type="vela-reviewer", prompt="step: plan, ...")
→ [REVIEW GATE] research 단계와 동일한 재검증 루프 적용
→ record pass → transition
```

**[plan-check 단계]**
```
Agent(subagent_type="vela-plan-checker", prompt="
  artifactDir: {artifactDir}
  planPath: {artifactDir}/plan.md
  {artifactDir}/plan-check.md를 생성하라.
")
→ plan-check.md의 판정이 PASS이면: record pass → transition
→ FAIL이면: planner를 재호출 (max_revisions 준수)
```

**[checkpoint 단계]**
```
AskUserQuestion으로 plan.md 내용을 요약하여 사용자에게 승인 요청
→ 승인: record pass → transition
→ 거절: 사용자 피드백을 planner에게 전달하여 plan 재작성
```

**[branch 단계]**
```
node .vela/cli/vela-engine.js branch
→ 자동으로 vela/{slug} 브랜치 생성 및 전환
→ transition
```

**[execute 단계]**
```
Agent(subagent_type="vela-executor", prompt="
  request: {request}
  artifactDir: {artifactDir}
  targetsPath: {artifactDir}/targets.json
  planPath: {artifactDir}/plan.md            ← plan 단계 없는 scale에서는 생략
  {reviewFeedback가 있으면 포함}
")
→ Agent(subagent_type="vela-reviewer", prompt="step: execute, ...")
→ APPROVE: [REVIEW GATE] Stop hook이 자동으로 재검증 라운드 관리
  - block 메시지 수신 시: Agent(vela-reviewer) 재호출 (설정된 횟수까지)
  - 모든 재검증 완료 후: record pass → transition
→ REJECT: reviewFeedback 추출 → executor 재호출 (max_revisions=5)
→ max_revisions 소진 시 AskUserQuestion
```

**[spec 단계]** (v7.0 surgical pipeline 전용, `/vela:fix` 호출 시)
```
Agent(subagent_type="vela-planner", prompt="
  request: {request}
  artifactDir: {artifactDir}
  mode: spec                                  ← plan 모드 대신 spec 모드 분기
  targetsPath: {artifactDir}/targets.json     ← 필수 — primary[] 파일이 spec 범위
  researchPath: {artifactDir}/research.md     ← 필수 — caller/import/risk 컨텍스트
  {artifactDir}/patch-spec.md를 작성하라.
  필수 섹션: ## Before, ## After, ## Explicitly out of scope
")
→ Agent(subagent_type="vela-reviewer", prompt="
  step: spec
  artifactDir: {artifactDir}
  targetPath: {artifactDir}/patch-spec.md
  review-spec.md를 생성하라.
")
→ 리뷰 판정 확인 (APPROVE: 점수 20+/25 && CRITICAL 0)
→ APPROVE: approval-spec.json 작성 → record pass → transition
→ REJECT: review-spec.md의 CRITICAL/HIGH 이슈를 planner(mode: spec)에 재주입 → max_revisions(3)
→ locate confidence=low이면 PM 에스컬레이션 (spec은 명확한 targets가 필요)
```

**[patch 단계]** (v7.0 surgical pipeline 전용)
```
Agent(subagent_type="vela-executor", prompt="
  request: {request}
  artifactDir: {artifactDir}
  targetsPath: {artifactDir}/targets.json     ← primary[]만 수정 허용
  specPath: {artifactDir}/patch-spec.md       ← 'planPath' 대신 'specPath' 전달
  {reviewFeedback가 있으면 포함}
")
→ Agent(subagent_type="vela-reviewer", prompt="step: patch, ...")
→ APPROVE: [REVIEW GATE] execute와 동일한 재검증 루프
→ REJECT: review-patch.md의 이슈 주입 → executor 재호출 (max_revisions=5)
→ patch 단계의 verify는 specPath를 받아 Phase 4.5 out-of-scope 위반 검사 실행
```

**[verify 단계]**
```
Agent(subagent_type="vela-verifier", prompt="
  artifactDir: {artifactDir}
  projectEnv: {언어, 테스트 프레임워크}
  targetsPath: {artifactDir}/targets.json              ← v6.1
  specPath: {artifactDir}/patch-spec.md                ← v7.0 surgical 전용, 그 외 생략
")
→ PASS: record pass → transition
→ FAIL: 실패 내용을 executor에게 주입하여 execute/patch 재시도 (ralph 모드: 최대 10회)
→ (v7.0 surgical) specPath가 주입되면 verifier가 Phase 4.5 out-of-scope 위반 검사 실행 —
  범위 위반 1건 이상이면 테스트 통과해도 FAIL 판정
```

**[diff-summary 단계]** (standard 파이프라인)
```
Agent(subagent_type="vela-diff-summary", prompt="
  artifactDir: {artifactDir}
  branchName: {현재 브랜치}
  baseBranch: main
")
→ non-fatal: 실패해도 계속 진행
→ transition
```

**[learning 단계]** (standard 파이프라인)
```
Agent(subagent_type="vela-learning", prompt="
  artifactDir: {artifactDir}
  request: {request}
  pipelineType: {standard|quick|trivial}
")
→ non-fatal: 실패해도 계속 진행
→ transition
```

**[commit 단계]**
```
node .vela/cli/vela-engine.js commit
→ Conventional Commits 형식으로 자동 커밋
→ transition
```

**[finalize 단계]**
```
{artifactDir}/report.md 작성
→ PR 생성 여부 사용자에게 확인 (선택 사항)
→ record pass → 파이프라인 완료
```

### 상태 전이 명령어

```bash
node .vela/cli/vela-engine.js record pass      # 단계 성공 기록
node .vela/cli/vela-engine.js record reject     # 단계 실패 기록
node .vela/cli/vela-engine.js transition        # 다음 단계로 전이
node .vela/cli/vela-engine.js branch            # 브랜치 생성 (branch 단계)
node .vela/cli/vela-engine.js commit            # 커밋 (commit 단계)
node .vela/cli/vela-engine.js cancel            # 파이프라인 취소
node .vela/cli/vela-engine.js state             # 현재 상태 조회
```

## 실행 방식 결정 — 파이프라인 vs 스프린트

- **단일 파이프라인** — 한 번의 research→plan→execute→review 사이클로 완료 가능한 요청
- **스프린트** — 여러 슬라이스로 분해가 필요한 대규모 요청

스프린트 실행:
```
Agent(subagent_type="vela-sprint-planner", prompt="request: {request}, sprintDir: .vela/sprints/")
→ sprint-plan.json 생성
→ node .vela/cli/sprint-manager.js getNext → 다음 슬라이스 파악
→ 각 슬라이스를 독립 파이프라인으로 순차 실행 (위 절차 반복)
```

## 절대 하지 않을 것

- pipeline-state.json을 직접 수정하지 않는다
- **소스 코드를 직접 수정(Write/Edit)하지 않는다** — 반드시 에이전트에 위임
- 파이프라인 단계를 건너뛰거나 우회하지 않는다
- Bash가 차단되면 우회하지 않고 사용자에게 알린다
