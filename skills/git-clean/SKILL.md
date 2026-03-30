---
name: git-clean
description: "🧹 Git 정리 — 프로젝트의 불필요한 추적 파일, 머지된 브랜치, 캐시를 스캔하고 사용자 확인 후 정리합니다."
---

# /vela:git-clean — Git 프로젝트 정리

이 커맨드가 호출되면 현재 프로젝트의 git 상태를 스캔하고, 정리할 항목을 사용자에게 보여준 뒤 승인을 받고 실행한다.

**원칙: 무조건 삭제하지 않는다. 항상 먼저 보여주고, 사용자가 선택한 것만 실행한다.**

## 실행 절차

### Step 1: 스캔

```bash
node .vela/cli/vela-engine.js clean-scan
```

이 명령은 6가지 항목을 스캔하고 JSON으로 결과를 반환한다:
- `trackedIgnored`: .gitignore에 있지만 git이 추적 중인 파일
- `mergedBranches`: main에 이미 머지된 vela/ 브랜치
- `ignoredFiles`: 디스크에 남아있는 무시된 빌드/캐시 파일
- `staleArtifacts`: 7일+ 된 완료/취소 파이프라인 아티팩트
- `cacheFiles`: .vela/cache/ 내 DB 파일
- `prunableRefs`: 원격에서 삭제된 브랜치 참조

### Step 2: 결과 보고

스캔 결과를 사용자에게 보기 좋게 표시한다:

```
🧹 Git Clean 스캔 결과

📋 Tracked-but-ignored (git 추적 해제 대상): 2개
   - .env.local
   - dist/bundle.js

🌿 머지된 vela/ 브랜치: 2개
   - vela/fix-auth-1430
   - vela/add-logging-0915

🗑️ 무시된 빌드/캐시 파일: 15개
   - node_modules/
   - dist/
   - ...

📦 오래된 아티팩트 (7일+): 1개
   - 2026-03-20_jwt-auth (completed, 10일)

💾 Vela 캐시: 1개
   - vela-cache.db (156KB)

🔗 원격 브랜치 정리: 3개
```

`totalItems`가 0이면:
```
✅ 프로젝트가 깨끗합니다. 정리할 항목이 없습니다.
```
→ 여기서 종료.

### Step 3: 사용자 확인

AskUserQuestion으로 **복수 선택(allowMultiple: true)**을 사용한다.
발견된 카테고리만 선택지에 표시한다 (빈 카테고리는 생략).

### Step 4: 실행

사용자가 선택한 카테고리를 쉼표로 연결하여 실행:

```bash
node .vela/cli/vela-engine.js clean-exec --categories tracked,branches,ignored
```

카테고리 값:
- `tracked` — 추적 해제 + 자동 커밋
- `branches` — 머지된 vela/ 브랜치 삭제
- `ignored` — 무시된 빌드/캐시 파일 삭제 (git clean -fdX)
- `artifacts` — 오래된 아티팩트 삭제
- `cache` — Vela 캐시 DB 삭제
- `prune` — 원격 브랜치 참조 정리

### Step 5: 완료 보고

실행 결과의 `actions` 배열을 읽고 사용자에게 보고한다.

## 왜 엔진 CLI를 사용하는가

Vela의 Gate Keeper와 Gate Guard는 **파이프라인 외부에서의 bash/git 명령을 차단**한다.
`node .vela/cli/vela-engine.js`는 Gate Keeper의 허용 목록에 있으므로 차단되지 않는다.
따라서 git-clean의 모든 git 조작은 엔진 CLI를 통해 수행한다.
