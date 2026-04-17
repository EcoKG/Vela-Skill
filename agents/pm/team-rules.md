# 에이전트 위임 규칙 — v8.0 (4 에이전트)

PM은 `Agent(subagent_type="vela-{role}")` 단일 호출로 역할 에이전트를 소환한다.

## v8.0 역할 — 4개 에이전트 (v7.3-M3 통합 후)

| 역할 | subagent_type | 주요 도구 | 산출물 | 파이프라인 단계 |
|------|--------------|----------|-------|----------------|
| 리서처 | `vela-researcher` | Read/Glob/Grep/Bash | research.md 또는 analysis.md | /vela:analyze 전용 (mode=research/merge/analyze) |
| 플래너 | `vela-planner` | Read/Write | plan.md 또는 patch-spec.md | `plan` (research+plan+self-check 통합) |
| 실행자 | `vela-executor` | Read/Write/Edit/Bash | task-summary.md | `execute` |
| 리뷰어 | `vela-reviewer` | Read/Bash/Write | review-{step}.md 또는 verification.md | `plan/execute/verify` (review/verify/diff-summary 통합) |

v7.3-M3에서 통합/삭제된 에이전트:
- `vela-plan-checker` → planner의 `## Self-Check` 섹션으로 흡수
- `vela-verifier` → reviewer의 `mode=verify`로 흡수
- `vela-diff-summary` → reviewer의 verify 모드 Phase 4로 흡수
- `vela-learning` → 삭제 (v7.2 M8 post-tool 훅에 40줄 유용 로직만 잔존)
- `vela-sprint-planner` → 삭제 (M1c에서 스프린트 기능 제거)
- `vela-researcher-merge`, `vela-analyzer` → researcher의 mode=merge/analyze로 흡수

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
| 1 | 프로젝트 설명, 언어/프레임워크 (projectEnv) | plan, verify |
| 2 | targets.json 경로 (targetsPath) | plan, execute, verify |
| 3 | plan.md/patch-spec.md 경로, reviewFeedback | execute |

**절대 금지**: 전체 소스 코드를 프롬프트에 포함. 이전 단계 산출물 전부 전달.

## 파일 소유권

execute 단계에서 executor가 변경하는 파일을 프롬프트에 명시한다. 같은 파일을 두 번 할당하지 않는다.

## Opus 4.7 주입 (v8.0)

각 에이전트 frontmatter에 `effort: high` (coding: `xhigh`) 설정. `max_revisions`는 adaptive thinking이 담당하므로 공격적 축소 가능 (기본 3→1, 실패 시 모델 티어 에스컬레이션).
