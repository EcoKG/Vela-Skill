---
name: "vela:auto"
description: "⚡ Vela Auto 모드 — 파이프라인 전 단계를 무인 자동 실행합니다. 활성 파이프라인이 있으면 auto 모드를 토글합니다."
---

# /vela:auto — 자동 진행 파이프라인 (토글)

`/vela auto` (또는 `/vela:auto`)는 두 가지 동작을 한다:

### 1. 활성 파이프라인이 있을 때 → 파이프라인 재개

이미 파이프라인이 진행 중이면 현재 단계부터 자동으로 이어서 실행한다:
```bash
node .vela/cli/vela-pipeline.js resume
```

### 2. 활성 파이프라인이 없을 때 → Auto 모드로 새 파이프라인 시작

`/vela:start`와 동일하되 `--auto` 플래그를 추가한다:

1~3단계는 `/vela:start`와 동일.

4. **파이프라인 시작 (auto 플래그 추가)**
   ```bash
   node .vela/cli/vela-pipeline.js run "작업 설명" --scale <small|medium|large> --type <code|code-bug|code-refactor|docs> --auto
   ```

5. **자동 진행**
   Orchestrator가 매 프롬프트에 `⚡ AUTO` directive를 주입한다.
   - 일반 단계: 현재 단계를 완료한 뒤 즉시 transition 호출
   - checkpoint 단계: plan-check 통과 확인 → record pass → transition 호출

### Auto 모드 중단 조건

- `record reject`가 **2회 연속** 발생하면 auto 모드가 자동 비활성화된다.
- Orchestrator가 `⚠ AUTO SUSPENDED` directive를 주입하여 PM에게 알린다.
- 이후 사용자가 수동으로 개입하여 문제를 해결해야 한다.
