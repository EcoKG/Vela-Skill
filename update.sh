#!/bin/bash
# ⛵ Vela Engine — Update script
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
git clone --depth 1 -b main "$REPO" "$TMP" 2>/dev/null || {
  echo "❌ git clone failed. Check network and try again."
  exit 1
}

# ─── Read version from package.json (single source of truth) ───
VELA_VERSION=$(node -e "process.stdout.write(require('$TMP/package.json').version)" 2>/dev/null || echo '?')

# ─── Global skill update ───
mkdir -p "$SKILL_DIR"

# Core files
cp "$TMP/SKILL.md" "$SKILL_DIR/"
cp "$TMP/README.md" "$SKILL_DIR/" 2>/dev/null
cp "$TMP/package.json" "$SKILL_DIR/" 2>/dev/null

# Scripts (full replace to catch new files)
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
  # Install as independent top-level skills so /vela:start etc. appear in autocomplete
  SKILLS_ROOT="$HOME/.claude/skills"
  for sub in start git-clean analyze update; do
    if [ -d "$TMP/skills/$sub" ]; then
      mkdir -p "$SKILLS_ROOT/vela-$sub"
      cp "$TMP/skills/$sub/SKILL.md" "$SKILLS_ROOT/vela-$sub/SKILL.md"
    fi
  done
fi

# Plugin metadata
if [ -d "$TMP/.claude-plugin" ]; then
  rm -rf "$SKILL_DIR/.claude-plugin" 2>/dev/null
  cp -r "$TMP/.claude-plugin" "$SKILL_DIR/.claude-plugin"
fi

# Update npm dependencies globally
if command -v npm &>/dev/null; then
  # Core: playwright + sql.js + better-sqlite3
  npm install -g playwright sql.js --no-audit --no-fund 2>/dev/null
  npm install -g better-sqlite3 --no-audit --no-fund 2>/dev/null || {
    echo "  ⚠ Native build failed — sql.js (WASM) will be used"
  }

  # Install Playwright Chromium browser binary
  npx playwright install chromium 2>/dev/null || echo "  ⚠ Playwright chromium install failed"
fi

echo "  ✦ Global skill updated: $SKILL_DIR"

# ─── Register SessionStart version-check hook ───
source "$TMP/scripts/deploy-common.sh"
register_session_start_hook

# ─── Local project update (--local) ───
if [ "$LOCAL_FLAG" = "--local" ]; then
  if [ -d ".vela" ]; then
    echo "  🧭 Updating local project: $(pwd)/.vela/"
    sync_local_project "$TMP"

    echo "  ✦ Local project updated"
  else
    echo "  ⚠ No .vela/ found in current directory. Use /vela init first."
  fi
fi

# ─── Cleanup ───
rm -rf "$TMP" 2>/dev/null

echo ""
echo "✦───────────────────────────────────────✦"
echo "  ⛵ Update complete! (v${VELA_VERSION})"
echo "✦───────────────────────────────────────✦"
echo ""
