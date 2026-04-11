#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-commit-not-a-repo.sh — v7.1 M1 commit/branch non-git guard
#
# Covers: vela-engine.js cmdInit/cmdCommit/cmdBranch must fail loud
# when the project has no .git/ directory, instead of silently
# reporting `skipped: true` like v7.0.x did. Based on the hicoco
# session where 4 pipelines completed `commit` with skipped:true,
# and the user only realised their work had never been persisted
# when reading the final report.
#
# Asserts:
#   1. cmdInit includes a `pipelineWarnings` array and git.repo=false
#      when the project is not a git repo
#   2. cmdInit prints a non-git warning to stderr
#   3. cmdCommit returns status:"blocked" with a recovery array
#      (not status:"skipped")
#   4. cmdCommit prints the multi-line BLOCKED banner to stderr
#   5. cmdBranch returns status:"blocked" with a recovery array
#   6. Reverse sanity: in a git-initialised project the same commands
#      do NOT set status:"blocked" and do NOT emit the banner
# ──────────────────────────────────────────────────────────────
# Intentionally NOT using `set -e`. Many assertions are `grep -q … ; note $?`
# and a failed grep under set -e kills the run before the assertion even
# reports. pipefail is OK because we never pipe-and-continue.
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
  # $2 is a shell exit code: 0 = success = PASS, nonzero = FAIL.
  # Matches the `cmd; note "label" $?` idiom used throughout.
  TOTAL=$((TOTAL + 1))
  local label="$1" code="$2"
  if [ "$code" = "0" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

setup_non_git_project() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/templates"
  mkdir -p "$PROJECT/.vela/artifacts"
  mkdir -p "$PROJECT/.vela/state"
  cp "$PIPELINE_JSON" "$PROJECT/.vela/templates/pipeline.json"
  # NO git init — that's the whole point of this test.
}

setup_git_project() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/templates"
  mkdir -p "$PROJECT/.vela/artifacts"
  mkdir -p "$PROJECT/.vela/state"
  cp "$PIPELINE_JSON" "$PROJECT/.vela/templates/pipeline.json"
  (
    cd "$PROJECT"
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0=commit.gpgsign \
      GIT_CONFIG_VALUE_0=false \
      git init -q -b main
    git config user.email "test@vela.local"
    git config user.name "Vela Test"
    git config commit.gpgsign false
    echo "# test" > README.md
    git add README.md
    git commit -q -m "initial"
  )
}

run_engine() {
  local cwd="$1"
  shift
  ( cd "$cwd" && node "$ENGINE" "$@" >/tmp/m1-stdout 2>/tmp/m1-stderr; echo "exit=$?" > /tmp/m1-exit )
}

# ── Phase 1: non-git project — init ──────────────────────────
echo "📋 Phase 1: init warns about missing git"
setup_non_git_project

run_engine "$PROJECT" init "test task" --scale small >/dev/null
STDOUT="$(cat /tmp/m1-stdout)"
STDERR="$(cat /tmp/m1-stderr)"

echo "$STDOUT" | grep -q '"git"' && echo "$STDOUT" | grep -q '"repo": false'
note "init stdout contains git.repo:false" $?

echo "$STDOUT" | grep -q '"pipelineWarnings"'
note "init stdout contains pipelineWarnings array" $?

echo "$STDOUT" | grep -q '"not_a_git_repo"'
note "init warning uses code 'not_a_git_repo'" $?

echo "$STDERR" | grep -q "non-git project detected"
note "init stderr shows non-git banner" $?

# Advance to a step where we can call branch. The non-git project
# should have its pipeline-state.json created OK but git=null inside.
# We can't rely on pipeline progression here, so we hand-edit the
# state to sit at `commit` directly.

STATE_FILE="$(find "$PROJECT/.vela/artifacts" -name pipeline-state.json | head -1)"
[ -n "$STATE_FILE" ]
note "artifact dir + pipeline-state.json were created" $?

# Force current_step to commit so cmdCommit runs the guard we care about
node -e "
const fs=require('fs');
const p='$STATE_FILE';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
s.current_step='commit';
s.git=null;
fs.writeFileSync(p,JSON.stringify(s,null,2));
"

# ── Phase 2: cmdCommit blocks loudly ─────────────────────────
echo "📋 Phase 2: commit is BLOCKED, not silently skipped"
run_engine "$PROJECT" commit >/dev/null
STDOUT="$(cat /tmp/m1-stdout)"
STDERR="$(cat /tmp/m1-stderr)"

echo "$STDOUT" | grep -q '"status": "blocked"'
note "commit stdout contains status:blocked" $?

echo "$STDOUT" | grep -q '"reason": "not a git repo"'
note "commit stdout contains reason:not a git repo" $?

echo "$STDOUT" | grep -q '"recovery"'
note "commit stdout contains recovery array" $?

# Regression: status:blocked replaces status:skipped.
# PASS condition = grep does NOT find skipped:true → grep exit 1 → invert to 0.
if echo "$STDOUT" | grep -q '"skipped": true'; then
  note "commit no longer uses skipped:true (v7.1 replacement)" 1
else
  note "commit no longer uses skipped:true (v7.1 replacement)" 0
fi

echo "$STDERR" | grep -q "Vela commit BLOCKED"
note "commit stderr shows BLOCKED banner" $?

echo "$STDERR" | grep -q "git init -b main"
note "commit stderr includes git init recovery hint" $?

# ── Phase 3: cmdBranch blocks loudly ─────────────────────────
echo "📋 Phase 3: branch is BLOCKED, not silently skipped"
node -e "
const fs=require('fs');
const p='$STATE_FILE';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
s.current_step='branch';
s.git=null;
fs.writeFileSync(p,JSON.stringify(s,null,2));
"
run_engine "$PROJECT" branch >/dev/null
STDOUT="$(cat /tmp/m1-stdout)"
STDERR="$(cat /tmp/m1-stderr)"

echo "$STDOUT" | grep -q '"status": "blocked"'
note "branch stdout contains status:blocked" $?

echo "$STDERR" | grep -q "Vela branch BLOCKED"
note "branch stderr shows BLOCKED banner" $?

# ── Phase 4: reverse sanity on a real git project ────────────
echo "📋 Phase 4: reverse — git project emits no blocked banner"
cleanup
TMPDIR_ROOT=""
setup_git_project

run_engine "$PROJECT" init "test task" --scale small >/dev/null
STDOUT="$(cat /tmp/m1-stdout)"
STDERR="$(cat /tmp/m1-stderr)"

echo "$STDOUT" | grep -q '"repo": true'
note "init on git project shows git.repo:true" $?

if echo "$STDOUT" | grep -q '"pipelineWarnings"'; then
  note "init on git project has no pipelineWarnings" 1
else
  note "init on git project has no pipelineWarnings" 0
fi

if echo "$STDERR" | grep -q "non-git project detected"; then
  note "init on git project emits no non-git stderr" 1
else
  note "init on git project emits no non-git stderr" 0
fi

# Force current_step to branch and run on the git project — should succeed
STATE_FILE="$(find "$PROJECT/.vela/artifacts" -name pipeline-state.json | head -1)"
node -e "
const fs=require('fs');
const p='$STATE_FILE';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
s.current_step='branch';
fs.writeFileSync(p,JSON.stringify(s,null,2));
"
run_engine "$PROJECT" branch >/dev/null
STDOUT="$(cat /tmp/m1-stdout)"
STDERR="$(cat /tmp/m1-stderr)"

if echo "$STDOUT" | grep -q '"status": "blocked"'; then
  note "branch on git project does NOT block" 1
else
  note "branch on git project does NOT block" 0
fi

if echo "$STDERR" | grep -q "Vela branch BLOCKED"; then
  note "branch on git project emits no BLOCKED banner" 1
else
  note "branch on git project emits no BLOCKED banner" 0
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
