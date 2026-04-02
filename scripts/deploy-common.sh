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
  cp "$SRC/templates/presets.json" .vela/templates/ 2>/dev/null

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
