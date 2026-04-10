#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-worktree-manager.sh — Integration tests for worktree-manager.js
#
# Creates a temporary git repo and exercises create/remove/list/cleanup.
# Verifies full lifecycle: create+disk, list filtering, remove+disk,
# multi-worktree cleanup, idempotent cleanup, branch collision.
# Also tests error paths: remove non-existent, missing args.
#
# Requires: node, git
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE="$(cd "$SCRIPT_DIR/../shared" && pwd)/worktree-manager.js"

PASS=0
FAIL=0
TOTAL=0
TMPDIRS=()

# ── Helpers ───────────────────────────────────────────────────

cleanup() {
  for d in "${TMPDIRS[@]}"; do
    # Force-remove any leftover worktrees before deleting the dir
    if [ -d "$d/.git" ] || [ -f "$d/.git" ]; then
      git -C "$d" worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}' | while read -r wt; do
        [ "$wt" != "$d" ] && git -C "$d" worktree remove --force "$wt" 2>/dev/null || true
      done
      git -C "$d" worktree prune 2>/dev/null || true
    fi
    rm -rf "$d" 2>/dev/null || true
  done
}
trap cleanup EXIT

make_repo() {
  local tmp
  tmp="$(mktemp -d)"
  TMPDIRS+=("$tmp")
  git -C "$tmp" init -b main >/dev/null 2>&1
  git -C "$tmp" config user.email "test@test.com"
  git -C "$tmp" config user.name "Test"
  # Disable commit signing for the test repo — inherited global
  # commit.gpgsign=true with a broken signing hook would silently fail
  # the initial commit, leaving the repo with no HEAD and breaking
  # every subsequent `git worktree add -b <name>` call with
  # "No possible source branch, inferring '--orphan'".
  git -C "$tmp" config commit.gpgsign false
  echo "init" > "$tmp/README.md"
  git -C "$tmp" add -A >/dev/null 2>&1
  git -C "$tmp" commit -m "init" >/dev/null 2>&1
  echo "$tmp"
}

run_test() {
  local name="$1"
  local script="$2"
  TOTAL=$((TOTAL + 1))

  local output
  if output=$(eval "$script" 2>&1); then
    PASS=$((PASS + 1))
    echo "  ✅ $name"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $name"
    echo "     $output" | head -5
  fi
}

# ── Tests ─────────────────────────────────────────────────────

echo ""
echo "=== worktree-manager.js tests ==="
echo ""

# T1: Module exports all four functions
run_test "exports create/remove/list/cleanup" \
  "node -e \"
const wt = require('$MODULE');
const keys = Object.keys(wt);
if (!['create','remove','list','cleanup'].every(k => keys.includes(k)))
  throw new Error('missing exports: ' + keys.join(','));
\""

# T2: create() returns { path, branch } with absolute path and directory exists on disk
REPO1="$(make_repo)"
run_test "create() returns { path, branch } and path exists on disk" \
  "node -e \"
const wt = require('$MODULE');
const path = require('path');
const fs = require('fs');
const result = wt.create({ cwd: '$REPO1', pipelineSlug: 'test-s02', role: 'executor' });
if (!result.path || !result.branch) throw new Error('missing path/branch');
if (!path.isAbsolute(result.path)) throw new Error('path not absolute: ' + result.path);
if (!result.branch.startsWith('vela/wt-')) throw new Error('bad branch prefix: ' + result.branch);
if (!fs.existsSync(result.path)) throw new Error('worktree path does not exist on disk: ' + result.path);
if (!fs.statSync(result.path).isDirectory()) throw new Error('worktree path is not a directory');
console.log('path=' + result.path + ' branch=' + result.branch);
\""

# T3: list() returns vela worktrees, excludes non-vela worktrees
run_test "list() returns vela worktrees and excludes non-vela" \
  "node -e \"
const wt = require('$MODULE');
const { execFileSync } = require('child_process');
const path = require('path');
// Create a non-vela worktree manually (outside .vela/worktrees/)
const nonVelaPath = path.join('$REPO1', 'tmp-non-vela-wt');
execFileSync('git', ['worktree', 'add', nonVelaPath, '-b', 'non-vela-branch'], { cwd: '$REPO1' });
// list() should still only return the vela worktree
const result = wt.list({ cwd: '$REPO1' });
if (result.length !== 1) throw new Error('expected 1 vela worktree, got ' + result.length);
if (!result[0].path.includes('.vela/worktrees')) throw new Error('bad path: ' + result[0].path);
if (!result[0].branch) throw new Error('missing branch');
if (!result[0].head) throw new Error('missing head');
// Clean up the non-vela worktree
execFileSync('git', ['worktree', 'remove', '--force', nonVelaPath], { cwd: '$REPO1' });
execFileSync('git', ['branch', '-D', 'non-vela-branch'], { cwd: '$REPO1' });
console.log('vela worktrees: ' + JSON.stringify(result));
\""

# T4: remove() succeeds, path gone from disk and list
run_test "remove() removes worktree from disk and list" \
  "node -e \"
const wt = require('$MODULE');
const fs = require('fs');
const items = wt.list({ cwd: '$REPO1' });
const removedPath = items[0].path;
if (!fs.existsSync(removedPath)) throw new Error('worktree path should exist before remove');
const result = wt.remove({ cwd: '$REPO1', worktreePath: removedPath });
if (!result.ok) throw new Error('remove did not return ok');
if (fs.existsSync(removedPath)) throw new Error('worktree path still exists on disk after remove');
const after = wt.list({ cwd: '$REPO1' });
if (after.length !== 0) throw new Error('worktree still listed: ' + after.length);
\""

# T5: list() returns empty when no vela worktrees exist
REPO2="$(make_repo)"
run_test "list() returns [] when no vela worktrees" \
  "node -e \"
const wt = require('$MODULE');
const result = wt.list({ cwd: '$REPO2' });
if (result.length !== 0) throw new Error('expected 0, got ' + result.length);
\""

# T6: cleanup() returns { removed: 0 } when no worktrees
run_test "cleanup() idempotent on empty" \
  "node -e \"
const wt = require('$MODULE');
const result = wt.cleanup({ cwd: '$REPO2' });
if (result.removed !== 0) throw new Error('expected 0, got ' + result.removed);
\""

# T7: cleanup() removes multiple worktrees
REPO3="$(make_repo)"
run_test "cleanup() removes multiple worktrees" \
  "node -e \"
const wt = require('$MODULE');
wt.create({ cwd: '$REPO3', pipelineSlug: 'test-s02', role: 'exec' });
wt.create({ cwd: '$REPO3', pipelineSlug: 'test-s02', role: 'review' });
const before = wt.list({ cwd: '$REPO3' });
if (before.length !== 2) throw new Error('expected 2, got ' + before.length);
const result = wt.cleanup({ cwd: '$REPO3' });
if (result.removed !== 2) throw new Error('expected 2 removed, got ' + result.removed);
const after = wt.list({ cwd: '$REPO3' });
if (after.length !== 0) throw new Error('expected 0 after cleanup, got ' + after.length);
\""

# T8: create() handles branch collision with timestamp suffix
REPO4="$(make_repo)"
run_test "create() handles branch collision" \
  "node -e \"
const wt = require('$MODULE');
const r1 = wt.create({ cwd: '$REPO4', pipelineSlug: 'dup', role: 'test' });
// remove worktree but leave branch
const { execFileSync } = require('child_process');
execFileSync('git', ['worktree', 'remove', '--force', r1.path], { cwd: '$REPO4' });
// branch vela/wt-dup-test still exists — next create should suffix
const r2 = wt.create({ cwd: '$REPO4', pipelineSlug: 'dup', role: 'test' });
if (r2.branch === r1.branch) throw new Error('branches should differ on collision');
if (!r2.branch.startsWith('vela/wt-dup-test-')) throw new Error('bad suffix: ' + r2.branch);
console.log('r1=' + r1.branch + ' r2=' + r2.branch);
// cleanup
wt.cleanup({ cwd: '$REPO4' });
\""

# T9: remove() throws on non-existent path
REPO5="$(make_repo)"
run_test "remove() throws on non-existent path" \
  "node -e \"
const wt = require('$MODULE');
try {
  wt.remove({ cwd: '$REPO5', worktreePath: '/nonexistent/path' });
  throw new Error('should have thrown');
} catch (e) {
  if (!e.message.includes('not found')) throw new Error('wrong error: ' + e.message);
}
\""

# T10: create() throws on missing args
run_test "create() throws on missing args" \
  "node -e \"
const wt = require('$MODULE');
try {
  wt.create({ cwd: '$REPO5' });
  throw new Error('should have thrown');
} catch (e) {
  if (!e.message.includes('required')) throw new Error('wrong error: ' + e.message);
}
\""

# ── Summary ───────────────────────────────────────────────────

echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "ALL PASS"
