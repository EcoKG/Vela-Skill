#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-hook-selfheal.sh — v7.1.3 install.js hook self-heal
#
# Guards against the bug observed in a real user session:
# settings.json contained a PreToolUse hook entry pointing at
# ~/.vela/hooks/vela-file-read-cache.js, but the file did not
# exist on disk because a pre-v7.1.2 deploy-common.sh skipped
# copying it. Claude Code ran the command on every tool call
# and node errored with `internal/modules/cjs/loader:1386 —
# Cannot find module`. The error was non-blocking so tools
# still worked, but stderr was polluted on every invocation
# including ToolSearch (the deferred tool schema loader).
#
# v7.1.3 fix (in scripts/install.js::registerGlobalHooks):
#   1. pruneDanglingVelaHooks — before registering new hooks,
#      scan settings.json for entries pointing at files that
#      don't exist and remove them
#   2. addGlobalHook existence guard — refuse to write an entry
#      whose target file does not exist on disk
#
# Asserts:
#   Scenario A — dangling entry + missing source → entry pruned
#   Scenario B — source present → entry registered normally
#   Scenario C — source missing → addGlobalHook skips silently
#   Scenario D — VELA_HOOK_FILES list includes file-read-cache
#   Scenario E — idempotency: two installs with same state yield
#                the same settings.json
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
  mkdir -p "$FAKE_HOME/.claude"
  mkdir -p "$PROJECT/.vela"
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

# Query settings.json for a specific hook event + command substring
query_hook() {
  local event="$1" substr="$2"
  node -e "
    const fs = require('fs');
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const list = (s.hooks && s.hooks[process.argv[2]]) || [];
      const hits = list.filter(e => JSON.stringify(e).includes(process.argv[3]));
      console.log(hits.length);
    } catch { console.log(0); }
  " "$FAKE_HOME/.claude/settings.json" "$event" "$substr"
}

# ══════════════════════════════════════════════════════════════
# Scenario A — dangling entry is pruned on install
# ══════════════════════════════════════════════════════════════
echo "📋 Scenario A: dangling Vela hook entry gets pruned"
setup_sandbox

# Plant a dangling entry BEFORE install runs
mkdir -p "$FAKE_HOME/.vela/hooks"
cat > "$FAKE_HOME/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /this/path/vela-file-read-cache.js",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
EOF

# Before: dangling entry exists
HITS_BEFORE=$(query_hook PreToolUse "/this/path/vela-file-read-cache.js")
[ "$HITS_BEFORE" = "1" ]
note "Scenario A: dangling entry planted before install" $?

run_install

# After: dangling entry must be gone
HITS_AFTER=$(query_hook PreToolUse "/this/path/vela-file-read-cache.js")
[ "$HITS_AFTER" = "0" ]
note "Scenario A: dangling entry pruned by install ($HITS_AFTER left)" $?

# ══════════════════════════════════════════════════════════════
# Scenario B — source present → entry registered normally
# ══════════════════════════════════════════════════════════════
echo "📋 Scenario B: install registers only entries with existing source"
setup_sandbox
run_install

# Every Vela hook entry in settings.json must point at a file that exists
BAD=$(node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const velaFiles = ['vela-gate-keeper.js','vela-gate-guard.js','vela-stop.js','vela-review-gate.js','vela-file-read-cache.js'];
  let bad = 0;
  for (const event of ['PreToolUse','Stop']) {
    for (const entry of (s.hooks && s.hooks[event]) || []) {
      const str = JSON.stringify(entry);
      if (!velaFiles.some(f => str.includes(f))) continue;
      const cmd = (entry.hooks && entry.hooks[0] && entry.hooks[0].command) || '';
      const m = /node\s+(\S+\.js)/.exec(cmd);
      if (m && !fs.existsSync(m[1])) bad++;
    }
  }
  console.log(bad);
" "$FAKE_HOME/.claude/settings.json")

[ "$BAD" = "0" ]
note "Scenario B: all Vela hook entries point at existing files (0 dangling)" $?

# And the file-read-cache hook should have been registered
HITS_FRC=$(query_hook PreToolUse "vela-file-read-cache.js")
[ "$HITS_FRC" -ge 1 ]
note "Scenario B: vela-file-read-cache entry registered" $?

# And the target file really does exist
[ -f "$FAKE_HOME/.vela/hooks/vela-file-read-cache.js" ]
note "Scenario B: ~/.vela/hooks/vela-file-read-cache.js deployed" $?

# ══════════════════════════════════════════════════════════════
# Scenario C — source missing → addGlobalHook skips silently
# ══════════════════════════════════════════════════════════════
echo "📋 Scenario C: missing source → addGlobalHook refuses to register"
setup_sandbox

# Build a sandbox skill repo that has everything EXCEPT
# vela-file-read-cache.js. install.js's validate() restores missing
# files from `path.resolve(__dirname, "..")`, so using the real repo
# would re-create the file on every run — we need a fake skill repo
# where the source genuinely doesn't exist.
SANDBOX_SKILL="$TMPDIR_ROOT/skill-no-frc"
cp -r "$REPO_ROOT" "$SANDBOX_SKILL"
rm -f "$SANDBOX_SKILL/scripts/hooks/vela-file-read-cache.js"
# Also remove it from project-local .vela/hooks/ if it was ever copied
rm -f "$PROJECT/.vela/hooks/vela-file-read-cache.js"
rm -f "$FAKE_HOME/.vela/hooks/vela-file-read-cache.js"

# Start with a clean settings.json (no dangling entry left over from
# Scenarios A/B)
rm -f "$FAKE_HOME/.claude/settings.json"

# Run install from the sandboxed skill path
(
  cd "$PROJECT"
  HOME="$FAKE_HOME" node "$SANDBOX_SKILL/scripts/install.js" >/dev/null 2>&1
)

# Source is missing in the sandbox skill → entry must NOT be registered
HITS_NO_SRC=$(query_hook PreToolUse "vela-file-read-cache.js")
[ "$HITS_NO_SRC" = "0" ]
note "Scenario C: missing source → entry not registered ($HITS_NO_SRC)" $?

# And the four other hooks WERE registered (so install.js didn't bail)
HITS_GK=$(query_hook PreToolUse "vela-gate-keeper.js")
[ "$HITS_GK" = "1" ]
note "Scenario C: other hooks still registered (gate-keeper=$HITS_GK)" $?

# ══════════════════════════════════════════════════════════════
# Scenario D — VELA_HOOK_FILES list includes file-read-cache
# ══════════════════════════════════════════════════════════════
echo "📋 Scenario D: dedup list includes vela-file-read-cache"

grep -q '"vela-file-read-cache.js"' "$INSTALL_JS"
note "Scenario D: install.js VELA_HOOK_FILES includes file-read-cache" $?

# Plant 2 duplicate entries for file-read-cache, ensure dedup collapses to 1
setup_sandbox
mkdir -p "$FAKE_HOME/.vela/hooks"
# Create the file so it's not dangling (otherwise prune would kill both)
cp "$REPO_ROOT/scripts/hooks/vela-file-read-cache.js" "$FAKE_HOME/.vela/hooks/vela-file-read-cache.js"
cat > "$FAKE_HOME/.claude/settings.json" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {"hooks":[{"type":"command","command":"node $FAKE_HOME/.vela/hooks/vela-file-read-cache.js","timeout":5}]},
      {"hooks":[{"type":"command","command":"node $FAKE_HOME/.vela/hooks/vela-file-read-cache.js","timeout":5}]}
    ]
  }
}
EOF

HITS_BEFORE=$(query_hook PreToolUse "vela-file-read-cache.js")
[ "$HITS_BEFORE" = "2" ]
note "Scenario D: two duplicate entries planted" $?

run_install

HITS_AFTER=$(query_hook PreToolUse "vela-file-read-cache.js")
[ "$HITS_AFTER" = "1" ]
note "Scenario D: dedup collapses duplicates to 1 ($HITS_AFTER)" $?

# ══════════════════════════════════════════════════════════════
# Scenario E — idempotency: two installs on clean state are equal
# ══════════════════════════════════════════════════════════════
echo "📋 Scenario E: installing twice produces identical settings"
setup_sandbox
run_install
cp "$FAKE_HOME/.claude/settings.json" "$TMPDIR_ROOT/settings-first.json"
run_install
cp "$FAKE_HOME/.claude/settings.json" "$TMPDIR_ROOT/settings-second.json"

diff -q "$TMPDIR_ROOT/settings-first.json" "$TMPDIR_ROOT/settings-second.json" >/dev/null 2>&1
note "Scenario E: settings.json byte-identical after second install" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
