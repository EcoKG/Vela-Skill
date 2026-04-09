---
name: "vela:start"
description: "🧭 Vela 파이프라인 바로 시작 — init이 안 되어 있으면 자동으로 환경 구축 후 파이프라인을 시작합니다. 작업 내용과 규모를 선택하면 즉시 진행됩니다."
---

# /vela:start — 파이프라인 바로 시작

이 커맨드가 호출되면 Vela 파이프라인을 즉시 시작한다.
init이 안 되어 있으면 자동으로 init을 먼저 수행한다.

## 절차

1. **Vela 설치 확인 (자동 init)**
   `.vela/config.json`이 존재하는지 확인한다.
   - 있으면 → 바로 2단계로
   - 없으면 → `/vela:init` 절차를 먼저 수행한 후 2단계로 진행

2. **기존 파이프라인 확인**
   ```bash
   node .vela/cli/vela-engine.js state
   ```
   활성 파이프라인이 있으면 사용자에게 "기존 파이프라인을 이어서 진행할까요?" 확인:
   - 재개 → 현재 단계부터 파이프라인 계속 진행
   - 취소 후 새로 시작 → `node .vela/cli/vela-engine.js cancel` 후 3단계로

3. **작업 내용 수집**
   `$ARGUMENTS`가 있으면 그것을 원본 요청으로 사용한다.
   없으면 사용자에게 "⛵ 어떤 작업을 진행할까요?" 질문한다.

   원본 요청 확보 후 **프롬프트 최적화** 절차를 실행한다 (`.vela/agents/pm/prompt-optimizer.md` 참조).

4. **파이프라인 규모 선택**
   사용자에게 선택지를 제시한다:
   - ⛵ **small**: trivial (init → execute → commit → finalize) — 단일 파일, 10줄 이하
   - 🧭 **medium**: quick (init → plan → execute → verify → commit → finalize) — 3파일 이하
   - ✦ **large**: standard (full 12-step: research, plan, plan-check, checkpoint, branch, execute, verify, diff-summary, learning, commit, finalize) — 대규모 작업

5. **파이프라인 초기화**
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale <small|medium|large>
   ```

6. **파이프라인 진행**
   PM이 `vela-engine.js`로 상태를 추적하며, Agent 도구로 역할별 에이전트를 순서대로 소환한다.
   각 단계 완료 후 `node .vela/cli/vela-engine.js transition`으로 전이한다.
   
   상세 진행 방법은 `.vela/agents/pm/pipeline-flow.md`를 참조한다.
