#!/bin/bash
# ⛵ Vela Engine v3.1 — One-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/install.sh | bash
#
# Installs Vela as a Claude Code skill in $HOME/.claude/skills/vela/

set -e

REPO="https://github.com/EcoKG/Vela-Skill.git"
TMP="$HOME/.vela-install-tmp"
SKILL_DIR="$HOME/.claude/skills/vela"
SETTINGS="$HOME/.claude/settings.json"

echo ""
echo "⛵ Vela Engine v3.1 — Installing..."
echo ""

# ─── Clean previous attempts ───
rm -rf "$TMP" 2>/dev/null

# ─── Clone ───
git clone --depth 1 -b main "$REPO" "$TMP" 2>/dev/null || {
  echo "❌ git clone failed. Check network and try again."
  exit 1
}

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

# Skills (sub-skills: init, start)
if [ -d "$TMP/skills" ]; then
  rm -rf "$SKILL_DIR/skills" 2>/dev/null
  cp -r "$TMP/skills" "$SKILL_DIR/skills"
fi

# Plugin metadata
if [ -d "$TMP/.claude-plugin" ]; then
  rm -rf "$SKILL_DIR/.claude-plugin" 2>/dev/null
  cp -r "$TMP/.claude-plugin" "$SKILL_DIR/.claude-plugin"
fi

# ─── Enable Agent Teams in global settings ───
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

# ─── Cleanup ───
rm -rf "$TMP" 2>/dev/null

# ─── Verify ───
HOOK_COUNT=0
if [ -d "$SKILL_DIR/scripts/hooks" ]; then
  HOOK_COUNT=$(ls "$SKILL_DIR/scripts/hooks/"*.js 2>/dev/null | wc -l | tr -d ' ')
fi

echo ""
echo "✦───────────────────────────────────────✦"
echo "  ⛵ Vela Engine installed successfully!"
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
