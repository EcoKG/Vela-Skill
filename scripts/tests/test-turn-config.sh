#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-turn-config.sh — Unit tests for scripts/shared/turn-config.js
#
# 7 assertions covering:
#   1. Base lookup (no scale argument)
#   2. scale=large Math.ceil rounding for each pipeline role
#   3. Reviewer-stage keys (reviewer-haiku/sonnet/opus)
#   4. Unknown role fallback (→ 15)
#   5. Unknown scale fallback (→ 1.0x)
#   6. Undefined scale safety (→ 1.0x)
#   7. Math.ceil applied to non-integer scaled values
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TC="$(cd "$SCRIPT_DIR/../shared" && pwd)/turn-config.js"

PASS=0
FAIL=0
TOTAL=0

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label (got $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "── test-turn-config.sh ──"

# Test 1: Base lookup (no scale argument → 1.0x)
RESULT=$(node -e "
  const { getTurnLimit } = require('${TC}');
  const r = getTurnLimit('researcher') + ',' +
            getTurnLimit('planner') + ',' +
            getTurnLimit('executor') + ',' +
            getTurnLimit('reviewer');
  process.stdout.write(r);
")
assert_eq "base lookup: researcher/planner/executor/reviewer" "$RESULT" "15,15,25,10"

# Test 2: scale=large Math.ceil rounding for pipeline roles
# researcher(15*1.5=22.5→23), planner(15*1.5=22.5→23), executor(25*1.5=37.5→38), reviewer(10*1.5=15)
RESULT=$(node -e "
  const { getTurnLimit } = require('${TC}');
  const r = getTurnLimit('researcher','large') + ',' +
            getTurnLimit('planner','large') + ',' +
            getTurnLimit('executor','large') + ',' +
            getTurnLimit('reviewer','large');
  process.stdout.write(r);
")
assert_eq "scale=large: pipeline roles with ceil" "$RESULT" "23,23,38,15"

# Test 3: Reviewer-stage keys at base scale
RESULT=$(node -e "
  const { getTurnLimit } = require('${TC}');
  const r = getTurnLimit('reviewer-haiku','medium') + ',' +
            getTurnLimit('reviewer-sonnet','medium') + ',' +
            getTurnLimit('reviewer-opus','medium');
  process.stdout.write(r);
")
assert_eq "reviewer-stage keys at medium" "$RESULT" "5,8,10"

# Test 4: Unknown role → 15 fallback
RESULT=$(node -e "
  const { getTurnLimit } = require('${TC}');
  process.stdout.write(String(getTurnLimit('nonexistent-role','medium')));
")
assert_eq "unknown role fallback to 15" "$RESULT" "15"

# Test 5: Unknown scale → 1.0x fallback
RESULT=$(node -e "
  const { getTurnLimit } = require('${TC}');
  process.stdout.write(String(getTurnLimit('executor','bogus-scale')));
")
assert_eq "unknown scale fallback to 1.0x" "$RESULT" "25"

# Test 6: Undefined scale → 1.0x safety
RESULT=$(node -e "
  const { getTurnLimit } = require('${TC}');
  process.stdout.write(String(getTurnLimit('executor', undefined)));
")
assert_eq "undefined scale safety" "$RESULT" "25"

# Test 7: Math.ceil on reviewer-stage at large (5*1.5=7.5→8, 8*1.5=12, 10*1.5=15)
RESULT=$(node -e "
  const { getTurnLimit } = require('${TC}');
  const r = getTurnLimit('reviewer-haiku','large') + ',' +
            getTurnLimit('reviewer-sonnet','large') + ',' +
            getTurnLimit('reviewer-opus','large');
  process.stdout.write(r);
")
assert_eq "scale=large: reviewer stages with ceil" "$RESULT" "8,12,15"

echo ""
echo "── Results: $PASS/$TOTAL passed, $FAIL failed ──"
[ "$FAIL" -eq 0 ]
