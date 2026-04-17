#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-gate-policy.sh — .vela/config.json#gate_policy opt-in
#
# The gate_policy block lets projects dial the VK-08 chain
# operator, VK-10 web-in-write, and M11 researcher-scope rules
# between "block" (default), "ask" (stdout JSON + exit 0), and
# (VK-08 only) "allow" (let through, telemetry only).
#
# This test verifies the two non-default modes work for VK-08:
#   1) policy = "ask"   → stdout has {"decision":"ask"}, exit 0
#   2) policy = "allow" → exit 0, no JSON, no block
# It also checks the default "block" behavior still produces
# exit 2, proving the policy gate is the only path variance.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE_KEEPER="$SCRIPT_DIR/../hooks/vela-gate.js"  # v7.3-M4c: keeper + guard merged

PASS=0
FAIL=0
TOTAL=0

setup_sandbox() {
  local policy="$1"
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state" "$PROJECT/.vela/templates"

  cat > "$PROJECT/.vela/config.json" <<EOF
{
  "sandbox": { "enabled": true },
  "gate_policy": { "chain_operator": "$policy" }
}
EOF

  local AD="$PROJECT/.vela/artifacts/20260101T000000-t"
  mkdir -p "$AD"
  cat > "$AD/pipeline-state.json" <<'EOF'
{ "status": "active", "pipeline_type": "standard", "current_step": "step1" }
EOF

  cat > "$PROJECT/.vela/templates/pipeline.json" <<'EOF'
{ "pipelines": { "standard": { "steps": [ { "id": "step1", "mode": "readwrite" } ] } } }
EOF
}

teardown() { rm -rf "$TMPDIR_ROOT" 2>/dev/null || true; }

run_bash() {
  echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls && pwd\"},\"cwd\":\"$PROJECT\"}" \
    | node "$GATE_KEEPER" 2>/dev/null
}

# ─── policy = "block" (default behavior) ─────────────────────

echo "⛵ gate_policy.chain_operator = block (default)"
echo "─────────────────────────────────────"
setup_sandbox "block"
TOTAL=$((TOTAL + 1))
EXIT_CODE=0
run_bash >/dev/null 2>&1 || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 2 ]; then
  echo "  ✅ PASS: block policy → exit 2"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: block policy expected exit 2, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi
teardown
echo ""

# ─── policy = "ask" ──────────────────────────────────────────

echo "⛵ gate_policy.chain_operator = ask"
echo "─────────────────────────────────────"
setup_sandbox "ask"

TOTAL=$((TOTAL + 1))
EXIT_CODE=0
STDOUT=$(run_bash) || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "  ✅ PASS: ask policy → exit 0"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: ask policy expected exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
DECISION=$(echo "$STDOUT" | node -e "
  let s='';
  process.stdin.on('data',c=>s+=c);
  process.stdin.on('end',()=>{
    try { process.stdout.write(JSON.parse(s).decision||''); }
    catch { process.stdout.write(''); }
  });
" 2>/dev/null)
if [ "$DECISION" = "ask" ]; then
  echo "  ✅ PASS: stdout JSON {decision:\"ask\"}"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: expected {decision:\"ask\"}, got stdout: $STDOUT"
  FAIL=$((FAIL + 1))
fi
teardown
echo ""

# ─── policy = "allow" ─────────────────────────────────────────

echo "⛵ gate_policy.chain_operator = allow"
echo "─────────────────────────────────────"
setup_sandbox "allow"

TOTAL=$((TOTAL + 1))
EXIT_CODE=0
STDOUT=$(run_bash) || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "  ✅ PASS: allow policy → exit 0"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: allow policy expected exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
if [ -z "$STDOUT" ]; then
  echo "  ✅ PASS: allow produces no JSON on stdout"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: allow should produce empty stdout, got: $STDOUT"
  FAIL=$((FAIL + 1))
fi
teardown
echo ""

echo "─────────────────────────────────────"
echo "Total: $TOTAL | Pass: $PASS | Fail: $FAIL"
[ "$FAIL" -eq 0 ]
