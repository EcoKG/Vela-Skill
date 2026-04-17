#!/usr/bin/env bash
# ⛵ Vela — install.sh (deprecated in v8.0, removal in v8.2)
#
# Vela is now a Claude Code plugin. The curl + install.sh path is
# replaced by the plugin marketplace flow. Run inside Claude Code:
#
#   /plugin install vela@EcoKG/Vela-Skill
#
# If you're on Claude Code 2.1.107+, the plugin system handles
# installation, updates, permissions, and hook registration without
# editing ~/.claude/settings.json by hand.
#
# After the plugin is installed, initialize each project once:
#
#   /vela:install
#
# This shim will be deleted in v8.2.
cat <<'EOF' >&2
⛵ Vela v8.0 — install.sh is deprecated.

  Vela is now a Claude Code plugin. Install it via:

    /plugin install vela@EcoKG/Vela-Skill

  Then initialize each project with:

    /vela:install

  (This shim is scheduled for removal in v8.2.)
EOF
exit 1
