#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-v72-nightly-managed.sh — v7.2 M14 / M15
#
# M14: scripts/cli/vela-nightly.js
#   - reads .vela/learnings/learnings.json
#   - --dry-run prints markdown to stdout
#   - buckets by category, dedupes by description
#
# M15: scripts/managed/vela-managed-entry.js
#   - requires VELA_REQUEST env
#   - rejects unknown VELA_SCALE
#   - shells to .vela/cli/vela-engine.js init
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIGHTLY="$SCRIPT_DIR/../cli/vela-nightly.js"
MANAGED="$SCRIPT_DIR/../managed/vela-managed-entry.js"

PASS=0
FAIL=0
TOTAL=0

assert() {
  TOTAL=$((TOTAL + 1))
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then echo "  ✅ $label"; PASS=$((PASS + 1));
  else echo "  ❌ $label (got='$got' want='$want')"; FAIL=$((FAIL + 1)); fi
}

TMPROOT="$(mktemp -d)"
PROJECT="$TMPROOT/project"
mkdir -p "$PROJECT/.vela/learnings"
cd "$PROJECT"

echo "=== v7.2 M14 — vela-nightly ==="

# Seed learnings.json with two entries, one duplicate description to
# exercise the dedupe path.
NOW=$(date -Iseconds)
cat > .vela/learnings/learnings.json <<EOF
{
  "learnings": [
    {
      "timestamp": "$NOW",
      "request": "task A",
      "pipelineType": "small",
      "patterns": [
        {"category":"weakness","description":"missing error path"},
        {"category":"recurring_issue","description":"same bug twice"}
      ]
    },
    {
      "timestamp": "$NOW",
      "request": "task B",
      "pipelineType": "medium",
      "patterns": [
        {"category":"recurring_issue","description":"same bug twice"}
      ]
    }
  ]
}
EOF

REPORT="$(node "$NIGHTLY" --dry-run)"

echo "$REPORT" | head -3

if echo "$REPORT" | grep -q "^# Vela Nightly Report"; then
  assert "dry-run emits markdown header" "ok" "ok"
else
  assert "dry-run emits markdown header" "missing" "ok"
fi

if echo "$REPORT" | grep -q "Pipelines aggregated: 2"; then
  assert "aggregated pipeline count = 2" "ok" "ok"
else
  assert "aggregated pipeline count = 2" "wrong" "ok"
fi

# The recurring_issue "same bug twice" appears in 2 pipelines → expect ×2
if echo "$REPORT" | grep -q "×2.*same bug twice"; then
  assert "recurring dedupe: ×2 same bug twice" "ok" "ok"
else
  assert "recurring dedupe: ×2 same bug twice" "miss" "ok"
fi

# Non-dry-run writes the report file. We don't inspect the stdout JSON
# here (the file existence check below is what matters), so discard it.
node "$NIGHTLY" >/dev/null
TODAY=$(date +%F)
if [ -f ".vela/reports/nightly-$TODAY.md" ]; then
  assert "nightly-YYYY-MM-DD.md written" "yes" "yes"
else
  assert "nightly-YYYY-MM-DD.md written" "no" "yes"
fi

# --since=0 filters out everything (aggregated=0). Use --since 0 → clamps
# to 1 day. Instead, backdate one entry to 10 days ago and use --since 1.
cat > .vela/learnings/learnings.json <<'EOF'
{
  "learnings": [
    {
      "timestamp": "2000-01-01T00:00:00Z",
      "request": "old",
      "pipelineType": "small",
      "patterns": [{"category":"weakness","description":"ancient"}]
    }
  ]
}
EOF
OLD_REPORT="$(node "$NIGHTLY" --dry-run --since 1)"
if echo "$OLD_REPORT" | grep -q "No learnings within the window"; then
  assert "--since 1 filters out ancient entries" "ok" "ok"
else
  assert "--since 1 filters out ancient entries" "miss" "ok"
fi

cd /
rm -rf "$TMPROOT"

echo ""
echo "=== v7.2 M15 — vela-managed-entry ==="

# Missing VELA_REQUEST → exit 2
set +e
VELA_REQUEST="" node "$MANAGED" >/dev/null 2>&1
EXIT_MISSING=$?
set -e
assert "missing VELA_REQUEST exits 2" "$EXIT_MISSING" "2"

# Unknown VELA_SCALE → exit 2
set +e
VELA_REQUEST="test" VELA_SCALE="xxl" node "$MANAGED" >/dev/null 2>&1
EXIT_BAD_SCALE=$?
set -e
assert "unknown VELA_SCALE exits 2" "$EXIT_BAD_SCALE" "2"

# No .vela/cli/vela-engine.js in cwd → exit 3
TMP_NOENGINE="$(mktemp -d)"
set +e
( cd "$TMP_NOENGINE" && VELA_REQUEST="test" node "$MANAGED" >/dev/null 2>&1 )
EXIT_NO_ENGINE=$?
set -e
assert "missing .vela/cli/vela-engine.js exits 3" "$EXIT_NO_ENGINE" "3"
rm -rf "$TMP_NOENGINE"

echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ $FAIL -eq 0 ]
