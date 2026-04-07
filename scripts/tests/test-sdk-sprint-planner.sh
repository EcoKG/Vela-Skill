#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-sprint-planner.sh — sdk-sprint-planner.js 계약 테스트
#
# Contract-level verification — module exports, happy path sprint
# decomposition, edge cases, SDK unavailable fallback, hook isolation,
# structured output dual extraction.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# ⚠ K010: Must NOT run in parallel with test-sdk-runner.sh,
#   test-sdk-reviewer.sh, or other test-sdk-*.sh suites
#   (shared mock directory scripts/shared/node_modules/).
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sprintPlan function
# Test 3:  Happy path — valid request → ok:true + sprintId + 3 slices
# Test 4:  sprint-plan.json persisted with correct structure
# Test 5:  Per-slice request/description preserved in persisted plan
# Test 6:  Empty request → ok:false + error:invalid_input
# Test 7:  No request param → ok:false + error:invalid_input
# Test 8:  SDK returns no slices → ok:false + error:no_slices_extracted
# Test 9:  SDK returns malformed output → regex fallback extraction
# Test 10: Broken mock SDK → ok:false + error:sdk_not_available
# Test 11: Module doesn't crash on SDK unavailable
# Test 12: settingSources isolation — captured options include settingSources:[]
# Test 13: outputFormat passed to SDK queryOptions
# Test 14: Sonnet model used (not Opus/Haiku)
# Test 15: structuredOutput used when present (dual extraction primary)
# Test 16: cost/durationMs always present in result
# K001:    settingSources present in sdk-sprint-planner.js source
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/sdk-sprint-planner.js"
MODULE_DIR="$PROJECT_ROOT/scripts/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
CAPTURE_FILE=""
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

setup_temp_dirs() {
  CWD_DIR="$(mktemp -d)"
  mkdir -p "$CWD_DIR/.vela/sprints"
  mkdir -p "$CWD_DIR/.vela/state"
}

teardown_temp_dirs() {
  rm -rf "$CWD_DIR" 2>/dev/null || true
}

# Install mock SDK in sdk-runner.js's own node_modules directory.
# Mock returns structured sprint plans based on MOCK_SPRINT_MODE env var (K064).
#
# Modes:
#   happy         → 3 slices with deps, structuredOutput present
#   no_slices     → empty slices array (structuredOutput with slices:[])
#   malformed     → garbled text, no JSON, no structuredOutput (fallback test)
#   text_json     → no structuredOutput, but result text has ```json code block
#   no_structured → structuredOutput present but without slices field
#
# Captures SDK options to CAPTURE_FILE for isolation checks.
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

  const mode = process.env.MOCK_SPRINT_MODE || 'happy';

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-sprint-session' };

    let resultText = '';
    let structuredOutput = undefined;

    if (mode === 'happy') {
      structuredOutput = {
        title: 'Test Sprint',
        slices: [
          { id: 'slice-01', title: 'Setup foundation', description: 'Create project structure and base config', depends_on: [] },
          { id: 'slice-02', title: 'Core logic', description: 'Implement main business logic', depends_on: ['slice-01'] },
          { id: 'slice-03', title: 'Integration tests', description: 'Add integration test suite', depends_on: ['slice-01', 'slice-02'] }
        ],
        reasoning: 'Risk-ordered: foundation first, then core, then tests'
      };
      resultText = 'Sprint plan created with 3 slices.';
    } else if (mode === 'no_slices') {
      structuredOutput = {
        title: 'Empty Sprint',
        slices: [],
        reasoning: 'No slices generated'
      };
      resultText = 'No slices.';
    } else if (mode === 'malformed') {
      resultText = 'Here is my analysis... the project looks interesting but {broken json[[[';
      structuredOutput = undefined;
    } else if (mode === 'text_json') {
      // No structuredOutput — but result text has a valid JSON code block
      resultText = 'Analysis complete.\n\n```json\n' + JSON.stringify({
        title: 'Fallback Sprint',
        slices: [
          { id: 'slice-1', title: 'First task', description: 'Do the first thing', depends_on: [] },
          { id: 'slice-2', title: 'Second task', description: 'Do the second thing', depends_on: ['slice-1'] }
        ],
        reasoning: 'Fallback extraction test'
      }) + '\n```';
      structuredOutput = undefined;
    } else if (mode === 'no_structured') {
      // structuredOutput present but missing slices field
      structuredOutput = { title: 'Bad Plan', reasoning: 'no slices field' };
      resultText = 'Something went wrong.';
    }

    var result = {
      type: 'result',
      subtype: 'success',
      result: resultText,
      total_cost_usd: 0.0025,
      model: 'mock-sonnet-model',
      session_id: 'mock-sprint-session',
      num_turns: 5,
      duration_ms: 1500
    };
    if (structuredOutput !== undefined) {
      result.structured_output = structuredOutput;
    }
    yield result;
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

# Run node clearing relevant caches, with capture file env.
# process.chdir to CWD_DIR so sprint-manager writes to .vela/sprints/ relative to temp.
# K047: detectProjectMode prints diagnostic to stdout — pipe through tail -1.
run_sprint_test() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    process.chdir('$CWD_DIR');
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-sprint-planner') || k.includes('sprint-manager') || k.includes('claude-agent-sdk') || k.includes('vela-pipeline')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null | tail -1
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Sprint Planner 계약 테스트"
echo "─────────────────────────────────────"

setup_temp_dirs
trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sprintPlan function ──
echo ""
echo "📋 Test 2: Exports sprintPlan function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sprintPlan === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sprintPlan is a function" "PASS" "$result"

# ── Setup mock SDK ──
setup_mock_sdk

# ── Test 3: Happy path — 3 slices, ok:true, sprintId present ──
echo ""
echo "📋 Test 3: Happy path — valid request → ok:true + sprintId + 3 slices"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Build a REST API', cwd: '$CWD_DIR' }).then(r => {
    const checks = [
      r.ok === true,
      typeof r.sprintId === 'string' && r.sprintId.length > 0,
      Array.isArray(r.slices) && r.slices.length === 3
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "happy path: ok + sprintId + 3 slices" "PASS" "$result"

# ── Test 4: sprint-plan.json persisted ──
echo ""
echo "📋 Test 4: sprint-plan.json persisted with correct structure"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sprintPlan({ request: 'Build auth system', cwd: '$CWD_DIR' }).then(r => {
    if (!r.ok) { console.log('FAIL:not_ok:' + r.error); return; }
    // Find the sprint-plan.json in .vela/sprints/
    const sprintsDir = path.join('$CWD_DIR', '.vela', 'sprints');
    const dirs = fs.readdirSync(sprintsDir);
    const latestDir = dirs.sort().pop();
    const planPath = path.join(sprintsDir, latestDir, 'sprint-plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const checks = [
      plan.version === '1.0',
      plan.status === 'planned',
      plan.request === 'Build auth system',
      Array.isArray(plan.slices) && plan.slices.length === 3,
      plan.slices[0].id === 'slice-01'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify({ v: plan.version, s: plan.status, req: plan.request, len: plan.slices.length }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "sprint-plan.json persisted correctly" "PASS" "$result"

# ── Test 5: Per-slice request/description preserved ──
echo ""
echo "📋 Test 5: Per-slice request/description preserved in persisted plan"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sprintPlan({ request: 'Test slice descriptions', cwd: '$CWD_DIR' }).then(r => {
    if (!r.ok) { console.log('FAIL:not_ok:' + r.error); return; }
    const sprintsDir = path.join('$CWD_DIR', '.vela', 'sprints');
    const dirs = fs.readdirSync(sprintsDir);
    const latestDir = dirs.sort().pop();
    const planPath = path.join(sprintsDir, latestDir, 'sprint-plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    // sprint-manager normalizedSlices maps description → request
    const s1 = plan.slices[0];
    const checks = [
      typeof s1.request === 'string' && s1.request.length > 0,
      s1.request === 'Create project structure and base config'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:request=' + JSON.stringify(s1.request));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "per-slice request/description preserved" "PASS" "$result"

# ── Test 6: Empty request → invalid_input ──
echo ""
echo "📋 Test 6: Empty request → ok:false + error:invalid_input"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: '', cwd: '$CWD_DIR' }).then(r => {
    console.log(!r.ok && r.error === 'invalid_input' ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "empty request → invalid_input" "PASS" "$result"

# ── Test 7: No request param → invalid_input ──
echo ""
echo "📋 Test 7: No request param → ok:false + error:invalid_input"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ cwd: '$CWD_DIR' }).then(r => {
    console.log(!r.ok && r.error === 'invalid_input' ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "no request param → invalid_input" "PASS" "$result"

# ── Test 8: SDK returns no slices → no_slices_extracted ──
echo ""
echo "📋 Test 8: SDK returns no slices → ok:false + error:no_slices_extracted"
result=$(MOCK_SPRINT_MODE=no_slices run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Build something', cwd: '$CWD_DIR' }).then(r => {
    console.log(!r.ok && r.error === 'no_slices_extracted' ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "no slices → no_slices_extracted" "PASS" "$result"

# ── Test 9: Malformed → regex fallback via text_json mode ──
echo ""
echo "📋 Test 9: SDK returns text with JSON code block → regex fallback extraction"
result=$(MOCK_SPRINT_MODE=text_json run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Fallback test', cwd: '$CWD_DIR' }).then(r => {
    const checks = [
      r.ok === true,
      Array.isArray(r.slices) && r.slices.length === 2,
      r.slices[0].id === 'slice-01'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "text_json fallback → ok + 2 slices" "PASS" "$result"

# ── Test 9b: Completely malformed → no_slices_extracted ──
echo ""
echo "📋 Test 9b: Completely malformed → no_slices_extracted"
result=$(MOCK_SPRINT_MODE=malformed run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Malformed test', cwd: '$CWD_DIR' }).then(r => {
    console.log(!r.ok && r.error === 'no_slices_extracted' ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "malformed → no_slices_extracted" "PASS" "$result"

# ── Test 10: Broken mock SDK → sdk_not_available ──
echo ""
echo "📋 Test 10: Broken mock SDK → ok:false + error:sdk_not_available"
teardown_mock_sdk 2>/dev/null || true
mkdir -p "$MOCK_NM"
cat > "$MOCK_NM/package.json" <<'BPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.0.0-broken", "main": "index.js", "exports": { ".": "./index.js" } }
BPKG
cat > "$MOCK_NM/index.js" <<'BROKEN'
'use strict';
// Broken mock: query() not exported — triggers sdk_not_available (K029)
module.exports = {};
BROKEN
result=$(run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Test unavailable', cwd: '$CWD_DIR' }).then(r => {
    console.log(!r.ok && r.error === 'sdk_not_available' ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "broken mock → sdk_not_available" "PASS" "$result"

# ── Test 11: Module doesn't crash on SDK unavailable ──
echo ""
echo "📋 Test 11: Module doesn't crash on SDK unavailable"
result=$(run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Crash test', cwd: '$CWD_DIR' }).then(r => {
    console.log(typeof r === 'object' && r !== null ? 'PASS' : 'FAIL');
  }).catch(e => console.log('CRASHED:' + e.message));
")
assert_eq "no crash on SDK unavailable" "PASS" "$result"

# ── Reinstall working mock for remaining tests ──
teardown_mock_sdk 2>/dev/null || true
setup_mock_sdk

# ── Test 12: settingSources isolation ──
echo ""
echo "📋 Test 12: settingSources isolation — captured options include settingSources:[]"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Isolation test', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "settingSources is []" "PASS" "$result"

# ── Test 13: outputFormat passed to SDK ──
echo ""
echo "📋 Test 13: outputFormat passed to SDK queryOptions"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Format test', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const fmt = opts.outputFormat;
    const hasFormat = fmt && fmt.type === 'json' && fmt.schema && fmt.schema.required;
    console.log(hasFormat ? 'PASS' : 'FAIL:' + JSON.stringify(fmt));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "outputFormat in queryOptions" "PASS" "$result"

# ── Test 14: Sonnet model used ──
echo ""
echo "📋 Test 14: Sonnet model used (not Opus/Haiku)"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Model test', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const model = opts.model || '';
    const isSonnet = model.toLowerCase().includes('sonnet');
    const notOpus = !model.toLowerCase().includes('opus');
    const notHaiku = !model.toLowerCase().includes('haiku');
    console.log(isSonnet && notOpus && notHaiku ? 'PASS' : 'FAIL:model=' + model);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "Sonnet model used" "PASS" "$result"

# ── Test 15: structuredOutput used when present (dual extraction primary) ──
echo ""
echo "📋 Test 15: structuredOutput primary path — title from structuredOutput"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Structured output test', cwd: '$CWD_DIR' }).then(r => {
    // Mock's structuredOutput title is 'Test Sprint'
    // If dual extraction works, plan.title should be 'Test Sprint' (from structuredOutput)
    const checks = [
      r.ok === true,
      r.title === 'Test Sprint',
      r.slices[0].title === 'Setup foundation'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:title=' + r.title + ',s0=' + (r.slices[0]||{}).title);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "structuredOutput primary extraction" "PASS" "$result"

# ── Test 16: cost/durationMs always present ──
echo ""
echo "📋 Test 16: cost/durationMs always present in result"
result=$(MOCK_SPRINT_MODE=happy run_sprint_test "
  const { sprintPlan } = require('$MODULE');
  sprintPlan({ request: 'Cost test', cwd: '$CWD_DIR' }).then(r => {
    const hasCost = typeof r.cost === 'number';
    const hasDuration = typeof r.durationMs === 'number';
    console.log(hasCost && hasDuration ? 'PASS' : 'FAIL:cost=' + r.cost + ',dur=' + r.durationMs);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "cost and durationMs present" "PASS" "$result"

# ── K001: settingSources in source ──
echo ""
echo "📋 K001: settingSources present in sdk-sprint-planner.js source"
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
