# 모델 선택 전략 — V6 Agent 도구 기반

V6에서는 PM이 각 단계를 Agent 도구로 직접 실행한다. 모델 선택은 각 역할 에이전트의 시스템 프롬프트에서 자체적으로 처리한다.

## 단계별 실행 경로

| 단계 | 역할 에이전트 | 모델 | 특징 |
|------|-------------|------|------|
| research | `vela-researcher` | Sonnet | 아키텍처/보안/품질 3관점 분석 (v6.1에서 `project_mode: targeted` 자동 활성화) |
| plan | `vela-planner` | Sonnet | plan mode — Architecture/ClassSpec/TestStrategy 필수 |
| **spec** (v7.0) | `vela-planner` | Sonnet | spec mode — `patch-spec.md` (file:line Before/After + Explicitly out of scope), planner가 `mode: spec`으로 호출됨 |
| plan-check | `vela-plan-checker` | Haiku (`effort: low`) | plan.md 구조 검증 (PASS/FAIL) |
| execute | `vela-executor` | Sonnet | plan mode TDD 3단계 구현 |
| **patch** (v7.0) | `vela-executor` | Sonnet | spec mode — `patch-spec.md`의 `## After`를 정확히 적용, `Explicitly out of scope` 범위 준수 |
| verify | `vela-verifier` | Sonnet | 테스트/린트/타입 체크 + (v7.0) specPath 주입 시 Phase 4.5 out-of-scope 위반 검사 |
| review | `vela-reviewer` | Sonnet | 5차원 채점 (점수 ≥ 20/25 → 승인) |
| diff-summary | `vela-diff-summary` | Haiku (`effort: low`) | 전체 diff 통합 검토 (non-fatal) |
| learning | `vela-learning` | Haiku (`effort: low`) | 파이프라인 학습 축적 (non-fatal) |
| sprint-plan | `vela-sprint-planner` | Sonnet | 대규모 요청 슬라이스 분해 |

**v7.0 note**: spec과 patch는 각각 `vela-planner` / `vela-executor` 에이전트의 **새 mode**로 구현된다 — 새 에이전트 파일은 없다. PM이 프롬프트에 `mode: spec`을 주입하면 planner가 분기한다.

## PM 오케스트레이션 패턴

PM은 각 단계에서 다음과 같이 Agent 도구를 호출한다:

```
Agent(
  subagent_type="vela-researcher",
  prompt="request: {요청}, artifactDir: {artifactDir}, cwd: {cwd}"
)
```

**모델은 각 에이전트의 frontmatter(`model:`)에 고정한다.** 생략하면 공식 기본값 `inherit`가 적용되어 부모 세션의 모델(예: Opus)을 그대로 쓰므로 비용 예측이 불가능하다. 품질 크리티컬 단계(researcher/planner/executor/reviewer/verifier)는 Sonnet, 기계적 검사(plan-checker/diff-summary/learning)는 Haiku로 고정한다. Haiku 단계는 `effort: low`로 확장 사고(extended thinking)를 꺼서 추가 비용을 배제한다.

## 스케일별 단계 구성 (v6.1/v7.0)

모든 scale에 `init → locate` 공통 프리픽스 (v6.1).

| scale 명령 | pipeline_type | 실행되는 단계 |
|---|---|---|
| `/vela:hotfix` | hotfix | locate, execute, commit |
| `/vela:small` | trivial | locate, execute, commit, finalize |
| `/vela:medium` | quick | locate, plan, execute, verify, commit, finalize |
| `/vela:ralph` | ralph | locate, execute ↔ verify 루프, commit, finalize |
| **`/vela:fix` (v7.0)** | surgical | **locate, research(targeted), spec, patch, verify, commit, finalize** |
| `/vela:large` | standard | 전체 13단계 (locate, research, plan, plan-check, checkpoint, branch, execute, verify, diff-summary, learning, commit, finalize) |

스케일 선택 가이드:
- **일상 작업의 기본은 `/vela:fix`** — targets가 명확하면 가장 비용 효율적 (`~50-110k` 추정 토큰)
- 단일 파일 typo/오타 → `/vela:small`
- 범위는 명확하나 spec 단계가 과한 경우 → `/vela:medium`
- 신규 모듈/광범위 refactor/bootstrap/exploratory bug → `/vela:large`
- 테스트 통과까지 반복 → `/vela:ralph`
- 문서/설정 → `/vela:hotfix`

복잡한 작업일수록 높은 scale을 사용하여 충분한 분석과 검증을 보장한다.
