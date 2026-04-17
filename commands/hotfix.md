---
name: "vela:hotfix"
description: "🔧 Vela hotfix 파이프라인 — 문서/설정/README 수정 전용 (init → locate → execute → commit, 4단계, 리뷰 생략)"
---

# /vela:hotfix — 문서/설정 수정용 최소 파이프라인

이 커맨드는 Vela의 **hotfix** 파이프라인을 시작한다. 문서, README, 주석, 설정 파일(JSON/YAML/TOML) 수정처럼 코드 리뷰가 필요 없는 작업에 적합한 가장 가벼운 파이프라인이다.

## 절차

1. **Vela 환경 확인** — `.vela/config.json`이 없으면 자동 구성.
2. **작업 내용 수집** — `$ARGUMENTS`가 있으면 원본 요청. 없으면 질문.
3. **프롬프트 최적화** — `.vela/agents/pm/prompt-optimizer.md` 1~5단계.
   - **Scale Guard는 hotfix를 점검 대상에서 제외** (의도가 specific함)
4. **파이프라인 초기화**:
   ```bash
   vela-engine init "작업 설명" --scale hotfix
   ```
5. **파이프라인 진행** — 4단계:
   - `init → locate → execute → commit`
   - `locate`에서 targets.json 생성 (사용자 명시 파일 검증)
   - `execute`에서 직접 수정 (plan/verify/review 생략)
   - `commit` 자동

## 언제 사용하는가

- README, CHANGELOG, docs 수정
- 주석 수정, 오타
- 설정 파일 갱신 (`.env.example`, `config.yaml`)
- `.gitignore`, `package.json` 메타데이터 변경
- 비-실행 파일 수정

## 절대 사용하지 말아야 할 경우

- 프로덕션 코드 수정 — 테스트 없이 배포 위험
- 보안 설정 변경 — verify/review 누락
- 비즈니스 로직 포함 JSON (예: pipeline.json 구조 변경) — 오히려 `/vela:medium` 사용

## 속도 비용

가장 빠른 파이프라인. research/plan/verify 모두 생략이라 토큰 소비가 `/vela:medium` 대비 1/5 수준. 단, 검증이 없으므로 사용자가 변경 내용을 본인 책임으로 확인해야 한다.
