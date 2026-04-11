#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-full-pipeline.sh — V6 standard pipeline end-to-end scenario
#
# Simulates a real PM session walking through all 12 steps of the
# standard pipeline for a realistic task (refactor formatDate to
# ISO 8601). Exercises the actual vela-engine.js state machine,
# the vela-review-gate.js Stop hook N-round enforcement, and the
# ref_integrity gate via change-surface.js. Ends with a real git
# commit and finalize.
#
# Covers (validation-plan.md V8-1 + V8-3):
#   - init → research → plan → plan-check → checkpoint → branch →
#     execute → verify → diff-summary → learning → commit → finalize
#   - review-gate 3-round enforcement at research / plan / execute
#   - review-gate-{step}.json lifecycle (created, incremented, reset
#     on transition)
#   - exit_gate checks: research_md_exists, approval_exists,
#     plan_md_exists + plan_architecture_complete, plan_check_pass,
#     user_approved (checkpoint), branch_created, implementation_complete,
#     review_exists, ref_integrity, verification_md_exists,
#     changes_committed
#   - real git commit at the commit step
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"
REVIEW_GATE_HOOK="$SCRIPT_DIR/../hooks/vela-review-gate.js"
PIPELINE_JSON="$REPO_ROOT/templates/pipeline.json"
CONFIG_JSON="$REPO_ROOT/templates/config.json"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""
ARTIFACT_DIR=""

# ── Helpers ──────────────────────────────────────────────────

# Run git without the global commit.gpgsign so tests work in environments
# that set a signing hook (e.g. some sandboxes).
git_no_sign() {
  GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=commit.gpgsign \
    GIT_CONFIG_VALUE_0=false \
    git "$@"
}

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/src/utils"
  mkdir -p "$PROJECT/.vela/templates"
  mkdir -p "$PROJECT/.vela/artifacts"
  mkdir -p "$PROJECT/.vela/state"

  # Real templates from the repo
  cp "$PIPELINE_JSON" "$PROJECT/.vela/templates/pipeline.json"
  cp "$CONFIG_JSON"   "$PROJECT/.vela/templates/config.json"

  # Also put a copy at .vela/config.json so the review-gate hook
  # reads the same config.
  cp "$CONFIG_JSON" "$PROJECT/.vela/config.json"

  # This test specifically verifies the 3-round review-gate cycle across
  # research/plan/execute. Force those values regardless of whatever the
  # shipped template default is — the template default is a product
  # decision, but the scenario asserts the mechanism works when rounds=3.
  node -e "
    const fs = require('fs');
    for (const p of ['$PROJECT/.vela/config.json', '$PROJECT/.vela/templates/config.json']) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      cfg.review_gate = cfg.review_gate || {};
      cfg.review_gate.enabled = true;
      cfg.review_gate.validation_rounds = 3;
      cfg.review_gate.steps = ['research', 'execute', 'plan'];
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    }
  "

  # Realistic source file we're going to refactor
  cat > "$PROJECT/src/utils/helper.js" <<'JS'
function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

module.exports = { formatDate };
JS

  cat > "$PROJECT/src/app.js" <<'JS'
const { formatDate } = require("./utils/helper");
console.log("Today:", formatDate(new Date()));
module.exports = { run: () => formatDate(new Date()) };
JS

  # Match real-world fixture: .vela/ is fully gitignored from day 1, so the
  # baseline commit doesn't contain pipeline.json/config.json. This prevents
  # change-surface from treating those files as "deleted" during the execute
  # transition (it would otherwise match JSON tokens like "log" against
  # console.log in src/app.js and flag a false-positive broken reference).
  cat > "$PROJECT/.gitignore" <<'GI'
.vela/
GI

  (cd "$PROJECT" \
    && git_no_sign init -q -b main \
    && git_no_sign config user.email "test@vela.local" \
    && git_no_sign config user.name "Vela Scenario Test" \
    && git_no_sign config commit.gpgsign false \
    && git_no_sign add -A \
    && git_no_sign commit -q -m "fixture: initial formatDate")
}

teardown_sandbox() {
  [ -n "${TMPDIR_ROOT:-}" ] && rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
  TMPDIR_ROOT=""
  PROJECT=""
  ARTIFACT_DIR=""
}

trap teardown_sandbox EXIT

# Run engine from the project dir with signing disabled.
engine() {
  (cd "$PROJECT" && GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=commit.gpgsign \
    GIT_CONFIG_VALUE_0=false \
    node "$ENGINE" "$@")
}

# Resolve the active artifact directory via the engine state.
resolve_artifact_dir() {
  ARTIFACT_DIR=$(engine state 2>/dev/null | node -e "
    let data='';
    process.stdin.on('data',c=>data+=c);
    process.stdin.on('end',()=>{
      try {
        const s = JSON.parse(data);
        process.stdout.write(s.artifact_dir || '');
      } catch (_) {}
    });
  ")
}

# Read current_step from engine state.
current_step() {
  engine state 2>/dev/null | node -e "
    let data='';
    process.stdin.on('data',c=>data+=c);
    process.stdin.on('end',()=>{
      try {
        const s = JSON.parse(data);
        process.stdout.write(s.current_step || '');
      } catch (_) {}
    });
  "
}

# Run the review-gate Stop hook and return its stdout.
run_review_gate() {
  echo "{\"cwd\":\"$PROJECT\"}" | node "$REVIEW_GATE_HOOK" 2>/dev/null || true
}

# Assertion helpers
assert_ok() {
  TOTAL=$((TOTAL + 1))
  local label="$1"
  local out="$2"
  if echo "$out" | grep -q '"ok": *true'; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    echo "     output: $(echo "$out" | head -1)"
    FAIL=$((FAIL + 1))
  fi
}

assert_eq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_file() {
  TOTAL=$((TOTAL + 1))
  local label="$1" filepath="$2"
  if [ -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — missing: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_no_file() {
  TOTAL=$((TOTAL + 1))
  local label="$1" filepath="$2"
  if [ ! -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — file should not exist: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  TOTAL=$((TOTAL + 1))
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — '$needle' not in: $(echo "$haystack" | head -1)"
    FAIL=$((FAIL + 1))
  fi
}

# Simulate reviewer APPROVE by writing review-{step}.md
write_review_approve() {
  local step="$1"
  cat > "$ARTIFACT_DIR/review-${step}.md" <<EOF
# Review: ${step}

판정: APPROVE

리뷰어 에이전트 산출물. 시나리오 테스트에서 생성.
EOF
}

# Simulate PM approval by writing approval-{step}.json
write_approval() {
  local step="$1"
  cat > "$ARTIFACT_DIR/approval-${step}.json" <<EOF
{
  "decision": "approve",
  "step": "${step}",
  "reviewer": "vela-reviewer",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

# Verify the review-gate 3-round cycle for a given step.
# Precondition: current_step == $step, review-{step}.md with APPROVE exists.
# Postcondition: review-gate-{step}.json count=3, next hook call returns no block.
verify_review_gate_cycle() {
  local step="$1"
  local gate_file="$PROJECT/.vela/state/review-gate-${step}.json"

  echo ""
  echo "   🔁 review-gate 3-round cycle for '$step'"

  # Precondition: gate file absent
  assert_no_file "gate state absent before cycle ($step)" "$gate_file"

  # Round 1/3 — should block
  local out1
  out1=$(run_review_gate)
  assert_contains "round 1/3 blocks ($step)" "1/3" "$out1"
  assert_file "gate state file created ($step)" "$gate_file"
  local c1
  c1=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$gate_file','utf8')).count)" 2>/dev/null)
  assert_eq "gate count=1 after round 1 ($step)" "1" "$c1"

  # Round 2/3 — should block
  local out2
  out2=$(run_review_gate)
  assert_contains "round 2/3 blocks ($step)" "2/3" "$out2"
  local c2
  c2=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$gate_file','utf8')).count)" 2>/dev/null)
  assert_eq "gate count=2 after round 2 ($step)" "2" "$c2"

  # Round 3/3 — should block
  local out3
  out3=$(run_review_gate)
  assert_contains "round 3/3 blocks ($step)" "3/3" "$out3"
  local c3
  c3=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$gate_file','utf8')).count)" 2>/dev/null)
  assert_eq "gate count=3 after round 3 ($step)" "3" "$c3"

  # Round 4 — count already at 3, should not block (all rounds done)
  local out4
  out4=$(run_review_gate)
  TOTAL=$((TOTAL + 1))
  if echo "$out4" | grep -q '"decision"'; then
    echo "  ❌ FAIL: round 4 should pass (all rounds done) ($step) — got: $out4"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ PASS: round 4 passes (all rounds done) ($step)"
    PASS=$((PASS + 1))
  fi
}

# ── Main walkthrough ─────────────────────────────────────────

echo "⛵ V6 full-pipeline E2E scenario"
echo "════════════════════════════════════════════════"
echo "Task: Refactor formatDate to support ISO 8601"
echo ""

setup_sandbox

# ────────────────── STEP 1: init ──────────────────
echo "📋 Step 1/13 — init"
INIT_OUT=$(engine init "Refactor src/utils/helper.js formatDate helper to support ISO 8601 output format" --scale large)
assert_ok "init ok" "$INIT_OUT"
resolve_artifact_dir
assert_eq "artifact_dir populated" "1" "$([ -n "$ARTIFACT_DIR" ] && echo 1 || echo 0)"
assert_eq "current_step=init" "init" "$(current_step)"

# init exit gate is auto-passed; just record and transition
assert_ok "record pass (init)" "$(engine record pass)"
assert_ok "transition init→locate" "$(engine transition)"
assert_eq "current_step=locate" "locate" "$(current_step)"

# ────────────────── STEP 1.5: locate ──────────────────
# v6.1 Universal Locate — deterministic file/symbol identification.
# The request explicitly names src/utils/helper.js so locate should hit
# that file with high confidence using file_path matching.
echo ""
echo "📋 Step 2/13 — locate (v6.1)"
LOC_OUT=$(engine locate)
assert_ok "engine locate ok" "$LOC_OUT"
assert_file "targets.json created" "$ARTIFACT_DIR/targets.json"
# Verify targets.json has the expected structure + picked up our file
TARGETS_OK=$(node -e "
  const t = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/targets.json', 'utf8'));
  const hit = t.primary.some(p => p.file === 'src/utils/helper.js');
  process.stdout.write(hit && t.confidence !== 'low' ? 'ok' : 'miss');
" 2>/dev/null)
assert_eq "locate found src/utils/helper.js" "ok" "$TARGETS_OK"
assert_ok "record pass (locate)" "$(engine record pass)"
assert_ok "transition locate→research" "$(engine transition)"
assert_eq "current_step=research" "research" "$(current_step)"

# ────────────────── STEP 2: research ──────────────────
echo ""
echo "📋 Step 3/13 — research"
# Agent produces research.md
cat > "$ARTIFACT_DIR/research.md" <<'MD'
# Research: formatDate ISO 8601 refactor

## Current state
`src/utils/helper.js` returns manually-concatenated YYYY-M-D strings.

## Constraints
- Must remain backward-compatible with the single `Date` argument signature.
- `src/app.js` imports `formatDate` and uses it with `new Date()`.

## Approach
Use `toISOString()` and slice to the `YYYY-MM-DD` form (ISO 8601 date format).
MD
write_approval "research"
write_review_approve "research"

# Check review-gate 3-round cycle
verify_review_gate_cycle "research"

# Record + transition
assert_ok "record pass (research)" "$(engine record pass)"
TR_OUT=$(engine transition)
assert_ok "transition research→plan" "$TR_OUT"
assert_eq "current_step=plan" "plan" "$(current_step)"
# Verify transition reset the review-gate state file
assert_no_file "review-gate-research.json cleared after transition" \
  "$PROJECT/.vela/state/review-gate-research.json"

# ────────────────── STEP 3: plan ──────────────────
echo ""
echo "📋 Step 4/13 — plan"
# Plan must contain the three required sections, each >=200 chars of substance.
cat > "$ARTIFACT_DIR/plan.md" <<'MD'
# Plan: formatDate ISO 8601 refactor

## Architecture
The refactor keeps the existing single-file module layout: `src/utils/helper.js`
exports a single `formatDate(date)` function and `src/app.js` imports it. We
replace the implementation body with `new Date(date).toISOString().slice(0, 10)`
which produces a canonical `YYYY-MM-DD` string for any valid Date input. No
new dependencies, no new files, and the module surface stays identical so all
existing call-sites continue to work without change. The function stays pure.

## Class Specification
`formatDate(date: Date | string | number) -> string`. Input: anything the
`Date` constructor accepts. Output: a 10-character ISO 8601 date substring
`YYYY-MM-DD`. Behavior for invalid input: `toISOString()` throws a
`RangeError`, matching the prior implicit behavior where `NaN` values
produced `"NaN-NaN-NaN"`. We consider that an acceptable trade because
throwing is clearly better than returning corrupted output.

## Test Strategy
Smoke verification: calling `formatDate(new Date("2026-04-10"))` should
return exactly `"2026-04-10"`. The existing `src/app.js` continues to
execute without throwing because we hand it a real `new Date()`. The
refactor is small enough that a dedicated unit test is not required for
this scenario; the change-surface gate guarantees no downstream caller
is broken by validating ref integrity against the baseline.
MD
write_approval "plan"
write_review_approve "plan"

verify_review_gate_cycle "plan"

assert_ok "record pass (plan)" "$(engine record pass)"
assert_ok "transition plan→plan-check" "$(engine transition)"
assert_eq "current_step=plan-check" "plan-check" "$(current_step)"
assert_no_file "review-gate-plan.json cleared after transition" \
  "$PROJECT/.vela/state/review-gate-plan.json"

# ────────────────── STEP 4: plan-check ──────────────────
echo ""
echo "📋 Step 5/13 — plan-check"
cat > "$ARTIFACT_DIR/plan-check.md" <<'MD'
# Plan Check

판정: APPROVE

계획이 아키텍처 요건을 만족하고 실행 가능함.
MD

assert_ok "record pass (plan-check)" "$(engine record pass)"
assert_ok "transition plan-check→checkpoint" "$(engine transition)"
assert_eq "current_step=checkpoint" "checkpoint" "$(current_step)"

# ────────────────── STEP 5: checkpoint ──────────────────
echo ""
echo "📋 Step 6/13 — checkpoint (user approval)"
assert_ok "record pass (checkpoint)" "$(engine record pass)"
assert_ok "transition checkpoint→branch" "$(engine transition)"
assert_eq "current_step=branch" "branch" "$(current_step)"

# ────────────────── STEP 6: branch ──────────────────
echo ""
echo "📋 Step 7/13 — branch"
BR_OUT=$(engine branch --mode auto)
assert_ok "branch create ok" "$BR_OUT"
# Confirm we're on a vela/* branch now
CURRENT_BR=$(cd "$PROJECT" && git_no_sign rev-parse --abbrev-ref HEAD)
assert_contains "on vela/* branch" "vela/" "$CURRENT_BR"

assert_ok "record pass (branch)" "$(engine record pass)"
assert_ok "transition branch→execute" "$(engine transition)"
assert_eq "current_step=execute" "execute" "$(current_step)"

# ────────────────── STEP 7: execute ──────────────────
echo ""
echo "📋 Step 8/13 — execute (real code edit)"
# Make the actual refactor: formatDate → ISO 8601
cat > "$PROJECT/src/utils/helper.js" <<'JS'
function formatDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

module.exports = { formatDate };
JS

# Verify the code change actually happened
NEW_CONTENT=$(cat "$PROJECT/src/utils/helper.js")
assert_contains "formatDate uses toISOString" "toISOString" "$NEW_CONTENT"

# Agents write execute artifacts
write_approval "execute"
write_review_approve "execute"

verify_review_gate_cycle "execute"

assert_ok "record pass (execute)" "$(engine record pass)"
# The execute transition also runs ref_integrity via change-surface.js —
# the fixture's .gitignore excludes .vela/ so this should succeed.
EX_OUT=$(engine transition)
assert_ok "transition execute→verify (ref_integrity passes)" "$EX_OUT"
assert_eq "current_step=verify" "verify" "$(current_step)"
assert_no_file "review-gate-execute.json cleared after transition" \
  "$PROJECT/.vela/state/review-gate-execute.json"

# ────────────────── STEP 8: verify ──────────────────
echo ""
echo "📋 Step 9/13 — verify"
cat > "$ARTIFACT_DIR/verification.md" <<'MD'
# Verification

판정: APPROVE

formatDate(new Date("2026-04-10")) → "2026-04-10"  ✓
src/app.js 임포트 경로 변경 없음 ✓
MD

assert_ok "record pass (verify)" "$(engine record pass)"
assert_ok "transition verify→diff-summary" "$(engine transition)"
assert_eq "current_step=diff-summary" "diff-summary" "$(current_step)"

# ────────────────── STEP 9: diff-summary ──────────────────
echo ""
echo "📋 Step 10/13 — diff-summary"
cat > "$ARTIFACT_DIR/diff-summary.md" <<'MD'
# Diff Summary
- src/utils/helper.js: formatDate → toISOString().slice(0,10)
MD

assert_ok "record pass (diff-summary)" "$(engine record pass)"
assert_ok "transition diff-summary→learning" "$(engine transition)"
assert_eq "current_step=learning" "learning" "$(current_step)"

# ────────────────── STEP 10: learning ──────────────────
echo ""
echo "📋 Step 11/13 — learning"
cat > "$ARTIFACT_DIR/learning.md" <<'MD'
# Learning
toISOString().slice(0,10) is the canonical ISO 8601 date-only form.
MD

assert_ok "record pass (learning)" "$(engine record pass)"
assert_ok "transition learning→commit" "$(engine transition)"
assert_eq "current_step=commit" "commit" "$(current_step)"

# ────────────────── STEP 11: commit ──────────────────
echo ""
echo "📋 Step 12/13 — commit (real git commit)"
COMMIT_OUT=$(engine commit --message "refactor: formatDate → ISO 8601 via toISOString")
assert_ok "engine commit ok" "$COMMIT_OUT"
# Verify a new commit actually landed on the pipeline branch
LATEST_MSG=$(cd "$PROJECT" && git_no_sign log -1 --pretty=%s)
assert_contains "commit message landed" "formatDate" "$LATEST_MSG"

assert_ok "record pass (commit)" "$(engine record pass)"
assert_ok "transition commit→finalize" "$(engine transition)"
assert_eq "current_step=finalize" "finalize" "$(current_step)"

# ────────────────── STEP 12: finalize ──────────────────
echo ""
echo "📋 Step 13/13 — finalize"
cat > "$ARTIFACT_DIR/report.md" <<'MD'
# Pipeline Report
formatDate refactor complete. All 12 steps passed.
MD

assert_ok "record pass (finalize)" "$(engine record pass)"
FIN_OUT=$(engine transition)
assert_ok "transition finalize (completed)" "$FIN_OUT"
assert_contains "pipeline marked completed" "\"completed\": true" "$FIN_OUT"

# Final state should have active:false
FINAL_STATE=$(engine state)
assert_contains "final state active:false" '"active": false' "$FINAL_STATE"

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ SCENARIO FAILED"
  exit 1
fi
echo "✅ V6 전체 파이프라인 시나리오 PASS"
