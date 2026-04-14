#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-gate-telemetry.sh — .vela/state/gate-events.jsonl writes
#
# Every block/ask/warn decision from the gate hooks appends a
# single JSON line to .vela/state/gate-events.jsonl so that
# /vela:analyze friction can surface hook friction hotspots.
#
# This test triggers a known block and asserts:
#   1) The jsonl file exists after the block
#   2) The last line parses as JSON
#   3) `code`, `tool`, `decision`, `ts` fields are present
#   4) `code` matches the expected VK-08
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE_KEEPER="$SCRIPT_DIR/../hooks/vela-gate-keeper.js"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT="$(mktemp -d)"
PROJECT="$TMPDIR_ROOT/project"
mkdir -p "$PROJECT/.vela/state" "$PROJECT/.vela/templates"

cat > "$PROJECT/.vela/config.json" <<'EOF'
{ "sandbox": { "enabled": true } }
EOF

AD="$PROJECT/.vela/artifacts/20260101T000000-t"
mkdir -p "$AD"
cat > "$AD/pipeline-state.json" <<EOF
{ "status": "active", "pipeline_type": "standard", "current_step": "execute" }
EOF

cat > "$PROJECT/.vela/templates/pipeline.json" <<'EOF'
{ "pipelines": { "standard": { "steps": [ { "id": "execute", "mode": "readwrite" } ] } } }
EOF

cleanup() { rm -rf "$TMPDIR_ROOT" 2>/dev/null || true; }
trap cleanup EXIT

# Trigger VK-08 (chain operator). We don't care about the exit code here
# — the gate-keeper is expected to exit 2 — we care about the telemetry
# side effect (gate-events.jsonl must be written), which the assertions
# below verify.
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls && pwd\"},\"cwd\":\"$PROJECT\"}" \
  | node "$GATE_KEEPER" >/dev/null 2>&1 || true

EVENTS="$PROJECT/.vela/state/gate-events.jsonl"

TOTAL=$((TOTAL + 1))
if [ -f "$EVENTS" ]; then
  echo "  ✅ PASS: gate-events.jsonl created"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: gate-events.jsonl missing after block"
  FAIL=$((FAIL + 1))
fi

LAST_LINE=""
if [ -f "$EVENTS" ]; then
  LAST_LINE=$(tail -n 1 "$EVENTS")
fi

TOTAL=$((TOTAL + 1))
if echo "$LAST_LINE" | node -e "let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{try{JSON.parse(s.trim());process.exit(0);}catch(e){process.exit(1);}})" >/dev/null 2>&1; then
  echo "  ✅ PASS: last line is valid JSON"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: last line not valid JSON — $LAST_LINE"
  FAIL=$((FAIL + 1))
fi

# Check required fields via node
TOTAL=$((TOTAL + 1))
FIELDS_OK=$(echo "$LAST_LINE" | node -e "
  let s='';
  process.stdin.on('data',c=>s+=c);
  process.stdin.on('end',()=>{
    try {
      const o=JSON.parse(s.trim());
      const ok = o.code==='VK-08' && o.tool==='Bash' && o.decision==='deny' && typeof o.ts==='string' && o.step==='execute';
      process.stdout.write(ok?'yes':'no');
    } catch { process.stdout.write('no'); }
  });
" 2>/dev/null)

if [ "$FIELDS_OK" = "yes" ]; then
  echo "  ✅ PASS: event has code=VK-08, tool=Bash, decision=deny, step=execute, ts"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: event missing expected fields — $LAST_LINE"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "─────────────────────────────────────"
echo "Total: $TOTAL | Pass: $PASS | Fail: $FAIL"
[ "$FAIL" -eq 0 ]
