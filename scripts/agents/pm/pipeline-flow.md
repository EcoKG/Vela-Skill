# Pipeline Flow — v8.0 (6단계)

v7.3-M3에서 standard 13단계 → ship 6단계로 축소. plan-check/checkpoint/branch/diff-summary/learning/finalize가 삭제되거나 인접 단계로 흡수됨.

## 6단계 (ship 파이프라인)

```
init → locate → plan → execute → verify → commit
```

### init (엔진 자동)
- `.vela/artifacts/{YYYYMMDD}T{HHmmss}-{slug}/` 아티팩트 디렉토리 생성
- `meta.json` 작성
- `vela/{slug}` 브랜치 자동 생성 (구 branch 단계 흡수)
- exit_gate: `artifact_dir_created`, `mode_detected`, `git_clean`

### locate (LLM 0)
- `node .vela/cli/vela-engine.js locate`
- ripgrep + git grep + git ls-files 결정론적 좌표 식별
- `targets.json` 생성: `primary[]`, `tests[]`, `blast_radius[]`, `confidence`, `tokens_extracted[]`
- confidence 해석:
  - `high` → 자동 transition, planner에 `project_mode: targeted` 주입
  - `medium` → AskUserQuestion으로 primary 확인
  - `low` → tokens 빈: 명시 요청 / 매칭 과다: exploratory / 매칭 0: bootstrap
- exit_gate: `targets_json_exists`

### plan (v8.0 통합 — research + plan + self-check)
```
Agent(subagent_type="vela-planner", prompt={
  request, artifactDir, mode: "plan",
  targetsPath, project_mode, projectEnv
})
→ Agent(subagent_type="vela-reviewer", prompt={mode: "review", step: "plan", targetPath: "plan.md"})
→ [REVIEW GATE] Stop hook이 재검증 라운드 관리
  - block: reviewer 재호출
  - REJECT: review-plan.md 피드백 주입 → planner 재호출 (max_revisions=3)
→ record pass → transition
```

planner가 직접 파일 Read로 research 흡수, `## Self-Check` 섹션으로 plan-checker 흡수.

exit_gate: `plan_md_exists`, `plan_architecture_complete`, `approval_exists`

### execute
```
Agent(subagent_type="vela-executor", prompt={
  request, artifactDir, targetsPath,
  planPath: "plan.md"   ← fix 파이프라인이면 "patch-spec.md"
})
→ Agent(subagent_type="vela-reviewer", prompt={mode: "review", step: "execute"})
→ APPROVE: [REVIEW GATE] 재검증 루프
→ REJECT: reviewFeedback 주입 → executor 재호출 (max_revisions=5)
→ record pass → transition
```

TDD sub-phases: test-write → implement → refactor

exit_gate: `implementation_complete`, `review_exists`, `ref_integrity`

### verify (구 verifier + diff-summary 흡수)
```
Agent(subagent_type="vela-reviewer", prompt={
  mode: "verify",
  artifactDir, projectEnv,
  specPath: "patch-spec.md"   ← fix 파이프라인 전용, 그 외 생략
})
```
reviewer가 verify 모드에서 직접 수행:
- Phase 1: 테스트 실행 (`npm test`, `pytest`, `go test ./...` 등)
- Phase 2: 린트 + 타입체크
- Phase 3: out-of-scope 검사 (fix 파이프라인)
- Phase 4: diff 요약 (`git diff --stat`). >500 LOC 시 `/ultrareview` 에스컬레이션 마커

→ PASS: verification.md + approval-verify.json 작성 → record pass → transition
→ FAIL: 실패 로그를 executor에 주입 → execute 재시도

exit_gate: `verification_md_exists`, `ref_integrity`

### commit (구 branch + finalize 흡수)
```bash
node .vela/cli/vela-engine.js commit
```
- Conventional Commits 자동 생성
- `git diff --stat` 요약을 커밋 바디에 포함 (구 diff-summary 역할)
- PR 생성 여부 사용자 확인 (선택)
- 파이프라인 종료

exit_gate: `changes_committed`

---

## 파이프라인 변종

### fix (surgical, 작은 diff)
ship과 동일한 6단계. 차이점만:
- `plan` 단계에서 planner가 `mode: spec`으로 호출됨 → `patch-spec.md` 작성 (plan.md 대신)
- `execute` 단계에서 executor가 `patch-spec.md`의 Before/After만 적용, Explicitly out of scope 영역 수정 금지
- `verify` Phase 3에서 out-of-scope 위반 검사 활성화

### hotfix (minimal)
4단계: `init → locate → execute → commit`. plan과 verify 생략. 문서/config 수정 전용.

---

## v7.2 Phase B 병렬화 패턴 (선택)

`config.execution.parallelism: true`일 때만 활성. v8.0에서도 유지:

1. **Research 3관점 병렬 spawn** — `vela-researcher`를 architecture/security/quality 3개 병렬로 호출 후 `mode=merge`로 통합. plan 단계 내부에서 planner가 선행 호출.
2. **Reviewer+Verifier 병렬** — v8.0에서 둘이 하나의 에이전트(reviewer)가 되어 자연스럽게 통합됨.
3. **Executor Worktree Isolation** (M6 opt-in) — `config.execution.isolation: "worktree"`.

---

## 이관 참고

이전 13단계 오케스트레이션 로직(plan-check/checkpoint/diff-summary/learning/finalize 단계)은 git history에서 확인 가능. v7.3-M3 이전 파이프라인 이력.
