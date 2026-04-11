---
name: "vela:start"
description: "⚠️ DEPRECATED (v6.1) — /vela:small, /vela:medium, /vela:large, /vela:ralph, /vela:hotfix 중 하나를 직접 사용하세요. 호환성을 위해 유지되며 medium으로 폴백됩니다."
---

# /vela:start — 파이프라인 바로 시작 (⚠️ DEPRECATED)

**이 커맨드는 v6.1부터 deprecated되었다. v7.0에서 제거될 예정이다.**

사용자에게 아래 메시지를 반드시 먼저 표시한 후 진행한다:

```
⚠️ /vela:start는 v6.1부터 deprecated되었습니다.
   다음 명령 중 하나를 직접 사용하는 것을 권장합니다:

   - /vela:small   — 단일 파일/오타/한 줄 수정
   - /vela:medium  — 명확한 기능 추가 (대부분의 일상 작업, 기본 추천)
   - /vela:large   — 신규 모듈/광범위 리팩토링/critical path
   - /vela:ralph   — TDD 루프 버그 수정
   - /vela:hotfix  — 문서/설정 수정

   이번 호출은 호환성을 위해 /vela:medium으로 진행합니다.
   (v7.0에서 /vela:start는 완전히 제거됩니다.)
```

그 후 `/vela:medium`의 절차를 그대로 실행한다 (`skills/medium/SKILL.md` 참조).

---

## (레거시) 원본 /vela:start 절차

아래는 v6.0까지의 동작이다. deprecation 이후에도 내부적으로 아래 절차를 실행하되 scale은 `medium`으로 고정한다.

이 커맨드가 호출되면 Vela 파이프라인을 즉시 시작한다.
init이 안 되어 있으면 자동으로 init을 먼저 수행한다.

## 절차

1. **Vela 환경 확인 (자동 구성)**
   `.vela/config.json`이 존재하는지 확인한다.
   - 있으면 → 바로 2단계로
   - 없으면 → 아래 절차로 자동 구성 후 2단계로 진행:
     1. 스킬 디렉토리의 파일들을 `.vela/`로 복사 (CLI, agents, templates, references 등)
     2. `node .vela/install.js` 실행 (글로벌 훅 등록 + 에이전트 배포 + 권한 설정)

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

4. **(deprecated 동작) scale 자동 medium 고정**
   v6.1부터 /vela:start는 scale 선택 단계를 건너뛰고 항상 `medium`을 사용한다.
   명시적으로 다른 scale을 원하면 `/vela:small`, `/vela:large`, `/vela:ralph`, `/vela:hotfix`를 직접 호출한다.

5. **파이프라인 초기화**
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale medium
   ```

6. **파이프라인 진행**
   PM이 `vela-engine.js`로 상태를 추적하며, Agent 도구로 역할별 에이전트를 순서대로 소환한다.
   각 단계 완료 후 `node .vela/cli/vela-engine.js transition`으로 전이한다.
   
   상세 진행 방법은 `.vela/agents/pm/pipeline-flow.md`를 참조한다.
