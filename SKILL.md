---
name: vela
description: "⛵ Vela — Claude Code 샌드박스 개발 거버넌스. /vela:ship (기본 6단계 파이프라인), /vela:fix (Target-First 정밀 수정), /vela:hotfix (문서/설정), /vela:analyze (프로젝트 분석), /vela:git-clean, /vela:update. Vela, 벨라, 샌드박스, 파이프라인, fix, ship, hotfix, analyze, git-clean, update 키워드가 언급되면 이 스킬을 트리거한다."
---

# ⛵ Vela — Sandbox Development Governance (v8.0)

Vela는 Claude Code의 모든 코드 변경을 **6단계 파이프라인**과 **fail-closed 훅**으로 통제한다. 파이프라인 밖에서는 소스 수정이 차단되고, 파이프라인 안에서는 단계 순서가 강제된다.

## /vela 호출 시 분기

`$ARGUMENTS`를 확인한다:

| 인자 | 동작 |
|-----|------|
| `ship` 또는 `ship <작업>` | `/vela:ship` 절차 (기본 6단계 파이프라인) |
| `fix` 또는 `fix <작업>` | `/vela:fix` 절차 (surgical, <50 LOC diff) |
| `hotfix` 또는 `hotfix <작업>` | `/vela:hotfix` 절차 (docs/config 4단계) |
| `small \| medium \| large \| ralph` | **deprecated** — 경고 후 `/vela:ship`으로 자동 리다이렉트 |
| `status` | `node .vela/cli/vela-engine.js state` 결과 포맷팅 출력 |
| `analyze` | `/vela:analyze` 절차 (프로젝트 분석 → markdown) |
| `git-clean` | `/vela:git-clean` 절차 |
| `update` | `/vela:update` 절차 (엔진/스킬 업데이트) |
| (비어있음) | AskUserQuestion으로 ship/fix/hotfix 선택 |

`$ARGUMENTS`가 비어있을 때 표시할 선택지:

```json
{
  "questions": [{
    "question": "⛵ Vela — 어떤 파이프라인으로 시작할까요?",
    "header": "⛵ Vela",
    "options": [
      { "label": "ship (Recommended)", "description": "기본 6단계 — init → locate → plan → execute → verify → commit" },
      { "label": "fix", "description": "surgical 정밀 수정 (<50 LOC diff, patch-spec 기반)" },
      { "label": "hotfix", "description": "문서/설정 4단계 — plan/verify 생략" }
    ],
    "multiSelect": false
  }]
}
```

선택 후 해당 `skills/{ship|fix|hotfix}/SKILL.md`의 상세 절차를 실행한다.

---

## 파이프라인 (v8.0 — 6단계)

```
init → locate → plan → execute → verify → commit
```

| 단계 | 모드 | 역할 | 산출물 | 비고 |
|-----|------|-----|-------|------|
| init | read | PM | meta.json | git 상태 체크 + 브랜치 생성 (v8.0 흡수) |
| locate | read | PM (결정론) | targets.json | ripgrep+git 기반, LLM 0 |
| plan | write | **vela-planner** → **vela-reviewer** → PM | plan.md 또는 patch-spec.md | research+self-check 통합 (v8.0) |
| execute | readwrite | **vela-executor** → **vela-reviewer** → PM | task-summary.md | TDD sub-phases: test-write → implement → refactor |
| verify | rw-artifact | **vela-reviewer** (mode=verify) | verification.md | 테스트+린트+diff요약 통합. >500 LOC 시 `/ultrareview` 에스컬레이션 |
| commit | read | PM | diff.patch | Conventional Commits, finalize 흡수 |

**rw-artifact 모드**: `read` 기반에 `artifactDir` scope의 Write만 허용 — `createArtifactPathGuard(artifactDir)` PreToolUse 훅이 경로를 제한한다.

**파이프라인 변형**:
- **ship** (기본): 6단계 전체
- **fix**: plan 단계가 `mode=spec`으로 `patch-spec.md` 작성 (file:line Before/After + Explicitly out of scope)
- **hotfix**: `init → locate → execute → commit` 4단계 (plan/verify 생략)

---

## 역할 에이전트 (v8.0 — 4개)

PM은 `Agent(subagent_type="vela-{role}")`로 직접 소환한다. Teammate/TeamCreate/SendMessage는 사용하지 않는다.

| subagent_type | 모델 | 역할 |
|--------------|------|------|
| `vela-researcher` (mode=research\|merge\|analyze) | haiku (analyze), sonnet (research/merge) | `/vela:analyze` 전용 — 3관점/머지/심층 분석 |
| `vela-planner` (mode=plan\|spec) | **opus 4.7** (adaptive thinking) | research + plan + self-check 통합. spec 모드는 patch-spec.md |
| `vela-executor` | sonnet (effort: xhigh) | TDD 기반 코드 구현 (test-write → implement → refactor) |
| `vela-reviewer` (mode=review\|verify) | sonnet, 에스컬레이트 시 opus 4.7 | 5차원 채점 + 테스트/린트/diff 요약 통합 |

**삭제된 에이전트 호출 금지** (v7.3-M2a/M3에서 통합됨):
`vela-researcher-merge`, `vela-analyzer`, `vela-plan-checker`, `vela-verifier`, `vela-diff-summary`, `vela-learning`, `vela-sprint-planner`

### 소환 예시

```
Agent(
  subagent_type="vela-executor",
  prompt="
    request: {요청}
    artifactDir: {artifactDir}
    planPath: {artifactDir}/plan.md
    <task>
      <role>executor</role>
      <action>plan.md의 Class Specification에 따라 TDD로 구현한다.</action>
      <verify>npm test</verify>
      <done>모든 테스트 통과 + task-summary.md 생성</done>
    </task>
  "
)
```

---

## 엔진 명령어 (PM이 직접 호출)

```bash
# 파이프라인 초기화
node .vela/cli/vela-engine.js init "작업 설명" [--scale ship|fix|hotfix] [--auto] [--force]

# 상태 머신
node .vela/cli/vela-engine.js state              # 현재 상태 + recommended_model 조회
node .vela/cli/vela-engine.js transition         # 다음 단계로 전이
node .vela/cli/vela-engine.js record pass|reject # 단계 성공/실패 기록

# Git 통합
node .vela/cli/vela-engine.js branch             # vela/{slug} 브랜치 생성 (init에서 자동)
node .vela/cli/vela-engine.js commit             # Conventional Commits 자동 커밋
node .vela/cli/vela-engine.js locate             # 결정론적 targets.json 생성 (LLM 0)

# 기타
node .vela/cli/vela-engine.js history            # 이전 파이프라인 이력
node .vela/cli/vela-engine.js cancel             # 현재 파이프라인 취소
node .vela/cli/vela-friction.js                  # gate-events.jsonl 집계 (VK/VG 분포)
```

**옵션**: `--scale <ship|fix|hotfix>`, `--auto`, `--force` (dirty tree 스킵)

---

## 승인 메커니즘 (파일 기반)

1. PM이 `Agent(subagent_type="vela-reviewer")` 호출 → reviewer가 `review-{step}.md` + `approval-{step}.json` 자동 생성
2. 엔진 `exit_gate`가 `approval-{step}.json`의 `decision` 필드를 확인 — `approve`가 아니면 `transition` 차단
3. REJECT 시: PM이 `reviewFeedback`을 worker에게 재전달 → 재작업 → 재리뷰. `max_revisions` 소진 시 사용자에게 에스컬레이션
4. APPROVE 후 `Stop` 훅(`vela-stop.js`의 review-gate 경로)이 `review_gate.validation_rounds` 횟수만큼 재검증 강제

---

## 보안 훅

| 훅 | 이벤트 | 규칙 |
|----|-------|------|
| `vela-gate.js` | PreToolUse | VK-01~10 (모드별 Bash/Write/Edit 차단, 시크릿 감지, 체인 연산자, researcher 범위) + VG-03/13/14/15 (git commit 안전, pipeline.json 보호, 서킷 브레이커). keeper + guard 통합 (v7.3-M4c) |
| `vela-stop.js` | Stop + SubagentStop | auto 모드 차단 + review-gate 재검증 + dirty tree 경고 + session-end snapshot + 에이전트 텔레메트리. `hook_event_name`으로 내부 dispatch (v7.3-M4d) |
| `vela-session.js` | SessionStart | 버전 체크 + rich context 주입 (persona.md, pipeline state, git, env, v7.3-M4b 통합) |

**Fail-closed**: 모든 훅의 오류 경로는 `exit 2`(차단)로 폴백.

---

## 커스텀 어조 — persona.md

`.vela/persona.md` 파일이 있으면 모든 세션에 자동 주입된다.

```markdown
- 한국어로 답변하라
- 간결하고 명확하게 말하라
- 코드 주석은 영어로 작성하라
```

---

## 상세 레퍼런스

- `references/gates-and-guards.md` — 전체 게이트/가드 규칙 목록 (VK-01~08, VG-03~15)
- `references/cli-reference.md` — CLI 명령어 전체 레퍼런스
- `references/interactive-ui.md` — AskUserQuestion 템플릿 모음
- `CHANGELOG.md` — 버전별 마일스톤 요약
- `README.md` — 프로젝트 소개 + 설치 가이드
