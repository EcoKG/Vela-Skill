---
name: "vela:auto"
description: "⚡ Vela Auto 모드 — 파이프라인 전 단계를 무인 자동 실행합니다. 활성 파이프라인이 있으면 현재 단계부터 자동 진행합니다."
---

# /vela:auto — 자동 진행 파이프라인

`/vela auto` (또는 `/vela:auto`)는 두 가지 동작을 한다:

### 1. 활성 파이프라인이 있을 때 → 자동 재개

이미 파이프라인이 진행 중이면 현재 단계부터 자동으로 이어서 실행한다:
```bash
node .vela/cli/vela-engine.js state
```
현재 단계를 파악한 후 해당 단계의 에이전트를 Agent 도구로 소환하여 자동 진행한다.

### 2. 활성 파이프라인이 없을 때 → Auto 모드로 새 파이프라인 시작

`/vela:start`와 동일하되 `--auto` 플래그를 추가한다:

1~4단계는 `/vela:start`와 동일.

5. **파이프라인 초기화 (auto 플래그)**
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale <small|medium|large> --auto
   ```

6. **자동 진행**
   PM이 각 단계를 Agent 도구로 실행하되, 사용자 확인 없이 자동으로 다음 단계로 전이한다.
   - 일반 단계: 에이전트 완료 → 즉시 `vela-engine.js transition` 호출
   - checkpoint 단계: plan-check 통과 확인 → record pass → 자동 transition
   - 상세 진행 방법: `.vela/agents/pm/pipeline-flow.md` 참조

### Auto 모드 중단 조건

- `record reject`가 **2회 연속** 발생하면 auto 모드가 자동 비활성화된다.
- PM이 사용자에게 `⚠ AUTO SUSPENDED` 알림과 함께 AskUserQuestion으로 개입을 요청한다.
