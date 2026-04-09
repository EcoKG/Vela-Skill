# 모델 선택 전략 — V6 Agent 도구 기반

V6에서는 PM이 각 단계를 Agent 도구로 직접 실행한다. 모델 선택은 각 역할 에이전트의 시스템 프롬프트에서 자체적으로 처리한다.

## 단계별 실행 경로

| 단계 | 역할 에이전트 | 권장 모델 | 특징 |
|------|-------------|----------|------|
| research | `vela-researcher` | Sonnet | 아키텍처/보안/품질 3관점 분석 |
| plan | `vela-planner` | Sonnet | 설계, Architecture/ClassSpec/TestStrategy 필수 |
| plan-check | `vela-plan-checker` | Haiku | plan.md 구조 검증 (PASS/FAIL) |
| execute | `vela-executor` | Sonnet | TDD 3단계 구현 |
| verify | `vela-verifier` | Sonnet | 테스트/린트/타입 체크 |
| review | `vela-reviewer` | Sonnet | 5차원 채점 (점수 ≥ 20/25 → 승인) |
| diff-summary | `vela-diff-summary` | Sonnet | 전체 diff 통합 검토 |
| learning | `vela-learning` | Haiku | 파이프라인 학습 축적 |
| sprint-plan | `vela-sprint-planner` | Sonnet | 대규모 요청 슬라이스 분해 |

## PM 오케스트레이션 패턴

PM은 각 단계에서 다음과 같이 Agent 도구를 호출한다:

```
Agent(
  subagent_type="vela-researcher",
  prompt="request: {요청}, artifactDir: {artifactDir}, cwd: {cwd}"
)
```

모델을 직접 지정할 필요는 없다. 각 역할 에이전트가 자신의 작업에 적합한 도구와 접근 방식을 자체적으로 결정한다.

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
