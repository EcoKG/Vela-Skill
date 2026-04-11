#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-plan-checker-sanity.sh — v7.1 M4 plan-checker sanity
#
# Covers: the planner + plan-checker + plan-template trio that
# together enforces Architecture Guardrails + design sanity
# heuristics. Since the actual checks are run by a Claude Code
# Agent (not a script), we validate the *prompt contracts* and
# the *template file* — i.e. that planner and plan-checker both
# understand what "Architecture Guardrails" means, that the
# template demonstrates the required sections, and that the
# install manifest deploys the template.
#
# Asserts:
#   1. vela-planner.md specifies the Architecture Guardrails
#      section with Allowed/Forbidden/Injection subsections
#   2. vela-planner.md documents the domain-value format: /
#      must be constraint requirement
#   3. vela-planner.md requires ≥2 edge cases per class
#   4. vela-plan-checker.md has Phase 2 structural check with
#      4 required sections (was 3)
#   5. vela-plan-checker.md has Phase 3 design sanity with
#      (a) guardrails, (b) domain constraints, (c) edge cases
#   6. vela-plan-checker.md fails the whole plan if Phase 3
#      fails, not just warns
#   7. templates/plan-templates/quick.md has all the required
#      sections (Architecture Guardrails, Allowed imports,
#      Forbidden imports, Injection points, 2+ edge cases)
#   8. install.js FILE_MANIFEST deploys the template
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLANNER_MD="$REPO_ROOT/scripts/agents/vela-planner.md"
CHECKER_MD="$REPO_ROOT/scripts/agents/vela-plan-checker.md"
QUICK_TMPL="$REPO_ROOT/templates/plan-templates/quick.md"
INSTALL_JS="$REPO_ROOT/scripts/install.js"

PASS=0
FAIL=0
TOTAL=0

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

# ── Phase 1: planner.md requires Architecture Guardrails ─────
echo "📋 Phase 1: vela-planner.md Architecture Guardrails section"

grep -q '## Architecture Guardrails' "$PLANNER_MD"
note "planner.md plan template includes ## Architecture Guardrails" $?

grep -q 'Allowed imports' "$PLANNER_MD"
note "planner.md mentions Allowed imports" $?

grep -q 'Forbidden imports' "$PLANNER_MD"
note "planner.md mentions Forbidden imports" $?

grep -q 'Injection points' "$PLANNER_MD"
note "planner.md mentions Injection points" $?

grep -q 'T083634 DIP' "$PLANNER_MD"
note "planner.md references T083634 DIP hicoco bug" $?

# Domain value constraint rule
grep -q 'format:' "$PLANNER_MD" && grep -q 'must be' "$PLANNER_MD"
note "planner.md requires format:/must be for domain values" $?

grep -q 'bookUrl' "$PLANNER_MD"
note "planner.md shows a concrete bookUrl format example" $?

# Edge case cardinality
grep -q '엣지 케이스 ≥ 2' "$PLANNER_MD"
note "planner.md requires edge cases ≥ 2" $?

# ── Phase 2: plan-checker.md Phase 2 + Phase 3 ───────────────
echo "📋 Phase 2: vela-plan-checker.md Phase 2 + 3 specification"

grep -q '### Phase 2: 필수 섹션 확인' "$CHECKER_MD"
note "plan-checker.md has Phase 2 structural section" $?

grep -q '### Phase 3: Design sanity heuristics' "$CHECKER_MD"
note "plan-checker.md has Phase 3 design-sanity section" $?

# 4 required sections (not 3)
grep -q '## Architecture Guardrails' "$CHECKER_MD"
note "plan-checker.md Phase 2 table lists Architecture Guardrails" $?

# Phase 3 sub-checks
grep -q '(a) Architecture Guardrails 구체성' "$CHECKER_MD"
note "plan-checker.md Phase 3 has (a) Guardrails concreteness" $?

grep -q '(b) ClassSpec' "$CHECKER_MD"
note "plan-checker.md Phase 3 has (b) ClassSpec domain constraints" $?

grep -q '(c) TestStrategy' "$CHECKER_MD"
note "plan-checker.md Phase 3 has (c) TestStrategy edge cases" $?

# Failure semantics
grep -q 'guardrails_empty' "$CHECKER_MD"
note "plan-checker.md defines guardrails_empty failure code" $?

grep -q 'domain_value_unconstrained' "$CHECKER_MD"
note "plan-checker.md defines domain_value_unconstrained failure code" $?

grep -q 'test_edge_cases_too_few' "$CHECKER_MD"
note "plan-checker.md defines test_edge_cases_too_few failure code" $?

# Phase 3 FAIL → whole FAIL (no softening)
grep -q 'Phase 3 중 하나라도 실패하면 전체 FAIL' "$CHECKER_MD"
note "plan-checker.md: Phase 3 fail → whole plan FAIL" $?

# ── Phase 3: templates/plan-templates/quick.md sample ────────
echo "📋 Phase 3: quick.md template demonstrates all sections"

[ -f "$QUICK_TMPL" ]
note "templates/plan-templates/quick.md exists" $?

grep -q '^## Architecture Guardrails' "$QUICK_TMPL"
note "quick.md has ## Architecture Guardrails section" $?

grep -q '\*\*Allowed imports\*\*' "$QUICK_TMPL"
note "quick.md shows Allowed imports subsection" $?

grep -q '\*\*Forbidden imports\*\*' "$QUICK_TMPL"
note "quick.md shows Forbidden imports subsection" $?

grep -q '\*\*Injection points\*\*' "$QUICK_TMPL"
note "quick.md shows Injection points subsection" $?

# Count edge case bullets in Test Strategy — must be ≥ 2
# awk range /^## Test Strategy/,/^## / matches the start line on both
# bounds, so we skip the first line of the range and stop on the next
# `## ` header.
EDGE_COUNT=$(awk '
  /^## Test Strategy/ { inside=1; next }
  inside && /^## [A-Z]/ { inside=0 }
  inside { print }
' "$QUICK_TMPL" | grep -c -E '(\*\*edge\*\*|^- edge|^- 엣지)')
[ "$EDGE_COUNT" -ge 2 ]
note "quick.md Test Strategy has ≥ 2 edge cases (got $EDGE_COUNT)" $?

# Domain constraint example
grep -q 'must be valid RFC 5322' "$QUICK_TMPL"
note "quick.md demonstrates domain value constraint" $?

# ── Phase 4: install.js manifest ─────────────────────────────
echo "📋 Phase 4: install.js FILE_MANIFEST entry"

grep -q 'templates/plan-templates/quick.md' "$INSTALL_JS"
note "FILE_MANIFEST includes templates/plan-templates/quick.md" $?

# ── Phase 5: end-to-end deploy ───────────────────────────────
echo "📋 Phase 5: upgrade deploys quick.md to .vela/templates/"

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT
FAKE_HOME="$TMPDIR_ROOT/home"; mkdir -p "$FAKE_HOME/.claude"
PROJECT="$TMPDIR_ROOT/project"; mkdir -p "$PROJECT/.vela"
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
  HOME="$FAKE_HOME" node "$INSTALL_JS" upgrade >/dev/null 2>&1 || true
)

[ -f "$PROJECT/.vela/templates/plan-templates/quick.md" ]
note "upgrade deployed quick.md to .vela/templates/plan-templates/" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
