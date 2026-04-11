#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-engine-walk-up.sh — vela-engine.js walk-up project root (v7.0.6)
#
# Covers: findProjectRoot() in vela-engine.js must find an ancestor
# `.vela/` directory when the engine is launched from a subdirectory.
#
# Bug (fixed in v7.0.6):
#   Pre-v7.0.6 the engine hard-coded `CWD = process.cwd()`. When a
#   Claude Code session started in `/proj/src/foo/bar/` and the PM
#   executed `node .vela/cli/vela-engine.js state`, node failed at
#   module load (`Cannot find module '.../bar/.vela/cli/vela-engine.js'`)
#   before any engine code ran.
#
#   The v7.0.6 fix has two parts:
#     (a) scripts/agents/vela.md tells the PM to cd to the project root
#         first via a walk-up snippet, which solves the module-load
#         failure for the PM's relative path invocations.
#     (b) scripts/cli/vela-engine.js itself does a walk-up inside
#         findProjectRoot() so that ABSOLUTE-path invocations from a
#         subdirectory also succeed. This test covers (b).
#
# Strategy: create a project with .vela/, spawn deep subdirs under
# it, then exec the engine via its absolute path with CWD set to each
# subdir. Every command must behave identically to running from the
# project root.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""

cleanup() {
  [ -n "$TMPDIR_ROOT" ] && rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    echo "     expected: $expected"
    echo "     actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/artifacts"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/templates"

  # Deep subdirectory tree — mirrors the user report of
  # /home/starlyn/hicoco/server/storage/books/9999999
  mkdir -p "$PROJECT/server/storage/books/9999999"
  mkdir -p "$PROJECT/src/a/b/c/d/e"

  # Minimal pipeline template so `init` and `state` have something to
  # reference. We don't actually need a real pipeline to prove walk-up
  # works, but `state` exercises more code paths than a no-op.
  cat > "$PROJECT/.vela/templates/pipeline.json" <<'PIPEEOF'
{
  "version": "1.0",
  "scales": { "small": "trivial" },
  "pipelines": {
    "trivial": {
      "steps": ["init", "finalize"],
      "finalize": { "next": null }
    }
  }
}
PIPEEOF
}

# Helper: run the engine splitting stdout/stderr into two files so
# we can assert on each channel independently. v7.0.7 added a stderr
# warning when cwd drifts, so plain `2>&1` captures would conflate
# "quiet project-root baseline" with "noisy recovered subdir call".
run_engine() {
  local cwd="$1"
  shift
  ( cd "$cwd" && node "$ENGINE" "$@" >/tmp/walkup-stdout 2>/tmp/walkup-stderr; echo "exit=$?" )
}

# ── Phase 1: state from project root (baseline) ──────────────
# At the project root, cwd == projectRoot, so there should be NO
# stderr warning and the stdout should be a clean JSON response.
echo "📋 Phase 1: baseline — state from project root"
setup_sandbox

run_engine "$PROJECT" state >/dev/null
OUTPUT=$(cat /tmp/walkup-stdout)
STDERR_ROOT=$(cat /tmp/walkup-stderr)

if echo "$OUTPUT" | grep -q '"ok"'; then
  assert_eq "state from project root returns JSON with ok field" "ok" "ok"
else
  assert_eq "state from project root returns JSON with ok field" "ok" "no-json"
  echo "     output: $OUTPUT"
fi

# Baseline: no cwd-drift warning when called from the actual root.
if [ -z "$STDERR_ROOT" ]; then
  assert_eq "project-root call produces no stderr warning" "ok" "ok"
else
  assert_eq "project-root call produces no stderr warning" "ok" "unexpected-stderr"
  echo "     stderr: $STDERR_ROOT"
fi

# ── Phase 2: state from deep subdirectory ────────────────────
# In a deep subdir the engine must (a) return the same JSON shape
# as the root call on stdout, and (b) emit a clear stderr warning
# naming the drift — v7.0.7 no longer silently masks the recovery.
echo ""
echo "📋 Phase 2: walk-up — state from server/storage/books/9999999"

DEEP_DIR="$PROJECT/server/storage/books/9999999"
run_engine "$DEEP_DIR" state >/dev/null
OUTPUT_DEEP=$(cat /tmp/walkup-stdout)
STDERR_DEEP=$(cat /tmp/walkup-stderr)

if echo "$OUTPUT_DEEP" | grep -q '"ok"'; then
  assert_eq "state from 4-levels-deep subdir returns JSON with ok field" "ok" "ok"
else
  assert_eq "state from 4-levels-deep subdir returns JSON with ok field" "ok" "no-json"
  echo "     output: $OUTPUT_DEEP"
fi

# stdout must match the project-root baseline — the recovered call
# should be semantically indistinguishable on the stdout channel.
if [ "$OUTPUT" = "$OUTPUT_DEEP" ]; then
  assert_eq "deep subdir stdout == project root stdout" "ok" "ok"
else
  assert_eq "deep subdir stdout == project root stdout" "ok" "mismatch"
  echo "     root: $OUTPUT"
  echo "     deep: $OUTPUT_DEEP"
fi

# stderr MUST contain the chdir-drift warning so the root cause
# (usually a stray `cd` inside a Bash tool call) is visible.
if echo "$STDERR_DEEP" | grep -q "chdir.*→"; then
  assert_eq "deep subdir call emits cwd-drift stderr warning" "ok" "ok"
else
  assert_eq "deep subdir call emits cwd-drift stderr warning" "ok" "missing-warning"
  echo "     stderr: $STDERR_DEEP"
fi

# ── Phase 3: state from extreme-depth subdirectory ───────────
echo ""
echo "📋 Phase 3: walk-up — state from src/a/b/c/d/e (6 levels deep)"

EXTREME_DIR="$PROJECT/src/a/b/c/d/e"
OUTPUT_EXT=$(cd "$EXTREME_DIR" && node "$ENGINE" state 2>&1 || true)

if echo "$OUTPUT_EXT" | grep -q '"ok"'; then
  assert_eq "state from 6-levels-deep subdir returns JSON with ok field" "ok" "ok"
else
  assert_eq "state from 6-levels-deep subdir returns JSON with ok field" "ok" "no-json"
  echo "     output: $OUTPUT_EXT"
fi

# ── Phase 4: init from deep subdir ───────────────────────────
# init writes `pipeline-state.json` inside a freshly-created
# artifact directory under `.vela/artifacts/<timestamp>-<slug>/`
# (see scripts/cli/vela-engine.js cmdInit). If walk-up is broken,
# either (a) the artifact goes under `<subdir>/.vela/artifacts/`
# (which doesn't exist) and init fails, or (b) init somehow creates
# a stray `<subdir>/.vela/` tree. Verified by reading the file back
# from under the project root afterwards.
echo ""
echo "📋 Phase 4: init from deep subdir writes to project-root .vela/"

INIT_OUT=$(cd "$DEEP_DIR" && node "$ENGINE" init "test request" --scale small 2>&1 || true)
# Pull artifact_dir out of the JSON response so we can check it
# directly rather than guessing at the path layout.
ARTIFACT_DIR=$(echo "$INIT_OUT" | sed -n 's/.*"artifact_dir":[[:space:]]*"\([^"]*\)".*/\1/p')

if [ -n "$ARTIFACT_DIR" ] && [ -f "$ARTIFACT_DIR/pipeline-state.json" ]; then
  assert_eq "pipeline-state.json created under artifact_dir" "ok" "ok"
else
  assert_eq "pipeline-state.json created under artifact_dir" "ok" "missing"
  echo "     artifact_dir: $ARTIFACT_DIR"
  echo "     init output : $INIT_OUT"
fi

# The artifact directory must live INSIDE the project root,
# specifically under $PROJECT/.vela/artifacts/. If walk-up is
# broken it would resolve relative to the subdirectory's cwd and
# point somewhere else entirely.
case "$ARTIFACT_DIR" in
  "$PROJECT"/.vela/artifacts/*)
    assert_eq "artifact_dir is under project-root .vela/artifacts/" "ok" "ok"
    ;;
  *)
    assert_eq "artifact_dir is under project-root .vela/artifacts/" "ok" "wrong-parent"
    echo "     artifact_dir   : $ARTIFACT_DIR"
    echo "     expected prefix: $PROJECT/.vela/artifacts/"
    ;;
esac

# Make sure NO .vela/ was created inside the subdir.
if [ ! -d "$DEEP_DIR/.vela" ]; then
  assert_eq "no stray .vela/ created inside subdir" "ok" "ok"
else
  assert_eq "no stray .vela/ created inside subdir" "ok" "stray"
fi

# ── Phase 5: non-project cwd gracefully falls back ───────────
# When the engine is launched from a directory with no ancestor
# .vela/, it should NOT crash at module load; resolveProjectRoot
# falls back to process.cwd() and state simply reports active:false.
echo ""
echo "📋 Phase 5: non-project cwd returns active:false (no crash)"

NON_PROJECT_ROOT="$(mktemp -d)"
OUTPUT_NP=$(cd "$NON_PROJECT_ROOT" && node "$ENGINE" state 2>&1 || true)
rm -rf "$NON_PROJECT_ROOT"

if echo "$OUTPUT_NP" | grep -q '"active":false'; then
  assert_eq "non-project cwd yields active:false" "ok" "ok"
else
  # Also acceptable: any clean JSON with ok field (engine handled it).
  if echo "$OUTPUT_NP" | grep -q '"ok"'; then
    assert_eq "non-project cwd returns clean JSON" "ok" "ok"
  else
    assert_eq "non-project cwd yields active:false" "ok" "crash-or-garbage"
    echo "     output: $OUTPUT_NP"
  fi
fi

# ── Phase 6: workspace.json pin (v7.0.7) ─────────────────────
# With a pinned workspace root, the engine reads .vela/state/
# workspace.json and chdirs to whatever projectRoot is recorded
# there, rather than walking up blindly. This covers three cases:
#
#   6a. Valid pin: the engine uses the pinned root even when the
#       walk-up would have landed on the same place — proves the
#       pin is actually being read.
#   6b. Stale pin: the recorded projectRoot no longer has .vela/
#       (simulating a post-`mv` state). The engine should NOT chdir
#       to the dead path, should emit a clear "stale pin" warning
#       on stderr, and should fall back to the walk-up result.
#   6c. Malformed pin: garbage JSON in workspace.json must not
#       crash the engine — it should fall back to walk-up silently.
echo ""
echo "📋 Phase 6: workspace.json pin — valid / stale / malformed"

# 6a: valid pin
setup_sandbox
mkdir -p "$PROJECT/.vela/state"
cat > "$PROJECT/.vela/state/workspace.json" <<JSON
{"projectRoot":"$PROJECT","recordedAt":"2026-04-11T00:00:00Z","recordedBy":"test","velaVersion":"test"}
JSON

run_engine "$PROJECT/server/storage/books/9999999" state >/dev/null
STDERR_VALID=$(cat /tmp/walkup-stderr)
STDOUT_VALID=$(cat /tmp/walkup-stdout)

if echo "$STDOUT_VALID" | grep -q '"ok"'; then
  assert_eq "valid pin: engine returns JSON ok" "ok" "ok"
else
  assert_eq "valid pin: engine returns JSON ok" "ok" "no-json"
  echo "     stdout: $STDOUT_VALID"
fi
if echo "$STDERR_VALID" | grep -q "chdir.*→.*$PROJECT"; then
  assert_eq "valid pin: stderr warns chdir to pinned projectRoot" "ok" "ok"
else
  assert_eq "valid pin: stderr warns chdir to pinned projectRoot" "ok" "missing-or-wrong-target"
  echo "     stderr: $STDERR_VALID"
fi
if echo "$STDERR_VALID" | grep -q "stale"; then
  assert_eq "valid pin: no 'stale' warning" "ok" "unexpected-stale"
else
  assert_eq "valid pin: no 'stale' warning" "ok" "ok"
fi

# 6b: stale pin — point at a deleted directory
setup_sandbox
DEAD_PATH="$TMPDIR_ROOT/nonexistent-project-was-moved"
mkdir -p "$PROJECT/.vela/state"
cat > "$PROJECT/.vela/state/workspace.json" <<JSON
{"projectRoot":"$DEAD_PATH","recordedAt":"2026-04-11T00:00:00Z","recordedBy":"test"}
JSON

run_engine "$PROJECT/server/storage/books/9999999" state >/dev/null
STDERR_STALE=$(cat /tmp/walkup-stderr)

if echo "$STDERR_STALE" | grep -q "workspace.json points at $DEAD_PATH"; then
  assert_eq "stale pin: stderr names the dead projectRoot" "ok" "ok"
else
  assert_eq "stale pin: stderr names the dead projectRoot" "ok" "missing"
  echo "     stderr: $STDERR_STALE"
fi
if echo "$STDERR_STALE" | grep -q "falling back to walk-up"; then
  assert_eq "stale pin: stderr says falling back to walk-up" "ok" "ok"
else
  assert_eq "stale pin: stderr says falling back to walk-up" "ok" "missing"
fi
# The engine should NOT chdir to the dead path — verified by the
# init→artifact_dir check (artifact must land in $PROJECT, not $DEAD_PATH).
INIT_OUT_STALE=$(cd "$PROJECT/server/storage/books/9999999" && node "$ENGINE" init "stale-test" --scale small 2>/dev/null || true)
AD_STALE=$(echo "$INIT_OUT_STALE" | sed -n 's/.*"artifact_dir":[[:space:]]*"\([^"]*\)".*/\1/p')
case "$AD_STALE" in
  "$PROJECT"/.vela/artifacts/*)
    assert_eq "stale pin: artifact still lands in real project root" "ok" "ok"
    ;;
  *)
    assert_eq "stale pin: artifact still lands in real project root" "ok" "wrong"
    echo "     artifact_dir: $AD_STALE"
    ;;
esac

# 6c: malformed pin — garbage JSON
setup_sandbox
mkdir -p "$PROJECT/.vela/state"
echo "this is not valid json" > "$PROJECT/.vela/state/workspace.json"

run_engine "$PROJECT/server/storage/books/9999999" state >/dev/null
STDOUT_BAD=$(cat /tmp/walkup-stdout)
if echo "$STDOUT_BAD" | grep -q '"ok"'; then
  assert_eq "malformed pin: engine still works via walk-up fallback" "ok" "ok"
else
  assert_eq "malformed pin: engine still works via walk-up fallback" "ok" "crashed"
  echo "     stdout: $STDOUT_BAD"
fi

# ── Phase 7: install.js writes workspace.json (v7.0.7) ───────
# A fresh `node install.js validate` run against a bare project
# dir should leave .vela/state/workspace.json pinned to that dir.
echo ""
echo "📋 Phase 7: install.js validate pins workspace.json"

setup_sandbox
rm -f "$PROJECT/.vela/state/workspace.json"

INSTALL_JS="$SCRIPT_DIR/../install.js"
(cd "$PROJECT" && node "$INSTALL_JS" validate >/tmp/install-validate.log 2>&1 || true)

PIN_FILE="$PROJECT/.vela/state/workspace.json"
if [ -f "$PIN_FILE" ]; then
  assert_eq "install.js validate created workspace.json" "ok" "ok"
else
  assert_eq "install.js validate created workspace.json" "ok" "missing"
fi

# The recorded projectRoot must match the sandbox project path.
if [ -f "$PIN_FILE" ]; then
  RECORDED=$(python3 -c "import json; print(json.load(open('$PIN_FILE'))['projectRoot'])" 2>/dev/null)
  if [ "$RECORDED" = "$PROJECT" ]; then
    assert_eq "workspace.json projectRoot matches actual project" "ok" "ok"
  else
    assert_eq "workspace.json projectRoot matches actual project" "ok" "mismatch"
    echo "     recorded: $RECORDED"
    echo "     actual  : $PROJECT"
  fi
fi

# ── Summary ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ engine walk-up FAILED"
  exit 1
fi
echo "✅ engine walk-up project-root PASS"
