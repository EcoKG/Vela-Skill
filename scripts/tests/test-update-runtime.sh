#!/usr/bin/env bash
# scripts/tests/test-update-runtime.sh
#
# Runtime integration test for update.sh.
#
# Unlike test-pm-coverage.sh which statically greps update.sh for the
# right code structure, this test actually RUNS update.sh inside a
# sandboxed $HOME and verifies that the expected files really exist
# afterward. It catches the class of bug where the code looks correct
# but something in execution paths silently drops steps.
#
# v7.0.2 introduced the dynamic `for skill_src in "$TMP/skills"/*/; do`
# loop. Static coverage (Category E in test-pm-coverage) verifies the
# LOOP EXISTS. This test verifies the LOOP PRODUCES OUTPUT.
#
# Isolation technique: set HOME to a mktemp dir, set PWD to the repo
# root, and let update.sh do its thing. The script normally clones
# from GitHub, which would make the test network-dependent and slow.
# We redirect that by pre-populating $HOME/.vela-update-tmp with the
# current repo tree before running update.sh — the clone step then
# sees an up-to-date directory and may or may not overwrite (see
# below). To avoid any network or race, we stub the `git clone ...`
# command by prepending a shim directory to PATH that provides a
# `git` which succeeds without re-cloning.
#
# Scope: slash-command installation only. This test does NOT verify
# npm package installation, local project sync, or session-start
# hooks — those are orthogonal and already covered by test-install-flow.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
TOTAL=0

assert_eq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    echo "     expected: $expected"
    echo "     actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_dir() {
  TOTAL=$((TOTAL + 1))
  local label="$1" dir="$2"
  if [ -d "$dir" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    echo "     missing: $dir"
    FAIL=$((FAIL + 1))
  fi
}

assert_file() {
  TOTAL=$((TOTAL + 1))
  local label="$1" file="$2"
  if [ -f "$file" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    echo "     missing: $file"
    FAIL=$((FAIL + 1))
  fi
}

# ─── Setup ──────────────────────────────────────────────────

echo "🔧 Runtime integration test for update.sh"
echo ""

TMP_HOME=$(mktemp -d)
TMP_BIN=$(mktemp -d)

cleanup() {
  rm -rf "$TMP_HOME" "$TMP_BIN" 2>/dev/null
}
trap cleanup EXIT

# Stub `git` so `git clone` just copies the current repo instead of
# hitting the network. Every other git invocation (version, config,
# etc.) falls through to real git.
cat > "$TMP_BIN/git" <<'GITSTUB'
#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  # Extract the destination path — it's the last positional argument
  # among all those that aren't flags. Skip `--depth`, `-b main`, URL.
  dest=""
  for arg in "$@"; do
    case "$arg" in
      --depth|--depth=*|-b|main|clone|https://*|http://*)
        continue
        ;;
      -*)
        continue
        ;;
      *)
        dest="$arg"
        ;;
    esac
  done

  if [ -z "$dest" ]; then
    # Fall back to real git
    exec /usr/bin/git "$@"
  fi

  # Copy the test repo root into the destination
  mkdir -p "$dest"
  cp -r "$VELA_REPO_ROOT/." "$dest/"
  exit 0
fi

# Everything else — real git
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$TMP_BIN/git"

# Stub `npm` so update.sh doesn't actually install Playwright (~200MB)
# during every test run. Returns success with empty output.
cat > "$TMP_BIN/npm" <<'NPMSTUB'
#!/usr/bin/env bash
# Silent success for all npm invocations
exit 0
NPMSTUB
chmod +x "$TMP_BIN/npm"

export VELA_REPO_ROOT="$REPO_ROOT"
export PATH="$TMP_BIN:$PATH"

# ─── Run update.sh in the sandbox ──────────────────────────

echo "📋 Phase 1: run update.sh against sandboxed HOME"
echo "   TMP_HOME: $TMP_HOME"
echo ""

UPDATE_OUT=$(HOME="$TMP_HOME" bash "$REPO_ROOT/update.sh" 2>&1)

# Uncomment for debugging:
# echo "$UPDATE_OUT"

# Expect the "Update complete" banner
if echo "$UPDATE_OUT" | grep -q "Update complete"; then
  assert_eq "update.sh ran to completion" "ok" "ok"
else
  assert_eq "update.sh ran to completion" "ok" "missing-banner"
  echo "--- update.sh output ---"
  echo "$UPDATE_OUT"
  echo "------------------------"
fi

# Expect the installation count summary
if echo "$UPDATE_OUT" | grep -qE "Slash commands installed: [0-9]+ skill"; then
  assert_eq "update.sh emits install summary" "ok" "ok"
else
  assert_eq "update.sh emits install summary" "ok" "missing"
fi

# Extract the reported install count
REPORTED=$(echo "$UPDATE_OUT" | grep -oE "Slash commands installed: [0-9]+" | head -1 | grep -oE "[0-9]+")
[ -z "$REPORTED" ] && REPORTED=0

# ─── Phase 2: verify slash-command skills on disk ─────────

echo ""
echo "📋 Phase 2: verify slash-command skills exist on disk"

SKILLS_ROOT="$TMP_HOME/.claude/skills"

# Every skills/{name}/ in the repo should have a corresponding
# $SKILLS_ROOT/vela-{name}/SKILL.md
EXPECTED_SKILLS=()
for skill_src in "$REPO_ROOT/skills"/*/; do
  [ -f "$skill_src/SKILL.md" ] || continue
  EXPECTED_SKILLS+=("$(basename "$skill_src")")
done

for sub in "${EXPECTED_SKILLS[@]}"; do
  assert_dir "vela-$sub directory exists" "$SKILLS_ROOT/vela-$sub"
  assert_file "vela-$sub/SKILL.md exists" "$SKILLS_ROOT/vela-$sub/SKILL.md"
done

# Total count should match expected
ACTUAL_COUNT=$(find "$SKILLS_ROOT" -maxdepth 1 -type d -name 'vela-*' 2>/dev/null | wc -l)
EXPECTED_COUNT=${#EXPECTED_SKILLS[@]}

assert_eq \
  "vela-* count: expected=$EXPECTED_COUNT actual=$ACTUAL_COUNT" \
  "$EXPECTED_COUNT" \
  "$ACTUAL_COUNT"

assert_eq \
  "install summary count matches filesystem count ($REPORTED)" \
  "$EXPECTED_COUNT" \
  "$REPORTED"

# ─── Phase 3: idempotency ──────────────────────────────────
# Running update.sh a second time should still leave exactly
# the same set of skills — not more, not less.

echo ""
echo "📋 Phase 3: re-running update.sh is idempotent"

HOME="$TMP_HOME" bash "$REPO_ROOT/update.sh" >/dev/null 2>&1
ACTUAL_COUNT2=$(find "$SKILLS_ROOT" -maxdepth 1 -type d -name 'vela-*' 2>/dev/null | wc -l)
assert_eq \
  "second run: vela-* count unchanged" \
  "$EXPECTED_COUNT" \
  "$ACTUAL_COUNT2"

# ─── Phase 4: stale cleanup ────────────────────────────────
# Plant a fake vela-deadskill/ that has no source directory, run
# update.sh again, and verify it's removed.

echo ""
echo "📋 Phase 4: stale cleanup removes orphaned vela-*"

mkdir -p "$SKILLS_ROOT/vela-deadskill"
echo "stale" > "$SKILLS_ROOT/vela-deadskill/SKILL.md"

HOME="$TMP_HOME" bash "$REPO_ROOT/update.sh" >/dev/null 2>&1

if [ ! -d "$SKILLS_ROOT/vela-deadskill" ]; then
  assert_eq "vela-deadskill removed by stale cleanup" "ok" "ok"
else
  assert_eq "vela-deadskill removed by stale cleanup" "ok" "still-present"
fi

# Real skills should still all be there
ACTUAL_COUNT3=$(find "$SKILLS_ROOT" -maxdepth 1 -type d -name 'vela-*' 2>/dev/null | wc -l)
assert_eq \
  "real vela-* count after cleanup" \
  "$EXPECTED_COUNT" \
  "$ACTUAL_COUNT3"

# ─── Phase 5: skill-name collision prevention (v7.0.4) ─────
# Pre-v7.0.4 update.sh copied the entire skills/ tree into
# $SKILL_DIR/skills/ in addition to the top-level vela-*/ install.
# Claude Code discovers skills recursively, so it saw BOTH copies
# of the same SKILL.md under the same `name:` frontmatter — causing
# silent collisions that hid the new /vela:fix, /vela:small etc.
# commands from autocomplete.
#
# The fix is to NOT copy skills/ into $SKILL_DIR/skills/ at all.
# This phase verifies:
#   1. $SKILL_DIR/skills/ does not exist after update.sh runs
#   2. There is exactly ONE SKILL.md per skill name in the tree
#      (i.e. the only copies live under $SKILLS_ROOT/vela-*/)

echo ""
echo "📋 Phase 5: collision prevention — no duplicate SKILL.md"

LEGACY_SUBDIR="$TMP_HOME/.claude/skills/vela/skills"
if [ ! -d "$LEGACY_SUBDIR" ]; then
  assert_eq "legacy .claude/skills/vela/skills/ subdir absent" "ok" "ok"
else
  assert_eq "legacy .claude/skills/vela/skills/ subdir absent" "ok" "still-present"
  echo "     found: $LEGACY_SUBDIR"
  find "$LEGACY_SUBDIR" -maxdepth 2 -name 'SKILL.md' 2>/dev/null | head -10
fi

# Verify each vela-<sub> name has exactly one SKILL.md file anywhere
# under $TMP_HOME/.claude/skills/ (i.e. no pair of files share the
# same `name:` frontmatter value).
TOTAL=$((TOTAL + 1))
collision_found=0
for sub in "${EXPECTED_SKILLS[@]}"; do
  # Match the frontmatter `name:` field for this sub-skill.
  # The value may be `vela:<sub>` or `vela-<sub>` depending on
  # frontmatter convention, so we check both.
  count=$(grep -rslE "^name:\s*[\"']?vela[:-]${sub}[\"']?\s*$" \
    "$TMP_HOME/.claude/skills/" 2>/dev/null | wc -l)
  if [ "$count" != "1" ]; then
    echo "  ❌ collision: name vela:${sub} appears in $count SKILL.md files:"
    grep -rslE "^name:\s*[\"']?vela[:-]${sub}[\"']?\s*$" \
      "$TMP_HOME/.claude/skills/" 2>/dev/null | sed 's/^/       /'
    collision_found=1
  fi
done

if [ "$collision_found" = "0" ]; then
  echo "  ✅ PASS: every vela-* name has exactly one SKILL.md"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: duplicate SKILL.md files detected for at least one name"
  FAIL=$((FAIL + 1))
fi

# ─── Phase 6: install.js doesn't nuke slash-command skills (v7.0.5) ─
# Pre-v7.0.5 scripts/install.js carried an allow-list of five
# "valid" vela-* directory names and aggressively deleted every
# other vela-* directory as "pollution" on every run. Any workflow
# that triggered `node install.js` (e.g. /vela:large invoking the
# project installer) silently wiped the new v6.1 scale skills and
# the v7.0 surgical skill right after update.sh installed them —
# because update.sh and install.js didn't share a single source
# of truth for the skill catalog.
#
# v7.0.5 inverts the cleanup block into a block-list of explicitly-
# retired directories (vela-init, vela-auto). This phase proves it:
#
#   1. Run update.sh → 10 skills installed.
#   2. Stage a fake legacy dir (vela-init/) to prove the block-list
#      still works for actual retired names.
#   3. Invoke scripts/install.js (upgrade mode) in a sandboxed cwd.
#   4. Assert all 10 real slash-command skills still exist.
#   5. Assert vela-init was removed.

echo ""
echo "📋 Phase 6: install.js preserves slash-command skills"

# Fresh update to restore any state Phase 4/5 may have churned.
HOME="$TMP_HOME" bash "$REPO_ROOT/update.sh" >/dev/null 2>&1

# Stage a legacy directory. install.js should remove it.
mkdir -p "$SKILLS_ROOT/vela-init"
echo "legacy stub" > "$SKILLS_ROOT/vela-init/SKILL.md"

# Run install.js in a temporary project directory so it doesn't try
# to write into the real repo. install.js walks up looking for .vela/,
# so we create an empty .vela/ in a temp dir to make it a valid
# "project root".
INSTALL_PROJECT_DIR=$(mktemp -d)
mkdir -p "$INSTALL_PROJECT_DIR/.vela"
# We invoke install.js via the `validate` subcommand. validate() is
# the function that owns Phase 9 "Global pollution cleanup" — upgrade()
# does NOT call it. install() also calls validate() internally, so
# validate is the minimum invocation that exercises the cleanup path.
# This is the exact same code path that ran on the user's machine
# when /vela:large triggered the project installer and silently
# wiped their slash-command skills pre-v7.0.5.
(
  cd "$INSTALL_PROJECT_DIR"
  HOME="$TMP_HOME" node "$REPO_ROOT/scripts/install.js" validate \
    >/tmp/install-js-run.log 2>&1 || true
)
rm -rf "$INSTALL_PROJECT_DIR"

# Assertion 1: every expected slash-command skill survived.
for sub in "${EXPECTED_SKILLS[@]}"; do
  assert_dir "install.js preserved vela-$sub" "$SKILLS_ROOT/vela-$sub"
  assert_file "install.js preserved vela-$sub/SKILL.md" \
    "$SKILLS_ROOT/vela-$sub/SKILL.md"
done

# Assertion 2: the block-list legacy entry was removed.
if [ ! -d "$SKILLS_ROOT/vela-init" ]; then
  assert_eq "install.js removed legacy vela-init" "ok" "ok"
else
  assert_eq "install.js removed legacy vela-init" "ok" "still-present"
fi

# Assertion 3: total count still equals expected.
ACTUAL_COUNT4=$(find "$SKILLS_ROOT" -maxdepth 1 -type d -name 'vela-*' 2>/dev/null | wc -l)
assert_eq \
  "vela-* count after install.js run" \
  "$EXPECTED_COUNT" \
  "$ACTUAL_COUNT4"

# ─── Summary ────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ update.sh runtime integration FAILED"
  exit 1
fi
echo "✅ update.sh runtime integration PASS"
