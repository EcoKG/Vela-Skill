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

# ─── Shared function: register SessionStart version check hook ───
# Used by install.sh and update.sh to add the version-check hook to ~/.claude/settings.json
# Idempotent — safe to call multiple times.
register_session_start_hook() {
  local HOOK_SCRIPT="$HOME/.claude/skills/vela/scripts/hooks/session-start-version-check.js"
  local SETTINGS_FILE="$HOME/.claude/settings.json"

  # Verify hook script exists
  if [ ! -f "$HOOK_SCRIPT" ]; then
    return 1
  fi

  # Use node to safely merge the hook into settings.json
  node -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';
const hookCommand = 'node $HOOK_SCRIPT';

let settings = {};
try {
  if (fs.existsSync(path)) {
    settings = JSON.parse(fs.readFileSync(path, 'utf8'));
  }
} catch (e) {
  console.error('  ⚠ Could not parse ' + path + ' — skipping hook registration');
  process.exit(1);
}

settings.hooks = settings.hooks || {};
settings.hooks.SessionStart = settings.hooks.SessionStart || [];

// Remove any existing Vela version-check hook entries (match by command substring)
settings.hooks.SessionStart = settings.hooks.SessionStart.filter(entry => {
  if (!entry || !Array.isArray(entry.hooks)) return true;
  const hasVelaHook = entry.hooks.some(h =>
    h && h.command && h.command.includes('session-start-version-check.js')
  );
  return !hasVelaHook;
});

// Add fresh entry
settings.hooks.SessionStart.push({
  hooks: [
    {
      type: 'command',
      command: hookCommand,
      timeout: 5
    }
  ]
});

fs.mkdirSync(require('path').dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log('  ⛵ SessionStart version-check hook registered');
" 2>&1
}
