#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-v72-engine-fields.sh — v7.2 M1/M2/M13
#
# `vela-engine state` gained three output fields this phase:
#   recommended_model  — per-role model routing from config.models
#   cache_config       — pass-through of config.cache
#   tasks[]            — pipeline-steps-as-tasks for PM's task-list
#                        tool integration (M13)
#
# This test spins up a minimal .vela fixture, starts a pipeline,
# and asserts the three fields materialize correctly.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"

PASS=0
FAIL=0
TOTAL=0

assert() {
  TOTAL=$((TOTAL + 1))
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label (got='$got' want='$want')"
    FAIL=$((FAIL + 1))
  fi
}

TMPROOT="$(mktemp -d)"
PROJECT="$TMPROOT/project"
mkdir -p "$PROJECT/.vela/templates"
cd "$PROJECT"

# Minimal git repo (engine refuses to init in a dirty / non-repo state)
git init -q
git config user.email t@t && git config user.name t

# Minimal project config with the new v7.2 sections
cat > .vela/config.json <<'EOF'
{
  "engine": "vela",
  "cache": { "enabled": true, "ttl": "1h" },
  "models": {
    "default": "sonnet",
    "research": "opus",
    "plan": "opus",
    "plan_check": "haiku",
    "verify": "haiku"
  }
}
EOF

# Copy the real pipeline template so the engine can resolve steps
cp "$SCRIPT_DIR/../../templates/pipeline.json" .vela/templates/pipeline.json
cp "$SCRIPT_DIR/../../templates/role-budgets.json" .vela/templates/role-budgets.json 2>/dev/null || true

git add -A && git commit -qm init

# Start a small-scale pipeline so `state` has something to report
node "$ENGINE" init "unit test" --scale small >/dev/null 2>&1

echo "=== v7.2 engine state fields ==="
STATE_JSON="$(node "$ENGINE" state 2>/dev/null)"

# recommended_model at the 'init' step of small scale — not explicitly
# mapped, should fall back to models.default = "sonnet".
MODEL=$(echo "$STATE_JSON" | node -e "const s=require('fs').readFileSync(0,'utf8'); console.log(JSON.parse(s).recommended_model || 'null')")
assert "recommended_model falls back to default=sonnet at init step" "$MODEL" "sonnet"

# cache_config surfaces the config.cache object
CACHE_TTL=$(echo "$STATE_JSON" | node -e "const s=require('fs').readFileSync(0,'utf8'); const c=JSON.parse(s).cache_config; console.log(c && c.ttl || 'null')")
assert "cache_config.ttl = 1h" "$CACHE_TTL" "1h"

# tasks[] length equals steps length
TASKS_LEN=$(echo "$STATE_JSON" | node -e "const s=require('fs').readFileSync(0,'utf8'); const j=JSON.parse(s); console.log((j.tasks||[]).length === (j.completed_steps.length + j.remaining_steps.length) ? 'ok' : 'mismatch')")
assert "tasks[] length matches total steps" "$TASKS_LEN" "ok"

# First task status should be in_progress (init step is current_step)
FIRST_STATUS=$(echo "$STATE_JSON" | node -e "const s=require('fs').readFileSync(0,'utf8'); console.log(JSON.parse(s).tasks[0].status)")
assert "tasks[0].status = in_progress (current step)" "$FIRST_STATUS" "in_progress"

# Task id prefix encodes pipeline_type.
# v7.3-M3 collapsed pipelines: `trivial` → `ship` (all small/medium/
# large/ralph/hotfix now route through the 6-step ship pipeline except
# fix+hotfix). So the --scale small init above resolves to ship.
FIRST_ID=$(echo "$STATE_JSON" | node -e "const s=require('fs').readFileSync(0,'utf8'); const id=JSON.parse(s).tasks[0].id; console.log(id.startsWith('vela-ship-0-init') ? 'ok' : id)")
assert "tasks[0].id = vela-ship-0-init" "$FIRST_ID" "ok"

cd /
rm -rf "$TMPROOT"

echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ $FAIL -eq 0 ]
