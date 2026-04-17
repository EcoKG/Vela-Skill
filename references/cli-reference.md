# Vela CLI 레퍼런스

## vela-engine (파이프라인 엔진)

```bash
vela-engine init "설명" [--type TYPE] [--scale SIZE] [--auto]
vela-engine state
vela-engine transition
vela-engine record pass|fail|reject
vela-engine advance [pass|fail|reject]            # v7.1 M8 — record+transition
vela-engine doctor                                # v7.1 M6 — health check
vela-engine branch [--mode auto|prompt|none]
vela-engine commit [--message TEXT]
vela-engine cancel
vela-engine history
vela-engine locate [--request "..."] [--json]    # v6.1
vela-engine clean-scan
vela-engine clean-exec
```

### `advance` 명령 (v7.1 M8)

`record pass` + `transition` 을 한 번의 엔진 호출로 수행한다. 정상 진행 시 PM 의
top-level Bash 호출을 절반으로 줄이고, 응답에 `nextAction` 힌트가 포함되어
`state` 재조회 없이 다음 단계의 Agent 소환으로 직행할 수 있다.

```bash
vela-engine advance            # 기본값 pass
vela-engine advance pass       # 동일
vela-engine advance reject     # revisions++ + 같은 단계 유지
vela-engine advance fail       # reject 와 동일한 retry 시멘틱
```

응답 JSON: `{previousStep, currentStep, nextStep, revision, circuitOpen, nextAction, message}`.

기존 `record` / `transition` 은 back-compat 으로 그대로 남는다.

### `doctor` 명령 (v7.1 M6)

엔진/에이전트/템플릿/훅 파일 전부가 있고 파싱 가능한지 검증. PM 이 세션 시작 시
자동으로 호출한다 (vela.md 1.5단계). `ok: false` 리턴 시 `missing[]` 에 누락 파일이
나열되고 `recovery: "node .vela/install.js validate"` 를 제안한다.

```bash
vela-engine doctor
```

검사 항목: core dirs, `cli/vela-engine.js`, `templates/pipeline.json` parse,
`config.json` parse, agent manifest, v7.1 파일들 (role-budgets.json,
plan-templates/quick.md, guidelines/live-processes.json,
guidelines/smoke-test.sh.example). v7.3-M4에서 vela-file-read-cache.js 훅은 제거됨.

### `locate` 명령 (v6.1, LLM 0)

Universal Locate — 결정론적 file/symbol 식별자 탐지. ripgrep (없으면 git grep) + git ls-files 기반.

```bash
# 현재 활성 파이프라인의 request를 읽어 targets.json 생성 (PM이 locate 단계에서 호출)
vela-engine locate

# 파이프라인 없이 미리보기
vela-engine locate --request "auth.ts의 login 함수 검증 추가"

# 전체 targets.json 구조 출력
vela-engine locate --json
```

출력: `{artifactDir}/targets.json` (또는 `.vela/locate-preview/targets.json` for --request)
- `primary[]`: file:line 주요 수정 대상
- `tests[]`: primary를 커버하는 테스트 파일
- `blast_radius[]`: primary를 import/reference하는 read-only 파일
- `confidence`: `high | medium | low`
- `tokens_extracted[]`: 프롬프트에서 추출된 식별자 힌트

### 지원하는 `--scale` 값 (v6.1/v7.0)

| `--scale` 값 | pipeline_type | 슬래시 명령 | 단계 수 |
|---|---|---|---|
| `fix` **(v7.0 기본 추천)** | surgical | `/vela:fix` | 8 |
| `small` | trivial | `/vela:small` | 5 |
| `medium` | quick | `/vela:medium` | 7 |
| `large` | standard | `/vela:large` | 13 |
| `ralph` | ralph | `/vela:ralph` | 5+루프 |
| `hotfix` | hotfix | `/vela:hotfix` | 4 |

`--scale` 누락 시 `medium`으로 폴백 (deprecation 경고 출력). `autoDetectScale()`은 v6.1부터 deprecated (v7.0에서 제거 예정).

## V6/V7 파이프라인 실행

v8.0에서 PM(vela.md agent)이 6단계 파이프라인을 오케스트레이션한다:

```
PM → vela-engine.js init "요청" --scale {ship|fix|hotfix}
   → vela-engine.js locate                           ← LLM 0 (모든 파이프라인 공통)
   → Agent(vela-planner, mode=plan|spec) → Agent(vela-reviewer, mode=review)
   → Agent(vela-executor) → Agent(vela-reviewer, mode=review)
   → Agent(vela-reviewer, mode=verify) → vela-engine.js commit
```

`/vela:fix`는 `plan` 단계에서 planner를 `mode: spec`으로 호출하여 `patch-spec.md`를 생성하고, executor가 그 spec을 정확히 적용한다(out-of-scope 범위 준수).

## ~~vela-sprint~~ (v7.3-M1c 제거됨)

스프린트 오케스트레이션은 V8에서 제거되었다. 대규모 요청은 사용자가 작업을 작은 단위로 쪼개 단일 파이프라인을 여러 번 실행한다. Opus 4.7의 adaptive thinking + 1M context로 단일 파이프라인의 커버 범위가 넓어졌기 때문. `sprint-manager.js`, `vela-sprint-planner.md`, `test-sprint-manager.sh` 모두 제거.

## /vela:analyze (분석 — v7.3-M1b부터 스킬 내부 실행)

전용 CLI 없이 `skills/analyze/SKILL.md` 스킬이 직접 운영한다:
- **deps**: 스킬 내부에서 `npm audit --json` + `npm outdated --json` 실행, Claude가 markdown 요약 작성
- **perspectives** (security/bugs/performance/code-quality/architecture): `Agent(subagent_type="vela-researcher", mode=analyze)` 호출 (v7.3-M2a 흡수)

출력: `.vela/artifacts/<ts>/analysis.md` (PDF 필요 시 Claude Code의 브라우저 출력 사용)

## vela-friction (훅 마찰 집계)

```bash
node .vela/cli/vela-friction.js [--limit 500] [--json]
```

## TreeNode 캐시

역할 에이전트(vela-researcher 등)가 Read/Glob/Grep 도구 실행 시 파일 경로를 자동 수집하여 `pending-paths.jsonl`에 기록한다. `ingest` 명령으로 SQLite에 반영하면 세션 간 파일 위치를 기억한다.

```bash
node .vela/cache/treenode.js ingest     # 대기 경로 SQLite 반영
node .vela/cache/treenode.js query src/ # 접두사로 검색
node .vela/cache/treenode.js stats      # 캐시 통계
node .vela/cache/treenode.js clear      # 캐시 초기화
node .vela/cache/treenode.js export     # 전체 경로 내보내기
```

## 설치 관리

```bash
node .vela/install.js              # 설치 (유효성 검증 포함)
node .vela/install.js verify       # 검증만
node .vela/install.js uninstall    # 완전 제거
node .vela/install.js status       # 현재 상태
node .vela/install.js --json       # JSON 출력
```

## vela-cost (비용/메트릭)

```bash
node .vela/cli/vela-cost.js        # 파이프라인 비용 리포트
```

## vela-report (대시보드)

```bash
node .vela/cli/vela-report.js                    # JSON 리포트
node .vela/cli/vela-report.js --html report.html # HTML 대시보드
```

## 글로벌 훅 (Stop / PreToolUse)

설치 시 `~/.claude/settings.json`에 자동 등록. 모든 프로젝트에 적용되며, 활성 Vela 파이프라인이 없는 프로젝트에서는 즉시 통과.

| 훅 | 이벤트 | 역할 |
|----|--------|------|
| `vela-gate.js` | PreToolUse | VK-01~10 (모드별 도구 제한, 시크릿, 체인 연산자, researcher 범위) + VG-03/13/14/15 (git commit 안전, pipeline.json 보호, 서킷 브레이커) (v7.3-M4c 통합) |
| `vela-stop.js` | Stop + SubagentStop | Auto 모드 차단 + review-gate 재검증(기본 1회, execute 전용) + dirty tree 경고 + session-end snapshot + 에이전트 텔레메트리 (v7.3-M4d 통합) |
| `vela-session.js` | SessionStart | 버전 체크 + 파이프라인 상태/학습/환경/git context 주입 (v7.3-M4b 통합) |

### review_gate 설정 (.vela/config.json)

```json
"review_gate": {
  "enabled": true,
  "validation_rounds": 3,
  "steps": ["research", "execute", "plan"]
}
```

- `validation_rounds`: APPROVE 후 추가 검증 횟수 (기본 3)
- `steps`: 재검증 적용 단계 목록
- Gate 상태: `.vela/state/review-gate-{step}.json` (transition 시 자동 삭제)
