# ⛵ Vela — Sandbox Development Governance (v8.0)

**Vela**(돛자리)는 Claude Code의 모든 코드 변경을 **6단계 파이프라인**과 **fail-closed 훅**으로 통제하는 거버넌스 스킬이다. 엔진이 아니라 "언제·어떤 순서로·누구의 검증을 거쳐 코드를 수정할 수 있는가"를 강제하는 얇은 레이어다.

---

## 사상 (Philosophy)

1. **⛵ 통제된 자유** — 통제 없는 AI 자율성은 위험하다. Vela는 파이프라인 밖에서 소스 수정을 차단한다.
2. **🌟 이중 방어** — Gate Keeper(PreToolUse) + Gate Guard(PreToolUse) + Reviewer(Agent) + Permission deny/allow.
3. **🔭 추적 가능성** — 산출물(plan.md, review-*.md, approval-*.json, verification.md) + git 커밋 파이프라인 참조.
4. **✦ 구조로 강제** — 산출물이 없으면 다음 단계 불가. PM은 코드를 직접 작성할 수 없고 Executor 에이전트를 통해서만 가능.

---

## 빠른 시작

### 설치

Claude Code 2.1.107+ 에서 한 줄로 설치:

```
/plugin install vela@EcoKG/Vela-Skill
```

프로젝트 최초 사용 시 한 번만 초기화:

```
/vela:install
```

이 명령이 `.vela/config.json`, `.vela/templates/`, `.vela/state/` 등 프로젝트별 구조를 생성한다. 기존 v7.x curl 설치 사용자는 `/vela:install`이 자동으로 레거시 `~/.vela/hooks/`, `~/.claude/skills/vela*/`, `settings.json`의 `_velaId: vela-*` 엔트리를 정리한다(backup 생성).

업데이트:

```
/plugin update vela          # 플러그인 재빌드
/vela:install --resync       # 프로젝트 템플릿 재동기화
```

### 3개 슬래시 명령 (v8.0)

```
/vela:ship    — 기본 파이프라인 (6단계, 모든 일반 작업)
/vela:fix     — Target-First 정밀 수정 (<50 LOC diff, patch-spec 기반)
/vela:hotfix  — 문서/설정 수정 (4단계, plan/verify 생략)
```

**Deprecated**: `/vela:small`, `/vela:medium`, `/vela:large`, `/vela:ralph`는 `/vela:ship`으로 자동 리다이렉트되며 경고를 출력한다. v8.2에서 완전 제거 예정.

### 사용

```
/vela              # AskUserQuestion으로 ship/fix/hotfix 선택
/vela:ship OAuth 인증 추가
/vela:fix auth.js:42 null guard
/vela status       # 현재 파이프라인 상태
```

Vela는 `SessionStart` 훅으로 24h 캐시 버전 체크를 수행한다. 새 버전이 있으면 Claude가 "지금 업데이트할까요?"라고 묻는다. `curl install.sh/update.sh` 방식은 v8.0부터 deprecated이며 v8.2에서 제거 예정이다.

---

## 파이프라인 (v8.0)

```
✦──────────────────────────────────────────────────────────✦
│            ⛵ VELA SANDBOX  v8.0                          │
│                                                           │
│  🧭 PIPELINE (6 stages) ─────────────────────────        │
│  init → locate → plan → execute → verify → commit        │
│                                                           │
│  🤖 ROLE AGENTS (4) ─────────────────────────────        │
│  vela-researcher — /vela:analyze 전용 (3-mode)           │
│  vela-planner    — research + plan + self-check 통합     │
│  vela-executor   — TDD 구현 (test→implement→refactor)    │
│  vela-reviewer   — review + verify + diff-summary 통합   │
│                                                           │
│  🛡️ HOOKS (3) ────────────────────────────────────       │
│  gate    (PreToolUse; VK + VG 통합, M4c)                 │
│  stop    (Stop+SubagentStop+review-gate 통합, M4d)       │
│  session (SessionStart; version+context 통합, M4b)       │
✦──────────────────────────────────────────────────────────✦
```

### 3개 파이프라인 변형

| 파이프라인 | 단계 | 명령 | 용도 |
|---------|------|------|------|
| **ship** | init → locate → plan → execute → verify → commit | `/vela:ship` | 모든 일반 작업 (구 small/medium/large/ralph 통합) |
| **fix** | ship + plan 단계가 `mode=spec`으로 `patch-spec.md` 생성 | `/vela:fix` | 정밀 수정 (<50 LOC, file:line Before/After) |
| **hotfix** | init → locate → execute → commit | `/vela:hotfix` | 문서/설정 (plan/verify 생략) |

### Locate 단계 — 결정론적 좌표 식별 (LLM 0)

`vela-engine.js locate`는 ripgrep + git ls-files 기반으로 `targets.json`(primary/tests/blast_radius/confidence)을 생성한다. confidence: high → `project_mode: targeted`로 planner가 좁은 범위만 분석. confidence: low → exploratory 폴백.

### Plan 단계 — 아키텍처 명세서 필수

planner는 `plan.md`에 다음 섹션을 반드시 포함한다. 섹션 누락 또는 200bytes 미만 시 엔진이 transition을 차단한다.

```markdown
## Architecture    — 레이어, 의존성 방향, 모듈 분리
## Class Specification  — Interface/Class/Method 정의
## Test Strategy   — 테스트 케이스 목록
## Self-Check      — planner 자체 검증 (v8.0 — plan-checker 흡수)
```

### Execute 단계 — TDD Sub-Phase

```
test-write (Red) → implement (Green) → refactor (Refactor)
```

sub-phase는 `pipeline-state.json`의 `sub_phase` 필드로 추적되며 `vela-engine state`로 확인 가능.

### Verify 단계 — 에스컬레이션

`vela-reviewer` (mode=verify)가 테스트 + 린트 + 타입체크 + diff 요약을 한 번에 수행한다. **diff > 500 LOC** 시 Claude Code의 `/ultrareview` 번들 스킬로 자동 에스컬레이션.

---

## 역할 에이전트 (v8.0 — 4개)

| 에이전트 | 모델 | 역할 |
|---------|------|------|
| `vela-researcher` (mode=research/merge/analyze) | haiku/sonnet | `/vela:analyze` 전용. merge는 v7.2 M5 병렬 결과 통합 |
| `vela-planner` (mode=plan/spec) | **opus 4.7** (adaptive thinking) | research+plan+self-check 통합. spec은 patch-spec.md 작성 |
| `vela-executor` | sonnet (effort: xhigh) | TDD 구현 |
| `vela-reviewer` (mode=review/verify) | sonnet | 5차원 채점 + 테스트/린트/diff 요약 통합 |

### 소환 패턴

```
Agent(subagent_type="vela-executor", prompt="
  request: {요청}
  artifactDir: {artifactDir}
  planPath: {artifactDir}/plan.md
")
```

**모델 고정**: 각 에이전트의 frontmatter에 `model:` 필드로 고정. 생략 시 공식 기본값 `inherit`가 부모 세션 모델을 상속하여 비용 예측이 불가능해진다.

### 승인 메커니즘 (파일 기반)

- Reviewer가 `review-{step}.md` (X/25 점수) + `approval-{step}.json` 자동 생성
- 엔진 `exit_gate`가 `approval-{step}.json`의 `decision` 확인 → `approve`가 아니면 transition 차단
- REJECT 시 피드백을 executor에게 전달하여 재작업. `max_revisions` 소진 시 사용자 에스컬레이션

---

## 분석 — `/vela:analyze`

프로젝트를 선택적으로 분석하고 `.vela/artifacts/<ts>/analysis.md`에 markdown 요약을 저장한다 (v7.3-M1b: PDF 파이프라인 제거).

| 항목 | 방식 | 비용 |
|------|------|------|
| 📦 Dependencies | skill 내부 `npm audit --json` + `npm outdated --json` + Claude 요약 | 무료 |
| 🔒 Security / 🐛 Bugs / ⚡ Performance / 📐 Code Quality / 🏗️ Architecture | `Agent(vela-researcher, mode=analyze)` | 토큰 |

### Friction Report

```bash
node .vela/cli/vela-friction.js [--limit 500] [--json]
```

`.vela/state/gate-events.jsonl`을 집계해 상위 VK/VG 코드, 단계별 분포, 정책 조정 제안을 출력.

---

## 보안 시스템

### `vela-gate.js` (PreToolUse — v7.3-M4c 통합)

단일 PreToolUse 훅이 VK Keeper(Phase 1) + VG Guard(Phase 2) 로직을 순차 실행한다.

**Phase 1 — VK Keeper**

| 코드 | 규칙 |
|------|------|
| VK-01/02 | Vela CLI 외 Bash 차단. 안전한 읽기 명령은 허용 |
| VK-03/04 | 읽기전용 모드에서 Write/Edit 차단 |
| VK-05 | `.env`, `credentials.json`, `config.json` 차단 |
| VK-06 | 15개 시크릿 패턴 차단 |
| VK-07 | PM은 Read/Glob/Grep만 허용, Write/Edit 차단 |
| VK-08 | SAFE_BASH_READ 명령에서 체인 연산자(`&&`, `;`, `\|`) 차단 |
| VK-10 | write 모드에서 WebFetch/WebSearch 차단 (policy-driven) |
| M11 | research 단계에서 targets.json 범위 밖 Read 차단 (policy-driven) |

**Phase 2 — VG Guard**

| 코드 | 규칙 |
|------|------|
| VG-03 | 빌드/테스트 실패 시 `git commit` 차단 |
| VG-13 | `.vela/templates/pipeline.json` 직접 수정 차단 |
| VG-14 | Write 내용에 시크릿 패턴 감지 시 차단 |
| VG-15 | 연속 실패 5회 초과 시 circuit breaker 발동 |

### Permission Deny (절대 차단)

`rm -rf`, `git push --force`, `git reset --hard`, `git commit --no-verify`, `git clean -f` — `settings.local.json`의 deny 패턴.

### Fail-Closed 모델

모든 훅 오류 경로는 `exit 2`(차단)로 폴백. 정상 허용만 통과.

---

## 설치 구조

```
$HOME/.claude/skills/vela/       ← 글로벌 스킬
  ├── SKILL.md                   ← 스킬 진입점
  ├── scripts/
  │   ├── shared/                ← change-surface, project-env, worktree-manager, constants
  │   ├── cli/                   ← vela-engine, vela-cost, vela-report, vela-friction
  │   ├── agents/                ← vela.md (PM) + 4 역할 에이전트
  │   ├── hooks/                 ← 7 훅 (글로벌 배포)
  │   ├── install.js             ← FILE_MANIFEST 기반 설치/업그레이드
  │   └── statusline.sh          ← ⛵ 하단 바
  ├── templates/                 ← pipeline.json (v2.0), config.json, presets.json
  └── references/                ← gates-and-guards, cli-reference, interactive-ui

your-project/                    ← /vela:{ship|fix|hotfix} 실행 시 자동 구축
  ├── .vela/                     ← 프로젝트별 설치 (FILE_MANIFEST 복사)
  ├── .claude/settings.local.json ← permission deny/allow + agent + spinner + statusLine
  ├── .claude/agents/            ← vela.md + 4 역할 에이전트
  └── CLAUDE.md                  ← Vela 규칙 주입
```

---

## v7.2 Configuration (opt-in)

`.vela/config.json` — 모든 플래그 기본값은 V7 호환이며 필요한 기능만 활성화한다.

- `cache.ttl: "1h"` (env 필수: `export ENABLE_PROMPT_CACHING_1H=1`)
- `models.*` — 역할별 모델 라우팅 (default: sonnet, plan: opus, verify: haiku 등)
- `execution.parallelism` / `isolation: worktree` / `ralph_sentinel` — 병렬/격리/자율 루프 (v7.2 M4-M12)
- `mcp.context7` — 외부 라이브러리 docs 버전별 조회 (v7.2 M11)
- `gate_policy.event_log` — 훅 결정을 `gate-events.jsonl`에 기록, `vela-friction`으로 집계

상세: [`templates/config.json`](templates/config.json) + [CHANGELOG.md](CHANGELOG.md).

---

## 테스트

```bash
bash scripts/tests/test-fail-closed.sh       # Fail-closed 게이트
bash scripts/tests/test-chain-operators.sh   # 체인 연산자 차단 (VK-08)
bash scripts/tests/test-gate-keeper.sh       # VK-01~VK-08
bash scripts/tests/test-auto-mode.sh         # Auto 모드
bash scripts/tests/test-change-surface.sh    # 참조 무결성 검증
bash scripts/tests/test-gate-telemetry.sh    # gate-events.jsonl + gate_policy
```

---

## 버전 이력

전체 마일스톤 이력은 **[CHANGELOG.md](CHANGELOG.md)**를 참조. 커밋별 상세는 `git log`.

**현재 — v7.3 → v8.0 전환**: Opus 4.7 기준 슬림화. 파이프라인 13→6, 에이전트 10+→4, 명령 6→3, 총 -9,000 LOC.

---

## 라이선스

MIT License — Copyright (c) 2026 EcoKG
