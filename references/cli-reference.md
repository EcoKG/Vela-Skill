# Vela CLI 레퍼런스

## vela-engine (파이프라인 엔진)

```bash
node .vela/cli/vela-engine.js init "설명"
node .vela/cli/vela-engine.js state
node .vela/cli/vela-engine.js transition
node .vela/cli/vela-engine.js record pass|fail
node .vela/cli/vela-engine.js sub-transition
node .vela/cli/vela-engine.js branch [--mode auto|prompt|none]
node .vela/cli/vela-engine.js commit [--message TEXT]
node .vela/cli/vela-engine.js cancel
node .vela/cli/vela-engine.js history
node .vela/cli/vela-engine.js auto                                # Auto 모드 토글 (ON↔OFF)
node .vela/cli/vela-engine.js review                             # V6 stub — use Agent(vela-reviewer) directly
node .vela/cli/vela-engine.js plan-check                         # V6 stub — use Agent(vela-plan-checker) directly
node .vela/cli/vela-engine.js research                           # V6 stub — use Agent(vela-researcher) directly
node .vela/cli/vela-engine.js execute                            # V6 stub — use Agent(vela-executor) directly
node .vela/cli/vela-engine.js validate                           # V6 stub — use Agent(vela-verifier) directly
```

## V6 파이프라인 실행

V6에서는 `vela-pipeline.js`가 제거되었다. PM(vela.md agent)이 직접 파이프라인을 오케스트레이션한다:

```
PM → vela-engine.js init "요청"
   → Agent(vela-researcher) → Agent(vela-reviewer)
   → Agent(vela-planner) → Agent(vela-reviewer)
   → Agent(vela-executor) → Agent(vela-reviewer)
   → Agent(vela-verifier) → ... → vela-engine.js commit
```

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
node .vela/cli/vela-analyze.js run --perspectives <list>  # V6 stub — use Agent(vela-analyzer) directly
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
