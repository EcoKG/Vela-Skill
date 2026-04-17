---
name: "vela:ship"
description: "⛵ Vela 기본 파이프라인 — init → locate → plan → execute → verify → commit (6단계). small/medium/large/ralph의 통합 후속 (v8.0-M3)."
---

# /vela:ship — 기본 개발 파이프라인 (v8.0)

일상적 모든 규모의 코드 변경에 사용한다. 6단계 파이프라인이 규모를 `change-surface.js` 출력과 planner의 self-check로 자동 조정한다.

## 절차

1. **Vela 환경 확인** — `.vela/config.json`이 없으면 자동 구성
2. **작업 수집** — `$ARGUMENTS`가 있으면 그대로 사용, 없으면 AskUserQuestion
3. **프롬프트 최적화** — `.vela/agents/pm/prompt-optimizer.md` 1~5단계
4. **파이프라인 초기화**:
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale ship
   ```
   init이 vela/{slug} 브랜치도 자동 생성
5. **6단계 진행**:
   - `init` — 아티팩트 디렉토리 + 브랜치
   - `locate` — targets.json 결정론적 식별 (LLM 0)
   - `plan` — vela-planner (research + plan + self-check 통합, Opus 4.7 adaptive thinking)
   - `execute` — vela-executor TDD (test-write → implement → refactor)
   - `verify` — vela-reviewer (테스트/린트/타입체크 + diff 요약; >500 LOC 시 `/ultrareview` 에스컬레이션)
   - `commit` — Conventional Commits + git diff --stat 요약

## 언제 사용하는가

- 대부분의 일상 코드 변경 (신규 기능, 리팩토링, 버그 수정 다수)
- 단일 영역 또는 관련 다중 영역
- 명확한 요구사항이 있는 작업

## 다른 명령

| 상황 | 명령 | 차이 |
|------|------|------|
| 작은 surgical 수정 (<50 LOC) | `/vela:fix` | planner가 mode=spec으로 patch-spec.md 작성 |
| 문서/config 수정 | `/vela:hotfix` | plan/verify 생략 (4단계) |
| 반복 TDD 루프 필요 | `/vela:ship` + `/loop` | Claude Code 번들 `/loop` 래핑 (구 /vela:ralph 대체) |
| 분석만 (수정 없음) | `/vela:analyze` | 파이프라인 없음, vela-researcher(mode=analyze) 직접 호출 |

## v7.3-M3 변경 노트

- 구 `/vela:small`, `/vela:medium`, `/vela:large` 삭제 — 모두 `/vela:ship`으로 통합 (이번 릴리스에서 deprecation 셤 경고 + 자동 리다이렉트)
- 구 `/vela:ralph` 삭제 — `/loop /vela:ship`으로 대체
- 파이프라인 단계 13 → 6 (plan-check/checkpoint/branch/diff-summary/learning/finalize 제거 또는 흡수)
- 에이전트 10+ → 4 (researcher는 /vela:analyze 전용, planner가 research 흡수, reviewer가 verify+diff-summary 흡수)
