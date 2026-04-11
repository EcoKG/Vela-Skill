---
name: "vela:small"
description: "🧭 Vela small-scale 파이프라인 — 단일 파일/단일 함수 단위의 가벼운 수정 (trivial pipeline: init → locate → execute → commit → finalize, 5단계)"
---

# /vela:small — 가벼운 수정용 파이프라인

이 커맨드는 Vela의 **trivial** 파이프라인을 시작한다. 단일 파일 수정, 오타 수정, 간단한 주석 추가 등 명확하고 범위가 좁은 작업에 적합하다.

## 절차

1. **Vela 환경 확인** — `.vela/config.json`이 없으면 자동 구성 (`.vela/` 복사 + `node .vela/install.js`).
2. **작업 내용 수집** — `$ARGUMENTS`가 있으면 원본 요청으로 사용. 없으면 질문.
3. **프롬프트 최적화** — `.vela/agents/pm/prompt-optimizer.md`의 1~5단계 실행 (Scale Mismatch Guard 포함).
   - Scale Guard가 small이 과소하다고 판단하면 사용자에게 제안 (자동 변경 금지).
4. **파이프라인 초기화**:
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale small
   ```
5. **파이프라인 진행** — PM이 `pipeline-flow.md`에 따라 단계별 Agent 도구로 진행:
   - `init → locate → execute → commit → finalize` (5단계)
   - `locate` 단계에서 `vela-engine locate`로 targets.json 생성 (LLM 0)
   - `execute`에서 targets.json의 primary 파일만 수정

## 언제 사용하는가

- 단일 파일 수정, 오타/주석/포맷팅
- 명확한 file:line 좌표가 있는 경우
- 한 줄 수정처럼 범위가 매우 좁은 경우

## 언제 다른 scale을 쓰는가

- 여러 파일 수정 + 테스트 필요 → `/vela:medium`
- 신규 기능/광범위 리팩토링 → `/vela:large`
- 버그 수정 (TDD 반복) → `/vela:ralph`
- 문서/설정 수정 → `/vela:hotfix`
