#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-researcher.sh — sdk-researcher.js 계약 테스트
#
# Contract-level verification — module exports, 3-perspective
# parallel research with PERSPECTIVE markers, SDK fallback,
# partial/total failure, hook isolation.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# ⚠ K010: Must NOT run in parallel with test-sdk-plan-checker.sh or
#   test-sdk-runner.sh (shared mock directory).
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkResearch function
# Test 3:  SDK unavailable fallback — research.md still written with error content
# Test 4:  All 3 perspectives succeed — research.md contains all 3 sections, ok:true
# Test 5:  One perspective fails (partial success) — 2 success + 1 error section
# Test 6:  All perspectives fail — research.md still written with error content
# Test 7:  settingSources isolation — captured SDK options include settingSources: []
# Test 8:  Perspective markers present in system prompts (grep source)
# K001:    settingSources present in sdk-researcher.js source
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/sdk-researcher.js"
MODULE_DIR="$PROJECT_ROOT/scripts/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
CAPTURE_FILE=""
ARTIFACT_DIR=""
CWD_DIR=""

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
  CWD_DIR="$(mktemp -d)"
}

teardown_temp_dirs() {
  rm -rf "$ARTIFACT_DIR" "$CWD_DIR" 2>/dev/null || true
}

# Install mock SDK in sdk-runner.js's own node_modules directory.
# Mock's query() generator detects [PERSPECTIVE:xxx] markers in
# options.systemPrompt to return perspective-specific results.
# Supports __research_fail__ (all fail) and __fail_<perspective>__
# (single perspective fail) markers in prompt arg.
# Captures SDK options via appendFileSync (parallel-safe) to
# CAPTURE_FILE for isolation checks.
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

  // Determine perspective from system prompt marker
  let perspective = 'unknown';
  if (systemPrompt.includes('[PERSPECTIVE:architecture]')) perspective = 'architecture';
  else if (systemPrompt.includes('[PERSPECTIVE:security]')) perspective = 'security';
  else if (systemPrompt.includes('[PERSPECTIVE:quality]')) perspective = 'quality';

  // Capture to file (append for parallel calls)
  if (captureFile) {
    try {
      fs.appendFileSync(captureFile, JSON.stringify({ perspective, options }) + '\n');
    } catch (_) { /* ignore capture errors */ }
  }

  // Determine if this perspective should fail
  const shouldFail = prompt.includes('__research_fail__') || prompt.includes('__fail_' + perspective + '__');

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-researcher-' + perspective };

    if (shouldFail) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: 'Simulated failure for ' + perspective,
        total_cost_usd: 0.0001,
        model: 'mock-haiku',
        session_id: 'mock-researcher-' + perspective,
        num_turns: 1,
        duration_ms: 50
      };
    } else {
      yield {
        type: 'result',
        subtype: 'success',
        result: '# ' + perspective + ' analysis result\n\n## Hypotheses\n- H1: Test hypothesis\n\n## Evidence\n- Code analysis complete\n\n## Conclusion\n' + perspective + ' perspective analysis complete',
        total_cost_usd: 0.001,
        model: 'mock-haiku',
        session_id: 'mock-researcher-' + perspective,
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
  teardown_temp_dirs
}

# Run node with cache clearing, capture file env.
run_researcher_test() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-researcher') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Researcher 계약 테스트"
echo "─────────────────────────────────────"

setup_temp_dirs
trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sdkResearch function ──
echo ""
echo "📋 Test 2: Exports sdkResearch function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sdkResearch === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sdkResearch is a function" "PASS" "$result"

# ── Test 3: SDK unavailable fallback ──
echo ""
echo "📋 Test 3: SDK unavailable → research.md still written with error content"
# Install a broken mock that has no query() export — simulates SDK unavailable.
# (Real SDK at project root intercepts import(), so removing mock is insufficient.)
teardown_mock_sdk 2>/dev/null || true
mkdir -p "$MOCK_NM"
cat > "$MOCK_NM/package.json" <<'BPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.0.0-broken", "main": "index.js", "exports": { ".": "./index.js" } }
BPKG
cat > "$MOCK_NM/index.js" <<'BROKEN'
'use strict';
// Broken mock: query() not exported — triggers sdk_not_available in sdk-runner.js
module.exports = {};
BROKEN
result=$(node -e "
  Object.keys(require.cache).forEach(k => {
    if (k.includes('sdk-runner') || k.includes('sdk-researcher') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { sdkResearch } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkResearch({ step: { name: 'test-step' }, artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const researchExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'research.md'));
    const content = researchExists ? fs.readFileSync(path.join('$ARTIFACT_DIR', 'research.md'), 'utf8') : '';
    const hasError = content.includes('실패') || content.includes('sdk_not_available') || content.includes('Error');
    console.log(JSON.stringify({ ok: r.ok, researchExists, hasError }));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "research.md written on SDK failure" '"researchExists":true' "$result"
assert_contains "error content present" '"hasError":true' "$result"

# Clear artifact dir before good-mock tests
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Setup mock SDK for tests 4-8 ──
setup_mock_sdk

# ── Test 4: All 3 perspectives succeed ──
echo ""
echo "📋 Test 4: All 3 perspectives succeed → research.md with all sections, ok:true"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
> "$CAPTURE_FILE"
result=$(run_researcher_test "
  const { sdkResearch } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkResearch({ step: { name: 'all-pass-step' }, artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const researchPath = path.join('$ARTIFACT_DIR', 'research.md');
    const content = fs.existsSync(researchPath) ? fs.readFileSync(researchPath, 'utf8') : '';
    const hasArch = content.toLowerCase().includes('architecture');
    const hasSec = content.toLowerCase().includes('security');
    const hasQual = content.toLowerCase().includes('quality');
    const okCount = r.perspectives.filter(p => p.ok).length;
    console.log(JSON.stringify({ ok: r.ok, okCount, hasArch, hasSec, hasQual }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
")
assert_contains "ok is true" '"ok":true' "$result"
assert_contains "3 perspectives ok" '"okCount":3' "$result"
assert_contains "architecture section present" '"hasArch":true' "$result"
assert_contains "security section present" '"hasSec":true' "$result"
assert_contains "quality section present" '"hasQual":true' "$result"

# ── Test 5: One perspective fails (partial success) ──
echo ""
echo "📋 Test 5: One perspective fails (partial) → 2 success + 1 error, ok:true"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
> "$CAPTURE_FILE"
result=$(run_researcher_test "
  const { sdkResearch } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkResearch({ step: { name: '__fail_security__' }, artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const researchPath = path.join('$ARTIFACT_DIR', 'research.md');
    const content = fs.existsSync(researchPath) ? fs.readFileSync(researchPath, 'utf8') : '';
    const hasFailMarker = content.includes('실패') || content.includes('error_during_execution');
    const okCount = r.perspectives.filter(p => p.ok).length;
    const failCount = r.perspectives.filter(p => !p.ok).length;
    const secFailed = r.perspectives.find(p => p.key === 'security' && !p.ok) != null;
    console.log(JSON.stringify({ ok: r.ok, okCount, failCount, secFailed, hasFailMarker }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
")
assert_contains "ok is true (partial success)" '"ok":true' "$result"
assert_contains "2 perspectives ok" '"okCount":2' "$result"
assert_contains "1 perspective failed" '"failCount":1' "$result"
assert_contains "security perspective failed" '"secFailed":true' "$result"
assert_contains "error content in research.md" '"hasFailMarker":true' "$result"

# ── Test 6: All perspectives fail ──
echo ""
echo "📋 Test 6: All perspectives fail → research.md still written, ok:false"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
> "$CAPTURE_FILE"
result=$(run_researcher_test "
  const { sdkResearch } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkResearch({ step: { name: '__research_fail__' }, artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const researchPath = path.join('$ARTIFACT_DIR', 'research.md');
    const researchExists = fs.existsSync(researchPath);
    const content = researchExists ? fs.readFileSync(researchPath, 'utf8') : '';
    const hasError = content.includes('실패') || content.includes('error_during_execution');
    const okCount = r.perspectives.filter(p => p.ok).length;
    console.log(JSON.stringify({ ok: r.ok, researchExists, hasError, okCount }));
  }).catch(e => console.log(JSON.stringify({ crashed: true, error: e.message })));
")
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "research.md still written" '"researchExists":true' "$result"
assert_contains "error content present" '"hasError":true' "$result"
assert_contains "0 perspectives ok" '"okCount":0' "$result"

# ── Test 7: settingSources isolation ──
echo ""
echo "📋 Test 7: settingSources isolation — captured SDK options include settingSources: []"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
> "$CAPTURE_FILE"
result=$(run_researcher_test "
  const { sdkResearch } = require('$MODULE');
  sdkResearch({ step: { name: 'isolation-test' }, artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
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
assert_contains "3 SDK calls captured" '"captureCount":3' "$result"

# ── Test 8: Perspective markers present in system prompts ──
echo ""
echo "📋 Test 8: Perspective markers present in source"
TOTAL=$((TOTAL + 1))
arch_marker=$(rg -c '\[PERSPECTIVE:architecture\]' "$MODULE" 2>/dev/null || echo "0")
sec_marker=$(rg -c '\[PERSPECTIVE:security\]' "$MODULE" 2>/dev/null || echo "0")
qual_marker=$(rg -c '\[PERSPECTIVE:quality\]' "$MODULE" 2>/dev/null || echo "0")
if [ "$arch_marker" -gt 0 ] && [ "$sec_marker" -gt 0 ] && [ "$qual_marker" -gt 0 ]; then
  echo "  ✅ PASS: All 3 perspective markers found in source"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Missing perspective markers — arch:$arch_marker sec:$sec_marker qual:$qual_marker"
  FAIL=$((FAIL + 1))
fi

# ── K001 cross-file sweep: settingSources in source ──
echo ""
echo "📋 K001: settingSources present in sdk-researcher.js source"
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
