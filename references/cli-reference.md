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
node .vela/cli/vela-engine.js clean-scan
node .vela/cli/vela-engine.js clean-exec
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
