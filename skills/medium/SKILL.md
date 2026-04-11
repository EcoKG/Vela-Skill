---
name: "vela:medium"
description: "🧭 Vela medium-scale 파이프라인 — 명확한 기능 추가/수정 (quick pipeline: init → locate → plan → execute → verify → commit → finalize, 7단계)"
---

# /vela:medium — 일상 작업용 파이프라인 (기본 추천)

이 커맨드는 Vela의 **quick** 파이프라인을 시작한다. 대부분의 일상 작업에 적합한 기본 scale이다.

## 절차

1. **Vela 환경 확인** — `.vela/config.json`이 없으면 자동 구성.
2. **작업 내용 수집** — `$ARGUMENTS`가 있으면 원본 요청. 없으면 질문.
3. **프롬프트 최적화** — `.vela/agents/pm/prompt-optimizer.md`의 1~5단계 실행 (Scale Mismatch Guard 포함).
4. **파이프라인 초기화**:
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale medium
   ```
5. **파이프라인 진행**:
   - `init → locate → plan → execute → verify → commit → finalize` (7단계)
   - `locate`에서 targets.json 생성 (LLM 0)
   - `plan`에서 targets 기반으로 plan.md 작성 (Architecture/ClassSpec/TestStrategy 필수)
   - `execute`에서 targets 범위 내에서 TDD 구현
   - `verify`에서 테스트 + 린트 실행

## 언제 사용하는가

- 명확한 기능 추가 (단일 또는 소규모 파일 세트)
- 버그 수정 (정적, 테스트 필요)
- 기존 함수 시그니처 변경
- 2~5개 파일 수정 작업
- **대부분의 일상 코딩 작업의 기본값**

## 언제 다른 scale을 쓰는가

- 한 줄 수정, 오타 → `/vela:small`
- 신규 모듈, 광범위 리팩토링, 보안/인증 → `/vela:large`
- TDD 버그 수정 (테스트 통과까지 반복) → `/vela:ralph`
- 문서/설정 수정 → `/vela:hotfix`
