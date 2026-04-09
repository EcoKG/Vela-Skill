---
name: "vela:update"
description: "🔄 Vela 엔진 최신 버전으로 업데이트 — 글로벌 스킬(~/.claude/skills/vela)과 현재 워크스페이스의 .vela/ 를 함께 최신화합니다."
---

# /vela:update — Vela 엔진 업데이트

이 커맨드가 호출되면 Vela 엔진을 GitHub 최신 main 브랜치 기준으로 업데이트한다.

**동작 순서:**
1. 글로벌 스킬(`~/.claude/skills/vela/`) 업데이트 — 항상 수행
2. 현재 워크스페이스에 `.vela/`가 있으면 로컬도 함께 업데이트 — 자동 감지
3. 다른 워크스페이스에도 `.vela/`가 있다면 각 프로젝트에서 `/vela:update`를 실행해야 한다고 안내

## 실행 절차

### Step 1: 현재 워크스페이스 상태 확인

```bash
ls -d .vela 2>/dev/null && echo "LOCAL_VELA_EXISTS" || echo "LOCAL_VELA_MISSING"
```

현재 워크스페이스에 `.vela/`가 존재하는지 확인한다.

### Step 2: 업데이트 스크립트 실행

**Case A — 현재 워크스페이스에 `.vela/`가 있는 경우 (로컬 포함 업데이트):**

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/update.sh | bash -s -- --local
```

이 명령은 다음을 수행한다:
- 글로벌 스킬 업데이트 (`~/.claude/skills/vela/`)
- 서브스킬 플랫 설치 (`~/.claude/skills/vela-init/`, `vela-start/`, `vela-auto/`, `vela-analyze/`, `vela-git-clean/`, `vela-update/`)
- 글로벌 npm 의존성 업데이트 (playwright, sql.js, better-sqlite3)
- Playwright Chromium 바이너리 설치
- **현재 워크스페이스의 `.vela/` 디렉토리를 글로벌 스킬 기준으로 재동기화**

**Case B — 현재 워크스페이스에 `.vela/`가 없는 경우 (글로벌만 업데이트):**

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/update.sh | bash
```

글로벌 스킬만 업데이트한다. `.vela/`를 만들어야 한다면 `/vela:init`을 먼저 실행한다.

### Step 3: 결과 확인 및 안내

스크립트 실행 후 마지막 출력의 버전 번호(`v${VELA_VERSION}`)를 사용자에게 전달한다.

**반드시 다음 안내를 포함한다:**

```
✦ 글로벌 Vela 스킬이 최신 버전으로 업데이트되었습니다.

⚠️ 다른 워크스페이스에 .vela/ 가 설치되어 있다면, 각 프로젝트를 열고
   /vela:update 를 실행해서 로컬 .vela/ 도 최신화해야 합니다.

   현재 워크스페이스는 자동으로 업데이트되었습니다 (Case A) /
   현재 워크스페이스에는 .vela/ 가 없습니다. 필요하면 /vela:init 을 실행하세요 (Case B).
```

## 업데이트되는 파일

### 글로벌 스킬 (`~/.claude/skills/vela/`)
- `SKILL.md`, `README.md`, `package.json`
- `scripts/` (전체 교체)
- `templates/`, `references/` (전체 교체)
- `skills/` (전체 교체 + 서브스킬 플랫 설치)
- `.claude-plugin/`

### 로컬 워크스페이스 (`--local` 플래그, `.vela/` 존재 시)
- `.vela/cli/`, `.vela/shared/`, `.vela/agents/`
- `.vela/templates/`, `.vela/references/`
- `templates/`의 config.json, pipeline.json 등 (validate()가 누락 파일 자동 복구)

## 왜 엔진 CLI를 사용하지 않는가

`/vela:update`는 Vela 엔진 자체를 업데이트하는 유일한 명령이다. 엔진 CLI나 파이프라인에 의존하면 업데이트 대상 코드가 실행 중이어서 교체 불가능한 순환 의존성이 생긴다. 따라서 외부 `curl | bash` 스크립트로 업데이트한다.

## 트러블슈팅

- **`curl: command not found`** → `curl`을 시스템에 설치해야 한다 (`apt install curl` 등).
- **`git clone failed`** → 네트워크 또는 GitHub 접근 권한 확인.
- **`Native build failed` (better-sqlite3)** → 정상. sql.js(WASM)가 대체로 사용된다.
- **`Playwright chromium install failed`** → PDF 생성이 필요한 경우에만 영향. `npx playwright install chromium` 수동 실행 가능.
- **로컬 `.vela/`가 업데이트되지 않음** → Case A의 `--local` 플래그 포함 명령이 사용되었는지 확인.
