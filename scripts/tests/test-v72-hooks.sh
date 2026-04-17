#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-v72-hooks.sh — v7.2 M8 (v7.3-M4d 통합됨)
#
# vela-post-tool-learning.js 관련 테스트 블록은 v7.3-M4에서 훅이
# 제거되면서 삭제됨.
#
# v7.3-M4d: vela-subagent-stop.js → vela-stop.js로 통합.
# 입력에 hook_event_name="SubagentStop"을 넣어 통합 훅을 호출한다.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SUB="$SCRIPT_DIR/../hooks/vela-stop.js"

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
# shellcheck disable=SC2064  # $TMPROOT deliberately expanded now (fixed cleanup target)
trap "rm -rf '$TMPROOT'" EXIT

PROJECT="$TMPROOT/project"
AD="$PROJECT/.vela/artifacts/20260415T120000-test"
mkdir -p "$AD"
cat > "$AD/pipeline-state.json" <<'EOF'
{ "status": "active", "pipeline_type": "ship", "current_step": "execute" }
EOF

echo "=== v7.2 M8 — SubagentStop dispatch via unified vela-stop.js (M4d) ==="

# Subagent stop with usage → agent-telemetry.jsonl line
echo '{"hook_event_name":"SubagentStop","subagent_type":"vela-researcher","cwd":"'$PROJECT'","usage":{"input_tokens":100,"output_tokens":50},"tool_counts":{"Read":5,"Grep":2},"duration_ms":3400,"model":"opus"}' \
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
echo "=== No active pipeline → hook is a no-op ==="

EMPTY="$TMPROOT/empty"
mkdir -p "$EMPTY"
echo '{"hook_event_name":"SubagentStop","subagent_type":"vela-researcher","cwd":"'$EMPTY'","usage":{"input_tokens":10,"output_tokens":5}}' \
  | node "$HOOK_SUB" >/dev/null 2>&1
assert "subagent-stop is no-op outside a pipeline (exit 0)" "$?" "0"

echo ""
echo "────────────────────────────────────────"
echo "Total: $TOTAL, Pass: $PASS, Fail: $FAIL"
[ "$FAIL" = "0" ]
