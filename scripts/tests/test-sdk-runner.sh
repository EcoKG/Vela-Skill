#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-runner.sh — sdk-runner.js 계약 테스트
#
# K004: Contract-level verification — module exports, fallback,
#       option shapes (settingSources, permissionMode, persistSession),
#       result normalization (success + error paths).
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/hooks/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# Test 1: Module loads without syntax error (node -c)
# Test 2: Exports runSdkAgent function
# Test 3: SDK unavailable fallback — returns { ok: false, error: 'sdk_not_available' }
# Test 4: Options shape — settingSources isolation (must be [])
# Test 5: Options shape — default permissionMode ('bypassPermissions')
# Test 6: Options shape — persistSession default (false)
# Test 7: Result normalization — success path
# Test 8: Result normalization — error path
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/hooks/shared/sdk-runner.js"
MODULE_DIR="$PROJECT_ROOT/scripts/hooks/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
CAPTURE_FILE=""

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

# Install mock SDK in sdk-runner.js's own node_modules directory
# so dynamic import() resolves it during module resolution.
setup_mock_sdk() {
  CAPTURE_FILE="$(mktemp)"
  mkdir -p "$MOCK_NM"

  # package.json with exports field (required for ESM dynamic import)
  cat > "$MOCK_NM/package.json" <<'MPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.2.0-mock", "main": "index.js", "exports": { ".": "./index.js" } }
MPKG

  # Mock index.js — captures query args to file, returns async generator
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
    yield { type: 'system', subtype: 'init', session_id: 'mock-session-001' };

    if (prompt.includes('__error_test__')) {
      yield {
        type: 'result',
        subtype: 'error_max_turns',
        result: 'Max turns exceeded',
        errors: ['Turn limit reached', 'Aborted'],
        total_cost_usd: 0.005,
        num_turns: 10,
        duration_ms: 5000
      };
    } else {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Mock task completed successfully',
        total_cost_usd: 0.001,
        model: 'mock-model-v1',
        session_id: 'mock-session-001',
        num_turns: 3,
        duration_ms: 1500
      };
    }
  })();
}

module.exports = { query };
MOCK
}

teardown_mock_sdk() {
  # Remove the temporary mock from sdk-runner.js's node_modules
  rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
  rm -f "$CAPTURE_FILE" 2>/dev/null || true
}

# Run node with cache clearing, capture file env, from project root.
run_with_mock() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    // Clear cached modules to pick up mock on each test
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Runner 계약 테스트"
echo "─────────────────────────────────────"

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports runSdkAgent function ──
echo ""
echo "📋 Test 2: Exports runSdkAgent function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.runSdkAgent === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "runSdkAgent is a function" "PASS" "$result"

# ── Test 3: SDK unavailable fallback ──
echo ""
echo "📋 Test 3: SDK unavailable fallback (no crash, returns sdk_not_available)"
# Ensure no mock is installed for this test
teardown_mock_sdk 2>/dev/null || true
result=$(node -e "
  Object.keys(require.cache).forEach(k => {
    if (k.includes('sdk-runner') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: 'test' }).then(r => {
    console.log(JSON.stringify(r));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "error is sdk_not_available" '"error":"sdk_not_available"' "$result"

# ── Setup mock SDK for tests 4-8 ──
setup_mock_sdk
trap teardown_mock_sdk EXIT

# ── Test 4: Options shape — settingSources isolation ──
echo ""
echo "📋 Test 4: settingSources must be [] (hook isolation)"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: 'isolation test' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  });
")
assert_eq "settingSources is []" "PASS" "$result"

# ── Test 5: Options shape — default permissionMode ──
echo ""
echo "📋 Test 5: permissionMode = 'bypassPermissions' and allowDangerouslySkipPermissions = true"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: 'permission test' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const pm = opts.permissionMode === 'bypassPermissions';
    const skip = opts.allowDangerouslySkipPermissions === true;
    console.log(pm && skip ? 'PASS' : 'FAIL:pm=' + opts.permissionMode + ',skip=' + opts.allowDangerouslySkipPermissions);
  });
")
assert_eq "permissionMode and allowDangerouslySkipPermissions" "PASS" "$result"

# ── Test 6: Options shape — persistSession default ──
echo ""
echo "📋 Test 6: persistSession defaults to false"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: 'persist test' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    console.log(opts.persistSession === false ? 'PASS' : 'FAIL:' + opts.persistSession);
  });
")
assert_eq "persistSession is false" "PASS" "$result"

# ── Test 7: Result normalization — success path ──
echo ""
echo "📋 Test 7: Result normalization — success → { ok: true, result, cost, ... }"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: 'success test' }).then(r => {
    const checks = [
      r.ok === true,
      r.result === 'Mock task completed successfully',
      r.cost === 0.001,
      r.sessionId === 'mock-session-001',
      r.numTurns === 3,
      typeof r.durationMs === 'number'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  });
")
assert_eq "success result shape" "PASS" "$result"

# ── Test 8: Result normalization — error path ──
echo ""
echo "📋 Test 8: Result normalization — error → { ok: false, error: subtype, details, ... }"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: '__error_test__' }).then(r => {
    const checks = [
      r.ok === false,
      r.error === 'error_max_turns',
      r.details === 'Turn limit reached, Aborted',
      r.cost === 0.005,
      r.numTurns === 10,
      typeof r.durationMs === 'number'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  });
")
assert_eq "error result shape" "PASS" "$result"

# ── K001 cross-file sweep: settingSources in source ──
echo ""
echo "📋 K001: settingSources present in sdk-runner.js source"
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

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
