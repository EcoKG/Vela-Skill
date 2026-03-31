#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-permission-hook.sh — vela-permission.js 계약 테스트
#
# K004: stdin JSON → hook logic → stdout + exit code
#
# Test 1:  auto+execute+delegation+Write → behavior:allow
# Test 2:  auto+execute+delegation+Edit → behavior:allow
# Test 3:  auto+execute+delegation+NotebookEdit → behavior:allow
# Test 4:  auto=false → silent pass (empty stdout, exit 0)
# Test 5:  no delegation.json → silent pass
# Test 6:  plan step (not execute) → silent pass
# Test 7:  Bash tool (not in WRITE_TOOLS) → silent pass
# Test 8:  missing tool_name → silent pass
# Test 9:  no config.json → silent pass
# Test 10: no pipeline → silent pass
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../hooks/vela-permission.js"

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/artifacts"
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

create_config() {
  cat > "$PROJECT/.vela/config.json" <<'CFG'
{ "persona": "pm", "model": "sonnet" }
CFG
}

# Create an active pipeline with auto mode
# Args: $1=current_step (default: execute), $2=auto (default: true)
create_pipeline() {
  local step="${1:-execute}"
  local auto="${2:-true}"
  local date_dir
  date_dir="$(date +%Y-%m-%d)_001_test"
  ARTIFACT_DIR="$PROJECT/.vela/artifacts/$date_dir"
  mkdir -p "$ARTIFACT_DIR"

  cat > "$ARTIFACT_DIR/pipeline-state.json" <<EOF
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "$step",
  "current_step_index": 2,
  "completed_steps": ["init", "plan"],
  "total_steps": 5,
  "request": "test request",
  "auto": $auto
}
EOF
}

create_delegation() {
  mkdir -p "$PROJECT/.vela/state"
  # Generate HMAC key and sign delegation.json
  node -e "
    const hmac = require('$SCRIPT_DIR/../hooks/shared/hmac');
    const fs = require('fs');
    const path = require('path');
    const keyHex = hmac.generateKey();
    fs.writeFileSync(path.join('$PROJECT', '.vela', 'state', 'hmac-key'), keyHex);
    const obj = { active: true, step: 'execute', started_at: Date.now() };
    obj._hmac = hmac.signJSON(obj, keyHex);
    fs.writeFileSync(path.join('$PROJECT', '.vela', 'state', 'delegation.json'), JSON.stringify(obj, null, 2));
  "
}

run_hook() {
  local stdin_json="$1"
  echo "$stdin_json" | node "$HOOK" 2>/dev/null || true
}

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

assert_empty() {
  local label="$1"
  local actual="$2"

  TOTAL=$((TOTAL + 1))
  if [ -z "$actual" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected empty, got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

# ── main ─────────────────────────────────────────────────────

trap teardown_sandbox EXIT

echo "⛵ PermissionRequest Hook 계약 테스트"
echo "─────────────────────────────────────"

# ── Test 1: auto+execute+delegation+Write → allow ──
echo ""
echo "📋 Test 1: auto+execute+delegation+Write → behavior:allow"
setup_sandbox
create_config
create_pipeline "execute" "true"
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Write"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_contains "stdout has behavior:allow" '"behavior"' "$output"
assert_contains "stdout has allow value" '"allow"' "$output"
assert_contains "stdout has PermissionRequest event" 'PermissionRequest' "$output"
teardown_sandbox

# ── Test 2: auto+execute+delegation+Edit → allow ──
echo ""
echo "📋 Test 2: auto+execute+delegation+Edit → behavior:allow"
setup_sandbox
create_config
create_pipeline "execute" "true"
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Edit"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_contains "stdout has behavior:allow" '"allow"' "$output"
assert_contains "stdout has PermissionRequest event" 'PermissionRequest' "$output"
teardown_sandbox

# ── Test 3: auto+execute+delegation+NotebookEdit → allow ──
echo ""
echo "📋 Test 3: auto+execute+delegation+NotebookEdit → behavior:allow"
setup_sandbox
create_config
create_pipeline "execute" "true"
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"NotebookEdit"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_contains "stdout has behavior:allow" '"allow"' "$output"
assert_contains "stdout has PermissionRequest event" 'PermissionRequest' "$output"
teardown_sandbox

# ── Test 4: auto=false → silent pass ──
echo ""
echo "📋 Test 4: auto=false → empty stdout, exit 0"
setup_sandbox
create_config
create_pipeline "execute" "false"
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Write"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (auto=false)" "$output"
teardown_sandbox

# ── Test 5: no delegation.json → silent pass ──
echo ""
echo "📋 Test 5: no delegation.json → empty stdout, exit 0"
setup_sandbox
create_config
create_pipeline "execute" "true"
# No delegation created

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Write"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (no delegation)" "$output"
teardown_sandbox

# ── Test 6: plan step (not execute) → silent pass ──
echo ""
echo "📋 Test 6: plan step → empty stdout, exit 0"
setup_sandbox
create_config
create_pipeline "plan" "true"
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Write"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (wrong step)" "$output"
teardown_sandbox

# ── Test 7: Bash tool (not in WRITE_TOOLS) → silent pass ──
echo ""
echo "📋 Test 7: Bash tool → empty stdout, exit 0"
setup_sandbox
create_config
create_pipeline "execute" "true"
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Bash"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (Bash not in WRITE_TOOLS)" "$output"
teardown_sandbox

# ── Test 8: missing tool_name field → silent pass (malformed) ──
echo ""
echo "📋 Test 8: missing tool_name → empty stdout, exit 0"
setup_sandbox
create_config
create_pipeline "execute" "true"
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (no tool_name)" "$output"
teardown_sandbox

# ── Test 9: no config.json → silent pass (early exit) ──
echo ""
echo "📋 Test 9: no config.json → empty stdout, exit 0"
setup_sandbox
# No config created
create_pipeline "execute" "true"
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Write"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (no config)" "$output"
teardown_sandbox

# ── Test 10: no pipeline → silent pass (early exit) ──
echo ""
echo "📋 Test 10: no pipeline → empty stdout, exit 0"
setup_sandbox
create_config
# No pipeline created
create_delegation

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Write"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (no pipeline)" "$output"
teardown_sandbox

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
