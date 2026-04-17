#!/usr/bin/env bash
# scripts/tests/test-locate-bench.sh
# Locate accuracy benchmark — mechanical-only recall measurement.
#
# Purpose:
#   Measure how often mechanical locate (LLM-free) correctly identifies
#   the primary file for a realistic natural-language request. This
#   informs v6.1 RFC decisions Q10-Q12:
#     Q10 — should semantic fallback use Haiku, Sonnet, or cascading?
#     Q11 — should we add ctags/tree-sitter for mechanical strengthening?
#     Q12 — should we add semantic fallback at all?
#
# Scope:
#   This script measures *mechanical-only* — the LLM-free Tier 1 path.
#   Semantic Tier 2 (Haiku/Sonnet fallback) is not implemented yet;
#   this benchmark is run BEFORE that decision to get data.
#
#   The Vela-Skill repo itself is the fixture. Scenarios use real files
#   that exist in the repo at commit time of this script. If files are
#   renamed later the fixture must be updated.
#
# Output:
#   A summary table: PASS/FAIL per scenario + aggregate recall.
#   A detailed per-scenario log with:
#     expected_file, actual_primary, confidence, tokens, match_source
#
# Interpretation:
#   recall ≥ 80%  → mechanical alone may be enough → Q12: semantic fallback optional
#   recall 60-80% → semantic fallback valuable → Q10: benchmark Haiku next
#   recall < 60%  → mechanical needs strengthening → Q11: add ctags/tree-sitter
#
# This script is NON-BLOCKING. A failing scenario is a data point, not
# a CI failure. The script always exits 0 unless the infrastructure
# itself breaks (module can't load, etc.).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCATE="$REPO_ROOT/scripts/shared/locate.js"

# Sanity: module must load
if ! node --check "$LOCATE" 2>/dev/null; then
  echo "❌ locate.js failed --check — infrastructure error"
  exit 1
fi

PASS=0
FAIL=0
TOTAL=0
FAIL_LOG=""

# ─── Helpers ─────────────────────────────────────────────────

# Run locate and emit: confidence|primary_file_0|primary_count|tokens_joined
bench_run() {
  local request="$1"
  (cd "$REPO_ROOT" && node -e "
    const { locate, DEFAULT_EXCLUDE_PATHS } = require('$LOCATE');
    const r = locate(process.argv[1], {
      excludePaths: [
        ...DEFAULT_EXCLUDE_PATHS,
        // Exclude the bench script itself so fixture prompts don't
        // self-match on the scenario text embedded in this file.
        'scripts/tests/test-locate-bench.sh',
        'scripts/tests/test-locate.sh',
        // (v7.3-M5: archival RFCs removed; no doc exclusions needed)
      ],
    });
    const first = r.primary[0] ? r.primary[0].file : '';
    const tokens = r.tokens_extracted.map(t => t.token).join(',');
    process.stdout.write(r.confidence + '|' + first + '|' + r.primary.length + '|' + tokens);
  " -- "$request" 2>/dev/null)
}

# Run a scenario.
#   $1 label
#   $2 request
#   $3 expected file (primary must contain this; first match is scored)
scenario() {
  local label="$1" request="$2" expected="$3"
  TOTAL=$((TOTAL + 1))

  local result
  result=$(bench_run "$request")
  local confidence=$(echo "$result" | cut -d'|' -f1)
  local actual=$(echo "$result" | cut -d'|' -f2)
  local count=$(echo "$result" | cut -d'|' -f3)
  local tokens=$(echo "$result" | cut -d'|' -f4)

  # Success criterion: expected file is the first primary match
  if [ "$actual" = "$expected" ]; then
    printf "  ✅ %-45s  conf=%s  first=%s\n" "$label" "$confidence" "$actual"
    PASS=$((PASS + 1))
  else
    printf "  ❌ %-45s  conf=%s  got=%s  want=%s\n" "$label" "$confidence" "$actual" "$expected"
    FAIL=$((FAIL + 1))
    FAIL_LOG="${FAIL_LOG}
    [$label]
      request:  $request
      expected: $expected
      actual:   $actual
      count:    $count
      tokens:   $tokens
      conf:     $confidence"
  fi
}

# ─── Scenarios ───────────────────────────────────────────────

echo "🔬 Mechanical Locate Accuracy Benchmark"
echo "   Repo: $REPO_ROOT"
echo ""

echo "📋 Group A: Explicit file path (trivial case)"
scenario "A1 vela-engine.js path" \
  "vela-engine.js의 cmdBranch 함수에 검증 추가" \
  "scripts/cli/vela-engine.js"
scenario "A2 full path with line" \
  "scripts/shared/locate.js:42 주석 보완" \
  "scripts/shared/locate.js"
scenario "A3 test file explicit" \
  "scripts/tests/test-review-gate.sh 의 V2-4-10 수정" \
  "scripts/tests/test-review-gate.sh"
scenario "A4 doc file explicit" \
  "references/gates-and-guards.md 의 GUARD 3 설명 보강" \
  "references/gates-and-guards.md"
scenario "A5 template file explicit" \
  "templates/pipeline.json 의 version 상수 갱신" \
  "templates/pipeline.json"

echo ""
echo "📋 Group B: Kebab-case filename stem"
scenario "B1 kebab CLI tool" \
  "vela-engine init 명령의 에러 메시지 개선" \
  "scripts/cli/vela-engine.js"
scenario "B2 kebab hook" \
  "vela-stop 훅의 review gate validation_rounds 로깅" \
  "scripts/hooks/vela-stop.js"
scenario "B3 kebab module" \
  "change-surface 모듈의 parseDiff 경로 보정" \
  "scripts/shared/change-surface.js"
scenario "B4 kebab hook gate" \
  "vela-gate 훅의 VK-08 메시지 수정" \
  "scripts/hooks/vela-gate.js"

echo ""
echo "📋 Group C: Symbol-only (PascalCase/camelCase)"
scenario "C1 PascalCase class" \
  "TreeNode 캐시 entry 형식 정리" \
  "scripts/cache/treenode.js"
scenario "C2 camelCase function" \
  "autoDetectScale 함수 폐기 준비" \
  "scripts/cli/vela-engine.js"
scenario "C3 camelCase method" \
  "cmdCleanExec 함수의 categories 파싱 보강" \
  "scripts/cli/vela-engine.js"

echo ""
echo "📋 Group D: Abstract Korean (hard cases)"
scenario "D1 abstract korean only" \
  "로그인 검증 추가" \
  "(none — should trigger AskUserQuestion)"
scenario "D2 abstract korean mixed" \
  "결제 모듈의 환불 처리 버그" \
  "(none — should trigger AskUserQuestion)"
scenario "D3 generic english" \
  "install 절차 개선" \
  "(none — should trigger AskUserQuestion)"

echo ""
echo "📋 Group E: Mixed specificity"
scenario "E1 file + symbol mix" \
  "vela-engine.js autoDetectScale 폐기" \
  "scripts/cli/vela-engine.js"
scenario "E2 test file pascal" \
  "test-engine-record 의 CIRCUIT_BREAKER_THRESHOLD 검증" \
  "scripts/tests/test-engine-record.sh"
scenario "E3 script with option" \
  "install.js 의 FILE_MANIFEST 갱신" \
  "scripts/install.js"

# ─── Summary ─────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Mechanical Locate Benchmark Results"
echo "═══════════════════════════════════════════════════════"

# Exclude the intentional-fail "(none ...)" scenarios from recall
# since they're designed to expose mechanical limits.
EXPECTED_FAIL=3
SCORED_TOTAL=$((TOTAL - EXPECTED_FAIL))
SCORED_PASS=$PASS
RECALL=$(awk "BEGIN { printf \"%.1f\", ($SCORED_PASS / $SCORED_TOTAL) * 100 }")

echo ""
echo "  Total scenarios:     $TOTAL"
echo "  Scored (excluding 3 intentional low-confidence): $SCORED_TOTAL"
echo "  Passed:              $SCORED_PASS"
echo "  Failed:              $((SCORED_TOTAL - SCORED_PASS))"
echo "  Mechanical recall:   ${RECALL}%"
echo ""

if [ -n "$FAIL_LOG" ]; then
  echo "  Failing scenarios (data for Q10-Q12 decision):"
  echo "$FAIL_LOG"
  echo ""
fi

echo "  Interpretation:"
echo "    ≥ 80% → mechanical alone may suffice; Q12 = semantic fallback optional"
echo "    60-80% → semantic fallback valuable; benchmark Haiku next"
echo "    < 60%  → mechanical needs strengthening; add ctags or tree-sitter"
echo ""

# Always exit 0 — this is a measurement, not a gate.
exit 0
