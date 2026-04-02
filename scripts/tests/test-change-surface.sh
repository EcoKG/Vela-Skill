#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-change-surface.sh — E2E tests for Change Surface Analysis
#
# Creates temporary git repos to simulate 16 change scenarios
# and verifies analyze() produces correct pass/fail verdicts.
#
# Requires: node, git, rg (ripgrep)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSA="$(cd "$SCRIPT_DIR/../shared" && pwd)/change-surface.js"

PASS=0
FAIL=0
TOTAL=0
TMPDIRS=()

# ── Helpers ───────────────────────────────────────────────────

cleanup() {
  for d in "${TMPDIRS[@]}"; do rm -rf "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

if ! command -v rg &>/dev/null; then
  echo "❌ rg (ripgrep) is required but not found."
  exit 1
fi

mktestrepo() {
  local d
  d=$(mktemp -d)
  TMPDIRS+=("$d")
  git -C "$d" init -q
  git -C "$d" config user.email "test@test.com"
  git -C "$d" config user.name "Test"
  echo "$d"
}

assert_pass() {
  local label="$1" repo="$2" sha="${3:-HEAD~1}"
  TOTAL=$((TOTAL + 1))
  local code=0
  node -e "
    const m = require('${CSA}');
    const r = m.analyze('${sha}', { cwd: '${repo}' });
    if (!r.verdict.pass) { console.error(r.verdict.report); process.exit(1); }
  " 2>/dev/null || code=$?
  if [ "$code" -eq 0 ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected PASS, got FAIL"
    FAIL=$((FAIL + 1))
  fi
}

assert_fail() {
  local label="$1" repo="$2" sha="${3:-HEAD~1}"
  TOTAL=$((TOTAL + 1))
  local code=0
  node -e "
    const m = require('${CSA}');
    const r = m.analyze('${sha}', { cwd: '${repo}' });
    if (r.verdict.pass) { console.error('Expected FAIL but got PASS'); process.exit(1); }
  " 2>/dev/null || code=$?
  if [ "$code" -eq 0 ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected FAIL verdict, got PASS"
    FAIL=$((FAIL + 1))
  fi
}

assert_warn_pass() {
  local label="$1" repo="$2" sha="${3:-HEAD~1}"
  TOTAL=$((TOTAL + 1))
  local code=0
  node -e "
    const m = require('${CSA}');
    const r = m.analyze('${sha}', { cwd: '${repo}' });
    if (!r.verdict.pass || r.verdict.warnCount === 0) { console.error(JSON.stringify(r.verdict)); process.exit(1); }
  " 2>/dev/null || code=$?
  if [ "$code" -eq 0 ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected PASS with warnings"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit() {
  local label="$1" expected="$2" repo="$3" sha="${4:-HEAD~1}"
  TOTAL=$((TOTAL + 1))
  local actual=0
  (cd "$repo" && node "$CSA" "$sha") > /dev/null 2>&1 || actual=$?
  if [ "$actual" -eq "$expected" ]; then
    echo "  ✅ PASS: $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected exit $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

# ── Tests ─────────────────────────────────────────────────────

echo "⛵ Change Surface Analysis E2E Tests"
echo "═════════════════════════════════════"

# ── 1. File delete + refs not fixed → FAIL ──
echo ""
echo "── Test 1: File delete + refs not fixed ──"
R=$(mktestrepo)
mkdir -p "$R/lib"
echo 'module.exports = { helper: true };' > "$R/lib/helper.js"
printf "const h = require('./lib/helper.js');\n" > "$R/main.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
rm "$R/lib/helper.js"
git -C "$R" add -A && git -C "$R" commit -qm "delete helper"
assert_fail "File delete + refs not fixed → FAIL" "$R"

# ── 2. File delete + refs fixed → PASS ──
echo ""
echo "── Test 2: File delete + refs fixed ──"
R=$(mktestrepo)
mkdir -p "$R/lib"
echo 'module.exports = { helper: true };' > "$R/lib/helper.js"
printf "const h = require('./lib/helper.js');\n" > "$R/main.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
rm "$R/lib/helper.js"
printf "// helper removed, no ref\n" > "$R/main.js"
git -C "$R" add -A && git -C "$R" commit -qm "delete helper + fix refs"
assert_pass "File delete + refs fixed → PASS" "$R"

# ── 3. File delete + no refs → PASS ──
echo ""
echo "── Test 3: File delete + no refs ──"
R=$(mktestrepo)
echo 'const x = 1;' > "$R/orphan.js"
echo 'const y = 2;' > "$R/other.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
rm "$R/orphan.js"
git -C "$R" add -A && git -C "$R" commit -qm "delete orphan"
assert_pass "File delete + no refs → PASS" "$R"

# ── 4. Export const rename + refs not fixed → FAIL ──
echo ""
echo "── Test 4: Export const rename + refs not fixed ──"
R=$(mktestrepo)
printf 'const MAX_RETRIES = 3;\nmodule.exports = { MAX_RETRIES };\n' > "$R/config.js"
printf "const { MAX_RETRIES } = require('./config');\nconsole.log(MAX_RETRIES);\n" > "$R/app.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf 'const MAX_ATTEMPTS = 3;\nmodule.exports = { MAX_ATTEMPTS };\n' > "$R/config.js"
git -C "$R" add -A && git -C "$R" commit -qm "rename constant"
assert_fail "Export const rename + refs not fixed → FAIL" "$R"

# ── 5. Export const rename + refs fixed → PASS ──
echo ""
echo "── Test 5: Export const rename + refs fixed ──"
R=$(mktestrepo)
printf 'const MAX_RETRIES = 3;\nmodule.exports = { MAX_RETRIES };\n' > "$R/config.js"
printf "const { MAX_RETRIES } = require('./config');\nconsole.log(MAX_RETRIES);\n" > "$R/app.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf 'const MAX_ATTEMPTS = 3;\nmodule.exports = { MAX_ATTEMPTS };\n' > "$R/config.js"
printf "const { MAX_ATTEMPTS } = require('./config');\nconsole.log(MAX_ATTEMPTS);\n" > "$R/app.js"
git -C "$R" add -A && git -C "$R" commit -qm "rename constant + fix refs"
assert_pass "Export const rename + refs fixed → PASS" "$R"

# ── 6. Function name change + refs not fixed → FAIL ──
echo ""
echo "── Test 6: Function name change + refs not fixed ──"
R=$(mktestrepo)
printf 'function calculateTotal(a, b) { return a + b; }\nmodule.exports = { calculateTotal };\n' > "$R/utils.js"
printf "const { calculateTotal } = require('./utils');\ncalculateTotal(1, 2);\n" > "$R/app.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf 'function computeTotal(a, b) { return a + b; }\nmodule.exports = { computeTotal };\n' > "$R/utils.js"
git -C "$R" add -A && git -C "$R" commit -qm "rename function"
assert_fail "Function name change + refs not fixed → FAIL" "$R"

# ── 7. Function body change only (name preserved) → PASS ──
echo ""
echo "── Test 7: Function body change only ──"
R=$(mktestrepo)
printf 'function calculateTotal(a, b) { return a + b; }\nmodule.exports = { calculateTotal };\n' > "$R/utils.js"
printf "const { calculateTotal } = require('./utils');\ncalculateTotal(1, 2);\n" > "$R/app.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf 'function calculateTotal(a, b) { return a + b + 0; }\nmodule.exports = { calculateTotal };\n' > "$R/utils.js"
git -C "$R" add -A && git -C "$R" commit -qm "change body"
assert_pass "Function body change only → PASS" "$R"

# ── 8. JSON key change + refs not fixed → FAIL ──
echo ""
echo "── Test 8: JSON key change + refs not fixed ──"
R=$(mktestrepo)
printf '{\n  "maxRetries": 3,\n  "timeout": 5000\n}\n' > "$R/settings.json"
printf "const cfg = require('./settings.json');\nconsole.log(cfg.maxRetries);\n" > "$R/app.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf '{\n  "maxAttempts": 3,\n  "timeout": 5000\n}\n' > "$R/settings.json"
git -C "$R" add -A && git -C "$R" commit -qm "rename JSON key"
assert_fail "JSON key change + refs not fixed → FAIL" "$R"

# ── 9. Markdown heading change + anchor link not fixed → FAIL ──
echo ""
echo "── Test 9: Markdown heading change + anchor not fixed ──"
R=$(mktestrepo)
printf '# Installation Guide\n\nSome content here.\n' > "$R/docs.md"
printf '## See also\n\nRefer to [Installation Guide](docs.md#installation-guide)\n' > "$R/readme.md"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf '# Setup Instructions\n\nSome content here.\n' > "$R/docs.md"
git -C "$R" add -A && git -C "$R" commit -qm "rename heading"
assert_fail "Markdown heading change + anchor not fixed → FAIL" "$R"

# ── 10. Tree diagram item deleted → FAIL ──
echo ""
echo "── Test 10: Tree diagram item deleted ──"
R=$(mktestrepo)
printf '# Project Structure\n\n├── src/\n├── config.js\n└── utils.js\n' > "$R/structure.md"
printf 'See structure.md for config.js location\n' > "$R/notes.md"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf '# Project Structure\n\n├── src/\n└── utils.js\n' > "$R/structure.md"
git -C "$R" add -A && git -C "$R" commit -qm "remove tree item"
assert_fail "Tree diagram item deleted → FAIL" "$R"

# ── 11. node_modules refs → ignored → PASS ──
echo ""
echo "── Test 11: node_modules refs ignored ──"
R=$(mktestrepo)
printf 'const GLOBAL_FLAG = true;\nmodule.exports = { GLOBAL_FLAG };\n' > "$R/flags.js"
mkdir -p "$R/node_modules/somepkg"
printf "const { GLOBAL_FLAG } = require('../../flags');\n" > "$R/node_modules/somepkg/index.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf 'const WORLD_FLAG = true;\nmodule.exports = { WORLD_FLAG };\n' > "$R/flags.js"
git -C "$R" add -A && git -C "$R" commit -qm "rename constant"
assert_pass "node_modules refs ignored → PASS" "$R"

# ── 12. Code block refs → WARN (pass) ──
echo ""
echo "── Test 12: Code block refs → WARN ──"
R=$(mktestrepo)
printf 'function initSystem() { return true; }\nmodule.exports = { initSystem };\n' > "$R/core.js"
# Reference only inside a code block comment
printf '// Usage: initSystem()\nconst x = 1;\n' > "$R/notes.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf 'function bootSystem() { return true; }\nmodule.exports = { bootSystem };\n' > "$R/core.js"
git -C "$R" add -A && git -C "$R" commit -qm "rename function"
assert_warn_pass "Code block refs → WARN (pass)" "$R"

# ── 13. Token length ≤ 2 → filtered → PASS ──
echo ""
echo "── Test 13: Short token filtered ──"
R=$(mktestrepo)
# 'id' is length 2, should be filtered by MIN_TOKEN_LENGTH=3
printf '{\n  "id": 1,\n  "name": "test"\n}\n' > "$R/data.json"
printf 'const d = require("./data.json"); console.log(d.id);\n' > "$R/app.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf '{\n  "pk": 1,\n  "name": "test"\n}\n' > "$R/data.json"
git -C "$R" add -A && git -C "$R" commit -qm "rename short key"
assert_pass "Short token (len≤2) filtered → PASS" "$R"

# ── 14. Partial match filtered (READ ≠ READONLY) → PASS ──
echo ""
echo "── Test 14: Partial match filtered ──"
R=$(mktestrepo)
printf 'const READ_MODE = "r";\nmodule.exports = { READ_MODE };\n' > "$R/modes.js"
# READONLY contains READ_MODE as substring, but word boundary should filter
printf 'const READONLY_FLAG = true;\n' > "$R/app.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
printf 'const SCAN_MODE = "s";\nmodule.exports = { SCAN_MODE };\n' > "$R/modes.js"
git -C "$R" add -A && git -C "$R" commit -qm "rename constant"
assert_pass "Partial match filtered (READ_MODE ≠ READONLY_FLAG) → PASS" "$R"

# ── 15. Empty diff → PASS ──
echo ""
echo "── Test 15: Empty diff ──"
R=$(mktestrepo)
echo 'const x = 1;' > "$R/file.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
# Diff HEAD against HEAD = empty diff
assert_pass "Empty diff → PASS" "$R" "HEAD"

# ── 16. CLI exit code verification ──
echo ""
echo "── Test 16: CLI exit code ──"
# 16a: Clean diff → exit 0
R=$(mktestrepo)
echo 'const a = 1;' > "$R/file.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
echo 'const a = 2;' > "$R/file.js"
git -C "$R" add -A && git -C "$R" commit -qm "safe edit"
assert_exit "CLI exit 0 on clean diff" 0 "$R"

# 16b: Broken ref → exit 1
R=$(mktestrepo)
mkdir -p "$R/lib"
echo 'module.exports = { helper: true };' > "$R/lib/helper.js"
printf "const h = require('./lib/helper.js');\n" > "$R/main.js"
git -C "$R" add -A && git -C "$R" commit -qm "init"
rm "$R/lib/helper.js"
git -C "$R" add -A && git -C "$R" commit -qm "delete helper"
assert_exit "CLI exit 1 on broken ref" 1 "$R"

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
