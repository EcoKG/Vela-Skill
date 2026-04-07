#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-vela-sprint.sh — vela-sprint.js 계약 테스트
#
# 22 assertions covering module exports, CLI help, context
# passing logic, status/cancel commands, error cases, and
# lock file separation.
#
# Groups:
#   MODULE    — syntax, buildSliceContext, assembleSliceRequest exports
#   HELP      — CLI help contains 'run', 'status'
#   CONTEXT   — dependency result collection, request assembly
#   STATUS    — empty status, sprint display
#   CANCEL    — cancel active sprint, cancel with nothing
#   ERRORS    — run with no request, resume with no sprint, resume bad ID
#   LOCK      — lock path is .sprint.lock, separate from .orchestrator.lock
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VS="$PROJECT_ROOT/scripts/cli/vela-sprint.js"
SM="$PROJECT_ROOT/scripts/shared/sprint-manager.js"

PASS=0
FAIL=0
TOTAL=0

# ─── Setup temp directory ───

TMP_DIR=$(mktemp -d)

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Run tests from TMP_DIR so sprint-manager's SPRINTS_DIR (.vela/sprints) resolves to temp
cd "$TMP_DIR"
mkdir -p .vela/sprints .vela/state

# ─── Helpers ───

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label — expected=\"$expected\" actual=\"$actual\""
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label — expected to contain \"$needle\""
    FAIL=$((FAIL + 1))
  fi
}

assert_exit() {
  local label="$1" expected_exit="$2"
  shift 2
  TOTAL=$((TOTAL + 1))
  set +e
  OUTPUT=$("$@" 2>&1)
  local actual_exit=$?
  set -e
  if [ "$expected_exit" -eq "$actual_exit" ]; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label — expected exit=$expected_exit actual=$actual_exit"
    echo "     output: $OUTPUT"
    FAIL=$((FAIL + 1))
  fi
}

echo "═══════════════════════════════════════════════════"
echo "  vela-sprint.js contract tests"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── Group 1: Module Basics ───
echo "── MODULE BASICS ──"

# 1. Syntax check
assert_exit "syntax check passes" 0 node -c "$VS"

# 2. exports buildSliceContext
BSC_TYPE=$(node -e "console.log(typeof require('$VS').buildSliceContext)")
assert_eq "exports buildSliceContext as function" "function" "$BSC_TYPE"

# 3. exports assembleSliceRequest
ASR_TYPE=$(node -e "console.log(typeof require('$VS').assembleSliceRequest)")
assert_eq "exports assembleSliceRequest as function" "function" "$ASR_TYPE"

echo ""

# ─── Group 2: CLI Help ───
echo "── CLI HELP ──"

HELP_OUTPUT=$(node "$VS" --help 2>&1)

# 4. Help contains 'run'
assert_contains "help contains 'run'" "run" "$HELP_OUTPUT"

# 5. Help contains 'status'
assert_contains "help contains 'status'" "status" "$HELP_OUTPUT"

echo ""

# ─── Group 3: Context Passing Logic ───
echo "── CONTEXT PASSING ──"

# Create sprint with A→B for context tests
CTX_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Context Test',
    request: 'Test context passing',
    slices: [
      { id: 'a', title: 'Slice A' },
      { id: 'b', title: 'Slice B', depends_on: ['a'] }
    ]
  });
  console.log(plan.id);
")

# 6. A not done → buildSliceContext for B returns null
CTX_NULL=$(node -e "
  const { buildSliceContext } = require('$VS');
  const sm = require('$SM');
  const plan = sm.loadSprint('$CTX_ID');
  const sliceB = plan.slices.find(s => s.id === 'b');
  console.log(buildSliceContext(plan, sliceB));
")
assert_eq "dep not done → buildSliceContext returns null" "null" "$CTX_NULL"

# 7. Set A to done with result → buildSliceContext for B returns string containing result
node -e "
  const sm = require('$SM');
  sm.updateSliceStatus('$CTX_ID', 'a', { status: 'queued' });
  sm.updateSliceStatus('$CTX_ID', 'a', { status: 'running' });
  sm.updateSliceStatus('$CTX_ID', 'a', { status: 'done', result: 'Result from A' });
" > /dev/null
CTX_A=$(node -e "
  const { buildSliceContext } = require('$VS');
  const sm = require('$SM');
  const plan = sm.loadSprint('$CTX_ID');
  const sliceB = plan.slices.find(s => s.id === 'b');
  const ctx = buildSliceContext(plan, sliceB);
  console.log(ctx && ctx.includes('Result from A') ? 'has_result' : 'missing');
")
assert_eq "dep done with result → context contains result" "has_result" "$CTX_A"

# 8. Three slices (A→C, B→C), both done → context for C contains both
CTX3_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Multi-dep Test',
    request: 'Test multi deps',
    slices: [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
      { id: 'c', title: 'Charlie', depends_on: ['a', 'b'] }
    ]
  });
  // Move both A and B to done with results
  sm.updateSliceStatus(plan.id, 'a', { status: 'queued' });
  sm.updateSliceStatus(plan.id, 'a', { status: 'running' });
  sm.updateSliceStatus(plan.id, 'a', { status: 'done', result: 'Alpha result' });
  sm.updateSliceStatus(plan.id, 'b', { status: 'queued' });
  sm.updateSliceStatus(plan.id, 'b', { status: 'running' });
  sm.updateSliceStatus(plan.id, 'b', { status: 'done', result: 'Beta result' });
  console.log(plan.id);
")
CTX_BOTH=$(node -e "
  const { buildSliceContext } = require('$VS');
  const sm = require('$SM');
  const plan = sm.loadSprint('$CTX3_ID');
  const sliceC = plan.slices.find(s => s.id === 'c');
  const ctx = buildSliceContext(plan, sliceC);
  const hasAlpha = ctx && ctx.includes('Alpha result');
  const hasBeta = ctx && ctx.includes('Beta result');
  console.log(hasAlpha && hasBeta ? 'both' : 'missing');
")
assert_eq "multi-dep: context contains both results" "both" "$CTX_BOTH"

# 9. Slice with no depends_on → buildSliceContext returns null
CTX_NODEP=$(node -e "
  const { buildSliceContext } = require('$VS');
  const sm = require('$SM');
  const plan = sm.loadSprint('$CTX_ID');
  const sliceA = plan.slices.find(s => s.id === 'a');
  console.log(buildSliceContext(plan, sliceA));
")
assert_eq "no depends_on → buildSliceContext returns null" "null" "$CTX_NODEP"

# 10. assembleSliceRequest(null, 'do X') → returns 'do X' unchanged
ASR_NULL=$(node -e "
  const { assembleSliceRequest } = require('$VS');
  console.log(assembleSliceRequest(null, 'do X'));
")
assert_eq "assembleSliceRequest(null, 'do X') → 'do X'" "do X" "$ASR_NULL"

# 11. assembleSliceRequest('ctx', 'do X') → contains both
ASR_BOTH=$(node -e "
  const { assembleSliceRequest } = require('$VS');
  const result = assembleSliceRequest('ctx info', 'do X');
  const hasCtx = result.includes('ctx info');
  const hasReq = result.includes('do X');
  console.log(hasCtx && hasReq ? 'both' : 'missing');
")
assert_eq "assembleSliceRequest('ctx', 'do X') → contains both" "both" "$ASR_BOTH"

echo ""

# ─── Group 4: Status Command ───
echo "── STATUS COMMAND ──"

# 12. status with no active sprint → exits 0
# Use a fresh temp for isolation
STATUS_TMP=$(mktemp -d)
mkdir -p "$STATUS_TMP/.vela/sprints"
STATUS_OUT=$(cd "$STATUS_TMP" && node "$VS" status 2>&1)
STATUS_EXIT=$?
rm -rf "$STATUS_TMP"
assert_eq "status with no sprints exits 0" "0" "$STATUS_EXIT"

# 13. Create sprint → status <id> shows title
STATUS_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Status Display Test',
    request: 'Show status',
    slices: [{ id: 's1', title: 'Slice 1' }]
  });
  sm.updateSprintStatus(plan.id, 'running');
  console.log(plan.id);
")
STATUS_TITLE=$(node "$VS" status "$STATUS_ID" 2>&1)
assert_contains "status shows sprint title" "Status Display Test" "$STATUS_TITLE"

# 14. status shows slice count
assert_contains "status shows slice count" "1" "$STATUS_TITLE"

echo ""

# ─── Group 5: Cancel Command ───
echo "── CANCEL COMMAND ──"

# 15. Create sprint → set to running → cancel → shows cancelled
CANCEL_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Cancel Test',
    request: 'Test cancel',
    slices: [{ id: 's1', title: 'Slice 1' }]
  });
  sm.updateSprintStatus(plan.id, 'running');
  console.log(plan.id);
")
node "$VS" cancel "$CANCEL_ID" > /dev/null 2>&1
CANCEL_STATUS=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$CANCEL_ID');
  console.log(plan.status);
")
assert_eq "cancel sets sprint to cancelled" "cancelled" "$CANCEL_STATUS"

# 16. cancel with no active sprint → exits non-zero
CANCEL_TMP=$(mktemp -d)
mkdir -p "$CANCEL_TMP/.vela/sprints"
assert_exit "cancel with no sprint exits non-zero" 1 bash -c "cd '$CANCEL_TMP' && node '$VS' cancel 2>&1"
rm -rf "$CANCEL_TMP"

echo ""

# ─── Group 6: Error Cases ───
echo "── ERROR CASES ──"

# 17. run with no request → exits non-zero
assert_exit "run with no request exits non-zero" 1 node "$VS" run

# 18. resume with no active sprint → exits non-zero
RESUME_TMP=$(mktemp -d)
mkdir -p "$RESUME_TMP/.vela/sprints"
assert_exit "resume with no active sprint exits non-zero" 1 bash -c "cd '$RESUME_TMP' && node '$VS' resume 2>&1"
rm -rf "$RESUME_TMP"

# 19. resume with invalid ID → exits non-zero
assert_exit "resume with invalid ID exits non-zero" 1 node "$VS" resume invalid-id-999

echo ""

# ─── Group 7: Lock ───
echo "── LOCK ──"

# 20. Lock path is .sprint.lock (grep in source)
LOCK_GREP=$(grep -c '\.sprint\.lock' "$VS")
assert_eq "lock path contains .sprint.lock" "true" "$([ "$LOCK_GREP" -ge 1 ] && echo true || echo false)"

# 21. Lock is separate from .orchestrator.lock (verify different names)
HAS_ORCH=$(grep -c '\.orchestrator\.lock' "$VS" || true)
assert_eq "lock is not .orchestrator.lock" "0" "$HAS_ORCH"

# 22. Lock file is in .vela/state/ (verify path structure)
LOCK_PATH_CHECK=$(grep -c 'state.*\.sprint\.lock' "$VS")
assert_eq "lock file in .vela/state/" "true" "$([ "$LOCK_PATH_CHECK" -ge 1 ] && echo true || echo false)"

# ─── Group 8: Sprint Summary Generation ───
echo "── SUMMARY GENERATION ──"

# Create sprint with 2 slices, mark both done with timing
SUM_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Summary Gen Test',
    request: 'Test summary generation',
    slices: [
      { id: 'x1', title: 'First Slice' },
      { id: 'x2', title: 'Second Slice', depends_on: ['x1'] }
    ]
  });
  sm.updateSprintStatus(plan.id, 'running');
  // Slice x1: done
  sm.updateSliceStatus(plan.id, 'x1', { status: 'queued' });
  sm.updateSliceStatus(plan.id, 'x1', { status: 'running', started_at: '2026-04-07T10:00:00Z' });
  sm.updateSliceStatus(plan.id, 'x1', { status: 'done', result: 'x1 completed ok', completed_at: '2026-04-07T10:05:00Z' });
  // Slice x2: done
  sm.updateSliceStatus(plan.id, 'x2', { status: 'queued' });
  sm.updateSliceStatus(plan.id, 'x2', { status: 'running', started_at: '2026-04-07T10:05:00Z' });
  sm.updateSliceStatus(plan.id, 'x2', { status: 'done', result: 'x2 completed ok', completed_at: '2026-04-07T10:12:30Z' });
  sm.updateSprintStatus(plan.id, 'done');
  console.log(plan.id);
")

# 23. generateSprintSummary is exported
GSS_TYPE=$(node -e "console.log(typeof require('$VS').generateSprintSummary)")
assert_eq "exports generateSprintSummary as function" "function" "$GSS_TYPE"

# 24. Call generateSprintSummary → file created
SUM_PATH=$(node -e "
  const { generateSprintSummary } = require('$VS');
  const sm = require('$SM');
  const plan = sm.loadSprint('$SUM_ID');
  const p = generateSprintSummary(plan);
  console.log(p);
")
assert_eq "sprint-summary.md was created" "true" "$([ -f "$SUM_PATH" ] && echo true || echo false)"

# 25. Summary contains sprint title
SUM_CONTENT=$(cat "$SUM_PATH")
assert_contains "summary contains sprint title" "Summary Gen Test" "$SUM_CONTENT"

# 26. Summary contains table header
assert_contains "summary contains table header" "| ID | Title | Status | Duration | Result |" "$SUM_CONTENT"

# 27. Summary contains stats section
assert_contains "summary contains Stats heading" "## Stats" "$SUM_CONTENT"

# 28. Summary contains completed count 2
assert_contains "summary shows 2 completed" "**Completed:** 2" "$SUM_CONTENT"

# 29. Summary contains slice x1 duration (300s = 300.0s)
assert_contains "summary contains x1 duration" "300.0s" "$SUM_CONTENT"

# 30. Summary contains request
assert_contains "summary contains request" "Test summary generation" "$SUM_CONTENT"

echo ""

# ─── Summary ───
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "ALL PASS"
