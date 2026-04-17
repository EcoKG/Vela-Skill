#!/bin/bash
# ⛵ Vela Engine — Shared deploy functions
# Sourced by install.sh and update.sh to avoid duplication.

# Guard against double-sourcing. The `:-` default prevents an unbound-variable
# error when the parent shell has `set -u` active (e.g. a strict-mode test
# harness sourcing this file).
[ -n "${_VELA_DEPLOY_COMMON_LOADED:-}" ] && return 0
_VELA_DEPLOY_COMMON_LOADED=1

# ─── Shared function: sync local .vela/ project from source ───
# Used by install.sh (auto-upgrade) and update.sh (--local)
#
# v7.1.1 drift fix:
#   Pre-v7.1.1 this function enumerated individual hook filenames and
#   hard-coded `templates/pipeline.json` as the only template to copy.
#   v7.1 added (v7.3-M4: vela-file-read-cache.js 제거됨):
#     - templates/role-budgets.json (M9)
#     - templates/guidelines/* (M3)
#     - templates/plan-templates/* (M4)
#   None of those were picked up by this function, so `update.sh --local`
#   silently left users on partial v7.0.7 state for those artifacts. The
#   install.js FILE_MANIFEST did list them, but sync_local_project runs
#   BEFORE `node .vela/install.js`, and install.js upgrade requires
#   velaDir to already exist. The final `node .vela/install.js` call at
#   the bottom of this function is where FILE_MANIFEST takes over — but
#   since the files aren't deployed yet, registerGlobalHooks() has
#   nothing to point at for the new file-read-cache hook.
#
#   v7.1.1 flips the directory copies to `cp` globs so new files are
#   picked up automatically. Subdirectories under templates/ are copied
#   recursively so the new guidelines/ and plan-templates/ trees come
#   along for free. The only thing that stays hand-listed is the
#   agent subdir allowlist, because the Vela repo has some legacy subdirs
#   (conflict-manager, leader) that install.js FILE_MANIFEST does NOT
#   include; we keep the historical behaviour there to avoid re-shipping
#   retired files.
sync_local_project() {
  local SRC="$1"

  # Shared modules
  mkdir -p .vela/shared
  cp "$SRC/scripts/shared/"*.js .vela/shared/ 2>/dev/null

  # Hooks — v7.1.1: glob over scripts/hooks/*.js so any hook added to the
  # repo (v7.3-M4: vela-file-read-cache/post-tool-learning 제거됨) is
  # automatically deployed. session-start-version-check.js and vela-session-start.js
  # live under hooks/ too and are meant for the global install path, not
  # the project — filter them out explicitly so the project .vela/hooks/
  # stays clean.
  mkdir -p .vela/hooks
  mkdir -p .vela/hooks/shared
  for hook_src in "$SRC/scripts/hooks/"*.js; do
    [ -f "$hook_src" ] || continue
    hook_name=$(basename "$hook_src")
    case "$hook_name" in
      session-start-version-check.js|vela-session-start.js) continue ;;
    esac
    cp "$hook_src" .vela/hooks/ 2>/dev/null
  done
  cp "$SRC/scripts/hooks/shared/constants.js" .vela/hooks/shared/ 2>/dev/null

  # CLI
  mkdir -p .vela/cli
  cp "$SRC/scripts/cli/"*.js .vela/cli/ 2>/dev/null

  # Cache
  mkdir -p .vela/cache
  cp "$SRC/scripts/cache/"*.js .vela/cache/ 2>/dev/null

  # Install script
  cp "$SRC/scripts/install.js" .vela/ 2>/dev/null

  # Statusline
  cp "$SRC/scripts/statusline.sh" .vela/ 2>/dev/null

  # Agents (top-level + subdirectories)
  mkdir -p .vela/agents
  cp "$SRC/scripts/agents/"*.md .vela/agents/ 2>/dev/null
  for sub in pm researcher planner executor reviewer conflict-manager leader; do
    if [ -d "$SRC/scripts/agents/$sub" ]; then
      mkdir -p ".vela/agents/$sub"
      cp "$SRC/scripts/agents/$sub/"*.md ".vela/agents/$sub/" 2>/dev/null
    fi
  done

  # Guidelines
  mkdir -p .vela/guidelines
  cp "$SRC/scripts/guidelines/"*.md .vela/guidelines/ 2>/dev/null

  # Templates (v7.1.1: recursive copy to pick up subdirs like
  # guidelines/ (v7.1 M3) and plan-templates/ (v7.1 M4) and
  # role-budgets.json (v7.1 M9) without maintaining a file list).
  # config.json must NOT be overwritten — user may have customised it,
  # so we copy templates/*.json / *.md excluding config.json, then
  # recursively copy subdirectories.
  mkdir -p .vela/templates
  for f in "$SRC/templates/"*; do
    [ -e "$f" ] || continue
    fname=$(basename "$f")
    if [ -d "$f" ]; then
      # Subdirectory (guidelines/, plan-templates/) — recursive copy
      mkdir -p ".vela/templates/$fname"
      cp -r "$f/." ".vela/templates/$fname/" 2>/dev/null
    else
      # Top-level template file — skip config.json (user-owned)
      if [ "$fname" = "config.json" ]; then
        continue
      fi
      cp "$f" ".vela/templates/$fname" 2>/dev/null
    fi
  done


  # References
  mkdir -p .vela/references
  cp "$SRC/references/"*.md .vela/references/ 2>/dev/null

  # Note: skills/ directory is NOT copied to .vela/ — skills live only in the skill repository

  # Test fixtures
  if [ -d "$SRC/test-fixtures" ]; then
    rm -rf .vela/test-fixtures 2>/dev/null
    cp -r "$SRC/test-fixtures" .vela/test-fixtures
  fi

  # Update .claude/agents/vela.md
  if [ -d ".claude/agents" ]; then
    cp "$SRC/scripts/agents/vela.md" .claude/agents/ 2>/dev/null
  fi

  # Re-run install to update settings.local.json and register global hooks.
  # This MUST come after the file copies above because registerGlobalHooks
  # reads from .vela/hooks/ when staging to ~/.vela/hooks/.
  if [ -f ".vela/install.js" ]; then
    node .vela/install.js 2>/dev/null | tail -1
  fi
}

# ─── Shared function: register SessionStart hooks ────────────────
# Registers both the version-check hook and the rich session-start context hook
# into ~/.claude/settings.json (global).
# Used by install.sh and update.sh. Idempotent — safe to call multiple times.
register_session_start_hook() {
  local VERSION_CHECK_SCRIPT="$HOME/.claude/skills/vela/scripts/hooks/session-start-version-check.js"
  local SESSION_START_SCRIPT="$HOME/.claude/skills/vela/scripts/hooks/vela-session-start.js"
  local SETTINGS_FILE="$HOME/.claude/settings.json"

  # Verify version-check script exists (required)
  if [ ! -f "$VERSION_CHECK_SCRIPT" ]; then
    return 1
  fi

  # Use node to safely merge both hooks into settings.json
  node -e "
const fs = require('fs');
const settingsPath = '$SETTINGS_FILE';
const versionCheckCmd = 'node $VERSION_CHECK_SCRIPT';
const sessionStartCmd = 'node $SESSION_START_SCRIPT';
const hasSessionStart = fs.existsSync('$SESSION_START_SCRIPT');

let settings = {};
try {
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
} catch (e) {
  console.error('  ⚠ Could not parse ' + settingsPath + ' — skipping hook registration');
  process.exit(1);
}

settings.hooks = settings.hooks || {};
settings.hooks.SessionStart = settings.hooks.SessionStart || [];

// Remove any existing Vela SessionStart hook entries (idempotent cleanup)
settings.hooks.SessionStart = settings.hooks.SessionStart.filter(entry => {
  if (!entry) return false;
  // Remove by _velaId
  if (entry._velaId && (entry._velaId === 'vela-version-check' || entry._velaId === 'vela-session-start')) return false;
  // Remove legacy flat format
  if (entry.hooks && Array.isArray(entry.hooks)) {
    const hasVelaHook = entry.hooks.some(h =>
      h && h.command && (
        h.command.includes('session-start-version-check.js') ||
        h.command.includes('vela-session-start.js')
      )
    );
    if (hasVelaHook) return false;
  }
  return true;
});

// Register version-check hook (network check, 5s timeout)
settings.hooks.SessionStart.push({
  _velaId: 'vela-version-check',
  hooks: [{ type: 'command', command: versionCheckCmd, timeout: 5 }]
});

// Register rich session-start context injection hook (8s timeout — git + fs reads)
if (hasSessionStart) {
  settings.hooks.SessionStart.push({
    _velaId: 'vela-session-start',
    hooks: [{ type: 'command', command: sessionStartCmd, timeout: 8 }]
  });
}

fs.mkdirSync(require('path').dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
if (hasSessionStart) {
  console.log('  ⛵ SessionStart hooks registered (version-check + rich context)');
} else {
  console.log('  ⛵ SessionStart version-check hook registered');
}
" 2>&1
}
