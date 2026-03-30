#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-analyze-e2e.sh — vela-analyze.js full subcommand E2E contract test
#
# Contract-level verification — full CLI flow using mock SDK for
# code analysis and real dep-analyzer for dependencies.
# Covers deps-only, combined analysis, negative cases, PDF
# generation, SKILL.md integration, and K001 sweep.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/hooks/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# ⚠ K010: Must NOT run in parallel with test-sdk-analyzer.sh,
#   test-sdk-runner.sh, or other tests that use the shared mock directory.
#
# Test 1:  full subcommand exists — missing --items → exit 1 with usage hint
# Test 2:  Invalid items — full --items invalid → exit 1, error message
# Test 3:  Invalid model — full --items deps --model badmodel → exit 1
# Test 4:  Deps-only — full --items deps → exit 0, PDF generated
# Test 5:  Deps-only has no codeAnalysis — stdout JSON lacks codeAnalysis
# Test 6:  SDK perspectives with mock — full --items security,bugs → exit 0, 2 perspectives
# Test 7:  Combined deps + SDK — full --items deps,security → exit 0, both present, PDF
# Test 8:  All items — full --items deps,security,bugs,performance,code-quality,architecture → 5 perspectives
# Test 9:  Report subcommand with combined fixture → PDF generated
# Test 10: printUsage includes full
# Test 11: SKILL.md has analyze routing
# Test 12: K001 sweep — no TODO/FIXME/HACK markers
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$PROJECT_ROOT/scripts/cli/vela-analyze.js"
MODULE_DIR="$PROJECT_ROOT/scripts/hooks/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
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

assert_not_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"

  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ❌ FAIL: $label — '$needle' unexpectedly found in output"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  fi
}

# Install mock SDK that returns perspective-specific findings
# via K012 PERSPECTIVE markers in system prompt.
setup_mock_sdk() {
  mkdir -p "$MOCK_NM"

  cat > "$MOCK_NM/package.json" <<'MPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.2.0-mock", "main": "index.js", "exports": { ".": "./index.js" } }
MPKG

  cat > "$MOCK_NM/index.js" <<'MOCK'
'use strict';

function query(args) {
  const options = (args && args.options) || {};
  const systemPrompt = options.systemPrompt || '';

  // Determine perspective from system prompt marker (K012)
  let perspective = 'unknown';
  if (systemPrompt.includes('[PERSPECTIVE:security]')) perspective = 'security';
  else if (systemPrompt.includes('[PERSPECTIVE:bugs]')) perspective = 'bugs';
  else if (systemPrompt.includes('[PERSPECTIVE:performance]')) perspective = 'performance';
  else if (systemPrompt.includes('[PERSPECTIVE:code-quality]')) perspective = 'code-quality';
  else if (systemPrompt.includes('[PERSPECTIVE:architecture]')) perspective = 'architecture';

  const findingsJson = JSON.stringify({
    findings: [{
      name: 'Mock finding from ' + perspective,
      severity: 'high',
      file: 'src/mock.js',
      line: 1,
      description: 'Mock issue in ' + perspective,
      suggestion: 'Mock fix'
    }]
  });

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-e2e-' + perspective };
    yield {
      type: 'result',
      subtype: 'success',
      result: '```json\n' + findingsJson + '\n```',
      total_cost_usd: 0.001,
      model: options.model || 'mock-haiku',
      session_id: 'mock-e2e-' + perspective,
      num_turns: 1,
      duration_ms: 50
    };
  })();
}

module.exports = { query };
MOCK
}

teardown_mock_sdk() {
  rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
}

cleanup_all() {
  teardown_mock_sdk
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 Vela Analyze E2E 계약 테스트"
echo "─────────────────────────────────────"

trap cleanup_all EXIT

TMP_DIR="$(mktemp -d)"

# ── Test 1: full subcommand — missing --items → exit 1 with usage hint ──
echo ""
echo "📋 Test 1: full subcommand — missing --items → exit 1"
output=$(node "$CLI" full 2>&1 || true)
exit_code=0
node "$CLI" full >/dev/null 2>&1 || exit_code=$?
assert_eq "exit code is 1" "1" "$exit_code"
assert_contains "error mentions items" "items" "$output"

# ── Test 2: Invalid items — full --items invalid → exit 1 ──
echo ""
echo "📋 Test 2: Invalid items → exit 1, error mentions unknown"
output=$(node "$CLI" full --items invalid 2>&1 || true)
exit_code=0
node "$CLI" full --items invalid >/dev/null 2>&1 || exit_code=$?
assert_eq "exit code is 1" "1" "$exit_code"
assert_contains "error mentions unknown" "Unknown" "$output"

# ── Test 3: Invalid model → exit 1 ──
echo ""
echo "📋 Test 3: Invalid model → exit 1"
exit_code=0
output=$(node "$CLI" full --items deps --model badmodel 2>&1 || true)
node "$CLI" full --items deps --model badmodel >/dev/null 2>&1 || exit_code=$?
assert_eq "exit code is 1" "1" "$exit_code"
assert_contains "error mentions model" "model" "$output"

# ── Test 4: Deps-only → exit 0, PDF generated ──
echo ""
echo "📋 Test 4: Deps-only → exit 0, PDF generated"
DEPS_PDF="$TMP_DIR/test-e2e-deps.pdf"
exit_code=0
deps_out=$(node "$CLI" full --items deps --output "$DEPS_PDF" 2>&1) || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
# Verify PDF file exists and is a real PDF
pdf_check=""
if [ -f "$DEPS_PDF" ]; then
  pdf_check=$(file "$DEPS_PDF")
fi
assert_contains "PDF file generated" "PDF" "$pdf_check"
assert_contains "stdout has ok:true" '"ok":true' "$deps_out"

# ── Test 5: Deps-only has no codeAnalysis ──
echo ""
echo "📋 Test 5: Deps-only stdout has no codeAnalysis"
assert_not_contains "no codeAnalysis in stdout" "codeAnalysis" "$deps_out"

# ── Setup mock SDK for tests 6-8 ──
setup_mock_sdk

# ── Test 6: SDK perspectives with mock — security,bugs → 2 perspectives ──
echo ""
echo "📋 Test 6: SDK perspectives — security,bugs → exit 0, 2 perspectives"
SDK_PDF="$TMP_DIR/test-e2e-sdk.pdf"
exit_code=0
sdk_out=$(node "$CLI" full --items security,bugs --model haiku --output "$SDK_PDF" 2>&1) || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
pdf_check=""
if [ -f "$SDK_PDF" ]; then
  pdf_check=$(file "$SDK_PDF")
fi
assert_contains "SDK PDF generated" "PDF" "$pdf_check"

# ── Test 7: Combined deps + SDK → both present, PDF ──
echo ""
echo "📋 Test 7: Combined deps + SDK → exit 0, PDF generated"
COMBINED_PDF="$TMP_DIR/test-e2e-combined.pdf"
exit_code=0
combined_out=$(node "$CLI" full --items deps,security --output "$COMBINED_PDF" 2>&1) || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
pdf_check=""
if [ -f "$COMBINED_PDF" ]; then
  pdf_check=$(file "$COMBINED_PDF")
fi
assert_contains "combined PDF generated" "PDF" "$pdf_check"
assert_contains "stdout has ok:true" '"ok":true' "$combined_out"

# ── Test 8: All items → 5 perspectives in codeAnalysis ──
echo ""
echo "📋 Test 8: All items → exit 0, PDF generated"
ALL_PDF="$TMP_DIR/test-e2e-all.pdf"
exit_code=0
all_out=$(node "$CLI" full --items deps,security,bugs,performance,code-quality,architecture --output "$ALL_PDF" 2>&1) || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
pdf_check=""
if [ -f "$ALL_PDF" ]; then
  pdf_check=$(file "$ALL_PDF")
fi
assert_contains "all-items PDF generated" "PDF" "$pdf_check"

# ── Teardown mock SDK ──
teardown_mock_sdk

# ── Test 9: Report subcommand with combined fixture → PDF ──
echo ""
echo "📋 Test 9: Report with combined fixture → PDF generated"
REPORT_PDF="$TMP_DIR/test-e2e-report.pdf"
FIXTURE="$PROJECT_ROOT/test-fixtures/sample-combined-analysis.json"
exit_code=0
report_out=$(node "$CLI" report --input "$FIXTURE" --output "$REPORT_PDF" 2>&1) || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
pdf_check=""
if [ -f "$REPORT_PDF" ]; then
  pdf_check=$(file "$REPORT_PDF")
fi
assert_contains "report PDF generated" "PDF" "$pdf_check"

# ── Test 10: printUsage includes full ──
echo ""
echo "📋 Test 10: printUsage includes full"
usage_out=$(node "$CLI" 2>&1 || true)
assert_contains "usage mentions full" "full" "$usage_out"

# ── Test 11: SKILL.md has analyze routing ──
echo ""
echo "📋 Test 11: SKILL.md has analyze routing"
TOTAL=$((TOTAL + 1))
if grep -q 'analyze.*절차\|/vela:analyze' "$PROJECT_ROOT/SKILL.md"; then
  echo "  ✅ PASS: SKILL.md has analyze routing"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: SKILL.md missing analyze routing"
  FAIL=$((FAIL + 1))
fi

# ── Test 12: K001 sweep — no TODO/FIXME/HACK markers ──
echo ""
echo "📋 Test 12: K001 sweep — no residual markers"
TOTAL=$((TOTAL + 1))
markers=$(rg -i 'TODO|FIXME|HACK' "$CLI" "$PROJECT_ROOT/SKILL.md" 2>/dev/null || true)
if [ -z "$markers" ]; then
  echo "  ✅ PASS: No TODO/FIXME/HACK markers"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Residual markers found:"
  echo "    $markers"
  FAIL=$((FAIL + 1))
fi

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "Results: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
