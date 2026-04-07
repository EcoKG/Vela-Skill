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
node .vela/cli/vela-engine.js review                             # SDK Opus 단일 리뷰
node .vela/cli/vela-engine.js plan-check                         # SDK plan.md 구조 검증 (Haiku)
node .vela/cli/vela-engine.js research                           # SDK 3-관점 병렬 리서치 (Haiku)
node .vela/cli/vela-engine.js execute                            # SDK 단일 실행 (Sonnet)
node .vela/cli/vela-engine.js wave-execute                       # Wave 병렬 실행 (plan.md 태스크를 wave 단위 동시 실행)
node .vela/cli/vela-engine.js validate                           # SDK 코드 검증 (테스트/린트/타입 체크)
```

## vela-pipeline (SDK 오케스트레이터)

```bash
node .vela/cli/vela-pipeline.js run "<요청>" [--type TYPE]                               # SDK 파이프라인 실행
node .vela/cli/vela-pipeline.js status                                                    # 파이프라인 상태 조회
node .vela/cli/vela-pipeline.js cancel                                                    # 활성 파이프라인 취소
```

- `--type`: 파이프라인 타입 (code/code-bug/code-refactor/docs)
- vela-engine.js의 상태 머신을 CLI bridge로 재사용하여 단계 전이를 위임한다.

## vela-sprint (스프린트 오케스트레이터)

```bash
node .vela/cli/vela-sprint.js run "<요청>"          # 스프린트 계획 + 전체 슬라이스 순차 실행
node .vela/cli/vela-sprint.js status [sprint-id]     # 스프린트 상태 및 슬라이스별 진행률
node .vela/cli/vela-sprint.js resume [sprint-id]     # 중단된 스프린트 재개
node .vela/cli/vela-sprint.js cancel [sprint-id]     # 활성 스프린트 취소
```

- sdk-sprint-planner.js가 요청을 의존성 그래프 기반 슬라이스로 분해한다.
- 각 슬라이스를 vela-pipeline.js run으로 독립 파이프라인 실행한다 (CLI bridge, K025).
- 상태 파일: `.vela/sprints/sprint-*.json`

## vela-analyze (분석 보고서)

```bash
node .vela/cli/vela-analyze.js deps                              # 의존성 분석 (npm audit/outdated, 무료)
node .vela/cli/vela-analyze.js report --input <file> [--output <file>]  # JSON → PDF 변환
node .vela/cli/vela-analyze.js run --perspectives <list> [--model haiku|sonnet|opus]  # SDK 코드 분석
node .vela/cli/vela-analyze.js full --items <list> [--model haiku|sonnet|opus] [--output <file>]  # 통합 분석 → PDF

# perspectives: security, bugs, performance, code-quality, architecture
# items: deps, security, bugs, performance, code-quality, architecture
```

## TreeNode 캐시

SDK 오케스트레이터(vela-pipeline.js)가 Read/Glob/Grep 도구 실행 시 파일 경로를 자동 수집하여 `pending-paths.jsonl`에 기록한다. `ingest` 명령으로 SQLite에 반영하면 세션 간 파일 위치를 기억한다.

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
