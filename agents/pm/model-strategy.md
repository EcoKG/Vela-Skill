# 모델 선택 전략 — v8.0 (v7.3-M3 이후)

PM은 각 단계를 Agent 도구로 실행한다. 모델 선택은 각 역할 에이전트의 frontmatter에서 고정한다.

## 단계별 실행 경로 (6단계)

| 단계 | 역할 에이전트 | mode | 모델 | 특징 |
|------|-------------|------|------|------|
| init | (엔진) | — | — | 아티팩트 디렉토리 + 브랜치 자동 생성 (LLM 0) |
| locate | (엔진) | — | — | ripgrep + git grep 결정론 (LLM 0) |
| plan (ship) | `vela-planner` | `plan` | Sonnet (effort: high) | research 흡수 — 파일 직접 Read + plan.md + ## Self-Check |
| plan (fix) | `vela-planner` | `spec` | Sonnet (effort: high) | patch-spec.md (file:line Before/After + out-of-scope) |
| execute | `vela-executor` | — | Sonnet (effort: xhigh) | TDD 3단계 (test-write→implement→refactor). fix에서는 patch-spec 엄수. |
| verify | `vela-reviewer` | `verify` | Sonnet | 테스트/린트/타입체크 + diff 요약 통합. >500 LOC → /ultrareview 에스컬레이션 |
| commit | (엔진) | — | — | Conventional Commits 자동 (LLM 0) |

review 판정은 verify 단계 내부에서 `mode: review`로 중첩 수행되거나 execute 직후 별도 호출 (파이프라인 설정에 따라). Architecture Guardrails 위반/CRITICAL 검출 시 REJECT.

## 모델 고정 원칙

- 각 에이전트 frontmatter `model:`는 **반드시 명시**한다. 생략 시 `inherit`로 부모 모델(Opus)이 흘러내려 비용 폭증.
- v8.0 권고:
  - `vela-planner` — **Opus 4.7** (`model: opus`, `effort: high`, adaptive thinking으로 Task Budget 자가 페이싱)
  - `vela-executor` — Sonnet 4.5 (`model: sonnet`, `effort: xhigh` — 코딩 특화)
  - `vela-reviewer` — Sonnet 4.5 (`model: sonnet`). 대형 diff 시 `/ultrareview`로 Opus 위임.
  - `vela-researcher` (/vela:analyze 전용) — Haiku 4.5 (`model: haiku`, `effort: low`) — 스캔 중심

## 삭제된 단계의 처리

v7.3-M3 이전에 존재했던 단계들의 현재 위치:

| 구 단계 | v8.0 위치 |
|--------|-----------|
| research | plan 내부에서 planner가 직접 수행 |
| plan-check | plan.md의 `## Self-Check` 섹션 |
| checkpoint | 삭제 (auto 모드 기본) |
| branch | init 단계에서 자동 생성 |
| diff-summary | verify 단계의 reviewer Phase 4 |
| learning | 삭제 (post-tool-learning 훅 40줄만 잔존) |
| finalize | commit 단계에서 git diff --stat 요약 |

## 파이프라인 변종 (3종)

| 명령 | pipeline_type | 단계 수 | 특징 |
|------|---------------|---------|------|
| `/vela:ship` | ship | 6 | 기본 — small/medium/large/ralph 통합 |
| `/vela:fix` | fix | 6 | surgical — planner mode=spec |
| `/vela:hotfix` | hotfix | 4 | 문서/config — plan/verify 생략 |

Deprecated: `/vela:small`, `/vela:medium`, `/vela:large`, `/vela:ralph` — 모두 `/vela:ship`으로 자동 리다이렉트 (v8.1에서 완전 제거).
