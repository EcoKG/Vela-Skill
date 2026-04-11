#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-context-pack.sh — v7.1 M7 context pack
#
# Covers: the researcher → executor/verifier context-pack.json
# contract. Asserts the prompt files describe the schema and the
# engine's `state` command surfaces contextPackPath when the
# file exists.
#
# Asserts:
#   1. vela-researcher.md documents context-pack.json as a
#      required deliverable with version/schema fields
#   2. vela-executor.md instructs "read context-pack.json first"
#      and bans project-tree re-scanning
#   3. vela-verifier.md reads conventions/testDirs/entryPoints
#      from context-pack.json
#   4. cmdState() returns contextPackPath: null when absent
#   5. cmdState() returns contextPackPath: <path> when present
#   6. Schema roundtrip: a hand-written context-pack.json parses
#      and contains all v7.1 required fields
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"
RESEARCHER_MD="$REPO_ROOT/scripts/agents/vela-researcher.md"
EXECUTOR_MD="$REPO_ROOT/scripts/agents/vela-executor.md"
VERIFIER_MD="$REPO_ROOT/scripts/agents/vela-verifier.md"
PIPELINE_JSON="$REPO_ROOT/templates/pipeline.json"

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

# ── Phase 1: researcher.md ───────────────────────────────────
echo "📋 Phase 1: vela-researcher.md context-pack.json contract"

grep -q 'context-pack.json' "$RESEARCHER_MD"
note "researcher.md mentions context-pack.json" $?

grep -q 'v7.1 M7' "$RESEARCHER_MD"
note "researcher.md cites v7.1 M7" $?

grep -q 'relatedFilesForRequest' "$RESEARCHER_MD"
note "researcher.md documents relatedFilesForRequest field" $?

grep -q 'sourceTree' "$RESEARCHER_MD"
note "researcher.md documents sourceTree field" $?

grep -q 'entryPoints' "$RESEARCHER_MD"
note "researcher.md documents entryPoints field" $?

grep -q 'conventions' "$RESEARCHER_MD"
note "researcher.md documents conventions field" $?

grep -q '"version": 1' "$RESEARCHER_MD"
note "researcher.md shows version:1 in schema" $?

# ── Phase 2: executor.md ────────────────────────────────────
echo "📋 Phase 2: vela-executor.md reads context-pack first"

grep -q 'context-pack.json' "$EXECUTOR_MD"
note "executor.md mentions context-pack.json" $?

grep -q 'Context Pack 우선 로드' "$EXECUTOR_MD"
note "executor.md has Context Pack section" $?

grep -q '전수 탐색' "$EXECUTOR_MD"
note "executor.md bans project-tree scanning" $?

grep -q 'relatedFilesForRequest' "$EXECUTOR_MD"
note "executor.md references relatedFilesForRequest" $?

# ── Phase 3: verifier.md ────────────────────────────────────
echo "📋 Phase 3: vela-verifier.md reads context-pack first"

grep -q 'context-pack.json' "$VERIFIER_MD"
note "verifier.md mentions context-pack.json" $?

grep -q 'conventions.testRunner' "$VERIFIER_MD"
note "verifier.md reads conventions.testRunner" $?

grep -q 'testDirs' "$VERIFIER_MD"
note "verifier.md reads testDirs" $?

# ── Phase 4: cmdState exposes contextPackPath ───────────────
echo "📋 Phase 4: cmdState reports contextPackPath correctly"

TMPDIR_ROOT="$(mktemp -d)"
PROJECT="$TMPDIR_ROOT/project"
mkdir -p "$PROJECT/.vela/templates" "$PROJECT/.vela/artifacts" "$PROJECT/.vela/state"
cp "$PIPELINE_JSON" "$PROJECT/.vela/templates/pipeline.json"

(
  cd "$PROJECT"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false \
    git init -q -b main
  git config user.email t@v.local
  git config user.name t
  echo "# x" > README.md
  git add README.md
  git -c commit.gpgsign=false commit -q -m i
)

(
  cd "$PROJECT"
  node "$ENGINE" init "context pack test" --scale small >/tmp/m7-init 2>/dev/null
)

ARTIFACT_DIR="$(find "$PROJECT/.vela/artifacts" -type d -name '2026*' | head -1)"
[ -n "$ARTIFACT_DIR" ]
note "sandbox artifact dir created" $?

# Before we drop the context-pack, state should report null
(
  cd "$PROJECT"
  node "$ENGINE" state 2>/dev/null >/tmp/m7-state
)
grep -q '"contextPackPath": null' /tmp/m7-state
note "state returns contextPackPath:null when absent" $?

# Drop a minimal context-pack.json
cat > "$ARTIFACT_DIR/context-pack.json" <<'CTX'
{
  "version": 1,
  "generatedBy": "vela-researcher",
  "generatedAt": "2026-04-11T12:00:00Z",
  "projectRoot": "/tmp/project",
  "sourceTree": [
    { "path": "scraper/url-parser.js", "size": 2341, "sha": "abc", "role": "domain", "summary": "parse" }
  ],
  "entryPoints": ["cli.js"],
  "testDirs": ["tests"],
  "conventions": { "moduleSystem": "ESM", "testRunner": "vitest" },
  "relatedFilesForRequest": ["scraper/url-parser.js"]
}
CTX

(
  cd "$PROJECT"
  node "$ENGINE" state 2>/dev/null >/tmp/m7-state
)

# state should now have contextPackPath: <something>/context-pack.json
grep -q '"contextPackPath".*context-pack.json' /tmp/m7-state
note "state returns contextPackPath pointing at file when present" $?

# Schema validation
node -e "
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const required = ['version','generatedBy','generatedAt','projectRoot','sourceTree','entryPoints','testDirs','conventions','relatedFilesForRequest'];
  for (const k of required) {
    if (!(k in j)) { console.error('missing:'+k); process.exit(1); }
  }
  if (!Array.isArray(j.sourceTree)) process.exit(1);
  if (j.version !== 1) process.exit(1);
" "$ARTIFACT_DIR/context-pack.json"
note "context-pack.json roundtrip has all required fields" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
