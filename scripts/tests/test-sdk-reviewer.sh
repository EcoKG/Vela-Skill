#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-reviewer.sh — sdk-reviewer.js 계약 테스트
#
# Contract-level verification — module exports, Opus single-pass
# review logic (pass/reject), score parsing, artifact generation,
# step-aware prompts/schemas, worktree isolation, fallback.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkReview function
# Test 3:  SDK unavailable fallback — returns { ok: false, error: 'sdk_not_available' }
# Test 4:  Opus pass (score >= 20) → decision:'approve', stage:'opus'
# Test 5:  Opus pass → approval artifact written with correct fields
# Test 6:  Opus reject (score < 20) → decision:'reject', stage:'opus'
# Test 7:  Opus reject → approval artifact has reject + stage:'opus'
# Test 8:  Score parse null → fallback behavior (reject with score null)
# Test 9:  settingSources isolation — captured SDK options include settingSources: []
# Test 10: Structured output total takes priority over regex
# Test 11: Structured output absent → regex parseScore() fallback
# Test 12: Structured output review_text used for artifact
# Test 13: step='research' → Source Coverage in prompt, no Security
# Test 14: step='execute' → Security & Data Safety in prompt, no Source Coverage
# Test 15: step='plan' → Architecture & Design in prompt
# Test 16: step='unknown_step' → execute fallback (Security & Data Safety)
# Test 17: step='research' → schema has source_coverage
# Test 18: step='execute' → schema has security_data_safety
# Test 19: step='plan' → schema has api_interface
# Test 20: pipelineSlug → worktree created, SDK receives worktree cwd
# Test 21: Worktree cleaned up after success
# Test 22: Worktree cleaned up after SDK error
# Test 23: No worktree when pipelineSlug absent
# Sweep:  no stale reviewResult.verdict in vela-pipeline.js
# Sweep:  escalate_to_pm exists in vela-pipeline.js
# Sweep:  no stale 3-stage fields in sdk-reviewer.js
# K001:   settingSources present in sdk-reviewer.js source
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/sdk-reviewer.js"
MODULE_DIR="$PROJECT_ROOT/scripts/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
CAPTURE_FILE=""
ARTIFACT_DIR=""
CWD_DIR=""
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

# Create temp directories for artifact generation tests
setup_temp_dirs() {
  ARTIFACT_DIR="$(mktemp -d)"
  CWD_DIR="$(mktemp -d)"
  mkdir -p "$CWD_DIR/.vela/state"
}

teardown_temp_dirs() {
  rm -rf "$ARTIFACT_DIR" "$CWD_DIR" 2>/dev/null || true
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

# Install mock SDK — Opus single-pass architecture.
# No multi-stage logic — score markers determine response:
#   __score_22__ → 22/25 (pass, >= 20)
#   __score_15__ → 15/25 (reject, < 20)
#   __score_null__ → no score line (null → reject)
#   __structured_25__ → structured output with total=25 + review_text
#   __no_structured__ → text with ## Total: 23/25, no structured output
#   __sdk_error__ → throws error (for worktree cleanup test)
#   default → 20/25 (pass)
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
    yield { type: 'system', subtype: 'init', session_id: 'mock-reviewer-session' };

    let scoreText = '';
    let structuredOutput = undefined;

    if (prompt.includes('__structured_25__')) {
      // Structured output path: return structured_output with total + review_text
      scoreText = 'Mock review — structured output test (text has no ## Total).';
      structuredOutput = {
        scores: { security_data_safety: 5, robustness_resource_safety: 5, readability_maintainability: 5, test_quality: 5, completeness_contract: 5 },
        total: 25,
        issues: [],
        review_text: 'Structured review: all dimensions excellent via JSON schema.'
      };
    } else if (prompt.includes('__no_structured__')) {
      // No structured output — falls back to regex
      scoreText = 'Regex fallback review.\n\n## Total: 23/25';
    } else if (prompt.includes('__score_22__')) {
      scoreText = 'Opus review — pass.\n\n## Total: 22/25';
    } else if (prompt.includes('__score_15__')) {
      scoreText = 'Opus review — reject.\n\n## Total: 15/25';
    } else if (prompt.includes('__score_null__')) {
      scoreText = 'Opus review — no score line present.';
    } else if (prompt.includes('__sdk_error__')) {
      throw new Error('Mock SDK deliberate error for worktree cleanup test');
    } else {
      scoreText = 'Default review.\n\n## Total: 20/25';
    }

    const resultPayload = {
      type: 'result',
      subtype: 'success',
      result: scoreText,
      total_cost_usd: 0.001,
      model: 'mock-opus-model',
      session_id: 'mock-reviewer-session',
      num_turns: 3,
      duration_ms: 500
    };
    if (structuredOutput !== undefined) {
      resultPayload.structured_output = structuredOutput;
    }
    yield resultPayload;
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
  cleanup_wt_tmpdirs
}

# Run node with cache clearing, capture file env, from project root.
run_reviewer_test() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-reviewer') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Reviewer 계약 테스트 (Opus 단일 아키텍처)"
echo "─────────────────────────────────────"

setup_temp_dirs
trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sdkReview function ──
echo ""
echo "📋 Test 2: Exports sdkReview function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sdkReview === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sdkReview is a function" "PASS" "$result"

# ── Test 3: SDK unavailable fallback ──
echo ""
echo "📋 Test 3: SDK unavailable → ok:false, no artifacts"
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
    if (k.includes('sdk-runner') || k.includes('sdk-reviewer') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: 'test_unavail', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    console.log(JSON.stringify(r));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "error is sdk_not_available" '"error":"sdk_not_available"' "$result"

artifact_count=$(ls -1A "$ARTIFACT_DIR" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "no artifacts written when SDK unavailable" "0" "$artifact_count"

# ── Setup mock SDK for tests 4+ ──
setup_mock_sdk

# ── Test 4: Opus pass (score >= 20) → approve, stage opus ──
echo ""
echo "📋 Test 4: Opus pass (score 22) → decision:'approve', stage:'opus'"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__score_22__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const ok = r.ok === true && r.decision === 'approve' && r.stage === 'opus' && r.score === 22;
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "Opus pass: approve + stage opus" "PASS" "$result"

# ── Test 5: Opus pass → approval artifact with correct fields ──
echo ""
echo "📋 Test 5: Opus pass → approval artifact written with correct fields"
result=$(node -e "
  const ap = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/approval-__score_22__.json', 'utf8'));
  const ok = ap.score === 22 && ap.stage === 'opus' && ap.decision === 'approve' && ap.threshold === 20;
  console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(ap));
" 2>/dev/null)
assert_eq "approval artifact: score 22, stage opus, approve, threshold 20" "PASS" "$result"

# ── Test 6: Opus reject (score < 20) → reject, stage opus ──
echo ""
echo "📋 Test 6: Opus reject (score 15) → decision:'reject', stage:'opus'"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__score_15__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const ok = r.ok === true && r.decision === 'reject' && r.stage === 'opus' && r.score === 15;
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "Opus reject: reject + stage opus" "PASS" "$result"

# ── Test 7: Opus reject → approval artifact has reject + stage opus ──
echo ""
echo "📋 Test 7: Opus reject → approval artifact has reject + stage:'opus'"
result=$(node -e "
  const ap = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/approval-__score_15__.json', 'utf8'));
  const ok = ap.score === 15 && ap.stage === 'opus' && ap.decision === 'reject' && ap.threshold === 20;
  console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(ap));
" 2>/dev/null)
assert_eq "approval artifact: score 15, stage opus, reject" "PASS" "$result"

# ── Test 8: Score parse null → reject with score null ──
echo ""
echo "📋 Test 8: Score parse null → fallback behavior (reject with score null)"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__score_null__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const ok = r.ok === true && r.decision === 'reject' && r.stage === 'opus' && r.score === null;
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "null score: reject with score null" "PASS" "$result"

# ── Test 9: settingSources isolation ──
echo ""
echo "📋 Test 9: settingSources isolation — captured SDK options include settingSources: []"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__score_22__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "settingSources is []" "PASS" "$result"

# ── Test 10: Structured output total takes priority over regex ──
echo ""
echo "📋 Test 10: structured_output.total takes priority over parseScore() regex"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__structured_25__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // structured_output provides total=25; text has NO ## Total line, so regex would return null
    // If score is 25, it came from structuredOutput.total, not parseScore()
    const ok = r.ok === true && r.score === 25 && r.decision === 'approve' && r.stage === 'opus';
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "structured_output.total used for score (25)" "PASS" "$result"

# ── Test 11: Structured output absent → regex parseScore() fallback ──
echo ""
echo "📋 Test 11: structured_output absent → regex parseScore() fallback"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__no_structured__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // No structured_output in mock response; regex finds ## Total: 23/25
    const ok = r.ok === true && r.score === 23 && r.decision === 'approve' && r.stage === 'opus';
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "regex fallback score (23)" "PASS" "$result"

# ── Test 12: Structured output review_text used for artifact ──
echo ""
echo "📋 Test 12: structured_output.review_text used for review artifact when present"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkReview({ step: '__structured_25__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const reviewPath = path.join('$ARTIFACT_DIR', 'review-__structured_25__.md');
    const content = fs.readFileSync(reviewPath, 'utf8');
    // review_text from structuredOutput should be used, not the result text
    const ok = content.includes('Structured review: all dimensions excellent via JSON schema.');
    console.log(ok ? 'PASS' : 'FAIL:content=' + content.substring(0, 100));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "review artifact uses structured review_text" "PASS" "$result"

# ── Test 13: step='research' → Source Coverage in prompt, no Security ──
echo ""
echo "📋 Test 13: step='research' → Source Coverage in prompt, no Security & Data Safety"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'research', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const hasResearch = sp.includes('Source Coverage');
    const noExecute = !sp.includes('Security & Data Safety');
    console.log(hasResearch && noExecute ? 'PASS' : 'FAIL:research=' + hasResearch + ',noExec=' + noExecute);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "research step: Source Coverage in prompt, no Security & Data Safety" "PASS" "$result"

# ── Test 14: step='execute' → Security & Data Safety in prompt, no Source Coverage ──
echo ""
echo "📋 Test 14: step='execute' → Security & Data Safety in prompt, no Source Coverage"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'execute', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const hasExecute = sp.includes('Security & Data Safety');
    const noResearch = !sp.includes('Source Coverage');
    console.log(hasExecute && noResearch ? 'PASS' : 'FAIL:exec=' + hasExecute + ',noResearch=' + noResearch);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "execute step: Security & Data Safety in prompt, no Source Coverage" "PASS" "$result"

# ── Test 15: step='plan' → Architecture & Design in prompt ──
echo ""
echo "📋 Test 15: step='plan' → Architecture & Design in prompt"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'plan', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const hasPlan = sp.includes('Architecture & Design');
    const noResearch = !sp.includes('Source Coverage');
    const noExecute = !sp.includes('Security & Data Safety');
    console.log(hasPlan && noResearch && noExecute ? 'PASS' : 'FAIL:plan=' + hasPlan + ',noR=' + noResearch + ',noE=' + noExecute);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "plan step: Architecture & Design, no Source Coverage or Security" "PASS" "$result"

# ── Test 16: step='unknown_step' → execute fallback (Security & Data Safety) ──
echo ""
echo "📋 Test 16: step='unknown_step' → execute fallback (Security & Data Safety)"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'unknown_step', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const hasExecute = sp.includes('Security & Data Safety');
    console.log(hasExecute ? 'PASS' : 'FAIL:hasExecute=' + hasExecute);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "unknown step falls back to execute prompt" "PASS" "$result"

# ── Test 17: step='research' → schema has source_coverage ──
echo ""
echo "📋 Test 17: step='research' → outputFormat schema has source_coverage"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'research', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const schema = captured.options.outputFormat && captured.options.outputFormat.schema;
    const scoreProp = schema && schema.properties && schema.properties.scores && schema.properties.scores.properties;
    const hasSc = scoreProp && 'source_coverage' in scoreProp;
    const noSecurity = scoreProp && !('security_data_safety' in scoreProp);
    console.log(hasSc && noSecurity ? 'PASS' : 'FAIL:hasSc=' + hasSc + ',noSecurity=' + noSecurity);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "research schema has source_coverage, no security_data_safety" "PASS" "$result"

# ── Test 18: step='execute' → schema has security_data_safety ──
echo ""
echo "📋 Test 18: step='execute' → outputFormat schema has security_data_safety"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'execute', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const schema = captured.options.outputFormat && captured.options.outputFormat.schema;
    const scoreProp = schema && schema.properties && schema.properties.scores && schema.properties.scores.properties;
    const hasSecurity = scoreProp && 'security_data_safety' in scoreProp;
    const noSource = scoreProp && !('source_coverage' in scoreProp);
    console.log(hasSecurity && noSource ? 'PASS' : 'FAIL:hasSecurity=' + hasSecurity + ',noSource=' + noSource);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "execute schema has security_data_safety, no source_coverage" "PASS" "$result"

# ── Test 19: step='plan' → schema has api_interface ──
echo ""
echo "📋 Test 19: step='plan' → outputFormat schema has api_interface"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'plan', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const schema = captured.options.outputFormat && captured.options.outputFormat.schema;
    const scoreProp = schema && schema.properties && schema.properties.scores && schema.properties.scores.properties;
    const hasApi = scoreProp && 'api_interface' in scoreProp;
    const noSource = scoreProp && !('source_coverage' in scoreProp);
    const noSecurity = scoreProp && !('security_data_safety' in scoreProp);
    console.log(hasApi && noSource && noSecurity ? 'PASS' : 'FAIL:hasApi=' + hasApi + ',noSource=' + noSource + ',noSecurity=' + noSecurity);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "plan schema has api_interface, no source_coverage or security_data_safety" "PASS" "$result"

# ── Worktree Isolation Integration Tests ──────────────────────

# ── Test 20: pipelineSlug → worktree created, SDK receives worktree cwd ──
echo ""
echo "📋 Test 20: pipelineSlug provided → SDK receives cwd under .vela/worktrees/"
WT_REPO1="$(make_repo)"
WT_ARTIFACT_DIR1="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR1")
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__score_22__', artifactDir: '$WT_ARTIFACT_DIR1', cwd: '$WT_REPO1', pipelineSlug: 'test-slug' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isWorktree = sdkCwd.includes('.vela/worktrees/');
    const notRepoRoot = sdkCwd !== '$WT_REPO1';
    console.log(isWorktree && notRepoRoot ? 'PASS' : 'FAIL:cwd=' + sdkCwd);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "SDK received cwd under .vela/worktrees/" "PASS" "$result"

# ── Test 21: Worktree cleaned up after successful review ──
echo ""
echo "📋 Test 21: Worktree cleaned up after successful review — no vela worktrees remain"
WT_REPO2="$(make_repo)"
WT_ARTIFACT_DIR2="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR2")
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__score_22__', artifactDir: '$WT_ARTIFACT_DIR2', cwd: '$WT_REPO2', pipelineSlug: 'clean-slug' }).then(r => {
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

# ── Test 22: Worktree cleaned up after SDK error ──
echo ""
echo "📋 Test 22: Worktree cleaned up after SDK error — cleanup despite error"
WT_REPO3="$(make_repo)"
WT_ARTIFACT_DIR3="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR3")
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__sdk_error__', artifactDir: '$WT_ARTIFACT_DIR3', cwd: '$WT_REPO3', pipelineSlug: 'err-slug' }).then(r => {
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

# ── Test 23: No worktree when pipelineSlug absent ──
echo ""
echo "📋 Test 23: No worktree when pipelineSlug not provided — cwd unchanged"
WT_REPO4="$(make_repo)"
WT_ARTIFACT_DIR4="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR4")
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__score_22__', artifactDir: '$WT_ARTIFACT_DIR4', cwd: '$WT_REPO4' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isOriginal = sdkCwd === '$WT_REPO4';
    console.log(isOriginal ? 'PASS' : 'FAIL:cwd=' + sdkCwd + ',expected=$WT_REPO4');
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "cwd equals original repo root (no worktree created)" "PASS" "$result"

# ── Pipeline sweeps ──────────────────────────────────────────

echo ""
echo "📋 Pipeline sweep: no stale reviewResult.verdict in vela-pipeline.js"
stale_verdict=$(rg 'reviewResult\.verdict' "$PROJECT_ROOT/scripts/cli/vela-pipeline.js" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -z "$stale_verdict" ]; then
  echo "  ✅ PASS: no stale verdict references"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: stale verdict references found:"
  echo "    $stale_verdict"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "📋 Pipeline sweep: escalate_to_pm exists in vela-pipeline.js"
esc_ref=$(rg 'escalate_to_pm' "$PROJECT_ROOT/scripts/cli/vela-pipeline.js" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$esc_ref" ]; then
  echo "  ✅ PASS: escalate_to_pm found"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: escalate_to_pm NOT found"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "📋 Sweep: no stale 3-stage fields in sdk-reviewer.js"
stale_3stage=$(rg 'FAIL_THRESHOLD|runOpusEscalation|stage.*haiku|stage.*sonnet|HAIKU_MODEL|SONNET_MODEL' "$MODULE" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -z "$stale_3stage" ]; then
  echo "  ✅ PASS: no stale 3-stage references"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: stale 3-stage references found:"
  echo "    $stale_3stage"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "📋 K001: settingSources present in sdk-reviewer.js source"
sweep_result=$(rg -n 'settingSources' "$MODULE" 2>/dev/null | head -5)
TOTAL=$((TOTAL + 1))
if [ -n "$sweep_result" ]; then
  echo "  ✅ PASS: settingSources found in source"
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
