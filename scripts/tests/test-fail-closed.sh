#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-fail-closed.sh — Fail-closed error handling verification
#
# Verifies that gate-keeper and gate-guard exit(2) on:
#   - Corrupt stdin (not JSON)
#   - Empty stdin
#   - (gate-guard) Corrupt signals file during git commit
#
# Also verifies normal operation still works (exit 0 pass-through)
# when sandbox / gate_guard is disabled.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE_KEEPER="$SCRIPT_DIR/../hooks/vela-gate.js"  # v7.3-M4c: keeper + guard merged
GATE_GUARD="$SCRIPT_DIR/../hooks/vela-gate.js"   # same unified hook

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

assert_exit() {
  local label="$1"
  local expected="$2"
  local hook="$3"
  local stdin_data="$4"

  TOTAL=$((TOTAL + 1))
  local actual=0
  echo "$stdin_data" | node "$hook" 2>/dev/null || actual=$?

  if [ "$actual" -eq "$expected" ]; then
    echo "  ✅ PASS: $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected exit $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit_no_stdin() {
  local label="$1"
  local expected="$2"
  local hook="$3"

  TOTAL=$((TOTAL + 1))
  local actual=0
  node "$hook" < /dev/null 2>/dev/null || actual=$?

  if [ "$actual" -eq "$expected" ]; then
    echo "  ✅ PASS: $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected exit $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/templates"

  # config.json — sandbox disabled for pass-through tests
  cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "sandbox": { "enabled": false },
  "gate_guard": { "enabled": false },
  "project_name": "test-fail-closed"
}
EOF
}

setup_guard3_sandbox() {
  # Separate sandbox for GUARD 3 (corrupt signals file) test
  GUARD3_PROJECT="$TMPDIR_ROOT/guard3-project"
  mkdir -p "$GUARD3_PROJECT/.vela/state"
  mkdir -p "$GUARD3_PROJECT/.vela/templates"

  # config.json — gate_guard enabled
  cat > "$GUARD3_PROJECT/.vela/config.json" <<'EOF'
{
  "sandbox": { "enabled": true },
  "gate_guard": { "enabled": true },
  "project_name": "test-guard3"
}
EOF

  # pipeline-state.json — active pipeline at execute step (commits allowed)
  local ARTIFACT_DIR="$GUARD3_PROJECT/.vela/artifacts/20260101T000000-test-guard3"
  mkdir -p "$ARTIFACT_DIR"
  cat > "$ARTIFACT_DIR/pipeline-state.json" <<'EOF'
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "execute"
}
EOF

  # pipeline.json — must include execute step for git commit to be allowed
  cat > "$GUARD3_PROJECT/.vela/templates/pipeline.json" <<'EOF'
{
  "pipelines": {
    "standard": {
      "steps": [
        { "id": "research", "name": "Research", "mode": "read" },
        { "id": "plan", "name": "Plan", "mode": "read" },
        { "id": "execute", "name": "Execute", "mode": "readwrite" },
        { "id": "verify", "name": "Verify", "mode": "read" }
      ]
    }
  }
}
EOF

  # Corrupt signals file — invalid JSON
  echo "NOT_VALID_JSON{{{" > "$GUARD3_PROJECT/.vela/tracker-signals.json"
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

# ── main ─────────────────────────────────────────────────────

trap teardown_sandbox EXIT
setup_sandbox

echo "⛵ Fail-Closed Error Handling Tests"
echo "═══════════════════════════════════"

echo ""
echo "── 1. Corrupt stdin tests ──"

assert_exit "gate-keeper: corrupt stdin (not JSON) → exit 2" 2 \
  "$GATE_KEEPER" "THIS IS NOT JSON AT ALL"

assert_exit "gate-guard: corrupt stdin (not JSON) → exit 2" 2 \
  "$GATE_GUARD" "THIS IS NOT JSON AT ALL"

echo ""
echo "── 2. Empty stdin tests ──"

assert_exit_no_stdin "gate-keeper: empty stdin → exit 2" 2 "$GATE_KEEPER"

assert_exit_no_stdin "gate-guard: empty stdin → exit 2" 2 "$GATE_GUARD"

echo ""
echo "── 3. Valid JSON pass-through tests (sandbox/guard disabled) ──"

VALID_JSON=$(cat <<ENDJSON
{
  "tool_name": "Read",
  "tool_input": {"file_path": "test.js"},
  "session_id": "test-session",
  "cwd": "$PROJECT"
}
ENDJSON
)

assert_exit "gate-keeper: valid JSON, sandbox disabled → exit 0" 0 \
  "$GATE_KEEPER" "$VALID_JSON"

assert_exit "gate-guard: valid JSON, guard disabled → exit 0" 0 \
  "$GATE_GUARD" "$VALID_JSON"

echo ""
echo "── 4. GUARD 3: corrupt signals file → exit 2 ──"

setup_guard3_sandbox

GUARD3_JSON=$(cat <<ENDJSON
{
  "tool_name": "Bash",
  "tool_input": {"command": "git commit -m 'test'"},
  "session_id": "test-session",
  "cwd": "$GUARD3_PROJECT"
}
ENDJSON
)

assert_exit "gate-guard: corrupt signals + git commit → exit 2 (VG-03)" 2 \
  "$GATE_GUARD" "$GUARD3_JSON"

echo ""
echo "═══════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
