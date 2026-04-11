---
name: "vela:large"
description: "✦ Vela large-scale 파이프라인 — 광범위 설계, 신규 모듈, critical path (standard pipeline: 13단계, locate + research + plan + plan-check + checkpoint + branch + execute + verify + diff-summary + learning + commit + finalize)"
---

# /vela:large — 광범위 작업용 파이프라인

이 커맨드는 Vela의 **standard** 파이프라인(13단계)을 시작한다. research + plan + 사용자 checkpoint + 전체 diff 리뷰까지 모든 품질 게이트를 거친다.

## 절차

1. **Vela 환경 확인** — `.vela/config.json`이 없으면 자동 구성.
2. **작업 내용 수집** — `$ARGUMENTS`가 있으면 원본 요청. 없으면 질문.
3. **프롬프트 최적화** — `.vela/agents/pm/prompt-optimizer.md`의 1~5단계 실행 (Scale Mismatch Guard 포함).
   - Scale Guard가 large가 과하다고 판단하면 사용자에게 medium/small 제안 (자동 변경 금지).
4. **파이프라인 초기화**:
   ```bash
   node .vela/cli/vela-engine.js init "작업 설명" --scale large
   ```
5. **파이프라인 진행** — 13단계:
   - `init → locate → research → plan → plan-check → checkpoint → branch → execute → verify → diff-summary → learning → commit → finalize`
   - `locate`에서 targets.json 생성
   - `research(targeted)`는 locate confidence가 high일 때 자동 활성화 (좁은 범위 분석 — v6.1)
   - `plan` 단계에서 Architecture/ClassSpec/TestStrategy 필수 (각 200byte 이상, 엔진이 차단)
   - `checkpoint`에서 사용자 plan 승인
   - `branch` 자동 생성 (`vela/{slug}-{HHMM}`)
   - `execute`에서 TDD 3단계 (test-write → implement → refactor)
   - `verify`에서 테스트/린트/타입 체크 + ref_integrity
   - `diff-summary`에서 5차원 diff 검토 (non-fatal)
   - `learning`에서 패턴 누적 (non-fatal)

## 언제 사용하는가

- 신규 모듈/신규 기능 (광범위)
- Critical path 변경 (보안/인증/결제/DB)
- 광범위 리팩토링
- Exploratory bug (원인 불명)
- 팀 협업 — audit trail + research.md + plan.md가 중요한 경우

## 언제 다른 scale을 쓰는가

- 명확한 단일/소규모 변경 → `/vela:medium` (대부분의 일상 작업)
- 한 줄 수정 → `/vela:small`
- TDD 반복 버그 수정 → `/vela:ralph`
- 문서 수정 → `/vela:hotfix`

## 비용 경고

large 파이프라인은 가장 무겁다 — 13단계 + research + plan review 때문에 토큰 소비가 medium 대비 3-5배 많다. 작업이 정말 large가 필요한지 `/vela:medium`과 비교 검토하는 것을 권장한다. Scale Guard가 자동으로 검토해준다.
