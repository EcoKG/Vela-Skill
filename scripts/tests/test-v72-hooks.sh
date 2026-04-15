#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-v72-hooks.sh — v7.2 M8
#
# Two new observational hooks were added this phase:
#   vela-post-tool-learning.js  (PostToolUse on Write/Edit)
#     → appends to <artifactDir>/edit-journal.jsonl
#   vela-subagent-stop.js       (SubagentStop)
#     → appends to <artifactDir>/agent-telemetry.jsonl
#
# Both must always exit 0 (non-fatal / observational) and both
# must be no-ops when no active pipeline exists.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_EDIT="$SCRIPT_DIR/../hooks/vela-post-tool-learning.js"
HOOK_SUB="$SCRIPT_DIR/../hooks/vela-subagent-stop.js"

PASS=0
FAIL=0
TOTAL=0

assert() {
  TOTAL=$((TOTAL + 1))
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then echo "  ✅ $label"; PASS=$((PASS + 1));
  else echo "  ❌ $label (got='$got' want='$want')"; FAIL=$((FAIL + 1)); fi
}

TMPROOT="$(mktemp -d)"
PROJECT="$TMPROOT/project"
AD="$PROJECT/.vela/artifacts/20260415T120000-test"
mkdir -p "$AD"
cat > "$AD/pipeline-state.json" <<'EOF'
{ "status": "active", "pipeline_type": "standard", "current_step": "execute" }
EOF

echo "=== v7.2 M8 — vela-post-tool-learning hook ==="

# Write event → edit-journal.jsonl line
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/demo.txt\"},\"cwd\":\"$PROJECT\",\"session_id\":\"sess1\"}" \
  | node "$HOOK_EDIT" >/dev/null 2>&1
EXIT1=$?
assert "post-tool-learning exit 0 on Write" "$EXIT1" "0"

JOURNAL="$AD/edit-journal.jsonl"
if [ -f "$JOURNAL" ]; then
  assert "edit-journal.jsonl created" "yes" "yes"
  LINE_COUNT=$(wc -l < "$JOURNAL" | tr -d ' ')
  assert "edit-journal.jsonl has 1 line" "$LINE_COUNT" "1"
  TOOL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$JOURNAL','utf8').trim()).tool)")
  assert "journal entry tool=Write" "$TOOL" "Write"
  OP=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$JOURNAL','utf8').trim()).op)")
  assert "journal entry op=write" "$OP" "write"
else
  assert "edit-journal.jsonl created" "no" "yes"
fi

# Non-Write/Edit tool must be a no-op (no new line)
echo "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/tmp/x\"},\"cwd\":\"$PROJECT\"}" \
  | node "$HOOK_EDIT" >/dev/null 2>&1
LINE_COUNT2=$(wc -l < "$JOURNAL" | tr -d ' ')
assert "Read is no-op (journal still 1 line)" "$LINE_COUNT2" "1"

# Edit with replace_all=true → op=edit-replace-all
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/demo.txt\",\"replace_all\":true},\"cwd\":\"$PROJECT\"}" \
  | node "$HOOK_EDIT" >/dev/null 2>&1
LAST_OP=$(tail -1 "$JOURNAL" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8').trim()).op)")
assert "Edit replace_all → op=edit-replace-all" "$LAST_OP" "edit-replace-all"

echo ""
echo "=== v7.2 M8 — vela-subagent-stop hook ==="

# Subagent stop with usage → agent-telemetry.jsonl line
echo '{"subagent_type":"vela-researcher","cwd":"'$PROJECT'","usage":{"input_tokens":100,"output_tokens":50},"tool_counts":{"Read":5,"Grep":2},"duration_ms":3400,"model":"opus"}' \
  | node "$HOOK_SUB" >/dev/null 2>&1
EXIT2=$?
assert "subagent-stop exit 0" "$EXIT2" "0"

TELEMETRY="$AD/agent-telemetry.jsonl"
if [ -f "$TELEMETRY" ]; then
  AGENT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TELEMETRY','utf8').trim()).agent)")
  assert "telemetry entry agent=vela-researcher" "$AGENT" "vela-researcher"
  MODEL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TELEMETRY','utf8').trim()).model)")
  assert "telemetry entry model=opus" "$MODEL" "opus"
  DURATION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TELEMETRY','utf8').trim()).duration_ms)")
  assert "telemetry entry duration_ms=3400" "$DURATION" "3400"
else
  assert "agent-telemetry.jsonl created" "no" "yes"
fi

echo ""
echo "=== No active pipeline → both hooks are no-ops ==="

EMPTY="$TMPROOT/empty"
mkdir -p "$EMPTY"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/x\"},\"cwd\":\"$EMPTY\"}" \
  | node "$HOOK_EDIT" >/dev/null 2>&1
assert "post-tool-learning is no-op outside a pipeline (exit 0)" "$?" "0"

echo "{\"subagent_type\":\"x\",\"cwd\":\"$EMPTY\"}" | node "$HOOK_SUB" >/dev/null 2>&1
assert "subagent-stop is no-op outside a pipeline (exit 0)" "$?" "0"

rm -rf "$TMPROOT"

echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ $FAIL -eq 0 ]
