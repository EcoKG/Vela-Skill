---
description: "⛵ 현재 프로젝트에 Vela 초기화 — .vela/ 디렉토리 생성 + 레거시 정리"
argument-hint: "[--cleanup-legacy=auto|skip] [--resync]"
allowed-tools: ["Bash", "AskUserQuestion"]
---

# /vela:install — 프로젝트 .vela/ 부트스트랩 (v8.0)

Claude Code 플러그인으로 설치된 Vela를 **현재 프로젝트**에 초기화한다. 이 명령은 프로젝트별 `.vela/` 디렉토리(파이프라인 상태, config, 아티팩트)를 최초 구축한다.

## 언제 실행하는가

- 새 프로젝트에서 `/vela:ship`, `/vela:fix`, `/vela:hotfix`를 처음 사용하기 전
- 기존 v7.x curl 설치에서 v8.0 플러그인으로 마이그레이션할 때 (`--cleanup-legacy` 자동 실행)
- `/vela:update` 이후 템플릿을 재동기화할 때 (`--resync`)

## 절차

1. **Vela 플러그인 환경 확인**
   - `CLAUDE_PLUGIN_ROOT` 환경변수 존재 여부 확인
   - 미설정이면 "이 명령은 Claude Code 플러그인 컨텍스트에서만 작동합니다. `/plugin install vela@EcoKG/Vela-Skill`을 먼저 실행하세요" 메시지 표시

2. **엔진 호출**

   ```bash
   vela-engine init-project
   ```

   (플래그 전달 예)
   ```bash
   vela-engine init-project --cleanup-legacy=auto --resync
   ```

3. **생성되는 구조**

   ```
   {project}/.vela/
   ├── config.json             ← templates/config.json 복사 (사용자 커스터마이징 영역)
   ├── templates/              ← pipeline.json, presets.json, guidelines/, plan-templates/
   ├── references/             ← gates-and-guards, cli-reference, interactive-ui, messages-en
   ├── state/
   │   └── workspace.json      ← projectRoot + pluginRoot + version pin
   ├── artifacts/              ← 빈 디렉토리 (파이프라인 실행 시 채워짐)
   ├── learnings/              ← 빈 디렉토리
   └── .gitignore              ← artifacts/ cache/ state/ learnings/ 제외
   ```

4. **레거시 정리 (기본 on)**

   pre-plugin(v7.x) 설치 잔재가 있으면 자동 제거하고 stderr에 보고:
   - `~/.vela/hooks/*.js` (플러그인 캐시가 대체)
   - `~/.claude/skills/vela*/` (플러그인이 대체)
   - `~/.claude/settings.json`에서 `_velaId: vela-*` 엔트리 (hooks.json이 대체)

   `--cleanup-legacy=skip`을 명시하면 건너뛴다.

5. **결과 확인**

   ```bash
   vela-engine state
   ```

   "No active pipeline" 반환이면 성공. 이제 `/vela:ship`을 호출할 수 있다.

## 출력 예시

```
⛵ Vela installed to /path/to/project/.vela
  Plugin root: /home/user/.claude/plugins/cache/vela/
  Version: 8.0.0

⚠️  Legacy cleanup (pre-plugin v7.x):
  ✓ Removed ~/.vela/hooks/ (5 files)
  ✓ Removed ~/.claude/skills/vela/ (1 directory)
  ✓ Removed 4 legacy _velaId entries from ~/.claude/settings.json
  See ~/.claude/settings.json.pre-plugin-backup-20260418T020000 for rollback.

Next: run /vela:ship "your task" to start a pipeline.
```
