#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-reviewer.sh — sdk-reviewer.js 계약 테스트
#
# Contract-level verification — module exports, 2-stage review
# logic (clear pass, borderline, clear fail), score parsing,
# artifact generation, escalation, fallback, hook isolation.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkReview function
# Test 3:  SDK unavailable fallback — returns { ok: false, error: 'sdk_not_available' }, no artifacts
# Test 4:  Clear pass (score 25) → approve + artifacts written
# Test 5:  Clear pass details → score 25, stage haiku
# Test 6:  Borderline (score 17) → triggers Sonnet second pass
# Test 7:  Borderline details → Sonnet score 22, stage sonnet, approve
# Test 8:  Clear fail (score 10) → Opus escalation → approve + escalated:true
# Test 9:  Opus escalation approval artifact → escalation_model: opus
# Test 10: settingSources isolation — captured SDK options include settingSources: []
# Test 11: __opus_pass__ → Haiku fail (10) → Opus pass (22) → approve + escalated:true
# Test 12: __opus_also_fail__ → Haiku fail (10) → Opus fail (8) → reject + escalated:true + escalation.json
# Test 13: __borderline_opus__ → Haiku borderline (17) → Sonnet fail (14) → Opus pass (21) → approve + escalated:true
# Test 14: Escalation.json has auto_escalated:true when Opus fails
# Test 15: structured_output.total takes priority over parseScore() regex
# Test 16: structured_output absent → falls back to regex parseScore()
# Test 17: structured_output.review_text used for review artifact when present
# Test 18: step='research' → Source Coverage in prompt, no Layer Separation
# Test 19: step='execute' → Layer Separation in prompt, no Source Coverage
# Test 20: step='plan' → Architecture Design in prompt
# Test 21: step='unknown_step' → execute fallback (Layer Separation)
# Test 22: step='research' → outputFormat schema has source_coverage
# Test 23: pipelineSlug provided → SDK receives cwd under .vela/worktrees/
# Test 24: Worktree cleaned up after successful review — no vela worktrees remain
# Test 25: Worktree cleaned up after SDK error — cleanup despite error
# Test 26: No worktree when pipelineSlug not provided — cwd unchanged
# Sweep:   no stale reviewResult.verdict in vela-pipeline.js
# Sweep:   escalate_to_pm exists in vela-pipeline.js
# K001:    settingSources present in sdk-reviewer.js source
# Broad:   No stale Reviewer subagent references in updated files
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

# Create temp directories for artifact generation + escalation tests
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

# Install mock SDK in sdk-runner.js's own node_modules directory
# so dynamic import() resolves it during module resolution.
# Mock returns configurable scores based on prompt content:
#   __score_25__ → 25/25 (clear pass)
#   __score_17__ → 17/25 (borderline); Stage 2 → 22/25
#   __score_10__ → 10/25 (clear fail); Stage 3 Opus → determined by marker variant
#   __opus_pass__  → Haiku 10 (fail) → Opus 22 (pass)
#   __opus_also_fail__ → Haiku 10 (fail) → Opus 8 (fail)
#   __borderline_opus__ → Haiku 17 (borderline) → Sonnet 14 (fail) → Opus 21 (pass)
# Differentiates stages by:
#   - Stage 2 Sonnet: prompt contains "이전 Haiku 리뷰"
#   - Stage 3 Opus: options.model contains "opus"
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
  const model = (args && args.options && args.options.model) || '';
  const isOpus = model.includes('opus');
  const isStage2 = prompt.includes('\uC774\uC804 Haiku \uB9AC\uBDF0');

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-reviewer-session' };

    let scoreText = '';
    let structuredOutput = undefined;

    if (prompt.includes('__structured_25__')) {
      // Structured output path: return structured_output with total + review_text
      scoreText = 'Mock review — structured output test (text has no ## Total).';
      structuredOutput = {
        scores: { layer_separation: 5, ddd_patterns: 5, solid_principles: 5, test_strategy: 5, specification_completeness: 5 },
        total: 25,
        issues: [],
        review_text: 'Structured review: all dimensions excellent via JSON schema.'
      };
    } else if (prompt.includes('__no_structured__')) {
      // No structured output — falls back to regex
      scoreText = 'Regex fallback review.\n\n## Total: 23/25';
    } else if (prompt.includes('__opus_pass__')) {
      if (isOpus) {
        scoreText = 'Opus escalation review \u2014 rescued.\n\n## Total: 22/25';
      } else {
        scoreText = 'Haiku fail review.\n\n## Total: 10/25';
      }
    } else if (prompt.includes('__opus_also_fail__')) {
      if (isOpus) {
        scoreText = 'Opus escalation review \u2014 still bad.\n\n## Total: 8/25';
      } else {
        scoreText = 'Haiku severe fail.\n\n## Total: 10/25';
      }
    } else if (prompt.includes('__borderline_opus__')) {
      if (isOpus) {
        scoreText = 'Opus escalation review \u2014 borderline rescued.\n\n## Total: 21/25';
      } else if (isStage2) {
        scoreText = 'Sonnet deep review \u2014 still below threshold.\n\n## Total: 14/25';
      } else {
        scoreText = 'Haiku borderline review.\n\n## Total: 17/25';
      }
    } else if (prompt.includes('__sdk_error__')) {
      // Throw error to test worktree cleanup on SDK failure
      throw new Error('Mock SDK deliberate error for worktree cleanup test');
    } else if (prompt.includes('__score_25__')) {
      scoreText = 'Mock review \u2014 all dimensions excellent.\n\n## Total: 25/25';
    } else if (prompt.includes('__score_17__')) {
      if (isStage2) {
        scoreText = 'Sonnet deep review \u2014 improved assessment.\n\n## Total: 22/25';
      } else {
        scoreText = 'Haiku initial review \u2014 borderline quality.\n\n## Total: 17/25';
      }
    } else if (prompt.includes('__score_10__')) {
      if (isOpus) {
        scoreText = 'Opus escalation \u2014 default pass.\n\n## Total: 22/25';
      } else {
        scoreText = 'Severe design issues found.\n\n## Total: 10/25';
      }
    } else {
      scoreText = 'Default review.\n\n## Total: 20/25';
    }

    const resultPayload = {
      type: 'result',
      subtype: 'success',
      result: scoreText,
      total_cost_usd: 0.001,
      model: isOpus ? 'mock-opus-model' : 'mock-model',
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

echo "🔧 SDK Reviewer 계약 테스트"
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

# No artifacts should have been written
artifact_count=$(ls -1A "$ARTIFACT_DIR" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "no artifacts written when SDK unavailable" "0" "$artifact_count"

# ── Setup mock SDK for tests 4-10 ──
setup_mock_sdk

# ── Test 4: Clear pass (score 25) → approve + artifacts ──
echo ""
echo "📋 Test 4: Clear pass (score 25) → approve + artifacts written"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkReview({ step: '__score_25__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const reviewExists = fs.existsSync(path.join('$ARTIFACT_DIR', 'review-__score_25__.md'));
    const approvalPath = path.join('$ARTIFACT_DIR', 'approval-__score_25__.json');
    const approvalExists = fs.existsSync(approvalPath);
    let approvalOk = false;
    if (approvalExists) {
      const ap = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
      approvalOk = ap.decision === 'approve';
    }
    const checks = [r.ok === true, r.decision === 'approve', reviewExists, approvalExists, approvalOk];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "clear pass: approve + artifacts" "PASS" "$result"

# ── Test 5: Clear pass details — score 25, stage haiku ──
echo ""
echo "📋 Test 5: Clear pass → score 25, stage haiku"
result=$(node -e "
  const ap = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/approval-__score_25__.json', 'utf8'));
  console.log(ap.score === 25 && ap.stage === 'haiku' ? 'PASS' : 'FAIL:score=' + ap.score + ',stage=' + ap.stage);
" 2>/dev/null)
assert_eq "score 25, stage haiku" "PASS" "$result"

# ── Clean artifacts for borderline test ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 6: Borderline (score 17) → triggers Sonnet second pass ──
echo ""
echo "📋 Test 6: Borderline (score 17) → triggers Sonnet second pass"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__score_17__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    console.log(r.ok === true && r.stage === 'sonnet' ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "borderline triggers Sonnet" "PASS" "$result"

# ── Test 7: Borderline → Sonnet score 22, stage sonnet, approve ──
echo ""
echo "📋 Test 7: Borderline → final approval uses Sonnet score 22"
result=$(node -e "
  const ap = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/approval-__score_17__.json', 'utf8'));
  const ok = ap.score === 22 && ap.stage === 'sonnet' && ap.decision === 'approve';
  console.log(ok ? 'PASS' : 'FAIL:score=' + ap.score + ',stage=' + ap.stage + ',decision=' + ap.decision);
" 2>/dev/null)
assert_eq "Sonnet score 22, stage sonnet, approve" "PASS" "$result"

# ── Clean artifacts + escalation for fail test ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
rm -f "$CWD_DIR/.vela/state/escalation.json" 2>/dev/null || true

# ── Test 8: Clear fail (score 10) → Opus escalation → approve + escalated ──
echo ""
echo "📋 Test 8: Clear fail (score 10) → Opus escalation → approve + escalated:true"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__score_10__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const approvalPath = '$ARTIFACT_DIR/approval-__score_10__.json';
    const ap = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    const checks = [r.ok === true, r.decision === 'approve', r.stage === 'opus', r.escalated === true, ap.escalated === true];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify({ r: r, ap: ap }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "clear fail: Opus escalation → approve + escalated" "PASS" "$result"

# ── Test 9: Opus escalation approval artifact has escalation_model ──
echo ""
echo "📋 Test 9: Opus escalation approval artifact → escalation_model: opus"
result=$(node -e "
  const ap = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/approval-__score_10__.json', 'utf8'));
  console.log(ap.escalation_model === 'opus' && ap.stage === 'opus' ? 'PASS' : 'FAIL:' + JSON.stringify(ap));
" 2>/dev/null)
assert_eq "approval escalation_model=opus, stage=opus" "PASS" "$result"

# ── Clean artifacts for settingSources test ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 10: settingSources isolation ──
echo ""
echo "📋 Test 10: settingSources isolation — captured SDK options include settingSources: []"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__score_25__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "settingSources is []" "PASS" "$result"

# ── Clean artifacts + escalation for Opus tests ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
rm -f "$CWD_DIR/.vela/state/escalation.json" 2>/dev/null || true

# ── Test 11: __opus_pass__ → Haiku fail (10) → Opus pass (22) → approve + escalated ──
echo ""
echo "📋 Test 11: __opus_pass__ → Haiku fail → Opus pass → approve + escalated:true"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__opus_pass__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const approvalPath = '$ARTIFACT_DIR/approval-__opus_pass__.json';
    const ap = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    const checks = [
      r.ok === true,
      r.decision === 'approve',
      r.stage === 'opus',
      r.escalated === true,
      r.score === 22,
      ap.decision === 'approve',
      ap.escalated === true,
      ap.escalation_model === 'opus'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify({ r: r, ap: ap }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "opus_pass: Haiku fail → Opus approve + escalated" "PASS" "$result"

# ── Clean for opus_also_fail ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
rm -f "$CWD_DIR/.vela/state/escalation.json" 2>/dev/null || true

# ── Test 12: __opus_also_fail__ → Haiku fail (10) → Opus fail (8) → reject + escalated + escalation.json ──
echo ""
echo "📋 Test 12: __opus_also_fail__ → Haiku fail → Opus fail → reject + escalated:true + escalation.json"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__opus_also_fail__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const approvalPath = '$ARTIFACT_DIR/approval-__opus_also_fail__.json';
    const escalationPath = '$CWD_DIR/.vela/state/escalation.json';
    const ap = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    const escExists = fs.existsSync(escalationPath);
    let escOk = false;
    if (escExists) {
      const esc = JSON.parse(fs.readFileSync(escalationPath, 'utf8'));
      escOk = esc.auto_escalated === true;
    }
    const checks = [
      r.ok === true,
      r.decision === 'reject',
      r.stage === 'opus',
      r.escalated === true,
      r.score === 8,
      ap.decision === 'reject',
      ap.escalated === true,
      escExists,
      escOk
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify({ r: r, ap: ap, escExists: escExists, escOk: escOk }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "opus_also_fail: reject + escalated + auto_escalated" "PASS" "$result"

# ── Clean for borderline_opus ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
rm -f "$CWD_DIR/.vela/state/escalation.json" 2>/dev/null || true

# ── Test 13: __borderline_opus__ → Haiku 17 → Sonnet 14 → Opus 21 → approve + escalated ──
echo ""
echo "📋 Test 13: __borderline_opus__ → borderline → Sonnet fail → Opus pass → approve + escalated:true"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__borderline_opus__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const approvalPath = '$ARTIFACT_DIR/approval-__borderline_opus__.json';
    const ap = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    const checks = [
      r.ok === true,
      r.decision === 'approve',
      r.stage === 'opus',
      r.escalated === true,
      r.score === 21,
      ap.decision === 'approve',
      ap.escalated === true,
      ap.escalation_model === 'opus'
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify({ r: r, ap: ap }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "borderline_opus: Sonnet fail → Opus approve + escalated" "PASS" "$result"

# ── Test 14: escalation.json auto_escalated field on Opus reject ──
echo ""
echo "📋 Test 14: escalation.json has auto_escalated:true on Opus reject"
# Re-use the escalation.json from Test 12
rm -f "$CWD_DIR/.vela/state/escalation.json" 2>/dev/null || true
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__opus_also_fail__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const escalationPath = '$CWD_DIR/.vela/state/escalation.json';
    const esc = JSON.parse(fs.readFileSync(escalationPath, 'utf8'));
    const checks = [esc.auto_escalated === true, esc.score === 8, esc.threshold === 15];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(esc));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "escalation.json auto_escalated:true, score, threshold" "PASS" "$result"

# ── Clean artifacts for structured output tests ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 15: structured_output.total takes priority over parseScore() regex ──
echo ""
echo "📋 Test 15: structured_output.total takes priority over parseScore() regex"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__structured_25__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // structured_output provides total=25; text has NO ## Total line, so regex would return null
    // If score is 25, it came from structuredOutput.total, not parseScore()
    const ok = r.ok === true && r.score === 25 && r.decision === 'approve' && r.stage === 'haiku';
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "structured_output.total used for score (25)" "PASS" "$result"

# ── Clean artifacts ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 16: structured_output absent → falls back to regex parseScore() ──
echo ""
echo "📋 Test 16: structured_output absent → regex parseScore() fallback"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__no_structured__', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // No structured_output in mock response; regex finds ## Total: 23/25
    const ok = r.ok === true && r.score === 23 && r.decision === 'approve' && r.stage === 'haiku';
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "regex fallback score (23)" "PASS" "$result"

# ── Test 17: structured_output.review_text used for review artifact ──
echo ""
echo "📋 Test 17: structured_output.review_text used for review artifact when present"
result=$(node -e "
  const content = require('fs').readFileSync('$ARTIFACT_DIR/../' + require('path').basename('$ARTIFACT_DIR') + '/../' + 'x', 'utf8');
" 2>/dev/null || true)
# Re-run structured_25 to generate artifact, then check its content
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

# ── Clean artifacts for step-aware tests ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 18: step='research' → prompt contains 'Source Coverage', not 'Layer Separation' ──
echo ""
echo "📋 Test 18: step='research' → Source Coverage in prompt, no Layer Separation"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'research', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const hasResearch = sp.includes('Source Coverage');
    const noExecute = !sp.includes('Layer Separation');
    console.log(hasResearch && noExecute ? 'PASS' : 'FAIL:research=' + hasResearch + ',noExec=' + noExecute);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "research step: Source Coverage in prompt, no Layer Separation" "PASS" "$result"

# ── Clean artifacts ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 19: step='execute' → prompt contains 'Layer Separation', not 'Source Coverage' ──
echo ""
echo "📋 Test 19: step='execute' → Layer Separation in prompt, no Source Coverage"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'execute', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const hasExecute = sp.includes('Layer Separation');
    const noResearch = !sp.includes('Source Coverage');
    console.log(hasExecute && noResearch ? 'PASS' : 'FAIL:exec=' + hasExecute + ',noResearch=' + noResearch);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "execute step: Layer Separation in prompt, no Source Coverage" "PASS" "$result"

# ── Clean artifacts ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 20: step='plan' → prompt contains 'Architecture Design' ──
echo ""
echo "📋 Test 20: step='plan' → Architecture Design in prompt"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'plan', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const hasPlan = sp.includes('Architecture Design');
    const noResearch = !sp.includes('Source Coverage');
    const noExecute = !sp.includes('Layer Separation');
    console.log(hasPlan && noResearch && noExecute ? 'PASS' : 'FAIL:plan=' + hasPlan + ',noR=' + noResearch + ',noE=' + noExecute);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "plan step: Architecture Design, no Source Coverage or Layer Separation" "PASS" "$result"

# ── Clean artifacts ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 21: step='unknown_step' → execute fallback (Layer Separation in prompt) ──
echo ""
echo "📋 Test 21: step='unknown_step' → execute fallback (Layer Separation)"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'unknown_step', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const hasExecute = sp.includes('Layer Separation');
    console.log(hasExecute ? 'PASS' : 'FAIL:hasExecute=' + hasExecute);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "unknown step falls back to execute prompt" "PASS" "$result"

# ── Clean artifacts ──
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true

# ── Test 22: step='research' → outputFormat schema has 'source_coverage' ──
echo ""
echo "📋 Test 22: step='research' → outputFormat schema has source_coverage"
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: 'research', artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const schema = captured.options.outputFormat && captured.options.outputFormat.schema;
    const scoreProp = schema && schema.properties && schema.properties.scores && schema.properties.scores.properties;
    const hasSc = scoreProp && 'source_coverage' in scoreProp;
    const noLayer = scoreProp && !('layer_separation' in scoreProp);
    console.log(hasSc && noLayer ? 'PASS' : 'FAIL:hasSc=' + hasSc + ',noLayer=' + noLayer);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "research schema has source_coverage, no layer_separation" "PASS" "$result"

# ── Pipeline verdict sweep ──
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

# ── Pipeline escalate_to_pm sweep ──
echo ""
echo "📋 Pipeline sweep: escalate_to_pm exists in vela-pipeline.js"
esc_ref=$(rg 'escalate_to_pm' "$PROJECT_ROOT/scripts/cli/vela-pipeline.js" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$esc_ref" ]; then
  echo "  ✅ PASS: escalate_to_pm found"
  echo "    $esc_ref"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: escalate_to_pm NOT found"
  FAIL=$((FAIL + 1))
fi

# ── K001 cross-file sweep: settingSources in source ──
echo ""
echo "📋 K001: settingSources present in sdk-reviewer.js source"
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

# ── Broad sweep: no stale subagent reviewer references ──
echo ""
echo "📋 Broad sweep: no stale Reviewer subagent references in updated files"
stale=$(rg -n 'Reviewer\s+(subagent|Teammate)|리뷰어.*subagent|subagent.*리뷰어' \
  "$PROJECT_ROOT/scripts/cli/vela-pipeline.js" \
  "$PROJECT_ROOT/scripts/agents/vela-pm.md" \
  "$PROJECT_ROOT/scripts/agents/pm/pipeline-flow.md" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -z "$stale" ]; then
  echo "  ✅ PASS: no stale references found"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: stale references found:"
  echo "    $stale"
  FAIL=$((FAIL + 1))
fi

# ── Worktree Isolation Integration Tests ──────────────────────
# Tests 23-26 use real temp git repos and the mock SDK to verify
# that sdk-reviewer.js creates/cleans worktrees when pipelineSlug is provided.
# The mock SDK capture file records the cwd that runReviewStage received.

# ── Test 23: Worktree created for reviewer ──
echo ""
echo "📋 Test 23: pipelineSlug provided → SDK receives cwd under .vela/worktrees/"
WT_REPO1="$(make_repo)"
WT_ARTIFACT_DIR1="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR1")
WT_CWD_DIR1="$(mktemp -d)"
mkdir -p "$WT_CWD_DIR1/.vela/state"
WT_TMPDIRS+=("$WT_CWD_DIR1")
setup_mock_sdk
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__score_25__', artifactDir: '$WT_ARTIFACT_DIR1', cwd: '$WT_REPO1', pipelineSlug: 'test-slug' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isWorktree = sdkCwd.includes('.vela/worktrees/');
    const notRepoRoot = sdkCwd !== '$WT_REPO1';
    console.log(isWorktree && notRepoRoot ? 'PASS' : 'FAIL:cwd=' + sdkCwd);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "SDK received cwd under .vela/worktrees/" "PASS" "$result"

# ── Test 24: Worktree cleaned up after successful review ──
echo ""
echo "📋 Test 24: Worktree cleaned up after successful review — no vela worktrees remain"
WT_REPO2="$(make_repo)"
WT_ARTIFACT_DIR2="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR2")
WT_CWD_DIR2="$(mktemp -d)"
mkdir -p "$WT_CWD_DIR2/.vela/state"
WT_TMPDIRS+=("$WT_CWD_DIR2")
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  sdkReview({ step: '__score_25__', artifactDir: '$WT_ARTIFACT_DIR2', cwd: '$WT_REPO2', pipelineSlug: 'clean-slug' }).then(r => {
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

# ── Test 25: Worktree cleaned up after SDK error ──
echo ""
echo "📋 Test 25: Worktree cleaned up after SDK error — cleanup despite error"
WT_REPO3="$(make_repo)"
WT_ARTIFACT_DIR3="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR3")
WT_CWD_DIR3="$(mktemp -d)"
mkdir -p "$WT_CWD_DIR3/.vela/state"
WT_TMPDIRS+=("$WT_CWD_DIR3")
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

# ── Test 26: No worktree when pipelineSlug not provided ──
echo ""
echo "📋 Test 26: No worktree when pipelineSlug not provided — cwd unchanged"
WT_REPO4="$(make_repo)"
WT_ARTIFACT_DIR4="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR4")
WT_CWD_DIR4="$(mktemp -d)"
mkdir -p "$WT_CWD_DIR4/.vela/state"
WT_TMPDIRS+=("$WT_CWD_DIR4")
result=$(run_reviewer_test "
  const { sdkReview } = require('$MODULE');
  const fs = require('fs');
  sdkReview({ step: '__score_25__', artifactDir: '$WT_ARTIFACT_DIR4', cwd: '$WT_REPO4' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isOriginal = sdkCwd === '$WT_REPO4';
    console.log(isOriginal ? 'PASS' : 'FAIL:cwd=' + sdkCwd + ',expected=$WT_REPO4');
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "cwd equals original repo root (no worktree created)" "PASS" "$result"

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
