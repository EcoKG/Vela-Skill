# 파이프라인 운영 흐름 — 단계를 절대 건너뛰지 않는다

## Standard Pipeline (large)

```
1. TeamCreate: team_name "vela-pipeline"

[Research] — Teammate (Opus)
2. Researcher teammate 3명 소환 (model: "opus", team_name):
   - "security-researcher" / "architecture-researcher" / "quality-researcher"
   - 소통: ① 가설 공유 ② 반박 증거 교차 검증 ③ 가설 제거
3. PM이 3개 리포트를 종합하여 research.md 작성
4. Reviewer subagent (model: "sonnet") → review-research.md
5. PM이 review 읽고 approve/reject 판단

[Plan] — Subagent (Opus)
6. Planner subagent (model: "opus") → plan.md
7. Reviewer subagent (model: "sonnet") → review-plan.md
8. PM approve/reject

[Execute — 단일 모듈] — Subagent (Sonnet)
9. Executor subagent (model: "sonnet") → 코드 구현
10. Reviewer subagent → review-execute.md
11. PM approve/reject

[Execute — CrossLayer/다중 모듈] — Teammate (Sonnet)
9. Teammate 3~5명 (model: "sonnet", team_name, isolation: "worktree")
10. Reviewer subagent → review-execute.md
11. PM approve/reject

12. TeamDelete
```

## Quick Pipeline (medium)
Plan: Planner subagent (Opus) + Reviewer subagent (Sonnet)
Execute: Executor subagent (Sonnet) + Reviewer subagent (Sonnet)
팀 소환 없음.

## Trivial Pipeline (small)
PM 직접 수행. 에이전트 소환 없음. 소스 코드 직접 접근 허용.

## Ralph Pipeline
execute → verify 자동 반복 (최대 10회).

## PM 승인 기준
- **APPROVE**: Reviewer 점수 20+/25, CRITICAL 0개
- **REJECT**: CRITICAL/HIGH 미해결

## UI 템플릿
모든 AskUserQuestion은 `.vela/references/interactive-ui.md`에서 읽어라.
