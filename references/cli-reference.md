# Vela CLI 레퍼런스

## vela-engine (파이프라인 엔진)

```bash
node .vela/cli/vela-engine.js init "설명" --scale <small|medium|large>
node .vela/cli/vela-engine.js state
node .vela/cli/vela-engine.js transition
node .vela/cli/vela-engine.js record pass|fail
node .vela/cli/vela-engine.js sub-transition
node .vela/cli/vela-engine.js branch [--mode auto|prompt|none]
node .vela/cli/vela-engine.js commit [--message TEXT]
node .vela/cli/vela-engine.js cancel
node .vela/cli/vela-engine.js history
node .vela/cli/vela-engine.js auto                                # Auto 모드 토글 (ON↔OFF)
node .vela/cli/vela-engine.js review                             # SDK 3단계 리뷰 (Haiku→Sonnet→Opus)
node .vela/cli/vela-engine.js plan-check                         # SDK plan.md 구조 검증 (Haiku)
node .vela/cli/vela-engine.js research                           # SDK 3-관점 병렬 리서치 (Haiku)
node .vela/cli/vela-engine.js execute                            # SDK 단일 실행 (Sonnet)
```

## vela-pipeline (SDK 오케스트레이터)

```bash
node .vela/cli/vela-pipeline.js run "<요청>" --scale <small|medium|large> [--type TYPE]  # SDK 파이프라인 실행
node .vela/cli/vela-pipeline.js status                                                    # 파이프라인 상태 조회
node .vela/cli/vela-pipeline.js cancel                                                    # 활성 파이프라인 취소
```

- `--scale`: small(trivial) / medium(quick) / large(standard)
- `--type`: 파이프라인 타입 (기본: scale에 따라 자동 결정)
- vela-engine.js의 상태 머신을 CLI bridge로 재사용하여 단계 전이를 위임한다.

## vela-analyze (분석 보고서)

```bash
node .vela/cli/vela-analyze.js deps                              # 의존성 분석 (npm audit/outdated, 무료)
node .vela/cli/vela-analyze.js report --input <file> [--output <file>]  # JSON → PDF 변환
node .vela/cli/vela-analyze.js run --perspectives <list> [--model haiku|sonnet]  # SDK 코드 분석
node .vela/cli/vela-analyze.js full --items <list> [--model haiku|sonnet] [--output <file>]  # 통합 분석 → PDF

# perspectives: security, bugs, performance, code-quality, architecture
# items: deps, security, bugs, performance, code-quality, architecture
```

## TreeNode 캐시

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
