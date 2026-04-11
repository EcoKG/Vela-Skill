# Vela CLI 레퍼런스

## vela-engine (파이프라인 엔진)

```bash
node .vela/cli/vela-engine.js init "설명" [--type TYPE] [--scale SIZE] [--auto]
node .vela/cli/vela-engine.js state
node .vela/cli/vela-engine.js transition
node .vela/cli/vela-engine.js record pass|fail|reject
node .vela/cli/vela-engine.js branch [--mode auto|prompt|none]
node .vela/cli/vela-engine.js commit [--message TEXT]
node .vela/cli/vela-engine.js cancel
node .vela/cli/vela-engine.js history
node .vela/cli/vela-engine.js locate [--request "..."] [--json]    # v6.1
node .vela/cli/vela-engine.js clean-scan
node .vela/cli/vela-engine.js clean-exec
```

### `locate` 명령 (v6.1, LLM 0)

Universal Locate — 결정론적 file/symbol 식별자 탐지. ripgrep (없으면 git grep) + git ls-files 기반.

```bash
# 현재 활성 파이프라인의 request를 읽어 targets.json 생성 (PM이 locate 단계에서 호출)
node .vela/cli/vela-engine.js locate

# 파이프라인 없이 미리보기
node .vela/cli/vela-engine.js locate --request "auth.ts의 login 함수 검증 추가"

# 전체 targets.json 구조 출력
node .vela/cli/vela-engine.js locate --json
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

V6에서 `vela-pipeline.js`가 제거되었다. PM(vela.md agent)이 직접 파이프라인을 오케스트레이션한다:

```
PM → vela-engine.js init "요청" --scale {scale}
   → vela-engine.js locate                    ← v6.1 (모든 scale 공통)
   → Agent(vela-researcher) → Agent(vela-reviewer)
   → Agent(vela-planner) → Agent(vela-reviewer)   ← plan mode 또는 mode: spec (v7.0)
   → Agent(vela-executor) → Agent(vela-reviewer)  ← legacy execute 또는 patch (v7.0)
   → Agent(vela-verifier) → ... → vela-engine.js commit
```

v7.0 surgical(`/vela:fix`)은 `plan` 대신 `spec` 단계에서 planner를 `mode: spec`으로 호출하여 `patch-spec.md`를 생성하고, `execute` 대신 `patch` 단계에서 executor가 이 spec을 정확히 적용한다.

## vela-sprint (스프린트 — V6)

V6에서는 PM이 직접 스프린트를 처리한다:

```
PM → Agent(vela-sprint-planner) → sprint-{timestamp}.json
   → 슬라이스별 파이프라인 순차 실행 (Agent 도구 체인)
```

- `sprint-manager.js`가 스프린트 상태를 `.vela/sprints/sprint-*.json`에 기록한다.

## vela-analyze (분석 보고서)

```bash
node .vela/cli/vela-analyze.js deps                              # 의존성 분석 (npm audit/outdated, 무료)
node .vela/cli/vela-analyze.js report --input <file> [--output <file>]  # JSON → PDF 변환
node .vela/cli/vela-analyze.js full --items <list> [--output <file>]  # 통합 분석 → PDF (deps는 CLI, 나머지는 Agent)

# perspectives: security, bugs, performance, code-quality, architecture
# items: deps, security, bugs, performance, code-quality, architecture
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
| `vela-gate-keeper.js` | PreToolUse | VK-01~08: 모드별 도구 제한 |
| `vela-gate-guard.js` | PreToolUse | VG-03~15: 단계 순서 강제, 서킷 브레이커 |
| `vela-stop.js` | Stop | Auto 모드 파이프라인 중 조기 종료 차단 |
| `vela-review-gate.js` | Stop | APPROVE 후 N회 재검증 강제 (기본 3회) |

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
