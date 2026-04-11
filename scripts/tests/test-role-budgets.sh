#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-role-budgets.sh — v7.1 M9 role budgets
#
# Covers: templates/role-budgets.json schema + agent prompts +
# vela-stop.js rollup. Budgets themselves are enforced by the
# agent as it runs (they self-report exceedances to a marker
# file), so the test asserts on:
#
#   1. role-budgets.json exists with all 6 scales (small/medium/
#      large/surgical/ralph/hotfix) + all 3 roles (executor/
#      verifier/reviewer)
#   2. Budget numbers match the design: large={80,60,25},
#      small={15,15,10}
#   3. executor/verifier/reviewer prompts mention budget
#   4. install.js FILE_MANIFEST deploys the template
#   5. vela-stop.js rolls up budget-exceeded.json into
#      tool-usage.json when it exists
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUDGETS_JSON="$REPO_ROOT/templates/role-budgets.json"
EXECUTOR_MD="$REPO_ROOT/scripts/agents/vela-executor.md"
VERIFIER_MD="$REPO_ROOT/scripts/agents/vela-verifier.md"
REVIEWER_MD="$REPO_ROOT/scripts/agents/vela-reviewer.md"
INSTALL_JS="$REPO_ROOT/scripts/install.js"
STOP_JS="$REPO_ROOT/scripts/hooks/vela-stop.js"

PASS=0
FAIL=0
TOTAL=0

note() {
  TOTAL=$((TOTAL + 1))
  if [ "$2" = "0" ]; then
    echo "  ✅ PASS: $1"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $1"
    FAIL=$((FAIL + 1))
  fi
}

# ── Phase 1: role-budgets.json schema ────────────────────────
echo "📋 Phase 1: role-budgets.json schema"

[ -f "$BUDGETS_JSON" ]
note "templates/role-budgets.json exists" $?

node -e "JSON.parse(require('fs').readFileSync('$BUDGETS_JSON','utf8'))" 2>/dev/null
note "role-budgets.json parses as JSON" $?

for scale in small medium large surgical ralph hotfix; do
  node -e "
    const j = JSON.parse(require('fs').readFileSync('$BUDGETS_JSON','utf8'));
    if (!j['$scale']) process.exit(1);
    for (const k of ['executor','verifier','reviewer']) {
      if (typeof j['$scale'][k] !== 'number') process.exit(1);
    }
  " 2>/dev/null
  note "role-budgets.json has $scale with {executor,verifier,reviewer}" $?
done

# Specific numbers
node -e "
  const j = JSON.parse(require('fs').readFileSync('$BUDGETS_JSON','utf8'));
  if (j.large.executor !== 80) process.exit(1);
  if (j.large.verifier !== 60) process.exit(1);
  if (j.large.reviewer !== 25) process.exit(1);
" 2>/dev/null
note "role-budgets.json large scale = {80, 60, 25}" $?

node -e "
  const j = JSON.parse(require('fs').readFileSync('$BUDGETS_JSON','utf8'));
  if (j.small.executor !== 15) process.exit(1);
  if (j.small.verifier !== 15) process.exit(1);
  if (j.small.reviewer !== 10) process.exit(1);
" 2>/dev/null
note "role-budgets.json small scale = {15, 15, 10}" $?

# ── Phase 2: agent prompts mention budget ────────────────────
echo "📋 Phase 2: agent prompts mention tool_use budget"

grep -q 'tool_use 예산' "$EXECUTOR_MD"
note "executor.md has tool_use 예산 section" $?

grep -q 'tool_use 예산' "$VERIFIER_MD"
note "verifier.md has tool_use 예산 section" $?

grep -q 'tool_use 예산' "$REVIEWER_MD"
note "reviewer.md has tool_use 예산 section" $?

grep -q 'budget-exceeded.json' "$EXECUTOR_MD"
note "executor.md documents budget-exceeded.json marker" $?

grep -q 'budget-exceeded.json' "$VERIFIER_MD"
note "verifier.md documents budget-exceeded.json marker" $?

grep -q 'budget-exceeded.json' "$REVIEWER_MD"
note "reviewer.md documents budget-exceeded.json marker" $?

# ── Phase 3: install.js deploys the template ─────────────────
echo "📋 Phase 3: install.js FILE_MANIFEST entry"

grep -q 'templates/role-budgets.json' "$INSTALL_JS"
note "FILE_MANIFEST includes templates/role-budgets.json" $?

# ── Phase 4: vela-stop.js rollup ─────────────────────────────
echo "📋 Phase 4: vela-stop.js rollup of budget-exceeded.json"

grep -q 'rollupToolUsage' "$STOP_JS"
note "vela-stop.js has rollupToolUsage function" $?

grep -q 'budget-exceeded.json' "$STOP_JS"
note "vela-stop.js reads budget-exceeded.json" $?

grep -q 'tool-usage.json' "$STOP_JS"
note "vela-stop.js writes tool-usage.json" $?

grep -q 'toolUsage' "$STOP_JS"
note "vela-stop.js session-end snapshot includes toolUsage" $?

# ── Phase 5: end-to-end rollup ───────────────────────────────
echo "📋 Phase 5: rollup picks up a dropped marker file"

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT
PROJECT="$TMPDIR_ROOT/project"
mkdir -p "$PROJECT/.vela/state" "$PROJECT/.vela/templates"
ARTIFACT_DIR="$PROJECT/.vela/artifacts/20260411T000000-t"
mkdir -p "$ARTIFACT_DIR"
cat > "$ARTIFACT_DIR/pipeline-state.json" <<'EOF'
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "execute",
  "request": "budget rollup test"
}
EOF
cat > "$PROJECT/.vela/templates/pipeline.json" <<'EOF'
{ "pipelines": { "standard": { "steps": [{ "id": "execute", "mode": "readwrite" }] } } }
EOF

cat > "$ARTIFACT_DIR/budget-exceeded.json" <<'EOF'
{ "role": "executor", "limit": 80, "used": 94, "overBy": 14 }
EOF

# Simulate a Stop hook fire
echo "{\"cwd\":\"$PROJECT\"}" | node "$STOP_JS" >/dev/null 2>&1 || true

[ -f "$ARTIFACT_DIR/tool-usage.json" ]
note "vela-stop.js wrote tool-usage.json" $?

grep -q '"overBy": 14' "$ARTIFACT_DIR/tool-usage.json" 2>/dev/null
note "tool-usage.json contains budgetExceeded.overBy" $?

grep -q '"role": "executor"' "$ARTIFACT_DIR/tool-usage.json" 2>/dev/null
note "tool-usage.json retains the executor role" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
