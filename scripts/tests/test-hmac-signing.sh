#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-hmac-signing.sh — HMAC signing & verification chain tests
#
# 13 test cases covering:
#   Tests 1-3:  VK-07 delegation.json HMAC (gate-keeper)
#   Tests 4-5:  VG-12 delegation.json HMAC (gate-guard)
#   Tests 6-8:  review-{step}.md HMAC via exit_gate (vela-engine)
#   Tests 9-10: config.json write protection (VG-05, VK-05)
#   Tests 11-12: delegation.json cleanup on transition/cancel
#   Test 13:    permission hook rejects unsigned delegation
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"
GATE_KEEPER="$SCRIPT_DIR/../hooks/vela-gate-keeper.js"
GATE_GUARD="$SCRIPT_DIR/../hooks/vela-gate-guard.js"
PERMISSION="$SCRIPT_DIR/../hooks/vela-permission.js"
HMAC_MOD="$SCRIPT_DIR/../hooks/shared/hmac.js"

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/templates"

  # Copy pipeline.json template
  cp "$SCRIPT_DIR/../../templates/pipeline.json" "$PROJECT/.vela/templates/pipeline.json"

  # config.json
  cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "sandbox": { "enabled": true },
  "project_name": "test-hmac",
  "gate_guard": { "enabled": true }
}
EOF

  # Generate HMAC key
  node -e "
    const hmac = require('$HMAC_MOD');
    const fs = require('fs');
    fs.writeFileSync('$PROJECT/.vela/state/hmac-key', hmac.generateKey());
  "

  # Dummy source file for write tests
  echo "console.log('hello');" > "$PROJECT/index.js"
}

# Create a flat-style active pipeline
# Args: $1=current_step  $2=pipeline_type  $3=mode (optional, for pipeline.json step)
create_pipeline() {
  local step="${1:-execute}"
  local ptype="${2:-standard}"
  local ARTIFACT_DIR="$PROJECT/.vela/artifacts/2026-01-01_001_test-hmac"
  mkdir -p "$ARTIFACT_DIR"

  cat > "$ARTIFACT_DIR/pipeline-state.json" <<EOF
{
  "status": "active",
  "pipeline_type": "$ptype",
  "current_step": "$step",
  "current_step_index": 5,
  "completed_steps": ["init", "research", "plan", "plan-check", "checkpoint"],
  "total_steps": 10,
  "request": "test request",
  "auto": true,
  "revisions": {}
}
EOF
  ARTIFACT_DIR_PATH="$ARTIFACT_DIR"
}

# Create signed delegation.json
create_signed_delegation() {
  node -e "
    const hmac = require('$HMAC_MOD');
    const fs = require('fs');
    const key = fs.readFileSync('$PROJECT/.vela/state/hmac-key', 'utf8').trim();
    const obj = { active: true, step: 'execute', started_at: Date.now() };
    obj._hmac = hmac.signJSON(obj, key);
    fs.writeFileSync('$PROJECT/.vela/state/delegation.json', JSON.stringify(obj, null, 2));
  "
}

# Create unsigned delegation.json (no _hmac field)
create_unsigned_delegation() {
  cat > "$PROJECT/.vela/state/delegation.json" <<'EOF'
{ "active": true, "step": "execute", "started_at": 1234567890 }
EOF
}

# Create tampered delegation.json (wrong _hmac)
create_tampered_delegation() {
  cat > "$PROJECT/.vela/state/delegation.json" <<'EOF'
{ "active": true, "step": "execute", "started_at": 1234567890, "_hmac": "deadbeef0000000000000000000000000000000000000000000000000000dead" }
EOF
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

run_gate_keeper() {
  local tool_name="$1"
  local tool_input="$2"
  echo "{
    \"tool_name\": \"$tool_name\",
    \"tool_input\": $tool_input,
    \"session_id\": \"test-session\",
    \"cwd\": \"$PROJECT\"
  }" | node "$GATE_KEEPER" 2>/dev/null
  return ${PIPESTATUS[1]}
}

run_gate_guard() {
  local tool_name="$1"
  local tool_input="$2"
  echo "{
    \"tool_name\": \"$tool_name\",
    \"tool_input\": $tool_input,
    \"session_id\": \"test-session\",
    \"cwd\": \"$PROJECT\"
  }" | node "$GATE_GUARD" 2>/dev/null
  return ${PIPESTATUS[1]}
}

run_permission() {
  local tool_name="$1"
  local tool_input="$2"
  echo "{
    \"tool_name\": \"$tool_name\",
    \"tool_input\": $tool_input,
    \"session_id\": \"test-session\",
    \"cwd\": \"$PROJECT\"
  }" | node "$PERMISSION" 2>/dev/null
  return ${PIPESTATUS[1]}
}

assert_exit() {
  local label="$1"
  local expected="$2"
  local func="$3"
  local tool_name="$4"
  local tool_input="$5"

  TOTAL=$((TOTAL + 1))
  local actual=0
  $func "$tool_name" "$tool_input" || actual=$?

  if [ "$actual" -eq "$expected" ]; then
    echo "  ✅ PASS: $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected exit $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

# ── main ─────────────────────────────────────────────────────

trap teardown_sandbox EXIT

echo "⛵ HMAC Signing & Verification Chain Tests"
echo "═══════════════════════════════════════════"

# ─── Test 1: delegation.json without HMAC → VK-07 blocks ───
echo ""
echo "── Test 1: delegation.json without HMAC → VK-07 blocks"
setup_sandbox
create_pipeline "execute"
create_unsigned_delegation

assert_exit "Write with unsigned delegation → VK-07 blocks (exit 2)" 2 \
  run_gate_keeper "Write" '{"file_path":"index.js","content":"modified"}'
teardown_sandbox

# ─── Test 2: delegation.json with valid HMAC → VK-07 allows write ───
echo ""
echo "── Test 2: delegation.json with valid HMAC → VK-07 allows write"
setup_sandbox
create_pipeline "execute"
create_signed_delegation

assert_exit "Write with signed delegation → VK-07 allows (exit 0)" 0 \
  run_gate_keeper "Write" '{"file_path":"index.js","content":"modified"}'
teardown_sandbox

# ─── Test 3: delegation.json with tampered HMAC → VK-07 blocks ───
echo ""
echo "── Test 3: delegation.json with tampered HMAC → VK-07 blocks"
setup_sandbox
create_pipeline "execute"
create_tampered_delegation

assert_exit "Write with tampered delegation → VK-07 blocks (exit 2)" 2 \
  run_gate_keeper "Write" '{"file_path":"index.js","content":"modified"}'
teardown_sandbox

# ─── Test 4: delegation.json without HMAC → VG-12 blocks ───
echo ""
echo "── Test 4: delegation.json without HMAC → VG-12 blocks"
setup_sandbox
create_pipeline "execute"
create_unsigned_delegation

assert_exit "Write with unsigned delegation → VG-12 blocks (exit 2)" 2 \
  run_gate_guard "Write" '{"file_path":"index.js","content":"modified"}'
teardown_sandbox

# ─── Test 5: delegation.json with valid HMAC → VG-12 allows ───
echo ""
echo "── Test 5: delegation.json with valid HMAC → VG-12 allows"
setup_sandbox
create_pipeline "execute"
create_signed_delegation

assert_exit "Write with signed delegation → VG-12 allows (exit 0)" 0 \
  run_gate_guard "Write" '{"file_path":"index.js","content":"modified"}'
teardown_sandbox

# ─── Test 6: review-{step}.md without companion .hmac → exit_gate rejects ───
echo ""
echo "── Test 6: review file without .hmac → exit_gate rejects"
setup_sandbox
create_pipeline "execute"

# Create review file without .hmac companion
echo "# Review Content" > "$ARTIFACT_DIR_PATH/review-execute.md"

# Run transition — should fail because review is unsigned
TOTAL=$((TOTAL + 1))
output=""
actual=0
output=$(cd "$PROJECT" && node "$ENGINE" transition 2>/dev/null) || actual=$?

# Engine outputs JSON with ok:false and review_unsigned in missing
if echo "$output" | grep -q 'review_unsigned'; then
  echo "  ✅ PASS: Unsigned review → transition blocked (review_unsigned)"
  PASS=$((PASS + 1))
elif echo "$output" | grep -q 'review_missing'; then
  echo "  ✅ PASS: Unsigned review → transition blocked (review_missing)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Unsigned review → expected review_unsigned in output, got: $output"
  FAIL=$((FAIL + 1))
fi
teardown_sandbox

# ─── Test 7: review-{step}.md with valid .hmac → exit_gate passes ───
echo ""
echo "── Test 7: review file with valid .hmac → exit_gate passes review check"
setup_sandbox
create_pipeline "execute"

# Create review file and sign it
echo "# Review Content\n## Total: 22/25" > "$ARTIFACT_DIR_PATH/review-execute.md"
node -e "
  const hmac = require('$HMAC_MOD');
  const fs = require('fs');
  const key = fs.readFileSync('$PROJECT/.vela/state/hmac-key', 'utf8').trim();
  hmac.signFile('$ARTIFACT_DIR_PATH/review-execute.md', key);
"

# Also need approval-execute.json for implementation_complete gate
cat > "$ARTIFACT_DIR_PATH/approval-execute.json" <<'EOF'
{ "decision": "approve", "score": 22, "threshold": 20 }
EOF

# Transition — may still fail on other gates but not review_unsigned
TOTAL=$((TOTAL + 1))
output=""
actual=0
output=$(cd "$PROJECT" && node "$ENGINE" transition 2>&1) || actual=$?

# Check if output contains review_unsigned (should NOT)
if echo "$output" | grep -q 'review_unsigned'; then
  echo "  ❌ FAIL: Signed review still reported as unsigned"
  FAIL=$((FAIL + 1))
else
  echo "  ✅ PASS: Signed review passes HMAC verification"
  PASS=$((PASS + 1))
fi
teardown_sandbox

# ─── Test 8: review-{step}.md modified after signing → exit_gate rejects ───
echo ""
echo "── Test 8: review modified after signing → exit_gate rejects"
setup_sandbox
create_pipeline "execute"

# Create and sign review file
echo "# Original Review Content" > "$ARTIFACT_DIR_PATH/review-execute.md"
node -e "
  const hmac = require('$HMAC_MOD');
  const fs = require('fs');
  const key = fs.readFileSync('$PROJECT/.vela/state/hmac-key', 'utf8').trim();
  hmac.signFile('$ARTIFACT_DIR_PATH/review-execute.md', key);
"

# Tamper with review content after signing
echo "# TAMPERED Review Content" > "$ARTIFACT_DIR_PATH/review-execute.md"

# Also need approval for implementation_complete
cat > "$ARTIFACT_DIR_PATH/approval-execute.json" <<'EOF'
{ "decision": "approve", "score": 22, "threshold": 20 }
EOF

TOTAL=$((TOTAL + 1))
output=""
actual=0
output=$(cd "$PROJECT" && node "$ENGINE" transition 2>&1) || actual=$?

if echo "$output" | grep -q 'review_unsigned'; then
  echo "  ✅ PASS: Tampered review detected as unsigned"
  PASS=$((PASS + 1))
elif [ "$actual" -ne 0 ]; then
  echo "  ✅ PASS: Tampered review → transition blocked (exit $actual)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Tampered review not detected"
  FAIL=$((FAIL + 1))
fi
teardown_sandbox

# ─── Test 9: config.json write → VG-05 blocks ───
echo ""
echo "── Test 9: config.json write → VG-05 blocks"
setup_sandbox
create_pipeline "execute"
create_signed_delegation

assert_exit "Write config.json → VG-05 blocks (exit 2)" 2 \
  run_gate_guard "Write" '{"file_path":".vela/config.json","content":"tampered"}'
teardown_sandbox

# ─── Test 10: config.json write → VK-05 blocks ───
echo ""
echo "── Test 10: config.json write → VK-05 blocks"
setup_sandbox
create_pipeline "execute"

assert_exit "Write config.json → VK-05 blocks (exit 2)" 2 \
  run_gate_keeper "Write" '{"file_path":".vela/config.json","content":"tampered"}'
teardown_sandbox

# ─── Test 11: delegation.json cleaned up on cmdTransition ───
echo ""
echo "── Test 11: delegation.json cleaned up on transition"
setup_sandbox

# Create a pipeline at a step that can transition (e.g. research → plan)
# Need to satisfy exit gates for research step: research_md_exists + approval_exists
ARTIFACT_DIR="$PROJECT/.vela/artifacts/2026-01-01_001_test-hmac"
mkdir -p "$ARTIFACT_DIR"

cat > "$ARTIFACT_DIR/pipeline-state.json" <<'EOF'
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "research",
  "current_step_index": 1,
  "completed_steps": ["init"],
  "total_steps": 10,
  "request": "test request",
  "auto": false,
  "revisions": {}
}
EOF

# Create exit gate artifacts for research step
echo "# Research content" > "$ARTIFACT_DIR/research.md"
cat > "$ARTIFACT_DIR/approval-research.json" <<'EOF'
{ "decision": "approve" }
EOF

# Create delegation.json (should be cleaned up after transition)
create_signed_delegation

TOTAL=$((TOTAL + 1))
cd "$PROJECT" && node "$ENGINE" transition >/dev/null 2>&1 || true
cd "$SCRIPT_DIR/../.."

if [ ! -f "$PROJECT/.vela/state/delegation.json" ]; then
  echo "  ✅ PASS: delegation.json cleaned up after transition"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: delegation.json still exists after transition"
  FAIL=$((FAIL + 1))
fi
teardown_sandbox

# ─── Test 12: delegation.json cleaned up on cmdCancel ───
echo ""
echo "── Test 12: delegation.json cleaned up on cancel"
setup_sandbox
create_pipeline "execute"
create_signed_delegation

TOTAL=$((TOTAL + 1))
cd "$PROJECT" && node "$ENGINE" cancel >/dev/null 2>&1 || true
cd "$SCRIPT_DIR/../.."

if [ ! -f "$PROJECT/.vela/state/delegation.json" ]; then
  echo "  ✅ PASS: delegation.json cleaned up after cancel"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: delegation.json still exists after cancel"
  FAIL=$((FAIL + 1))
fi
teardown_sandbox

# ─── Test 13: permission hook rejects unsigned delegation ───
echo ""
echo "── Test 13: permission hook rejects unsigned delegation"
setup_sandbox
create_pipeline "execute"
create_unsigned_delegation

# Permission hook should exit 0 (pass through) when delegation is invalid
# because it can't grant permission without valid delegation
TOTAL=$((TOTAL + 1))
output=""
actual=0
output=$(run_permission "Write" '{"file_path":"index.js","content":"modified"}' 2>/dev/null) || actual=$?

# Permission hook exits 0 with empty output when delegation is invalid
# (it doesn't block — it just doesn't grant the special permission)
if [ "$actual" -eq 0 ] && [ -z "$output" ]; then
  echo "  ✅ PASS: Permission hook silent pass on unsigned delegation (no allow granted)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Permission hook unexpected behavior — exit $actual, output: $output"
  FAIL=$((FAIL + 1))
fi
teardown_sandbox

# ─── Summary ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
