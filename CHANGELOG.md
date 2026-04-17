# Vela Changelog

전체 릴리스 이력. v7.3부터는 git log + 커밋 메시지가 1차 기록이므로 이 파일은 과거 마일스톤 요약 용도.

## v7.3 (v8.0 전환 — 진행 중)

대규모 슬림화 스프린트. Opus 4.7(2026-04-16 릴리스) 기준 최신 Claude Code 베스트 프랙티스에 맞춰 "엔진"에서 "거버넌스 스킬"로 회귀. 자세한 커밋 이력은 `git log v7.2.0..HEAD`.

- **M1a** `1ffa870` — V4.1 ARCHIVED 루트 MD 5개 삭제 (-399 LOC)
- **M1b** `18faa65` — /vela:analyze PDF 파이프라인 제거 + vela-friction.js 분리 (-880 LOC)
- **M1c** `f930a23` — Sprint 오케스트레이션 완전 제거 (-1,245 LOC)
- **M2a** `32ed1b0` — Researcher multi-mode 통합 (merge+analyzer 흡수, -151 LOC)
- **M5a** `ae55ca2` — Archival RFC/release docs 6개 삭제 (-2,334 LOC)
- **M3** `4f84a9d` — 파이프라인 13→6 + 에이전트 8→4 + 명령 6→3 (-3,152 LOC)
- **M4a** `bc7adbc` — 관찰 훅 2개 제거 (file-read-cache, post-tool-learning, -878 LOC)
- **M5b** (진행 중) — README/SKILL 슬림 재작성

누적 감소: 약 -9,000 LOC, -20+ 파일.

## v7.2 (2026)

- **v7.2.0 Harness** — 구조화된 stderr (VK/VG 코드 명시), gate-events.jsonl 텔레메트리, config.gate_policy 3-way 정책
- **v7.2.0 M1–M15 V8 Strengthening (Phase A–D)** — Claude Code 2.1.107–109 아키텍처 정합. 프롬프트 캐싱 1h, 역할별 모델 라우팅, 병렬화/격리, Context7 MCP, SubagentStop 텔레메트리, managed-agents 등

## v7.1 (2026 hicoco hardening)

- **M029–M040 (M1–M12)** — commit/branch non-git guard, verify bash safelist, verifier Phase 3 smoke test, plan-checker sanity heuristics + Architecture Guardrails, slug fs-safe truncation, vela-engine doctor, context-pack.json, advance one-shot, role budgets, file-read-cache 훅(v7.3-M4a 제거), researcher targeted scope, CLAUDE.md cd-rule injection
- **v7.1.1~v7.1.5** — deploy drift 수정, FILE_MANIFEST parity 테스트, self-heal, constants.js wrapper 전환, 후보 검색 범위 확장

## v7.0 (2026 Surgical Pipeline)

- **M028** — Target-First 패러다임. `/vela:fix` 명령 + surgical 파이프라인 + planner mode=spec + patch-spec.md (file:line Before/After + Explicitly out of scope). v7.3-M3에서 ship 파이프라인에 통합.

## v6.x (2026 Native Agent Tool)

- **M025** v6.0 — SDK 완전 제거, 네이티브 Agent 도구로 재구성. 10개 역할 에이전트 생성.
- **M026** v6.0.1 — 모델 라우팅 명시(Sonnet/Haiku), review-gate 기본 1 라운드.
- **M027** v6.1 — Universal Locate 단계 도입. 결정론적 ripgrep+git 기반, LLM 0.

## v4.x ~ v5.x (2026 SDK 고도화)

- **v4.0 M013~M023** — sdk-custom-tools MCP, structured output, CSA 참조 무결성, change-surface 범용 확장, SDK 복원력 강화
- **v4.1 M024** — maxTurns 상한 제거, SDK 자율 턴

## v3.x (2025 SDK 도입 + 분석)

- **v3.0~v3.1 M003~M007** — Agent SDK 통합, 5개 SDK 모듈, 분석 리포트(dep-analyzer, vela-analyze, PDF), UI 고도화
- **v3.2~v3.3 M008~M012** — Fail-closed 게이트, VK-08 체인 연산자, SDK 오케스트레이터 전환, UPGRADE-REPORT

## v1.x ~ v2.x (2025 초기)

- **v1.0** — Gate Keeper + Gate Guard + Orchestrator + Tracker 기본 4 hook, 5종 파이프라인
- **v2.0 M001** — 비용 최적화(Opus→Sonnet), Auto 모드, Bash 완화, persona.md
- **v2.5 M002** — Hook 4→18개 확장

상세 구조/라인별 이력은 `git log --grep=v<version>`으로 조회.
