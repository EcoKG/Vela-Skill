#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-runner.sh — sdk-runner.js 계약 테스트
#
# K004: Contract-level verification — module exports, fallback,
#       option shapes (settingSources, permissionMode, persistSession),
#       result normalization (success + error paths).
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
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
MODULE="$PROJECT_ROOT/scripts/shared/sdk-runner.js"
MODULE_DIR="$PROJECT_ROOT/scripts/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
CAPTURE_FILE=""
COUNTER_FILE=""

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
  COUNTER_FILE="$(mktemp)"
  mkdir -p "$MOCK_NM"

  # package.json with exports field (required for ESM dynamic import)
  cat > "$MOCK_NM/package.json" <<'MPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.2.0-mock", "main": "index.js", "exports": { ".": "./index.js" } }
MPKG

  # Mock index.js — captures query args to file, returns async generator
  cat > "$MOCK_NM/index.js" <<'MOCK'
'use strict';
const fs = require('fs');
const path = require('path');

function query(args) {
  const captureFile = process.env.SDK_CAPTURE_FILE || '';
  if (captureFile) {
    fs.writeFileSync(captureFile, JSON.stringify(args, null, 2));
  }

  const prompt = (args && args.prompt) || '';

  // Rate limit call counter — track across retries within the same process
  const counterFile = process.env.SDK_CALL_COUNTER_FILE || '';

  function getCallCount() {
    if (!counterFile) return 0;
    try { return parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch { return 0; }
  }

  function incrementCallCount() {
    if (!counterFile) return;
    const count = getCallCount() + 1;
    fs.writeFileSync(counterFile, String(count));
  }

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-session-001' };

    if (prompt.includes('__rate_limit__')) {
      // First call: rate limit event + error_during_execution
      // Subsequent calls: success
      incrementCallCount();
      const callNum = getCallCount();

      if (callNum <= 1) {
        yield { type: 'rate_limit_event', status: 'rejected', resets_at: Date.now() + 100 };
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          result: 'Rate limited',
          errors: ['Rate limit exceeded'],
          total_cost_usd: 0.0005,
          num_turns: 1,
          duration_ms: 200
        };
      } else {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Recovered after rate limit',
          total_cost_usd: 0.001,
          model: 'mock-model-v1',
          session_id: 'mock-session-001',
          num_turns: 3,
          duration_ms: 1500
        };
      }
    } else if (prompt.includes('__rate_limit_exhaust__')) {
      // Always return rate limit error (for max retries exhaustion test)
      yield { type: 'rate_limit_event', status: 'rejected' };
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: 'Rate limited',
        errors: ['Rate limit exceeded'],
        total_cost_usd: 0.0005,
        num_turns: 1,
        duration_ms: 200
      };
    } else if (prompt.includes('__structured_output_test__')) {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Structured output test',
        structured_output: { answer: 42, valid: true },
        total_cost_usd: 0.002,
        model: 'mock-model-v1',
        session_id: 'mock-session-001',
        num_turns: 2,
        duration_ms: 800
      };
    } else if (prompt.includes('__error_test__')) {
      yield {
        type: 'result',
        subtype: 'error_max_turns',
        result: 'Max turns exceeded',
        errors: ['Turn limit reached', 'Aborted'],
        total_cost_usd: 0.005,
        num_turns: 10,
        duration_ms: 5000
      };
    } else if (prompt.includes('__checkpoint_test__')) {
      // Emit user messages with UUIDs before the result
      yield { type: 'user', uuid: 'ckpt-001' };
      yield { type: 'user', uuid: 'ckpt-002' };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Checkpoint test completed',
        total_cost_usd: 0.001,
        model: 'mock-model-v1',
        session_id: 'mock-session-001',
        num_turns: 4,
        duration_ms: 1200
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
  rm -f "$COUNTER_FILE" 2>/dev/null || true
}

# Run node with cache clearing, capture file env, from project root.
run_with_mock() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" SDK_CALL_COUNTER_FILE="$COUNTER_FILE" node -e "
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
# Install a broken mock that exports no query() — overrides real SDK at project root.
teardown_mock_sdk 2>/dev/null || true
mkdir -p "$MOCK_NM"
cat > "$MOCK_NM/package.json" <<'BPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.0.0-broken", "main": "index.js", "exports": { ".": "./index.js" } }
BPKG
cat > "$MOCK_NM/index.js" <<'BROKEN'
'use strict';
// Broken mock: no query() export — triggers sdk_not_available in sdk-runner.js
module.exports = {};
BROKEN
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
rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
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

# ── Test 9: Rate limit → auto retry → success ──
echo ""
echo "📋 Test 9: Rate limit → auto retry → success (cost accumulated)"
# Reset call counter for this test
echo "0" > "$COUNTER_FILE"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: '__rate_limit__', retryDelayMs: 10 }).then(r => {
    const checks = [
      r.ok === true,
      r.result === 'Recovered after rate limit',
      r.cost > 0.001,   // accumulated: 0.0005 (fail) + 0.001 (success)
      r.retriesAttempted === 1
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  });
")
assert_eq "rate limit retry → success" "PASS" "$result"

# ── Test 10: Rate limit exhaust → error with retriesAttempted ──
echo ""
echo "📋 Test 10: Rate limit max retries exhausted → error + retriesAttempted"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: '__rate_limit_exhaust__', maxRetries: 2, retryDelayMs: 10 }).then(r => {
    const checks = [
      r.ok === false,
      r.error === 'error_during_execution',
      r.retriesAttempted === 2,
      r.cost > 0  // accumulated across retries
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  });
")
assert_eq "max retries exhausted" "PASS" "$result"

# ── Test 11: Rate limit retry cost accumulation ──
echo ""
echo "📋 Test 11: Rate limit retry — cost accumulated correctly"
echo "0" > "$COUNTER_FILE"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: '__rate_limit__', retryDelayMs: 10 }).then(r => {
    // Cost = 0.0005 (rate-limited attempt) + 0.001 (successful attempt) = 0.0015
    const expectedCost = 0.0015;
    const costMatch = Math.abs(r.cost - expectedCost) < 0.0001;
    console.log(costMatch ? 'PASS' : 'FAIL:cost=' + r.cost + ',expected=' + expectedCost);
  });
")
assert_eq "cost accumulated across retries" "PASS" "$result"

# ── Test 12: computeRetryDelay — backoff clamping ──
echo ""
echo "📋 Test 12: computeRetryDelay — exponential backoff with min/max clamping"
result=$(node -e "
  const { computeRetryDelay } = require('$MODULE');
  const checks = [
    // attempt=0, base=2000 → 2^0 * 2000 = 2000
    computeRetryDelay(0, 2000, null) === 2000,
    // attempt=2, base=2000 → 2^2 * 2000 = 8000
    computeRetryDelay(2, 2000, null) === 8000,
    // attempt=10, base=2000 → clamped to 60000
    computeRetryDelay(10, 2000, null) === 60000,
    // attempt=0, base=100 → clamped to 1000 (minimum)
    computeRetryDelay(0, 100, null) === 1000,
    // with resetsAt in the future
    computeRetryDelay(0, 2000, Date.now() + 3000) >= 2000 && computeRetryDelay(0, 2000, Date.now() + 3000) <= 3500,
    // with resetsAt in the past → falls back to exponential
    computeRetryDelay(0, 2000, Date.now() - 1000) === 2000
  ];
  console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + checks.map((c,i) => i + ':' + c).join(','));
" 2>/dev/null)
assert_eq "computeRetryDelay backoff" "PASS" "$result"

# ── Test 13: outputFormat passthrough to queryOptions ──
echo ""
echo "📋 Test 13: outputFormat passed through to queryOptions"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  const schema = { type: 'object', properties: { answer: { type: 'number' } } };
  runSdkAgent({ prompt: 'fmt test', outputFormat: schema }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const match = JSON.stringify(opts.outputFormat) === JSON.stringify(schema);
    console.log(match ? 'PASS' : 'FAIL:' + JSON.stringify(opts.outputFormat));
  });
")
assert_eq "outputFormat in queryOptions" "PASS" "$result"

# ── Test 14: effort passthrough to queryOptions ──
echo ""
echo "📋 Test 14: effort passed through to queryOptions"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: 'effort test', effort: 'low' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    console.log(opts.effort === 'low' ? 'PASS' : 'FAIL:' + opts.effort);
  });
")
assert_eq "effort in queryOptions" "PASS" "$result"

# ── Test 15: thinking passthrough to queryOptions ──
echo ""
echo "📋 Test 15: thinking passed through to queryOptions"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  const thinkCfg = { type: 'enabled', budget_tokens: 5000 };
  runSdkAgent({ prompt: 'think test', thinking: thinkCfg }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const match = JSON.stringify(opts.thinking) === JSON.stringify(thinkCfg);
    console.log(match ? 'PASS' : 'FAIL:' + JSON.stringify(opts.thinking));
  });
")
assert_eq "thinking in queryOptions" "PASS" "$result"

# ── Test 16: hooks passthrough to queryOptions ──
echo ""
echo "📋 Test 16: hooks passed through to queryOptions"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  const hooks = { onMessage: 'placeholder' };
  runSdkAgent({ prompt: 'hooks test', hooks: hooks }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    console.log(opts.hooks && opts.hooks.onMessage === 'placeholder' ? 'PASS' : 'FAIL:' + JSON.stringify(opts.hooks));
  });
")
assert_eq "hooks in queryOptions" "PASS" "$result"

# ── Test 17: structuredOutput in success result ──
echo ""
echo "📋 Test 17: structuredOutput populated from structured_output in result"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: '__structured_output_test__' }).then(r => {
    const checks = [
      r.ok === true,
      r.structuredOutput != null,
      r.structuredOutput.answer === 42,
      r.structuredOutput.valid === true
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  });
")
assert_eq "structuredOutput in result" "PASS" "$result"

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

# ── Test 18: enableFileCheckpointing passthrough to queryOptions ──
echo ""
echo "📋 Test 18: enableFileCheckpointing passed through to queryOptions"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: 'ckpt test', enableFileCheckpointing: true }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    console.log(opts.enableFileCheckpointing === true ? 'PASS' : 'FAIL:' + opts.enableFileCheckpointing);
  });
")
assert_eq "enableFileCheckpointing in queryOptions" "PASS" "$result"

# ── Test 19: extraArgs passthrough to queryOptions ──
echo ""
echo "📋 Test 19: extraArgs passed through to queryOptions"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  const extra = { foo: 'bar', count: 3 };
  runSdkAgent({ prompt: 'extra test', extraArgs: extra }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const match = JSON.stringify(opts.extraArgs) === JSON.stringify(extra);
    console.log(match ? 'PASS' : 'FAIL:' + JSON.stringify(opts.extraArgs));
  });
")
assert_eq "extraArgs in queryOptions" "PASS" "$result"

# ── Test 20: mcpServers passthrough to queryOptions ──
echo ""
echo "📋 Test 20: mcpServers passed through to queryOptions"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  const servers = { 'vela-tools': { command: 'node', args: ['server.js'] } };
  runSdkAgent({ prompt: 'mcp test', mcpServers: servers }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const match = JSON.stringify(opts.mcpServers) === JSON.stringify(servers);
    console.log(match ? 'PASS' : 'FAIL:' + JSON.stringify(opts.mcpServers));
  });
")
assert_eq "mcpServers in queryOptions" "PASS" "$result"

# ── Test 21: checkpoint UUID capture from user messages ──
echo ""
echo "📋 Test 21: checkpoint UUID capture from user messages"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: '__checkpoint_test__' }).then(r => {
    const checks = [
      r.ok === true,
      Array.isArray(r.checkpoints),
      r.checkpoints.length === 2,
      r.checkpoints[0] === 'ckpt-001',
      r.checkpoints[1] === 'ckpt-002'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r.checkpoints));
  });
")
assert_eq "checkpoint UUIDs captured" "PASS" "$result"

# ── Test 22: checkpoints array empty when no user messages ──
echo ""
echo "📋 Test 22: checkpoints array empty when no user messages"
result=$(run_with_mock "
  const { runSdkAgent } = require('$MODULE');
  runSdkAgent({ prompt: 'no checkpoints test' }).then(r => {
    const checks = [
      r.ok === true,
      Array.isArray(r.checkpoints),
      r.checkpoints.length === 0
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:checkpoints=' + JSON.stringify(r.checkpoints));
  });
")
assert_eq "checkpoints empty array" "PASS" "$result"

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
