#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-plan-checker.sh — sdk-plan-checker.js 계약 테스트
#
# Contract-level verification — module exports, single-stage
# Haiku plan.md structural check, VERDICT parsing, artifact
# generation, SDK fallback, hook isolation.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# ⚠ K010: Must NOT run in parallel with test-sdk-runner.sh or
#   test-sdk-reviewer.sh (shared mock directory).
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkPlanCheck function
# Test 3:  SDK unavailable fallback — plan-check.md still written
# Test 4:  Pass case (VERDICT: PASS) → ok:true + verdict=pass + plan-check.md
# Test 5:  Fail case (VERDICT: FAIL) → ok:true + verdict=fail + plan-check.md
# Test 6:  plan.md missing → ok:false + error=plan_md_not_found
# Test 7:  settingSources isolation — captured SDK options include settingSources: []
# Test 8:  structuredOutput.verdict used directly when present (T03)
# Test 9:  VERDICT_REGEX fallback when structuredOutput absent (T03)
# Test 10: outputFormat passed to SDK queryOptions (T03)
# K001:    settingSources present in sdk-plan-checker.js source
# Broad:   No stale references sweep
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/sdk-plan-checker.js"
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
  mkdir -p "$CWD_DIR/.vela/state"
}

teardown_temp_dirs() {
  rm -rf "$ARTIFACT_DIR" "$CWD_DIR" 2>/dev/null || true
}

# Write a plan.md fixture with the three required sections.
# Embeds a marker string for the mock SDK to differentiate pass/fail.
write_plan_fixture() {
  local marker="$1"
  cat > "$ARTIFACT_DIR/plan.md" <<PLAN
# Design Plan

Marker: ${marker}

## Architecture

The system uses a layered architecture with clear dependency direction.
Presentation layer depends on Domain layer which depends on Infrastructure.
Module separation follows bounded contexts. Directory layout:
- src/domain/ — core business logic and entities
- src/application/ — use cases and orchestration
- src/infrastructure/ — database adapters and external services
- src/presentation/ — API controllers and view models
Each layer communicates through well-defined interfaces to maintain
loose coupling and testability across all boundaries.

## Class Specification

### Interfaces
- IUserRepository: findById(id: string): Promise<User | null>, save(user: User): Promise<void>
- INotificationService: send(notification: Notification): Promise<boolean>

### Classes
- UserService: constructor(repo: IUserRepository, notifier: INotificationService)
  - createUser(dto: CreateUserDto): Promise<User>
  - deactivateUser(id: string): Promise<void>
- User: Value Object with id, name, email, status fields
- Notification: Aggregate Root managing delivery state

## Test Strategy

### Unit Tests
- UserService.createUser — validates DTO, persists user, returns entity
- UserService.deactivateUser — sets status to inactive, sends notification
- User value object — equality by id, immutability checks

### Integration Tests
- UserRepository — round-trip persistence with test database
- NotificationService — delivery confirmation with mock transport

### Edge Cases
- Duplicate email rejection
- Deactivation of non-existent user
- Notification delivery failure handling
PLAN
}

# Install mock SDK in sdk-runner.js's own node_modules directory.
# Mock returns VERDICT based on prompt content markers:
#   __plan_pass__ → VERDICT: PASS
#   __plan_fail__ → VERDICT: FAIL
#   __structured_pass__ → structured_output with verdict:PASS (no VERDICT line in text)
#   __structured_fail__ → structured_output with verdict:FAIL (no VERDICT line in text)
#   __no_structured__ → no structured_output, VERDICT: PASS in text (fallback path)
#   default       → VERDICT: PASS
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

  const prompt = (args && args.prompt) || '';

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-plan-checker-session' };

    let resultText = '';
    let structuredOutput = undefined;

    if (prompt.includes('__structured_pass__')) {
      // T03: structured_output with verdict, no VERDICT line in text
      resultText = 'Analysis complete. All sections verified.';
      structuredOutput = {
        verdict: 'PASS',
        sections: [
          { name: 'Architecture', exists: true, byteCount: 450, substantive: true },
          { name: 'Class Specification', exists: true, byteCount: 380, substantive: true },
          { name: 'Test Strategy', exists: true, byteCount: 290, substantive: true }
        ]
      };
    } else if (prompt.includes('__structured_fail__')) {
      // T03: structured_output with verdict FAIL, no VERDICT line in text
      resultText = 'Analysis complete. Missing sections found.';
      structuredOutput = {
        verdict: 'FAIL',
        sections: [
          { name: 'Architecture', exists: true, byteCount: 450, substantive: true },
          { name: 'Class Specification', exists: false, byteCount: 0, substantive: false },
          { name: 'Test Strategy', exists: true, byteCount: 120, substantive: false }
        ]
      };
    } else if (prompt.includes('__no_structured__')) {
      // T03: no structured_output → fallback to VERDICT_REGEX
      resultText = 'All sections checked.\n\nVERDICT: PASS';
      structuredOutput = undefined;
    } else if (prompt.includes('__plan_fail__')) {
      resultText = [
        '## Section Check',
        '',
        '### ## Architecture',
        '- Header: EXISTS',
        '- Byte count: 450',
        '- Substantive: YES',
        '',
        '### ## Class Specification',
        '- Header: MISSING',
        '- Byte count: 0',
        '- Substantive: NO',
        '',
        '### ## Test Strategy',
        '- Header: EXISTS',
        '- Byte count: 120',
        '- Substantive: NO (below 200 byte threshold)',
        '',
        'VERDICT: FAIL'
      ].join('\n');
    } else {
      resultText = [
        '## Section Check',
        '',
        '### ## Architecture',
        '- Header: EXISTS',
        '- Byte count: 450',
        '- Substantive: YES',
        '',
        '### ## Class Specification',
        '- Header: EXISTS',
        '- Byte count: 380',
        '- Substantive: YES',
        '',
        '### ## Test Strategy',
        '- Header: EXISTS',
        '- Byte count: 290',
        '- Substantive: YES',
        '',
        'VERDICT: PASS'
      ].join('\n');
    }

    var result = {
      type: 'result',
      subtype: 'success',
      result: resultText,
      total_cost_usd: 0.001,
      model: 'mock-haiku-model',
      session_id: 'mock-plan-checker-session',
      num_turns: 1,
      duration_ms: 200
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

# Run node with cache clearing, capture file env.
run_plan_checker_test() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-plan-checker') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Plan Checker 계약 테스트"
echo "─────────────────────────────────────"

setup_temp_dirs
trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sdkPlanCheck function ──
echo ""
echo "📋 Test 2: Exports sdkPlanCheck function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sdkPlanCheck === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sdkPlanCheck is a function" "PASS" "$result"

# ── Test 3: SDK unavailable fallback ──
echo ""
echo "📋 Test 3: SDK unavailable → ok:false + plan-check.md still written"
# Install a broken mock that exports query() but always yields error_during_execution.
# This simulates SDK failure (real SDK at project root would otherwise intercept import()).
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
write_plan_fixture "__unavail_test__"
result=$(node -e "
  Object.keys(require.cache).forEach(k => {
    if (k.includes('sdk-runner') || k.includes('sdk-plan-checker') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { sdkPlanCheck } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const planCheckExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'plan-check.md'));
    console.log(JSON.stringify({ ok: r.ok, error: r.error, planCheckExists }));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "plan-check.md written on SDK failure" '"planCheckExists":true' "$result"

# ── Setup mock SDK for tests 4-7 ──
setup_mock_sdk

# ── Test 4: Pass case → ok:true + verdict=pass + plan-check.md ──
echo ""
echo "📋 Test 4: Pass case (VERDICT: PASS) → ok:true + verdict=pass + plan-check.md"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
write_plan_fixture "__plan_pass__"
result=$(run_plan_checker_test "
  const { sdkPlanCheck } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const planCheckExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'plan-check.md'));
    const planCheckContent = planCheckExists ? fs.readFileSync(path.join('$ARTIFACT_DIR', 'plan-check.md'), 'utf8') : '';
    const hasVerdict = planCheckContent.includes('PASS');
    const checks = [r.ok === true, r.verdict === 'pass', planCheckExists, hasVerdict];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "pass case: ok + verdict=pass + plan-check.md" "PASS" "$result"

# ── Test 5: Fail case → ok:true + verdict=fail + plan-check.md ──
echo ""
echo "📋 Test 5: Fail case (VERDICT: FAIL) → ok:true + verdict=fail + plan-check.md"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
write_plan_fixture "__plan_fail__"
result=$(run_plan_checker_test "
  const { sdkPlanCheck } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const planCheckExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'plan-check.md'));
    const planCheckContent = planCheckExists ? fs.readFileSync(path.join('$ARTIFACT_DIR', 'plan-check.md'), 'utf8') : '';
    const hasFail = planCheckContent.includes('FAIL');
    const checks = [r.ok === true, r.verdict === 'fail', planCheckExists, hasFail];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "fail case: ok + verdict=fail + plan-check.md" "PASS" "$result"

# ── Test 6: plan.md missing → ok:false + error=plan_md_not_found ──
echo ""
echo "📋 Test 6: plan.md missing → ok:false + error=plan_md_not_found"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
# Intentionally do NOT write plan.md
result=$(run_plan_checker_test "
  const { sdkPlanCheck } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const planCheckExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'plan-check.md'));
    console.log(JSON.stringify({ ok: r.ok, error: r.error, planCheckExists }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "error is plan_md_not_found" '"error":"plan_md_not_found"' "$result"
# plan-check.md should NOT be written when plan.md is missing (early return)
assert_contains "no plan-check.md when plan.md missing" '"planCheckExists":false' "$result"

# ── Test 7: settingSources isolation ──
echo ""
echo "📋 Test 7: settingSources isolation — captured SDK options include settingSources: []"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
write_plan_fixture "__plan_pass__"
result=$(run_plan_checker_test "
  const { sdkPlanCheck } = require('$MODULE');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "settingSources is []" "PASS" "$result"

# ── Test 8: structuredOutput.verdict used directly when present (T03) ──
echo ""
echo "📋 Test 8: structuredOutput.verdict used directly when present (T03)"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
write_plan_fixture "__structured_pass__"
result=$(run_plan_checker_test "
  const { sdkPlanCheck } = require('$MODULE');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // structuredOutput.verdict=PASS is used directly, text has no VERDICT line
    const checks = [r.ok === true, r.verdict === 'pass'];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "structuredOutput.verdict used for pass" "PASS" "$result"

# Also test structuredOutput FAIL verdict
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
write_plan_fixture "__structured_fail__"
result=$(run_plan_checker_test "
  const { sdkPlanCheck } = require('$MODULE');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const checks = [r.ok === true, r.verdict === 'fail'];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "structuredOutput.verdict used for fail" "PASS" "$result"

# ── Test 9: VERDICT_REGEX fallback when structuredOutput absent (T03) ──
echo ""
echo "📋 Test 9: VERDICT_REGEX fallback when structuredOutput absent (T03)"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
write_plan_fixture "__no_structured__"
result=$(run_plan_checker_test "
  const { sdkPlanCheck } = require('$MODULE');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // No structured_output → falls back to VERDICT_REGEX in text
    const checks = [r.ok === true, r.verdict === 'pass'];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "VERDICT_REGEX fallback works" "PASS" "$result"

# ── Test 10: outputFormat passed to SDK queryOptions (T03) ──
echo ""
echo "📋 Test 10: outputFormat passed to SDK queryOptions (T03)"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
write_plan_fixture "__plan_pass__"
result=$(run_plan_checker_test "
  const { sdkPlanCheck } = require('$MODULE');
  sdkPlanCheck({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const fmt = opts.outputFormat;
    const hasFormat = fmt && fmt.type === 'json' && fmt.schema && fmt.schema.required;
    console.log(hasFormat ? 'PASS' : 'FAIL:' + JSON.stringify(fmt));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "outputFormat in queryOptions" "PASS" "$result"

# ── K001 cross-file sweep: settingSources in source ──
echo ""
echo "📋 K001: settingSources present in sdk-plan-checker.js source"
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

# ── Broad sweep: no stale references ──
echo ""
echo "📋 Broad sweep: no stale PM plan-check references in hook files"
stale=$(rg -n 'PM.*plan.check\|plan.check.*PM\|vela-pm.*plan-check' \
  "$PROJECT_ROOT/scripts/cli/" \
  "$PROJECT_ROOT/scripts/agents/" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -z "$stale" ]; then
  echo "  ✅ PASS: no stale references found"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: stale references found:"
  echo "    $stale"
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
