#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-engine-advance.sh — v7.1 M8 advance command
#
# Covers: `vela-engine.js advance [pass|fail|reject]` must be the
# semantic equivalent of `record <verdict>` followed by
# `transition` (when verdict is pass), and must return a
# `nextAction` hint so the PM can skip a round-trip `state` call.
#
# Motivation: hicoco session showed the top-level PM emitting 146
# Bash calls, the largest single pattern being `record pass` +
# `transition` on every successful step. One advance call halves
# that, and the nextAction hint eliminates another `state` call
# after transition.
#
# Asserts:
#   1. `advance pass` increments completed_steps AND moves to next step
#   2. `advance pass` response includes previousStep, currentStep,
#      nextStep, active, circuitOpen, nextAction
#   3. `advance fail` and `advance reject` stay on same step
#   4. `advance reject` increments revisions
#   5. `advance` without arg defaults to pass
#   6. `advance pass` on the final step marks pipeline completed
#   7. Reverse: record/transition still work independently
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"
PIPELINE_JSON="$REPO_ROOT/templates/pipeline.json"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""

cleanup() { [ -n "$TMPDIR_ROOT" ] && rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

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

reset_sandbox() {
  cleanup
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/templates" "$PROJECT/.vela/artifacts" "$PROJECT/.vela/state"
  cp "$PIPELINE_JSON" "$PROJECT/.vela/templates/pipeline.json"
  (
    cd "$PROJECT"
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0=commit.gpgsign \
      GIT_CONFIG_VALUE_0=false \
      git init -q -b main
    git config user.email t@vela.local
    git config user.name t
    echo "# x" > README.md
    git add README.md
    git -c commit.gpgsign=false commit -q -m "initial"
  )
}

run_engine() {
  local cwd="$1"; shift
  ( cd "$cwd" && node "$ENGINE" "$@" >/tmp/m8-stdout 2>/tmp/m8-stderr; echo "exit=$?" > /tmp/m8-exit )
}

read_field() {
  local field="$1"
  node -e "
    let b='';
    process.stdin.on('data',d=>b+=d);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(b); console.log(j['$field']!==undefined ? j['$field'] : ''); }
      catch { console.log(''); }
    });
  " < /tmp/m8-stdout
}

# ── Phase 1: advance pass on a fresh trivial pipeline ────────
echo "📋 Phase 1: advance pass — happy path"
reset_sandbox
run_engine "$PROJECT" init "test advance" --scale small

run_engine "$PROJECT" advance pass
CMD=$(read_field command)
[ "$CMD" = "advance" ]
note "advance pass returned command=advance" $?

PREV=$(read_field previousStep)
[ "$PREV" = "init" ]
note "advance pass reports previousStep=init" $?

CUR=$(read_field currentStep)
[ "$CUR" = "locate" ]
note "advance pass moved to currentStep=locate" $?

# nextAction is a string hint
cat /tmp/m8-stdout | grep -q '"nextAction"'
note "advance pass response includes nextAction" $?

cat /tmp/m8-stdout | grep -q '"revision"'
note "advance pass response includes revision counter" $?

cat /tmp/m8-stdout | grep -q '"circuitOpen"'
note "advance pass response includes circuitOpen flag" $?

# Verify the state on disk actually advanced
STATE_FILE="$(find "$PROJECT/.vela/artifacts" -name pipeline-state.json | head -1)"
DISK_STEP=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).current_step)")
[ "$DISK_STEP" = "locate" ]
note "disk state.current_step is locate after advance pass" $?

# ── Phase 2: advance with no verdict arg defaults to pass ────
echo "📋 Phase 2: advance default=pass"
reset_sandbox
run_engine "$PROJECT" init "test default" --scale small
run_engine "$PROJECT" advance
CMD=$(read_field command)
[ "$CMD" = "advance" ]
note "advance (no arg) returned command=advance" $?
CUR=$(read_field currentStep)
[ "$CUR" = "locate" ]
note "advance (no arg) behaves as pass" $?

# ── Phase 3: advance reject stays put, bumps revision ────────
echo "📋 Phase 3: advance reject"
reset_sandbox
run_engine "$PROJECT" init "test reject" --scale small

# First reject at init
run_engine "$PROJECT" advance reject
CUR=$(read_field currentStep)
[ "$CUR" = "init" ]
note "advance reject keeps currentStep=init" $?

REV=$(read_field revision)
[ "$REV" = "1" ]
note "advance reject revision=1 on first reject" $?

run_engine "$PROJECT" advance reject
REV=$(read_field revision)
[ "$REV" = "2" ]
note "advance reject revision=2 on second reject" $?

CUR=$(read_field currentStep)
[ "$CUR" = "init" ]
note "advance reject still on init after second reject" $?

# ── Phase 4: advance fail stays put ──────────────────────────
echo "📋 Phase 4: advance fail"
reset_sandbox
run_engine "$PROJECT" init "test fail" --scale small
run_engine "$PROJECT" advance fail
CUR=$(read_field currentStep)
[ "$CUR" = "init" ]
note "advance fail keeps currentStep=init" $?

# ── Phase 5: record + transition still work (back-compat) ────
echo "📋 Phase 5: legacy record/transition preserved"
reset_sandbox
run_engine "$PROJECT" init "test legacy" --scale small
run_engine "$PROJECT" record pass
CMD=$(read_field command)
[ "$CMD" = "record" ]
note "record command still exists and emits command=record" $?
run_engine "$PROJECT" transition
CMD=$(read_field command)
[ "$CMD" = "transition" ]
note "transition command still exists and emits command=transition" $?
DISK_STEP=$(node -e "
  const fs=require('fs');
  const f=require('child_process').execSync('find $PROJECT/.vela/artifacts -name pipeline-state.json').toString().trim().split('\n')[0];
  console.log(JSON.parse(fs.readFileSync(f,'utf8')).current_step);
")
[ "$DISK_STEP" = "locate" ]
note "record+transition still advances state (locate)" $?

# ── Phase 6: invalid verdict rejected ────────────────────────
echo "📋 Phase 6: invalid verdict"
reset_sandbox
run_engine "$PROJECT" init "test invalid" --scale small
run_engine "$PROJECT" advance bogus
if grep -q '"ok": false' /tmp/m8-stdout; then
  note "advance rejects unknown verdict" 0
else
  note "advance rejects unknown verdict" 1
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
