#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-integration.sh — SDK 통합 테스트
#
# 5개 SDK 테스트 스위트 순차 실행 + 크로스 모듈 검증 + 문서 일관성.
# K010: 병렬 실행 금지 — 모든 스위트는 순차 실행.
# K001: Stale reference broad sweep 포함.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TOTAL=0
PASS=0
FAIL=0

pass() {
  TOTAL=$((TOTAL + 1))
  PASS=$((PASS + 1))
  echo "  ✅ PASS: $1"
}

fail() {
  TOTAL=$((TOTAL + 1))
  FAIL=$((FAIL + 1))
  echo "  ❌ FAIL: $1"
}

# ══════════════════════════════════════════════════════════════
# Phase 1: 개별 테스트 스위트 순차 실행
# ══════════════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════════"
echo "Phase 1: 개별 테스트 스위트 순차 실행"
echo "══════════════════════════════════════════════════════════"

SUITES=(
  "test-sdk-runner.sh"
  "test-sdk-reviewer.sh"
  "test-sdk-plan-checker.sh"
  "test-sdk-researcher.sh"
  "test-sdk-executor.sh"
)

for suite in "${SUITES[@]}"; do
  echo ""
  echo "── $suite ──"
  if bash "$SCRIPT_DIR/$suite"; then
    pass "$suite 전체 통과"
  else
    fail "$suite 실패 (exit code $?)"
  fi
done

# ══════════════════════════════════════════════════════════════
# Phase 2: 크로스 모듈 검증
# ══════════════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════════"
echo "Phase 2: 크로스 모듈 검증"
echo "══════════════════════════════════════════════════════════"

# Test: 5개 SDK 모듈 require() 가능 + 올바른 export 함수
echo ""
echo "── 모듈 로드 + export 검증 ──"

MODULES=(
  "sdk-runner.js:runSdkAgent"
  "sdk-reviewer.js:sdkReview"
  "sdk-plan-checker.js:sdkPlanCheck"
  "sdk-researcher.js:sdkResearch"
  "sdk-executor.js:sdkExecute"
)

for entry in "${MODULES[@]}"; do
  modfile="${entry%%:*}"
  expected_fn="${entry##*:}"
  modpath="$PROJECT_ROOT/scripts/shared/$modfile"

  result=$(node -e "
    try {
      const m = require('$modpath');
      if (typeof m.$expected_fn === 'function') {
        console.log('OK');
      } else {
        console.log('MISSING_FN');
      }
    } catch (e) {
      console.log('LOAD_ERROR: ' + e.message);
    }
  " 2>&1)

  if [ "$result" = "OK" ]; then
    pass "$modfile exports $expected_fn()"
  else
    fail "$modfile: $result"
  fi
done

# Test: 모든 모듈에 settingSources 참조 존재
echo ""
echo "── settingSources 참조 검증 ──"

for entry in "${MODULES[@]}"; do
  modfile="${entry%%:*}"
  modpath="$PROJECT_ROOT/scripts/shared/$modfile"

  if rg -q 'settingSources' "$modpath" 2>/dev/null; then
    pass "$modfile contains settingSources"
  else
    fail "$modfile missing settingSources reference"
  fi
done

# ══════════════════════════════════════════════════════════════
# Phase 3: 문서 일관성 검증
# ══════════════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════════"
echo "Phase 3: 문서 일관성 검증"
echo "══════════════════════════════════════════════════════════"

# Test: SKILL.md에 stale 'Reviewer subagent 소환' 참조 0건
echo ""
echo "── stale reference 검증 ──"

stale_count=$(rg -c 'Reviewer subagent 소환' "$PROJECT_ROOT/SKILL.md" 2>/dev/null || echo "0")
if [ "$stale_count" = "0" ]; then
  pass "SKILL.md에 'Reviewer subagent 소환' 참조 0건"
else
  fail "SKILL.md에 'Reviewer subagent 소환' 참조 ${stale_count}건 발견"
fi

# Test: install.js에 5개 SDK 모듈 포함
echo ""
echo "── install.js SDK 모듈 포함 검증 ──"

INSTALL_JS="$PROJECT_ROOT/scripts/install.js"
SDK_NAMES=("sdk-runner" "sdk-reviewer" "sdk-plan-checker" "sdk-researcher" "sdk-executor")

install_src=$(cat "$INSTALL_JS")
all_present=true
missing_list=""

for sdk in "${SDK_NAMES[@]}"; do
  if echo "$install_src" | grep -q "$sdk"; then
    : # present
  else
    all_present=false
    missing_list="$missing_list $sdk"
  fi
done

if $all_present; then
  pass "install.js에 5개 SDK 모듈 모두 포함"
else
  fail "install.js에 누락:$missing_list"
fi

# Test: cli-reference.md에 4개 새 커맨드 존재
echo ""
echo "── cli-reference.md 커맨드 검증 ──"

CLI_REF="$PROJECT_ROOT/references/cli-reference.md"
COMMANDS=("review" "plan-check" "research" "execute")
all_cmds=true
missing_cmds=""

for cmd in "${COMMANDS[@]}"; do
  if rg -q "vela-engine.js $cmd" "$CLI_REF" 2>/dev/null; then
    : # present
  else
    all_cmds=false
    missing_cmds="$missing_cmds $cmd"
  fi
done

if $all_cmds; then
  pass "cli-reference.md에 4개 SDK 커맨드 모두 존재"
else
  fail "cli-reference.md에 누락:$missing_cmds"
fi

# ══════════════════════════════════════════════════════════════
# Phase 4: K001 최종 broad sweep
# ══════════════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════════"
echo "Phase 4: K001 최종 broad sweep"
echo "══════════════════════════════════════════════════════════"

echo ""
echo "── stale subagent/reviewer 패턴 스윕 ──"

sweep_output=$(rg -i 'subagent.*소환.*reviewer|reviewer.*subagent.*소환' "$PROJECT_ROOT/SKILL.md" "$PROJECT_ROOT/scripts/" --glob '!test-sdk-integration.sh' 2>/dev/null || true)
sweep_hits=0
if [ -n "$sweep_output" ]; then
  sweep_hits=$(echo "$sweep_output" | wc -l | tr -d ' ')
fi

if [ "$sweep_hits" = "0" ]; then
  pass "K001 broad sweep: stale subagent/reviewer 패턴 0건"
else
  fail "K001 broad sweep: stale subagent/reviewer 패턴 ${sweep_hits}건 발견"
  rg -in 'subagent.*소환.*reviewer|reviewer.*subagent.*소환' "$PROJECT_ROOT/SKILL.md" "$PROJECT_ROOT/scripts/" --glob '!test-sdk-integration.sh' 2>/dev/null || true
fi

# ══════════════════════════════════════════════════════════════
# Results
# ══════════════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════════"
echo "통합 테스트 결과: $PASS/$TOTAL PASS, $FAIL FAIL"
echo "══════════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
