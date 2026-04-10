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
   - `scripts/shared/*` → `.vela/shared/` (유틸리티: constants.js, change-surface.js, sprint-manager.js, dep-analyzer.js, project-env.js)
   - `scripts/cli/*` → `.vela/cli/` (4개 CLI 도구: vela-engine.js, vela-analyze.js, vela-cost.js, vela-report.js)
   - `scripts/cache/*` → `.vela/cache/`
   - `scripts/agents/*` → `.vela/agents/` (PM + 10개 역할 에이전트, 서브디렉토리 포함)
   - `scripts/guidelines/*` → `.vela/guidelines/`
   - `scripts/install.js` → `.vela/install.js`
   - `scripts/statusline.sh` → `.vela/statusline.sh`
   - `templates/*` → `.vela/templates/`
   - `references/*` → `.vela/references/`

   > ⚠ **주의:** `skills/` 디렉토리는 복사하지 않는다.

3. **글로벌 훅 등록 및 에이전트 배포**
   ```bash
   node .vela/install.js
   node .vela/install.js verify
   ```
   install.js가 자동으로:
   - `~/.vela/hooks/`에 훅 스크립트 배포 (gate-keeper, gate-guard, stop)
   - `~/.claude/settings.json`에 전역 훅 등록 (모든 프로젝트에서 active pipeline 감지 시 자동 활성화)
   - `.claude/settings.local.json`에 permissions, agent, statusLine 설정 (훅 미포함)
   - `.claude/agents/`에 PM + 역할별 에이전트 파일 배포 (vela.md, vela-researcher.md 등)
   - `"agent": "vela"` 설정
   - `CLAUDE.md` 생성
   - ⛵ statusLine 등록

4. **초기화 확인**
   사용자에게 설치 결과를 보고한다.
