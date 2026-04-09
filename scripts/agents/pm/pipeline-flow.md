# 파이프라인 운영 흐름 — 단계를 절대 건너뛰지 않는다

**핵심: `vela-pipeline.js`가 유일한 실행 인터페이스다. PM은 `vela-engine.js`를 직접 호출하지 않는다.**

## 새 파이프라인 시작
```bash
node .vela/cli/vela-pipeline.js run "요청"
node .vela/cli/vela-pipeline.js run "요청" --scale hotfix   # 수동 스케일 지정
```

## 기존 파이프라인 재개
세션이 끊기거나 중단된 파이프라인을 이어서 진행할 때:
```bash
node .vela/cli/vela-pipeline.js resume
```
`resume`은 현재 단계부터 자동으로 이어서 실행한다. 완료된 단계는 skip된다.

---

## 파이프라인 티어 — 작업 규모별 자동 선택

요청 길이로 자동 감지. `--scale` 플래그로 수동 지정 가능.

| 요청 규모 | scale | pipeline_type | 단계 흐름 | 특징 |
|-----------|-------|---------------|-----------|------|
| ≤ 10 단어 | small | trivial | init → execute → commit → finalize | 플래닝 없음 |
| 11~30 단어 | medium | quick | init → plan → execute → verify → commit → finalize | 경량 플로우 |
| > 30 단어 | large | standard | init → research → plan → plan-check → ... (전체 12단계) | 완전 파이프라인 |
| --scale ralph | ralph | ralph | init → execute ↔ verify (최대 10회 반복) → commit → finalize | 버그 TDD 루프 |
| --scale hotfix | hotfix | hotfix | init → execute → commit | 문서/README 수정 |

**수동 지정 예시:**
```bash
node .vela/cli/vela-pipeline.js run "Fix null pointer in auth" --scale ralph
node .vela/cli/vela-pipeline.js run "Update README" --scale hotfix
node .vela/cli/vela-pipeline.js run "Add OAuth2" --scale large
```

---

## Standard Pipeline (large scale)

```
오케스트레이터가 자동 실행하는 흐름:

[Research] — sdkResearch (Opus × 3 병렬)
1. architecture / security / quality 3관점 병렬 분석
2. 오케스트레이터가 자동 리뷰 실행 → review-research.md 생성
3. approve/reject 자동 판정

[Plan] — SDK Agent (Sonnet, effort=high)
4. 오케스트레이터가 Planner SDK agent 실행 → plan.md
5. 오케스트레이터가 자동 리뷰 실행 → review-plan.md 생성
6. approve/reject 자동 판정

[Plan-check] — sdkPlanCheck (Haiku, structured output)
7. plan.md 필수 섹션 구조 검증 (Architecture / Class Specification / Test Strategy)
8. PASS/FAIL 판정 → plan-check.md 생성

[Execute] — SDK Agent (Sonnet, effort=high)
9. 오케스트레이터가 Executor SDK agent 실행 → 코드 구현
10. 오케스트레이터가 자동 리뷰 실행 → review-execute.md 생성
11. approve/reject 자동 판정 (reject 시 리뷰 피드백과 함께 재실행)

[Verify] — sdkValidate (Sonnet)
12. 테스트 실행, 린트/타입 체크 → verification.md
13. FAIL 시 execute→review→verify 재시도 루프 진입 (최대 max_revisions 회)

[Diff-summary] — sdkDiffSummary (Opus)
[Learning] — sdkLearning (Haiku)
[Commit / Finalize] — PM 자동 처리
```

## Quick Pipeline (medium scale)

```
init → plan → execute → verify → commit → finalize
(research / plan-check / checkpoint / branch / diff-summary / learning 생략)
```

## Trivial Pipeline (small scale)

```
init → execute → commit → finalize
(플래닝 없음. 단일 파일 간단 수정에 적합)
```

## 스프린트 실행 흐름

여러 슬라이스로 분해가 필요한 대규모 요청은 스프린트로 실행한다.

```
[Sprint Planning] — SDK Sprint Planner (Sonnet)
1. PM이 vela-sprint.js run "요청" 실행
2. Sprint Planner가 슬라이스 분해 + 의존성 그래프 생성
3. sprint-plan.json 생성 (슬라이스 목록, 의존성, 실행 순서)

[Slice Execution] — 각 슬라이스를 독립 파이프라인으로 실행
4. getNextSlice()로 다음 실행 가능한 슬라이스 결정
5. 의존성이 충족된 슬라이스에 대해 vela-pipeline.js run 실행
6. 완료된 슬라이스의 컨텍스트를 다음 슬라이스에 전달
7. 모든 슬라이스 완료 시 스프린트 종료
```

단일 요청으로 처리 가능하면 파이프라인, 다중 슬라이스 분해가 필요하면 스프린트를 사용한다.

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
