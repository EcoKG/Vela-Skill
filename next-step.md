# ⛵ Vela Engine — Next Steps

3명의 전문가(skills-analyst, product-manager, feature-scout) 조사 결과 기반 로드맵.

## 완료 현황

| 버전 | 완료 | 남음 |
|------|------|------|
| **v1.4** | 6/6 ✅ | 0 |
| **v1.5** | 6/6 ✅ | 0 |
| **v2.0** | 8/8 ✅ | 0 |

---

## v1.4 — Must-Have (안정성 + 사용성)

### 1. Stop Hook — 파이프라인 포기 방지
- **문제**: 실수로 세션 종료 시 파이프라인이 중단됨
- **구현**: `Stop` 훅 이벤트에서 활성 파이프라인 감지 → 경고 메시지
- **참고**: forge, ralph-loop 모두 사용

### 2. SessionStart Hook — 중단 파이프라인 자동 감지
- **문제**: 세션 재시작 후 이전 파이프라인을 모름
- **구현**: `SessionStart` 훅에서 활성 파이프라인 탐색 → "이전 파이프라인이 있습니다. 재개할까요?" AskUserQuestion
- **참고**: forge의 `--resume` 기능

### 3. PreCompact/PostCompact — 컨텍스트 압축 시 상태 보존
- **문제**: 긴 작업 중 컨텍스트 압축되면 파이프라인 상태를 잃음
- **구현**: `PreCompact` 훅에서 현재 단계/변수를 파일에 저장, `PostCompact`에서 재주입
- **효과**: 긴 standard 파이프라인에서 컨텍스트 유지

### 4. `/vela status` 커맨드
- **문제**: 현재 파이프라인 상태를 한눈에 볼 수 없음
- **구현**: SKILL.md에 `status` 인자 처리 추가, `vela-engine state` 결과를 예쁘게 포맷
- **출력 예시**:
  ```
  ⛵ Vela Pipeline Status
  🧭 standard │ Step: execute (3/10) │ Task: 인증 시스템 추가
  ✦ Branch: vela/auth-system-1358
  🌟 Last approval: plan (22/25)
  ```

### 5. 설치 출력 개선 — JSON → 사람이 읽기 좋은 포맷
- **문제**: `node .vela/install.js` 출력이 raw JSON
- **구현**: JSON 대신 포맷된 텍스트 출력 (JSON은 `--json` 플래그로)
- **출력 예시**:
  ```
  ⛵ Vela Engine — Installation Complete
  ✓ 4 hooks registered
  ✓ 13 deny rules + 3 allow rules
  ✓ Agent: vela
  ✓ StatusLine: active
  ✓ Spinner: 12 nautical verbs
  ✦─────────────────────✦
  ```

### 6. Guard 에러 메시지 개선
- **문제**: 차단 메시지가 무엇이 잘못됐는지만 알려주고 해결법이 부족
- **구현**: 각 GUARD 메시지에 "해결 방법" 섹션 추가
- **예시**: `"BLOCKED: No active pipeline" → "해결: /vela start 로 파이프라인을 시작하세요"`

---

## v1.5 — Should-Have (자동화 + 품질)

### 7. 파이프라인 히스토리
- **구현**: `vela-engine history` 커맨드, `.vela/artifacts/` 기반
- **출력**: 날짜, 작업명, 결과(completed/cancelled), 소요시간

### 8. TaskCompleted Hook — 자동 품질 게이트
- **구현**: `TaskCompleted` 훅에서 exit(2)로 완료 차단
- **용도**: 테스트 미통과 시 작업 완료 방지

### 9. SubagentStart Hook — 에이전트에 파이프라인 컨텍스트 주입
- **구현**: `SubagentStart` 훅에서 `additionalContext`로 현재 파이프라인 상태 주입
- **효과**: 모든 subagent가 파이프라인 상태를 자동으로 인식

### 10. SKILL.md 경량화
- **문제**: 568줄 → 500줄 이하 목표
- **구현**: Gate 규칙, CLI 레퍼런스, Git 상세를 `references/` 디렉토리로 분리
- **참고**: skill-creator의 progressive disclosure 패턴

### 11. Ralph 모드 — 테스트 통과까지 자동 반복
- **구현**: `--ralph` 플래그, execute 단계에서 테스트 실패 시 자동 재시도
- **참고**: forge의 ralph pipeline

### 12. Worktree 지원 — 에이전트 격리 실행
- **구현**: Agent 소환 시 `isolation: "worktree"` 파라미터
- **효과**: 파일 충돌 없는 병렬 execute

---

## v2.0 — Competitive Advantage

### 13. 플러그인 전환
- **구현**: `.claude-plugin/plugin.json` 매니페스트, 마켓플레이스 배포
- **효과**: `/vela:init`, `/vela:start` 자동완성, 원클릭 설치

### 14. 자동 모드 — sandbox + autoAllow
- **구현**: `sandbox.enabled: true` + `autoAllowBashIfSandboxed: true`
- **효과**: 무인 파이프라인 실행 (보안 경계 내)

### 15. 비용 투명성
- **구현**: 파이프라인 완료 시 토큰/비용 리포트 (`report.md`에 포함)
- **출력**: "이 파이프라인: 183K tokens, ~$6.00, 3개 critical 이슈 발견"

### 16. HTML 대시보드
- **구현**: `vela-engine report --html` → 시각적 파이프라인 리포트 생성
- **내용**: 단계별 타임라인, Reviewer 점수, approve/reject 히스토리

### 17. Pipeline 템플릿
- **구현**: `.vela/templates/` 에 프리셋 (auth-system, api-crud, migration 등)
- **사용**: `/vela start --template auth`

### 18. 세션 복구
- **구현**: `SessionStart` 훅 + `PreCompact/PostCompact` 조합
- **효과**: 세션이 끊겨도 파이프라인 상태 자동 복구

### 19. 다국어 지원
- **구현**: 메시지 로케일 파일 분리, 설정으로 언어 선택
- **지원**: 한국어 (기본), 영어

### 20. 비-소스 변경 핫픽스 모드
- **문제**: README 한 줄 수정에도 파이프라인 오버헤드
- **구현**: `--hotfix` 플래그, 비-소스 파일(md, json, yaml) 수정 시 파이프라인 최소화

---

## 우선순위 매트릭스

| 우선순위 | 기능 | 노력 | 영향 |
|---------|------|------|------|
| P0 | Stop Hook | 소 | 파이프라인 안전 |
| P0 | SessionStart (재개) | 소 | 세션 복구 |
| P0 | 설치 출력 개선 | 소 | 첫인상 |
| P1 | PreCompact/PostCompact | 중 | 컨텍스트 유지 |
| P1 | `/vela status` | 소 | 사용성 |
| P1 | Guard 에러 메시지 개선 | 소 | 사용자 혼란 감소 |
| P1 | 파이프라인 히스토리 | 소 | 추적성 |
| P2 | SKILL.md 경량화 | 중 | 로딩 성능 |
| P2 | Ralph 모드 | 중 | 자동화 |
| P2 | 비용 투명성 | 소 | 가치 증명 |
| P3 | 플러그인 전환 | 대 | 배포 간편 |
| P3 | HTML 대시보드 | 대 | 사용자 만족 |
| P3 | 핫픽스 모드 | 중 | 일상 마찰 감소 |
