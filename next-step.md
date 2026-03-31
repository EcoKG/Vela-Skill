# ⛵ Vela Engine — Next Steps

## 완료 현황

| 버전 | 마일스톤 | 내용 | 상태 |
|------|---------|------|------|
| **v2.0** | M001 | 비용 최적화 + Auto 모드 — Opus→Sonnet 전환, PM 속독, Auto 모드, Bash 완화, persona.md | ✅ 완료 |
| **v2.5** | M002 | Hook API 고급화 — Stop/SubagentStop/Permission/Failure/Prompt/Async/Notification. Hook 4→18개 | ✅ 완료 |
| **v3.0** | M003 | Agent SDK 통합 — 5개 SDK 모듈, 3단계 리뷰, PM 코드 작성 구조 차단, 81 assertion 통합 테스트 | ✅ 완료 |
| **v3.1** | M004 | 분석 보고서 — dep-analyzer + sdk-analyzer 5관점, vela-analyze CLI (deps/report/run/full), PDF 생성, `/vela analyze` 스킬 통합, E2E 22/22 PASS | ✅ 완료 |
| **v3.1** | M005 | UI 세계관 고도화 — statusline 컬러 그라데이션(green/yellow/red)+유니코드 프로그레스 바(█░), Orchestrator 유니코드 박스 드로잉(╭╮╰╯│─), 18개 hook description 항해 세계관 통합, spinner/tips/announcements 전면 교체 | ✅ 완료 |
| **v3.1** | M006 | 글로벌 오염 정리 — ~/.claude/ 잔여물 전체 정리(146MB+ 회수), install.sh/update.sh 서브스킬 플랫 복사 제거, install.js validate() 자기 치유 가드 추가 | ✅ 완료 |
| **v3.1** | M007 | 프로젝트 전수 검수 — 코드베이스 ~14,500줄 정밀 감사. 59건 발견(High 8, Medium 24, Low 27). AUDIT-001~059 통합 보고서 산출 | ✅ 완료 |
| **v3.2** | M008 | 전수 수정 — Fail-closed 게이트, HMAC-SHA256 서명 체인, 체인 연산자 차단(VK-08), 파이프라인 완화(trivial/hotfix exit_gate:[]), execFileSync 전환(35+ callers), SQL parameterization, SDK null guards. 21개 테스트 스위트 230/230 PASS | ✅ 완료 |

---

## 향후 로드맵

### Deferred (우선순위 미정)

| ID | 기능 | 설명 | 유래 |
|----|------|------|------|
| R013 | Wave 병렬 그룹화 | plan.md Task Distribution에서 의존성 그래프 추출 → 병렬 가능한 작업을 Wave로 그룹화 | GSD 분석 |
| R014 | HTML 대시보드 | `vela-engine report --html`로 시각적 파이프라인 리포트 (타임라인, 점수, approve/reject 히스토리) | GSD 분석 |

### 아이디어 풀 (검토 필요)

| 기능 | 설명 | 영향 |
|------|------|------|
| SDK 실행 비용 추적 | SDK 커맨드별 토큰/비용을 trace.jsonl에 기록 → 파이프라인 비용 투명화 | 비용 가시성 |
| SDK Researcher Sonnet 에스컬레이션 | 현재 Haiku only → Sonnet 에스컬레이션 옵션 | 분석 품질 |
| 플러그인 패키지 전환 | `.claude-plugin/plugin.json` 매니페스트 → 마켓플레이스 배포 | 배포 간편 |
| config.json 검증 강화 | 사용자 설정 유효성 검증 + migration 지원 | 안정성 |
| 다국어 메시지 분리 | 한국어/영어 메시지 로케일 파일 분리 | 접근성 |
