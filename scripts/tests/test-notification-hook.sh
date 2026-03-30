#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-notification-hook.sh — vela-notification.js 계약 테스트
#
# K004: stdin JSON → hook logic → stdout + exit code
#
# Test 1: idle_prompt notification → exit 0
# Test 2: permission_prompt notification → exit 0
# Test 3: empty stdin → exit 0 (graceful)
# Test 4: malformed JSON → exit 0 (graceful)
# Test 5: missing message/title fields → exit 0 (defaults used)
# Test 6: install.js verify에서 vela-notification이 OK
# Test 7: settings.local.json에 vela-permission의 if 필드 존재
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../hooks/vela-notification.js"
INSTALL_JS="$SCRIPT_DIR/../install.js"

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

echo "⛵ Notification Hook 계약 테스트"
echo "═══════════════════════════════════════"

# ══════════════════════════════════════
# vela-notification.js — 직접 실행 테스트
# ══════════════════════════════════════

# ── Test 1: idle_prompt notification → exit 0 ──
echo ""
echo "📋 Test 1: idle_prompt notification → exit 0"
STDIN_JSON='{"title":"Idle","message":"Claude is idle","notification_type":"idle_prompt"}'
output=$(echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || true)
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (notification hook produces no stdout)" "$output"

# ── Test 2: permission_prompt notification → exit 0 ──
echo ""
echo "📋 Test 2: permission_prompt notification → exit 0"
STDIN_JSON='{"title":"Permission needed","message":"Claude needs permission to use Bash","notification_type":"permission_prompt"}'
output=$(echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || true)
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty" "$output"

# ── Test 3: empty stdin → exit 0 (graceful) ──
echo ""
echo "📋 Test 3: empty stdin → exit 0 (graceful)"
output=$(echo "" | node "$HOOK" 2>/dev/null || true)
exit_code=0
echo "" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty" "$output"

# ── Test 4: malformed JSON → exit 0 (graceful) ──
echo ""
echo "📋 Test 4: malformed JSON → exit 0 (graceful)"
output=$(echo "not valid json {{{{" | node "$HOOK" 2>/dev/null || true)
exit_code=0
echo "not valid json {{{{" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty" "$output"

# ── Test 5: missing message/title fields → exit 0 (defaults used) ──
echo ""
echo "📋 Test 5: missing message/title fields → exit 0 (defaults used)"
output=$(echo '{}' | node "$HOOK" 2>/dev/null || true)
exit_code=0
echo '{}' | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty" "$output"

# ══════════════════════════════════════
# install.js 통합 테스트
# ══════════════════════════════════════

# ── Test 6: install.js verify에서 vela-notification이 OK ──
echo ""
echo "📋 Test 6: install.js verify에서 vela-notification이 OK"

# Run install first to ensure settings.local.json is populated
install_output=$(node "$INSTALL_JS" install 2>/dev/null || true)

# Then verify
verify_output=$(node "$INSTALL_JS" verify 2>/dev/null || true)
exit_code=0
node "$INSTALL_JS" verify 2>/dev/null || exit_code=$?

assert_eq "verify exit code is 0" "0" "$exit_code"

# Check that vela-notification appears with status OK in verify output
notif_status=$(echo "$verify_output" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const hook = (data.hooks || []).find(h => h.id === 'vela-notification');
  console.log(hook ? hook.status : 'NOT_FOUND');
" 2>/dev/null || echo "PARSE_ERROR")

assert_eq "vela-notification status is OK" "OK" "$notif_status"

# ── Test 7: settings.local.json에 vela-permission의 if 필드가 존재 ──
echo ""
echo "📋 Test 7: settings.local.json에 vela-permission의 if 필드가 존재"

# Find project root the same way install.js does — walk up from CWD looking for .vela/
PROJECT_ROOT="$(node -e "
  const fs = require('fs'), path = require('path');
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.vela'))) { console.log(dir); process.exit(0); }
    dir = path.dirname(dir);
  }
  console.log(process.cwd());
" 2>/dev/null)"
SETTINGS_FILE="$PROJECT_ROOT/.claude/settings.local.json"

if [ -f "$SETTINGS_FILE" ]; then
  # Check that PermissionRequest hooks contain an entry with if field for vela-permission
  if_field_found=$(node -e "
    const settings = JSON.parse(require('fs').readFileSync('$SETTINGS_FILE','utf8'));
    const permHooks = settings.hooks?.PermissionRequest || [];
    const hasIf = permHooks.some(entry =>
      entry.hooks && entry.hooks.some(h =>
        h.command && h.command.includes('vela-permission') && h.if
      )
    );
    console.log(hasIf ? 'true' : 'false');
  " 2>/dev/null || echo "PARSE_ERROR")

  assert_eq "vela-permission has if field in settings" "true" "$if_field_found"
else
  TOTAL=$((TOTAL + 1))
  echo "  ❌ FAIL: settings.local.json not found at $SETTINGS_FILE"
  FAIL=$((FAIL + 1))
fi

# ── Results ──
echo ""
echo "═══════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
