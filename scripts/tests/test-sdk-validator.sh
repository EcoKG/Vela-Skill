#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-validator.sh — sdk-validator.js 계약 테스트
#
# Contract-level verification — module exports, single-stage
# Sonnet verification, verification.md fallback writing,
# SDK unavailable handling, SDK error handling, hook isolation.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location (K009).
#
# ⚠ Must NOT run in parallel with test-sdk-runner.sh,
#   test-sdk-executor.sh, or test-sdk-reviewer.sh —
#   shared mock directory (K010).
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkValidate function
# Test 3:  SDK unavailable fallback — returns { ok: false, error: 'sdk_not_available' }, no artifacts
# Test 4:  Successful validation — mock SDK returns result, verification.md written to artifactDir
# Test 5:  Successful execution details — result has ok:true, step, artifact, model fields
# Test 6:  SDK error — returns ok:false with error details, no verification.md written
# Test 7:  settingSources isolation — captured SDK options include settingSources: []
# Test 8:  Fallback verification.md content includes step name
# Test 9:  Worktree created for validator — SDK cwd under .vela/worktrees/
# Test 10: Worktree cleaned up after success — no vela worktrees remain
# Test 11: Worktree cleaned up after SDK error — cleanup despite error
# Test 12: Graceful fallback without pipelineSlug — cwd unchanged
# K001:    settingSources present in sdk-validator.js source
# Stale:   No stale Validator subagent references in updated files
# New:     vela-engine.js validate 참조 확인
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/sdk-validator.js"
MODULE_DIR="$PROJECT_ROOT/scripts/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
CAPTURE_FILE=""
ARTIFACT_DIR=""
WT_TMPDIRS=()

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
#   (default)     → success with verification-like output
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
    yield { type: 'system', subtype: 'init', session_id: 'mock-validator-session' };

    if (prompt.includes('__sdk_error__')) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: 'Verification failed: test runner crashed',
        errors: ['TestRunnerError: process exited with code 1'],
        total_cost_usd: 0.03,
        model: 'mock-sonnet-model',
        session_id: 'mock-validator-session',
        num_turns: 2,
        duration_ms: 500
      };
      return;
    }

    // Default: successful verification
    yield {
      type: 'result',
      subtype: 'success',
      result: 'Verification complete. All tests passing. Lint clean.\n\n# Verification Report\n\n## Summary\n- **Verdict:** PASS\n- **Timestamp:** 2026-01-01T00:00:00Z\n\n## Test Results\n- Total: 10\n- Passed: 10\n- Failed: 0\n\n## Lint Results\n- Errors: 0\n- Warnings: 2',
      total_cost_usd: 0.15,
      model: 'mock-sonnet-model',
      session_id: 'mock-validator-session',
      num_turns: 5,
      duration_ms: 8000
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

cleanup_wt_tmpdirs() {
  for d in "${WT_TMPDIRS[@]}"; do
    if [ -d "$d/.git" ] || [ -f "$d/.git" ]; then
      git -C "$d" worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}' | while read -r wt; do
        [ "$wt" != "$d" ] && git -C "$d" worktree remove --force "$wt" 2>/dev/null || true
      done
      git -C "$d" worktree prune 2>/dev/null || true
    fi
    rm -rf "$d" 2>/dev/null || true
  done
}

make_repo() {
  local tmp
  tmp="$(mktemp -d)"
  WT_TMPDIRS+=("$tmp")
  git -C "$tmp" init -b main >/dev/null 2>&1
  git -C "$tmp" config user.email "test@test.com"
  git -C "$tmp" config user.name "Test"
  echo "init" > "$tmp/README.md"
  git -C "$tmp" add -A >/dev/null 2>&1
  git -C "$tmp" commit -m "init" >/dev/null 2>&1
  echo "$tmp"
}

cleanup_all() {
  teardown_mock_sdk
  teardown_temp_dirs
  cleanup_wt_tmpdirs
}

# Run node with cache clearing and capture file env.
run_validator_test() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-validator') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Validator 계약 테스트"
echo "─────────────────────────────────────"

setup_temp_dirs
trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sdkValidate function ──
echo ""
echo "📋 Test 2: Exports sdkValidate function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sdkValidate === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sdkValidate is a function" "PASS" "$result"

# ── Test 3: SDK unavailable fallback ──
echo ""
echo "📋 Test 3: SDK unavailable → ok:false, no artifacts"
# Install a broken mock that has no query() export — simulates SDK unavailable.
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
    if (k.includes('sdk-runner') || k.includes('sdk-validator') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { sdkValidate } = require('$MODULE');
  sdkValidate({ step: 'test_unavail', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    console.log(JSON.stringify(r));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "error is sdk_not_available" '"error":"sdk_not_available"' "$result"

# No artifacts should have been written
artifact_count=$(ls -1A "$ARTIFACT_DIR" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "no artifacts written when SDK unavailable" "0" "$artifact_count"

# ── Setup mock SDK for tests 4-8 ──
setup_mock_sdk

# ── Test 4: Successful validation — verification.md written ──
echo ""
echo "📋 Test 4: Successful validation → verification.md written to artifactDir"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkValidate({ step: 'verify', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const verifyExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'verification.md'));
    console.log(r.ok === true && verifyExists ? 'PASS' : 'FAIL:' + JSON.stringify({ ok: r.ok, verifyExists }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "success: ok:true + verification.md exists" "PASS" "$result"

# ── Test 5: Successful execution details — ok, step, artifact, model ──
echo ""
echo "📋 Test 5: Successful execution details — ok:true, step, artifact, model fields"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  sdkValidate({ step: 'my_verify', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const checks = [
      r.ok === true,
      r.step === 'my_verify',
      r.artifact === 'verification.md',
      typeof r.model === 'string' && r.model.length > 0,
      typeof r.cost === 'number' && r.cost > 0,
      typeof r.numTurns === 'number',
      typeof r.durationMs === 'number'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "result has ok, step, artifact, model, cost, numTurns, durationMs" "PASS" "$result"

# ── Test 6: SDK error — ok:false, no verification.md ──
echo ""
echo "📋 Test 6: SDK error → ok:false with error details, no verification.md"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkValidate({ step: '__sdk_error__', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const verifyExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'verification.md'));
    const checks = [
      r.ok === false,
      typeof r.error === 'string' && r.error.length > 0,
      !verifyExists
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify({ r, verifyExists }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "SDK error: ok:false, no verification.md" "PASS" "$result"

# ── Test 7: settingSources isolation ──
echo ""
echo "📋 Test 7: settingSources isolation — captured SDK options include settingSources: []"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  sdkValidate({ step: 'settings_test', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "settingSources is []" "PASS" "$result"

# ── Test 8: Fallback verification.md content includes step name ──
echo ""
echo "📋 Test 8: Fallback verification.md content includes step name"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkValidate({ step: 'verify_content', artifactDir: '$ARTIFACT_DIR', cwd: '$PROJECT_ROOT' }).then(r => {
    const content = fs.readFileSync(path.join('$ARTIFACT_DIR', 'verification.md'), 'utf8');
    const hasStep = content.includes('verify_content');
    const hasHeader = content.includes('# Verification Report') || content.includes('Verification');
    console.log(hasStep && hasHeader ? 'PASS' : 'FAIL:hasStep=' + hasStep + ',hasHeader=' + hasHeader);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "verification.md has step name and header" "PASS" "$result"

# ── Worktree Isolation Integration Tests ──────────────────────
# Tests 9-12 use real temp git repos and the mock SDK to verify
# that sdk-validator.js creates/cleans worktrees when pipelineSlug is provided.
# The mock SDK capture file records the cwd that runSdkAgent received.

# ── Test 9: Worktree created for validator ──
echo ""
echo "📋 Test 9: Worktree created for validator — SDK cwd under .vela/worktrees/"
WT_REPO1="$(make_repo)"
WT_ARTIFACT_DIR1="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR1")
setup_mock_sdk
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  const fs = require('fs');
  sdkValidate({ step: 'wt_test', artifactDir: '$WT_ARTIFACT_DIR1', cwd: '$WT_REPO1', pipelineSlug: 'test-slug' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isWorktree = sdkCwd.includes('.vela/worktrees/');
    const notRepoRoot = sdkCwd !== '$WT_REPO1';
    console.log(isWorktree && notRepoRoot ? 'PASS' : 'FAIL:cwd=' + sdkCwd);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "SDK received cwd under .vela/worktrees/" "PASS" "$result"

# ── Test 10: Worktree cleaned up after success ──
echo ""
echo "📋 Test 10: Worktree cleaned up after success — no vela worktrees remain"
WT_REPO2="$(make_repo)"
WT_ARTIFACT_DIR2="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR2")
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  sdkValidate({ step: 'wt_clean', artifactDir: '$WT_ARTIFACT_DIR2', cwd: '$WT_REPO2', pipelineSlug: 'clean-slug' }).then(r => {
    const { execFileSync } = require('child_process');
    const wtList = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: '$WT_REPO2' }).toString();
    const hasVelaWt = wtList.includes('.vela/worktrees/');
    const fs = require('fs');
    const path = require('path');
    const wtDir = path.join('$WT_REPO2', '.vela', 'worktrees');
    const dirEmpty = !fs.existsSync(wtDir) || fs.readdirSync(wtDir).length === 0;
    console.log(!hasVelaWt && dirEmpty ? 'PASS' : 'FAIL:hasVelaWt=' + hasVelaWt + ',dirEmpty=' + dirEmpty);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "no vela worktrees remain after success" "PASS" "$result"

# ── Test 11: Worktree cleaned up after SDK error ──
echo ""
echo "📋 Test 11: Worktree cleaned up after SDK error — cleanup despite error"
WT_REPO3="$(make_repo)"
WT_ARTIFACT_DIR3="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR3")
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  sdkValidate({ step: '__sdk_error__', artifactDir: '$WT_ARTIFACT_DIR3', cwd: '$WT_REPO3', pipelineSlug: 'err-slug' }).then(r => {
    const { execFileSync } = require('child_process');
    const wtList = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: '$WT_REPO3' }).toString();
    const hasVelaWt = wtList.includes('.vela/worktrees/');
    const fs = require('fs');
    const path = require('path');
    const wtDir = path.join('$WT_REPO3', '.vela', 'worktrees');
    const dirEmpty = !fs.existsSync(wtDir) || fs.readdirSync(wtDir).length === 0;
    console.log(!hasVelaWt && dirEmpty ? 'PASS' : 'FAIL:hasVelaWt=' + hasVelaWt + ',dirEmpty=' + dirEmpty);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "no vela worktrees remain after SDK error" "PASS" "$result"

# ── Test 12: Graceful fallback without pipelineSlug ──
echo ""
echo "📋 Test 12: Graceful fallback without pipelineSlug — cwd unchanged"
WT_REPO4="$(make_repo)"
WT_ARTIFACT_DIR4="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR4")
result=$(run_validator_test "
  const { sdkValidate } = require('$MODULE');
  const fs = require('fs');
  sdkValidate({ step: 'no_wt', artifactDir: '$WT_ARTIFACT_DIR4', cwd: '$WT_REPO4' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isOriginal = sdkCwd === '$WT_REPO4';
    console.log(isOriginal ? 'PASS' : 'FAIL:cwd=' + sdkCwd + ',expected=$WT_REPO4');
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "cwd equals original repo root (no worktree created)" "PASS" "$result"

# ── K001 cross-file sweep: settingSources in source ──
echo ""
echo "📋 K001: settingSources present in sdk-validator.js source"
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

# ── Stale reference sweep: no Validator subagent references ──
echo ""
echo "📋 Stale sweep: no Validator subagent references in updated files"
stale=$(rg -n 'Validator\s+subagent|Validator subagent' \
  "$PROJECT_ROOT/scripts/agents/vela-pm.md" \
  "$PROJECT_ROOT/scripts/agents/pm/pipeline-flow.md" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -z "$stale" ]; then
  echo "  ✅ PASS: no stale Validator subagent references"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: stale references found:"
  echo "    $stale"
  FAIL=$((FAIL + 1))
fi

# ── New reference sweep: vela-engine.js validate present in cli-reference ──
echo ""
echo "📋 New sweep: vela-engine.js validate present in cli-reference"
new_refs=$(rg -n 'validate' \
  "$PROJECT_ROOT/references/cli-reference.md" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$new_refs" ]; then
  echo "  ✅ PASS: validate references found"
  echo "    $(echo "$new_refs" | head -3)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: no validate references found in cli-reference.md"
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
