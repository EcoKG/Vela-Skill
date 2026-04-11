---
name: "vela:ralph"
description: "🔁 Vela ralph 파이프라인 — TDD 루프 버그 수정 (execute ↔ verify 반복, 테스트 통과까지 최대 10회)"
---

# /vela:ralph — TDD 루프 버그 수정

이 커맨드는 Vela의 **ralph** 파이프라인을 시작한다. 테스트가 통과할 때까지 `execute ↔ verify` 사이클을 최대 10회 반복한다. 버그 수정, 플레이키 테스트 해결, 복잡한 리팩토링 TDD에 적합.

## 절차

1. **Vela 환경 확인** — `.vela/config.json`이 없으면 자동 구성.
2. **작업 내용 수집** — `$ARGUMENTS`가 있으면 원본 요청. 없으면 질문.
3. **프롬프트 최적화** — `.vela/agents/pm/prompt-optimizer.md` 1~5단계.
   - **Scale Guard는 ralph를 점검 대상에서 제외** (의도가 specific함)
4. **파이프라인 초기화**:
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale ralph
   ```
5. **파이프라인 진행** — 6단계 (execute ↔ verify 루프 포함):
   - `init → locate → execute → verify → commit → finalize`
   - `locate`에서 targets.json 생성 (첫 사이클부터 정확한 수정 위치 보장)
   - `execute`에서 TDD 3-phase (test-write → implement → refactor)
   - `verify`가 FAIL이면 자동으로 `execute`로 복귀 (최대 10회)
   - 10회 소진 시 AskUserQuestion으로 에스컬레이션

## 언제 사용하는가

- 이미 테스트가 있는 버그 수정 (테스트가 통과해야 완료)
- 플레이키 테스트 안정화
- TDD 스타일의 반복 개선
- "테스트 통과까지 계속 고쳐줘" 같은 의지 표현

## 언제 다른 scale을 쓰는가

- 버그 원인 미상 → `/vela:large` (exploratory research 필요)
- 단순 오타 → `/vela:small`
- 신규 기능 → `/vela:medium` 또는 `/vela:large`

## 반복 제한

- `execute ↔ verify` 최대 10회 (pipeline.json: `max_revisions: 10`)
- 매 `execute` 실패는 `verification.md`의 실패 내용을 executor 프롬프트에 주입
- 10회 모두 실패 시 사용자 에스컬레이션 (강제 중단 없음)
