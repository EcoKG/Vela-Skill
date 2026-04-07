#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-researcher-modes.sh — M023/S02 researcher mode contract tests
#
# Verifies the project_mode pipeline: detectProjectMode() + buildStepPrompt
# mode-block injection (T01 contract) and the bootstrap/targeted/exploratory
# rewrites in researcher.md/index.md/hypothesis.md (T02 contract).
#
# Tests:
#   1. detectProjectMode(empty dir, 'large')          → 'bootstrap'
#   2. detectProjectMode(project root, 'small')       → 'targeted'
#   3. detectProjectMode(project root, 'large')       → 'exploratory'
#   4. buildStepPrompt('research', {project_mode: X}) contains X  (3 modes)
#   5. researcher.md/index.md/hypothesis.md carry all 3 mode keywords
#      AND contain zero '반드시.*경쟁가설' occurrences
#
# Runs with no SDK/API calls — pure function + file-content verification.
# K010: test does not touch SDK mocks, but regressions are run sequentially
# after this file to stay consistent with existing test ordering.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIPELINE_MODULE="$PROJECT_ROOT/scripts/cli/vela-pipeline.js"
RESEARCHER_MD="$PROJECT_ROOT/scripts/agents/researcher.md"
RESEARCHER_INDEX="$PROJECT_ROOT/scripts/agents/researcher/index.md"
RESEARCHER_HYPOTHESIS="$PROJECT_ROOT/scripts/agents/researcher/hypothesis.md"

# ANSI colors for summary
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RESET='\033[0m'

PASS=0
FAIL=0
TOTAL=0

TMP_EMPTY_DIR=""

cleanup() {
  [ -n "$TMP_EMPTY_DIR" ] && rm -rf "$TMP_EMPTY_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}✅ PASS${RESET}: $label"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ FAIL${RESET}: $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}✅ PASS${RESET}: $label"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ FAIL${RESET}: $label — '$needle' not found"
    FAIL=$((FAIL + 1))
  fi
}

echo "═══════════════════════════════════════════════════"
echo "  researcher.md mode contract tests (M023/S02)"
echo "═══════════════════════════════════════════════════"

# Preflight: module loads
node -c "$PIPELINE_MODULE" 2>/dev/null || {
  echo -e "${RED}FATAL${RESET}: vela-pipeline.js has a syntax error"
  exit 2
}

# Create empty tmp directory (no files, no .git) for Test 1
TMP_EMPTY_DIR="$(mktemp -d)"

# ══════════════════════════════════════════════════════════
# Test 1: detectProjectMode(empty dir, 'large') → 'bootstrap'
#   fileCount=0 branch short-circuits before scale check
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 1: detectProjectMode — empty dir → bootstrap ──"
MODE_EMPTY=$(node -e "
  const { detectProjectMode } = require('$PIPELINE_MODULE');
  const mode = detectProjectMode('$TMP_EMPTY_DIR', 'large');
  console.log(mode);
" 2>/dev/null | tail -1)
assert_eq "empty dir + scale=large → 'bootstrap'" "bootstrap" "$MODE_EMPTY"

# ══════════════════════════════════════════════════════════
# Test 2: detectProjectMode(project root) → 'exploratory'
#   fileCount>0 → exploratory (binary mode: bootstrap/exploratory)
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 2: detectProjectMode — project root → exploratory ──"
MODE_SMALL=$(node -e "
  const { detectProjectMode } = require('$PIPELINE_MODULE');
  const mode = detectProjectMode('$PROJECT_ROOT');
  console.log(mode);
" 2>/dev/null | tail -1)
assert_eq "project root → 'exploratory'" "exploratory" "$MODE_SMALL"

# ══════════════════════════════════════════════════════════
# Test 3: detectProjectMode(project root, 'large') → 'exploratory'
#   fileCount>0 + scale=large routes to exploratory
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 3: detectProjectMode — project root + large → exploratory ──"
MODE_LARGE=$(node -e "
  const { detectProjectMode } = require('$PIPELINE_MODULE');
  const mode = detectProjectMode('$PROJECT_ROOT', 'large');
  console.log(mode);
" 2>/dev/null | tail -1)
assert_eq "project root + scale=large → 'exploratory'" "exploratory" "$MODE_LARGE"

# ══════════════════════════════════════════════════════════
# Test 4: buildStepPrompt injects project_mode into research prompt
#   All 3 modes verified in one node invocation
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 4: buildStepPrompt — mode injection ──"
PROMPT_RESULTS=$(node -e "
  const { buildStepPrompt } = require('$PIPELINE_MODULE');
  const stepDef = { id: 'research', name: 'Research' };
  const baseState = { request: 'x' };
  const artifactDir = '/tmp/art';

  const out = {};
  for (const mode of ['bootstrap', 'targeted', 'exploratory']) {
    const prompt = buildStepPrompt(stepDef, { ...baseState, project_mode: mode }, artifactDir);
    out[mode] = prompt.includes(mode);
  }
  console.log(JSON.stringify(out));
" 2>/dev/null)
assert_contains "research prompt contains 'bootstrap'" '"bootstrap":true' "$PROMPT_RESULTS"
assert_contains "research prompt contains 'targeted'" '"targeted":true' "$PROMPT_RESULTS"
assert_contains "research prompt contains 'exploratory'" '"exploratory":true' "$PROMPT_RESULTS"

# ══════════════════════════════════════════════════════════
# Test 5: researcher agent files carry all 3 mode keywords AND
#         contain zero '반드시.*경쟁가설' regex matches
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 5: researcher agent files — 3-mode keywords + no hard '반드시 경쟁가설' ──"

for file_path in "$RESEARCHER_MD" "$RESEARCHER_INDEX" "$RESEARCHER_HYPOTHESIS"; do
  rel="${file_path#$PROJECT_ROOT/}"
  TOTAL=$((TOTAL + 1))
  missing=""
  for kw in bootstrap exploratory; do
    if ! grep -q "$kw" "$file_path"; then
      missing="$missing $kw"
    fi
  done
  if [ -z "$missing" ]; then
    echo -e "  ${GREEN}✅ PASS${RESET}: $rel — all 3 mode keywords present"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ FAIL${RESET}: $rel — missing keywords:$missing"
    FAIL=$((FAIL + 1))
  fi
done

# Negation check — '반드시.*경쟁가설' must NOT appear in any of the 3 files
TOTAL=$((TOTAL + 1))
NEG_MATCHES=$(grep -l -E '반드시.*경쟁가설|경쟁가설.*반드시' \
  "$RESEARCHER_MD" "$RESEARCHER_INDEX" "$RESEARCHER_HYPOTHESIS" 2>/dev/null || true)
if [ -z "$NEG_MATCHES" ]; then
  echo -e "  ${GREEN}✅ PASS${RESET}: no '반드시.*경쟁가설' in researcher agent files"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}❌ FAIL${RESET}: '반드시.*경쟁가설' still present in: $NEG_MATCHES"
  FAIL=$((FAIL + 1))
fi

# ══════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo -e "  ${RED}Results${RESET}: $PASS/$TOTAL passed, ${RED}$FAIL failed${RESET}"
  echo "═══════════════════════════════════════════════════"
  exit 1
fi
echo -e "  ${GREEN}Results${RESET}: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"
exit 0
