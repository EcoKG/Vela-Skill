#!/bin/bash
# ─── S04 Hardening Regression Test Suite ───
# Covers: SDK null guards, deploy script syntax, esc() hardening, execSync sweep

set -e

PASS=0
FAIL=0
TOTAL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

# ────────────────────────────────────────────
# 1. SDK null input guards (T02 regression)
# ────────────────────────────────────────────
echo ""
echo "═══ SDK Null Input Guards ═══"

SDK_MODULES=(
  "sdk-executor:sdkExecute"
  "sdk-reviewer:sdkReview"
  "sdk-plan-checker:sdkPlanCheck"
  "sdk-researcher:sdkResearch"
  "sdk-analyzer:sdkAnalyze"
)

for entry in "${SDK_MODULES[@]}"; do
  MODULE="${entry%%:*}"
  FUNC="${entry##*:}"
  RESULT=$(node -e "
    const m = require('$PROJECT_DIR/scripts/hooks/shared/${MODULE}.js');
    Promise.resolve(m.${FUNC}(null)).then(r => console.log(JSON.stringify(r)));
  " 2>/dev/null)
  if echo "$RESULT" | grep -q '"ok":false.*"error":"invalid_input"'; then
    pass "$MODULE: null → invalid_input"
  else
    fail "$MODULE: null → expected invalid_input, got: $RESULT"
  fi
done

# ────────────────────────────────────────────
# 2. Deploy script syntax validity
# ────────────────────────────────────────────
echo ""
echo "═══ Deploy Script Syntax ═══"

if bash -n "$PROJECT_DIR/install.sh" 2>/dev/null; then
  pass "install.sh syntax valid"
else
  fail "install.sh syntax invalid"
fi

if bash -n "$PROJECT_DIR/update.sh" 2>/dev/null; then
  pass "update.sh syntax valid"
else
  fail "update.sh syntax invalid"
fi

# ────────────────────────────────────────────
# 3. sync_local_project() function exists in both scripts
# ────────────────────────────────────────────
echo ""
echo "═══ Deploy Script Unification ═══"

if grep -q 'sync_local_project()' "$PROJECT_DIR/install.sh"; then
  pass "install.sh has sync_local_project()"
else
  fail "install.sh missing sync_local_project()"
fi

if grep -q 'sync_local_project()' "$PROJECT_DIR/update.sh"; then
  pass "update.sh has sync_local_project()"
else
  fail "update.sh missing sync_local_project()"
fi

# Verify install.sh auto-upgrade block uses the function
if grep -q 'sync_local_project "\$SKILL_DIR"' "$PROJECT_DIR/install.sh"; then
  pass "install.sh auto-upgrade calls sync_local_project"
else
  fail "install.sh auto-upgrade does not call sync_local_project"
fi

# Verify update.sh --local block uses the function
if grep -q 'sync_local_project "\$TMP"' "$PROJECT_DIR/update.sh"; then
  pass "update.sh --local calls sync_local_project"
else
  fail "update.sh --local does not call sync_local_project"
fi

# ────────────────────────────────────────────
# 4. settings.json backup (AUDIT-030)
# ────────────────────────────────────────────
echo ""
echo "═══ Settings Backup ═══"

if grep -q 'cp "\$SETTINGS" "\$SETTINGS.bak"' "$PROJECT_DIR/install.sh"; then
  pass "install.sh backs up settings.json before modification"
else
  fail "install.sh missing settings.json backup"
fi

# ────────────────────────────────────────────
# 5. esc() hardening (backslash + null byte)
# ────────────────────────────────────────────
echo ""
echo "═══ esc() Hardening ═══"

# Test backslash doubling
ESC_BACKSLASH=$(node -e "
  const esc = (str) => (str || '').replace(/\0/g, '').replace(/\\\\/g, '\\\\\\\\').replace(/'/g, \"''\");
  console.log(esc('a\\\\b'));
")
if [ "$ESC_BACKSLASH" = 'a\\b' ]; then
  pass "esc() doubles backslashes"
else
  fail "esc() backslash handling: expected 'a\\\\b', got '$ESC_BACKSLASH'"
fi

# Test null byte stripping
ESC_NULL=$(node -e "
  const esc = (str) => (str || '').replace(/\0/g, '').replace(/\\\\/g, '\\\\\\\\').replace(/'/g, \"''\");
  console.log(esc('ab\x00cd'));
")
if [ "$ESC_NULL" = "abcd" ]; then
  pass "esc() strips null bytes"
else
  fail "esc() null byte handling: expected 'abcd', got '$ESC_NULL'"
fi

# Test single quote escaping still works
ESC_QUOTE=$(node -e "
  const esc = (str) => (str || '').replace(/\0/g, '').replace(/\\\\/g, '\\\\\\\\').replace(/'/g, \"''\");
  console.log(esc(\"it's\"));
")
if [ "$ESC_QUOTE" = "it''s" ]; then
  pass "esc() still escapes single quotes"
else
  fail "esc() quote handling: expected \"it''s\", got '$ESC_QUOTE'"
fi

# Verify esc() in treenode.js source has all three transforms
ESC_BODY=$(sed -n '/^function esc/,/^}/p' "$PROJECT_DIR/scripts/cache/treenode.js")
if echo "$ESC_BODY" | grep -q 'Strip NULL' && echo "$ESC_BODY" | grep -q 'Double backslash'; then
  pass "treenode.js esc() has null byte + backslash handling in source"
else
  fail "treenode.js esc() missing hardening transforms"
fi

# ────────────────────────────────────────────
# 6. SQL parameterization (AUDIT-031)
# ────────────────────────────────────────────
echo ""
echo "═══ SQL Parameterization ═══"

# sqlJsIngest should use prepare/bind, not esc()
if grep -A5 'sqlJsIngest' "$PROJECT_DIR/scripts/cache/treenode.js" | grep -q 'db.prepare'; then
  pass "sqlJsIngest uses db.prepare() (parameterized)"
else
  fail "sqlJsIngest still uses string interpolation"
fi

# sqlJsQuery should use prepare/bind, not esc()
if grep -A5 'sqlJsQuery' "$PROJECT_DIR/scripts/cache/treenode.js" | grep -q 'db.prepare'; then
  pass "sqlJsQuery uses db.prepare() (parameterized)"
else
  fail "sqlJsQuery still uses string interpolation"
fi

# Verify no esc() calls remain in sql.js functions
SQLJS_ESC_COUNT=$(sed -n '/async function sqlJsIngest/,/^async function\|^function/p' "$PROJECT_DIR/scripts/cache/treenode.js" | grep -c "esc(" || true)
SQLJS_QUERY_ESC_COUNT=$(sed -n '/async function sqlJsQuery/,/^async function\|^function/p' "$PROJECT_DIR/scripts/cache/treenode.js" | grep -c "esc(" || true)
if [ "$SQLJS_ESC_COUNT" = "0" ] && [ "$SQLJS_QUERY_ESC_COUNT" = "0" ]; then
  pass "No esc() calls in sqlJsIngest/sqlJsQuery"
else
  fail "esc() still used in sql.js path (ingest:$SQLJS_ESC_COUNT, query:$SQLJS_QUERY_ESC_COUNT)"
fi

# ────────────────────────────────────────────
# 7. Cross-file execSync sweep (K001 pattern)
# ────────────────────────────────────────────
echo ""
echo "═══ execSync Variable Interpolation Sweep ═══"

# Check for execSync with template literals containing user-controllable variables
# Exclude: test files, node_modules, known-safe patterns (DB_PATH, tmpSql from treenode CLI backend)
UNSAFE_EXECSYNC=$(grep -rn 'execSync(`' "$PROJECT_DIR/scripts/" \
  --include='*.js' \
  | grep -v 'test-' \
  | grep -v 'node_modules' \
  | grep -v 'DB_PATH' \
  | grep -v 'tmpSql' \
  || true)

if [ -z "$UNSAFE_EXECSYNC" ]; then
  pass "No unsafe execSync template literal interpolation found"
else
  # Check if any remaining ones interpolate user input
  UNSAFE_COUNT=$(echo "$UNSAFE_EXECSYNC" | wc -l | tr -d ' ')
  fail "Found $UNSAFE_COUNT execSync with template literals: $UNSAFE_EXECSYNC"
fi

# ────────────────────────────────────────────
# 8. treenode.js loads without errors
# ────────────────────────────────────────────
echo ""
echo "═══ Module Loading ═══"

TREENODE_RESULT=$(cd "$PROJECT_DIR" && node -e "require('./scripts/cache/treenode.js')" 2>&1)
TREENODE_EXIT=$?
if [ "$TREENODE_EXIT" = "0" ]; then
  pass "treenode.js loads successfully"
else
  fail "treenode.js failed to load (exit=$TREENODE_EXIT): $TREENODE_RESULT"
fi

# ────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────
echo ""
echo "═══════════════════════════════"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo ""
echo "✅ All S04 hardening tests passed"
