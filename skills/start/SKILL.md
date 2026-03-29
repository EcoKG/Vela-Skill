---
name: start
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

2. **작업 내용 수집**
   사용자에게 질문한다:
   - "⛵ 어떤 작업을 진행할까요?" → 작업 설명 수집

3. **파이프라인 규모 선택**
   사용자에게 선택지를 제시한다:
   - ⛵ **small**: trivial (init → execute → commit → finalize) — 단일 파일, 10줄 이하
   - 🧭 **medium**: quick (init → plan → execute → verify → commit → finalize) — 3파일 이하
   - ✦ **large**: standard (full 10-step with research, plan, team review) — 대규모 작업

4. **파이프라인 시작**
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale <small|medium|large> --type <code|code-bug|code-refactor|docs>
   ```

5. **파이프라인 진행**
   `.vela/agents/vela.md`의 지시사항에 따라 파이프라인 단계를 순서대로 진행한다.
   - standard: Research=Teammate(Opus) + Plan=Subagent(Opus) + Execute=Subagent/Teammate(Sonnet)
   - quick: Subagent 기반 + Reviewer(Subagent)
   - trivial: PM 직접 수행
