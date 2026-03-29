#!/bin/bash
# ⛵ Vela Engine — One-line installer (Plugin format)
# Usage: curl -fsSL https://raw.githubusercontent.com/EcoKG/vela/main/install.sh | bash

REPO="https://github.com/EcoKG/vela.git"
TMP="$HOME/.vela-install-tmp"
PLUGIN_DIR="$HOME/.claude/skills/vela"
SETTINGS="$HOME/.claude/settings.json"

echo "⛵ Vela Engine — Installing as plugin..."

# Clean previous attempts
rm -rf "$TMP" 2>/dev/null

# Clone
git clone --depth 1 "$REPO" "$TMP" 2>/dev/null || { echo "❌ git clone failed"; exit 1; }

# Create plugin directory
mkdir -p "$PLUGIN_DIR"

# Copy plugin structure
cp -r "$TMP/.claude-plugin" "$PLUGIN_DIR/"
cp -r "$TMP/skills" "$PLUGIN_DIR/"
cp -r "$TMP/scripts" "$PLUGIN_DIR/"
cp -r "$TMP/templates" "$PLUGIN_DIR/"
cp "$TMP/README.md" "$PLUGIN_DIR/" 2>/dev/null

# Keep SKILL.md as fallback
cp "$TMP/SKILL.md" "$PLUGIN_DIR/" 2>/dev/null

# Cleanup
rm -rf "$TMP" 2>/dev/null

# Enable Agent Teams in global settings
if command -v node &>/dev/null; then
  mkdir -p "$HOME/.claude"
  node -e "
    const fs = require('fs');
    const p = '$SETTINGS';
    let d = {};
    try { d = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch(e) {}
    if (!d.env) d.env = {};
    d.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
    console.log('🌟 Agent Teams enabled');
  " 2>/dev/null || echo "⚠ Add manually: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
fi

echo ""
echo "✦ Vela Engine installed successfully! ✦"
echo ""
echo "⛵ Plugin: $PLUGIN_DIR"
echo "🌟 Agent Teams: enabled"
echo ""
echo "🧭 Commands:"
echo "   /vela:init    — 프로젝트에 Vela 환경 구축"
echo "   /vela:start   — 파이프라인 바로 시작"
echo ""
echo "✦─────────────────────✦"
