#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-executor.sh — sdk-executor.js 계약 테스트
#
# Contract-level verification — module exports, single-stage
# Sonnet execution, task-summary.md fallback writing,
# SDK unavailable handling, SDK error handling, hook isolation.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/hooks/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location (K009).
#
# ⚠ Must NOT run in parallel with test-sdk-runner.sh or
#   test-sdk-reviewer.sh — shared mock directory (K010).
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkExecute function
# Test 3:  SDK unavailable fallback — returns { ok: false, error: 'sdk_not_available' }, no artifacts
# Test 4:  Successful execution — mock SDK returns result, task-summary.md written to artifactDir
# Test 5:  Successful execution details — result has ok:true, step, artifact, model fields
# Test 6:  SDK error — returns ok:false with error details, no task-summary.md written
# Test 7:  settingSources isolation — captured SDK options include settingSources: []
# Test 8:  Fallback task-summary.md content includes step name and model
# K001:    settingSources present in sdk-executor.js source
# Stale:   No stale Executor subagent references in updated files
# New:     vela-engine.js execute present in PM doc files
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/hooks/shared/sdk-executor.js"
MODULE_DIR="$PROJECT_ROOT/scripts/hooks/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
CAPTURE_FILE=""
ARTIFACT_DIR=""

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

# Create temp directories for artifact generation
setup_temp_dirs() {
  ARTIFACT_DIR="$(mktemp -d)"
}

teardown_temp_dirs() {
  rm -rf "$ARTIFACT_DIR" 2>/dev/null || true
}

# Install mock SDK in sdk-runner.js's own node_modules directory
# so dynamic import() resolves it during module resolution.
# Mock returns configurable results based on prompt content:
#   __sdk_error__ → error_during_execution with error details
#   (default)     → success with executor-like output
# Captures options to CAPTURE_FILE for settingSources verification.
setup_mock_sdk() {
  CAPTURE_FILE="$(mktemp)"
  mkdir -p "$MOCK_NM"

  cat > "$MOCK_NM/package.json" <<'MPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.2.0-mock", "main": "index.js", "exports": { ".": "./index.js" } }
MPKG

  cat > "$MOCK_NM/index.js" <<'MOCK'
'use strict';
const fs = require('fs');

function query(args) {
  const captureFile = process.env.SDK_CAPTURE_FILE || '';
  if (captureFile) {
    fs.writeFileSync(captureFile, JSON.stringify(args, null, 2));
  }

  const prompt = (args && args.prompt) || '';

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-executor-session' };

    if (prompt.includes('__sdk_error__')) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: 'Build failed: compilation error in src/main.js',
        errors: ['CompilationError: unexpected token'],
        total_cost_usd: 0.05,
        model: 'mock-sonnet-model',
        session_id: 'mock-executor-session',
        num_turns: 2,
        duration_ms: 300
      };
      return;
    }

    // Default: successful execution
    yield {
      type: 'result',
      subtype: 'success',
      result: 'Implementation complete. All tests passing.\n\nFiles modified:\n- src/main.js\n- tests/main.test.js',
      total_cost_usd: 0.42,
      model: 'mock-sonnet-model',
      session_id: 'mock-executor-session',
      num_turns: 12,
      duration_ms: 15000
    };
  })();
}

module.exports = { query };
MOCK
}

teardown_mock_sdk() {
  rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
  rm -f "$CAPTURE_FILE" 2>/dev/null || true
}

cleanup_all() {
  teardown_mock_sdk
  teardown_temp_dirs
}

# Run node with cache clearing and capture file env.
run_executor_test() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-executor') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Executor 계약 테스트"
echo "─────────────────────────────────────"

setup_temp_dirs
trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sdkExecute function ──
echo ""
echo "📋 Test 2: Exports sdkExecute function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sdkExecute === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sdkExecute is a function" "PASS" "$result"

# ── Test 3: SDK unavailable fallback ──
echo ""
echo "📋 Test 3: SDK unavailable → ok:false, no artifacts"
# Ensure no mock is installed for this test
teardown_mock_sdk 2>/dev/null || true
result=$(node -e "
  Object.keys(require.cache).forEach(k => {
    if (k.includes('sdk-runner') || k.includes('sdk-executor') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { sdkExecute } = require('$MODULE');
  sdkExecute({ step: 'test_unavail', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    console.log(JSON.stringify(r));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "error is sdk_not_available" '"error":"sdk_not_available"' "$result"

# No artifacts should have been written
artifact_count=$(ls -1A "$ARTIFACT_DIR" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "no artifacts written when SDK unavailable" "0" "$artifact_count"

# ── Setup mock SDK for tests 4-8 ──
setup_mock_sdk

# ── Test 4: Successful execution — task-summary.md written ──
echo ""
echo "📋 Test 4: Successful execution → task-summary.md written to artifactDir"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_executor_test "
  const { sdkExecute } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkExecute({ step: 'execute', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const summaryExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'task-summary.md'));
    console.log(r.ok === true && summaryExists ? 'PASS' : 'FAIL:' + JSON.stringify({ ok: r.ok, summaryExists }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "success: ok:true + task-summary.md exists" "PASS" "$result"

# ── Test 5: Successful execution details — ok, step, artifact, model ──
echo ""
echo "📋 Test 5: Successful execution details — ok:true, step, artifact, model fields"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_executor_test "
  const { sdkExecute } = require('$MODULE');
  sdkExecute({ step: 'my_step', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const checks = [
      r.ok === true,
      r.step === 'my_step',
      r.artifact === 'task-summary.md',
      typeof r.model === 'string' && r.model.length > 0,
      typeof r.cost === 'number' && r.cost > 0,
      typeof r.numTurns === 'number',
      typeof r.durationMs === 'number'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "result has ok, step, artifact, model, cost, numTurns, durationMs" "PASS" "$result"

# ── Test 6: SDK error — ok:false, no task-summary.md ──
echo ""
echo "📋 Test 6: SDK error → ok:false with error details, no task-summary.md"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_executor_test "
  const { sdkExecute } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkExecute({ step: '__sdk_error__', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const summaryExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'task-summary.md'));
    const checks = [
      r.ok === false,
      typeof r.error === 'string' && r.error.length > 0,
      !summaryExists
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify({ r, summaryExists }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "SDK error: ok:false, no task-summary.md" "PASS" "$result"

# ── Test 7: settingSources isolation ──
echo ""
echo "📋 Test 7: settingSources isolation — captured SDK options include settingSources: []"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_executor_test "
  const { sdkExecute } = require('$MODULE');
  sdkExecute({ step: 'settings_test', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "settingSources is []" "PASS" "$result"

# ── Test 8: Fallback task-summary.md content includes step name and model ──
echo ""
echo "📋 Test 8: Fallback task-summary.md content includes step name and model"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_executor_test "
  const { sdkExecute } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkExecute({ step: 'verify_content', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const content = fs.readFileSync(path.join('$ARTIFACT_DIR', 'task-summary.md'), 'utf8');
    const hasStep = content.includes('verify_content');
    const hasModel = content.includes('mock-sonnet-model') || content.includes('claude-sonnet');
    const hasHeader = content.includes('# Task Summary');
    console.log(hasStep && hasModel && hasHeader ? 'PASS' : 'FAIL:hasStep=' + hasStep + ',hasModel=' + hasModel + ',hasHeader=' + hasHeader);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "task-summary.md has step name, model, header" "PASS" "$result"

# ── K001 cross-file sweep: settingSources in source ──
echo ""
echo "📋 K001: settingSources present in sdk-executor.js source"
sweep_result=$(rg -n 'settingSources' "$MODULE" 2>/dev/null | head -5)
TOTAL=$((TOTAL + 1))
if [ -n "$sweep_result" ]; then
  echo "  ✅ PASS: settingSources found in source"
  echo "    $sweep_result"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: settingSources NOT found in source"
  FAIL=$((FAIL + 1))
fi

# ── Stale reference sweep: no Executor subagent references ──
echo ""
echo "📋 Stale sweep: no Executor subagent references in updated files"
stale=$(rg -n 'Executor\s+subagent|Executor subagent' \
  "$PROJECT_ROOT/scripts/agents/vela-pm.md" \
  "$PROJECT_ROOT/scripts/agents/pm/pipeline-flow.md" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -z "$stale" ]; then
  echo "  ✅ PASS: no stale Executor subagent references"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: stale references found:"
  echo "    $stale"
  FAIL=$((FAIL + 1))
fi

# ── New reference sweep: vela-engine.js execute present ──
echo ""
echo "📋 New sweep: vela-engine.js execute present in PM doc files"
new_refs=$(rg -n 'vela-engine\.js execute' \
  "$PROJECT_ROOT/scripts/agents/vela-pm.md" \
  "$PROJECT_ROOT/scripts/agents/pm/pipeline-flow.md" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$new_refs" ]; then
  echo "  ✅ PASS: vela-engine.js execute references found"
  echo "    $(echo "$new_refs" | head -3)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: no vela-engine.js execute references found"
  FAIL=$((FAIL + 1))
fi

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
