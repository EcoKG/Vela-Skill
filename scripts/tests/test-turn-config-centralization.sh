#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-turn-config-centralization.sh — TURNS_MAP/maxTurns invariants
#
# Guards S03's centralization work (M023/S03/T02 + T03) from regression.
# The TURNS_MAP constant was removed from vela-pipeline.js and three
# hardcoded maxTurns literals (5/8/10) were removed from sdk-reviewer.js.
# Both files now call getTurnLimit() from shared/turn-config.js.
#
# Invariants checked (5 total, using K044 split pattern — require vs call):
#   1. vela-pipeline.js: 0 occurrences of token TURNS_MAP.
#   2. sdk-reviewer.js: 0 hardcoded maxTurns: 5|8|10 literals.
#   3. vela-pipeline.js: exactly 1 require.*turn-config AND exactly 1
#      getTurnLimit( function call.
#   4. sdk-reviewer.js: exactly 1 require.*turn-config AND exactly 3
#      getTurnLimit( function calls (haiku/sonnet/opus).
#   5. turn-config.js: defines function getTurnLimit AND exports it.
#
# On violation: prints a structured failure line per check and exits 1.
# On pass: prints "═══ ALL CHECKS PASS ═══" banner and exits 0.
#
# Environment overrides (for self-test and CI):
#   PIPELINE_JS, REVIEWER_JS, TURN_CONFIG_JS — override target file paths.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PIPELINE_JS="${PIPELINE_JS:-$PROJECT_ROOT/scripts/cli/vela-pipeline.js}"
REVIEWER_JS="${REVIEWER_JS:-$PROJECT_ROOT/scripts/shared/sdk-reviewer.js}"
TURN_CONFIG_JS="${TURN_CONFIG_JS:-$PROJECT_ROOT/scripts/shared/turn-config.js}"

# Verify target files exist before running checks.
for f in "$PIPELINE_JS" "$REVIEWER_JS" "$TURN_CONFIG_JS"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: file not found: $f" >&2
    exit 2
  fi
done

echo "═══════════════════════════════════════════════════"
echo "  turn-config centralization invariants (5 checks)"
echo "═══════════════════════════════════════════════════"

FAILS=0

# count_matches <pattern> <file> — emits match count as integer.
# Uses grep -E -c with || true to avoid set -e exit on zero matches.
count_matches() {
  local pattern="$1"
  local file="$2"
  grep -Ec "$pattern" "$file" 2>/dev/null || true
}

# ── Check 1: vela-pipeline.js has ZERO TURNS_MAP token occurrences.
C1=$(count_matches '\bTURNS_MAP\b' "$PIPELINE_JS")
if [ "$C1" -eq 0 ]; then
  echo "  [1/5] OK    vela-pipeline.js TURNS_MAP=0 (expected 0)"
else
  echo "  [1/5] FAIL  vela-pipeline.js TURNS_MAP=$C1 (expected 0)"
  FAILS=$((FAILS + 1))
fi

# ── Check 2: sdk-reviewer.js has ZERO hardcoded maxTurns: 5|8|10 literals.
C2=$(count_matches 'maxTurns:[[:space:]]*(5|8|10)\b' "$REVIEWER_JS")
if [ "$C2" -eq 0 ]; then
  echo "  [2/5] OK    sdk-reviewer.js hardcoded maxTurns=0 (expected 0)"
else
  echo "  [2/5] FAIL  sdk-reviewer.js hardcoded maxTurns=$C2 (expected 0)"
  FAILS=$((FAILS + 1))
fi

# ── Check 3: vela-pipeline.js has exactly 1 require.*turn-config AND 1 getTurnLimit( call.
C3R=$(count_matches 'require.*turn-config' "$PIPELINE_JS")
C3C=$(count_matches 'getTurnLimit\(' "$PIPELINE_JS")
if [ "$C3R" -eq 1 ] && [ "$C3C" -eq 1 ]; then
  echo "  [3/5] OK    vela-pipeline.js require=1 call=1 (expected 1/1)"
else
  echo "  [3/5] FAIL  vela-pipeline.js require=$C3R call=$C3C (expected 1/1)"
  FAILS=$((FAILS + 1))
fi

# ── Check 4: sdk-reviewer.js has exactly 1 require.*turn-config AND 3 getTurnLimit( calls.
C4R=$(count_matches 'require.*turn-config' "$REVIEWER_JS")
C4C=$(count_matches 'getTurnLimit\(' "$REVIEWER_JS")
if [ "$C4R" -eq 1 ] && [ "$C4C" -eq 3 ]; then
  echo "  [4/5] OK    sdk-reviewer.js require=1 call=3 (expected 1/3)"
else
  echo "  [4/5] FAIL  sdk-reviewer.js require=$C4R call=$C4C (expected 1/3)"
  FAILS=$((FAILS + 1))
fi

# ── Check 5: turn-config.js defines AND exports getTurnLimit.
C5D=$(count_matches '^function getTurnLimit\b' "$TURN_CONFIG_JS")
C5E=$(count_matches '(exports.*getTurnLimit|module\.exports.*getTurnLimit|[[:space:]]+getTurnLimit,)' "$TURN_CONFIG_JS")
if [ "$C5D" -ge 1 ] && [ "$C5E" -ge 1 ]; then
  echo "  [5/5] OK    turn-config.js define=$C5D export=$C5E (expected ≥1/≥1)"
else
  echo "  [5/5] FAIL  turn-config.js define=$C5D export=$C5E (expected ≥1/≥1)"
  FAILS=$((FAILS + 1))
fi

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "═══════════════════════════════════════════════════"
  echo "  ═══ ALL CHECKS PASS ═══ (5/5)"
  echo "═══════════════════════════════════════════════════"
  exit 0
else
  echo "═══════════════════════════════════════════════════"
  echo "  ❌ FAIL: $FAILS/5 invariant violations"
  echo "═══════════════════════════════════════════════════"
  exit 1
fi
