#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-wave-executor.sh — wave-executor.js 통합 계약 테스트
#
# Contract-level verification — module exports, error handling,
# vela-engine.js command registration, install.js manifest, and
# vela-wave.js interface compatibility.
#
# No SDK calls — tests run purely against module loading,
# exports, and error paths with temp plan.md files.
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  executeWaves export is function type
# Test 3:  Missing plan.md → { ok: false, error: 'plan_not_found' }
# Test 4:  No Task Distribution → { ok: false, error: 'no_tasks_found' }
# Test 5:  vela-engine.js has wave-execute command registered
# Test 6:  install.js FILE_MANIFEST contains wave-executor.js
# Test 7:  wave-executor.js exports structure (executeWaves key)
# Test 8:  vela-wave.js ↔ wave-executor.js interface compatibility
# Test 9:  Invalid input (null) → { ok: false, error: 'invalid_input' }
# Test 10: Invalid input (array) → { ok: false, error: 'invalid_input' }
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/wave-executor.js"
ENGINE="$PROJECT_ROOT/scripts/cli/vela-engine.js"
INSTALL="$PROJECT_ROOT/scripts/install.js"
WAVE_CLI="$PROJECT_ROOT/scripts/cli/vela-wave.js"
TMP_DIR=""

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"

  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"

  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — '$needle' not found in output"
    FAIL=$((FAIL + 1))
  fi
}

setup_tmp() {
  TMP_DIR="$(mktemp -d)"
}

cleanup() {
  rm -rf "$TMP_DIR" 2>/dev/null || true
}

# ── main ─────────────────────────────────────────────────────

echo "🌊 Wave Executor 통합 계약 테스트"
echo "─────────────────────────────────────"

setup_tmp
trap cleanup EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: executeWaves export is function type ──
echo ""
echo "📋 Test 2: executeWaves export is function type"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.executeWaves === 'function' ? 'PASS' : 'FAIL:' + typeof m.executeWaves);
" 2>/dev/null)
assert_eq "executeWaves is a function" "PASS" "$result"

# ── Test 3: Missing plan.md → { ok: false, error: 'plan_not_found' } ──
echo ""
echo "📋 Test 3: Missing plan.md → plan_not_found"
mkdir -p "$TMP_DIR/empty-dir"
result=$(node -e "
  const { executeWaves } = require('$MODULE');
  executeWaves({
    artifactDir: '$TMP_DIR/empty-dir',
    cwd: '$PROJECT_ROOT',
    pipelineSlug: 'test-missing'
  }).then(r => {
    const checks = [
      r.ok === false,
      r.error === 'plan_not_found'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" 2>/dev/null)
assert_eq "plan_not_found for missing plan.md" "PASS" "$result"

# ── Test 4: No Task Distribution → { ok: false, error: 'no_tasks_found' } ──
echo ""
echo "📋 Test 4: No Task Distribution section → no_tasks_found"
mkdir -p "$TMP_DIR/no-tasks"
cat > "$TMP_DIR/no-tasks/plan.md" <<'PLAN'
# Project Plan

## Architecture
Some architecture content here.

## Test Strategy
Test content here.
PLAN

result=$(node -e "
  const { executeWaves } = require('$MODULE');
  executeWaves({
    artifactDir: '$TMP_DIR/no-tasks',
    cwd: '$PROJECT_ROOT',
    pipelineSlug: 'test-no-tasks'
  }).then(r => {
    const checks = [
      r.ok === false,
      r.error === 'no_tasks_found'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" 2>/dev/null)
assert_eq "no_tasks_found for plan without Task Distribution" "PASS" "$result"

# ── Test 5: vela-engine.js has wave-execute command registered ──
echo ""
echo "📋 Test 5: vela-engine.js has wave-execute command"
wave_cmd=$(grep -c 'wave-execute' "$ENGINE" 2>/dev/null || echo "0")
TOTAL=$((TOTAL + 1))
if [ "$wave_cmd" -ge 1 ]; then
  echo "  ✅ PASS: wave-execute found in vela-engine.js ($wave_cmd occurrences)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: wave-execute NOT found in vela-engine.js"
  FAIL=$((FAIL + 1))
fi

# ── Test 6: install.js FILE_MANIFEST contains wave-executor.js ──
echo ""
echo "📋 Test 6: install.js FILE_MANIFEST contains wave-executor.js"
manifest_hit=$(grep -c 'wave-executor' "$INSTALL" 2>/dev/null || echo "0")
TOTAL=$((TOTAL + 1))
if [ "$manifest_hit" -ge 1 ]; then
  echo "  ✅ PASS: wave-executor.js in FILE_MANIFEST ($manifest_hit occurrences)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: wave-executor.js NOT in FILE_MANIFEST"
  FAIL=$((FAIL + 1))
fi

# ── Test 7: wave-executor.js exports structure (executeWaves key) ──
echo ""
echo "📋 Test 7: wave-executor.js exports structure validation"
result=$(node -e "
  const m = require('$MODULE');
  const keys = Object.keys(m);
  const checks = [
    keys.includes('executeWaves'),
    keys.length >= 1
  ];
  console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:keys=' + JSON.stringify(keys));
" 2>/dev/null)
assert_eq "exports include executeWaves" "PASS" "$result"

# ── Test 8: vela-wave.js ↔ wave-executor.js interface compatibility ──
echo ""
echo "📋 Test 8: vela-wave.js ↔ wave-executor.js interface compatibility"

# Create a plan.md with known tasks and dependencies
mkdir -p "$TMP_DIR/compat-test"
cat > "$TMP_DIR/compat-test/plan.md" <<'PLAN'
## Task Distribution
- Alpha: root task
- Beta: second task (depends: [Alpha])
- Gamma: parallel to Beta (depends: [Alpha])
PLAN

# Verify parsePlanMd → buildDependencyGraph → topologicalSort chain works
# from wave-executor's dependency context (same require path)
result=$(node -e "
  const { parsePlanMd, buildDependencyGraph, topologicalSort } = require('$WAVE_CLI');
  const fs = require('fs');
  const content = fs.readFileSync('$TMP_DIR/compat-test/plan.md', 'utf8');

  // Step 1: parsePlanMd returns array of tasks
  const tasks = parsePlanMd(content);
  const step1 = Array.isArray(tasks) && tasks.length === 3;

  // Step 2: buildDependencyGraph accepts parsed tasks (returns plain object)
  const graph = buildDependencyGraph(tasks);
  const step2 = typeof graph === 'object' && graph !== null
    && Array.isArray(graph.taskNames) && graph.taskNames.length === 3;

  // Step 3: topologicalSort returns waves array
  const waves = topologicalSort(graph);
  const step3 = Array.isArray(waves) && waves.length === 2;

  // Step 4: Verify wave contents match expected grouping
  const step4 = waves[0].length === 1 && waves[0][0] === 'Alpha'
    && waves[1].length === 2
    && waves[1].includes('Beta') && waves[1].includes('Gamma');

  const checks = [step1, step2, step3, step4];
  console.log(checks.every(Boolean) ? 'PASS'
    : 'FAIL:steps=' + JSON.stringify({step1, step2, step3, step4, tasks: tasks.length, waves}));
" 2>/dev/null)
assert_eq "parsePlanMd → buildDependencyGraph → topologicalSort chain OK" "PASS" "$result"

# ── Test 9: Invalid input (null) → invalid_input ──
echo ""
echo "📋 Test 9: Invalid input (null) → invalid_input"
result=$(node -e "
  const { executeWaves } = require('$MODULE');
  executeWaves(null).then(r => {
    const checks = [r.ok === false, r.error === 'invalid_input'];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" 2>/dev/null)
assert_eq "null input → invalid_input" "PASS" "$result"

# ── Test 10: Invalid input (array) → invalid_input ──
echo ""
echo "📋 Test 10: Invalid input (array) → invalid_input"
result=$(node -e "
  const { executeWaves } = require('$MODULE');
  executeWaves([1,2,3]).then(r => {
    const checks = [r.ok === false, r.error === 'invalid_input'];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" 2>/dev/null)
assert_eq "array input → invalid_input" "PASS" "$result"

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
