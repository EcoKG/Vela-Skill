# 에이전트 위임 규칙 — V6 Agent 도구 기반

V6에서 PM은 `TeamCreate`/`Teammate`를 사용하지 않는다.
모든 역할 에이전트는 `Agent(subagent_type="vela-{role}")` 단일 호출로 소환한다.

## 역할별 Agent 소환 패턴

| 역할 | subagent_type | 주요 도구 | 산출물 |
|------|--------------|----------|-------|
| 리서처 | `vela-researcher` | Read/Glob/Grep | research.md |
| 플래너 | `vela-planner` | Read/Write | plan.md |
| plan 검증 | `vela-plan-checker` | Read/Write | plan-check.md |
| 실행자 | `vela-executor` | Read/Write/Edit/Bash | task-summary.md |
| 리뷰어 | `vela-reviewer` | Read/Write | review-{step}.md |
| 검증자 | `vela-verifier` | Read/Bash/Write | verification.md |
| diff 분석 | `vela-diff-summary` | Read/Bash/Write | diff-summary.md |
| 학습 | `vela-learning` | Read/Write | learning.md |
| 스프린트 | `vela-sprint-planner` | Read/Write | sprint-{ts}.json |

## 소환 프롬프트 형식

에이전트 소환 시 **반드시 XML 구조**로 태스크를 전달한다:

```
Agent(
  subagent_type="vela-executor",
  prompt="
    request: {요청}
    artifactDir: {artifactDir}
    planPath: {artifactDir}/plan.md

    <task>
      <role>executor</role>
      <action>plan.md의 Class Specification에 따라 TDD로 구현한다.</action>
      <verify>npm test</verify>
      <done>모든 테스트 통과 + task-summary.md 생성</done>
    </task>
  "
)
```

### XML 필드
- `<role>`: 에이전트 역할
- `<action>`: 구체적 작업 지시 (동사 + 목적어)
- `<verify>`: 검증 명령어
- `<done>`: 완료 조건 (검증 가능)

## 컨텍스트 Tier — 필요한 것만 전달

에이전트에 과도한 컨텍스트를 전달하지 않는다:

| Tier | 포함 내용 | 사용 단계 |
|------|----------|----------|
| 0 (항상) | artifactDir, request | 모든 소환 |
| 1 | 프로젝트 설명, 언어/프레임워크 | research |
| 2 | research.md 경로 | plan |
| 3 | plan.md 경로, reviewFeedback | execute |

**절대 금지**: 전체 소스 코드를 프롬프트에 포함. 이전 단계 산출물 전부 전달.

## 파일 소유권

execute 단계에서 vela-executor가 변경하는 파일을 프롬프트에 명시한다.
같은 파일을 두 번 executor에게 할당하지 않는다 (재시도 시도 동일 파일 범위 유지).
