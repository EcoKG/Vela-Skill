#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-install-flow.sh — End-to-end install / upgrade deploy test
#
# Exercises the real deploy path that `install.sh` and `update.sh`
# drive into, but hermetically: a temp directory stands in for $HOME
# and the local repo checkout stands in for the git-cloned skill repo.
#
# What this guards against:
#   1. The FILE_MANIFEST regression we fixed in 3c7671e — a hook wired
#      into registerGlobalHooks() but absent from FILE_MANIFEST was
#      silently deleted by orphan cleanup on `install.js upgrade`.
#      This test installs fresh, runs upgrade, and asserts that every
#      hook registered by registerGlobalHooks() is still on disk.
#   2. V4.1 residue re-appearing in .vela/hooks/ — fake legacy hook
#      files are planted, upgrade is run, and the test asserts they
#      were cleaned up (without touching any active hook).
#   3. Global hook registration duplication — install() is run twice
#      and the test asserts that ~/.claude/settings.json hook counts
#      don't grow.
#   4. deploy-common.sh sync_local_project drift — the shell-level
#      copy list must match what install.js / registerGlobalHooks()
#      expect. The test runs sync_local_project end-to-end and
#      asserts the resulting .vela/hooks/ matches expectations.
#
# Coverage (legacy validation-plan V5 + V6 — doc removed in v7.3-M5):
#   V5-1 기본 설치 검증
#   V5-2 registerGlobalHooks 멱등성
#   V5-4 settings.local.json hooks 마이그레이션
#   V6-2 deploy-common.sh 복사 목록
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_JS="$REPO_ROOT/scripts/install.js"
DEPLOY_COMMON="$REPO_ROOT/scripts/deploy-common.sh"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
FAKE_HOME=""
PROJECT=""

# The active hooks that must always be present after install/upgrade.
# v7.1.1: added vela-file-read-cache.js to catch the deploy-common.sh
# sync_local_project() drift where the v7.1 hook was never copied
# because the function enumerated hook filenames by hand.
ACTIVE_HOOKS=(
  vela-gate-keeper.js
  vela-gate-guard.js
  vela-stop.js
  vela-review-gate.js
  vela-file-read-cache.js
)

# Legacy V4.1 hooks that must NOT reappear in .vela/hooks/.
LEGACY_HOOKS=(
  vela-failure.js
  vela-compact.js
  vela-analytics.js
)

# ── Helpers ──────────────────────────────────────────────────

setup_home_and_project() {
  TMPDIR_ROOT="$(mktemp -d)"
  FAKE_HOME="$TMPDIR_ROOT/home"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$FAKE_HOME/.claude/skills/vela/scripts/hooks"
  mkdir -p "$PROJECT/.vela"

  # register_session_start_hook in deploy-common.sh requires this file
  # to exist in $HOME/.claude/skills/vela/scripts/hooks/ before it will
  # do anything. Create a minimal stub so that path succeeds.
  cp "$REPO_ROOT/scripts/hooks/session-start-version-check.js" \
    "$FAKE_HOME/.claude/skills/vela/scripts/hooks/session-start-version-check.js"
  if [ -f "$REPO_ROOT/scripts/hooks/vela-session-start.js" ]; then
    cp "$REPO_ROOT/scripts/hooks/vela-session-start.js" \
      "$FAKE_HOME/.claude/skills/vela/scripts/hooks/vela-session-start.js"
  fi

  # Initialise a git repo inside the project so install.js doesn't
  # bail on ensureGitignore / git operations.
  (cd "$PROJECT" \
    && GIT_CONFIG_COUNT=1 \
       GIT_CONFIG_KEY_0=commit.gpgsign \
       GIT_CONFIG_VALUE_0=false \
       git init -q -b main \
    && git config user.email "test@vela.local" \
    && git config user.name  "Vela Install Test" \
    && git config commit.gpgsign false \
    && echo "# test project" > README.md \
    && echo ".vela/" > .gitignore \
    && git add -A \
    && git commit -q -m "initial")
}

teardown() {
  [ -n "${TMPDIR_ROOT:-}" ] && rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
  TMPDIR_ROOT=""
  FAKE_HOME=""
  PROJECT=""
}
trap teardown EXIT

# Run a command with the fake HOME and git signing disabled.
run_in_sandbox() {
  HOME="$FAKE_HOME" \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=commit.gpgsign \
    GIT_CONFIG_VALUE_0=false \
    "$@"
}

# Run node install.js inside the project dir with sandboxed HOME.
install_js() {
  (cd "$PROJECT" && run_in_sandbox node "$INSTALL_JS" "$@")
}

# Assertion helpers
assert_file() {
  TOTAL=$((TOTAL + 1))
  local label="$1" filepath="$2"
  if [ -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — missing: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_no_file() {
  TOTAL=$((TOTAL + 1))
  local label="$1" filepath="$2"
  if [ ! -e "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — file should not exist: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_eq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  TOTAL=$((TOTAL + 1))
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q -- "$needle"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — '$needle' not in: $(echo "$haystack" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi
}

# Count globally-registered hooks for a given event (PreToolUse / Stop)
count_global_hooks() {
  local event="$1"
  HOME="$FAKE_HOME" node -e "
    const fs = require('fs');
    const path = require('path');
    const p = path.join(process.env.HOME, '.claude', 'settings.json');
    if (!fs.existsSync(p)) { console.log(0); process.exit(0); }
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    const hooks = (s.hooks && s.hooks['$event']) || [];
    // Count only entries whose command references a vela hook
    const vela = hooks.filter(e => {
      if (e && e.hooks && Array.isArray(e.hooks)) {
        return e.hooks.some(h => h && h.command && h.command.includes('vela-'));
      }
      return false;
    });
    console.log(vela.length);
  "
}

# Dump the global settings.json (for debugging assertions)
cat_global_settings() {
  cat "$FAKE_HOME/.claude/settings.json" 2>/dev/null || echo "(no settings.json)"
}

# ── Tests ────────────────────────────────────────────────────

echo "⛵ test-install-flow.sh — install/upgrade deploy scenarios"
echo "══════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────
# Scenario A — Fresh install
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Scenario A — Fresh install from clean project"

setup_home_and_project

# Discard the output — the scenario's assertions look at files and
# settings.json, not the install.js stdout. Kept as `|| true` so an
# unexpected non-zero exit doesn't abort the sandbox before we can
# inspect it.
install_js > /dev/null 2>&1 || true

# All 4 active hooks staged in .vela/hooks/
for hook in "${ACTIVE_HOOKS[@]}"; do
  assert_file "A: .vela/hooks/$hook present (staged)" "$PROJECT/.vela/hooks/$hook"
done
assert_file "A: .vela/hooks/shared/constants.js present" \
  "$PROJECT/.vela/hooks/shared/constants.js"

# All 4 active hooks deployed to global ~/.vela/hooks/
for hook in "${ACTIVE_HOOKS[@]}"; do
  assert_file "A: ~/.vela/hooks/$hook present (global)" "$FAKE_HOME/.vela/hooks/$hook"
done

# v7.1 M10: global settings.json has 3 PreToolUse (gate-keeper,
# gate-guard, file-read-cache) + 2 Stop (vela-stop, vela-review-gate).
# Pre-v7.1 there were only 2 PreToolUse.
assert_eq "A: PreToolUse vela hook count"  "3" "$(count_global_hooks PreToolUse)"
assert_eq "A: Stop vela hook count"        "2" "$(count_global_hooks Stop)"

# Hook commands point at the global hooks dir under the fake HOME
GLOBAL_SETTINGS_JSON=$(cat_global_settings)
assert_contains "A: gate-keeper command uses ~/.vela/hooks/" \
  "$FAKE_HOME/.vela/hooks/vela-gate-keeper.js" "$GLOBAL_SETTINGS_JSON"
assert_contains "A: gate-guard command uses ~/.vela/hooks/" \
  "$FAKE_HOME/.vela/hooks/vela-gate-guard.js" "$GLOBAL_SETTINGS_JSON"
assert_contains "A: stop command uses ~/.vela/hooks/" \
  "$FAKE_HOME/.vela/hooks/vela-stop.js" "$GLOBAL_SETTINGS_JSON"
assert_contains "A: review-gate command uses ~/.vela/hooks/" \
  "$FAKE_HOME/.vela/hooks/vela-review-gate.js" "$GLOBAL_SETTINGS_JSON"

# Project-local settings.local.json exists and has permissions + agent
assert_file "A: .claude/settings.local.json created" \
  "$PROJECT/.claude/settings.local.json"

# Legacy hooks must NOT have appeared
for legacy in "${LEGACY_HOOKS[@]}"; do
  assert_no_file "A: .vela/hooks/$legacy absent (no V4.1 residue)" \
    "$PROJECT/.vela/hooks/$legacy"
done

# install.js verify reports ok
VERIFY_OUT=$(install_js verify 2>&1 || true)
assert_contains "A: verify reports ok:true" '"ok": true' "$VERIFY_OUT"

# ─────────────────────────────────────────────────────────────
# Scenario B — Upgrade idempotency (THE critical regression check)
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Scenario B — Upgrade idempotency (review-gate survives cleanup)"

# First upgrade — this is what exposed the FILE_MANIFEST bug before
UPGRADE_OUT_1=$(install_js upgrade 2>&1 || true)
assert_contains "B: first upgrade reports ok" '"ok": true' "$UPGRADE_OUT_1"

# review-gate.js MUST still exist after upgrade (the bug fix)
assert_file "B: vela-review-gate.js survives first upgrade" \
  "$PROJECT/.vela/hooks/vela-review-gate.js"

# All other active hooks also still there
for hook in vela-gate-keeper.js vela-gate-guard.js vela-stop.js; do
  assert_file "B: $hook survives first upgrade" "$PROJECT/.vela/hooks/$hook"
done

# orphansRemoved should NOT mention any active hook
TOTAL=$((TOTAL + 1))
if echo "$UPGRADE_OUT_1" | grep -q 'hooks/vela-review-gate.js"\|hooks/vela-gate-keeper.js"\|hooks/vela-gate-guard.js"\|hooks/vela-stop.js"' && \
   echo "$UPGRADE_OUT_1" | grep -q '"orphansRemoved"'; then
  # Only fail if an active hook name shows up inside the orphansRemoved section
  ORPHANS=$(echo "$UPGRADE_OUT_1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j = JSON.parse(d);
        const list = (j.details && j.details.orphansRemoved) || [];
        process.stdout.write(list.join('\n'));
      } catch (_) { process.stdout.write(''); }
    });
  ")
  if echo "$ORPHANS" | grep -q 'vela-gate-keeper\|vela-gate-guard\|vela-stop\|vela-review-gate'; then
    echo "  ❌ FAIL: B: active hook appeared in orphansRemoved: $ORPHANS"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ PASS: B: no active hooks in orphansRemoved"
    PASS=$((PASS + 1))
  fi
else
  echo "  ✅ PASS: B: no active hooks in orphansRemoved"
  PASS=$((PASS + 1))
fi

# Second upgrade (idempotency)
UPGRADE_OUT_2=$(install_js upgrade 2>&1 || true)
assert_contains "B: second upgrade reports ok" '"ok": true' "$UPGRADE_OUT_2"
assert_file "B: review-gate.js still present after 2nd upgrade" \
  "$PROJECT/.vela/hooks/vela-review-gate.js"

# ─────────────────────────────────────────────────────────────
# Scenario C — V4.1 residue orphan cleanup
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Scenario C — Orphan cleanup removes V4.1 residue on upgrade"

# Plant fake legacy hook files
for legacy in "${LEGACY_HOOKS[@]}"; do
  echo "// stale V4.1 legacy hook $legacy" \
    > "$PROJECT/.vela/hooks/$legacy"
done

# Confirm planted
for legacy in "${LEGACY_HOOKS[@]}"; do
  assert_file "C: planted $legacy before upgrade" \
    "$PROJECT/.vela/hooks/$legacy"
done

# Run upgrade — orphan cleanup should remove them
UPGRADE_OUT_C=$(install_js upgrade 2>&1 || true)
assert_contains "C: upgrade ok" '"ok": true' "$UPGRADE_OUT_C"

for legacy in "${LEGACY_HOOKS[@]}"; do
  assert_no_file "C: $legacy removed by orphan cleanup" \
    "$PROJECT/.vela/hooks/$legacy"
done

# Active hooks untouched
for hook in "${ACTIVE_HOOKS[@]}"; do
  assert_file "C: $hook still present after cleanup" \
    "$PROJECT/.vela/hooks/$hook"
done

# ─────────────────────────────────────────────────────────────
# Scenario D — Global registration idempotency (no duplication)
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Scenario D — Re-running install doesn't duplicate global hooks"

PRE_PRE_COUNT=$(count_global_hooks PreToolUse)
PRE_STOP_COUNT=$(count_global_hooks Stop)

install_js > /dev/null 2>&1 || true
install_js > /dev/null 2>&1 || true

POST_PRE_COUNT=$(count_global_hooks PreToolUse)
POST_STOP_COUNT=$(count_global_hooks Stop)

assert_eq "D: PreToolUse count unchanged after 2x install" \
  "$PRE_PRE_COUNT" "$POST_PRE_COUNT"
assert_eq "D: Stop count unchanged after 2x install" \
  "$PRE_STOP_COUNT" "$POST_STOP_COUNT"

# D2: Heal pre-existing duplicates (regression from the old idempotency bug)
# Plant 3 extra duplicate Stop hook entries directly into settings.json
# (mimicking what a user who installed multiple times under the buggy
# version would see) and assert the next install() call dedups them
# back to exactly 2.
HOME="$FAKE_HOME" node -e "
  const fs = require('fs');
  const path = require('path');
  const p = path.join(process.env.HOME, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  s.hooks = s.hooks || {};
  s.hooks.Stop = s.hooks.Stop || [];
  const stopCmd = 'node ' + path.join(process.env.HOME, '.vela', 'hooks', 'vela-stop.js');
  const rgCmd   = 'node ' + path.join(process.env.HOME, '.vela', 'hooks', 'vela-review-gate.js');
  // 3 extra stop + 2 extra review-gate duplicates = 5 extras
  for (let i = 0; i < 3; i++) {
    s.hooks.Stop.push({ hooks: [{ type: 'command', command: stopCmd, timeout: 10 }] });
  }
  for (let i = 0; i < 2; i++) {
    s.hooks.Stop.push({ hooks: [{ type: 'command', command: rgCmd, timeout: 10 }] });
  }
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
"
PRE_HEAL_STOP=$(count_global_hooks Stop)
assert_eq "D2: planted Stop hook count (2 + 3 + 2 = 7)" "7" "$PRE_HEAL_STOP"

install_js > /dev/null 2>&1 || true

POST_HEAL_STOP=$(count_global_hooks Stop)
assert_eq "D2: install() healed duplicates back to 2" "2" "$POST_HEAL_STOP"

teardown

# ─────────────────────────────────────────────────────────────
# Scenario E — deploy-common.sh sync_local_project end-to-end
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Scenario E — deploy-common.sh sync_local_project"

setup_home_and_project

# Source deploy-common.sh with the sandboxed HOME so register_session_start_hook
# writes to the fake settings file.
(
  set +e
  cd "$PROJECT"
  export HOME="$FAKE_HOME"
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=commit.gpgsign
  export GIT_CONFIG_VALUE_0=false
  # shellcheck disable=SC1090
  source "$DEPLOY_COMMON"
  sync_local_project "$REPO_ROOT" > /dev/null 2>&1
)

# After sync: exactly the 4 active hooks + shared/constants.js
for hook in "${ACTIVE_HOOKS[@]}"; do
  assert_file "E: sync_local_project deployed $hook" \
    "$PROJECT/.vela/hooks/$hook"
done
assert_file "E: sync_local_project deployed hooks/shared/constants.js" \
  "$PROJECT/.vela/hooks/shared/constants.js"

# No V4.1 residue copied
for legacy in "${LEGACY_HOOKS[@]}"; do
  assert_no_file "E: sync_local_project did NOT copy $legacy" \
    "$PROJECT/.vela/hooks/$legacy"
done

# sync_local_project internally runs install.js → global hooks registered.
# v7.1 M10 adds vela-file-read-cache to PreToolUse bringing the count to 3.
assert_eq "E: global PreToolUse count after sync" "3" "$(count_global_hooks PreToolUse)"
assert_eq "E: global Stop count after sync"       "2" "$(count_global_hooks Stop)"

# ─────────────────────────────────────────────────────────────
# v7.1.1 regression guard — sync_local_project MUST deploy every
# v7.1 template file. Pre-v7.1.1 these were missed because the
# function hard-coded `cp templates/pipeline.json` as the only
# template, and hooks were listed by filename. `update.sh --local`
# on a real project would leave the new v7.1 artifacts missing,
# silently reverting affected behaviour (Phase 0 live processes,
# Phase 3 smoke test, role budgets, Architecture Guardrails
# samples, file-read cache hook).
# ─────────────────────────────────────────────────────────────
assert_file "E.v7.1: role-budgets.json deployed" \
  "$PROJECT/.vela/templates/role-budgets.json"
assert_file "E.v7.1: plan-templates/quick.md deployed" \
  "$PROJECT/.vela/templates/plan-templates/quick.md"
assert_file "E.v7.1: guidelines/live-processes.json deployed" \
  "$PROJECT/.vela/templates/guidelines/live-processes.json"
assert_file "E.v7.1: guidelines/smoke-test.sh.example deployed" \
  "$PROJECT/.vela/templates/guidelines/smoke-test.sh.example"

# Important back-compat invariant: config.json must NOT be
# overwritten by sync_local_project even though we now recurse
# through templates/. Plant a user-customised config.json and
# confirm it survives a second sync.
echo '{"custom":"keep-me"}' > "$PROJECT/.vela/templates/config.json"
(
  set +e
  cd "$PROJECT"
  export HOME="$FAKE_HOME"
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=commit.gpgsign
  export GIT_CONFIG_VALUE_0=false
  # shellcheck disable=SC1090
  source "$DEPLOY_COMMON"
  sync_local_project "$REPO_ROOT" > /dev/null 2>&1
)
assert_contains "E.v7.1: user config.json NOT overwritten by sync" \
  '"custom"' "$(cat "$PROJECT/.vela/templates/config.json" 2>/dev/null)"

teardown

# ─────────────────────────────────────────────────────────────
# Scenario F — Uninstall cleans up global hooks
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Scenario F — Uninstall removes global vela hooks from settings.json"

setup_home_and_project
install_js > /dev/null 2>&1 || true

PRE_UNINSTALL_PRE=$(count_global_hooks PreToolUse)
PRE_UNINSTALL_STOP=$(count_global_hooks Stop)
# v7.1 M10 raised PreToolUse from 2 to 3 (added vela-file-read-cache).
assert_eq "F: baseline PreToolUse count" "3" "$PRE_UNINSTALL_PRE"
assert_eq "F: baseline Stop count"       "2" "$PRE_UNINSTALL_STOP"

UNINSTALL_OUT=$(install_js uninstall 2>&1 || true)
assert_contains "F: uninstall reports ok" '"ok": true' "$UNINSTALL_OUT"

POST_UNINSTALL_PRE=$(count_global_hooks PreToolUse)
POST_UNINSTALL_STOP=$(count_global_hooks Stop)
assert_eq "F: PreToolUse vela hooks gone" "0" "$POST_UNINSTALL_PRE"
assert_eq "F: Stop vela hooks gone"       "0" "$POST_UNINSTALL_STOP"

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ INSTALL FLOW TEST FAILED"
  exit 1
fi
echo "✅ V6 install/upgrade 배포 플로우 PASS"
