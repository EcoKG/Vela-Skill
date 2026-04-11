#!/usr/bin/env bash
# scripts/tests/test-locate.sh
# Unit test for scripts/shared/locate.js (mechanical locate module).
#
# Tests both pure-function logic (token extraction, file matching) and
# end-to-end locate() against the live Vela-Skill repo. The repo itself
# is the fixture — so adding/removing tracked files in the project will
# affect these tests. Keep assertions on stable, well-known files
# (vela-engine.js, treenode.js, vela-review-gate.js).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCATE="$REPO_ROOT/scripts/shared/locate.js"

PASS=0
FAIL=0
TOTAL=0

# ─── Helpers ─────────────────────────────────────────────────

assert_eq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" expected="$2" actual="$3"
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

assert_contains() {
  TOTAL=$((TOTAL + 1))
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    echo "     needle:   $needle"
    echo "     haystack: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

# Run locate() and emit a single line: confidence|count|first_file
# Stable JSON parsing avoids quoting nightmares in bash.
# We exclude this test file itself from the grep scope so fixture identifiers
# (like `cmdBranch` mentioned in assertions below) don't self-match.
run_locate() {
  local request="$1"
  (cd "$REPO_ROOT" && node -e "
    const { locate, DEFAULT_EXCLUDE_PATHS } = require('$LOCATE');
    const r = locate(process.argv[1], {
      excludePaths: [...DEFAULT_EXCLUDE_PATHS, 'scripts/tests/test-locate.sh'],
    });
    const first = r.primary[0] ? r.primary[0].file : '';
    process.stdout.write(r.confidence + '|' + r.primary.length + '|' + first);
  " -- "$request" 2>/dev/null)
}

# Run extractRequestTokens and emit: token1,token2,token3
run_extract() {
  local request="$1"
  (cd "$REPO_ROOT" && node -e "
    const { extractRequestTokens } = require('$LOCATE');
    const t = extractRequestTokens(process.argv[1]);
    process.stdout.write(t.map(x => x.token + '/' + x.type).join(','));
  " -- "$request" 2>/dev/null)
}

# ─── Phase 1: Module loads cleanly ───────────────────────────

echo "📋 Phase 1: Module syntax and exports"
node --check "$LOCATE" 2>/dev/null
assert_eq "locate.js parses with node --check" "0" "$?"

EXPORTS=$(node -e "const m = require('$LOCATE'); console.log(Object.keys(m).sort().join(','));")
assert_contains "exports include locate()" "locate" "$EXPORTS"
assert_contains "exports include extractRequestTokens()" "extractRequestTokens" "$EXPORTS"
assert_contains "exports include rgSearch()" "rgSearch" "$EXPORTS"
assert_contains "exports include searchBackend()" "searchBackend" "$EXPORTS"
assert_contains "exports include findFilesByPathToken()" "findFilesByPathToken" "$EXPORTS"

# ─── Phase 2: Token extraction ───────────────────────────────

echo ""
echo "📋 Phase 2: extractRequestTokens"

# File path with extension is always the highest-weight extractor
TOKENS=$(run_extract "auth.ts의 login 함수에 검증 추가")
assert_contains "file_path token extracted from 'auth.ts'" "auth.ts/file_path" "$TOKENS"

# Line hint preserved as separate field (not in label format here)
TOKENS=$(run_extract "scripts/cli/vela-engine.js:42 수정")
assert_contains "file path with subdir extracted" "scripts/cli/vela-engine.js/file_path" "$TOKENS"

# camelCase extracted
TOKENS=$(run_extract "loginHandler 함수 검증 추가")
assert_contains "camelCase extracted" "loginHandler/camel_case" "$TOKENS"

# PascalCase extracted (mixed case with both upper+lower transitions)
TOKENS=$(run_extract "UserRepository 인터페이스 정의")
assert_contains "PascalCase extracted" "UserRepository/pascal_case" "$TOKENS"

# kebab-case extracted
TOKENS=$(run_extract "vela-review-gate hook 수정")
assert_contains "kebab-case extracted" "vela-review-gate/kebab_case" "$TOKENS"

# UPPER_SNAKE_CASE extracted
TOKENS=$(run_extract "MAX_BUFFER 상수 변경")
assert_contains "UPPER_SNAKE extracted" "MAX_BUFFER/upper_snake" "$TOKENS"

# Korean noise filtered (function/file/etc are not tokens)
TOKENS=$(run_extract "함수 파일 모듈")
assert_eq "pure noise → empty token list" "" "$TOKENS"

# English noise filtered
TOKENS=$(run_extract "the function and the file")
assert_eq "english noise → empty" "" "$TOKENS"

# Quoted identifier captured
TOKENS=$(run_extract "the 'snapshotGitState' helper needs review")
assert_contains "quoted identifier captured" "snapshotGitState/quoted" "$TOKENS"

# ─── Phase 3: locate() against the live repo ─────────────────

echo ""
echo "📋 Phase 3: locate() against live Vela-Skill repo"

RESULT=$(run_locate "vela-engine.js의 cmdBranch 함수에 검증 추가")
assert_eq "T1 confidence=high" "high" "$(echo "$RESULT" | cut -d'|' -f1)"
assert_eq "T1 primary count=1" "1" "$(echo "$RESULT" | cut -d'|' -f2)"
assert_eq "T1 first file=vela-engine.js" "scripts/cli/vela-engine.js" "$(echo "$RESULT" | cut -d'|' -f3)"

RESULT=$(run_locate "TreeNode 캐시 정리")
assert_eq "T5 PascalCase confidence=high" "high" "$(echo "$RESULT" | cut -d'|' -f1)"
assert_eq "T5 first file=treenode.js" "scripts/cache/treenode.js" "$(echo "$RESULT" | cut -d'|' -f3)"

RESULT=$(run_locate "vela-engine init 명령 개선")
assert_eq "T6 kebab-case confidence=high" "high" "$(echo "$RESULT" | cut -d'|' -f1)"
assert_eq "T6 first file=vela-engine.js" "scripts/cli/vela-engine.js" "$(echo "$RESULT" | cut -d'|' -f3)"

RESULT=$(run_locate "vela-review-gate hook 수정")
assert_eq "T7 kebab w/o own-name confidence=high" "high" "$(echo "$RESULT" | cut -d'|' -f1)"
assert_eq "T7 first file=vela-review-gate.js" "scripts/hooks/vela-review-gate.js" "$(echo "$RESULT" | cut -d'|' -f3)"

# Pure Korean — no extractable tokens, must fall back to low
RESULT=$(run_locate "로그인 검증 추가")
assert_eq "T3 pure korean confidence=low" "low" "$(echo "$RESULT" | cut -d'|' -f1)"
assert_eq "T3 primary count=0" "0" "$(echo "$RESULT" | cut -d'|' -f2)"

# Untracked file (this very test file is currently untracked!)
RESULT=$(run_locate "scripts/shared/locate.js:42 수정")
assert_eq "T4 untracked file confidence=high" "high" "$(echo "$RESULT" | cut -d'|' -f1)"
assert_eq "T4 first file=locate.js" "scripts/shared/locate.js" "$(echo "$RESULT" | cut -d'|' -f3)"

# Document file with line hint
RESULT=$(run_locate "docs/v6.1-rfc-precision-locate.md 의 Q1 결정")
assert_eq "T12 doc file confidence=high" "high" "$(echo "$RESULT" | cut -d'|' -f1)"
assert_eq "T12 first file=v6.1 rfc" "docs/v6.1-rfc-precision-locate.md" "$(echo "$RESULT" | cut -d'|' -f3)"

# ─── Phase 4: Edge cases ─────────────────────────────────────

echo ""
echo "📋 Phase 4: Edge cases"

# Empty request → low confidence, empty
RESULT=$(run_locate "")
assert_eq "empty request → low confidence" "low" "$(echo "$RESULT" | cut -d'|' -f1)"

# Request with only whitespace
RESULT=$(run_locate "   ")
assert_eq "whitespace request → low" "low" "$(echo "$RESULT" | cut -d'|' -f1)"

# Request with very long noise
RESULT=$(run_locate "the function and the file and the module that does the thing")
assert_eq "all-noise request → low" "low" "$(echo "$RESULT" | cut -d'|' -f1)"

# Request with mixed Korean/English/identifier
RESULT=$(run_locate "vela-engine.js를 검토하세요")
assert_eq "mixed locale w/ file → high" "high" "$(echo "$RESULT" | cut -d'|' -f1)"
assert_eq "mixed locale primary correct" "scripts/cli/vela-engine.js" "$(echo "$RESULT" | cut -d'|' -f3)"

# ─── Summary ─────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ SOME TESTS FAILED"
  exit 1
fi
echo "✅ 전체 PASS"
