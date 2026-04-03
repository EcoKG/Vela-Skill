---
name: "vela:init"
description: "⛵ Vela 환경 구축 — 프로젝트에 Vela 샌드박스 엔진을 설치합니다. 훅, CLI, 에이전트 파일을 배포하고 파이프라인 시스템을 활성화합니다."
---

# /vela:init — Vela 환경 구축

이 커맨드가 호출되면 현재 프로젝트에 Vela 환경을 구축한다.

## 초기화 절차

1. **디렉토리 구조 생성**
   프로젝트 루트에 `.vela/` 디렉토리를 생성한다.

2. **스크립트 배포**
   이 스킬의 `scripts/` 디렉토리에 있는 파일들을 `.vela/`로 복사한다:
   - `scripts/shared/*` → `.vela/shared/` (SDK 모듈 9개 + constants.js)
   - `scripts/cli/*` → `.vela/cli/` (6개 CLI 도구)
   - `scripts/cache/*` → `.vela/cache/`
   - `scripts/agents/*` → `.vela/agents/` (서브디렉토리 포함: `pm/`, `researcher/`, `executor/`, `planner/`, `reviewer/`, `conflict-manager/`)
   - `scripts/guidelines/*` → `.vela/guidelines/`
   - `scripts/install.js` → `.vela/install.js`
   - `scripts/statusline.sh` → `.vela/statusline.sh`
   - `templates/*` → `.vela/templates/`
   - `references/*` → `.vela/references/`
   - `test-fixtures/*` → `.vela/test-fixtures/` (분석 보고서 샘플 데이터)

   > ⚠ **주의:** `skills/` 디렉토리는 복사하지 않는다. skills는 스킬 저장소에만 존재하며 `.vela/`나 `~/.claude/skills/`에 복사하면 자동완성 중복이 발생한다.

3. **훅 등록**
   ```bash
   node .vela/install.js
   node .vela/install.js verify
   ```
   install.js가 자동으로:
   - `.claude/settings.local.json`에 훅 + permission(deny/allow) 등록
   - `.claude/agents/vela.md` 배포 (기본 에이전트)
   - `"agent": "vela"` 설정
   - `CLAUDE.md` 생성
   - ⛵ statusLine 등록

4. **초기화 확인**
   사용자에게 설치 결과를 보고한다.
