# 파이프라인 운영 흐름 — 단계를 절대 건너뛰지 않는다

**핵심: `vela-pipeline.js`가 유일한 실행 인터페이스다. PM은 `vela-engine.js`를 직접 호출하지 않는다.**

## 새 파이프라인 시작
```bash
node .vela/cli/vela-pipeline.js run "요청" --scale <small|medium|large>
```

## 기존 파이프라인 재개
세션이 끊기거나 중단된 파이프라인을 이어서 진행할 때:
```bash
node .vela/cli/vela-pipeline.js resume
```
`resume`은 현재 단계부터 자동으로 이어서 실행한다. 완료된 단계는 skip된다.

## Standard Pipeline (large)

```
오케스트레이터가 자동 실행하는 흐름:

[Research] — SDK Agent (Sonnet)
1. 오케스트레이터가 Researcher SDK agent 실행
2. 오케스트레이터가 자동 리뷰 실행 → review-research.md 생성
3. approve/reject 자동 판정

[Plan] — SDK Agent (Sonnet)
4. 오케스트레이터가 Planner SDK agent 실행 → plan.md
5. 오케스트레이터가 자동 리뷰 실행 → review-plan.md 생성
6. approve/reject 자동 판정

[Execute] — SDK Agent (Sonnet)
7. 오케스트레이터가 Executor SDK agent 실행 → 코드 구현
8. 오케스트레이터가 자동 리뷰 실행 → review-execute.md 생성
9. approve/reject 자동 판정 (reject 시 리뷰 피드백과 함께 재실행)
```

## Quick Pipeline (medium)

Plan → Execute. 오케스트레이터가 각 단계의 SDK agent + 리뷰를 자동 실행.

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
