# 파이프라인 운영 흐름 — 단계를 절대 건너뛰지 않는다

## Standard Pipeline (large)

```
1. TeamCreate: team_name "vela-pipeline"

[Research] — Subagent (Sonnet)
2. Researcher subagent 1명 소환 (model: "sonnet"):
   - 프로젝트 분석 수행
   - 요구사항 파악 → 코드베이스 탐색 → 의존성/제약 분석 → 결론
3. PM이 리포트를 검토하여 research.md 작성
4. `node .vela/cli/vela-engine.js review` → SDK Reviewer 실행 → review-research.md 생성
5. PM이 review 읽고 approve/reject 판단

[Plan] — Subagent (Sonnet)
6. Planner subagent (model: "sonnet") → plan.md
7. `node .vela/cli/vela-engine.js review` → SDK Reviewer 실행 → review-plan.md 생성
8. PM approve/reject

[Execute — 단일 모듈] — Subagent (Sonnet)
9. `node .vela/cli/vela-engine.js execute` → SDK Executor (Sonnet) 코드 구현
10. `node .vela/cli/vela-engine.js review` → SDK Reviewer 실행 → review-execute.md 생성
11. PM approve/reject

[Execute — CrossLayer/다중 모듈] — Teammate (Sonnet)
9. Teammate 3~5명 (model: "sonnet", team_name, isolation: "worktree")
10. `node .vela/cli/vela-engine.js review` → SDK Reviewer 실행 → review-execute.md 생성
11. PM approve/reject

12. TeamDelete
```

## Quick Pipeline (medium)
Plan: Planner subagent (Sonnet) + SDK Reviewer (`vela-engine.js review`)
Execute: SDK Executor (`vela-engine.js execute`) + SDK Reviewer (`vela-engine.js review`)
팀 소환 없음.

## Trivial Pipeline (small)
PM 직접 수행. 에이전트 소환 없음. 소스 코드 직접 접근 허용.

## Ralph Pipeline
execute → verify 자동 반복 (최대 10회).

## PM 승인 기준
- **APPROVE**: Reviewer 점수 20+/25, CRITICAL 0개
- **REJECT**: CRITICAL/HIGH 미해결

## 퍼미션 모드 감지 + 안내

파이프라인 시작 시 사용자의 퍼미션 모드를 확인한다.

- **Default mode 감지**: 사용자가 기본 퍼미션 모드(매번 승인 프롬프트)로 실행 중이면, Read/Glob/Grep 도구 사용 시마다 승인 요청이 반복된다.
- **Vela allow 규칙 안내**: Vela는 `settings.local.json`에 `Read(*)`, `Glob(*)`, `Grep(*)` allow 규칙을 자동 등록한다. 이 규칙이 적용되면 읽기 도구는 승인 없이 실행된다.
- **반복 프롬프트 발생 시 안내**: allow 규칙이 적용되지 않은 환경에서는 다음을 안내한다:
  1. `claude --dangerously-skip-permissions` 플래그로 실행
  2. 또는 `/permissions` 명령으로 세션 내 퍼미션 설정 변경
- **advisory 전용**: 이 안내는 참고 정보다. Vela는 사용자의 퍼미션 모드를 프로그래밍 방식으로 변경할 수 없다. 최종 선택은 사용자에게 있다.

## UI 템플릿
모든 AskUserQuestion은 `.vela/references/interactive-ui.md`에서 읽어라.
.
