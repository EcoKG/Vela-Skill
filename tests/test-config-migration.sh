#!/usr/bin/env bash
# Integration tests for config.json shallow merge migration in install.js upgrade()
# Tests:
#   1. New template keys are added to user config
#   2. Existing user values are preserved (never overwritten)
#   3. Broken JSON is fully restored from template
#   4. Missing config.json (fresh install) → skipped, no error
#   5. Identical config to template → no changes
#   6. upgrade() JSON output contains configMigration field
#   7. Empty file → restored from template
#   8. User custom keys (not in template) are preserved

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_JS="$SCRIPT_DIR/scripts/install.js"
TEMPLATE_CONFIG="$SCRIPT_DIR/templates/config.json"
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

# Helper: create a fresh .vela/ dir and run initial upgrade to populate managed files
setup_vela() {
  TMPDIR_TEST="$(mktemp -d)"
  VELA_DIR="$TMPDIR_TEST/.vela"
  mkdir -p "$VELA_DIR"
  cd "$TMPDIR_TEST"
  # Initial upgrade to populate .vela/ with managed files (including templates/config.json)
  node "$INSTALL_JS" upgrade >/dev/null 2>&1 || true
}

echo "=== Config Migration Tests ==="
echo "  Install.js: $INSTALL_JS"
echo "  Template:   $TEMPLATE_CONFIG"

# --- Test 1: New keys added to user config ---
echo ""
echo "=== Test 1: New template keys added to user config ==="

setup_vela

# Create a user config with only some keys (missing 'cache', 'hooks', 'artifacts')
cat > "$VELA_DIR/config.json" << 'EOF'
{
  "version": "1.0",
  "engine": "vela",
  "sandbox": {
    "enabled": true,
    "strict_mode": false,
    "bash_policy": "blocked"
  }
}
EOF

# Run upgrade → should add missing keys
UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)

# Check that new keys were added
ADDED_KEYS=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const m = j.configMigration || j.details?.configMigration || {};
      console.log(JSON.stringify(m.added || []));
    } catch(e) { console.log('[]'); }
  });
")

# Verify keys from template that were missing are now added
HAS_CACHE=$(node -e "const c=require('$VELA_DIR/config.json'); console.log('cache' in c ? 'yes' : 'no')")
HAS_HOOKS=$(node -e "const c=require('$VELA_DIR/config.json'); console.log('hooks' in c ? 'yes' : 'no')")
HAS_ARTIFACTS=$(node -e "const c=require('$VELA_DIR/config.json'); console.log('artifacts' in c ? 'yes' : 'no')")
HAS_PIPELINE=$(node -e "const c=require('$VELA_DIR/config.json'); console.log('pipeline' in c ? 'yes' : 'no')")

[ "$HAS_CACHE" = "yes" ] && pass "cache key added" || fail "cache key missing"
[ "$HAS_HOOKS" = "yes" ] && pass "hooks key added" || fail "hooks key missing"
[ "$HAS_ARTIFACTS" = "yes" ] && pass "artifacts key added" || fail "artifacts key missing"
[ "$HAS_PIPELINE" = "yes" ] && pass "pipeline key added" || fail "pipeline key missing"

rm -rf "$TMPDIR_TEST"

# --- Test 2: Existing user values preserved ---
echo ""
echo "=== Test 2: Existing user values preserved ==="

setup_vela

# User has customized sandbox.strict_mode to false and version to "2.0"
cat > "$VELA_DIR/config.json" << 'EOF'
{
  "version": "2.0",
  "engine": "custom-engine",
  "sandbox": {
    "enabled": true,
    "strict_mode": false,
    "bash_policy": "allowed"
  },
  "pipeline": {
    "default": "fast",
    "auto_scale": false
  }
}
EOF

# Run upgrade
node "$INSTALL_JS" upgrade >/dev/null 2>&1 || true

# Verify user values are untouched
USER_VERSION=$(node -e "console.log(require('$VELA_DIR/config.json').version)")
USER_ENGINE=$(node -e "console.log(require('$VELA_DIR/config.json').engine)")
USER_STRICT=$(node -e "console.log(require('$VELA_DIR/config.json').sandbox.strict_mode)")
USER_PIPELINE=$(node -e "console.log(require('$VELA_DIR/config.json').pipeline.default)")

[ "$USER_VERSION" = "2.0" ] && pass "version preserved as '2.0'" || fail "version changed (got: $USER_VERSION)"
[ "$USER_ENGINE" = "custom-engine" ] && pass "engine preserved as 'custom-engine'" || fail "engine changed (got: $USER_ENGINE)"
[ "$USER_STRICT" = "false" ] && pass "sandbox.strict_mode preserved as false" || fail "sandbox.strict_mode changed (got: $USER_STRICT)"
[ "$USER_PIPELINE" = "fast" ] && pass "pipeline.default preserved as 'fast'" || fail "pipeline.default changed (got: $USER_PIPELINE)"

rm -rf "$TMPDIR_TEST"

# --- Test 3: Broken JSON → full restore from template ---
echo ""
echo "=== Test 3: Broken JSON → full restore from template ==="

setup_vela

# Write broken JSON
echo '{invalid json content' > "$VELA_DIR/config.json"

# Run upgrade
UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)

# Verify config is now valid JSON matching template structure
CONFIG_VALID=$(node -e "
  try {
    const c = require('$VELA_DIR/config.json');
    console.log(c.engine === 'vela' && c.sandbox && c.pipeline ? 'yes' : 'no');
  } catch(e) { console.log('no'); }
")

RESTORED=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const m = j.configMigration || j.details?.configMigration || {};
      console.log(m.restored === true ? 'yes' : 'no');
    } catch(e) { console.log('parse_error'); }
  });
")

[ "$CONFIG_VALID" = "yes" ] && pass "Broken config restored to valid template" || fail "Config still broken after upgrade"
[ "$RESTORED" = "yes" ] && pass "configMigration.restored = true" || fail "configMigration.restored not true (got: $RESTORED)"

rm -rf "$TMPDIR_TEST"

# --- Test 4: No config.json → skipped, no error ---
echo ""
echo "=== Test 4: No config.json → skipped ==="

setup_vela

# Remove config.json entirely
rm -f "$VELA_DIR/config.json"

# Run upgrade
UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)

SKIPPED=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const m = j.configMigration || j.details?.configMigration || {};
      console.log(m.skipped === true ? 'yes' : 'no');
    } catch(e) { console.log('parse_error'); }
  });
")

IS_OK=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try { const j=JSON.parse(d); console.log(j.ok === true ? 'yes' : 'no'); }
    catch(e) { console.log('parse_error'); }
  });
")

[ "$SKIPPED" = "yes" ] && pass "configMigration.skipped = true" || fail "configMigration.skipped not true (got: $SKIPPED)"
[ "$IS_OK" = "yes" ] && pass "upgrade still reports ok:true" || fail "upgrade reported failure (got: $IS_OK)"

rm -rf "$TMPDIR_TEST"

# --- Test 5: Config identical to template → no changes ---
echo ""
echo "=== Test 5: Config identical to template → no changes ==="

setup_vela

# Copy template as-is to user config
cp "$TEMPLATE_CONFIG" "$VELA_DIR/config.json"

# Save hash before upgrade
BEFORE_HASH=$(md5sum "$VELA_DIR/config.json" | awk '{print $1}')

# Run upgrade
UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)

# Hash should be unchanged
AFTER_HASH=$(md5sum "$VELA_DIR/config.json" | awk '{print $1}')

ADDED_COUNT=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const m = j.configMigration || j.details?.configMigration || {};
      console.log((m.added || []).length);
    } catch(e) { console.log(-1); }
  });
")

[ "$BEFORE_HASH" = "$AFTER_HASH" ] && pass "Config file unchanged" || fail "Config file was modified"
[ "$ADDED_COUNT" = "0" ] && pass "Zero keys added" || fail "Keys were added (count: $ADDED_COUNT)"

rm -rf "$TMPDIR_TEST"

# --- Test 6: upgrade JSON output has configMigration field ---
echo ""
echo "=== Test 6: configMigration field in upgrade output ==="

setup_vela

# Use a partial config to trigger migration
cat > "$VELA_DIR/config.json" << 'EOF'
{
  "version": "1.0",
  "engine": "vela"
}
EOF

UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)

HAS_FIELD=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      console.log(j.configMigration !== undefined ? 'yes' : 'no');
    } catch(e) { console.log('parse_error'); }
  });
")

HAS_ADDED=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const m = j.configMigration || {};
      console.log(Array.isArray(m.added) ? 'yes' : 'no');
    } catch(e) { console.log('parse_error'); }
  });
")

HAS_PRESERVED=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const m = j.configMigration || {};
      console.log(Array.isArray(m.preserved) ? 'yes' : 'no');
    } catch(e) { console.log('parse_error'); }
  });
")

[ "$HAS_FIELD" = "yes" ] && pass "configMigration field exists" || fail "configMigration field missing"
[ "$HAS_ADDED" = "yes" ] && pass "configMigration.added is array" || fail "configMigration.added not array"
[ "$HAS_PRESERVED" = "yes" ] && pass "configMigration.preserved is array" || fail "configMigration.preserved not array"

rm -rf "$TMPDIR_TEST"

# --- Test 7: Empty file → restored from template ---
echo ""
echo "=== Test 7: Empty file → restored from template ==="

setup_vela

# Write empty file
> "$VELA_DIR/config.json"

UPGRADE_OUT=$(node "$INSTALL_JS" upgrade 2>/dev/null || true)

CONFIG_VALID=$(node -e "
  try {
    const c = require('$VELA_DIR/config.json');
    console.log(c.engine === 'vela' ? 'yes' : 'no');
  } catch(e) { console.log('no'); }
")

RESTORED=$(echo "$UPGRADE_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const m = j.configMigration || j.details?.configMigration || {};
      console.log(m.restored === true ? 'yes' : 'no');
    } catch(e) { console.log('parse_error'); }
  });
")

[ "$CONFIG_VALID" = "yes" ] && pass "Empty config restored to valid template" || fail "Empty config not restored"
[ "$RESTORED" = "yes" ] && pass "configMigration.restored = true for empty file" || fail "configMigration.restored not true (got: $RESTORED)"

rm -rf "$TMPDIR_TEST"

# --- Test 8: User custom keys (not in template) are preserved ---
echo ""
echo "=== Test 8: User custom keys preserved ==="

setup_vela

# User config has all template keys PLUS custom keys
cat > "$VELA_DIR/config.json" << 'EOF'
{
  "version": "1.0",
  "engine": "vela",
  "sandbox": { "enabled": true, "strict_mode": true, "bash_policy": "blocked" },
  "pipeline": { "default": "standard", "auto_scale": true, "enforce_all_steps": true },
  "gate_keeper": { "enabled": true, "default_mode": "read", "mode_auto_detect": true },
  "gate_guard": { "enabled": true, "hard_block_exit_code": 2, "bypass_allowed": false },
  "cli": { "language": null, "tools_dir": ".vela/cli" },
  "cache": { "enabled": true, "db_path": ".vela/cache/vela-cache.db", "treenode_enabled": true },
  "hooks": { "use_vela_hooks": true, "claude_code_trigger": true },
  "artifacts": { "base_dir": ".vela/artifacts", "date_format": "YYYY-MM-DD", "cleanup_after_hours": 24 },
  "my_custom_plugin": { "enabled": true, "api_key": "user-secret" },
  "experimental_feature": "beta"
}
EOF

# Run upgrade
node "$INSTALL_JS" upgrade >/dev/null 2>&1 || true

# Verify custom keys still exist
HAS_CUSTOM=$(node -e "
  const c = require('$VELA_DIR/config.json');
  const ok = c.my_custom_plugin && c.my_custom_plugin.enabled === true && c.experimental_feature === 'beta';
  console.log(ok ? 'yes' : 'no');
")

[ "$HAS_CUSTOM" = "yes" ] && pass "Custom user keys preserved after migration" || fail "Custom user keys lost"

rm -rf "$TMPDIR_TEST"

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
