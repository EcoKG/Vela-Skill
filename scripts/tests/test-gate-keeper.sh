#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-gate-keeper.sh — Comprehensive VK-* keeper test (runs via vela-gate.js, v7.3-M4c merged)
#
# Covers:
#   VK-01: Bash safe commands allowed in read mode
#   VK-02: Bash blocked in write mode
#   VK-03: Write tool blocked in read mode
#   VK-04: Edit tool blocked in read mode
#   VK-05: .vela/ writes allowed in read mode (except pipeline-state)
#   VK-06: Sandbox disabled → all tools pass through
#   VK-07: Read/Glob/Grep allowed in read mode
#   VK-08: Chain operators (&&, ||, ;, |) blocked
#   Fail-closed: empty/corrupt stdin → exit 2
#   readwrite mode: everything allowed
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE_KEEPER="$SCRIPT_DIR/../hooks/vela-gate.js"  # v7.3-M4c: keeper + guard merged

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

TMPDIR_ROOT=""
PROJECT=""

setup_sandbox() {
  local mode="${1:-read}"
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/templates"

  cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "sandbox": { "enabled": true },
  "project_name": "test-gk"
}
EOF

  local ARTIFACT_DIR="$PROJECT/.vela/artifacts/20260101T000000-test-gk"
  mkdir -p "$ARTIFACT_DIR"
  cat > "$ARTIFACT_DIR/pipeline-state.json" <<EOF
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "step1"
}
EOF

  cat > "$PROJECT/.vela/templates/pipeline.json" <<EOF
{
  "pipelines": {
    "standard": {
      "steps": [
        { "id": "step1", "mode": "$mode" }
      ]
    }
  }
}
EOF

  echo "console.log('hello');" > "$PROJECT/index.js"
}

setup_sandbox_no_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela"
  cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "project_name": "test-no-sandbox"
}
EOF
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

run_gate() {
  local tool_name="$1"
  local tool_input="$2"
  local json
  json=$(cat <<ENDJSON
{
  "tool_name": "$tool_name",
  "tool_input": $tool_input,
  "session_id": "test-session",
  "cwd": "$PROJECT"
}
ENDJSON
  )
  echo "$json" | node "$GATE_KEEPER" 2>/dev/null
  return ${PIPESTATUS[1]}
}

assert_exit() {
  local label="$1"
  local expected="$2"
  local tool_name="$3"
  local tool_input="$4"

  TOTAL=$((TOTAL + 1))
  local actual=0
  run_gate "$tool_name" "$tool_input" || actual=$?

  if [ "$actual" -eq "$expected" ]; then
    echo "  ✅ PASS: $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected exit $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

# ── Test: Fail-closed ────────────────────────────────────────

echo "⛵ Gate Keeper — Fail-closed tests"
echo "─────────────────────────────────────"

TOTAL=$((TOTAL + 1))
EXIT_CODE=0
echo "" | node "$GATE_KEEPER" 2>/dev/null || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 2 ]; then
  echo "  ✅ PASS: Empty stdin → exit 2"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Empty stdin — expected exit 2, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
EXIT_CODE=0
echo "not json at all" | node "$GATE_KEEPER" 2>/dev/null || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 2 ]; then
  echo "  ✅ PASS: Corrupt JSON → exit 2"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Corrupt JSON — expected exit 2, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

echo ""

# ── Test: Sandbox disabled ───────────────────────────────────

echo "⛵ VK-06: Sandbox disabled → pass through"
echo "─────────────────────────────────────"

setup_sandbox_no_sandbox

assert_exit "Bash with no sandbox → allow" 0 \
  "Bash" '{"command":"rm -rf /"}'

assert_exit "Write with no sandbox → allow" 0 \
  "Write" '{"file_path":"index.js","content":"x"}'

teardown_sandbox
echo ""

# ── Test: Read mode ──────────────────────────────────────────

echo "⛵ VK-01/VK-07: Read mode — allowed tools"
echo "─────────────────────────────────────"

setup_sandbox "read"

assert_exit "Read tool → allow" 0 \
  "Read" '{"file_path":"index.js"}'

assert_exit "Glob tool → allow" 0 \
  "Glob" '{"pattern":"*.js"}'

assert_exit "Grep tool → allow" 0 \
  "Grep" '{"pattern":"console"}'

assert_exit "Bash ls → allow (safe read cmd)" 0 \
  "Bash" '{"command":"ls -la"}'

assert_exit "Bash git status → allow (safe read cmd)" 0 \
  "Bash" '{"command":"git status"}'

assert_exit "Bash git log → allow (safe read cmd)" 0 \
  "Bash" '{"command":"git log --oneline"}'

assert_exit "Bash npm test → allow (safe read cmd)" 0 \
  "Bash" '{"command":"npm test"}'

assert_exit "Bash cat → allow (safe read cmd)" 0 \
  "Bash" '{"command":"cat file.txt"}'

teardown_sandbox
echo ""

echo "⛵ VK-01/VK-03/VK-04: Read mode — blocked tools"
echo "─────────────────────────────────────"

setup_sandbox "read"

assert_exit "Bash rm → block" 2 \
  "Bash" '{"command":"rm file.txt"}'

assert_exit "Bash curl → block (not in safe list)" 2 \
  "Bash" '{"command":"curl http://example.com"}'

assert_exit "Write tool → block" 2 \
  "Write" '{"file_path":"index.js","content":"modified"}'

assert_exit "Edit tool → block" 2 \
  "Edit" '{"file_path":"index.js","new_string":"modified"}'

assert_exit "NotebookEdit tool → block" 2 \
  "NotebookEdit" '{"file_path":"notebook.ipynb"}'

teardown_sandbox
echo ""

# ── Test: .vela/ writes in read mode ─────────────────────────

echo "⛵ VK-05: .vela/ writes in read mode"
echo "─────────────────────────────────────"

setup_sandbox "read"

assert_exit "Write .vela/artifacts/log → allow" 0 \
  "Write" "{\"file_path\":\"$PROJECT/.vela/artifacts/log.json\",\"content\":\"{}\"}"

assert_exit "Edit .vela/state/x → allow" 0 \
  "Edit" "{\"file_path\":\"$PROJECT/.vela/state/x.json\",\"new_string\":\"x\"}"

assert_exit "Write pipeline-state.json → block" 2 \
  "Write" "{\"file_path\":\"$PROJECT/.vela/artifacts/dir/pipeline-state.json\",\"content\":\"{}\"}"

teardown_sandbox
echo ""

# ── Test: Write mode ─────────────────────────────────────────

echo "⛵ VK-02: Write mode — Bash blocked"
echo "─────────────────────────────────────"

setup_sandbox "write"

assert_exit "Bash ls in write mode → block" 2 \
  "Bash" '{"command":"ls"}'

assert_exit "Write tool in write mode → allow" 0 \
  "Write" '{"file_path":"index.js","content":"modified"}'

assert_exit "Edit tool in write mode → allow" 0 \
  "Edit" '{"file_path":"index.js","new_string":"modified"}'

assert_exit "Read tool in write mode → allow" 0 \
  "Read" '{"file_path":"index.js"}'

teardown_sandbox
echo ""

# ── Test: readwrite mode ─────────────────────────────────────

echo "⛵ Readwrite mode — everything allowed"
echo "─────────────────────────────────────"

setup_sandbox "readwrite"

assert_exit "Bash in readwrite → allow" 0 \
  "Bash" '{"command":"ls"}'

assert_exit "Write in readwrite → allow" 0 \
  "Write" '{"file_path":"index.js","content":"x"}'

assert_exit "Edit in readwrite → allow" 0 \
  "Edit" '{"file_path":"index.js","new_string":"x"}'

teardown_sandbox
echo ""

# ── Test: VK-08 Chain operators ──────────────────────────────

echo "⛵ VK-08: Chain operator blocking"
echo "─────────────────────────────────────"

setup_sandbox "readwrite"

assert_exit "Bash && → block" 2 \
  "Bash" '{"command":"ls && rm file"}'

assert_exit "Bash || → block" 2 \
  "Bash" '{"command":"ls || echo fail"}'

assert_exit "Bash semicolon → block" 2 \
  "Bash" '{"command":"ls; rm file"}'

assert_exit "Bash pipe → block" 2 \
  "Bash" '{"command":"ls | grep foo"}'

teardown_sandbox
echo ""

# ── Summary ──────────────────────────────────────────────────

echo "═══════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ SOME TESTS FAILED"
  exit 1
fi
echo "✅ 전체 PASS"
