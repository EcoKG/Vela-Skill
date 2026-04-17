#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-global-hook-loadable.sh — v7.1.4 global hook loadability
#
# v7.1.3 (self-heal) ensured settings.json only references files
# that exist. But "the file exists" is not the same as "the file
# will actually run without crashing at require time". This test
# exercises the second invariant.
#
# Real bug it guards:
#   scripts/hooks/shared/constants.js is a 3-line wrapper that
#   does `module.exports = require("../../shared/constants")`.
#   When install.js registerGlobalHooks copied THAT wrapper into
#   ~/.vela/hooks/shared/constants.js, the `../../shared/constants`
#   lookup pointed at ~/.vela/shared/constants.js — which doesn't
#   exist. Any hook that require()d ./shared/constants (gate-keeper,
#   gate-guard, stop, review-gate) would throw MODULE_NOT_FOUND at
#   load time with `internal/modules/cjs/loader:1386`.
#
#   Pre-v7.1.4 this was a latent bug: settings.json happened to
#   reference the repo-path copies (~/.claude/skills/vela/scripts/
#   hooks/vela-*.js) where the wrapper resolves correctly. v7.1.3's
#   addGlobalHook guard made the global-hook-dir path a first-class
#   option, and anyone whose settings.json lost the repo entry
#   would flip to the broken chain.
#
# v7.1.4 fix: registerGlobalHooks deploys the REAL
# scripts/shared/constants.js (via skillBase) into
# ~/.vela/hooks/shared/constants.js so the file is self-contained
# and no parent lookup is needed.
#
# This test:
#   1. Builds a sandbox ~/.vela/hooks/ via registerGlobalHooks-like
#      staging (install flow)
#   2. Spawns `node` against every hook in that dir with a minimal
#      valid PreToolUse stdin
#   3. Asserts exit code ≥ 0 AND stderr contains no MODULE_NOT_FOUND
#      AND stderr contains no loader:1386
#   4. Reverse-sanity: if constants.js is swapped to the wrapper,
#      loads must fail — proves the test would catch a regression
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

setup_sandbox() {
  cleanup
  TMPDIR_ROOT="$(mktemp -d)"
  FAKE_HOME="$TMPDIR_ROOT/home"
  PROJECT="$TMPDIR_ROOT/project"
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
}

run_install() {
  (
    cd "$PROJECT"
    HOME="$FAKE_HOME" node "$INSTALL_JS" >/dev/null 2>&1
  )
}

probe_hook() {
  # Invoke a hook with a minimal, realistic PreToolUse stdin and
  # capture exit code + stderr. A healthy hook either exits 0
  # (allow) or exits 2 (block), AND emits no MODULE_NOT_FOUND.
  local hook="$1"
  local stdin='{"tool_name":"Read","tool_input":{"file_path":"/etc/hostname"},"session_id":"probe","cwd":"/tmp"}'
  local err
  err=$(echo "$stdin" | node "$hook" 2>&1 >/dev/null)
  local exit_code=$?
  echo "$err" > /tmp/probe-err
  return $exit_code
}

assert_loadable() {
  local hook_name="$1"
  local hook_path="$FAKE_HOME/.vela/hooks/$hook_name"

  if [ ! -f "$hook_path" ]; then
    note "$hook_name deployed to ~/.vela/hooks/" 1
    return
  fi
  note "$hook_name deployed to ~/.vela/hooks/" 0

  probe_hook "$hook_path"
  local exit_code=$?

  if grep -q 'MODULE_NOT_FOUND\|Cannot find module\|loader:1386' /tmp/probe-err; then
    note "$hook_name loads without MODULE_NOT_FOUND" 1
    echo "     stderr head: $(head -1 /tmp/probe-err)"
  else
    note "$hook_name loads without MODULE_NOT_FOUND" 0
  fi

  # Exit 0 (allow) or 2 (block) are both healthy. Anything else
  # means the hook crashed.
  if [ "$exit_code" = "0" ] || [ "$exit_code" = "2" ]; then
    note "$hook_name runs to completion (exit $exit_code)" 0
  else
    note "$hook_name runs to completion (exit $exit_code)" 1
  fi
}

# ══════════════════════════════════════════════════════════════
# Phase 1: install and probe every global hook
# ══════════════════════════════════════════════════════════════
echo "📋 Phase 1: every global hook in ~/.vela/hooks/ loads cleanly"
setup_sandbox
run_install

for hook_name in \
  vela-gate.js \
  vela-stop.js; do
  assert_loadable "$hook_name"
done

# ══════════════════════════════════════════════════════════════
# Phase 2: the constants.js in the global hook dir must NOT be
# the wrapper. It must be the real source file (self-contained).
# ══════════════════════════════════════════════════════════════
echo "📋 Phase 2: ~/.vela/hooks/shared/constants.js is self-contained"

GLOBAL_CONSTANTS="$FAKE_HOME/.vela/hooks/shared/constants.js"
REAL_CONSTANTS="$REPO_ROOT/scripts/shared/constants.js"

[ -f "$GLOBAL_CONSTANTS" ]
note "global hook dir has shared/constants.js" $?

# The file must NOT be the 3-line wrapper. The wrapper contains
# the literal string `require("../../shared/constants")`; the
# real source does not.
if grep -q 'require("../../shared/constants")' "$GLOBAL_CONSTANTS"; then
  note "global constants.js is NOT the re-export wrapper" 1
else
  note "global constants.js is NOT the re-export wrapper" 0
fi

# It must be byte-identical to scripts/shared/constants.js
if diff -q "$GLOBAL_CONSTANTS" "$REAL_CONSTANTS" >/dev/null 2>&1; then
  note "global constants.js == repo scripts/shared/constants.js" 0
else
  note "global constants.js == repo scripts/shared/constants.js" 1
fi

# And it must be require-able directly from node, exporting the
# expected named fields (SAFE_BASH_READ is a good canary — it's
# used by gate-keeper).
LOADED=$(node -e "
  try {
    const c = require('$GLOBAL_CONSTANTS');
    console.log(c.SAFE_BASH_READ ? 'ok' : 'missing');
  } catch (e) {
    console.log('err:' + e.message);
  }
")
[ "$LOADED" = "ok" ]
note "global constants.js exports SAFE_BASH_READ (got '$LOADED')" $?

# ══════════════════════════════════════════════════════════════
# Phase 2.5 (v7.1.5) — run install.js from {project}/.vela/install.js
# instead of from the skill repo. This simulates the update.sh --local
# path where the install.js copy inside .vela/ is invoked.
#
# In that layout:
#   __dirname     = {project}/.vela
#   skillBase     = {project}            ← NOT a skill repo!
#   PROJECT_ROOT  = {project}
#
# v7.1.4 would fall through to the wrapper here because skillBase/
# scripts/shared/constants.js doesn't exist in a user project. v7.1.5
# adds {project}/.vela/shared/constants.js as a search candidate, so
# this path now finds the real file that sync_local_project staged.
# ══════════════════════════════════════════════════════════════
echo "📋 Phase 2.5: install.js run from {project}/.vela/install.js"
setup_sandbox
# First run populates .vela/ and ~/.vela/hooks/ via the skill-repo
# install.js path. This also drops scripts/shared/constants.js into
# $PROJECT/.vela/shared/constants.js via validate()'s FILE_MANIFEST
# copy, which is what candidates[1] depends on below.
run_install

# install.js is NOT in FILE_MANIFEST — it's only copied into
# .vela/install.js by sync_local_project in deploy-common.sh. We
# reproduce that copy manually so we can invoke the project-local
# install.js (what update.sh --local actually does).
cp "$INSTALL_JS" "$PROJECT/.vela/install.js"

# Remove the global constants to force re-copy and prove the second
# install really goes through the candidates loop.
rm -f "$FAKE_HOME/.vela/hooks/shared/constants.js"

(
  cd "$PROJECT"
  HOME="$FAKE_HOME" node "$PROJECT/.vela/install.js" >/dev/null 2>&1
)

# Now ~/.vela/hooks/shared/constants.js must still be the real source
GLOBAL_CONSTANTS="$FAKE_HOME/.vela/hooks/shared/constants.js"
[ -f "$GLOBAL_CONSTANTS" ]
note "Phase 2.5: constants.js deployed after project-local install" $?

if grep -q 'require("../../shared/constants")' "$GLOBAL_CONSTANTS"; then
  note "Phase 2.5: constants.js is NOT the wrapper after project-local install" 1
else
  note "Phase 2.5: constants.js is NOT the wrapper after project-local install" 0
fi

# gate-keeper must still load cleanly from the global hook dir
probe_hook "$FAKE_HOME/.vela/hooks/vela-gate.js" || true
if grep -q 'MODULE_NOT_FOUND\|loader:1386' /tmp/probe-err; then
  note "Phase 2.5: vela-gate loads cleanly after project-local install" 1
  echo "     stderr: $(head -1 /tmp/probe-err)"
else
  note "Phase 2.5: vela-gate loads cleanly after project-local install" 0
fi

# ══════════════════════════════════════════════════════════════
# Phase 3: reverse-sanity — swap in the wrapper and verify the
# test would catch a regression.
# ══════════════════════════════════════════════════════════════
echo "📋 Phase 3: reverse-sanity — swapping in the wrapper breaks hooks"

# Overwrite global constants.js with the wrapper (the pre-v7.1.4 state)
cat > "$GLOBAL_CONSTANTS" <<'WRAPPER'
/**
 * Vela Hook Constants
 * Re-exports shared constants for standalone Claude Code hook scripts.
 */
module.exports = require("../../shared/constants");
WRAPPER

# Now probe gate-keeper — it should FAIL to load
probe_hook "$FAKE_HOME/.vela/hooks/vela-gate.js" || true

if grep -q 'MODULE_NOT_FOUND\|Cannot find module' /tmp/probe-err; then
  note "wrapper re-introduces MODULE_NOT_FOUND (as expected)" 0
else
  note "wrapper re-introduces MODULE_NOT_FOUND (as expected)" 1
  echo "     unexpected stderr: $(head -1 /tmp/probe-err)"
fi

# And the real-file check must now fail
if diff -q "$GLOBAL_CONSTANTS" "$REAL_CONSTANTS" >/dev/null 2>&1; then
  note "reverse-sanity: wrapper diff != real source" 1
else
  note "reverse-sanity: wrapper diff != real source" 0
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
