# 모델 선택 전략 — SDK 자동 선택

vela-pipeline.js 오케스트레이터가 각 단계의 모델을 자동 선택한다. PM이 모델을 직접 지정하지 않는다.

## 단계별 실행 경로 및 모델

각 단계는 **전용 SDK 모듈** 또는 **제네릭 runStep()**으로 실행된다.
전용 모듈은 단계에 최적화된 모델·프롬프트·병렬성을 사용한다.

| 단계 | 실행 경로 | 모델 | 특징 |
|------|-----------|------|------|
| research | sdkResearch() | **Opus × 3 병렬** | architecture / security / quality 관점 동시 분석 |
| plan | runStep() generic | Sonnet | 설계, effort=high, thinking=10000 tokens |
| plan-check | sdkPlanCheck() | **Haiku** | plan.md 구조 검증 (structured output) |
| execute | runStep() generic | Sonnet | 코드 구현, effort=high |
| verify | sdkValidate() | **Sonnet** | 테스트/린트/타입 체크 전용 에이전트 |
| review | sdkReview() | **Opus** | 5차원 채점 (점수 ≥ 20/25 → 승인) |
| diff-summary | sdkDiffSummary() | **Opus** | 전체 diff 통합 검토 |
| learning | sdkLearning() | **Haiku** | 파이프라인 학습 축적 |

## 전용 SDK 모듈 vs 제네릭 runStep

**전용 모듈이 있는 단계**는 해당 모듈이 직접 호출된다. vela-pipeline.js의 MODEL_MAP/EFFORT_MAP은
제네릭 runStep()을 사용하는 단계(plan, execute)에만 적용된다.

```
research  → sdk-researcher.js  (OPUS_MODEL 내장, 3-parallel Promise.allSettled)
plan-check → sdk-plan-checker.js (HAIKU_MODEL 내장, structured output schema)
verify    → sdk-validator.js   (SONNET_MODEL 내장, bypassPermissions)
review    → sdk-reviewer.js    (OPUS_MODEL 내장, 5-dimension scoring)
diff-summary → sdk-diff-summary.js (OPUS_MODEL 내장)
learning  → sdk-learning.js   (HAIKU_MODEL 내장)
```

## 리뷰 동작 (관찰용 참고)

오케스트레이터가 자동으로 리뷰를 처리한다:
- Opus 단일 호출로 5차원 채점 (점수 ≥ 20/25 → 승인)
- reject 시 오케스트레이터가 피드백을 주입하여 자동 재실행
- PM은 리뷰에 개입하지 않는다

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
