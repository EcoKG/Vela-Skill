#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-claudemd-cd-rule-injection.sh — v7.1 M12
#
# Covers: install.js upgrade() must inject the "Bash tool — never
# use bare `cd`" section into existing CLAUDE.md files that were
# first initialised before v7.0.7 (and therefore never received
# the rule). Must be idempotent and must not touch a CLAUDE.md
# that already has the marker.
#
# Scenarios:
#   A. no existing CLAUDE.md at all — upgrade does NOT create one
#      (install() owns first-time creation, not upgrade)
#   B. existing CLAUDE.md without the marker — upgrade appends
#      the section and the claudeMdInjected flag is true
#   C. existing CLAUDE.md WITH the marker — upgrade is a no-op,
#      file size unchanged, claudeMdInjected is false
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_JS="$REPO_ROOT/scripts/install.js"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
FAKE_HOME=""
PROJECT=""

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

cleanup() {
  [ -n "$TMPDIR_ROOT" ] && rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

setup_project() {
  cleanup
  TMPDIR_ROOT="$(mktemp -d)"
  FAKE_HOME="$TMPDIR_ROOT/home"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$FAKE_HOME/.claude"
  mkdir -p "$PROJECT/.vela/templates"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/artifacts"
  # upgrade() requires velaDir to exist
  (
    cd "$PROJECT"
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0=commit.gpgsign \
      GIT_CONFIG_VALUE_0=false \
      git init -q -b main
    git config user.email t@v.local
    git config user.name t
    echo "# test" > README.md
    git add README.md
    git -c commit.gpgsign=false commit -q -m "i"
  )
}

run_upgrade() {
  (
    cd "$PROJECT"
    HOME="$FAKE_HOME" \
      GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0=commit.gpgsign \
      GIT_CONFIG_VALUE_0=false \
      node "$INSTALL_JS" upgrade >/tmp/m12-stdout 2>/tmp/m12-stderr
  )
}

# ── Scenario A: no CLAUDE.md at all ──────────────────────────
echo "📋 Scenario A: no CLAUDE.md → upgrade must not create one"
setup_project
run_upgrade || true

if [ -f "$PROJECT/CLAUDE.md" ]; then
  note "Scenario A: CLAUDE.md still absent after upgrade" 1
else
  note "Scenario A: CLAUDE.md still absent after upgrade" 0
fi

grep -q '"claudeMdInjected": false' /tmp/m12-stdout
note "Scenario A: claudeMdInjected=false in upgrade output" $?

# ── Scenario B: existing CLAUDE.md without the marker ─────────
echo "📋 Scenario B: pre-v7.0.7 CLAUDE.md → inject the rule"
setup_project
cat > "$PROJECT/CLAUDE.md" <<'OLD_MD'
# Development Workflow — Vela V6

This project uses Vela for development governance.

- To explore/read code: use normal tools freely (Explore mode).
- To modify code: ALWAYS start with `node .vela/cli/vela-engine.js init`
OLD_MD

BEFORE_SIZE=$(wc -c < "$PROJECT/CLAUDE.md")
run_upgrade || true
AFTER_SIZE=$(wc -c < "$PROJECT/CLAUDE.md")

[ "$AFTER_SIZE" -gt "$BEFORE_SIZE" ]
note "Scenario B: CLAUDE.md grew (size $BEFORE_SIZE → $AFTER_SIZE)" $?

grep -q "Bash tool — never use bare \`cd\`" "$PROJECT/CLAUDE.md"
note "Scenario B: injected section marker present" $?

grep -q "subshell isolates" "$PROJECT/CLAUDE.md"
note "Scenario B: injected section explains subshell isolation" $?

# Original content must be preserved
grep -q "Development Workflow — Vela V6" "$PROJECT/CLAUDE.md"
note "Scenario B: original content preserved" $?

grep -q '"claudeMdInjected": true' /tmp/m12-stdout
note "Scenario B: claudeMdInjected=true in upgrade output" $?

# ── Scenario C: CLAUDE.md already has the marker — no-op ─────
echo "📋 Scenario C: CLAUDE.md already patched → idempotent no-op"
setup_project
cat > "$PROJECT/CLAUDE.md" <<'PATCHED_MD'
# Development Workflow — Vela V6

Stuff.

## Bash tool — never use bare `cd` inside a single invocation

Already patched.
PATCHED_MD

BEFORE_SIZE=$(wc -c < "$PROJECT/CLAUDE.md")
run_upgrade || true
AFTER_SIZE=$(wc -c < "$PROJECT/CLAUDE.md")

[ "$AFTER_SIZE" = "$BEFORE_SIZE" ]
note "Scenario C: CLAUDE.md size unchanged (still $AFTER_SIZE)" $?

# Exactly one occurrence of the marker — no duplicates
COUNT=$(grep -c "Bash tool — never use bare \`cd\`" "$PROJECT/CLAUDE.md")
[ "$COUNT" = "1" ]
note "Scenario C: marker appears exactly once (not duplicated), got $COUNT" $?

grep -q '"claudeMdInjected": false' /tmp/m12-stdout
note "Scenario C: claudeMdInjected=false in upgrade output" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
