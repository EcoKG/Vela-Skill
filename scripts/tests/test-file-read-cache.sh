#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-file-read-cache.sh — v7.1 M10 read cache hook
#
# Covers: vela-file-read-cache.js must append one JSON line per
# Read tool call to <artifactDir>/read-cache.jsonl, and must
# emit a stderr warning when the same (agent,file,sha) combo
# appears 4+ times. It must also be a no-op outside Vela
# (no active pipeline) and must not block a Read call.
#
# Asserts:
#   1. Hook exits 0 always (even on malformed input)
#   2. Hook writes one JSONL line per Read at the active pipeline's
#      artifact dir when one exists
#   3. After 4 identical Reads, hook emits the dup warning
#   4. Hook is a no-op when no active pipeline is present
#   5. Hook handles non-Read tools as pass-through no-op
#   6. vela-stop.js rollupToolUsage aggregates read-cache.jsonl
#   7. install.js deploys the hook in FILE_MANIFEST AND registers
#      it in registerGlobalHooks
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK="$SCRIPT_DIR/../hooks/vela-file-read-cache.js"
STOP_JS="$SCRIPT_DIR/../hooks/vela-stop.js"
INSTALL_JS="$REPO_ROOT/scripts/install.js"

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

setup_sandbox() {
  cleanup
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state"
  ARTIFACT_DIR="$PROJECT/.vela/artifacts/20260411T000000-test"
  mkdir -p "$ARTIFACT_DIR"
  cat > "$ARTIFACT_DIR/pipeline-state.json" <<'EOF'
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "research"
}
EOF
  # A real target file for sha fingerprinting
  echo 'console.log("hello");' > "$PROJECT/index.js"
}

fire_read() {
  local file="$1"
  local agent="${2:-session-abc}"
  local code=0
  node -e "
    const j = {
      tool_name: 'Read',
      tool_input: { file_path: process.argv[1] },
      session_id: process.argv[2],
      cwd: process.argv[3]
    };
    process.stdout.write(JSON.stringify(j));
  " "$file" "$agent" "$PROJECT" | node "$HOOK" 2>/tmp/m10-stderr || code=$?
  echo "$code"
}

fire_non_read() {
  local code=0
  # shellcheck disable=SC2016
  node -e "
    const j = {
      tool_name: 'Edit',
      tool_input: { file_path: '/some/path' },
      session_id: 'sid',
      cwd: process.argv[1]
    };
    process.stdout.write(JSON.stringify(j));
  " "$PROJECT" | node "$HOOK" 2>/tmp/m10-stderr || code=$?
  echo "$code"
}

# ── Phase 1: hook exit codes ─────────────────────────────────
echo "📋 Phase 1: hook always exits 0"

setup_sandbox
EXIT=$(fire_read "$PROJECT/index.js")
[ "$EXIT" = "0" ]
note "normal Read → exit 0" $?

EXIT=$(fire_non_read)
[ "$EXIT" = "0" ]
note "non-Read tool → exit 0 (pass-through)" $?

# Malformed input
EXIT=0
echo "{not json}" | node "$HOOK" 2>/dev/null || EXIT=$?
[ "$EXIT" = "0" ]
note "malformed stdin → exit 0" $?

EXIT=0
echo "" | node "$HOOK" 2>/dev/null || EXIT=$?
[ "$EXIT" = "0" ]
note "empty stdin → exit 0" $?

# ── Phase 2: JSONL append ────────────────────────────────────
echo "📋 Phase 2: hook appends to read-cache.jsonl"

setup_sandbox
fire_read "$PROJECT/index.js" "session-a" >/dev/null

[ -f "$ARTIFACT_DIR/read-cache.jsonl" ]
note "read-cache.jsonl created" $?

LINE_COUNT=$(wc -l < "$ARTIFACT_DIR/read-cache.jsonl")
[ "$LINE_COUNT" = "1" ]
note "one line after single Read (got $LINE_COUNT)" $?

grep -q '"file":.*index.js' "$ARTIFACT_DIR/read-cache.jsonl"
note "line contains the file path" $?

grep -q '"agent":"session-a"' "$ARTIFACT_DIR/read-cache.jsonl"
note "line contains the agent id" $?

grep -q '"sha":"[0-9a-f]' "$ARTIFACT_DIR/read-cache.jsonl"
note "line contains a sha fingerprint" $?

# ── Phase 3: duplicate warning at 4+ reads ───────────────────
echo "📋 Phase 3: 4th+ identical Read emits dup warning"

setup_sandbox
fire_read "$PROJECT/index.js" "session-a" >/dev/null  # 1st
fire_read "$PROJECT/index.js" "session-a" >/dev/null  # 2nd
fire_read "$PROJECT/index.js" "session-a" >/dev/null  # 3rd
fire_read "$PROJECT/index.js" "session-a" >/dev/null  # 4th — should warn

grep -q 'repeated read' /tmp/m10-stderr
note "4th identical Read triggers stderr warning" $?

# But a different agent reading the same file should not trigger
# until IT also hits 4.
setup_sandbox
fire_read "$PROJECT/index.js" "session-a" >/dev/null
fire_read "$PROJECT/index.js" "session-b" >/dev/null
fire_read "$PROJECT/index.js" "session-c" >/dev/null
fire_read "$PROJECT/index.js" "session-d" >/dev/null

if grep -q 'repeated read' /tmp/m10-stderr; then
  note "4 reads by 4 different agents = no dup warning" 1
else
  note "4 reads by 4 different agents = no dup warning" 0
fi

# ── Phase 4: no-op when no active pipeline ───────────────────
echo "📋 Phase 4: no-op when no active pipeline"

TMPDIR_ROOT=$(mktemp -d)
PROJECT="$TMPDIR_ROOT/project"
mkdir -p "$PROJECT/.vela/artifacts"  # empty artifacts dir

EXIT=0
node -e "
  const j = {
    tool_name: 'Read',
    tool_input: { file_path: '/etc/hosts' },
    session_id: 'x',
    cwd: process.argv[1]
  };
  process.stdout.write(JSON.stringify(j));
" "$PROJECT" | node "$HOOK" 2>/tmp/m10-stderr || EXIT=$?

[ "$EXIT" = "0" ]
note "no-active-pipeline hook still exits 0" $?

if find "$PROJECT" -name read-cache.jsonl 2>/dev/null | grep -q .; then
  note "no read-cache.jsonl written when no active pipeline" 1
else
  note "no read-cache.jsonl written when no active pipeline" 0
fi

# ── Phase 5: install.js wiring ───────────────────────────────
echo "📋 Phase 5: install.js deploys + registers hook"

grep -q 'vela-file-read-cache.js' "$INSTALL_JS"
note "install.js mentions vela-file-read-cache.js" $?

grep -q 'addGlobalHook.*vela-file-read-cache' "$INSTALL_JS"
note "install.js registers hook via addGlobalHook" $?

# ── Phase 6: vela-stop.js consumes read-cache.jsonl ──────────
echo "📋 Phase 6: vela-stop.js rollup reads read-cache.jsonl"

grep -q 'read-cache.jsonl' "$STOP_JS"
note "vela-stop.js reads read-cache.jsonl" $?

grep -q 'duplicateReads' "$STOP_JS"
note "vela-stop.js computes duplicateReads" $?

# End-to-end: populate a read-cache.jsonl, fire stop, check tool-usage.json
setup_sandbox
echo '{"ts":"2026-04-11T00:00:00Z","agent":"a","file":"/x","sha":"1"}' > "$ARTIFACT_DIR/read-cache.jsonl"
echo '{"ts":"2026-04-11T00:00:01Z","agent":"a","file":"/x","sha":"1"}' >> "$ARTIFACT_DIR/read-cache.jsonl"
echo '{"ts":"2026-04-11T00:00:02Z","agent":"a","file":"/x","sha":"1"}' >> "$ARTIFACT_DIR/read-cache.jsonl"

mkdir -p "$PROJECT/.vela/templates"
cat > "$PROJECT/.vela/templates/pipeline.json" <<'EOF'
{ "pipelines": { "standard": { "steps": [{ "id": "research", "mode": "read" }] } } }
EOF

echo "{\"cwd\":\"$PROJECT\"}" | node "$STOP_JS" >/dev/null 2>&1 || true

grep -q '"duplicateReads"' "$ARTIFACT_DIR/tool-usage.json" 2>/dev/null
note "tool-usage.json contains duplicateReads field" $?

grep -q '"count": 3' "$ARTIFACT_DIR/tool-usage.json" 2>/dev/null
note "tool-usage.json records the count=3 duplicate" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
