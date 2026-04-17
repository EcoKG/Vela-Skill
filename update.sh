#!/usr/bin/env bash
# ⛵ Vela — update.sh (deprecated in v8.0, removal in v8.2)
#
# Updates are now handled by the Claude Code plugin system. Run
# inside Claude Code:
#
#   /plugin update vela
#
# To re-sync a project's local templates after a plugin update:
#
#   /vela:install --resync
#
# This shim will be deleted in v8.2.
cat <<'EOF' >&2
⛵ Vela v8.0 — update.sh is deprecated.

  Updates go through the Claude Code plugin system:

    /plugin update vela

  To re-sync project-local templates after an update:

    /vela:install --resync

  (This shim is scheduled for removal in v8.2.)
EOF
exit 1
