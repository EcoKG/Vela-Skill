#!/bin/bash
# ⛵ Vela Engine — One-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/install.sh | bash
#
# Installs Vela as a Claude Code skill in $HOME/.claude/skills/vela/

set -e

REPO="https://github.com/EcoKG/Vela-Skill.git"
TMP="$HOME/.vela-install-tmp"
SKILL_DIR="$HOME/.claude/skills/vela"
SETTINGS="$HOME/.claude/settings.json"

echo ""
echo "⛵ Vela Engine — Installing..."
echo ""

# ─── Clean previous attempts ───
rm -rf "$TMP" 2>/dev/null

# ─── Clone ───
git clone --depth 1 -b main "$REPO" "$TMP" 2>/dev/null || {
  echo "❌ git clone failed. Check network and try again."
  exit 1
}

# ─── Read version from package.json (single source of truth) ───
VELA_VERSION=$(node -e "process.stdout.write(require('$TMP/package.json').version)" 2>/dev/null || echo '?')

# ─── Create skill directory ───
mkdir -p "$SKILL_DIR"

# ─── Copy skill structure ───
# Core files
cp "$TMP/SKILL.md" "$SKILL_DIR/"
cp "$TMP/README.md" "$SKILL_DIR/" 2>/dev/null
cp "$TMP/package.json" "$SKILL_DIR/" 2>/dev/null

# Scripts (hooks, cli, agents, cache, guidelines, tests, shared, install)
if [ -d "$TMP/scripts" ]; then
  rm -rf "$SKILL_DIR/scripts" 2>/dev/null
  cp -r "$TMP/scripts" "$SKILL_DIR/scripts"
fi

# Templates
if [ -d "$TMP/templates" ]; then
  rm -rf "$SKILL_DIR/templates" 2>/dev/null
  cp -r "$TMP/templates" "$SKILL_DIR/templates"
fi

# References
if [ -d "$TMP/references" ]; then
  rm -rf "$SKILL_DIR/references" 2>/dev/null
  cp -r "$TMP/references" "$SKILL_DIR/references"
fi

# Skills (sub-skills installed as independent top-level skills for Claude Code autocomplete)
if [ -d "$TMP/skills" ]; then
  rm -rf "$SKILL_DIR/skills" 2>/dev/null
  cp -r "$TMP/skills" "$SKILL_DIR/skills"
  # Install as independent top-level skills so /vela:init etc. appear in autocomplete
  SKILLS_ROOT="$HOME/.claude/skills"
  for sub in init start git-clean auto analyze; do
    if [ -d "$TMP/skills/$sub" ]; then
      mkdir -p "$SKILLS_ROOT/vela-$sub"
      cp "$TMP/skills/$sub/SKILL.md" "$SKILLS_ROOT/vela-$sub/SKILL.md"
    fi
  done
fi

# Test fixtures (sample data for analyze/report)
if [ -d "$TMP/test-fixtures" ]; then
  rm -rf "$SKILL_DIR/test-fixtures" 2>/dev/null
  cp -r "$TMP/test-fixtures" "$SKILL_DIR/test-fixtures"
fi

# Plugin metadata
if [ -d "$TMP/.claude-plugin" ]; then
  rm -rf "$SKILL_DIR/.claude-plugin" 2>/dev/null
  cp -r "$TMP/.claude-plugin" "$SKILL_DIR/.claude-plugin"
fi

# ─── Enable Agent Teams in global settings ───
if command -v node &>/dev/null; then
  mkdir -p "$HOME/.claude"
  # AUDIT-030: Backup settings.json before modification
  cp "$SETTINGS" "$SETTINGS.bak" 2>/dev/null || true
  node -e "
    const fs = require('fs');
    const p = '$SETTINGS';
    let d = {};
    try { d = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch(e) {}
    if (!d.env) d.env = {};
    d.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
    console.log('  🌟 Agent Teams enabled in settings.json');
  " 2>/dev/null || echo "  ⚠ Agent Teams: add CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 manually"
fi

# ─── Install npm dependencies (SQLite backends for TreeNode cache) ───
if command -v npm &>/dev/null && [ -f "$SKILL_DIR/package.json" ]; then
  echo "  📦 Installing SQLite backends..."
  (cd "$SKILL_DIR" && npm install --no-audit --no-fund 2>/dev/null) && {
    SQLITE_BACKEND="better-sqlite3"
  } || {
    # better-sqlite3 needs native compilation — try sql.js (pure WASM) as fallback
    echo "  ⚠ Native build failed — installing sql.js (WASM fallback)..."
    (cd "$SKILL_DIR" && npm install sql.js --no-audit --no-fund 2>/dev/null) && {
      SQLITE_BACKEND="sql.js"
    } || {
      SQLITE_BACKEND="json-fallback"
      echo "  ⚠ npm install failed — TreeNode cache will use JSON fallback"
    }
  }
fi

# ─── Optional: Install Claude Agent SDK (enables SDK mode) ───
if command -v npm &>/dev/null; then
  echo "  🔌 Installing Claude Agent SDK (optional)..."
  if (cd "$SKILL_DIR" && npm install @anthropic-ai/claude-agent-sdk --no-audit --no-fund 2>/dev/null); then
    echo "  ✅ Claude Agent SDK installed — SDK mode available"
  else
    echo "  ⚠ Claude Agent SDK not installed — non-SDK mode will be used (fully functional)"
  fi
fi

# ─── Shared function: sync local .vela/ project from source ───
# Used by auto-upgrade block (below) and update.sh --local
sync_local_project() {
  local SRC="$1"

  # Hooks
  cp "$SRC/scripts/hooks/"*.js .vela/hooks/ 2>/dev/null
  mkdir -p .vela/hooks/shared
  cp "$SRC/scripts/hooks/shared/"*.js .vela/hooks/shared/ 2>/dev/null

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

  # Re-run install to update settings.local.json with new hooks
  if [ -f ".vela/install.js" ]; then
    node .vela/install.js 2>/dev/null | tail -1
  fi
}

# ─── Auto-upgrade existing local .vela/ projects ───
# If install.sh is run from inside a project that already has .vela/,
# automatically update the local project too (same as update.sh --local).
if [ -d ".vela" ]; then
  echo "  🧭 Detected existing .vela/ — auto-upgrading local project..."
  sync_local_project "$SKILL_DIR"
  echo "  ✦ Local project auto-upgraded"
fi

# ─── Cleanup ───
rm -rf "$TMP" 2>/dev/null

# ─── Verify ───
HOOK_COUNT=0
if [ -d "$SKILL_DIR/scripts/hooks" ]; then
  HOOK_COUNT=$(ls "$SKILL_DIR/scripts/hooks/"*.js 2>/dev/null | wc -l | tr -d ' ')
fi

echo ""
echo "✦───────────────────────────────────────✦"
echo "  ⛵ Vela Engine v${VELA_VERSION} installed successfully!"
echo "✦───────────────────────────────────────✦"
echo ""
echo "  📂 Location: $SKILL_DIR"
echo "  🔧 Hooks: ${HOOK_COUNT} scripts"
echo "  💾 SQLite: ${SQLITE_BACKEND:-not checked}"
echo "  🌟 Agent Teams: enabled"
echo ""
echo "  🧭 Quick Start:"
echo "     /vela init    — 프로젝트에 Vela 환경 구축"
echo "     /vela start   — 파이프라인 바로 시작"
echo "     /vela auto    — 무인 자동 실행"
echo ""
echo "  📖 Docs: https://github.com/EcoKG/Vela-Skill"
echo ""
