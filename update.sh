#!/bin/bash
# ⛵ Vela Engine v3.0 — Update script
# Updates global skill and optionally the current project's .vela/
#
# Global only:    curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/update.sh | bash
# Global + local: curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/update.sh | bash -s -- --local

set -e

REPO="https://github.com/EcoKG/Vela-Skill.git"
TMP="$HOME/.vela-update-tmp"
SKILL_DIR="$HOME/.claude/skills/vela"
LOCAL_FLAG="$1"

echo ""
echo "⛵ Vela Engine — Updating..."
echo ""

# ─── Clone latest ───
rm -rf "$TMP" 2>/dev/null
git clone --depth 1 "$REPO" "$TMP" 2>/dev/null || {
  echo "❌ git clone failed. Check network and try again."
  exit 1
}

# ─── Global skill update ───
mkdir -p "$SKILL_DIR"

# Core files
cp "$TMP/SKILL.md" "$SKILL_DIR/"
cp "$TMP/README.md" "$SKILL_DIR/" 2>/dev/null

# Scripts (full replace to catch new hooks/files)
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

# Skills
if [ -d "$TMP/skills" ]; then
  rm -rf "$SKILL_DIR/skills" 2>/dev/null
  cp -r "$TMP/skills" "$SKILL_DIR/skills"
fi

# Plugin metadata
if [ -d "$TMP/.claude-plugin" ]; then
  rm -rf "$SKILL_DIR/.claude-plugin" 2>/dev/null
  cp -r "$TMP/.claude-plugin" "$SKILL_DIR/.claude-plugin"
fi

HOOK_COUNT=$(ls "$SKILL_DIR/scripts/hooks/"*.js 2>/dev/null | wc -l | tr -d ' ')
echo "  ✦ Global skill updated: $SKILL_DIR ($HOOK_COUNT hooks)"

# ─── Local project update (--local) ───
if [ "$LOCAL_FLAG" = "--local" ]; then
  if [ -d ".vela" ]; then
    echo "  🧭 Updating local project: $(pwd)/.vela/"

    # Hooks (all .js files)
    cp "$TMP/scripts/hooks/"*.js .vela/hooks/ 2>/dev/null
    mkdir -p .vela/hooks/shared
    cp "$TMP/scripts/hooks/shared/"*.js .vela/hooks/shared/ 2>/dev/null

    # CLI
    mkdir -p .vela/cli
    cp "$TMP/scripts/cli/"*.js .vela/cli/ 2>/dev/null

    # Cache
    mkdir -p .vela/cache
    cp "$TMP/scripts/cache/"*.js .vela/cache/ 2>/dev/null

    # Install script
    cp "$TMP/scripts/install.js" .vela/ 2>/dev/null

    # Statusline
    cp "$TMP/scripts/statusline.sh" .vela/ 2>/dev/null

    # Agents
    mkdir -p .vela/agents
    cp "$TMP/scripts/agents/"*.md .vela/agents/ 2>/dev/null

    # Guidelines
    mkdir -p .vela/guidelines
    cp "$TMP/scripts/guidelines/"*.md .vela/guidelines/ 2>/dev/null

    # Templates (pipeline.json, presets.json — skip config.json to preserve user settings)
    cp "$TMP/templates/pipeline.json" .vela/templates/ 2>/dev/null
    cp "$TMP/templates/presets.json" .vela/templates/ 2>/dev/null

    # References
    mkdir -p .vela/references
    cp "$TMP/references/"*.md .vela/references/ 2>/dev/null

    # Update .claude/agents/vela.md
    if [ -d ".claude/agents" ]; then
      cp "$TMP/scripts/agents/vela.md" .claude/agents/ 2>/dev/null
    fi

    # Re-run install to update settings.local.json with new hooks
    if [ -f ".vela/install.js" ]; then
      node .vela/install.js 2>/dev/null | tail -1
    fi

    echo "  ✦ Local project updated"
  else
    echo "  ⚠ No .vela/ found in current directory. Use /vela init first."
  fi
fi

# ─── Cleanup ───
rm -rf "$TMP" 2>/dev/null

echo ""
echo "✦───────────────────────────────────────✦"
echo "  ⛵ Update complete!"
echo "✦───────────────────────────────────────✦"
echo ""
