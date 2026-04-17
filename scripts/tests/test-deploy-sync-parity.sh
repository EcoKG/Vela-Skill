#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-deploy-sync-parity.sh — v7.1.2 CI-enforced parity check
#
# Guards against the v7.1 drift we hit in hicoco: install.js
# FILE_MANIFEST listed the new v7.1 templates and hooks, but
# scripts/deploy-common.sh sync_local_project() still had
# hand-enumerated filenames, so `update.sh --local` silently
# missed 5 files. We merged v7.1.1 to fix the function itself;
# this test adds the *structural invariant* to CI so the same
# class of drift can never sneak past review again.
#
# Invariant:
#   Every entry in install.js FILE_MANIFEST (except entries
#   marked skipOnUpgrade:true and an explicit GLOBAL_ONLY
#   allowlist) must end up on disk after running
#   `sync_local_project "$REPO_ROOT"` inside a sandbox project.
#
# When this fails:
#   - Someone added a file to install.js FILE_MANIFEST but
#     forgot to update scripts/deploy-common.sh::sync_local_project
#     (or forgot to add their file to the glob pattern it copies)
#   - Or: someone renamed a file in one place but not the other.
#
# Remediation:
#   Update scripts/deploy-common.sh to copy the new file. If the
#   file is intentionally global-only (like the SessionStart
#   hooks), add it to the GLOBAL_ONLY list below with a comment
#   explaining why.
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_JS="$REPO_ROOT/scripts/install.js"
DEPLOY_COMMON="$REPO_ROOT/scripts/deploy-common.sh"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""
FAKE_HOME=""

cleanup() { [ -n "$TMPDIR_ROOT" ] && rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

note() {
  TOTAL=$((TOTAL + 1))
  if [ "$2" = "0" ]; then
    echo "  ✅ PASS: $1"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $1"
    FAIL=$((FAIL + 1))
  fi
}

# ─── Files in FILE_MANIFEST that are INTENTIONALLY global-only ─
#
# These files live under scripts/hooks/ because that's where the
# skill repo stages them for registerGlobalHooks() to copy into
# $HOME/.claude/skills/vela/scripts/hooks/. They don't belong in
# a per-project .vela/hooks/ because their purpose is session-
# level (version check on session start, session context
# injection) rather than pipeline-level.
#
# Add a new entry only with a comment explaining why. Any other
# FILE_MANIFEST entry MUST be reachable from sync_local_project.
GLOBAL_ONLY_DSTS=(
  "hooks/vela-session.js"
)

# ─── Setup a sandbox project with minimal skeleton ────────────
setup_sandbox() {
  cleanup
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  FAKE_HOME="$TMPDIR_ROOT/home"
  mkdir -p "$FAKE_HOME/.claude" "$PROJECT/.vela"
  (
    cd "$PROJECT"
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0=commit.gpgsign \
      GIT_CONFIG_VALUE_0=false \
      git init -q -b main
    git config user.email t@v.local
    git config user.name t
    echo "# test" > README.md
    git add README.md
    git -c commit.gpgsign=false commit -q -m "initial"
  )
}

# ─── Run sync_local_project in the sandbox ────────────────────
run_sync() {
  (
    set +e
    cd "$PROJECT"
    export HOME="$FAKE_HOME"
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=commit.gpgsign
    export GIT_CONFIG_VALUE_0=false
    # shellcheck disable=SC1090
    source "$DEPLOY_COMMON"
    sync_local_project "$REPO_ROOT" > /dev/null 2>&1
  )
}

# ─── Extract FILE_MANIFEST entries as newline-separated rows ──
# Format: `src<TAB>dst<TAB>skipOnUpgrade(0|1)` on each line.
# Parsed from install.js by regex because install.js is not
# importable as a module (it has top-level side effects). TSV
# rather than JSON so the bash reader doesn't need a JSON parser
# per row — that was the v7.1.2 first-cut bug (spawning node
# twice per manifest entry).
extract_manifest() {
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const re = /\{\s*src:\s*"([^"]+)"\s*,\s*dst:\s*"([^"]+)"([^}]*)\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const [, srcPath, dstPath, tail] = m;
      const skip = /skipOnUpgrade:\s*true/.test(tail) ? "1" : "0";
      console.log([srcPath, dstPath, skip].join("\t"));
    }
  ' "$INSTALL_JS"
}

is_global_only() {
  local dst="$1"
  for g in "${GLOBAL_ONLY_DSTS[@]}"; do
    if [ "$dst" = "$g" ]; then return 0; fi
  done
  return 1
}

# ═══════════════════════════════════════════════════════════════
# Phase 1: sanity — the extractor finds a non-trivial number of
# entries. If the regex ever breaks silently, this catches it.
# ═══════════════════════════════════════════════════════════════
echo "📋 Phase 1: FILE_MANIFEST extractor sanity"

MANIFEST_LINES=$(extract_manifest | wc -l | tr -d ' ')
[ "$MANIFEST_LINES" -ge 40 ]
note "extractor found ≥ 40 FILE_MANIFEST entries (got $MANIFEST_LINES)" $?

# And that config.json is flagged skipOnUpgrade
extract_manifest | grep -qP 'templates/config\.json\t1$'
note "extractor correctly flags templates/config.json skipOnUpgrade" $?

# ═══════════════════════════════════════════════════════════════
# Phase 2: parity — run sync, walk manifest, assert coverage.
# This is the whole point of the test.
# ═══════════════════════════════════════════════════════════════
echo "📋 Phase 2: manifest ⊆ sync_local_project output"

setup_sandbox
run_sync

MISSING=""
CHECKED=0
EXEMPT_SKIP=0
EXEMPT_GLOBAL=0
EXEMPT_NO_SRC=0
# Read TSV: src<TAB>dst<TAB>skipOnUpgrade(0|1)
while IFS=$'\t' read -r SRC DST SKIP; do
  [ -z "$SRC" ] && continue

  # Skip: config.json and any other skipOnUpgrade entries
  if [ "$SKIP" = "1" ]; then
    EXEMPT_SKIP=$((EXEMPT_SKIP + 1))
    continue
  fi

  # Skip: explicitly global-only allowlist
  if is_global_only "$DST"; then
    EXEMPT_GLOBAL=$((EXEMPT_GLOBAL + 1))
    continue
  fi

  # Skip: source file doesn't exist in the repo. install.js handles
  # this gracefully by pushing to results.skipped; sync_local_project
  # would also silently skip. Don't fail on missing source.
  if [ ! -f "$REPO_ROOT/$SRC" ]; then
    EXEMPT_NO_SRC=$((EXEMPT_NO_SRC + 1))
    continue
  fi

  CHECKED=$((CHECKED + 1))
  if [ ! -f "$PROJECT/.vela/$DST" ]; then
    MISSING="$MISSING $DST"
  fi
done < <(extract_manifest)

if [ -z "$MISSING" ]; then
  note "all $CHECKED required FILE_MANIFEST entries deployed by sync_local_project" 0
else
  note "sync_local_project is MISSING manifest entries:" 1
  echo "     ($EXEMPT_SKIP skipOnUpgrade, $EXEMPT_GLOBAL global-only, $EXEMPT_NO_SRC missing-source exempted)"
  echo "     $CHECKED required entries checked"
  echo "     Missing files (update scripts/deploy-common.sh::sync_local_project):"
  for f in $MISSING; do
    echo "       - .vela/$f (from scripts/…/$(echo "$f" | awk -F/ '{print $NF}'))"
  done
fi

# ═══════════════════════════════════════════════════════════════
# Phase 3: spot-check the v7.1 files specifically — these are the
# files the original drift would have missed. Keeping them as an
# explicit list (even though Phase 2 already covers them) makes
# the intent obvious in test output and locks in the regression
# the hotfix landed.
# ═══════════════════════════════════════════════════════════════
echo "📋 Phase 3: v7.1 drift regression guards (explicit)"

for v71_file in \
  "templates/role-budgets.json" \
  "templates/plan-templates/quick.md" \
  "templates/guidelines/live-processes.json" \
  "templates/guidelines/smoke-test.sh.example"; do
  if [ -f "$PROJECT/.vela/$v71_file" ]; then
    note "v7.1 file deployed: $v71_file" 0
  else
    note "v7.1 file deployed: $v71_file" 1
  fi
done

# ═══════════════════════════════════════════════════════════════
# Phase 4: config.json preservation — a user-customised
# templates/config.json must NOT be overwritten by a second sync.
# ═══════════════════════════════════════════════════════════════
echo "📋 Phase 4: config.json preservation after re-sync"

echo '{"__custom":"this-must-survive"}' > "$PROJECT/.vela/templates/config.json"
run_sync

if grep -q '__custom' "$PROJECT/.vela/templates/config.json" 2>/dev/null; then
  note "user-customised templates/config.json preserved across sync" 0
else
  note "user-customised templates/config.json preserved across sync" 1
fi

# ═══════════════════════════════════════════════════════════════
# Phase 5: reverse-sanity — prove the test would actually fail if
# deploy-common.sh drifted. We edit the running copy of
# deploy-common.sh in memory (via a tempfile copy), drop one of
# its cp operations, re-source it in a sub-shell, and verify the
# parity check catches the missing file.
# ═══════════════════════════════════════════════════════════════
echo "📋 Phase 5: reverse-sanity — broken deploy-common is detected"

setup_sandbox
BROKEN_DC="$TMPDIR_ROOT/deploy-common-broken.sh"
# Copy deploy-common and surgically remove the templates recursive
# copy block so v7.1 template files won't be deployed.
awk '
  /# Templates.*v7\.1\.1/ { skip=1 }
  skip && /^  # References/ { skip=0 }
  !skip { print }
' "$DEPLOY_COMMON" > "$BROKEN_DC"

# Verify the edit removed something
BROKEN_SIZE=$(wc -l < "$BROKEN_DC")
ORIG_SIZE=$(wc -l < "$DEPLOY_COMMON")
[ "$BROKEN_SIZE" -lt "$ORIG_SIZE" ]
note "broken deploy-common.sh has fewer lines than original" $?

# Run sync with the broken file
(
  set +e
  cd "$PROJECT"
  export HOME="$FAKE_HOME"
  # shellcheck disable=SC1090
  source "$BROKEN_DC"
  sync_local_project "$REPO_ROOT" > /dev/null 2>&1
)

# Re-run the parity check manually and confirm at least one v7.1
# template is missing
BROKEN_MISSING=0
for f in \
  "templates/role-budgets.json" \
  "templates/plan-templates/quick.md" \
  "templates/guidelines/live-processes.json"; do
  if [ ! -f "$PROJECT/.vela/$f" ]; then
    BROKEN_MISSING=$((BROKEN_MISSING + 1))
  fi
done

[ "$BROKEN_MISSING" -ge 1 ]
note "broken deploy-common misses at least 1 v7.1 template ($BROKEN_MISSING/3)" $?

# ─── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
