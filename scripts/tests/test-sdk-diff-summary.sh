#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-diff-summary.sh — sdk-diff-summary.js 계약 테스트
#
# Contract-level verification — module exports, Opus diff review
# logic (pass/reject), score parsing, artifact generation,
# worktree isolation, fallback.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-runner.js's location.
#
# Mock uses MOCK_DIFF_SCORE_MODE env var to control behavior
# (sdk-diff-summary.js has a fixed prompt, unlike sdk-reviewer.js
# which embeds the step name into the prompt).
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkDiffSummary function
# Test 3:  SDK unavailable fallback — returns { ok: false, error: 'sdk_not_available' }
# Test 4:  Pass (score >= 20) → decision:'approve', has summary field
# Test 5:  Pass → approval artifact approval-diff-summary.json with correct fields
# Test 6:  Reject (score < 20) → decision:'reject'
# Test 7:  Reject → approval artifact has reject decision
# Test 8:  Score parse null → reject fallback
# Test 9:  settingSources isolation — captured SDK options include settingSources: []
# Test 10: Structured output total takes priority over regex
# Test 11: Structured output absent → regex parseScore() fallback
# Test 12: System prompt contains 5 scoring dimensions
# Test 13: Schema has correct fields (cross_file_consistency, etc.)
# Test 14: Worktree created when pipelineSlug provided — SDK receives worktree cwd
# Test 15: Worktree cleaned up after success
# Test 16: Worktree cleaned up after SDK error
# Test 17: No worktree when pipelineSlug absent
# K001:   settingSources present in sdk-diff-summary.js source
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/sdk-diff-summary.js"
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

# Install mock SDK — uses MOCK_DIFF_SCORE_MODE env var.
# sdk-diff-summary.js has a fixed prompt (no step parameter),
# so mock behavior is controlled via env var instead of prompt markers.
#
# Modes:
#   pass_22       → 22/25 (approve, >= 20)
#   reject_15     → 15/25 (reject, < 20)
#   null_score    → no score line (null → reject)
#   structured_25 → structured output with total=25, summary, review_text
#   no_structured → text with ## Total: 23/25, no structured output
#   sdk_error     → throws error (for worktree cleanup test)
#   default       → 20/25 (approve)
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

  const mode = process.env.MOCK_DIFF_SCORE_MODE || 'default';

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-diff-summary-session' };

    let scoreText = '';
    let structuredOutput = undefined;

    if (mode === 'structured_25') {
      scoreText = 'Mock diff review — structured output test (text has no ## Total).';
      structuredOutput = {
        scores: { cross_file_consistency: 5, change_completeness: 5, documentation_sync: 5, regression_risk: 5, overall_coherence: 5 },
        total: 25,
        issues: [],
        review_text: 'Structured diff review: all dimensions excellent via JSON schema.',
        summary: '전체 변경 사항이 일관성 있게 잘 구현되었습니다.'
      };
    } else if (mode === 'no_structured') {
      scoreText = 'Regex fallback diff review.\n\n## Total: 23/25';
    } else if (mode === 'pass_22') {
      scoreText = 'Diff review — pass.\n\n## Total: 22/25';
    } else if (mode === 'reject_15') {
      scoreText = 'Diff review — reject.\n\n## Total: 15/25';
    } else if (mode === 'null_score') {
      scoreText = 'Diff review — no score line present.';
    } else if (mode === 'sdk_error') {
      throw new Error('Mock SDK deliberate error for worktree cleanup test');
    } else {
      scoreText = 'Default diff review.\n\n## Total: 20/25';
    }

    const resultPayload = {
      type: 'result',
      subtype: 'success',
      result: scoreText,
      total_cost_usd: 0.001,
      model: 'mock-opus-model',
      session_id: 'mock-diff-summary-session',
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

# Run node with cache clearing, capture file env, score mode env.
run_diff_summary_test() {
  local js_code="$1"
  local score_mode="${2:-default}"
  MOCK_DIFF_SCORE_MODE="$score_mode" SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-diff-summary') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Diff Summary 계약 테스트 (Opus 전체 diff 통합 검토)"
echo "─────────────────────────────────────"

setup_temp_dirs
trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sdkDiffSummary function ──
echo ""
echo "📋 Test 2: Exports sdkDiffSummary function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sdkDiffSummary === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sdkDiffSummary is a function" "PASS" "$result"

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
    if (k.includes('sdk-runner') || k.includes('sdk-diff-summary') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
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

# ── Test 4: Pass (score >= 20) → approve, has summary ──
echo ""
echo "📋 Test 4: Pass (score 22) → decision:'approve', has summary field"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const ok = r.ok === true && r.decision === 'approve' && r.score === 22 && 'summary' in r;
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" "pass_22")
assert_eq "approve with score 22, summary present" "PASS" "$result"

# ── Test 5: Pass → approval artifact with correct fields ──
echo ""
echo "📋 Test 5: Pass → approval-diff-summary.json written with correct fields"
result=$(node -e "
  const ap = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/approval-diff-summary.json', 'utf8'));
  const ok = ap.score === 22 && ap.decision === 'approve' && ap.threshold === 20 && ap._source === 'sdk-diff-summary';
  console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(ap));
" 2>/dev/null)
assert_eq "approval artifact: score 22, approve, threshold 20, _source sdk-diff-summary" "PASS" "$result"

# ── Test 6: Reject (score < 20) ──
echo ""
echo "📋 Test 6: Reject (score 15) → decision:'reject'"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const ok = r.ok === true && r.decision === 'reject' && r.score === 15;
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" "reject_15")
assert_eq "reject with score 15" "PASS" "$result"

# ── Test 7: Reject → approval artifact has reject decision ──
echo ""
echo "📋 Test 7: Reject → approval artifact has reject decision"
result=$(node -e "
  const ap = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/approval-diff-summary.json', 'utf8'));
  const ok = ap.score === 15 && ap.decision === 'reject' && ap.threshold === 20;
  console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(ap));
" 2>/dev/null)
assert_eq "approval artifact: score 15, reject" "PASS" "$result"

# ── Test 8: Score parse null → reject fallback ──
echo ""
echo "📋 Test 8: Score parse null → fallback behavior (reject with score null)"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const ok = r.ok === true && r.decision === 'reject' && r.score === null;
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" "null_score")
assert_eq "null score: reject with score null" "PASS" "$result"

# ── Test 9: settingSources isolation ──
echo ""
echo "📋 Test 9: settingSources isolation — captured SDK options include settingSources: []"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(require('fs').readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  }).catch(e => console.log('ERROR:' + e.message));
" "pass_22")
assert_eq "settingSources is []" "PASS" "$result"

# ── Test 10: Structured output total takes priority over regex ──
echo ""
echo "📋 Test 10: structured_output.total takes priority over parseScore() regex"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // structured_output provides total=25; text has NO ## Total line
    const ok = r.ok === true && r.score === 25 && r.decision === 'approve';
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" "structured_25")
assert_eq "structured_output.total used for score (25)" "PASS" "$result"

# ── Test 11: Structured output absent → regex parseScore() fallback ──
echo ""
echo "📋 Test 11: structured_output absent → regex parseScore() fallback"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // No structured_output; regex finds ## Total: 23/25
    const ok = r.ok === true && r.score === 23 && r.decision === 'approve';
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
" "no_structured")
assert_eq "regex fallback score (23)" "PASS" "$result"

# ── Test 12: System prompt contains 5 scoring dimensions ──
echo ""
echo "📋 Test 12: System prompt contains all 5 scoring dimensions"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  const fs = require('fs');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sp = captured.options.systemPrompt || '';
    const d1 = sp.includes('Cross-file Consistency');
    const d2 = sp.includes('Change Completeness');
    const d3 = sp.includes('Documentation Sync');
    const d4 = sp.includes('Regression Risk');
    const d5 = sp.includes('Overall Coherence');
    console.log(d1 && d2 && d3 && d4 && d5 ? 'PASS' : 'FAIL:d1=' + d1 + ',d2=' + d2 + ',d3=' + d3 + ',d4=' + d4 + ',d5=' + d5);
  }).catch(e => console.log('ERROR:' + e.message));
" "pass_22")
assert_eq "system prompt has all 5 scoring dimensions" "PASS" "$result"

# ── Test 13: Schema has correct fields ──
echo ""
echo "📋 Test 13: Schema has correct scoring dimension fields"
rm -f "$ARTIFACT_DIR"/* 2>/dev/null || true
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  const fs = require('fs');
  sdkDiffSummary({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const schema = captured.options.outputFormat && captured.options.outputFormat.schema;
    const sp = schema && schema.properties && schema.properties.scores && schema.properties.scores.properties;
    const has = sp
      && 'cross_file_consistency' in sp
      && 'change_completeness' in sp
      && 'documentation_sync' in sp
      && 'regression_risk' in sp
      && 'overall_coherence' in sp;
    console.log(has ? 'PASS' : 'FAIL:keys=' + JSON.stringify(sp ? Object.keys(sp) : null));
  }).catch(e => console.log('ERROR:' + e.message));
" "pass_22")
assert_eq "schema has all 5 scoring dimension fields" "PASS" "$result"

# ── Worktree Isolation Integration Tests ──────────────────────

# ── Test 14: pipelineSlug → worktree created, SDK receives worktree cwd ──
echo ""
echo "📋 Test 14: pipelineSlug provided → SDK receives cwd under .vela/worktrees/"
WT_REPO1="$(make_repo)"
WT_ARTIFACT_DIR1="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR1")
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  const fs = require('fs');
  sdkDiffSummary({ artifactDir: '$WT_ARTIFACT_DIR1', cwd: '$WT_REPO1', pipelineSlug: 'test-slug' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isWorktree = sdkCwd.includes('.vela/worktrees/');
    const notRepoRoot = sdkCwd !== '$WT_REPO1';
    console.log(isWorktree && notRepoRoot ? 'PASS' : 'FAIL:cwd=' + sdkCwd);
  }).catch(e => console.log('ERROR:' + e.message));
" "pass_22")
assert_eq "SDK received cwd under .vela/worktrees/" "PASS" "$result"

# ── Test 15: Worktree cleaned up after successful review ──
echo ""
echo "📋 Test 15: Worktree cleaned up after success — no vela worktrees remain"
WT_REPO2="$(make_repo)"
WT_ARTIFACT_DIR2="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR2")
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$WT_ARTIFACT_DIR2', cwd: '$WT_REPO2', pipelineSlug: 'clean-slug' }).then(r => {
    const { execFileSync } = require('child_process');
    const wtList = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: '$WT_REPO2' }).toString();
    const hasVelaWt = wtList.includes('.vela/worktrees/');
    const fs = require('fs');
    const path = require('path');
    const wtDir = path.join('$WT_REPO2', '.vela', 'worktrees');
    const dirEmpty = !fs.existsSync(wtDir) || fs.readdirSync(wtDir).length === 0;
    console.log(!hasVelaWt && dirEmpty ? 'PASS' : 'FAIL:hasVelaWt=' + hasVelaWt + ',dirEmpty=' + dirEmpty);
  }).catch(e => console.log('ERROR:' + e.message));
" "pass_22")
assert_eq "no vela worktrees remain after success" "PASS" "$result"

# ── Test 16: Worktree cleaned up after SDK error ──
echo ""
echo "📋 Test 16: Worktree cleaned up after SDK error — cleanup despite error"
WT_REPO3="$(make_repo)"
WT_ARTIFACT_DIR3="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR3")
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  sdkDiffSummary({ artifactDir: '$WT_ARTIFACT_DIR3', cwd: '$WT_REPO3', pipelineSlug: 'err-slug' }).then(r => {
    const { execFileSync } = require('child_process');
    const wtList = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: '$WT_REPO3' }).toString();
    const hasVelaWt = wtList.includes('.vela/worktrees/');
    const fs = require('fs');
    const path = require('path');
    const wtDir = path.join('$WT_REPO3', '.vela', 'worktrees');
    const dirEmpty = !fs.existsSync(wtDir) || fs.readdirSync(wtDir).length === 0;
    console.log(!hasVelaWt && dirEmpty ? 'PASS' : 'FAIL:hasVelaWt=' + hasVelaWt + ',dirEmpty=' + dirEmpty);
  }).catch(e => console.log('ERROR:' + e.message));
" "sdk_error")
assert_eq "no vela worktrees remain after SDK error" "PASS" "$result"

# ── Test 17: No worktree when pipelineSlug absent ──
echo ""
echo "📋 Test 17: No worktree when pipelineSlug not provided — cwd unchanged"
WT_REPO4="$(make_repo)"
WT_ARTIFACT_DIR4="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR4")
result=$(run_diff_summary_test "
  const { sdkDiffSummary } = require('$MODULE');
  const fs = require('fs');
  sdkDiffSummary({ artifactDir: '$WT_ARTIFACT_DIR4', cwd: '$WT_REPO4' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isOriginal = sdkCwd === '$WT_REPO4';
    console.log(isOriginal ? 'PASS' : 'FAIL:cwd=' + sdkCwd + ',expected=$WT_REPO4');
  }).catch(e => console.log('ERROR:' + e.message));
" "pass_22")
assert_eq "cwd equals original repo root (no worktree created)" "PASS" "$result"

# ── K001 sweep ───────────────────────────────────────────────

echo ""
echo "📋 K001: settingSources present in sdk-diff-summary.js source"
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
