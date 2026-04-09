# Gate Keeper & Gate Guard 상세

## Gate Keeper (수문장) — Claude Code PreToolUse 훅

`vela-gate-keeper.js`가 Claude Code PreToolUse 훅으로 동작. 모든 도구 호출 전에 실행되어 R/W 모드를 강제한다 (VK-01~10).

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

### Fail-Closed 모델

Gate Keeper 콜백의 모든 오류 경로(잘못된 입력, 미처리 예외)는 `exit 2`(차단)를 반환한다. 정상 허용만 `exit 0`(통과)를 반환한다.

### 모드별 허용 도구

| 모드 | 허용 | 차단 |
|------|------|------|
| read | Read, Glob, Grep, Agent | Edit, Write, NotebookEdit, Bash(쓰기) |
| write | Read, Write, Edit, NotebookEdit, Glob, Grep | Bash, WebFetch, WebSearch |
| readwrite | Read, Write, Edit, NotebookEdit, Glob, Grep, Agent | Bash(제한적) |
| rw-artifact | Read, Glob, Grep, Bash(읽기), Write(artifactDir만) | Edit, NotebookEdit |

## Gate Guard (가이드라인) — Claude Code PreToolUse 훅

`vela-gate-guard.js`가 파이프라인 단계별 가드 규칙을 강제한다 (VG-03, VG-13, VG-14, VG-15).

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
