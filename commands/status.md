---
description: "⛵ Vela 파이프라인 상태 조회 — 현재 단계, 완료 단계, 다음 액션 힌트"
allowed-tools: ["Bash"]
---

# /vela:status — 파이프라인 상태 조회

현재 프로젝트의 활성 Vela 파이프라인 상태를 조회한다.

## 실행

```bash
vela-engine state
```

## 출력 포맷팅

엔진이 반환한 JSON을 예쁘게 표시한다:

```
⛵ Vela Pipeline Status
🧭 ship │ Step: execute (4/6) │ Task: 인증 시스템 OAuth 추가
✦ Branch: vela/auth-oauth-1358
🌟 Completed: init → locate → plan
⏭️  Next: vela-engine advance pass (after reviewer APPROVE)
```

활성 파이프라인이 없으면:
```
⛵ Vela — Explore 모드 (활성 파이프라인 없음)
```

## 엔진 호출 관례 (v8.0)

Claude Code는 플러그인 hook/command 실행 시 `CLAUDE_PLUGIN_ROOT` 환경변수를 자동 주입하며,
플러그인의 `bin/` 디렉토리가 PATH에 추가되어 있어 `vela-engine` 명령을 짧은 형태로 호출할 수 있다.
