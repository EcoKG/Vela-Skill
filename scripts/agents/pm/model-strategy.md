# 모델 선택 전략 — SDK 자동 선택

vela-pipeline.js 오케스트레이터가 각 단계의 모델을 자동 선택한다. PM이 모델을 직접 지정하지 않는다.

## 역할별 기본 모델 (참고용)

| 역할 | 기본 모델 | 비고 |
|------|----------|------|
| Researcher | Sonnet | 프로젝트 분석 |
| Planner | Sonnet | 설계 |
| Executor | Sonnet | 코드 구현 |
| Reviewer | Haiku→Sonnet→Opus | 3단계 에스컬레이션 |

## 에스컬레이션 동작 (관찰용 참고)

오케스트레이터가 자동으로 에스컬레이션을 처리한다:
- Reviewer 점수 미달 시 상위 모델로 자동 재실행
- reject 연속 시 상위 모델로 자동 재실행
- PM은 에스컬레이션에 개입하지 않는다
