#!/usr/bin/env bash
# scripts/tests/helpers/setup-plugin-env.sh
#
# Shared test setup for the v8.0 plugin layout. Source this from
# individual test-*.sh files so they don't each re-encode the same
# paths.
#
# Usage inside a test:
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   source "$SCRIPT_DIR/helpers/setup-plugin-env.sh"
#
# After sourcing, these variables are available:
#   REPO_ROOT            absolute path to the Vela-Skill repo root
#   CLAUDE_PLUGIN_ROOT   exported, same as REPO_ROOT (plugin runtime)
#   VELA_ENGINE          path to scripts/cli/vela-engine.js
#   VELA_ENGINE_WRAPPER  path to bin/vela-engine (PATH-exposable)
#   PATH                 prepended with $REPO_ROOT/bin so the
#                        `vela-engine` short form works too
#
# Also provides two helpers:
#   vela_init_project <dir>     run init-project in the given dir
#                                (wraps INIT_CWD + CLAUDE_PLUGIN_ROOT)
#   vela_bootstrap_fixture <dir>
#                                like vela_init_project but also runs
#                                `git init` + a first commit if the
#                                dir isn't already a repo.

set -u

# Resolve repo root from this helper's location.
# scripts/tests/helpers/ → scripts/tests/ → scripts/ → repo root
_HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_HELPER_DIR/../../.." && pwd)"

export CLAUDE_PLUGIN_ROOT="$REPO_ROOT"
export VELA_ENGINE="$REPO_ROOT/scripts/cli/vela-engine.js"
export VELA_ENGINE_WRAPPER="$REPO_ROOT/bin/vela-engine"

# Prepend plugin bin/ to PATH so `vela-engine <sub>` works inline.
case ":$PATH:" in
  *":$REPO_ROOT/bin:"*) : ;;
  *) export PATH="$REPO_ROOT/bin:$PATH" ;;
esac

vela_init_project() {
  local dir="$1"
  [ -z "$dir" ] && { echo "vela_init_project: dir required" >&2; return 1; }
  ( cd "$dir" && INIT_CWD="$dir" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    node "$VELA_ENGINE" init-project --cleanup-legacy=skip )
}

vela_bootstrap_fixture() {
  local dir="$1"
  [ -z "$dir" ] && { echo "vela_bootstrap_fixture: dir required" >&2; return 1; }
  mkdir -p "$dir"
  if [ ! -d "$dir/.git" ]; then
    ( cd "$dir" \
      && git init -q \
      && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false \
           commit --allow-empty -q -m "fixture initial" )
  fi
  vela_init_project "$dir"
}
