#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-engine-doctor.sh — v7.1 M6 engine health check
#
# Covers: `vela-engine.js doctor` must validate that every
# Vela-managed file is present and parseable. Returns
# { ok, missing[], recovery } JSON. Used by agents/vela.md at
# session start so the PM can fail loud (and offer `install.js
# validate`) when .vela/ is incomplete — fixes the hicoco
# ff03bb16 initial session footgun.
#
# Asserts:
#   1. doctor on a fully-installed sandbox returns ok:true
#   2. doctor on a sandbox missing a core file returns ok:false
#      with the missing file in the list
#   3. doctor reports recovery: "node .vela/install.js validate"
#      on failure
#   4. doctor checks each v7.1 new artifact (role-budgets.json,
#      plan-templates/quick.md, guidelines/live-processes.json,
#      guidelines/smoke-test.sh.example) — v7.3-M4에서 vela-file-read-cache 제거
#   5. vela.md session-start snippet documents the doctor call
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"
INSTALL_JS="$REPO_ROOT/scripts/install.js"
VELA_MD="$REPO_ROOT/scripts/agents/vela.md"

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

install_sandbox() {
  cleanup
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  FAKE_HOME="$TMPDIR_ROOT/home"
  mkdir -p "$FAKE_HOME/.claude" "$PROJECT/.vela"
  (
    cd "$PROJECT"
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false \
      git init -q -b main
    git config user.email t@v.local
    git config user.name t
    echo "# x" > README.md
    git add README.md
    git -c commit.gpgsign=false commit -q -m i
  )
  # Run upgrade first (populates .vela/templates/*, hooks/*, etc.),
  # then install (writes .vela/config.json + .vela/state/workspace.json
  # + CLAUDE.md). doctor inspects all of them.
  (
    cd "$PROJECT"
    HOME="$FAKE_HOME" node "$INSTALL_JS" upgrade >/dev/null 2>&1 || true
    HOME="$FAKE_HOME" node "$INSTALL_JS" install >/dev/null 2>&1 || true
  )
}

run_doctor() {
  local code=0
  (
    cd "$PROJECT"
    node "$ENGINE" doctor >/tmp/m6-stdout 2>/tmp/m6-stderr
  ) || code=$?
  echo "$code"
}

# ── Phase 1: healthy install → ok:true ───────────────────────
echo "📋 Phase 1: healthy install → ok:true"
install_sandbox

EXIT=$(run_doctor)
[ "$EXIT" = "0" ]
note "doctor exit code 0 on healthy install" $?

grep -q '"ok": true' /tmp/m6-stdout
note "doctor reports ok:true on healthy install" $?

grep -q '"command": "doctor"' /tmp/m6-stdout
note "doctor output has command:doctor" $?

# No missing list when healthy — parse JSON to avoid newline formatting
MISSING_LEN=$(node -e "
  const j=JSON.parse(require('fs').readFileSync('/tmp/m6-stdout','utf8'));
  console.log((j.missing || []).length);
")
[ "$MISSING_LEN" = "0" ]
note "doctor: missing[] is empty on healthy install (got length $MISSING_LEN)" $?

# ── Phase 2: v7.1 new files checked ──────────────────────────
echo "📋 Phase 2: v7.1 new artifacts all present"

for required in \
  "file:.vela/templates/role-budgets.json" \
  "file:.vela/templates/plan-templates/quick.md" \
  "file:.vela/templates/guidelines/live-processes.json" \
  "file:.vela/templates/guidelines/smoke-test.sh.example"; do
  # Use node to query the JSON directly — multi-line structure makes
  # line-wise grep unreliable (name and ok are on separate lines).
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

# ── Phase 3: missing file → ok:false ─────────────────────────
echo "📋 Phase 3: removing a core file makes doctor FAIL"
install_sandbox

# Corrupt by removing role-budgets.json
rm "$PROJECT/.vela/templates/role-budgets.json"

EXIT=$(run_doctor)
grep -q '"ok": false' /tmp/m6-stdout
note "doctor reports ok:false after removing role-budgets.json" $?

grep -q 'role-budgets.json' /tmp/m6-stdout
note "doctor missing[] includes role-budgets.json" $?

grep -q '"recovery".*install.js validate' /tmp/m6-stdout
note "doctor recovery message references install.js validate" $?

# ── Phase 4: removing multiple → all reported ────────────────
echo "📋 Phase 4: multiple missing files all reported"
install_sandbox

rm "$PROJECT/.vela/templates/plan-templates/quick.md"
rm "$PROJECT/.vela/templates/guidelines/smoke-test.sh.example"

EXIT=$(run_doctor)
grep -q 'quick.md' /tmp/m6-stdout
note "doctor reports missing plan-templates/quick.md" $?

grep -q 'smoke-test.sh.example' /tmp/m6-stdout
note "doctor reports missing smoke-test.sh.example" $?

# ── Phase 5: vela.md documents the call ──────────────────────
echo "📋 Phase 5: vela.md session-start snippet"

grep -q 'doctor' "$VELA_MD"
note "vela.md references doctor command" $?

grep -q 'install.js validate' "$VELA_MD"
note "vela.md mentions install.js validate recovery path" $?

grep -q '1.5단계\|v7.1 M6' "$VELA_MD"
note "vela.md has 1.5 step (or M6 cite) for doctor" $?

grep -q 'ff03bb16\|hicoco' "$VELA_MD"
note "vela.md cites hicoco initial-session motivation" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
