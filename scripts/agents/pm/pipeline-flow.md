# 파이프라인 운영 흐름 — V6: Agent 도구 기반 직접 오케스트레이션

**핵심: PM이 `vela-engine.js`(상태 관리)와 Agent 도구(에이전트 소환)를 직접 사용한다. `vela-pipeline.js`는 V6에서 제거되었다.**

## 사전 조건 — 반드시 프로젝트 루트에서 호출

아래 모든 `node .vela/cli/vela-engine.js ...` 호출은 CWD 상대 경로다.
Claude Code 세션은 서브 디렉토리에서 열릴 수 있으므로, 엔진을 호출하기 전에
PM이 **walk-up으로 `.vela/`가 있는 프로젝트 루트로 cd** 되어 있어야 한다.

자세한 절차는 `agents/vela.md` → "세션 시작 필수 동작" 참조. 요약:
```bash
d="$(pwd)"; while [ "$d" != "/" ] && [ ! -d "$d/.vela" ]; do d="$(dirname "$d")"; done
[ -d "$d/.vela" ] && cd "$d"
```

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

모든 파이프라인은 `locate` 단계를 공통으로 갖는다 (v6.1 Universal Locate — LLM 0, 결정론적).

| 슬래시 명령 | pipeline_type | 단계 흐름 |
|---|---|---|
| `/vela:fix` **(v7.0 기본 추천)** | surgical | init → **locate** → research(targeted) → **spec** → **patch** → verify → commit → finalize |
| `/vela:small` | trivial | init → **locate** → execute → commit → finalize |
| `/vela:medium` | quick | init → **locate** → plan → execute → verify → commit → finalize |
| `/vela:large` | standard | init → **locate** → research → plan → plan-check → checkpoint → branch → execute → verify → diff-summary → learning → commit → finalize |
| `/vela:ralph` | ralph | init → **locate** → execute ↔ verify (최대 10회) → commit → finalize |
| `/vela:hotfix` | hotfix | init → **locate** → execute → commit |

**v7.0 surgical (`/vela:fix`)이 일상 작업의 기본 추천**이다. research(targeted)로 좁은 범위 분석 후 spec 단계에서 결정론적 patch 명세를 작성하고, patch 단계에서 정확히 그 명세만 적용한다. verifier가 out-of-scope 위반을 catch하므로 scope creep이 구조적으로 차단된다.

---

## v7.2 Phase B — 병렬화 & 격리 패턴

**단일 메시지에 여러 Agent() 호출**을 담으면 Claude Code는 병렬로 실행한다. 아래 네 패턴은 config에 따라 켜지며, 기본값(`config.execution.parallelism: false`)은 V7 직렬 동작과 동일하다.

### 1. Research 3관점 병렬 spawn (M5)
`research` 단계에서 PM은 architecture/security/quality 관점을 **병렬 3개 Agent()** 로 소환한 후 `vela-researcher-merge` 에이전트(Haiku 권장)가 결과를 `research.md` 하나로 통합한다.
- 각 관점 에이전트 출력: `research-{perspective}.md`
- 머지 결과: `research.md` (exit_gate가 검증하는 정식 산출물)

### 2. Reviewer + Verifier 병렬 (M4)
`execute` 이후 단일 메시지에 Agent(reviewer) + Agent(verifier) 2개를 동시 호출. 둘 다 APPROVE/PASS면 `node .vela/cli/vela-engine.js transition --through verify`로 두 단계를 한 번에 넘긴다.
- reviewer REJECT: verifier 결과와 무관하게 executor 재호출
- verifier FAIL: reviewer 결과와 무관하게 executor 재호출 (ralph 모드라면 loop 카운터 증가)
- `transition --through verify`는 execute의 exit_gate와 verify의 exit_gate를 **둘 다** 통과해야 성공

### 3. Executor Worktree Isolation (M6) — opt-in
`config.execution.isolation: "worktree"`일 때만 활성. `execute`/`patch` 단계에서 `Agent(subagent_type="vela-executor", isolation="worktree", ...)`로 호출한다.
- worktree 경로: `.vela/worktrees/{slug}/`
- 실패 시 main working tree 무변경 — `commit` 단계에서 worktree → 현재 브랜치 병합
- 기본값은 `"inline"`(V7 동작 유지)

### 4. Learning + Diff-summary 백그라운드 (M7)
두 단계 모두 non-fatal이므로 `run_in_background: true`로 호출한 후 파이프라인은 즉시 `commit`으로 진행한다. `finalize`에서 TaskList로 상태를 점검하고 미완료면 `report.md`에 "deferred" 표기.

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

**직렬 모드 (기본, `config.execution.parallelism != true`)**:
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

**병렬 3관점 모드 (v7.2 M5, `config.execution.parallelism: true`)**:
```
# 단일 메시지에 3개 Agent() 병렬 호출
Agent(subagent_type="vela-researcher", prompt={..., perspective:"architecture"})
Agent(subagent_type="vela-researcher", prompt={..., perspective:"security"})
Agent(subagent_type="vela-researcher", prompt={..., perspective:"quality"})
→ 각각 research-{perspective}.md 생성
→ Agent(subagent_type="vela-researcher-merge", prompt={
    artifactDir,
    inputs:["research-architecture.md","research-security.md","research-quality.md"]
  })
→ research.md 생성 (exit_gate 검증 대상)
→ Agent(subagent_type="vela-reviewer", prompt={step:"research", artifactDir})
→ record + transition
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

**직렬 모드 (기본)**:
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

**병렬 reviewer+verifier 모드 (v7.2 M4, `config.execution.parallelism: true`)**:
```
# executor 완료 후
Agent(subagent_type="vela-executor", prompt={..., [isolation:"worktree" if M6]})
→ # 단일 메시지에 두 개 병렬 호출:
  Agent(subagent_type="vela-reviewer", prompt={step:"execute", artifactDir})
  Agent(subagent_type="vela-verifier", prompt={artifactDir, projectEnv, ...})
→ 둘 다 통과:
  node .vela/cli/vela-engine.js advance pass        # execute 단계
  node .vela/cli/vela-engine.js advance pass        # verify 단계 (exit_gate 이미 PASS)
→ 어느 하나라도 실패: REJECT 측을 executor에게 reviewFeedback으로 주입 후 재호출
```

**Worktree isolation (v7.2 M6, `config.execution.isolation: "worktree"`)**:
- executor Agent()에 `isolation: "worktree"` 추가
- executor 실패/취소 시 main working tree 무변경
- `commit` 단계가 worktree 변경사항을 현재 브랜치로 병합 후 worktree 정리

### spec (v7.0 surgical 파이프라인 전용)

```
Agent(subagent_type="vela-planner", prompt={
  request, artifactDir,
  mode: "spec",                                ← plan 모드 대신 spec 분기
  targetsPath: "{artifactDir}/targets.json",   ← 필수 (primary 파일이 spec 범위)
  researchPath: "{artifactDir}/research.md"    ← 필수 (caller/pattern/risk 컨텍스트)
})
→ Agent(subagent_type="vela-reviewer", prompt={step:"spec", artifactDir, targetPath:"patch-spec.md"})
→ APPROVE: record pass → transition
→ REJECT: review-spec.md의 CRITICAL을 planner(mode:spec)에 재주입 → 재시도 (max_revisions=3)
```

특이사항:
- `patch-spec.md`는 **`## Before`, `## After`, `## Explicitly out of scope` 세 섹션 필수** (engine의 `patch_spec_complete` exit gate가 검증)
- targets confidence가 `low`이면 spec은 의미 없음 — PM이 `/vela:large` exploratory로 에스컬레이션 제안
- planner가 `mode: spec`으로 호출되면 기존 plan.md 대신 patch-spec.md를 작성한다 (두 파일 동시 작성 금지)

### patch (v7.0 surgical 파이프라인 전용)

```
Agent(subagent_type="vela-executor", prompt={
  request, artifactDir,
  targetsPath: "{artifactDir}/targets.json",   ← primary[]만 수정 허용
  specPath: "{artifactDir}/patch-spec.md",     ← plan.md 대신 spec을 권위 source로 사용
  [reviewFeedback]
})
→ Agent(subagent_type="vela-reviewer", prompt={step:"patch", artifactDir})
→ APPROVE: record pass → transition
→ REJECT: review-patch.md의 이슈를 reviewFeedback으로 주입 → executor 재호출 (max_revisions=5)
```

특이사항:
- executor는 `specPath`가 주입되면 patch-spec.md의 `Before/After` 섹션에 명시된 변경만 수행한다
- `Explicitly out of scope`에 있는 파일은 *읽기*는 가능하지만 *쓰기*는 금지
- `targets.primary[]` 외 파일 수정 시 verifier의 Phase 4.5 out-of-scope 검사에서 FAIL
- `implementation_complete` exit gate는 `approval-patch.json`을 동적으로 해석 (engine v7.0 generalization)

### verify

```
Agent(subagent_type="vela-verifier", prompt={artifactDir, projectEnv,
  targetsPath: "{artifactDir}/targets.json",     ← v6.1
  specPath: "{artifactDir}/patch-spec.md"        ← v7.0 surgical 전용, 그 외 생략
})
→ verification.md 읽어 PASS/FAIL 확인
→ PASS: record pass → transition
→ FAIL: 실패 내용을 executor에게 주입 → execute 재시도 (ralph 모드: 최대 10회)
```

### diff-summary (standard 파이프라인만)

**직렬 모드 (기본)**:
```
Agent(subagent_type="vela-diff-summary", prompt={artifactDir, branchName, baseBranch})
→ non-fatal: 실패해도 경고만 남기고 진행
→ transition
```

**백그라운드 모드 (v7.2 M7, `config.execution.background_post_steps: true`)**:
```
Agent(subagent_type="vela-diff-summary", run_in_background:true, prompt={...})
→ 즉시 transition (에이전트는 뒤에서 계속)
→ finalize 단계에서 TaskList로 상태 점검 (미완료면 report.md에 "deferred: diff-summary")
```

### learning (standard 파이프라인만)

**직렬 모드 (기본)**:
```
Agent(subagent_type="vela-learning", prompt={artifactDir, request, pipelineType})
→ non-fatal: 실패해도 경고만 남기고 진행
→ transition
```

**백그라운드 모드 (v7.2 M7, `config.execution.background_post_steps: true`)**:
```
Agent(subagent_type="vela-learning", run_in_background:true, prompt={...})
→ 즉시 transition
→ finalize 단계에서 TaskList로 상태 점검
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
