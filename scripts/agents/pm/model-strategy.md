# 모델 선택 전략 — V6 Agent 도구 기반

V6에서는 PM이 각 단계를 Agent 도구로 직접 실행한다. 모델 선택은 각 역할 에이전트의 시스템 프롬프트에서 자체적으로 처리한다.

## 단계별 실행 경로

| 단계 | 역할 에이전트 | 모델 | 특징 |
|------|-------------|------|------|
| research | `vela-researcher` | Sonnet | 아키텍처/보안/품질 3관점 분석 |
| plan | `vela-planner` | Sonnet | 설계, Architecture/ClassSpec/TestStrategy 필수 |
| plan-check | `vela-plan-checker` | Haiku (`effort: low`) | plan.md 구조 검증 (PASS/FAIL) |
| execute | `vela-executor` | Sonnet | TDD 3단계 구현 |
| verify | `vela-verifier` | Sonnet | 테스트/린트/타입 체크 |
| review | `vela-reviewer` | Sonnet | 5차원 채점 (점수 ≥ 20/25 → 승인) |
| diff-summary | `vela-diff-summary` | Haiku (`effort: low`) | 전체 diff 통합 검토 (non-fatal) |
| learning | `vela-learning` | Haiku (`effort: low`) | 파이프라인 학습 축적 (non-fatal) |
| sprint-plan | `vela-sprint-planner` | Sonnet | 대규모 요청 슬라이스 분해 |

## PM 오케스트레이션 패턴

PM은 각 단계에서 다음과 같이 Agent 도구를 호출한다:

```
Agent(
  subagent_type="vela-researcher",
  prompt="request: {요청}, artifactDir: {artifactDir}, cwd: {cwd}"
)
```

**모델은 각 에이전트의 frontmatter(`model:`)에 고정한다.** 생략하면 공식 기본값 `inherit`가 적용되어 부모 세션의 모델(예: Opus)을 그대로 쓰므로 비용 예측이 불가능하다. 품질 크리티컬 단계(researcher/planner/executor/reviewer/verifier)는 Sonnet, 기계적 검사(plan-checker/diff-summary/learning)는 Haiku로 고정한다. Haiku 단계는 `effort: low`로 확장 사고(extended thinking)를 꺼서 추가 비용을 배제한다.

## 스케일별 단계 구성

| scale | pipeline_type | 실행되는 단계 |
|-------|--------------|--------------|
| hotfix | hotfix | execute, commit |
| small | trivial | execute, commit, finalize |
| medium | quick | plan, execute, verify, commit, finalize |
| large | standard | 전체 12단계 |
| ralph | ralph | execute ↔ verify 루프, commit, finalize |

스케일이 줄어들수록 research/plan-check 등 분석 단계가 생략되어 비용과 시간이 절약된다.
복잡한 작업일수록 높은 스케일(large/standard)을 사용하여 충분한 분석과 검증을 보장한다.
