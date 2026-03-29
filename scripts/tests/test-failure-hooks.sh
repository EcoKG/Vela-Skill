#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-failure-hooks.sh — 실패/복구 hooks 계약 테스트
#
# K004: stdin JSON → hook logic → stdout + exit code + filesystem side effects
#
# PostToolUseFailure (vela-failure.js):
#   Test 1: Active pipeline + tool failure → trace.jsonl entry + counter incremented
#   Test 2: No active pipeline → exit 0, no side effects
#   Test 3: Three consecutive failures → additionalContext warning + counter resets
#   Test 4: is_interrupt=true → counter resets to 0
#   Test 5: No config.json → exit 0 silent
#
# StopFailure (vela-stop-failure.js):
#   Test 6: Active pipeline + error → stop-failure snapshot written
#   Test 7: Snapshot contains pipeline state fields
#   Test 8: No active pipeline → exit 0, no snapshot
#   Test 9: stdout is empty (StopFailure output fully ignored)
#
# TeammateIdle (vela-teammate-idle.js):
#   Test 10: Active pipeline + teammate_name → stdout contains systemMessage
#   Test 11: No active pipeline → exit 0, stdout empty
#   Test 12: trace.jsonl entry with action:'teammate_idle'
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_FAILURE="$SCRIPT_DIR/../hooks/vela-failure.js"
HOOK_STOP_FAILURE="$SCRIPT_DIR/../hooks/vela-stop-failure.js"
HOOK_TEAMMATE_IDLE="$SCRIPT_DIR/../hooks/vela-teammate-idle.js"

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/artifacts"

  # Minimal config.json required by readConfig()
  cat > "$PROJECT/.vela/config.json" <<'CFG'
{ "persona": "pm", "model": "sonnet" }
CFG
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

# Create an active pipeline-state.json
# Args: $1=status (default: active)
create_pipeline() {
  local status="${1:-active}"
  local date_dir
  date_dir="$(date +%Y-%m-%d)_001_test"
  ARTIFACT_DIR="$PROJECT/.vela/artifacts/$date_dir"
  mkdir -p "$ARTIFACT_DIR"

  cat > "$ARTIFACT_DIR/pipeline-state.json" <<EOF
{
  "status": "$status",
  "pipeline_type": "standard",
  "current_step": "execute",
  "current_step_index": 2,
  "completed_steps": ["init", "plan"],
  "total_steps": 5,
  "request": "test request"
}
EOF
}

run_hook() {
  local hook="$1"
  local stdin_json="$2"
  echo "$stdin_json" | node "$hook" 2>/dev/null || true
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

assert_file_exists() {
  local label="$1"
  local filepath="$2"

  TOTAL=$((TOTAL + 1))
  if [ -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — file not found: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_not_exists() {
  local label="$1"
  local filepath="$2"

  TOTAL=$((TOTAL + 1))
  if [ ! -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — file should NOT exist: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_contains() {
  local label="$1"
  local needle="$2"
  local filepath="$3"

  TOTAL=$((TOTAL + 1))
  if [ -f "$filepath" ] && grep -q "$needle" "$filepath"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — '$needle' not found in $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_no_files_matching() {
  local label="$1"
  local pattern="$2"
  local dir="$3"

  TOTAL=$((TOTAL + 1))
  local count
  count=$(find "$dir" -name "$pattern" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" = "0" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — found $count files matching '$pattern' in $dir"
    FAIL=$((FAIL + 1))
  fi
}

# ── main ─────────────────────────────────────────────────────

trap teardown_sandbox EXIT

echo "⛵ Failure/Recovery Hooks 계약 테스트"
echo "═══════════════════════════════════════"

# ══════════════════════════════════════
# PostToolUseFailure (vela-failure.js)
# ══════════════════════════════════════
echo ""
echo "── PostToolUseFailure (vela-failure.js) ──"

# ── Test 1: Active pipeline + tool failure → trace + counter ──
echo ""
echo "📋 Test 1: Active pipeline + tool failure → trace.jsonl entry + counter incremented"
setup_sandbox
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Bash","error":"command not found"}'
output=$(run_hook "$HOOK_FAILURE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_FAILURE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_file_exists "trace.jsonl created" "$ARTIFACT_DIR/trace.jsonl"
assert_file_contains "trace has tool_failure action" "tool_failure" "$ARTIFACT_DIR/trace.jsonl"
assert_file_contains "trace has tool name" "Bash" "$ARTIFACT_DIR/trace.jsonl"

COUNTER_FILE="$PROJECT/.vela/state/failure-counter.json"
assert_file_exists "failure-counter.json created" "$COUNTER_FILE"
assert_file_contains "counter has count" '"count"' "$COUNTER_FILE"
teardown_sandbox

# ── Test 2: No active pipeline → exit 0, no side effects ──
echo ""
echo "📋 Test 2: No active pipeline → exit 0, no side effects"
setup_sandbox
# config exists but no pipeline

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Bash","error":"fail"}'
output=$(run_hook "$HOOK_FAILURE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_FAILURE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty" "$output"
assert_file_not_exists "no failure-counter.json" "$PROJECT/.vela/state/failure-counter.json"
teardown_sandbox

# ── Test 3: Three consecutive failures → additionalContext warning + counter resets ──
echo ""
echo "📋 Test 3: Three consecutive failures → warning + counter resets"
setup_sandbox
create_pipeline "active"

# Pre-seed counter at 2 so next failure hits threshold of 3
mkdir -p "$PROJECT/.vela/state"
cat > "$PROJECT/.vela/state/failure-counter.json" <<'CTR'
{ "count": 2, "last_tool": "Read", "last_timestamp": 0 }
CTR

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Bash","error":"third failure"}'
# Run hook only once — double-run would re-increment counter after reset
output=$(run_hook "$HOOK_FAILURE" "$STDIN_JSON")

assert_contains "stdout has additionalContext" "additionalContext" "$output"
assert_contains "warning message present" "연속 도구 실패" "$output"

# After threshold warning, counter should reset to 0
COUNTER_FILE="$PROJECT/.vela/state/failure-counter.json"
assert_file_contains "counter reset to 0" '"count": 0' "$COUNTER_FILE"
teardown_sandbox

# ── Test 4: is_interrupt=true → counter resets to 0 ──
echo ""
echo "📋 Test 4: is_interrupt=true → counter resets to 0"
setup_sandbox
create_pipeline "active"

# Pre-seed counter at 2
mkdir -p "$PROJECT/.vela/state"
cat > "$PROJECT/.vela/state/failure-counter.json" <<'CTR'
{ "count": 2, "last_tool": "Read", "last_timestamp": 0 }
CTR

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Bash","error":"interrupted","is_interrupt":true}'
output=$(run_hook "$HOOK_FAILURE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_FAILURE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (interrupt doesn't warn)" "$output"

COUNTER_FILE="$PROJECT/.vela/state/failure-counter.json"
assert_file_contains "counter reset to 0" '"count": 0' "$COUNTER_FILE"
assert_file_contains "last_tool is null" '"last_tool": null' "$COUNTER_FILE"
teardown_sandbox

# ── Test 5: No config.json → exit 0 silent ──
echo ""
echo "📋 Test 5: No config.json → exit 0 silent"
TMPDIR_ROOT="$(mktemp -d)"
PROJECT="$TMPDIR_ROOT/project"
mkdir -p "$PROJECT/.vela/artifacts"
# No config.json

STDIN_JSON='{"cwd":"'"$PROJECT"'","tool_name":"Bash","error":"fail"}'
output=$(run_hook "$HOOK_FAILURE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_FAILURE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (no config)" "$output"
rm -rf "$TMPDIR_ROOT" 2>/dev/null || true

# ══════════════════════════════════════
# StopFailure (vela-stop-failure.js)
# ══════════════════════════════════════
echo ""
echo "── StopFailure (vela-stop-failure.js) ──"

# ── Test 6: Active pipeline + error → stop-failure snapshot ──
echo ""
echo "📋 Test 6: Active pipeline + rate_limit error → stop-failure snapshot"
setup_sandbox
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","error":"rate_limit","error_details":"429 Too Many Requests","last_assistant_message":"working on task"}'
output=$(run_hook "$HOOK_STOP_FAILURE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_STOP_FAILURE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"

# Check snapshot file exists (pattern: stop-failure-{timestamp}.json)
snapshot_count=$(find "$ARTIFACT_DIR" -name 'stop-failure-*.json' 2>/dev/null | wc -l | tr -d ' ')
TOTAL=$((TOTAL + 1))
if [ "$snapshot_count" -ge 1 ]; then
  echo "  ✅ PASS: stop-failure snapshot file created"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: stop-failure snapshot file not found in $ARTIFACT_DIR"
  FAIL=$((FAIL + 1))
fi
teardown_sandbox

# ── Test 7: Snapshot contains pipeline state fields ──
echo ""
echo "📋 Test 7: Snapshot contains pipeline state fields"
setup_sandbox
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","error":"server_error","error_details":"500 Internal Server Error"}'
output=$(run_hook "$HOOK_STOP_FAILURE" "$STDIN_JSON")

# Find the snapshot file
SNAPSHOT_FILE=$(find "$ARTIFACT_DIR" -name 'stop-failure-*.json' 2>/dev/null | head -1)
if [ -n "$SNAPSHOT_FILE" ]; then
  assert_file_contains "snapshot has error" '"error": "server_error"' "$SNAPSHOT_FILE"
  assert_file_contains "snapshot has current_step" '"current_step": "execute"' "$SNAPSHOT_FILE"
  assert_file_contains "snapshot has status" '"status": "active"' "$SNAPSHOT_FILE"
  assert_file_contains "snapshot has pipeline_snapshot" 'pipeline_snapshot' "$SNAPSHOT_FILE"
else
  TOTAL=$((TOTAL + 4))
  echo "  ❌ FAIL: snapshot has error — no snapshot file found"
  echo "  ❌ FAIL: snapshot has current_step — no snapshot file found"
  echo "  ❌ FAIL: snapshot has status — no snapshot file found"
  echo "  ❌ FAIL: snapshot has pipeline_snapshot — no snapshot file found"
  FAIL=$((FAIL + 4))
fi
teardown_sandbox

# ── Test 8: No active pipeline → exit 0, no snapshot ──
echo ""
echo "📋 Test 8: No active pipeline → exit 0, no snapshot"
setup_sandbox
# config exists but no pipeline

STDIN_JSON='{"cwd":"'"$PROJECT"'","error":"rate_limit"}'
output=$(run_hook "$HOOK_STOP_FAILURE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_STOP_FAILURE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_no_files_matching "no stop-failure snapshot" "stop-failure-*.json" "$PROJECT/.vela/artifacts"
teardown_sandbox

# ── Test 9: stdout is empty (StopFailure output fully ignored) ──
echo ""
echo "📋 Test 9: stdout is empty (StopFailure output fully ignored by Claude Code)"
setup_sandbox
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","error":"rate_limit","error_details":"429"}'
output=$(run_hook "$HOOK_STOP_FAILURE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_STOP_FAILURE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty" "$output"
teardown_sandbox

# ══════════════════════════════════════
# TeammateIdle (vela-teammate-idle.js)
# ══════════════════════════════════════
echo ""
echo "── TeammateIdle (vela-teammate-idle.js) ──"

# ── Test 10: Active pipeline + teammate_name → systemMessage ──
echo ""
echo "📋 Test 10: Active pipeline + teammate_name → stdout contains systemMessage"
setup_sandbox
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","teammate_name":"worker-1","team_name":"dev-team"}'
output=$(run_hook "$HOOK_TEAMMATE_IDLE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_TEAMMATE_IDLE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_contains "stdout has systemMessage" "systemMessage" "$output"
assert_contains "message mentions teammate name" "worker-1" "$output"
assert_contains "message has Vela prefix" "Vela" "$output"
teardown_sandbox

# ── Test 11: No active pipeline → exit 0, stdout empty ──
echo ""
echo "📋 Test 11: No active pipeline → exit 0, stdout empty"
setup_sandbox
# config exists but no pipeline

STDIN_JSON='{"cwd":"'"$PROJECT"'","teammate_name":"worker-1"}'
output=$(run_hook "$HOOK_TEAMMATE_IDLE" "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK_TEAMMATE_IDLE" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (no pipeline)" "$output"
teardown_sandbox

# ── Test 12: trace.jsonl entry with action:'teammate_idle' ──
echo ""
echo "📋 Test 12: trace.jsonl entry with action:'teammate_idle'"
setup_sandbox
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","teammate_name":"scout-1","team_name":"alpha"}'
output=$(run_hook "$HOOK_TEAMMATE_IDLE" "$STDIN_JSON")

assert_file_exists "trace.jsonl created" "$ARTIFACT_DIR/trace.jsonl"
assert_file_contains "trace has teammate_idle action" "teammate_idle" "$ARTIFACT_DIR/trace.jsonl"
assert_file_contains "trace has teammate name" "scout-1" "$ARTIFACT_DIR/trace.jsonl"
assert_file_contains "trace has team name" "alpha" "$ARTIFACT_DIR/trace.jsonl"
teardown_sandbox

# ── Results ──
echo ""
echo "═══════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
