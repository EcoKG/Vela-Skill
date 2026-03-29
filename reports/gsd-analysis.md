# GSD Pro vs Vela Engine — 종합 분석 리포트

## 1. GSD Pro 개요

**레포지토리**: [itsjwill/gsd-pro](https://github.com/itsjwill/gsd-pro) (55 stars)
**포지셔닝**: "The most powerful AI coding workflow for Claude Code"
**형태**: **CLI 도구 (Node.js)** + 에이전트 MD + 워크플로우 MD + 훅
**핵심 문제 해결**: Context Rot — Claude가 컨텍스트 윈도우를 채우며 품질이 떨어지는 현상

### CLI 도구 구조
```
get-shit-done/bin/
├── gsd-tools.cjs          ← 메인 CLI (50개 워크플로우의 공통 로직 통합)
└── lib/
    ├── commands.cjs        ← 명령어 라우팅
    ├── config.cjs          ← 설정 관리
    ├── core.cjs            ← 핵심 유틸리티
    ├── frontmatter.cjs     ← MD 프론트매터 파싱/수정
    ├── init.cjs            ← 워크플로우 초기화 (컨텍스트 자동 생성)
    ├── milestone.cjs       ← 마일스톤 관리
    ├── model-profiles.cjs  ← 모델 에스컬레이션 프로필
    ├── phase.cjs           ← 단계 추가/삽입/제거/완료
    ├── roadmap.cjs         ← 로드맵 동기화
    ├── state.cjs           ← STATE.md 프론트매터 ↔ JSON 변환
    ├── template.cjs        ← PLAN/SUMMARY/VERIFICATION 프리필
    └── verify.cjs          ← 산출물 검증
```

### 훅 (3개)
| 훅 | 역할 |
|----|------|
| `gsd-context-monitor.js` | 컨텍스트 사용량 모니터링 — 35% WARNING, 25% CRITICAL |
| `gsd-statusline.js` | 하단 상태바 |
| `gsd-check-update.js` | 업데이트 확인 |

**핵심 차이**: GSD의 CLI(`gsd-tools.cjs`)는 **에이전트가 호출하는 도구**다.
에이전트 MD에서 `gsd-tools init execute-phase`를 호출하면 CLI가 컨텍스트를 자동 생성하여 반환한다.
Vela의 `vela-engine.js`와 유사하지만, GSD는 **상태 관리가 MD 프론트매터 기반** (Vela는 JSON 기반).

---

## 2. GSD Pro 핵심 원리

### 2.1 Context Engineering
GSD의 가장 핵심적인 차별점. 각 에이전트가 **200k 토큰의 신선한 컨텍스트**를 받아 작업한다.
- 오케스트레이터: ~10-15% 컨텍스트만 사용 (조율만)
- 실행 에이전트: 100% 신규 컨텍스트 (이전 작업의 오염 없음)

### 2.2 Adaptive Context Loader (4-Tier)
| Tier | 토큰 | 로드 대상 |
|------|------|----------|
| 0 | ~200 | STATE.md 위치 정보, config.json |
| 1 | ~2,000 | ROADMAP, PROJECT 파일 |
| 2 | ~3,000 | 단계별 PLAN.md + 관련 히스토리 |
| 3-4 | 점진적 | 기존 코드베이스, 모든 요약 |

효과: 24,500 → 10,200 토큰 (58% 절감)

### 2.3 Model Router (자동 에스컬레이션)
| 모델 | 역할 | 에스컬레이션 |
|------|------|-------------|
| Haiku | 파일 확인, grep, YAML 파싱 | 실패 2회 → Sonnet |
| Sonnet | 코드 생성, 테스트, 문서화 | 파일 5개+ → Opus |
| Opus | 아키텍처, 복잡 디버깅, 전략 | — |

### 2.4 Wave 기반 병렬 실행
- 독립적 작업 → 같은 Wave → **병렬** 실행
- 의존적 작업 → 다음 Wave → **순차** 실행
- 각 Wave 완료 후 SUMMARY.md 검증 → 다음 Wave

### 2.5 XML 구조화 프롬프트
```xml
<task type="auto">
  <name>작업명</name>
  <files>대상 파일</files>
  <action>구체적 지시</action>
  <verify>검증 방법</verify>
  <done>완료 정의</done>
</task>
```

---

## 3. GSD Pro 구조

### 3.1 에이전트 시스템 (15개)
| 에이전트 | 역할 |
|---------|------|
| gsd-project-researcher | 프로젝트 초기 리서치 |
| gsd-phase-researcher | 단계별 리서치 |
| gsd-research-synthesizer | 리서치 결과 종합 |
| gsd-planner | 구현 계획 작성 |
| gsd-plan-checker | 계획 검증 (요구사항 대조) |
| gsd-executor | 코드 구현 (핵심) |
| gsd-verifier | 자동 검증 |
| gsd-debugger | 실패 진단 + 수정 |
| gsd-codebase-mapper | 코드베이스 구조 파악 |
| gsd-integration-checker | 통합 검증 |
| gsd-nyquist-auditor | 성능/복잡도 감사 |
| gsd-ui-researcher | UI 리서치 |
| gsd-ui-auditor | UI 감사 |
| gsd-ui-checker | UI 검증 |
| gsd-roadmapper | 로드맵 관리 |

### 3.2 워크플로우 (38개)
new-project → discuss → plan → execute → verify → complete-milestone
+ quick, autonomous, debug, cleanup, rollback, recover 등 유틸리티

### 3.3 산출물
```
.planning/
├── research/           # 리서치 결과
├── 1-CONTEXT.md        # 논의 결정사항
├── 1-RESEARCH.md       # 단계별 리서치
├── 1-1-PLAN.md         # 작업 계획 (XML)
├── 1-1-SUMMARY.md      # 실행 결과
├── 1-VERIFICATION.md   # 검증 결과
└── quick/              # ad-hoc 작업
```

---

## 4. GSD vs Vela 비교

### 4.1 공통점

| 항목 | GSD | Vela |
|------|-----|------|
| 파이프라인 기반 | 6단계 (discuss→plan→execute→verify) | 10단계 (init→research→...→finalize) |
| 멀티에이전트 | 15개 에이전트 MD | 6개 에이전트 트리 구조 |
| 모델 라우팅 | Haiku/Sonnet/Opus 자동 에스컬레이션 | Haiku/Sonnet/Opus 역할별 고정 |
| 산출물 기반 검증 | PLAN.md, SUMMARY.md, VERIFICATION.md | plan.md, review-*.md, approval-*.json |
| 원자적 커밋 | 작업당 커밋 | 파이프라인당 커밋 |
| Git 통합 | 원자적 커밋 | Branch + Conventional Commits |

### 4.2 CLI 도구 비교

| 항목 | GSD (`gsd-tools.cjs`) | Vela (`vela-engine.js`) |
|------|----------------------|------------------------|
| **상태 저장** | STATE.md 프론트매터 (YAML) | pipeline-state.json (JSON) |
| **컨텍스트 생성** | `gsd-tools init` → 워크플로우별 컨텍스트 자동 생성 | `vela-engine init` → 아티팩트 디렉토리 생성 |
| **템플릿** | PLAN/SUMMARY/VERIFICATION 프리필 | pipeline.json 정의 기반 |
| **검증** | `gsd-tools verify` → 산출물 구조 검증 | exit gate → 파일 존재 + decision 검증 |
| **훅 수** | 3개 (context-monitor, statusline, update-check) | 10개 (Gate Keeper, Guard, Orchestrator 등) |
| **컨텍스트 모니터링** | 35% WARNING, 25% CRITICAL (훅 기반) | 100/150/180 도구 호출 경고 (tracker 기반) |
| **모델 라우팅** | `model-profiles.cjs` (자동 에스컬레이션) | 역할별 고정 |

### 4.3 GSD가 더 나은 점

| 항목 | GSD 방식 | Vela 현재 | 상태 |
|------|---------|-----------|------|
| **Context Rot 해결** | Adaptive Context Loader (4-Tier, 58% 절감) | **4-Tier 컨텍스트 로딩 규칙 적용** (pm/team-rules.md) | ✅ 흡수 |
| **Wave 병렬 실행** | 의존성 분석 → 자동 Wave 그룹화 → 병렬 | CrossLayer만 병렬, 의존성 분석 없음 | 📋 계획 |
| **자동 에스컬레이션** | Haiku 실패 → Sonnet → Opus 자동 전환 | 역할별 고정, 실패 시 수동 | 📋 계획 |
| **Discuss 단계** | 회색 영역 식별 + 도메인별 가이드 질문 | **도메인별 회색영역 가이드 적용** (pm/prompt-optimizer.md) | ✅ 흡수 |
| **Quick Mode** | 경량 ad-hoc 작업 | trivial 파이프라인 | 동등 |
| **XML 구조화 프롬프트** | task/files/action/verify/done 구조 | **XML `<task>` 구조 소환 프롬프트** (pm/team-rules.md) | ✅ 흡수 |
| **자동 디버깅** | debugger 에이전트 + 실패 진단 | 수동 | 📋 계획 |
| **에이전트 수** | 15개 (세분화) | 7개 (트리 구조) | Vela 충분 |

### 4.4 Vela가 더 나은 점

| 항목 | Vela 방식 | GSD 방식 |
|------|----------|---------|
| **Hook 기반 강제** | Gate Keeper + Gate Guard (exit(2)로 물리 차단) | CLAUDE.md + 프롬프트 의존 |
| **PM 소스 차단** | VK-07 훅으로 PM 직접 접근 물리 차단 | `--dangerously-skip-permissions` 권장 (보안 약화) |
| **경쟁가설 디버깅** | Teammate 3명 SendMessage 교차 검증 | 병렬 리서치만 (소통 없음) |
| **Teammate 소통** | SendMessage로 실시간 조율 | 에이전트 간 소통 없음 (각자 독립) |
| **파일 소유권** | 팀원당 담당 파일 명시 + 충돌 방지 | 없음 |
| **Conflict Manager** | 전담 에이전트로 git 충돌 관리 | 없음 |
| **Git Worktree** | isolation: "worktree"로 격리 실행 | 없음 |
| **블록 코드 복구** | VK-*/VG-* 코드 + 자동 복구 테이블 | 없음 |
| **보안** | 시크릿 감지 (15패턴), 민감파일 보호 | `--dangerously-skip-permissions` |

---

## 5. GSD에서 Vela가 흡수할 수 있는 것

### 5.1 Adaptive Context Loader (높은 우선순위)
현재 Vela의 TOC 기반 로딩을 **4-Tier 시스템으로 확장**:
- Tier 0: pipeline-state.json만 (항상)
- Tier 1: 로드맵 수준 (plan 단계)
- Tier 2: 관련 산출물만 (execute 단계)
- Tier 3: 필요한 소스 코드 (에이전트가 판단)

### 5.2 자동 모델 에스컬레이션 (높은 우선순위)
Haiku 실패 → Sonnet → Opus **자동 전환**. 현재 역할별 고정을 유지하되, 실패 시 상위 모델로 재시도.

### 5.3 Wave 기반 의존성 분석 (중간 우선순위)
plan.md의 Task Distribution에서 **의존성 그래프를 자동 추출**하여 병렬 가능한 작업을 Wave로 그룹화.

### 5.4 XML 구조화 프롬프트 (중간 우선순위)
에이전트 소환 시 XML 구조로 태스크를 정의하면 정밀도 향상:
```xml
<task>
  <files>src/api/auth.js</files>
  <action>JWT 검증 미들웨어 추가</action>
  <verify>npm test -- --grep "auth"</verify>
  <done>모든 인증 테스트 통과</done>
</task>
```

### 5.5 컨텍스트 사용량 모니터링 (중간 우선순위)
현재 Vela는 도구 호출 횟수(100/150/180)로 경고. GSD는 **실제 컨텍스트 잔여 비율**(35%/25%)로 경고.
statusline에서 컨텍스트 메트릭을 읽어 실제 잔여량 기반 경고로 전환하면 정밀도 향상.

### 5.6 Discuss 단계 강화 (낮은 우선순위)
현재 프롬프트 옵티마이저를 **도메인별 가이드 질문**으로 확장:
- UI 작업 → 레이아웃, 인터랙션, 빈 상태 질문
- API 작업 → 응답 형식, 에러 처리, 인증 질문
- DB 작업 → 스키마, 마이그레이션, 인덱스 질문

---

## 6. GSD Pro의 명확한 단점

### 6.1 보안 취약점 — 치명적
- `--dangerously-skip-permissions` 사용을 **공식 권장** → 모든 Bash 명령 무제한 실행
- 시크릿 감지 없음, 민감파일 보호 없음
- 에이전트가 `rm -rf`, `git push --force` 등 파괴적 명령 실행 가능
- **Vela 대비**: Hook exit(2)로 물리 차단, 15개 시크릿 패턴 감지, Permission Deny

### 6.2 에이전트 간 소통 불가 — 구조적 한계
- 15개 에이전트가 모두 **독립 실행** — SendMessage 없음
- 리서처 4명이 병렬 실행하지만 서로의 결과를 모름
- Plan Checker가 Planner의 의도를 이해 못 함 (산출물만 검증)
- **Vela 대비**: Teammate SendMessage로 실시간 소통, 경쟁가설 교차 검증

### 6.3 프롬프트 의존 — 강제력 없음
- CLAUDE.md와 에이전트 MD의 지시는 **무시 가능**
- 파이프라인 순서를 코드로 강제하지 않음 (단계 건너뛰기 가능)
- approval/review 메커니즘이 없음 — 실행 후 자동 통과
- **Vela 대비**: Gate Guard exit(2)로 물리 차단, approval-{step}.json 없으면 transition 불가

### 6.4 Context Monitor의 한계
- 컨텍스트 잔여량을 **statusline 브릿지 파일**에서 읽음 — statusline이 갱신되지 않으면 무용
- 60초 이상 된 메트릭은 무시 — 갱신 주기 의존
- WARNING/CRITICAL만 있고, **자동 대응**(상태 저장, 단계 전이)은 없음

### 6.5 Autonomous 모드의 위험
- 갭 폐쇄(gap closing) 1회 재시도 — 실패 시 사용자 개입 필요
- 검증 없이 다음 단계로 넘어갈 수 있음 (passed 판정이 자동)
- `--dangerously-skip-permissions`와 결합 시 **무인 파괴적 명령 실행** 가능

### 6.6 상태 관리 — MD 프론트매터의 한계
- STATE.md의 프론트매터(YAML)로 상태 관리 — **구조적 검증이 약함**
- JSON Schema 검증 불가, 타입 안전성 없음
- 동시 수정 시 충돌 가능 (여러 에이전트가 STATE.md를 동시에 읽기)

---

## 7. Vela가 GSD에서 흡수할 구체적 개선사항

### 7.1 즉시 적용 (코드 변경)

| # | 개선 | 효과 | 구현 위치 |
|---|------|------|----------|
| A | **컨텍스트 Tier 로딩** — 에이전트 소환 시 단계별 필수 컨텍스트만 프롬프트에 포함 | 토큰 절감 | pm/team-rules.md |
| B | **XML 구조화 태스크** — 에이전트 소환 프롬프트에 `<task>` 구조 적용 | 정밀도 향상 | pm/team-rules.md |
| C | **도메인별 Discuss 가이드** — 프롬프트 옵티마이저에 UI/API/DB 도메인별 질문 | 요구사항 정밀화 | pm/prompt-optimizer.md |

### 7.2 중기 적용 (신규 기능)

| # | 개선 | 효과 | 구현 위치 |
|---|------|------|----------|
| D | **자동 모델 에스컬레이션** — 에이전트 실패 시 상위 모델로 재시도 | 성공률 향상 | vela.md + vela-engine.js |
| E | **Wave 의존성 분석** — plan.md Task Distribution에서 의존성 그래프 → 자동 병렬 | 실행 속도 | vela-engine.js |

---

## 8. 결론

### GSD Pro의 강점
**Context Engineering** — 컨텍스트 로트를 시스템적으로 해결하는 4-Tier 로딩과 모델 라우팅.
**에이전트 세분화** — 15개 에이전트로 각 역할을 명확히 분리.
**Wave 병렬화** — 의존성 분석 기반 자동 병렬 실행.

### Vela의 강점
**Hook 기반 물리적 강제** — 프롬프트 의존이 아닌 코드 레벨 차단 (GSD에는 없음).
**Teammate 소통** — 에이전트 간 실시간 소통 (GSD는 각자 독립 실행).
**보안** — 시크릿 감지, 민감파일 보호, PM 소스 접근 차단 (GSD는 `--dangerously-skip-permissions` 권장).

### 최종 판단
GSD는 **"AI에게 최적의 컨텍스트를 주는 것"**에 집중하고,
Vela는 **"AI가 올바른 순서로 올바른 행동만 하게 강제하는 것"**에 집중한다.

두 시스템은 **상호 보완적**이다. Vela에 GSD의 Context Loader와 모델 에스컬레이션을 흡수하면,
**"최적의 컨텍스트 + 물리적 강제 + 팀 소통"**을 모두 갖춘 시스템이 된다.
