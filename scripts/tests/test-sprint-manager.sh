#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sprint-manager.sh — sprint-manager.js 계약 테스트
#
# 25+ assertions covering CRUD, validation, FSM transitions,
# and dependency-aware queue system.
#
# Groups:
#   CRUD      — createSprint, loadSprint, findActiveSprint, listSprints
#   VALIDATE  — validateSprintPlan (valid, missing fields, dupes, cycles, bad deps)
#   QUEUE     — getNextSlice (linear deps, parallel, complete, halt, wait, blocked)
#   TRANSITION — updateSliceStatus, updateSprintStatus (valid + invalid)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SM="$PROJECT_ROOT/scripts/shared/sprint-manager.js"

PASS=0
FAIL=0
TOTAL=0

# ─── Setup temp sprint directory ───

ORIG_SPRINTS_DIR=""
TMP_DIR=$(mktemp -d)
TMP_SPRINTS="$TMP_DIR/.vela/sprints"
mkdir -p "$TMP_SPRINTS"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

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

# Helper: run node with sprint-manager loaded, override SPRINTS_DIR to tmp
run_node() {
  node -e "
    const sm = require('$SM');
    // Override SPRINTS_DIR to temp directory
    const origDir = sm.SPRINTS_DIR;
    Object.defineProperty(sm, 'SPRINTS_DIR', { value: '$TMP_SPRINTS', writable: true, configurable: true });
    // Patch module-level constant used by functions via re-require trick:
    // Since SPRINTS_DIR is a const used inside closures, we need a different approach.
    // We'll pass the dir explicitly or use process.chdir.
    $1
  " 2>&1
}

# Since sprint-manager uses SPRINTS_DIR as a module const, we override by
# changing cwd and making SPRINTS_DIR relative — but it's hardcoded as '.vela/sprints'.
# Solution: run all tests from TMP_DIR so '.vela/sprints' resolves to TMP_SPRINTS.
cd "$TMP_DIR"

echo "═══════════════════════════════════════════════════"
echo "  sprint-manager.js contract tests"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── CRUD Group ───
echo "── CRUD ──"

# 1. createSprint round-trip: file exists
SPRINT_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Test Sprint',
    request: 'Build feature X',
    slices: [
      { id: 's1', title: 'Slice One' },
      { id: 's2', title: 'Slice Two', depends_on: ['s1'] }
    ]
  });
  console.log(plan.id);
")
PLAN_FILE="$TMP_SPRINTS/$SPRINT_ID/sprint-plan.json"
assert_eq "createSprint creates sprint-plan.json" "true" "$([ -f "$PLAN_FILE" ] && echo true || echo false)"

# 2. createSprint field verification
FIELDS=$(node -e "
  const fs = require('fs');
  const plan = JSON.parse(fs.readFileSync('$PLAN_FILE', 'utf8'));
  const checks = [
    plan.version === '1.0',
    plan.title === 'Test Sprint',
    plan.request === 'Build feature X',
    plan.status === 'planned',
    plan.slices.length === 2,
    plan.slices[0].status === 'planned',
    plan.slices[1].depends_on[0] === 's1',
    plan.total_slices === 2,
    plan.completed_slices === 0,
    plan.context_passing === true,
  ];
  console.log(checks.every(Boolean) ? 'all_ok' : 'mismatch');
")
assert_eq "createSprint fields are correct" "all_ok" "$FIELDS"

# 3. loadSprint returns identical data
LOAD_CHECK=$(node -e "
  const sm = require('$SM');
  const loaded = sm.loadSprint('$SPRINT_ID');
  console.log(loaded.title === 'Test Sprint' && loaded.slices.length === 2 ? 'match' : 'mismatch');
")
assert_eq "loadSprint returns same data" "match" "$LOAD_CHECK"

# 4. findActiveSprint returns null for planned sprint
ACTIVE=$(node -e "
  const sm = require('$SM');
  const result = sm.findActiveSprint();
  console.log(result === null ? 'null' : result.id);
")
assert_eq "findActiveSprint returns null for planned sprint" "null" "$ACTIVE"

# 5. findActiveSprint returns running sprint
node -e "
  const sm = require('$SM');
  sm.updateSprintStatus('$SPRINT_ID', 'running');
" > /dev/null
ACTIVE2=$(node -e "
  const sm = require('$SM');
  const result = sm.findActiveSprint();
  console.log(result ? result.id : 'null');
")
assert_eq "findActiveSprint returns running sprint" "$SPRINT_ID" "$ACTIVE2"

# Reset back to planned for further tests — need to create a fresh sprint
# (can't go running→planned, so create new one)

# 6. listSprints returns at least 1
LIST_COUNT=$(node -e "
  const sm = require('$SM');
  const list = sm.listSprints();
  console.log(list.length);
")
assert_eq "listSprints returns at least 1 sprint" "true" "$([ "$LIST_COUNT" -ge 1 ] && echo true || echo false)"

# 7. listSprints summary fields present
LIST_FIELDS=$(node -e "
  const sm = require('$SM');
  const list = sm.listSprints();
  const first = list[0];
  const ok = first.id && first.title && first.status && first.created_at !== undefined && first.total_slices !== undefined && first.completed_slices !== undefined;
  console.log(ok ? 'ok' : 'missing');
")
assert_eq "listSprints summary has all fields" "ok" "$LIST_FIELDS"

echo ""

# ─── Validation Group ───
echo "── VALIDATION ──"

# 8. Valid plan returns valid:true
VALID=$(node -e "
  const sm = require('$SM');
  const result = sm.validateSprintPlan({
    version: '1.0', id: 'test', title: 'T', request: 'R', status: 'planned',
    slices: [{ id: 's1', status: 'planned', depends_on: [] }]
  });
  console.log(result.valid);
")
assert_eq "validateSprintPlan valid plan → valid:true" "true" "$VALID"

# 9. Missing required field → valid:false
INVALID_MISSING=$(node -e "
  const sm = require('$SM');
  const result = sm.validateSprintPlan({
    version: '1.0', id: 'test', status: 'planned',
    slices: [{ id: 's1', status: 'planned' }]
  });
  console.log(result.valid + '|' + result.errors.some(e => e.includes('missing required field')));
")
assert_eq "validateSprintPlan missing fields → valid:false" "false|true" "$INVALID_MISSING"

# 10. Duplicate slice IDs → error
DUP_RESULT=$(node -e "
  const sm = require('$SM');
  const result = sm.validateSprintPlan({
    version: '1.0', id: 'test', title: 'T', request: 'R', status: 'planned',
    slices: [
      { id: 's1', status: 'planned' },
      { id: 's1', status: 'planned' }
    ]
  });
  console.log(result.valid + '|' + result.errors.some(e => e.includes('duplicate slice id')));
")
assert_eq "validateSprintPlan duplicate slice IDs → error" "false|true" "$DUP_RESULT"

# 11. Dependency cycle → error
CYCLE_RESULT=$(node -e "
  const sm = require('$SM');
  const result = sm.validateSprintPlan({
    version: '1.0', id: 'test', title: 'T', request: 'R', status: 'planned',
    slices: [
      { id: 's1', status: 'planned', depends_on: ['s2'] },
      { id: 's2', status: 'planned', depends_on: ['s1'] }
    ]
  });
  console.log(result.valid + '|' + result.errors.some(e => e.includes('dependency cycle')));
")
assert_eq "validateSprintPlan cycle → error" "false|true" "$CYCLE_RESULT"

# 12. Unknown dependency reference → error
BAD_DEP=$(node -e "
  const sm = require('$SM');
  const result = sm.validateSprintPlan({
    version: '1.0', id: 'test', title: 'T', request: 'R', status: 'planned',
    slices: [
      { id: 's1', status: 'planned', depends_on: ['nonexistent'] }
    ]
  });
  console.log(result.valid + '|' + result.errors.some(e => e.includes('unknown slice')));
")
assert_eq "validateSprintPlan bad dependency → error" "false|true" "$BAD_DEP"

echo ""

# ─── Queue Group ───
echo "── QUEUE ──"

# Create a fresh sprint for queue tests
QUEUE_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Queue Test',
    request: 'Test queue system',
    slices: [
      { id: 's1', title: 'First' },
      { id: 's2', title: 'Second', depends_on: ['s1'] },
      { id: 's3', title: 'Third', depends_on: ['s2'] }
    ]
  });
  console.log(plan.id);
")

# 13. Linear dependency: s1 is next (no deps)
NEXT1=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$QUEUE_ID');
  const result = sm.getNextSlice(plan);
  console.log(result.action + '|' + (result.slice ? result.slice.id : 'none'));
")
assert_eq "getNextSlice linear: s1 ready (no deps)" "run|s1" "$NEXT1"

# 14. After s1 done → s2 is next
node -e "
  const sm = require('$SM');
  sm.updateSprintStatus('$QUEUE_ID', 'running');
  sm.updateSliceStatus('$QUEUE_ID', 's1', { status: 'queued' });
  sm.updateSliceStatus('$QUEUE_ID', 's1', { status: 'running' });
  sm.updateSliceStatus('$QUEUE_ID', 's1', { status: 'done' });
" > /dev/null
NEXT2=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$QUEUE_ID');
  const result = sm.getNextSlice(plan);
  console.log(result.action + '|' + (result.slice ? result.slice.id : 'none'));
")
assert_eq "getNextSlice after s1 done → s2 ready" "run|s2" "$NEXT2"

# 15. Running slice → wait
node -e "
  const sm = require('$SM');
  sm.updateSliceStatus('$QUEUE_ID', 's2', { status: 'queued' });
  sm.updateSliceStatus('$QUEUE_ID', 's2', { status: 'running' });
" > /dev/null
WAIT=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$QUEUE_ID');
  const result = sm.getNextSlice(plan);
  console.log(result.action + '|' + (result.slice ? result.slice.id : 'none'));
")
assert_eq "getNextSlice running slice → wait" "wait|s2" "$WAIT"

# 16. All done → complete
node -e "
  const sm = require('$SM');
  sm.updateSliceStatus('$QUEUE_ID', 's2', { status: 'done' });
  sm.updateSliceStatus('$QUEUE_ID', 's3', { status: 'queued' });
  sm.updateSliceStatus('$QUEUE_ID', 's3', { status: 'running' });
  sm.updateSliceStatus('$QUEUE_ID', 's3', { status: 'done' });
" > /dev/null
COMPLETE=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$QUEUE_ID');
  const result = sm.getNextSlice(plan);
  console.log(result.action);
")
assert_eq "getNextSlice all done → complete" "complete" "$COMPLETE"

# 17. Failed slice → halt
HALT_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Halt Test',
    request: 'Test halt',
    slices: [
      { id: 's1', title: 'First' },
      { id: 's2', title: 'Second', depends_on: ['s1'] }
    ]
  });
  sm.updateSprintStatus(plan.id, 'running');
  sm.updateSliceStatus(plan.id, 's1', { status: 'queued' });
  sm.updateSliceStatus(plan.id, 's1', { status: 'running' });
  sm.updateSliceStatus(plan.id, 's1', { status: 'failed' });
  console.log(plan.id);
")
HALT=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$HALT_ID');
  const result = sm.getNextSlice(plan);
  console.log(result.action);
")
assert_eq "getNextSlice failed slice → halt" "halt" "$HALT"

# 18. Parallel slices: no deps, first is selected
PARALLEL_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Parallel Test',
    request: 'Test parallel',
    slices: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' }
    ]
  });
  console.log(plan.id);
")
PARALLEL=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$PARALLEL_ID');
  const result = sm.getNextSlice(plan);
  console.log(result.action + '|' + (result.slice ? result.slice.id : 'none'));
")
assert_eq "getNextSlice parallel: first available slice" "run|a" "$PARALLEL"

# 19. Deadlock / blocked: queued slices with unresolvable deps
BLOCKED=$(node -e "
  const sm = require('$SM');
  // Construct plan in memory with unsatisfied deps (all planned, none terminal)
  const plan = {
    version: '1.0', id: 'blocked-test', title: 'B', request: 'R', status: 'running',
    slices: [
      { id: 's1', title: 'S1', status: 'planned', depends_on: ['s2'] },
      { id: 's2', title: 'S2', status: 'planned', depends_on: ['s1'] }
    ]
  };
  const result = sm.getNextSlice(plan);
  console.log(result.action);
")
assert_eq "getNextSlice deadlock → blocked" "blocked" "$BLOCKED"

echo ""

# ─── Transition Group ───
echo "── TRANSITIONS ──"

# Create fresh sprint for transition tests
TRANS_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Transition Test',
    request: 'Test transitions',
    slices: [{ id: 's1', title: 'Slice 1' }]
  });
  console.log(plan.id);
")

# 20. Valid slice transitions: planned→queued
node -e "
  const sm = require('$SM');
  sm.updateSliceStatus('$TRANS_ID', 's1', { status: 'queued' });
" > /dev/null
S1_STATUS=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$TRANS_ID');
  console.log(plan.slices[0].status);
")
assert_eq "slice transition planned→queued" "queued" "$S1_STATUS"

# 21. Valid slice transitions: queued→running
node -e "
  const sm = require('$SM');
  sm.updateSliceStatus('$TRANS_ID', 's1', { status: 'running' });
" > /dev/null
S1_STATUS2=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$TRANS_ID');
  console.log(plan.slices[0].status);
")
assert_eq "slice transition queued→running" "running" "$S1_STATUS2"

# 22. Valid slice transitions: running→done
node -e "
  const sm = require('$SM');
  sm.updateSliceStatus('$TRANS_ID', 's1', { status: 'done' });
" > /dev/null
S1_STATUS3=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$TRANS_ID');
  console.log(plan.slices[0].status);
")
assert_eq "slice transition running→done" "done" "$S1_STATUS3"

# 23. completed_slices recomputed after done
COMP_COUNT=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$TRANS_ID');
  console.log(plan.completed_slices);
")
assert_eq "completed_slices recomputed after done" "1" "$COMP_COUNT"

# 24. Invalid slice transition: planned→done → throws
TRANS2_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Invalid Trans',
    request: 'Test invalid',
    slices: [{ id: 's1', title: 'S1' }]
  });
  console.log(plan.id);
")
INVALID_TRANS=$(node -e "
  const sm = require('$SM');
  try {
    sm.updateSliceStatus('$TRANS2_ID', 's1', { status: 'done' });
    console.log('no_error');
  } catch (e) {
    console.log(e.message.includes('invalid transition') ? 'caught' : 'wrong_error');
  }
")
assert_eq "invalid slice transition planned→done → throws" "caught" "$INVALID_TRANS"

# 25. Valid sprint transition: planned→running
SPRINT_TRANS_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Sprint Trans',
    request: 'Test sprint trans',
    slices: [{ id: 's1', title: 'S1' }]
  });
  console.log(plan.id);
")
node -e "
  const sm = require('$SM');
  sm.updateSprintStatus('$SPRINT_TRANS_ID', 'running');
" > /dev/null
SP_STATUS=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$SPRINT_TRANS_ID');
  console.log(plan.status);
")
assert_eq "sprint transition planned→running" "running" "$SP_STATUS"

# 26. Valid sprint transition: running→done
node -e "
  const sm = require('$SM');
  sm.updateSprintStatus('$SPRINT_TRANS_ID', 'done');
" > /dev/null
SP_STATUS2=$(node -e "
  const sm = require('$SM');
  const plan = sm.loadSprint('$SPRINT_TRANS_ID');
  console.log(plan.status);
")
assert_eq "sprint transition running→done" "done" "$SP_STATUS2"

# 27. Invalid sprint transition: planned→done → throws
SPRINT_TRANS2_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Invalid Sprint',
    request: 'Test invalid sprint',
    slices: [{ id: 's1', title: 'S1' }]
  });
  console.log(plan.id);
")
INVALID_SP=$(node -e "
  const sm = require('$SM');
  try {
    sm.updateSprintStatus('$SPRINT_TRANS2_ID', 'done');
    console.log('no_error');
  } catch (e) {
    console.log(e.message.includes('invalid transition') ? 'caught' : 'wrong_error');
  }
")
assert_eq "invalid sprint transition planned→done → throws" "caught" "$INVALID_SP"

# 28. Unknown slice ID → throws
UNKNOWN_SLICE=$(node -e "
  const sm = require('$SM');
  try {
    sm.updateSliceStatus('$SPRINT_TRANS_ID', 'nonexistent', { status: 'queued' });
    console.log('no_error');
  } catch (e) {
    console.log(e.message.includes('not found') ? 'caught' : 'wrong_error');
  }
")
assert_eq "updateSliceStatus unknown slice → throws" "caught" "$UNKNOWN_SLICE"

# 29. Skipped slice counts as completed
SKIP_ID=$(node -e "
  const sm = require('$SM');
  const plan = sm.createSprint({
    title: 'Skip Test',
    request: 'Test skip',
    slices: [
      { id: 's1', title: 'S1' },
      { id: 's2', title: 'S2' }
    ]
  });
  sm.updateSliceStatus(plan.id, 's1', { status: 'skipped' });
  const updated = sm.loadSprint(plan.id);
  console.log(updated.completed_slices);
")
assert_eq "skipped slice counts as completed" "1" "$SKIP_ID"

# 30. cleanSprint strips internal fields
CLEAN=$(node -e "
  const sm = require('$SM');
  const result = sm.cleanSprint({ id: 'test', _path: '/tmp/x', _sprintDir: '/tmp/y', title: 'T' });
  console.log(result._path === undefined && result._sprintDir === undefined && result.id === 'test' ? 'clean' : 'dirty');
")
assert_eq "cleanSprint strips _path and _sprintDir" "clean" "$CLEAN"

echo ""

# ─── Summary ───
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "ALL PASS"
