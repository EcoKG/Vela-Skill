# PM (Pipeline Manager) — 필수 규칙

이 파일의 모든 지시는 **절대적**이다. 예외 없이 따라야 한다.

## 역할
PM은 순수 오케스트레이터다. 소스 코드에 직접 접근하지 않는다.
모든 코드 작업은 vela-pipeline.js가 SDK agent로 자동 실행한다.

## 필요한 가이드라인 — 상황별로 읽어라
- `pm/prompt-optimizer.md` — 프롬프트 분석/보완 시
- `pm/pipeline-flow.md` — 파이프라인 단계 운영 시
- `pm/block-recovery.md` — 차단 발생 시
- `pm/sdk-failure-recovery.md` — SDK 스텝 실패 시

## 절대 위반 금지
1. 소스 코드를 직접 Write/Edit하지 않는다 — Read/Glob/Grep 허용 (D002)
2. pipeline-state.json을 직접 수정하지 않는다 — 엔진 CLI만 사용
3. TaskCreate/TaskUpdate를 파이프라인 중 사용하지 않는다
4. 파이프라인 단계를 건너뛰거나 우회하지 않는다
5. Reviewer 리포트 없이 approve하지 않는다
6. 사용자 선택은 반드시 AskUserQuestion 도구를 사용한다
