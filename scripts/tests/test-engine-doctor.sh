#!/usr/bin/env bash
# scripts/tests/test-engine-doctor.sh
#
# v8.0-M6: rewritten for plugin layout.
#
# cmdDoctor (scripts/commands/doctor.js) now validates:
#   - CLAUDE_PLUGIN_ROOT env + plugin artifacts (.claude-plugin/,
#     hooks/hooks.json, agents/, scripts/cli/vela-engine.js, hooks)
#   - project-local .vela/ (templates, state/workspace.json,
#     config.json, artifacts/)
#   - pipeline.json has v8.0 pipelines (ship, fix, hotfix)
#
# Fixture setup uses `init-project` from the engine (formerly
# install.js handled bootstrap — deleted in M5).
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers/setup-plugin-env.sh"

ENGINE="$REPO_ROOT/scripts/cli/vela-engine.js"

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

setup_fixture() {
  cleanup
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT"
  vela_bootstrap_fixture "$PROJECT" >/dev/null 2>&1
}

run_doctor() {
  local code=0
  (
    cd "$PROJECT"
    INIT_CWD="$PROJECT" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
      node "$ENGINE" doctor >/tmp/m6-stdout 2>/tmp/m6-stderr
  ) || code=$?
  echo "$code"
}

# ── Phase 1: healthy fixture → ok:true ────────────────────────
echo "📋 Phase 1: healthy fixture → ok:true"
setup_fixture

EXIT=$(run_doctor)
[ "$EXIT" = "0" ]
note "doctor exit code 0 on healthy fixture" $?

grep -q '"ok": true' /tmp/m6-stdout
note "doctor reports ok:true on healthy fixture" $?

grep -q '"command": "doctor"' /tmp/m6-stdout
note "doctor output has command:doctor" $?

# No missing list when healthy
MISSING_LEN=$(node -e "
  const j=JSON.parse(require('fs').readFileSync('/tmp/m6-stdout','utf8'));
  console.log((j.missing || []).length);
")
[ "$MISSING_LEN" = "0" ]
note "doctor: missing[] is empty on healthy fixture (got length $MISSING_LEN)" $?

# pluginRoot field is populated
PLUGIN_ROOT_JSON=$(node -e "
  const j=JSON.parse(require('fs').readFileSync('/tmp/m6-stdout','utf8'));
  console.log(j.pluginRoot || '(null)');
")
[ "$PLUGIN_ROOT_JSON" = "$REPO_ROOT" ]
note "doctor reports pluginRoot=$REPO_ROOT" $?

# ── Phase 2: v7.1 template artifacts checked ─────────────────
echo "📋 Phase 2: v7.1 template artifacts all present"

for required in \
  "file:.vela/templates/role-budgets.json" \
  "file:.vela/templates/plan-templates/quick.md" \
  "file:.vela/templates/guidelines/live-processes.json" \
  "file:.vela/templates/guidelines/smoke-test.sh.example"; do
  RESULT=$(node -e "
    const fs=require('fs');
    const j=JSON.parse(fs.readFileSync('/tmp/m6-stdout','utf8'));
    const hit = (j.checks || []).find(c => c.name === process.argv[1]);
    console.log(hit ? (hit.ok ? 'ok' : 'fail') : 'missing');
  " "$required")
  if [ "$RESULT" = "ok" ]; then
    note "doctor check present and passing: $required" 0
  else
    note "doctor check present and passing: $required ($RESULT)" 1
  fi
done

# ── Phase 3: removing a core file → ok:false ────────────────
echo "📋 Phase 3: removing a core file makes doctor FAIL"
setup_fixture

rm "$PROJECT/.vela/templates/role-budgets.json"

EXIT=$(run_doctor)
grep -q '"ok": false' /tmp/m6-stdout
note "doctor reports ok:false after removing role-budgets.json" $?

grep -q 'role-budgets.json' /tmp/m6-stdout
note "doctor missing[] includes role-budgets.json" $?

grep -q '/vela:install' /tmp/m6-stdout
note "doctor recovery message references /vela:install" $?

# ── Phase 4: multiple missing files all reported ────────────
echo "📋 Phase 4: multiple missing files all reported"
setup_fixture

rm "$PROJECT/.vela/templates/plan-templates/quick.md"
rm "$PROJECT/.vela/templates/guidelines/smoke-test.sh.example"

EXIT=$(run_doctor)
grep -q 'quick.md' /tmp/m6-stdout
note "doctor reports missing plan-templates/quick.md" $?

grep -q 'smoke-test.sh.example' /tmp/m6-stdout
note "doctor reports missing smoke-test.sh.example" $?

# ── Phase 5: plugin-root env missing → actionable message ───
echo "📋 Phase 5: CLAUDE_PLUGIN_ROOT unset → recovery suggests /plugin install"
setup_fixture

(
  cd "$PROJECT"
  env -u CLAUDE_PLUGIN_ROOT node "$ENGINE" doctor >/tmp/m6-stdout 2>/tmp/m6-stderr
) || true
grep -q 'plugin:CLAUDE_PLUGIN_ROOT' /tmp/m6-stdout
note "doctor flags plugin:CLAUDE_PLUGIN_ROOT check" $?

grep -q '/plugin install vela' /tmp/m6-stdout
note "doctor recovery suggests /plugin install vela when env unset" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
