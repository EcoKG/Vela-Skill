#!/bin/bash
# ⛵ Vela Engine — Shared deploy functions
# Sourced by install.sh and update.sh to avoid duplication.

# Guard against double-sourcing
[ -n "$_VELA_DEPLOY_COMMON_LOADED" ] && return 0
_VELA_DEPLOY_COMMON_LOADED=1

# ─── Shared function: sync local .vela/ project from source ───
# Used by install.sh (auto-upgrade) and update.sh (--local)
sync_local_project() {
  local SRC="$1"

  # Shared modules
  mkdir -p .vela/shared
  cp "$SRC/scripts/shared/"*.js .vela/shared/ 2>/dev/null

  # Hooks (staging — gate-keeper, gate-guard, stop, review-gate)
  mkdir -p .vela/hooks
  mkdir -p .vela/hooks/shared
  cp "$SRC/scripts/hooks/vela-gate-keeper.js" .vela/hooks/ 2>/dev/null
  cp "$SRC/scripts/hooks/vela-gate-guard.js" .vela/hooks/ 2>/dev/null
  cp "$SRC/scripts/hooks/vela-stop.js" .vela/hooks/ 2>/dev/null
  cp "$SRC/scripts/hooks/vela-review-gate.js" .vela/hooks/ 2>/dev/null
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

  # Templates (skip config.json to preserve user settings)
  mkdir -p .vela/templates
  cp "$SRC/templates/pipeline.json" .vela/templates/ 2>/dev/null


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

  # Re-run install to update settings.local.json
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
