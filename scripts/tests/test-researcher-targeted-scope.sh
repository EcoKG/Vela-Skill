#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-researcher-targeted-scope.sh — v7.1 M11
#
# Covers: vela-gate.js (v7.3-M4c merged, formerly gate-keeper) must deny Read tool calls during
# the `research` step when the file is outside primary[] ∪
# blast_radius[] ∪ tests[] (plus a small metadata allowlist),
# as long as targets.json has confidence high or medium.
#
# Based on the hicoco session where researcher read
# server/index.js and client/src/App.jsx for a 2-file
# scraper task, averaging 12 tool_use per research step.
# Target after v7.1 M11: ≤ 8.
#
# Asserts:
#   1. Read to targets.primary file at research step → allow
#   2. Read to targets.blast_radius file → allow
#   3. Read to targets.tests file → allow
#   4. Read to README.md (metadata allowlist) → allow
#   5. Read to arbitrary file NOT in targets → deny
#   6. Same arbitrary Read at a non-research step → allow
#      (M11 is scoped to research only)
#   7. Read with low confidence → allow even out-of-scope
#      (fallback to exploratory)
#   8. Read with no targets.json → allow (legacy path)
#   9. vela-researcher.md documents the scope rule
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATE_KEEPER="$SCRIPT_DIR/../hooks/vela-gate.js"  # v7.3-M4c: keeper + guard merged
RESEARCHER_MD="$REPO_ROOT/scripts/agents/vela-researcher.md"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""

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

note_exit() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

setup_pipeline() {
  cleanup
  local CONFIDENCE="${1:-high}"
  local STEP="${2:-research}"
  local WRITE_TARGETS="${3:-yes}"
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state" "$PROJECT/.vela/templates"
  mkdir -p "$PROJECT/scraper" "$PROJECT/server" "$PROJECT/tests/scraper"
  local ARTIFACT_DIR="$PROJECT/.vela/artifacts/20260411T120000-t"
  mkdir -p "$ARTIFACT_DIR"

  # Sample project files
  echo "// scraper primary" > "$PROJECT/scraper/url-parser.js"
  echo "// scraper secondary" > "$PROJECT/scraper/downloader.js"
  echo "// scraper test" > "$PROJECT/tests/scraper/url-parser.test.js"
  echo "// unrelated server" > "$PROJECT/server/index.js"
  echo "# readme" > "$PROJECT/README.md"

  cat > "$ARTIFACT_DIR/pipeline-state.json" <<EOF
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "$STEP"
}
EOF

  cat > "$PROJECT/.vela/templates/pipeline.json" <<EOF
{
  "pipelines": {
    "standard": {
      "steps": [
        { "id": "research", "mode": "rw-artifact" },
        { "id": "plan", "mode": "write" },
        { "id": "execute", "mode": "readwrite" }
      ]
    }
  }
}
EOF

  if [ "$WRITE_TARGETS" = "yes" ]; then
    cat > "$ARTIFACT_DIR/targets.json" <<EOF
{
  "confidence": "$CONFIDENCE",
  "primary": [
    { "file": "scraper/url-parser.js", "symbol": "parse", "lines": [1, 10] }
  ],
  "blast_radius": [
    { "file": "scraper/downloader.js", "symbol": "download", "lines": [1, 5] }
  ],
  "tests": [
    "tests/scraper/url-parser.test.js"
  ]
}
EOF
  fi
}

run_gate() {
  local file="$1"
  local exit_code=0
  node -e "
    const json = {
      tool_name: 'Read',
      tool_input: { file_path: process.argv[1] },
      session_id: 't',
      cwd: process.argv[2],
    };
    process.stdout.write(JSON.stringify(json));
  " "$file" "$PROJECT" | node "$GATE_KEEPER" 2>/dev/null || exit_code=$?
  echo "$exit_code"
}

# ── Phase 1: high confidence — scope enforced ────────────────
echo "📋 Phase 1: confidence=high → scope enforced at research step"
setup_pipeline high research yes

note_exit "primary file allowed"        0 "$(run_gate "$PROJECT/scraper/url-parser.js")"
note_exit "blast_radius file allowed"   0 "$(run_gate "$PROJECT/scraper/downloader.js")"
note_exit "tests file allowed"          0 "$(run_gate "$PROJECT/tests/scraper/url-parser.test.js")"
note_exit "README.md allowed (metadata)" 0 "$(run_gate "$PROJECT/README.md")"
note_exit "unrelated server file DENIED" 2 "$(run_gate "$PROJECT/server/index.js")"

# ── Phase 2: medium confidence — scope enforced ──────────────
echo "📋 Phase 2: confidence=medium → scope enforced"
setup_pipeline medium research yes

note_exit "medium: unrelated server file DENIED" 2 "$(run_gate "$PROJECT/server/index.js")"
note_exit "medium: primary file allowed"          0 "$(run_gate "$PROJECT/scraper/url-parser.js")"

# ── Phase 3: low confidence — fallback to exploratory ────────
echo "📋 Phase 3: confidence=low → scope NOT enforced"
setup_pipeline low research yes

note_exit "low: unrelated file allowed (exploratory fallback)" 0 "$(run_gate "$PROJECT/server/index.js")"

# ── Phase 4: other pipeline steps — M11 does not leak ────────
echo "📋 Phase 4: non-research steps — scope NOT enforced"
setup_pipeline high plan yes

note_exit "plan step: unrelated file allowed (scope is research-only)" 0 \
  "$(run_gate "$PROJECT/server/index.js")"

setup_pipeline high execute yes
note_exit "execute step: unrelated file allowed" 0 \
  "$(run_gate "$PROJECT/server/index.js")"

# ── Phase 5: no targets.json at all — legacy path ────────────
echo "📋 Phase 5: no targets.json → scope NOT enforced (back-compat)"
setup_pipeline high research no  # no targets.json

note_exit "no targets.json: unrelated file allowed" 0 \
  "$(run_gate "$PROJECT/server/index.js")"

# ── Phase 6: .vela/ artifact read is always allowed ──────────
echo "📋 Phase 6: .vela/ artifacts exempt"
setup_pipeline high research yes
ARTIFACT_FILE="$(find "$PROJECT/.vela/artifacts" -name pipeline-state.json | head -1)"
note_exit ".vela/artifacts/pipeline-state.json allowed" 0 "$(run_gate "$ARTIFACT_FILE")"

# ── Phase 7: researcher.md documents the rule ────────────────
echo "📋 Phase 7: researcher.md documents M11 scope rule"

grep -q 'M11' "$RESEARCHER_MD"
note "researcher.md mentions M11" $?

grep -q 'targets.primary' "$RESEARCHER_MD"
note "researcher.md references targets.primary" $?

grep -q 'package.json' "$RESEARCHER_MD"
note "researcher.md documents metadata allowlist (package.json)" $?

grep -q 'hicoco' "$RESEARCHER_MD"
note "researcher.md cites hicoco motivation" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
