---
name: "vela:update"
description: "🔄 Vela 플러그인 + 프로젝트 .vela/ 업데이트 안내"
---

# /vela:update — Vela 업데이트 (v8.0 플러그인)

Vela는 v8.0부터 Claude Code 공식 플러그인이다. 업데이트는 Claude Code의 플러그인 시스템이 담당한다. 이 명령은 사용자에게 올바른 명령어를 안내한다.

## 사용자에게 표시할 안내

다음을 순서대로 실행하라고 안내한다:

```
⛵ Vela 업데이트 (v8.0)

1. 플러그인 소스 갱신:
     /plugin marketplace update vela

2. 최신 버전 재설치:
     /plugin install vela@vela

3. 현재 프로젝트의 templates/references 재동기화:
     /vela:install --resync

(1번과 2번은 Claude Code 플러그인 시스템이 실행한다. 3번은 프로젝트
 로컬 `.vela/templates/`, `.vela/references/`만 다시 복사한다 — config.json
 과 state/는 그대로 유지된다.)
```

## Case 분기

### 현재 프로젝트에 `.vela/` 가 있음

모든 3단계를 실행하라고 안내한다.

### 현재 프로젝트에 `.vela/` 없음

1~2번만 실행. 이후 `/vela:install`로 프로젝트 초기화.

## 왜 curl/update.sh가 아닌가

v7.x에서는 `curl | bash update.sh`로 글로벌 `~/.claude/skills/vela/` + 프로젝트 `.vela/`를 동시 갱신했다. v8.0부터:

- 글로벌 배포는 Claude Code 플러그인 캐시(`~/.claude/plugins/cache/vela/`)가 담당 — `/plugin marketplace update` + `/plugin install`로 재빌드
- 프로젝트별 `.vela/config.json` (사용자 커스터마이징)은 절대 덮어쓰지 않음
- `.vela/templates/`, `.vela/references/`만 `/vela:install --resync`로 갱신

`install.sh`/`update.sh` 루트 shim은 deprecated이고 v8.2에서 제거된다.

## 레거시 사용자 (pre-plugin v7.x)

curl로 설치했던 사용자는 v8.0 플러그인 설치 후 `/vela:install`을 한 번 실행하면 `--cleanup-legacy=auto`가 기본으로 동작하여 `~/.vela/hooks/`, `~/.claude/skills/vela*/`, `settings.json`의 `_velaId: vela-*` 엔트리를 자동 제거한다 (backup 파일 생성).
