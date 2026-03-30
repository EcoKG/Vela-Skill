#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-analyzer.sh — sdk-analyzer.js 계약 테스트
#
# Contract-level verification — module exports, 5-perspective
# parallel analysis with PERSPECTIVE markers, SDK fallback,
# partial/total failure, perspective filtering, model selection,
# JSON extraction, hook isolation.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/hooks/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# ⚠ K010: Must NOT run in parallel with test-sdk-researcher.sh,
#   test-sdk-runner.sh, or test-sdk-plan-checker.sh (shared mock directory).
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkAnalyze function
# Test 3:  SDK unavailable fallback — returns { ok: false, error: 'sdk_not_available' }
# Test 4:  All 5 perspectives succeed — 5 entries, each ok:true
# Test 5:  Partial failure (security fails) — ok:true, failed perspective ok:false
# Test 6:  All perspectives fail — ok:false
# Test 7:  Perspective filtering — requesting 2 of 5 returns exactly 2
# Test 8:  Model selection — model passed through to SDK
# Test 9:  settingSources isolation — captured SDK options include settingSources: []
# Test 10: Perspective markers — rg finds 5 markers in source
# Test 11: JSON extraction — mock returns embedded json block, findings extracted
# K001:    settingSources present in sdk-analyzer.js source
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/hooks/shared/sdk-analyzer.js"
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

# Install mock SDK in sdk-runner.js's own node_modules directory.
# Mock's query() function reads the system prompt to find [PERSPECTIVE:xxx]
# markers (K012) to return perspective-specific responses.
#
# Failure control: SDK_FAIL_PERSPECTIVES env var (comma-separated) lists
# perspectives that should fail. SDK_FAIL_ALL=1 makes all perspectives fail.
# This avoids relying on prompt injection since sdk-analyzer builds its
# own fixed prompt strings.
#
# JSON extraction: SDK_JSON_FINDINGS=1 triggers response with embedded
# ```json block containing a findings array (for extractFindings test).
#
# Captures SDK options via appendFileSync (K012 — parallel-safe)
# to CAPTURE_FILE for isolation checks.
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
  const prompt = (args && args.prompt) || '';
  const options = (args && args.options) || {};
  const systemPrompt = options.systemPrompt || '';

  // Determine perspective from system prompt marker (K012)
  let perspective = 'unknown';
  if (systemPrompt.includes('[PERSPECTIVE:security]')) perspective = 'security';
  else if (systemPrompt.includes('[PERSPECTIVE:bugs]')) perspective = 'bugs';
  else if (systemPrompt.includes('[PERSPECTIVE:performance]')) perspective = 'performance';
  else if (systemPrompt.includes('[PERSPECTIVE:code-quality]')) perspective = 'code-quality';
  else if (systemPrompt.includes('[PERSPECTIVE:architecture]')) perspective = 'architecture';

  // Capture to file (appendFileSync for parallel calls — K012)
  if (captureFile) {
    try {
      fs.appendFileSync(captureFile, JSON.stringify({ perspective, options, prompt }) + '\n');
    } catch (_) { /* ignore capture errors */ }
  }

  // Failure control via env vars (sdk-analyzer builds its own prompts)
  const failAll = process.env.SDK_FAIL_ALL === '1';
  const failList = (process.env.SDK_FAIL_PERSPECTIVES || '').split(',').filter(Boolean);
  const shouldFail = failAll || failList.includes(perspective);

  // JSON extraction test mode
  const jsonFindings = process.env.SDK_JSON_FINDINGS === '1';

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-analyzer-' + perspective };

    if (shouldFail) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: 'Simulated failure for ' + perspective,
        total_cost_usd: 0.0001,
        model: options.model || 'mock-haiku',
        session_id: 'mock-analyzer-' + perspective,
        num_turns: 1,
        duration_ms: 50
      };
    } else if (jsonFindings) {
      // Return a response with embedded ```json block for extraction test
      var findingsJson = JSON.stringify({
        findings: [{
          name: 'Test finding from ' + perspective,
          severity: 'high',
          file: 'src/test.js',
          line: 10,
          description: 'Test issue in ' + perspective,
          suggestion: 'Fix it'
        }]
      });
      yield {
        type: 'result',
        subtype: 'success',
        result: '# Analysis Result\n\n```json\n' + findingsJson + '\n```\n\nAnalysis complete.',
        total_cost_usd: 0.002,
        model: options.model || 'mock-haiku',
        session_id: 'mock-analyzer-' + perspective,
        num_turns: 2,
        duration_ms: 100
      };
    } else {
      // Normal success — bare JSON with empty findings
      yield {
        type: 'result',
        subtype: 'success',
        result: '{"findings": []}',
        total_cost_usd: 0.001,
        model: options.model || 'mock-haiku',
        session_id: 'mock-analyzer-' + perspective,
        num_turns: 2,
        duration_ms: 150
      };
    }
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
}

# Run node with cache clearing, capture file env, and optional fail controls.
# Usage: run_analyzer_test "js_code" [FAIL_PERSPECTIVES] [FAIL_ALL] [JSON_FINDINGS]
run_analyzer_test() {
  local js_code="$1"
  local fail_perspectives="${2:-}"
  local fail_all="${3:-0}"
  local json_findings="${4:-0}"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" \
  SDK_FAIL_PERSPECTIVES="$fail_perspectives" \
  SDK_FAIL_ALL="$fail_all" \
  SDK_JSON_FINDINGS="$json_findings" \
  node -e "
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-analyzer') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Analyzer 계약 테스트"
echo "─────────────────────────────────────"

trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sdkAnalyze function ──
echo ""
echo "📋 Test 2: Exports sdkAnalyze function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sdkAnalyze === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sdkAnalyze is a function" "PASS" "$result"

# ── Test 3: SDK unavailable fallback ──
echo ""
echo "📋 Test 3: SDK unavailable → returns { ok: false, error: 'sdk_not_available' }"
# Install a broken mock that does NOT export query() — triggers sdk_not_available
# (Real SDK may be installed at project level, so simply removing the mock doesn't work)
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
    if (k.includes('sdk-runner') || k.includes('sdk-analyzer') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { sdkAnalyze } = require('$MODULE');
  sdkAnalyze({ perspectives: ['security', 'bugs'], cwd: '/tmp' }).then(r => {
    console.log(JSON.stringify({ ok: r.ok, error: r.error }));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
# Clean up broken mock before assertions (setup_mock_sdk will reinstall the real mock)
rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "error is sdk_not_available" '"error":"sdk_not_available"' "$result"

# ── Setup mock SDK for tests 4-11 ──
setup_mock_sdk

# ── Test 4: All 5 perspectives succeed ──
echo ""
echo "📋 Test 4: All 5 perspectives succeed → 5 entries, each ok:true"
> "$CAPTURE_FILE"
result=$(run_analyzer_test "
  const { sdkAnalyze } = require('$MODULE');
  sdkAnalyze({ perspectives: ['security', 'bugs', 'performance', 'code-quality', 'architecture'], cwd: '/tmp' }).then(r => {
    const okCount = r.perspectives.filter(p => p.ok).length;
    const total = r.perspectives.length;
    console.log(JSON.stringify({ ok: r.ok, okCount, total }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
")
assert_contains "ok is true" '"ok":true' "$result"
assert_contains "5 perspectives ok" '"okCount":5' "$result"
assert_contains "5 total perspectives" '"total":5' "$result"

# ── Test 5: Partial failure (security fails, others succeed) ──
echo ""
echo "📋 Test 5: Partial failure (security fails) → ok:true, failed perspective ok:false"
> "$CAPTURE_FILE"
result=$(run_analyzer_test "
  const { sdkAnalyze } = require('$MODULE');
  sdkAnalyze({ perspectives: ['security', 'bugs', 'performance', 'code-quality', 'architecture'], cwd: '/tmp' }).then(r => {
    const okCount = r.perspectives.filter(p => p.ok).length;
    const failCount = r.perspectives.filter(p => !p.ok).length;
    const secFailed = r.perspectives.find(p => p.perspective === 'security' && !p.ok) != null;
    console.log(JSON.stringify({ ok: r.ok, okCount, failCount, secFailed }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
" "security")
assert_contains "ok is true (partial success)" '"ok":true' "$result"
assert_contains "4 perspectives ok" '"okCount":4' "$result"
assert_contains "1 perspective failed" '"failCount":1' "$result"
assert_contains "security perspective failed" '"secFailed":true' "$result"

# ── Test 6: All perspectives fail ──
echo ""
echo "📋 Test 6: All perspectives fail → ok:false"
> "$CAPTURE_FILE"
result=$(run_analyzer_test "
  const { sdkAnalyze } = require('$MODULE');
  sdkAnalyze({ perspectives: ['security', 'bugs', 'performance', 'code-quality', 'architecture'], cwd: '/tmp' }).then(r => {
    const okCount = r.perspectives.filter(p => p.ok).length;
    console.log(JSON.stringify({ ok: r.ok, okCount }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
" "" "1")
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "0 perspectives ok" '"okCount":0' "$result"

# ── Test 7: Perspective filtering — requesting 2 of 5 ──
echo ""
echo "📋 Test 7: Perspective filtering — requesting 2 of 5 returns exactly 2"
> "$CAPTURE_FILE"
result=$(run_analyzer_test "
  const { sdkAnalyze } = require('$MODULE');
  sdkAnalyze({ perspectives: ['security', 'architecture'], cwd: '/tmp' }).then(r => {
    const total = r.perspectives.length;
    const keys = r.perspectives.map(p => p.perspective).sort().join(',');
    console.log(JSON.stringify({ ok: r.ok, total, keys }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
")
assert_contains "ok is true" '"ok":true' "$result"
assert_contains "2 perspectives returned" '"total":2' "$result"
assert_contains "correct perspective keys" '"keys":"architecture,security"' "$result"

# ── Test 8: Model selection — model passed through to SDK ──
echo ""
echo "📋 Test 8: Model selection — model passed through to SDK"
> "$CAPTURE_FILE"
result=$(run_analyzer_test "
  const { sdkAnalyze } = require('$MODULE');
  sdkAnalyze({ perspectives: ['security'], cwd: '/tmp', model: 'claude-sonnet-4-5-20250929' }).then(r => {
    const fs = require('fs');
    const lines = fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    const modelPassed = entry.options && entry.options.model === 'claude-sonnet-4-5-20250929';
    console.log(JSON.stringify({ ok: r.ok, modelPassed, model: r.model }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
")
assert_contains "model passed to SDK" '"modelPassed":true' "$result"
assert_contains "model in result" '"model":"claude-sonnet-4-5-20250929"' "$result"

# ── Test 9: settingSources isolation ──
echo ""
echo "📋 Test 9: settingSources isolation — captured SDK options include settingSources: []"
> "$CAPTURE_FILE"
result=$(run_analyzer_test "
  const { sdkAnalyze } = require('$MODULE');
  sdkAnalyze({ perspectives: ['security', 'bugs', 'performance', 'code-quality', 'architecture'], cwd: '/tmp' }).then(r => {
    const fs = require('fs');
    const lines = fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8').trim().split('\n');
    const allHaveEmptySettingSources = lines.every(line => {
      const entry = JSON.parse(line);
      const ss = entry.options && entry.options.settingSources;
      return Array.isArray(ss) && ss.length === 0;
    });
    const count = lines.length;
    console.log(JSON.stringify({ allIsolated: allHaveEmptySettingSources, captureCount: count }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
")
assert_contains "all calls have settingSources:[]" '"allIsolated":true' "$result"
assert_contains "5 SDK calls captured" '"captureCount":5' "$result"

# ── Test 10: Perspective markers present in source ──
echo ""
echo "📋 Test 10: Perspective markers — rg finds 5 markers in source"
TOTAL=$((TOTAL + 1))
sec_marker=$(rg -c '\[PERSPECTIVE:security\]' "$MODULE" 2>/dev/null || echo "0")
bugs_marker=$(rg -c '\[PERSPECTIVE:bugs\]' "$MODULE" 2>/dev/null || echo "0")
perf_marker=$(rg -c '\[PERSPECTIVE:performance\]' "$MODULE" 2>/dev/null || echo "0")
cq_marker=$(rg -c '\[PERSPECTIVE:code-quality\]' "$MODULE" 2>/dev/null || echo "0")
arch_marker=$(rg -c '\[PERSPECTIVE:architecture\]' "$MODULE" 2>/dev/null || echo "0")
if [ "$sec_marker" -gt 0 ] && [ "$bugs_marker" -gt 0 ] && [ "$perf_marker" -gt 0 ] && [ "$cq_marker" -gt 0 ] && [ "$arch_marker" -gt 0 ]; then
  echo "  ✅ PASS: All 5 perspective markers found in source"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Missing markers — sec:$sec_marker bugs:$bugs_marker perf:$perf_marker cq:$cq_marker arch:$arch_marker"
  FAIL=$((FAIL + 1))
fi

# ── Test 11: JSON extraction — mock returns embedded json block ──
echo ""
echo "📋 Test 11: JSON extraction — embedded json block → findings extracted"
> "$CAPTURE_FILE"
result=$(run_analyzer_test "
  const { sdkAnalyze } = require('$MODULE');
  sdkAnalyze({ perspectives: ['security', 'bugs'], cwd: '/tmp' }).then(r => {
    const secResult = r.perspectives.find(p => p.perspective === 'security');
    const bugsResult = r.perspectives.find(p => p.perspective === 'bugs');
    const secFindings = secResult ? secResult.findings.length : -1;
    const bugsFindings = bugsResult ? bugsResult.findings.length : -1;
    const secName = secResult && secResult.findings[0] ? secResult.findings[0].name : '';
    const bugsName = bugsResult && bugsResult.findings[0] ? bugsResult.findings[0].name : '';
    console.log(JSON.stringify({ ok: r.ok, secFindings, bugsFindings, secName, bugsName }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
" "" "0" "1")
assert_contains "ok is true" '"ok":true' "$result"
assert_contains "security has 1 finding" '"secFindings":1' "$result"
assert_contains "bugs has 1 finding" '"bugsFindings":1' "$result"
assert_contains "security finding name" 'Test finding from security' "$result"
assert_contains "bugs finding name" 'Test finding from bugs' "$result"

# ── K001 cross-file sweep: settingSources in source ──
echo ""
echo "📋 K001: settingSources present in sdk-analyzer.js source"
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
