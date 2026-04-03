#!/bin/bash
# ⛵ Vela Engine — One-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/install.sh | bash
#
# Installs Vela as a Claude Code skill in $HOME/.claude/skills/vela/

set -e

REPO="https://github.com/EcoKG/Vela-Skill.git"
TMP="$HOME/.vela-install-tmp"
SKILL_DIR="$HOME/.claude/skills/vela"

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

# Scripts (cli, agents, cache, guidelines, tests, shared, install)
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

# ─── Note: No Agent Teams env injection needed ───
# Vela uses SDK query() orchestrator (vela-pipeline.js), not Claude Code hooks.
# CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is not required.

# ─── Install npm dependencies globally (SQLite backends for TreeNode cache) ───
if command -v npm &>/dev/null; then
  echo "  📦 Installing npm dependencies globally..."

  # Core: playwright + sql.js (always needed)
  npm install -g playwright sql.js --no-audit --no-fund 2>/dev/null

  # better-sqlite3 (native build — may fail)
  npm install -g better-sqlite3 --no-audit --no-fund 2>/dev/null && {
    SQLITE_BACKEND="better-sqlite3"
  } || {
    SQLITE_BACKEND="sql.js"
    echo "  ⚠ Native build failed — sql.js (WASM) will be used"
  }

  # Install Playwright Chromium browser binary
  npx playwright install chromium 2>/dev/null || echo "  ⚠ Playwright chromium install failed"
fi

# ─── Optional: Install Claude Agent SDK (enables SDK orchestrator mode) ───
if command -v npm &>/dev/null; then
  echo "  🔌 Installing Claude Agent SDK (optional)..."
  npm install -g @anthropic-ai/claude-agent-sdk --no-audit --no-fund 2>/dev/null && {
    echo "  ✅ Claude Agent SDK installed globally"
  } || {
    echo "  ⚠ Claude Agent SDK not installed — CLI mode will be used (fully functional)"
  }
fi

# ─── Source shared deploy functions ───
source "$SKILL_DIR/scripts/deploy-common.sh"

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
echo ""
echo "✦───────────────────────────────────────✦"
echo "  ⛵ Vela Engine v${VELA_VERSION} installed successfully!"
echo "✦───────────────────────────────────────✦"
echo ""
echo "  📂 Location: $SKILL_DIR"
echo "  💾 SQLite: ${SQLITE_BACKEND:-not checked}"
echo "  🔌 SDK: Claude Agent SDK"
echo ""
echo "  🧭 Quick Start:"
echo "     /vela init    — 프로젝트에 Vela 환경 구축"
echo "     /vela start   — 파이프라인 바로 시작"
echo "     /vela auto    — 무인 자동 실행"
echo ""
echo "  📖 Docs: https://github.com/EcoKG/Vela-Skill"
echo ""
