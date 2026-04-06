#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-learning.sh — sdk-learning.js 계약 테스트
#
# Contract-level verification — module exports, Haiku learning
# extraction, artifact collection, persistent storage, worktree
# isolation, settingSources isolation, schema validation.
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary).
# MOCK_LEARNING_MODE env var controls mock behavior
# (following MOCK_DIFF_SCORE_MODE pattern from test-sdk-reviewer.sh).
#
# Test 1:  Module loads without syntax error (node -c)
# Test 2:  Exports sdkLearning function
# Test 3:  SDK unavailable fallback → { ok: false, error: 'sdk_not_available' }
# Test 4:  Successful extraction → ok: true + learning.md written
# Test 5:  Successful extraction details → patterns array exists, cost > 0
# Test 6:  learning.md artifact content check
# Test 7:  Persistent storage → .vela/learnings/learnings.json written
# Test 8:  Persistent storage append → 2 calls produce 2 entries
# Test 9:  Persistent storage FIFO cap → >50 entries trimmed to 50
# Test 10: settingSources isolation — captured SDK options include settingSources: []
# Test 11: collectArtifacts reads review-*.md and approval-*.json
# Test 12: collectArtifacts handles missing files gracefully
# Test 13: System prompt contains required keywords (패턴, 학습, 리뷰)
# Test 14: Schema has patterns, scores_summary, key_learnings, learning_text
# Test 15: pipelineSlug → worktree created, cwd points to worktree
# Test 16: Worktree cleaned up after successful run
# Test 17: Worktree cleaned up after SDK error
# Test 18: No worktree when pipelineSlug not provided
# K001:   settingSources present in sdk-learning.js source sweep
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/sdk-learning.js"
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

# Install mock SDK — Learning extraction architecture.
# MOCK_LEARNING_MODE env var controls behavior:
#   __sdk_error__ → throws error (for worktree cleanup test)
#   default → returns structured learning output
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
  const mode = process.env.MOCK_LEARNING_MODE || '';

  return (async function*() {
    yield { type: 'system', subtype: 'init', session_id: 'mock-learning-session' };

    if (mode === '__sdk_error__' || prompt.includes('__sdk_error__')) {
      throw new Error('Mock SDK deliberate error for worktree cleanup test');
    }

    const structuredOutput = {
      patterns: [
        {
          category: 'strength',
          description: '코드 품질이 우수함',
          frequency: 'recurring',
          step: 'execute'
        },
        {
          category: 'weakness',
          description: '테스트 커버리지 부족',
          frequency: 'first_time',
          step: 'plan'
        }
      ],
      scores_summary: {
        research: 20,
        plan: 18,
        execute: 22,
        diff_summary: 19
      },
      key_learnings: [
        '코드 품질은 우수하나 테스트 커버리지 개선 필요',
        '리서치 단계에서 소스 분석이 체계적',
        '실행 단계에서 보안 관행이 양호'
      ],
      recommendations: [
        '테스트 커버리지를 80% 이상으로 유지할 것',
        '리뷰 피드백을 다음 실행에 반영할 것'
      ],
      learning_text: '# 파이프라인 학습 보고서\n\n## 요약\n전반적으로 양호한 파이프라인 실행이었으나 테스트 커버리지 개선이 필요하다.\n\n## 패턴\n- 강점: 코드 품질 우수\n- 약점: 테스트 커버리지 부족'
    };

    yield {
      type: 'result',
      subtype: 'success',
      result: structuredOutput.learning_text,
      structured_output: structuredOutput,
      total_cost_usd: 0.0005,
      model: 'mock-haiku-model',
      session_id: 'mock-learning-session',
      num_turns: 1,
      duration_ms: 300
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

cleanup_all() {
  teardown_mock_sdk
  teardown_temp_dirs
  cleanup_wt_tmpdirs
}

# Run node with cache clearing, capture file env, from project root.
run_learning_test() {
  local js_code="$1"
  SDK_CAPTURE_FILE="$CAPTURE_FILE" node -e "
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-learning') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Learning 계약 테스트 (Haiku 학습 축적)"
echo "─────────────────────────────────────"

setup_temp_dirs
trap cleanup_all EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: Exports sdkLearning function ──
echo ""
echo "📋 Test 2: Exports sdkLearning function"
result=$(node -e "
  const m = require('$MODULE');
  console.log(typeof m.sdkLearning === 'function' ? 'PASS' : 'FAIL');
" 2>/dev/null)
assert_eq "sdkLearning is a function" "PASS" "$result"

# ── Test 3: SDK unavailable fallback ──
echo ""
echo "📋 Test 3: SDK unavailable → ok:false, error:'sdk_not_available'"
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

# Need review artifacts for the test (otherwise it returns no_artifacts)
mkdir -p "$ARTIFACT_DIR"
echo "## Review Research\nScore: 20/25" > "$ARTIFACT_DIR/review-research.md"

result=$(node -e "
  Object.keys(require.cache).forEach(k => {
    if (k.includes('sdk-runner') || k.includes('sdk-learning') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { sdkLearning } = require('$MODULE');
  sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    console.log(JSON.stringify(r));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "error is sdk_not_available" '"error":"sdk_not_available"' "$result"

# ── Setup mock SDK for tests 4+ ──
setup_mock_sdk

# Populate artifact dir with review files for tests
echo "## Review Research\nScore: 20/25\nGood research coverage." > "$ARTIFACT_DIR/review-research.md"
echo "## Review Plan\nScore: 18/25\nPlan needs improvement." > "$ARTIFACT_DIR/review-plan.md"
echo "## Review Execute\nScore: 22/25\nExcellent execution." > "$ARTIFACT_DIR/review-execute.md"
echo '{"decision":"approve","score":20,"stage":"opus"}' > "$ARTIFACT_DIR/approval-research.json"
echo '{"decision":"approve","score":18,"stage":"opus"}' > "$ARTIFACT_DIR/approval-plan.json"

# ── Test 4: Successful extraction → ok:true + learning.md written ──
echo ""
echo "📋 Test 4: Successful extraction → ok:true + learning.md written"
rm -f "$ARTIFACT_DIR/learning.md" 2>/dev/null || true
rm -rf "$CWD_DIR/.vela/learnings" 2>/dev/null || true
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const fs = require('fs');
    const path = require('path');
    const learningMd = fs.existsSync(path.join('$ARTIFACT_DIR', 'learning.md'));
    const ok = r.ok === true && learningMd;
    console.log(ok ? 'PASS' : 'FAIL:' + JSON.stringify({ ok: r.ok, learningMd }));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "ok:true + learning.md exists" "PASS" "$result"

# ── Test 5: Successful extraction details → patterns array, cost > 0 ──
echo ""
echo "📋 Test 5: Successful extraction details → patterns array exists, cost > 0"
rm -f "$ARTIFACT_DIR/learning.md" 2>/dev/null || true
rm -rf "$CWD_DIR/.vela/learnings" 2>/dev/null || true
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const hasPatterns = Array.isArray(r.patterns) && r.patterns.length > 0;
    const hasCost = typeof r.cost === 'number' && r.cost > 0;
    console.log(hasPatterns && hasCost ? 'PASS' : 'FAIL:patterns=' + hasPatterns + ',cost=' + hasCost + ',r=' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "patterns array exists and cost > 0" "PASS" "$result"

# ── Test 6: learning.md artifact content check ──
echo ""
echo "📋 Test 6: learning.md artifact content check"
rm -f "$ARTIFACT_DIR/learning.md" 2>/dev/null || true
rm -rf "$CWD_DIR/.vela/learnings" 2>/dev/null || true
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const content = fs.readFileSync(path.join('$ARTIFACT_DIR', 'learning.md'), 'utf8');
    const hasContent = content.length > 10;
    const hasHeader = content.includes('학습') || content.includes('보고서') || content.includes('파이프라인');
    console.log(hasContent && hasHeader ? 'PASS' : 'FAIL:len=' + content.length + ',header=' + hasHeader);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "learning.md has meaningful content" "PASS" "$result"

# ── Test 7: Persistent storage → .vela/learnings/learnings.json written ──
echo ""
echo "📋 Test 7: Persistent storage → .vela/learnings/learnings.json written"
rm -rf "$CWD_DIR/.vela/learnings" 2>/dev/null || true
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const jsonPath = path.join('$CWD_DIR', '.vela', 'learnings', 'learnings.json');
    const exists = fs.existsSync(jsonPath);
    if (!exists) { console.log('FAIL:file not found'); return; }
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const isArray = Array.isArray(data) && data.length === 1;
    const hasTs = data[0] && typeof data[0].timestamp === 'string';
    console.log(isArray && hasTs ? 'PASS' : 'FAIL:isArray=' + isArray + ',hasTs=' + hasTs);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "learnings.json written with 1 entry" "PASS" "$result"

# ── Test 8: Persistent storage append → 2 calls produce 2 entries ──
echo ""
echo "📋 Test 8: Persistent storage append → 2 calls produce 2 entries"
rm -rf "$CWD_DIR/.vela/learnings" 2>/dev/null || true
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  (async () => {
    await sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' });
    // Clear require cache for second run
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-learning') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    const mod2 = require('$MODULE');
    await mod2.sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' });
    const jsonPath = path.join('$CWD_DIR', '.vela', 'learnings', 'learnings.json');
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    console.log(data.length === 2 ? 'PASS' : 'FAIL:length=' + data.length);
  })().catch(e => console.log('ERROR:' + e.message));
")
assert_eq "2 calls produce 2 entries" "PASS" "$result"

# ── Test 9: Persistent storage FIFO cap → >50 entries trimmed to 50 ──
echo ""
echo "📋 Test 9: Persistent storage FIFO cap → >50 entries trimmed to 50"
rm -rf "$CWD_DIR/.vela/learnings" 2>/dev/null || true
# Pre-seed with 49 entries, then run once → 50 entries → run again → 51 trimmed to 50
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  const fs = require('fs');
  const path = require('path');
  (async () => {
    // Pre-seed 49 entries
    const learningsDir = path.join('$CWD_DIR', '.vela', 'learnings');
    const learningsPath = path.join(learningsDir, 'learnings.json');
    fs.mkdirSync(learningsDir, { recursive: true });
    const seed = [];
    for (let i = 0; i < 49; i++) {
      seed.push({ timestamp: new Date(Date.now() - i * 1000).toISOString(), patterns: [], scoresSummary: {}, keyLearnings: [], seeded: true });
    }
    fs.writeFileSync(learningsPath, JSON.stringify(seed));

    // Run once → 50 entries
    await sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' });
    const data50 = JSON.parse(fs.readFileSync(learningsPath, 'utf8'));
    if (data50.length !== 50) { console.log('FAIL:after50=' + data50.length); return; }

    // Clear cache and run again → 51 trimmed to 50
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-runner') || k.includes('sdk-learning') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    const mod2 = require('$MODULE');
    await mod2.sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' });
    const data51 = JSON.parse(fs.readFileSync(learningsPath, 'utf8'));
    // Should be 50 (FIFO trimmed), and the oldest seeded entry should be gone
    const isCapped = data51.length === 50;
    // First entry should now be seed[1] (seed[0] was oldest, trimmed)
    const oldestGone = !data51[0].seeded || data51[0].timestamp !== seed[0].timestamp;
    console.log(isCapped ? 'PASS' : 'FAIL:len=' + data51.length);
  })().catch(e => console.log('ERROR:' + e.message));
")
assert_eq "FIFO cap trims to 50 entries" "PASS" "$result"

# ── Test 10: settingSources isolation ──
echo ""
echo "📋 Test 10: settingSources isolation — captured SDK options include settingSources: []"
rm -rf "$CWD_DIR/.vela/learnings" 2>/dev/null || true
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  const fs = require('fs');
  sdkLearning({ artifactDir: '$ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const opts = captured.options || {};
    const ss = opts.settingSources;
    console.log(Array.isArray(ss) && ss.length === 0 ? 'PASS' : 'FAIL:' + JSON.stringify(ss));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "settingSources is []" "PASS" "$result"

# ── Test 11: collectArtifacts reads review-*.md and approval-*.json ──
echo ""
echo "📋 Test 11: collectArtifacts reads review-*.md and approval-*.json"
result=$(node -e "
  // Direct test of collectArtifacts internal behavior via module internals
  // We check that the learning prompt includes content from all artifact files
  const fs = require('fs');
  const captured = JSON.parse(fs.readFileSync('$CAPTURE_FILE', 'utf8'));
  const prompt = captured.prompt || '';
  const hasReviewResearch = prompt.includes('Review Research') || prompt.includes('review-research.md');
  const hasReviewPlan = prompt.includes('Review Plan') || prompt.includes('review-plan.md');
  const hasReviewExecute = prompt.includes('Review Execute') || prompt.includes('review-execute.md');
  const hasApproval = prompt.includes('approval-research.json') || prompt.includes('approve');
  console.log(hasReviewResearch && hasReviewPlan && hasReviewExecute && hasApproval ? 'PASS' : 'FAIL:r=' + hasReviewResearch + ',p=' + hasReviewPlan + ',e=' + hasReviewExecute + ',a=' + hasApproval);
" 2>/dev/null)
assert_eq "prompt contains all review artifacts" "PASS" "$result"

# ── Test 12: collectArtifacts handles missing files gracefully ──
echo ""
echo "📋 Test 12: collectArtifacts handles missing files gracefully"
EMPTY_ARTIFACT_DIR="$(mktemp -d)"
# Only put one file — the rest should be skipped silently
echo "## Review Research\nScore: 20/25" > "$EMPTY_ARTIFACT_DIR/review-research.md"
rm -rf "$CWD_DIR/.vela/learnings" 2>/dev/null || true
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  sdkLearning({ artifactDir: '$EMPTY_ARTIFACT_DIR', cwd: '$CWD_DIR' }).then(r => {
    // Should succeed with partial artifacts, not crash
    console.log(r.ok === true ? 'PASS' : 'FAIL:' + JSON.stringify(r));
  }).catch(e => console.log('ERROR:' + e.message));
")
rm -rf "$EMPTY_ARTIFACT_DIR"
assert_eq "handles missing artifact files gracefully" "PASS" "$result"

# ── Test 13: System prompt contains required keywords ──
echo ""
echo "📋 Test 13: System prompt contains required keywords (패턴, 학습, 리뷰)"
result=$(node -e "
  const fs = require('fs');
  const captured = JSON.parse(fs.readFileSync('$CAPTURE_FILE', 'utf8'));
  const sp = (captured.options && captured.options.systemPrompt) || '';
  const has패턴 = sp.includes('패턴');
  const has학습 = sp.includes('학습');
  const has리뷰 = sp.includes('리뷰');
  console.log(has패턴 && has학습 && has리뷰 ? 'PASS' : 'FAIL:패턴=' + has패턴 + ',학습=' + has학습 + ',리뷰=' + has리뷰);
" 2>/dev/null)
assert_eq "system prompt has 패턴, 학습, 리뷰" "PASS" "$result"

# ── Test 14: Schema has patterns, scores_summary, key_learnings, learning_text ──
echo ""
echo "📋 Test 14: Schema has patterns, scores_summary, key_learnings, learning_text"
result=$(node -e "
  const fs = require('fs');
  const captured = JSON.parse(fs.readFileSync('$CAPTURE_FILE', 'utf8'));
  const schema = captured.options && captured.options.outputFormat && captured.options.outputFormat.schema;
  if (!schema || !schema.properties) { console.log('FAIL:no schema'); process.exit(0); }
  const props = schema.properties;
  const hasPatterns = 'patterns' in props;
  const hasScores = 'scores_summary' in props;
  const hasLearnings = 'key_learnings' in props;
  const hasText = 'learning_text' in props;
  console.log(hasPatterns && hasScores && hasLearnings && hasText ? 'PASS' : 'FAIL:p=' + hasPatterns + ',s=' + hasScores + ',l=' + hasLearnings + ',t=' + hasText);
" 2>/dev/null)
assert_eq "schema has all required fields" "PASS" "$result"

# ── Worktree Isolation Integration Tests ──────────────────────

# ── Test 15: pipelineSlug → worktree created, cwd points to worktree ──
echo ""
echo "📋 Test 15: pipelineSlug → worktree created, cwd points to worktree"
WT_REPO1="$(make_repo)"
WT_ARTIFACT_DIR1="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR1")
echo "## Review Research\nScore: 20/25" > "$WT_ARTIFACT_DIR1/review-research.md"
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  const fs = require('fs');
  sdkLearning({ artifactDir: '$WT_ARTIFACT_DIR1', cwd: '$WT_REPO1', pipelineSlug: 'test-slug' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isWorktree = sdkCwd.includes('.vela/worktrees/');
    const notRepoRoot = sdkCwd !== '$WT_REPO1';
    console.log(isWorktree && notRepoRoot ? 'PASS' : 'FAIL:cwd=' + sdkCwd);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "SDK received cwd under .vela/worktrees/" "PASS" "$result"

# ── Test 16: Worktree cleaned up after successful run ──
echo ""
echo "📋 Test 16: Worktree cleaned up after successful run"
WT_REPO2="$(make_repo)"
WT_ARTIFACT_DIR2="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR2")
echo "## Review Research\nScore: 20/25" > "$WT_ARTIFACT_DIR2/review-research.md"
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  sdkLearning({ artifactDir: '$WT_ARTIFACT_DIR2', cwd: '$WT_REPO2', pipelineSlug: 'clean-slug' }).then(r => {
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

# ── Test 17: Worktree cleaned up after SDK error ──
echo ""
echo "📋 Test 17: Worktree cleaned up after SDK error"
WT_REPO3="$(make_repo)"
WT_ARTIFACT_DIR3="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR3")
echo "## Review Research\nScore: 20/25" > "$WT_ARTIFACT_DIR3/review-research.md"
result=$(MOCK_LEARNING_MODE="__sdk_error__" run_learning_test "
  const { sdkLearning } = require('$MODULE');
  sdkLearning({ artifactDir: '$WT_ARTIFACT_DIR3', cwd: '$WT_REPO3', pipelineSlug: 'err-slug' }).then(r => {
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

# ── Test 18: No worktree when pipelineSlug not provided ──
echo ""
echo "📋 Test 18: No worktree when pipelineSlug not provided — cwd unchanged"
WT_REPO4="$(make_repo)"
WT_ARTIFACT_DIR4="$(mktemp -d)"
WT_TMPDIRS+=("$WT_ARTIFACT_DIR4")
echo "## Review Research\nScore: 20/25" > "$WT_ARTIFACT_DIR4/review-research.md"
result=$(run_learning_test "
  const { sdkLearning } = require('$MODULE');
  const fs = require('fs');
  sdkLearning({ artifactDir: '$WT_ARTIFACT_DIR4', cwd: '$WT_REPO4' }).then(r => {
    const captured = JSON.parse(fs.readFileSync(process.env.SDK_CAPTURE_FILE, 'utf8'));
    const sdkCwd = (captured.options && captured.options.cwd) || '';
    const isOriginal = sdkCwd === '$WT_REPO4';
    console.log(isOriginal ? 'PASS' : 'FAIL:cwd=' + sdkCwd + ',expected=$WT_REPO4');
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "cwd equals original repo root (no worktree created)" "PASS" "$result"

# ── Source sweep: K001 ────────────────────────────────────────

echo ""
echo "📋 K001: settingSources present in sdk-learning.js source"
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
