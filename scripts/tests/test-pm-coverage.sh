#!/usr/bin/env bash
# scripts/tests/test-pm-coverage.sh
#
# Static PM-orchestration coverage check.
#
# WHY THIS EXISTS
# ───────────────
# v7.0 shipped with a fully working engine (templates/pipeline.json
# surgical pipeline + patch_spec_complete exit gate + planner mode:spec
# + verifier out-of-scope check + test-surgical-pipeline.sh 35/35 PASS)
# but with ZERO PM orchestration instructions for the new steps. The
# PM (scripts/agents/vela.md) had no [spec 단계] or [patch 단계]
# section, and pipeline-flow.md had no surgical tier row. A user
# invoking /vela:fix would have the engine happily create a surgical
# pipeline, run init → locate → research, and then stall because the
# PM had no instructions on how to invoke the spec step's planner
# with mode: spec + targetsPath + researchPath.
#
# test-full-pipeline.sh and test-surgical-pipeline.sh didn't catch
# this because both tests STUB agent artifacts directly (cat > spec.md)
# instead of driving the PM through its markdown instructions. The
# PM instruction layer has always been outside CI's blast radius.
#
# This test closes that gap for the static cases — anything that can
# be verified without actually running an agent:
#
# Category A  Every step id in pipeline.json must be mentioned by name
#             in either scripts/agents/vela.md or
#             scripts/agents/pm/pipeline-flow.md. If a step exists in
#             the engine but no PM doc mentions it, the PM literally
#             cannot route to it.
#
# Category B  Every scale in pipeline.json's `scales` map must have a
#             corresponding skills/{scale}/SKILL.md file. Missing skill
#             files mean the slash command doesn't resolve.
#
# Category C  Every scale must route to a pipeline that actually
#             exists in pipeline.json. Dangling scale → pipeline
#             references crash vela-engine init at load time.
#
# Category D  Every scale skill file (skills/{scale}/SKILL.md) must
#             invoke `vela-engine init ... --scale {name}` somewhere
#             in its body. Otherwise the skill silently uses the
#             default (medium) and the scale name becomes cosmetic.
#
# Categories are ordered so that finding a Category A failure usually
# predicts a Category D failure too (same class of oversight).
#
# NOT COVERED (still requires live LLM invocation)
# ────────────────────────────────────────────────
#   - whether an agent actually reads targetsPath it receives
#   - whether patch-spec.md content matches what planner was asked
#   - whether verifier actually runs Phase 4.5 when specPath is set
#
# For those we still rely on review-gate + manual /vela:fix dry-runs.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIPELINE_JSON="$REPO_ROOT/templates/pipeline.json"
VELA_MD="$REPO_ROOT/scripts/agents/vela.md"
PIPELINE_FLOW_MD="$REPO_ROOT/scripts/agents/pm/pipeline-flow.md"
SKILLS_DIR="$REPO_ROOT/skills"

PASS=0
FAIL=0
TOTAL=0

# ─── Helpers ────────────────────────────────────────────────

assert_true() {
  TOTAL=$((TOTAL + 1))
  local label="$1" cond="$2" detail="${3:-}"
  if [ "$cond" = "1" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    [ -n "$detail" ] && echo "     → $detail"
    FAIL=$((FAIL + 1))
  fi
}

# Collect every step id referenced by any pipeline:
# steps[] entries + steps_only[] entries from every pipeline.
# Deduplicated, sorted. Output one id per line.
collect_all_step_ids() {
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$PIPELINE_JSON', 'utf8'));
    const ids = new Set();
    for (const pl of Object.values(p.pipelines || {})) {
      if (Array.isArray(pl.steps)) {
        for (const s of pl.steps) if (s && s.id) ids.add(s.id);
      }
      if (Array.isArray(pl.steps_only)) {
        for (const id of pl.steps_only) ids.add(id);
      }
    }
    process.stdout.write(Array.from(ids).sort().join('\n'));
  "
}

collect_pipeline_names() {
  node -e "
    const p = JSON.parse(require('fs').readFileSync('$PIPELINE_JSON', 'utf8'));
    process.stdout.write(Object.keys(p.pipelines || {}).sort().join('\n'));
  "
}

# Emit scales as `scale|pipeline` lines
collect_scales() {
  node -e "
    const p = JSON.parse(require('fs').readFileSync('$PIPELINE_JSON', 'utf8'));
    for (const [scale, target] of Object.entries(p.scales || {})) {
      process.stdout.write(scale + '|' + target + '\n');
    }
  "
}

# Check whether a step id appears anywhere in the PM docs.
# Looks for the word surrounded by non-word characters so partial
# hits like "branching" don't pollute a check for "branch".
step_mentioned_in_pm_docs() {
  local step="$1"
  # Escape regex-special chars in step name (hyphen, etc.)
  local escaped
  escaped=$(printf '%s' "$step" | sed 's/[][\.*^$/\\-]/\\&/g')
  if grep -Eq "(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)" \
       "$VELA_MD" "$PIPELINE_FLOW_MD" 2>/dev/null; then
    echo 1
  else
    echo 0
  fi
}

# ─── Run ────────────────────────────────────────────────────

echo "🧭 PM Coverage Static Check"
echo "   Pipeline: $(realpath --relative-to="$REPO_ROOT" "$PIPELINE_JSON")"
echo "   vela.md:  $(realpath --relative-to="$REPO_ROOT" "$VELA_MD")"
echo "   flow.md:  $(realpath --relative-to="$REPO_ROOT" "$PIPELINE_FLOW_MD")"
echo ""

# Sanity: prerequisites exist
for f in "$PIPELINE_JSON" "$VELA_MD" "$PIPELINE_FLOW_MD"; do
  if [ ! -f "$f" ]; then
    echo "❌ missing prerequisite: $f"
    exit 2
  fi
done

# ─── Category A: step → PM doc mention ────────────────────
echo "📋 Category A: Every pipeline step is mentioned in PM docs"

STEP_IDS=$(collect_all_step_ids)
if [ -z "$STEP_IDS" ]; then
  assert_true "pipeline.json yields at least one step id" "0" \
    "Expected steps_only and steps arrays across pipelines"
fi

while IFS= read -r step; do
  [ -z "$step" ] && continue
  result=$(step_mentioned_in_pm_docs "$step")
  assert_true \
    "step '$step' mentioned in PM docs" \
    "$result" \
    "Add a section like [$step 단계] to scripts/agents/vela.md or pipeline-flow.md"
done <<< "$STEP_IDS"

# ─── Category B: scale → skill file exists ────────────────
echo ""
echo "📋 Category B: Every scale has a skills/{scale}/SKILL.md"

while IFS='|' read -r scale _pipeline; do
  [ -z "$scale" ] && continue
  skill_file="$SKILLS_DIR/$scale/SKILL.md"
  if [ -f "$skill_file" ]; then
    assert_true "scale '$scale' → skills/$scale/SKILL.md" "1"
  else
    assert_true \
      "scale '$scale' → skills/$scale/SKILL.md" \
      "0" \
      "Create skills/$scale/SKILL.md that invokes --scale $scale"
  fi
done < <(collect_scales)

# ─── Category C: scale → pipeline defined ─────────────────
echo ""
echo "📋 Category C: Every scale routes to a defined pipeline"

PIPELINES=$(collect_pipeline_names)
while IFS='|' read -r scale pipeline; do
  [ -z "$scale" ] && continue
  if echo "$PIPELINES" | grep -Fxq "$pipeline"; then
    assert_true "scale '$scale' → pipeline '$pipeline' exists" "1"
  else
    assert_true \
      "scale '$scale' → pipeline '$pipeline' exists" \
      "0" \
      "Define pipelines.$pipeline in templates/pipeline.json"
  fi
done < <(collect_scales)

# ─── Category D: scale skills actually use --scale ─────────
echo ""
echo "📋 Category D: Scale skills invoke '--scale {name}'"

# Build the set of valid scale names up front
SCALE_NAMES=$(collect_scales | awk -F'|' '{print $1}')

if [ -d "$SKILLS_DIR" ]; then
  for skill_dir in "$SKILLS_DIR"/*/; do
    skill_name=$(basename "$skill_dir")
    skill_file="$skill_dir/SKILL.md"
    [ ! -f "$skill_file" ] && continue

    # Only enforce on known scale names. Non-scale skills
    # (analyze, git-clean, update, start) are allowed to not
    # have --scale invocations.
    if ! echo "$SCALE_NAMES" | grep -Fxq "$skill_name"; then
      continue
    fi

    if grep -Fq -- "--scale $skill_name" "$skill_file"; then
      assert_true "skill '$skill_name' invokes '--scale $skill_name'" "1"
    else
      assert_true \
        "skill '$skill_name' invokes '--scale $skill_name'" \
        "0" \
        "Ensure skills/$skill_name/SKILL.md body runs vela-engine init --scale $skill_name"
    fi
  done
fi

# ─── Summary ────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "❌ PM coverage gaps detected."
  echo "   These gaps do NOT affect the engine state machine — CI's"
  echo "   existing tests (test-full-pipeline, test-surgical-pipeline)"
  echo "   will still pass because they stub agent artifacts directly."
  echo "   But a real PM running the documented procedures will fail"
  echo "   at the first missing step, because there's no instruction"
  echo "   telling it how to invoke the agent for that step."
  exit 1
fi
echo "✅ PM coverage complete — every pipeline step has a PM procedure"
