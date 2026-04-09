# Gate Keeper & Gate Guard 상세

## Gate Keeper (수문장) — Claude Code PreToolUse 훅

`vela-gate-keeper.js`가 Claude Code PreToolUse 훅으로 동작. 모든 도구 호출 전에 실행되어 R/W 모드를 강제한다 (VK-01~08).

### 게이트 규칙

| 게이트 | 코드 | 규칙 | 동작 |
|--------|------|------|------|
| GATE 1 | VK-01, VK-02 | Bash 차단 | Vela CLI 명령 외 Bash 사용 차단. 안전한 읽기 명령(ls, git status 등)은 모든 모드에서 허용. 활성 파이프라인 시 git/gh 명령 허용 (Gate Guard가 단계별 제한) |
| GATE 2 | VK-03, VK-04 | 모드 강제 | 읽기전용 모드에서 Write/Edit 차단. `.vela/` 내부 파일은 예외 (pipeline-state.json 제외) |
| GATE 3 | VK-05 | 민감파일 보호 | .env, credentials.json, config.json 등 민감 파일 쓰기 차단 |
| GATE 4 | VK-06 | 시크릿 감지 | API 키, 토큰, 비밀키 등 15개 패턴 감지 시 쓰기 차단 |
| GATE 5 | — | 경로 경고 | node_modules 등 제외 경로 쓰기 시 경고 (차단 아님) |
| GATE 6 | VK-07 | PM 속독 | PM은 Read/Glob/Grep 허용, Write/Edit 차단. delegation.json 검증 |
| GATE 7 | VK-08 | 체인 연산자 차단 | SAFE_BASH_READ 명령에서 `&&`, `||`, `;`, `|` 연산자 감지 시 차단 (`ls && rm -rf /` 방지) |

### Fail-Closed 모델

Gate Keeper 콜백의 모든 오류 경로(잘못된 입력, 미처리 예외)는 `permissionDecision: 'deny'`를 반환하여 도구를 차단한다. 정상 허용만 `undefined`(통과)를 반환한다.

### 모드별 허용 도구

| 모드 | 허용 | 차단 |
|------|------|------|
| read | Read, Glob, Grep, Agent | Edit, Write, NotebookEdit, Bash(쓰기) |
| write | Read, Write, Edit, NotebookEdit, Glob, Grep | Bash |
| readwrite | Read, Write, Edit, NotebookEdit, Glob, Grep, Agent | Bash(제한적) |

## Gate Guard (가이드라인) — SDK 단계별 도구 제어

SDK 오케스트레이터가 단계별 도구 화이트리스트와 `disallowedTools`로 파이프라인 순서를 강제한다. 무시, 우회, 변형 불가.

### 가드 규칙

| 가드 | 코드 | 규칙 |
|------|------|------|
| GUARD 0 | VG-00 | 파이프라인 중 TaskCreate/TaskUpdate/TaskList 차단 |
| GUARD 0.5 | — | 비-research 단계에서 5회 이상 Read 경고 (차단 아님) |
| GUARD 1 | VG-01 | research.md 없이 plan.md 작성 불가 |
| GUARD 2 | VG-02, VG-05 | execute 단계 전 소스코드 수정 불가 + pipeline-state.json 보호 + config.json 쓰기 차단 |
| GUARD 3 | VG-03 | 빌드/테스트 실패 시 git commit 불가. corrupt signals file 시 복구 안내 (tracker-signals.json 삭제) |
| GUARD 4 | VG-04 | verification.md 없이 report.md 작성 불가 |
| GUARD 5 | VG-05 | pipeline-state.json 직접 수정 불가 |
| GUARD 6 | VG-06 | 단계별 리비전 한도 초과 시 차단 |
| GUARD 7 | VG-07 | execute/commit/finalize에서만 git commit 허용 |
| GUARD 8 | VG-08 | verify 완료 전 git push 차단 |
| GUARD 9 | — | 보호 브랜치 직접 커밋 경고 (차단 아님) |
| GUARD 11 | VG-11 | 비-team 단계에서 approval-*.json / review-*.md 작성 차단 (team 단계에서만 허용) |
| GUARD 12 | VG-12 | execute 단계에서 PM 직접 소스 수정 차단 — SDK Agent 위임 강제 (delegation.json 검증) |

### Fail-Closed 모델

Gate Guard의 모든 오류 경로(잘못된 입력, 미처리 예외)는 `permissionDecision: 'deny'`를 반환하여 도구를 차단한다. 정상 허용만 통과.

### Permission Deny 규칙 (절대 차단)

- `rm -rf`, `rm -r`, `git push --force`, `git reset --hard`, `git commit --no-verify`, `git clean -f`

이 규칙들은 settings.local.json의 deny 패턴으로 등록되어 SDK와 무관하게 Claude Code 레벨에서 절대 차단된다.

### 차단 시 자동 복구 (Block Recovery)

```
SDK Agent: src/auth.js 수정 시도
  ↓
Guard: 🌟 [Vela] ✦ BLOCKED [VG-02]: Source code modification before execute step.
       Recovery: Complete steps first: research → plan → execute
  ↓
오케스트레이터: 차단 감지 → 올바른 단계로 전이
```
