---
name: "vela:fix"
description: "🎯 Vela surgical 파이프라인 — Target-First 패러다임. locate → research(targeted) → spec(patch-spec.md) → patch → verify → commit → finalize (8단계). 정확한 file:line 좌표 기반 결정론적 수정. 일상 작업의 기본 추천."
---

# /vela:fix — Target-First 정밀 수정 파이프라인 (v7.0)

이 커맨드는 Vela의 **surgical** 파이프라인을 시작한다. v6.1 Universal Locate가 좌표를 결정론적으로 식별하고, planner가 `mode: spec`으로 **patch-spec.md**(file:line Before/After + Explicitly out of scope)를 작성하며, executor가 spec을 *그대로* 적용한다. verifier는 `Explicitly out of scope` 섹션을 기준으로 범위 위반을 검사한다.

## 언제 사용하는가

**정확한 수정 위치가 있는 모든 일상 작업의 기본 추천**. 과한 /vela:large와 너무 가벼운 /vela:medium의 중간 지점 — 정밀하지만 research(targeted)로 문맥도 수집한다.

특히 유리한 경우:
- 기존 함수 시그니처 변경
- 특정 파일의 버그 수정 (원인 명확)
- 입력 검증/에러 처리 추가
- Scope creep 방지가 중요한 critical path 수정
- 팀 리뷰용 patch 명세가 필요한 경우

## 언제 다른 scale을 쓰는가

| 상황 | 권장 |
|---|---|
| 원인 불명 버그 (탐색 필요) | `/vela:large` — exploratory research |
| 신규 모듈/대규모 설계 | `/vela:large` — architecture plan 필요 |
| 한 줄 수정, 오타 | `/vela:small` — spec 명세가 과함 |
| TDD 반복 루프 (테스트 통과까지) | `/vela:ralph` |
| 문서/설정 | `/vela:hotfix` |
| 명확한 기능 추가 (spec 과정이 부담스러움) | `/vela:medium` — 기존 추상 plan 흐름 |

## 절차

1. **Vela 환경 확인** — `.vela/config.json`이 없으면 자동 구성.
2. **작업 내용 수집** — `$ARGUMENTS`가 있으면 원본 요청. 없으면 질문.
3. **프롬프트 최적화** — `.vela/agents/pm/prompt-optimizer.md` 1~5단계 (Scale Mismatch Guard 포함).
   - Scale Guard는 fix를 점검 대상으로 포함: locate confidence가 low + blast_radius ≥ 5 파일이면 `/vela:large` 제안.
4. **파이프라인 초기화**:
   ```bash
   vela-engine init "작업 설명" --scale fix
   ```
5. **파이프라인 진행** — 8단계:
   - `init → locate → research → spec → patch → verify → commit → finalize`
   - `locate`: ripgrep + git grep + git ls-files로 targets.json 생성 (LLM 0)
   - `research`: locate confidence high → `project_mode: targeted` 자동 주입, 좁은 범위만 분석
   - `spec`: planner를 `mode: spec`으로 호출 → patch-spec.md 작성 (file:line Before/After + Explicitly out of scope)
   - `patch`: executor가 patch-spec.md를 그대로 적용 (targets.primary 범위 내에서만)
   - `verify`: 테스트/린트 + **out-of-scope 위반 검사** (patch-spec.md의 `Explicitly out of scope` 섹션과 실제 git diff 대조)
   - `commit → finalize`: 기존과 동일

## 핵심 약속

- **결정론**: 같은 request → 같은 targets.json → 같은 patch-spec.md → 같은 patch.
- **Scope creep 방지**: executor가 patch-spec에 없는 파일을 수정하면 verifier가 FAIL 판정.
- **audit trail**: patch-spec.md가 "무엇을 왜 바꿨는가"의 영구 기록이 된다.

## 비용 특성 (예상)

| 단계 | 추정 토큰 |
|---|---|
| locate | 0 (LLM 없음) |
| research(targeted) | 15-25k (좁은 범위만) |
| spec | 10-20k |
| patch | 20-50k |
| verify | 5-15k (+ out-of-scope 검사) |
| **합계** | **~50-110k** |

`/vela:large` 대비 ~6-9배 절감 (vs 700k~900k). `/vela:medium` 대비 ~2-3배 비용이지만 결정론 + audit + scope 보호로 품질 ↑.

## 사전 조건

- `locate`가 primary 파일을 high/medium confidence로 식별해야 spec이 의미 있다.
- locate confidence가 low이면 PM이 AskUserQuestion으로 파일 명시를 요청하거나, `/vela:large` exploratory research로 전환을 제안한다.
- 신규 프로젝트(bootstrap)나 광범위 refactoring은 `/vela:fix`가 아닌 `/vela:large` 대상.
