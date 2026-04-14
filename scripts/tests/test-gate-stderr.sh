#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-gate-stderr.sh — structured stderr on gate blocks
#
# Verifies the v7.2 "harness engineering" change: when the gate
# hooks block a tool call with `exit 2`, they also write a
# machine-readable `[VK-XX] 사유 — 복구: …` line to stderr so
# Claude Code can read the block code and recovery hint.
#
# Covered:
#   VK-01  read mode write-bash     → stderr contains [VK-01]
#   VK-02  write mode bash          → stderr contains [VK-02]
#   VK-04  read mode Write/Edit     → stderr contains [VK-04]
#   VK-08  chain operator           → stderr contains [VK-08]
#   VG-03  corrupt tracker-signals  → stderr contains [VG-03]
#   VG-13  pipeline.json tamper     → stderr EMPTY (silent hard-block)
#   VG-14  secret in Write content  → stderr EMPTY (silent hard-block)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE_KEEPER="$SCRIPT_DIR/../hooks/vela-gate-keeper.js"
GATE_GUARD="$SCRIPT_DIR/../hooks/vela-gate-guard.js"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""

setup_sandbox() {
  local mode="${1:-read}"
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state" "$PROJECT/.vela/templates"

  cat > "$PROJECT/.vela/config.json" <<'EOF'
{ "sandbox": { "enabled": true }, "project_name": "test-stderr" }
EOF

  local AD="$PROJECT/.vela/artifacts/20260101T000000-test"
  mkdir -p "$AD"
  cat > "$AD/pipeline-state.json" <<EOF
{ "status": "active", "pipeline_type": "standard", "current_step": "step1" }
EOF

  cat > "$PROJECT/.vela/templates/pipeline.json" <<EOF
{ "pipelines": { "standard": { "steps": [ { "id": "step1", "mode": "$mode" } ] } } }
EOF
}

teardown() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

# run_hook <hook.js> <tool_name> <tool_input_json> → captures stderr to $STDERR_OUT, returns exit code
run_hook() {
  local hook="$1" tool="$2" input="$3"
  local req
  req=$(cat <<ENDJSON
{ "tool_name": "$tool", "tool_input": $input, "session_id": "t", "cwd": "$PROJECT" }
ENDJSON
  )
  STDERR_OUT=$(echo "$req" | node "$hook" 2>&1 >/dev/null) || return $?
  return 0
}

assert_stderr_contains() {
  local label="$1" expected_code="$2" hook="$3" tool="$4" input="$5" expected_exit="$6"
  TOTAL=$((TOTAL + 1))
  local actual_exit=0
  run_hook "$hook" "$tool" "$input" || actual_exit=$?

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "  ❌ FAIL: $label — expected exit $expected_exit, got $actual_exit"
    FAIL=$((FAIL + 1))
    return
  fi
  if echo "$STDERR_OUT" | grep -qF "$expected_code"; then
    echo "  ✅ PASS: $label (stderr has $expected_code, exit $actual_exit)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected stderr to contain '$expected_code'"
    echo "      stderr: $STDERR_OUT"
    FAIL=$((FAIL + 1))
  fi
}

assert_stderr_empty() {
  local label="$1" hook="$2" tool="$3" input="$4"
  TOTAL=$((TOTAL + 1))
  local actual_exit=0
  run_hook "$hook" "$tool" "$input" || actual_exit=$?

  if [ "$actual_exit" -ne 2 ]; then
    echo "  ❌ FAIL: $label — expected exit 2, got $actual_exit"
    FAIL=$((FAIL + 1))
    return
  fi
  if [ -z "$STDERR_OUT" ]; then
    echo "  ✅ PASS: $label (silent hard-block, exit 2)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected empty stderr for silent hard-block"
    echo "      stderr: $STDERR_OUT"
    FAIL=$((FAIL + 1))
  fi
}

# ─── Gate Keeper: educational stderr ─────────────────────────

echo "⛵ Gate Keeper — structured stderr"
echo "─────────────────────────────────────"

setup_sandbox "read"
assert_stderr_contains "VK-01 read mode rm" "[VK-01]" \
  "$GATE_KEEPER" "Bash" '{"command":"rm file"}' 2
assert_stderr_contains "VK-04 read mode Write" "[VK-04]" \
  "$GATE_KEEPER" "Write" '{"file_path":"foo.js","content":"x"}' 2
assert_stderr_contains "VK-08 chain operator" "[VK-08]" \
  "$GATE_KEEPER" "Bash" '{"command":"ls && pwd"}' 2
teardown

setup_sandbox "write"
assert_stderr_contains "VK-02 write mode bash" "[VK-02]" \
  "$GATE_KEEPER" "Bash" '{"command":"ls"}' 2
teardown

echo ""

# ─── Gate Guard: structured vs silent ─────────────────────────

echo "⛵ Gate Guard — structured (VG-03) vs silent (VG-13/14)"
echo "─────────────────────────────────────"

setup_sandbox "readwrite"
# Corrupt tracker-signals.json → VG-03 stderr
echo "not json" > "$PROJECT/.vela/tracker-signals.json"
assert_stderr_contains "VG-03 corrupt signals + git commit" "[VG-03]" \
  "$GATE_GUARD" "Bash" '{"command":"git commit -m x"}' 2
teardown

setup_sandbox "readwrite"
# Write to .vela/templates/pipeline.json → silent hard-block
PIPE_PATH="$PROJECT/.vela/templates/pipeline.json"
assert_stderr_empty "VG-13 pipeline.json tamper (silent)" \
  "$GATE_GUARD" "Write" "{\"file_path\":\"$PIPE_PATH\",\"content\":\"x\"}"
teardown

setup_sandbox "readwrite"
# Write with AWS access key → silent hard-block
assert_stderr_empty "VG-14 secret in Write (silent)" \
  "$GATE_GUARD" "Write" '{"file_path":"leak.txt","content":"AKIAIOSFODNN7EXAMPLE"}'
teardown

echo ""
echo "─────────────────────────────────────"
echo "Total: $TOTAL | Pass: $PASS | Fail: $FAIL"
[ "$FAIL" -eq 0 ]
