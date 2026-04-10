# Vela-Skill 프로젝트 전체 검증 계획

## 개요

이 계획은 Vela-Skill의 모든 컴포넌트(훅, CLI, 에이전트, 문서, 설정, 배포)에 대한
체계적인 검증을 정의한다. 각 검증 항목은 **대상 → 조건 → 기대 결과** 형식으로 기술된다.

---

## V1. 정적 검증 — 문서/코드 일관성

### V1-1. 삭제된 항목 잔류 검사
```bash
# 삭제된 스킬 디렉토리 없어야 함
[ ! -d skills/init ] && [ ! -d skills/auto ] && echo PASS || echo FAIL

# 삭제된 CLI 명령어 없어야 함 (dispatch 테이블)
grep -n "sub-transition\|wave-execute\|cmdAuto\|cmdDispatch\|cmdSubTransition" \
  scripts/cli/vela-engine.js | grep -v "^.*//.*" && echo FAIL || echo PASS

# 삭제된 명령어 문서에 없어야 함
grep -n "vela:init\|vela:auto\|sub-transition" \
  SKILL.md README.md references/cli-reference.md && echo FAIL || echo PASS

# install.js VALID_SUB_SKILLS에 vela-auto 없어야 함
grep "vela-auto" scripts/install.js | grep -v "Invalid (legacy)" && echo FAIL || echo PASS
```

### V1-2. 훅 등록 일관성
```bash
# registerGlobalHooks가 등록하는 훅 4개 확인
grep "addGlobalHook" scripts/install.js
# 기대: gate-keeper(PreToolUse), gate-guard(PreToolUse), gate-stop(Stop), review-gate(Stop)

# 훅 파일 존재 확인
for f in vela-gate-keeper.js vela-gate-guard.js vela-stop.js vela-review-gate.js; do
  [ -f "scripts/hooks/$f" ] && echo "PASS: $f" || echo "FAIL: $f missing"
done

# 훅 타임아웃 통일 (모두 10초)
grep -A2 "addGlobalHook" scripts/install.js | grep "timeout\|[0-9]"
# 기대: 4개 모두 10
```

### V1-3. vela-engine.js 명령어 목록 일관성
```bash
# dispatch 테이블에 정확히 10개 명령어
node -e "
  const src = require('fs').readFileSync('scripts/cli/vela-engine.js','utf8');
  const match = src.match(/const commands\s*=\s*\{([^}]+)\}/s);
  const keys = match[1].match(/\"[^\"]+\"/g);
  console.log('Commands:', keys);
  console.log('Count:', keys.length, keys.length === 10 ? 'PASS' : 'FAIL');
"

# 헤더 주석과 dispatch 일치 확인
grep "^\s*\*\s*[a-z]" scripts/cli/vela-engine.js | head -15
```

### V1-4. config.json 스키마 검증
```bash
# templates/config.json에 review_gate 섹션 있는지
node -e "
  const c = JSON.parse(require('fs').readFileSync('templates/config.json','utf8'));
  const checks = [
    ['review_gate.enabled', c.review_gate?.enabled === true],
    ['review_gate.validation_rounds', c.review_gate?.validation_rounds === 3],
    ['review_gate.steps', Array.isArray(c.review_gate?.steps)],
    ['changeSurface.enabled', c.changeSurface?.enabled === true],
  ];
  checks.forEach(([k,v]) => console.log(v ? 'PASS' : 'FAIL', k));
"
```

### V1-5. V6 순수성 검사 (기존 테스트)
```bash
bash scripts/tests/test-v6-purity.sh
# 기대: [PASS] V4.1 잔재 없음
```

---

## V2. 훅 단위 검증

### V2-1. vela-gate-keeper.js

#### V2-1-1. 활성 파이프라인 없을 때 즉시 통과
```bash
# 가짜 입력, .vela/artifacts/ 없는 디렉토리에서 실행
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/test.txt"},"cwd":"/tmp"}' \
  | node scripts/hooks/vela-gate-keeper.js
# 기대: exit 0 (차단 없음)
```

#### V2-1-2. read 모드 — Write 차단 (VK-03)
```bash
# pipeline-state.json에 mode:"read" 상태 생성 후
echo '{"tool_name":"Write","tool_input":{"file_path":"src/app.js"},"cwd":"'"$CWD"'"}' \
  | node scripts/hooks/vela-gate-keeper.js
# 기대: exit 2
```

#### V2-1-3. 시크릿 감지 (VK-06)
```bash
# AWS 키 패턴 포함 내용
echo '{"tool_name":"Write","tool_input":{"content":"AKIAIOSFODNN7EXAMPLE"},"cwd":"'"$CWD"'"}' \
  | node scripts/hooks/vela-gate-keeper.js
# 기대: exit 2
```

#### V2-1-4. 체인 연산자 차단 (VK-08)
```bash
echo '{"tool_name":"Bash","tool_input":{"command":"ls && rm -rf /"},"cwd":"'"$CWD"'"}' \
  | node scripts/hooks/vela-gate-keeper.js
# 기대: exit 2
```

#### V2-1-5. 기존 테스트 실행
```bash
bash scripts/tests/test-gate-keeper.sh
bash scripts/tests/test-chain-operators.sh
bash scripts/tests/test-gate-vk07.sh
```

---

### V2-2. vela-gate-guard.js

#### V2-2-1. 활성 파이프라인 없을 때 즉시 통과
```bash
echo '{"tool_name":"Write","tool_input":{},"cwd":"/tmp"}' \
  | node scripts/hooks/vela-gate-guard.js
# 기대: exit 0
```

#### V2-2-2. 서킷 브레이커 발동 (VG-15)
```bash
# circuit-open.json 생성 후
mkdir -p .vela/state
echo '{"step":"execute","count":5,"openAt":"2026-01-01T00:00:00Z"}' \
  > .vela/state/circuit-open.json

echo '{"tool_name":"Write","tool_input":{},"cwd":"'"$CWD"'"}' \
  | node scripts/hooks/vela-gate-guard.js
# 기대: exit 2 (모든 도구 차단)

rm .vela/state/circuit-open.json
```

#### V2-2-3. pipeline.json 직접 수정 차단 (VG-13)
```bash
echo '{"tool_name":"Write","tool_input":{"file_path":".vela/templates/pipeline.json"},"cwd":"'"$CWD"'"}' \
  | node scripts/hooks/vela-gate-guard.js
# 기대: exit 2
```

#### V2-2-4. 기존 테스트 실행
```bash
bash scripts/tests/test-fail-closed.sh
bash scripts/tests/test-s03-relaxation.sh
```

---

### V2-3. vela-stop.js

#### V2-3-1. 활성 파이프라인 없을 때 통과
```bash
echo '{"cwd":"/tmp"}' | node scripts/hooks/vela-stop.js
# 기대: stdout 없음 OR exit 0
```

#### V2-3-2. auto 모드 파이프라인 활성 시 차단
```bash
# pipeline-state.json에 auto:true 상태 설정
# 기대: stdout {"decision":"block","reason":"Auto-mode pipeline..."}
```

#### V2-3-3. 미커밋 변경사항 경고
```bash
# git 변경사항 있는 상태 + 활성 파이프라인
# 기대: stdout {"decision":"block","reason":"⚠️ 미커밋 변경사항..."}
```

---

### V2-4. vela-review-gate.js ⭐ 신규

#### V2-4-1. 활성 파이프라인 없을 때 통과
```bash
echo '{"cwd":"/tmp"}' | node scripts/hooks/vela-review-gate.js
# 기대: stdout 없음, exit 0
```

#### V2-4-2. 해당 단계 아닐 때 통과 (단계 필터)
```bash
# plan-check 단계 (DEFAULT_STEPS에 없음)
# pipeline-state.json의 current_step: "plan-check"
# review-plan-check.md에 "판정: APPROVE" 기록
echo '{"cwd":"'"$CWD"'"}' | node scripts/hooks/vela-review-gate.js
# 기대: exit 0, no block
```

#### V2-4-3. APPROVE + 첫 번째 라운드 → 차단 (1/3)
```bash
# current_step: "research"
# review-research.md: "판정: APPROVE"
# review-gate-research.json: 없음 (count=0)
echo '{"cwd":"'"$CWD"'"}' | node scripts/hooks/vela-review-gate.js
# 기대: 
#   stdout: {"decision":"block","reason":"[VELA REVIEW GATE] RESEARCH 재검증 1/3 ..."}
#   .vela/state/review-gate-research.json: {"count":1,"rounds":3,...}
```

#### V2-4-4. APPROVE + 두 번째 라운드 → 계속 차단 (2/3)
```bash
# review-gate-research.json: {"count":1}
echo '{"cwd":"'"$CWD"'"}' | node scripts/hooks/vela-review-gate.js
# 기대: stdout {"decision":"block",...} count→2
```

#### V2-4-5. APPROVE + 마지막 라운드 완료 → 통과 (3/3)
```bash
# review-gate-research.json: {"count":3}
echo '{"cwd":"'"$CWD"'"}' | node scripts/hooks/vela-review-gate.js
# 기대: stdout 없음, exit 0 (모든 라운드 완료)
```

#### V2-4-6. REJECT → 개입 없음 (PM 처리 위임)
```bash
# review-research.md: "판정: REJECT"
# review-gate-research.json: 없음
echo '{"cwd":"'"$CWD"'"}' | node scripts/hooks/vela-review-gate.js
# 기대: stdout 없음, exit 0 (REJECT는 이 훅이 처리하지 않음)
```

#### V2-4-7. 설정으로 비활성화 (enabled: false)
```bash
# .vela/config.json: { "review_gate": { "enabled": false } }
# review-research.md: "판정: APPROVE"
echo '{"cwd":"'"$CWD"'"}' | node scripts/hooks/vela-review-gate.js
# 기대: exit 0, no block
```

#### V2-4-8. 커스텀 validation_rounds (설정 제어)
```bash
# .vela/config.json: { "review_gate": { "validation_rounds": 1 } }
# review-gate-research.json: {"count":1} (rounds=1 충족)
echo '{"cwd":"'"$CWD"'"}' | node scripts/hooks/vela-review-gate.js
# 기대: exit 0 (1회 설정에서 1회 완료 → 통과)
```

#### V2-4-9. 커스텀 steps (단계 제어)
```bash
# .vela/config.json: { "review_gate": { "steps": ["verify"] } }
# current_step: "research" (steps에 포함 안 됨)
# review-research.md: "판정: APPROVE"
echo '{"cwd":"'"$CWD"'"}' | node scripts/hooks/vela-review-gate.js
# 기대: exit 0 (steps에 없는 단계 → 통과)
```

#### V2-4-10. transition 시 gate 상태 초기화
```bash
# .vela/state/review-gate-research.json 존재
node scripts/cli/vela-engine.js transition
# 기대: .vela/state/review-gate-research.json 삭제됨
```

---

## V3. vela-engine.js CLI 명령어 검증

### V3-1. init
```bash
# 기본 파이프라인 초기화
node .vela/cli/vela-engine.js init "테스트 작업"
# 기대:
#   ok: true
#   pipeline_type: "standard" (기본값)
#   artifact_dir: .vela/artifacts/{YYYYMMDDTHHMMSS}-test-.../ 생성
#   pipeline-state.json 생성
#   status: "active"
#   current_step: "init" 또는 첫 번째 step

# --scale small → trivial 타입
node .vela/cli/vela-engine.js init "소규모 작업" --scale small
# 기대: pipeline_type: "trivial"

# --auto 플래그
node .vela/cli/vela-engine.js init "자동 작업" --auto
# 기대: state.auto: true

# 이미 active 파이프라인 있을 때 재초기화 시도
node .vela/cli/vela-engine.js init "중복 작업"
# 기대: ok: false, error: "Active pipeline exists..."
```

### V3-2. state
```bash
# 활성 파이프라인 있을 때
node .vela/cli/vela-engine.js state
# 기대:
#   ok: true
#   active: true
#   current_step, pipeline_type, artifact_dir 포함

# 활성 파이프라인 없을 때
node .vela/cli/vela-engine.js state
# 기대: ok: true, active: false
```

### V3-3. record
```bash
# pass 기록
node .vela/cli/vela-engine.js record pass
# 기대:
#   ok: true, verdict: "pass"
#   state.revisions[step] 증가
#   circuit-open.json 삭제 (있었다면)

# reject 기록 → auto mode 카운터
node .vela/cli/vela-engine.js record reject
# 기대: auto_reject_count 증가

# reject 2회 연속 → auto 비활성화
node .vela/cli/vela-engine.js record reject
node .vela/cli/vela-engine.js record reject
# 기대: 두 번째 후 auto: false, auto_disabled: true 경고

# fail 5회 → 서킷 브레이커
for i in 1 2 3 4 5; do node .vela/cli/vela-engine.js record fail; done
# 기대: circuit-open.json 생성

# pass 기록 → 서킷 브레이커 리셋
node .vela/cli/vela-engine.js record pass
# 기대: circuit-open.json 삭제, _step_failures_* 리셋
```

### V3-4. transition
```bash
# 정상 전이
node .vela/cli/vela-engine.js transition
# 기대:
#   ok: true
#   current_step 다음 단계로 변경
#   circuit-open.json 삭제
#   review-gate-{prev_step}.json 삭제
#   completed_steps에 이전 단계 추가

# exit_gate 미충족 시 전이 차단
# 기대: ok: false, missing: ["approval_exists", ...]

# 마지막 단계에서 transition
# 기대: ok: true, completed: true, status: "completed"
```

### V3-5. branch / commit / cancel
```bash
# 브랜치 생성 (branch 단계에서)
node .vela/cli/vela-engine.js branch --mode auto
# 기대: vela/{slug}-{HHMM} 브랜치 생성

# 커밋
node .vela/cli/vela-engine.js commit --message "test: validation"
# 기대: git commit 실행, hash 반환

# 취소
node .vela/cli/vela-engine.js cancel
# 기대: state.status: "cancelled"

# cancel 후 state 조회
node .vela/cli/vela-engine.js state
# 기대: active: false
```

### V3-6. history / clean-scan / clean-exec
```bash
# 히스토리 (최소 1개 항목)
node .vela/cli/vela-engine.js history
# 기대: pipelines 배열, status별 목록

# clean-scan (dry-run)
node .vela/cli/vela-engine.js clean-scan
# 기대: findings 객체, totalItems 숫자

# clean-exec (실행)
node .vela/cli/vela-engine.js clean-exec
# 기대: cleaned 항목 수
```

---

## V4. 파이프라인 타입 검증

### V4-1. 각 타입별 단계 수 확인
```bash
node -e "
  const p = JSON.parse(require('fs').readFileSync('templates/pipeline.json','utf8'));
  const types = ['standard','quick','trivial','ralph','hotfix'];
  types.forEach(t => {
    const def = p.types[t];
    const steps = def.steps_only || p.types.standard.steps.map(s=>s.id);
    console.log(t, steps.length, 'steps:', steps.join('→'));
  });
"
# 기대:
#   standard: 12 steps
#   quick: 6 steps
#   trivial: 4 steps
#   ralph: 5 steps (execute↔verify 루프)
#   hotfix: 3 steps
```

### V4-2. ralph 모드 — execute max_revisions=10 확인
```bash
node -e "
  const p = JSON.parse(require('fs').readFileSync('templates/pipeline.json','utf8'));
  const ralph = p.types.ralph;
  console.log('execute max_revisions:', ralph.overrides.execute.max_revisions);
  console.log('verify ralph_loop:', ralph.overrides.verify.ralph_loop);
  // 기대: 10, true
"
```

---

## V5. install.js 검증

### V5-1. 기본 설치 검증
```bash
node scripts/install.js verify
# 기대: 모든 필수 파일 존재, warnings 없음 (또는 sqlite 관련만)
```

### V5-2. registerGlobalHooks — 멱등성
```bash
# 2회 실행해도 동일 결과
node scripts/install.js
node scripts/install.js
# ~/.claude/settings.json의 Stop 훅 중복 없어야 함
node -e "
  const s = JSON.parse(require('fs').readFileSync(
    require('os').homedir()+'/.claude/settings.json','utf8'));
  const stopHooks = s.hooks?.Stop || [];
  console.log('Stop hooks count:', stopHooks.length);
  // 기대: 2 (vela-gate-stop, vela-review-gate) — 중복 없음
"
```

### V5-3. VALID_SUB_SKILLS — 레거시 정리
```bash
# 현재 프로젝트에 vela-init/, vela-auto/ 없으면 삭제됨
node scripts/install.js
# 기대: ~/.claude/skills/vela-init/, vela-auto/ 삭제됨
```

### V5-4. settings.local.json hooks 마이그레이션
```bash
# 기존 hooks 항목 있는 settings.local.json
# install.js 실행 후 hooks 없어야 함
node -e "
  const s = JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8'));
  console.log('hooks in local settings:', s.hooks ? 'FAIL - still exists' : 'PASS - removed');
"
```

---

## V6. 배포 스크립트 검증

### V6-1. install.sh — 서브스킬 루프
```bash
grep "for sub in" install.sh update.sh
# 기대: "start git-clean analyze update" (init, auto 없음)
```

### V6-2. deploy-common.sh — 복사 목록
```bash
# vela-review-gate.js가 복사 목록에 포함되어야 함
grep "vela-review-gate" scripts/deploy-common.sh
# 기대: 포함 (신규 훅 배포)
```

> ⚠️ **TODO**: `scripts/deploy-common.sh`에 `vela-review-gate.js` 복사 라인 추가 필요

---

## V7. 에이전트 문서 검증

### V7-1. PM 에이전트 — 핵심 규칙 포함 확인
```bash
grep -n "REVIEW GATE\|record pass\|record reject\|vela-engine.js state" \
  scripts/agents/vela.md
# 기대: 각 단계(research, plan, execute)에 REVIEW GATE 언급 포함
```

### V7-2. 리뷰어 에이전트 — 판정 형식 확인
```bash
grep -n "판정.*APPROVE\|판정.*REJECT\|Verdict.*APPROVE" \
  scripts/agents/vela-reviewer.md
# 기대: "판정: APPROVE" 또는 "판정: REJECT" 형식 사용
# (vela-review-gate.js의 regex와 일치해야 함)
```

### V7-3. 세션 시작 동작 확인
```bash
grep -n "vela-engine.js state\|세션 시작\|첫.번째" scripts/agents/vela.md
# 기대: 세션 시작 시 state 명령 실행 지시 포함
```

---

## V8. 통합 시나리오 검증

### V8-1. 전체 파이프라인 플로우 (표준)

```
1. vela-engine.js init "테스트 기능 추가"
2. vela-engine.js state  → current_step: init
3. vela-engine.js record pass
4. vela-engine.js transition  → research
5. [researcher 실행 → research.md 생성]
6. [reviewer 실행 → review-research.md 생성: "판정: APPROVE"]
7. vela-review-gate.js  → 차단 (1/3)  ← Stop 훅
8. [reviewer 재실행 → review-research.md 갱신]
9. vela-review-gate.js  → 차단 (2/3)
10. [reviewer 재실행]
11. vela-review-gate.js  → 차단 (3/3)
12. [reviewer 재실행]
13. vela-review-gate.js  → 통과 (3/3 완료)
14. vela-engine.js record pass
15. vela-engine.js transition  → review-gate-research.json 삭제 확인
```

### V8-2. 서킷 브레이커 통합 시나리오

```
1. execute 단계
2. record fail × 5  → circuit-open.json 생성
3. gate-guard에서 Bash 명령 시도  → exit 2 (VG-15 차단)
4. record pass  → circuit-open.json 삭제
5. gate-guard에서 Bash 명령 시도  → exit 0 (정상 허용)
```

### V8-3. review-gate 두 카운터 분리 확인

```
# 실패 카운터 (cmdRecord)
record reject  → state._step_failures_execute: 1
record reject  → state._step_failures_execute: 2

# 재검증 카운터 (vela-review-gate.js)
[APPROVE] vela-review-gate → review-gate-execute.json: {count:1}
[APPROVE] vela-review-gate → review-gate-execute.json: {count:2}

# 두 카운터는 서로 영향 없음
record pass  → _step_failures_execute 리셋 (review-gate count는 유지)
```

### V8-4. auto 모드 + review-gate 연동

```
1. init --auto  → state.auto: true
2. execute 단계: reviewer APPROVE
3. vela-stop.js  → auto 모드로 차단 (기존)
4. vela-review-gate.js  → 재검증 라운드 차단 (신규)
# 두 Stop 훅이 모두 발동, 둘 다 block → PM이 재검증 진행
```

---

## V9. 기존 테스트 전체 실행

```bash
#!/bin/bash
# 전체 기존 테스트 실행 스크립트
cd /home/user/Vela-Skill

PASS=0; FAIL=0

run_test() {
  local name=$1
  local cmd=$2
  if bash $cmd > /dev/null 2>&1; then
    echo "[PASS] $name"
    ((PASS++))
  else
    echo "[FAIL] $name"
    ((FAIL++))
  fi
}

run_test "V6 순수성"         "scripts/tests/test-v6-purity.sh"
run_test "Gate Keeper"       "scripts/tests/test-gate-keeper.sh"
run_test "VK-07 PM 속독"     "scripts/tests/test-gate-vk07.sh"
run_test "체인 연산자 차단"  "scripts/tests/test-chain-operators.sh"
run_test "Fail-Closed"       "scripts/tests/test-fail-closed.sh"
run_test "S03 완화 규칙"     "scripts/tests/test-s03-relaxation.sh"
run_test "Auto 모드"         "scripts/tests/test-auto-mode.sh"
run_test "변경 감지"         "scripts/tests/test-change-surface.sh"
run_test "스프린트 관리자"   "scripts/tests/test-sprint-manager.sh"
run_test "작업트리 관리자"   "scripts/tests/test-worktree-manager.sh"

echo ""
echo "결과: ${PASS} PASS / ${FAIL} FAIL"
```

---

## V10. 신규 테스트 파일 작성 대상

현재 테스트 파일이 없는 컴포넌트:

| 우선순위 | 대상 | 파일명 | 핵심 케이스 |
|---------|------|--------|-----------|
| ⭐ High | vela-review-gate.js | `test-review-gate.sh` | V2-4-1~10 전체 |
| ⭐ High | vela-engine.js record | `test-engine-record.sh` | 서킷 브레이커, auto 모드, revision 카운팅 |
| Medium | vela-engine.js transition | `test-engine-transition.sh` | gate 리셋, sub-phase, 완료 감지 |
| Medium | install.js 멱등성 | `test-install-idempotent.sh` | 중복 설치, 마이그레이션, VALID_SUB_SKILLS |
| Low | vela-stop.js | `test-stop-hook.sh` | auto 모드 차단, 미커밋 경고 |

---

## V11. 검증 실행 순서 (권장)

```
Phase 1: 정적 검증    (V1 전체) — 5분
Phase 2: 훅 단위 검증 (V2 전체) — 20분
Phase 3: CLI 검증     (V3 전체) — 15분
Phase 4: 파이프라인 타입 (V4)  — 5분
Phase 5: install.js  (V5)      — 10분
Phase 6: 배포 스크립트 (V6)    — 5분
Phase 7: 에이전트 문서 (V7)    — 5분
Phase 8: 통합 시나리오 (V8)    — 30분
Phase 9: 기존 테스트 (V9)      — 20분
Phase 10: 신규 테스트 작성 (V10) — 별도 태스크
```

**총 예상 소요**: 약 2시간 (자동화 스크립트 실행 시)

---

## 완료된 후속 작업 (2026-04-10 기준)

| 항목 | 위치 | 상태 |
|------|------|------|
| deploy-common.sh에 vela-review-gate.js 복사 라인 추가 | `scripts/deploy-common.sh` | ✅ 완료 (c66e732 / 3c7671e) |
| test-review-gate.sh 작성 (V2-4 케이스 자동화) | `scripts/tests/test-review-gate.sh` | ✅ 완료 (17/17 PASS) |
| test-engine-record.sh 작성 (V3-3 케이스 자동화) | `scripts/tests/test-engine-record.sh` | ✅ 완료 (20/20 PASS) |
| evals.json에 review-gate eval 추가 | `evals/evals.json` (id=3) | ✅ 완료 |
| install.js FILE_MANIFEST에 vela-review-gate.js 추가 | `scripts/install.js` | ✅ 완료 (3c7671e) |
| V4.1 잔재 훅 제거 (vela-failure/compact/analytics) | `scripts/hooks/` | ✅ 완료 (3c7671e) |
| test-v6-purity.sh 확장 (evals/ 스캔 + team-dispatch 등 패턴) | `scripts/tests/test-v6-purity.sh` | ✅ 완료 |
