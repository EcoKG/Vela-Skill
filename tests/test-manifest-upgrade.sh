#!/usr/bin/env bash
# Integration tests for manifest-based orphan cleanup in install.js upgrade()
# Tests:
#   1. Orphan files in managed dirs are deleted on upgrade
#   2. Protected paths (config.json, state/, artifacts/) are untouched
#   3. Empty directories are cleaned up after orphan removal
#   4. validate() also detects and removes orphans (manifest-based, no hardcoded legacyFiles)
#   5. orphansRemoved appears in upgrade JSON output

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_JS="$SCRIPT_DIR/scripts/install.js"
PASS=0
FAIL=0
TOTAL=0

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  ❌ $1"; }

cleanup() {
  if [ -n "${TMPDIR_TEST:-}" ] && [ -d "$TMPDIR_TEST" ]; then
    rm -rf "$TMPDIR_TEST"
  fi
}
trap cleanup EXIT

# Create a temp project directory with .vela/ structure
TMPDIR_TEST="$(mktemp -d)"
VELA_DIR="$TMPDIR_TEST/.vela"
mkdir -p "$VELA_DIR"

echo "=== Test Setup ==="
echo "  Temp dir: $TMPDIR_TEST"
echo "  Install.js: $INSTALL_JS"

# --- Pre-populate .vela/ with managed files by running upgrade once ---
echo ""
echo "=== Initial upgrade to populate .vela/ ==="
cd "$TMPDIR_TEST"
UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)
INITIAL_COUNT=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try { const j=JSON.parse(d); console.log((j.updated||0)+(j.added||0)); }
    catch(e) { console.log(0); }
  });
")
echo "  Initial files installed: $INITIAL_COUNT"

if [ "$INITIAL_COUNT" -gt "0" ]; then
  pass "Initial upgrade populated .vela/"
else
  fail "Initial upgrade populated .vela/ (got $INITIAL_COUNT files)"
fi

# --- Test 1: Plant orphan files and verify they get deleted on upgrade ---
echo ""
echo "=== Test 1: Orphan files deleted on upgrade ==="

# Plant orphan files in managed directories
mkdir -p "$VELA_DIR/hooks" "$VELA_DIR/agents/old-agent" "$VELA_DIR/cli" "$VELA_DIR/references"
echo "obsolete" > "$VELA_DIR/hooks/obsolete-hook.js"
echo "old agent" > "$VELA_DIR/agents/old-agent/agent.md"
echo "old cli" > "$VELA_DIR/cli/old-command.js"
echo "old ref" > "$VELA_DIR/references/old-ref.md"

# Verify orphans exist
[ -f "$VELA_DIR/hooks/obsolete-hook.js" ] && pass "Orphan hooks/obsolete-hook.js planted" || fail "Failed to plant orphan"
[ -f "$VELA_DIR/agents/old-agent/agent.md" ] && pass "Orphan agents/old-agent/agent.md planted" || fail "Failed to plant orphan"

# Run upgrade
cd "$TMPDIR_TEST"
UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)

# Verify orphans are deleted
[ ! -f "$VELA_DIR/hooks/obsolete-hook.js" ] && pass "hooks/obsolete-hook.js removed" || fail "hooks/obsolete-hook.js still exists"
[ ! -f "$VELA_DIR/agents/old-agent/agent.md" ] && pass "agents/old-agent/agent.md removed" || fail "agents/old-agent/agent.md still exists"
[ ! -f "$VELA_DIR/cli/old-command.js" ] && pass "cli/old-command.js removed" || fail "cli/old-command.js still exists"
[ ! -f "$VELA_DIR/references/old-ref.md" ] && pass "references/old-ref.md removed" || fail "references/old-ref.md still exists"

# --- Test 2: Protected paths untouched ---
echo ""
echo "=== Test 2: Protected paths untouched ==="

# Plant files in protected areas
mkdir -p "$VELA_DIR/state" "$VELA_DIR/artifacts" "$VELA_DIR/templates"
echo "user state" > "$VELA_DIR/state/user-data.json"
echo "user artifact" > "$VELA_DIR/artifacts/pipeline-001.json"
echo "root config" > "$VELA_DIR/config.json"

# Run upgrade again
cd "$TMPDIR_TEST"
node "$INSTALL_JS" upgrade >/dev/null 2>&1 || true

# Verify protected paths survive
[ -f "$VELA_DIR/state/user-data.json" ] && pass "state/user-data.json preserved" || fail "state/user-data.json was deleted"
[ -f "$VELA_DIR/artifacts/pipeline-001.json" ] && pass "artifacts/pipeline-001.json preserved" || fail "artifacts/pipeline-001.json was deleted"
[ -f "$VELA_DIR/config.json" ] && pass "config.json preserved" || fail "config.json was deleted"

# --- Test 3: Empty directories cleaned up ---
echo ""
echo "=== Test 3: Empty directories cleaned after orphan removal ==="

# Create an orphan in a nested dir — after removal the parent dir should be cleaned
mkdir -p "$VELA_DIR/agents/defunct-agent"
echo "gone" > "$VELA_DIR/agents/defunct-agent/readme.md"

cd "$TMPDIR_TEST"
node "$INSTALL_JS" upgrade >/dev/null 2>&1 || true

[ ! -d "$VELA_DIR/agents/defunct-agent" ] && pass "agents/defunct-agent/ empty dir removed" || fail "agents/defunct-agent/ dir still exists"

# --- Test 4: orphansRemoved in JSON output ---
echo ""
echo "=== Test 4: orphansRemoved in upgrade JSON output ==="

# Plant another orphan to get non-zero count
echo "orphan" > "$VELA_DIR/hooks/will-be-removed.js"

cd "$TMPDIR_TEST"
UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)

# Check orphansRemoved field exists in JSON
HAS_ORPHANS=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      if (j.orphansRemoved !== undefined && j.details && j.details.orphansRemoved) {
        console.log('yes');
      } else {
        console.log('no');
      }
    } catch(e) { console.log('parse_error'); }
  });
")

[ "$HAS_ORPHANS" = "yes" ] && pass "orphansRemoved field in JSON output" || fail "orphansRemoved field missing (got: $HAS_ORPHANS)"

# --- Test 5: validate() uses manifest-based orphan detection ---
echo ""
echo "=== Test 5: validate() removes orphans (manifest-based) ==="

# Plant a legacy file that was previously hardcoded (hooks/vela-pm.md)
echo "legacy" > "$VELA_DIR/hooks/vela-pm.md"
# Also plant a new orphan
echo "another orphan" > "$VELA_DIR/cli/phantom.js"

cd "$TMPDIR_TEST"
VALIDATE_OUT=$(node "$INSTALL_JS" validate 2>/dev/null || true)

[ ! -f "$VELA_DIR/hooks/vela-pm.md" ] && pass "validate() removed hooks/vela-pm.md via manifest" || fail "validate() did not remove hooks/vela-pm.md"
[ ! -f "$VELA_DIR/cli/phantom.js" ] && pass "validate() removed cli/phantom.js via manifest" || fail "validate() did not remove cli/phantom.js"

# --- Summary ---
echo ""
echo "=== Results ==="
echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "  OVERALL: FAIL"
  exit 1
else
  echo "  OVERALL: PASS"
  exit 0
fi
