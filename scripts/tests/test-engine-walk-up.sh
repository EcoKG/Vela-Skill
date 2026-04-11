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

# ── Phase 1: state from project root (baseline) ──────────────
echo "📋 Phase 1: baseline — state from project root"
setup_sandbox

OUTPUT=$(cd "$PROJECT" && node "$ENGINE" state 2>&1 || true)
if echo "$OUTPUT" | grep -q '"ok"'; then
  assert_eq "state from project root returns JSON with ok field" "ok" "ok"
else
  assert_eq "state from project root returns JSON with ok field" "ok" "no-json"
  echo "     output: $OUTPUT"
fi

# ── Phase 2: state from deep subdirectory ────────────────────
echo ""
echo "📋 Phase 2: walk-up — state from server/storage/books/9999999"

DEEP_DIR="$PROJECT/server/storage/books/9999999"
OUTPUT_DEEP=$(cd "$DEEP_DIR" && node "$ENGINE" state 2>&1 || true)

if echo "$OUTPUT_DEEP" | grep -q '"ok"'; then
  assert_eq "state from 4-levels-deep subdir returns JSON with ok field" "ok" "ok"
else
  assert_eq "state from 4-levels-deep subdir returns JSON with ok field" "ok" "no-json"
  echo "     output: $OUTPUT_DEEP"
fi

# Outputs must match — walk-up should make deep/root invocations
# semantically identical.
if [ "$OUTPUT" = "$OUTPUT_DEEP" ]; then
  assert_eq "deep subdir state output == project root state output" "ok" "ok"
else
  assert_eq "deep subdir state output == project root state output" "ok" "mismatch"
  echo "     root: $OUTPUT"
  echo "     deep: $OUTPUT_DEEP"
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
# .vela/, it should NOT crash at module load; findProjectRoot falls
# back to process.cwd() and state simply reports active:false.
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

# ── Summary ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ engine walk-up FAILED"
  exit 1
fi
echo "✅ engine walk-up project-root PASS"
