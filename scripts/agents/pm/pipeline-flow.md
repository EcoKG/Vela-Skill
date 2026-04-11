# 파이프라인 운영 흐름 — V6: Agent 도구 기반 직접 오케스트레이션

**핵심: PM이 `vela-engine.js`(상태 관리)와 Agent 도구(에이전트 소환)를 직접 사용한다. `vela-pipeline.js`는 V6에서 제거되었다.**

## 새 파이프라인 시작

```bash
# 자동 scale 감지 (요청 길이 기반)
node .vela/cli/vela-engine.js init "요청"

# 수동 scale 지정
node .vela/cli/vela-engine.js init "요청" --scale hotfix
node .vela/cli/vela-engine.js init "요청" --scale ralph
node .vela/cli/vela-engine.js init "요청" --scale large
```

## 현재 상태 확인

```bash
node .vela/cli/vela-engine.js state
```

`current_step`, `artifactDir`, `pipeline_type`, `request` 필드를 파악한다.

---

## 파이프라인 티어 — 작업 규모별

모든 scale은 `locate` 단계를 공통으로 갖는다 (v6.1 Universal Locate — LLM 0, 결정론적).

| 요청 규모 | scale | pipeline_type | 단계 흐름 |
|-----------|-------|---------------|-----------|
| ≤ 10 단어 | small | trivial | init → **locate** → execute → commit → finalize |
| 11~30 단어 | medium | quick | init → **locate** → plan → execute → verify → commit → finalize |
| > 30 단어 | large | standard | init → **locate** → research → plan → plan-check → checkpoint → branch → execute → verify → diff-summary → learning → commit → finalize |
| --scale ralph | ralph | ralph | init → **locate** → execute ↔ verify (최대 10회) → commit → finalize |
| --scale hotfix | hotfix | hotfix | init → **locate** → execute → commit |

---

## 단계별 Agent 소환 패턴

각 단계에서 PM은 해당 역할의 에이전트를 Agent 도구로 소환한다.

### locate (v6.1 — 모든 scale 공통, LLM 0)

```bash
node .vela/cli/vela-engine.js locate
```

- LLM 호출 없음. ripgrep/git grep + git ls-files 기반.
- `{artifactDir}/targets.json` 생성 (primary / tests / blast_radius / confidence / tokens_extracted).
- **confidence 해석**:
  - `high` → `project_mode: targeted`로 다음 단계 진행, primary 파일만 분석 범위
  - `medium` → AskUserQuestion으로 primary 리스트 확인 후 진행
  - `low` + 토큰 비어있음 → AskUserQuestion으로 파일/함수 명시 요청 (프롬프트 모호)
  - `low` + 매칭 너무 넓음 → `project_mode: exploratory`로 폴백
  - `low` + 매칭 0 → bootstrap (신규 프로젝트) 가능성 — `project_mode: bootstrap`
- targets.json은 research/plan/execute의 필수 input — `targetsPath`로 모든 후속 에이전트에 전달된다.

### research

```
Agent(subagent_type="vela-researcher", prompt={
  request, artifactDir,
  targetsPath: "{artifactDir}/targets.json",   ← v6.1
  project_mode: "targeted" | "exploratory" | "bootstrap",   ← locate confidence 기반
  projectEnv
})
→ Agent(subagent_type="vela-reviewer", prompt={step:"research", artifactDir, targetPath})
→ 리뷰 판정 확인 (APPROVE: 점수 20+/25 && CRITICAL 0)
→ node .vela/cli/vela-engine.js record pass (또는 reject)
→ node .vela/cli/vela-engine.js transition
```

REJECT 시: `review-research.md`의 피드백을 추출하여 researcher 재호출 (최대 `max_revisions`회)

### plan

```
Agent(subagent_type="vela-planner", prompt={
  request, artifactDir,
  targetsPath: "{artifactDir}/targets.json",   ← v6.1
  researchPath: "{artifactDir}/research.md"    ← research 단계 없는 scale에서는 생략
})
→ Agent(subagent_type="vela-reviewer", prompt={step:"plan", artifactDir, targetPath})
→ record + transition (REJECT 시 피드백 포함 재호출)
```

### plan-check

```
Agent(subagent_type="vela-plan-checker", prompt={artifactDir, planPath})
→ plan-check.md 읽어 PASS/FAIL 확인
→ PASS: record pass → transition
→ FAIL: plan-check.md의 실패 이유를 planner에게 전달 → plan 재작성 → plan-check 재실행
```

### checkpoint

```
plan.md 요약 작성
→ AskUserQuestion으로 사용자에게 승인 요청
→ 승인: record pass → transition
→ 거절: 수정 의견 수집 → planner에게 전달 → plan 재작성
```

### branch

```
node .vela/cli/vela-engine.js branch
→ vela/{slug} 브랜치 자동 생성
→ transition (branch 완료 후 자동)
```

### execute

```
Agent(subagent_type="vela-executor", prompt={
  request, artifactDir,
  targetsPath: "{artifactDir}/targets.json",   ← v6.1 (허용된 수정 범위 정의)
  planPath: "{artifactDir}/plan.md",           ← plan 단계 없는 scale에서는 생략
  [reviewFeedback]
})
→ Agent(subagent_type="vela-reviewer", prompt={step:"execute", artifactDir})
→ APPROVE: record pass → transition
→ REJECT: review-execute.md의 CRITICAL/HIGH를 reviewFeedback으로 추출 → executor 재호출
→ max_revisions(5) 소진 시 AskUserQuestion
```

### verify

```
Agent(subagent_type="vela-verifier", prompt={artifactDir, projectEnv})
→ verification.md 읽어 PASS/FAIL 확인
→ PASS: record pass → transition
→ FAIL: 실패 내용을 executor에게 주입 → execute 재시도 (ralph 모드: 최대 10회)
```

### diff-summary (standard 파이프라인만)

```
Agent(subagent_type="vela-diff-summary", prompt={artifactDir, branchName, baseBranch})
→ non-fatal: 실패해도 경고만 남기고 진행
→ transition
```

### learning (standard 파이프라인만)

```
Agent(subagent_type="vela-learning", prompt={artifactDir, request, pipelineType})
→ non-fatal: 실패해도 경고만 남기고 진행
→ transition
```

### commit

```
node .vela/cli/vela-engine.js commit
→ Conventional Commits 자동 커밋 (feat/fix/refactor/docs)
→ transition
```

### finalize

```
{artifactDir}/report.md 작성 (파이프라인 요약)
→ PR 생성 여부 사용자에게 AskUserQuestion
→ record pass → 파이프라인 완료
```

---

## PM 승인 기준

- **APPROVE**: Reviewer 점수 20+/25, CRITICAL 0개
- **REJECT**: CRITICAL 존재 또는 점수 19 이하

## 퍼미션 모드 감지 + 안내

파이프라인 시작 시 반복 승인 프롬프트가 발생하면:
- Vela는 `settings.local.json`에 `Read(*)`, `Glob(*)`, `Grep(*)` allow 규칙을 자동 등록함을 안내한다
- `claude --dangerously-skip-permissions` 또는 `/permissions`로 세션 내 설정 변경 안내
- advisory 전용 — 프로그래밍 방식으로 변경 불가

## UI 템플릿

모든 AskUserQuestion은 `.vela/references/interactive-ui.md`에서 읽어라.
