# Gate Keeper & Gate Guard 상세

> v7.3-M4c (2026-04-17): Gate Keeper(`vela-gate-keeper.js`) + Gate Guard(`vela-gate-guard.js`)가 **`vela-gate.js` 단일 PreToolUse 훅**으로 통합되었다. 두 "phase"의 논리는 동일하며 문서 구조는 원본 VK/VG 분류를 유지한다. 통합 훅은 Phase 1(Gate Keeper VK-* 체크) → Phase 2(Gate Guard VG-* 체크) 순으로 실행하며, 어느 phase든 차단 조건을 만나면 `exit 2`로 즉시 종료한다.

## Gate Keeper (수문장) — Phase 1 (vela-gate.js 내부)

`vela-gate.js`의 Phase 1이 Claude Code PreToolUse 훅 진입 직후 실행. 모든 도구 호출 전에 실행되어 R/W 모드를 강제한다 (VK-01~10).

### 게이트 규칙

| 게이트 | 코드 | 규칙 | 동작 |
|--------|------|------|------|
| GATE 1 | VK-01, VK-02 | Bash 차단 | Vela CLI 명령 외 Bash 사용 차단. 안전한 읽기 명령(ls, git status 등)은 모든 모드에서 허용. 활성 파이프라인 시 git/gh 명령 허용 |
| GATE 2 | VK-03, VK-04 | 모드 강제 | 읽기전용 모드에서 Write/Edit 차단. `.vela/` 내부 파일은 예외 (pipeline-state.json 제외) |
| GATE 3 | VK-05 | 민감파일 보호 | .env, credentials.json, config.json 등 민감 파일 쓰기 차단 |
| GATE 4 | VK-06 | 시크릿 감지 | API 키, 토큰, 비밀키 등 15개 패턴 감지 시 쓰기 차단 |
| GATE 5 | — | 경로 경고 | node_modules 등 제외 경로 쓰기 시 경고 (차단 아님) |
| GATE 6 | VK-07 | PM 속독 | PM은 Read/Glob/Grep 허용, Write/Edit 차단 (read 모드 단계: init/commit/plan-check 등) |
| GATE 7 | VK-08 | 체인 연산자 차단 | SAFE_BASH_READ 명령에서 `&&`, `||`, `;`, `|` 연산자 감지 시 차단 (`ls && rm -rf /` 방지) |
| GATE 8 | VK-10 | write 모드 네트워크 차단 | write 모드(plan/finalize 단계)에서 WebFetch/WebSearch 차단 — 웹 조회는 research 단계에서 수행 |

> **NOTE (V6)**: VK-09 제거됨. V6에서 PM은 `Agent(subagent_type=...)` 도구로 역할 에이전트를 직접 소환한다. Agent 도구 차단은 파이프라인 실행을 막으므로 VK-09는 불필요.

### Fail-Closed 모델 (3계층)

Gate Keeper/Guard는 차단 시 다음 3가지 계층 중 하나를 사용한다. Fail-closed는 공통 — 오류/위반은 모두 차단된다.

| 계층 | 출력 | 예시 | 사용 시점 |
|------|------|------|----------|
| **Structured deny** | stderr `[VK-XX] 사유 — 복구: …` + `exit 2` | VK-01/02/04/08/10, M11, VG-03/15 | 일반 정책 위반 — Claude가 코드와 복구 힌트를 읽고 다음 행동을 결정 |
| **Silent hard-block** | stderr 없음 + `exit 2` | VG-13, VG-14, 빈/corrupt stdin | 정보 누설이 위험한 위반 (config 변조, 시크릿 탐지). 이유를 공개하지 않음 |
| **Ask (opt-in)** | stdout `{decision:"ask", reason:...}` + `exit 0` | `gate_policy`에서 `ask`로 설정된 규칙 | 사용자 확인 UI 노출 — 완전 차단 대신 인터랙티브 검증 |

모든 차단 이벤트는 `.vela/state/gate-events.jsonl`에 한 줄 JSON으로 기록된다 (`code/tool/step/mode/decision/summary/ts`). `node .vela/cli/vela-friction.js` 으로 집계 가능 (v7.3-M1b부터 전용 CLI).

### gate_policy (정책 설정)

`.vela/config.json`의 `gate_policy` 섹션으로 일부 규칙의 강도를 조절할 수 있다:

```json
"gate_policy": {
  "chain_operator":   "block",  // block(기본) | ask | allow — VK-08
  "web_in_write":     "block",  // block(기본) | ask         — VK-10
  "researcher_scope": "block",  // block(기본) | ask | warn  — M11
  "event_log":        true      // (예약)
}
```

- `block` — 기존 동작 (structured deny + exit 2)
- `ask`   — stdout JSON `{decision:"ask"}` 로 사용자 확인 UI 노출 + exit 0
- `allow` — 차단하지 않고 텔레메트리(`decision:"warn"`)만 기록 (VK-08만 지원)
- `warn`  — M11 전용: scope 밖이어도 Read 허용하되 텔레메트리에 기록

기본값은 현재(v7.1) 동작과 동일. 프로젝트별로 friction이 과도하면 `ask`로 조절하여 **완전차단 없는 강제**를 달성할 수 있다.

### 모드별 허용 도구

| 모드 | 허용 | 차단 |
|------|------|------|
| read | Read, Glob, Grep, Agent | Edit, Write, NotebookEdit, Bash(쓰기) |
| write | Read, Write, Edit, NotebookEdit, Glob, Grep | Bash, WebFetch, WebSearch |
| readwrite | Read, Write, Edit, NotebookEdit, Glob, Grep, Agent | Bash(제한적) |
| rw-artifact | Read, Glob, Grep, Bash(읽기), Write(artifactDir만) | Edit, NotebookEdit |

## Gate Guard (가이드라인) — Phase 2 (vela-gate.js 내부)

`vela-gate.js`의 Phase 2가 Phase 1(Gate Keeper)이 차단하지 않은 경우에만 실행되어 파이프라인 단계별 가드 규칙을 강제한다 (VG-03, VG-13, VG-14, VG-15).

> **NOTE (V6)**: SDK 오케스트레이터는 제거되었다. V6에서 PM(vela.md)이 `Agent(subagent_type=...)` 도구로 직접 각 단계를 실행한다.

### 가드 규칙

| 가드 | 코드 | 규칙 |
|------|------|------|
| GUARD 3 | VG-03 | 빌드/테스트 실패 시 git commit 불가. corrupt tracker-signals.json 시 복구 안내 |
| GUARD 13 | VG-13 | `.vela/templates/pipeline.json` 직접 수정 차단 (config tampering 방지) |
| GUARD 14 | VG-14 | Write 도구 내용에 시크릿 패턴 감지 시 차단 |
| GUARD 15 | VG-15 | 연속 실패 5회 초과 시 circuit breaker 발동 — 모든 도구 차단 |

> **NOTE (V6)**: VG-12 제거됨. V6에서 PM은 소스 코드를 직접 수정하지 않고 `Agent(subagent_type="vela-executor")`로 위임한다. PM의 쓰기 보호는 VK-07(gate-keeper)이 담당.

### Fail-Closed 모델

Gate Guard의 모든 오류 경로(잘못된 입력, 미처리 예외)는 `exit 2`(차단)를 반환한다.

### Permission Deny 규칙 (절대 차단)

`settings.local.json`의 deny 패턴으로 등록되어 Claude Code 레벨에서 절대 차단:

- `rm -rf`, `rm -r`, `git push --force`, `git reset --hard`, `git commit --no-verify`, `git clean -f`

### 차단 시 자동 복구 (Block Recovery)

```
PM: Agent(subagent_type="vela-executor") 호출 → executor가 src/auth.js 수정 시도
  ↓
Guard(VG-14): 시크릿 패턴 감지 → BLOCKED
  ↓
PM: 차단 감지 → .vela/agents/pm/block-recovery.md 참조 → 올바른 복구 경로 실행
```

---

## 엔진 Exit Gate — transition 차단

`vela-engine.js`의 `checkExitGate()`가 단계 전이 시점에 검증하는 산출물 gate. 실패하면 `transition`이 차단되고 `missing` 리스트가 반환된다. Gate Keeper/Gate Guard와 달리 **산출물 기반 정적 검증**이다.

| Gate 이름 | 검증 내용 | 사용 단계 |
|---|---|---|
| `artifact_dir_created` | `{artifactDir}/`가 생성되었는가 | init |
| `git_clean` | working tree가 clean인가 (init 시점) | init |
| `research_md_exists` | `research.md`가 생성되었는가 | research |
| `plan_md_exists` | `plan.md`가 생성되었는가 | plan |
| `plan_architecture_complete` | plan.md에 `## Architecture / ## Class Specification / ## Test Strategy` 섹션 각 200 bytes 이상 | plan (standard/quick) |
| `plan_check_pass` | `plan-check.md` 생성 | plan-check (standard) |
| `user_approved` | checkpoint 단계에서 사용자 record 완료 | checkpoint |
| `branch_created` | git branch 생성 기록 | branch |
| `implementation_complete` | **동적 해석** — `approval-{current_step}.json`에 `decision: approve` (v7.0 일반화: execute/patch 공용) | execute, patch |
| `review_exists` | `review-{current_step}.md`가 존재하는가 | execute, patch, spec |
| `approval_exists` | `approval-{current_step}.json`에 `decision: approve` | research, plan, spec |
| `verification_md_exists` | `verification.md`가 생성되었는가 | verify |
| `ref_integrity` | `change-surface.js` 참조 무결성 분석 → broken ref 0 | execute, patch, verify |
| **`targets_json_exists`** (v6.1) | `targets.json`이 생성되었는가 | locate (모든 scale 공통) |
| **`patch_spec_complete`** (v7.0) | `patch-spec.md`에 `## Before`, `## After`, `## Explicitly out of scope` 3개 섹션 모두 존재 | spec (surgical) |
| `changes_committed` | commit 단계에서 commit hash 기록 | commit |
| `diff_summary_exists` | `diff-summary.md` 생성 | diff-summary (standard) |
| `learning_md_exists` | `learning.md` 생성 | learning (standard) |
| `report_md_exists` | `report.md` 생성 | finalize |

이 gate들은 GUARD 코드가 없다 — PM 오케스트레이션 위반이 아니라 파이프라인 *완성도*를 검증하는 mechanism이다. 누락 시 `transition`이 에러를 반환하고 PM이 해당 산출물을 재작성하도록 안내한다.
