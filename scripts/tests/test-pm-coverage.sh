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
INSTALL_SH="$REPO_ROOT/install.sh"
UPDATE_SH="$REPO_ROOT/update.sh"
PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"
PACKAGE_JSON="$REPO_ROOT/package.json"
SKILL_MD="$REPO_ROOT/SKILL.md"
ENGINE_JS="$REPO_ROOT/scripts/cli/vela-engine.js"
CLI_REFERENCE="$REPO_ROOT/references/cli-reference.md"
GATES_GUARDS="$REPO_ROOT/references/gates-and-guards.md"
INSTALL_JS="$REPO_ROOT/scripts/install.js"
DEPLOY_COMMON="$REPO_ROOT/scripts/deploy-common.sh"
AGENTS_DIR="$REPO_ROOT/scripts/agents"

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

# ─── Category E: install.sh / update.sh deploy every skill ─
# This catches v7.0.2: install.sh and update.sh had a hardcoded
# "for sub in start git-clean analyze update" loop that installed
# sub-skills as top-level `vela-{name}` skills for Claude Code
# autocomplete. v6.1 added small/medium/large/ralph/hotfix and v7.0
# added fix, but nobody updated the hardcoded list. Result: the
# skill files were copied into ~/.claude/skills/vela/skills/ but
# Claude Code's slash-command autocomplete didn't find them because
# they weren't installed as top-level skills.
#
# We verify by scanning install.sh and update.sh for every skill
# directory under skills/ and checking that each one is referenced
# by name. An allowlist of "already handled" non-scale skills is
# tolerated.
echo ""
echo "📋 Category E: install.sh / update.sh deploy every skill as top-level"

for skill_dir in "$SKILLS_DIR"/*/; do
  skill_name=$(basename "$skill_dir")
  [ ! -f "$skill_dir/SKILL.md" ] && continue

  # install.sh must reference the skill name (either in a hardcoded
  # list or via a dynamic loop that processes every skills/ subdir)
  if grep -Eq "(for sub in[^;]*\\b${skill_name}\\b|for .* in[^;]*\\\"\\\$TMP/skills\\\"/\\*/|skills/\\*/)" "$INSTALL_SH" 2>/dev/null; then
    assert_true "install.sh deploys skills/$skill_name" "1"
  else
    assert_true \
      "install.sh deploys skills/$skill_name" \
      "0" \
      "Add '$skill_name' to install.sh's skill loop (or use dynamic skills/*/ loop)"
  fi

  if grep -Eq "(for sub in[^;]*\\b${skill_name}\\b|for .* in[^;]*\\\"\\\$TMP/skills\\\"/\\*/|skills/\\*/)" "$UPDATE_SH" 2>/dev/null; then
    assert_true "update.sh deploys skills/$skill_name" "1"
  else
    assert_true \
      "update.sh deploys skills/$skill_name" \
      "0" \
      "Add '$skill_name' to update.sh's skill loop (or use dynamic skills/*/ loop)"
  fi
done

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

# ─── Category F: version consistency ──────────────────────
# Catches v7.0.1's oversight: plugin.json and package.json were
# version 7.0.0 even after v7.0.1 fixes landed. SKILL.md heading
# should match. A mismatch means the update-notifier and usage
# telemetry will report a stale version.
echo ""
echo "📋 Category F: Version consistency (plugin.json / package.json / SKILL.md)"

PLUGIN_VER=$(node -e "process.stdout.write(require('$PLUGIN_JSON').version || '')" 2>/dev/null || echo "")
PACKAGE_VER=$(node -e "process.stdout.write(require('$PACKAGE_JSON').version || '')" 2>/dev/null || echo "")
# Extract the first vX.Y[.Z] token from the first H1 of SKILL.md
SKILL_VER=$(grep -m1 '^# ' "$SKILL_MD" 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 | sed 's/^v//')

if [ -n "$PLUGIN_VER" ] && [ -n "$PACKAGE_VER" ] && [ "$PLUGIN_VER" = "$PACKAGE_VER" ]; then
  assert_true "plugin.json ($PLUGIN_VER) == package.json ($PACKAGE_VER)" "1"
else
  assert_true \
    "plugin.json == package.json" \
    "0" \
    "plugin.json=$PLUGIN_VER, package.json=$PACKAGE_VER — bump both together"
fi

# SKILL.md only needs to agree on the major.minor prefix — patch
# version is informational in the user-facing header.
if [ -n "$SKILL_VER" ] && [ -n "$PLUGIN_VER" ]; then
  PLUGIN_MM=$(echo "$PLUGIN_VER" | cut -d. -f1,2)
  SKILL_MM=$(echo "$SKILL_VER" | cut -d. -f1,2)
  if [ "$PLUGIN_MM" = "$SKILL_MM" ]; then
    assert_true "SKILL.md header (v$SKILL_VER) matches plugin.json major.minor (v$PLUGIN_MM)" "1"
  else
    assert_true \
      "SKILL.md header matches plugin.json" \
      "0" \
      "SKILL.md=v$SKILL_VER, plugin.json=v$PLUGIN_VER — update SKILL.md header on major/minor bumps"
  fi
else
  assert_true \
    "SKILL.md has a parseable version header" \
    "0" \
    "Expected first heading of SKILL.md to contain vX.Y[.Z]"
fi

# ─── Category G: skill frontmatter ↔ directory name ──────
# Every skills/{name}/SKILL.md must have frontmatter name "vela:{name}"
# (or "vela" for the base skill). Mismatch means the slash command
# autocomplete label won't match the directory and users get confused.
echo ""
echo "📋 Category G: Skill frontmatter 'name:' matches directory"

for skill_dir in "$SKILLS_DIR"/*/; do
  [ -f "$skill_dir/SKILL.md" ] || continue
  skill_name=$(basename "$skill_dir")
  expected_name="vela:$skill_name"

  # Extract name field from YAML frontmatter (first --- block)
  actual_name=$(awk '/^---$/{f++; next} f==1 && /^name:/ {sub(/^name:[ \t]*/, ""); gsub(/^["'\'']|["'\'']$/, ""); print; exit}' "$skill_dir/SKILL.md" 2>/dev/null)

  if [ "$actual_name" = "$expected_name" ]; then
    assert_true "skills/$skill_name/SKILL.md name='$expected_name'" "1"
  else
    assert_true \
      "skills/$skill_name/SKILL.md name='$expected_name'" \
      "0" \
      "Found: '$actual_name'. Fix frontmatter 'name:' field."
  fi
done

# ─── Category H: vela-engine.js commands ↔ cli-reference.md ─
# Every command registered in the engine's command router must
# appear by name in the CLI reference documentation.
echo ""
echo "📋 Category H: vela-engine commands documented in cli-reference.md"

# Extract command names from the `const commands = { ... }` block.
# Lines look like: `  init: cmdInit,` or `  "clean-scan": cmdCleanScan,`
ENGINE_COMMANDS=$(awk '
  /^const commands = {/ {in_block=1; next}
  in_block && /^};/ {exit}
  in_block && /:/ {
    # Extract key: strip quotes and trailing colon
    sub(/^[ \t]*/, "")
    key = $1
    sub(/:.*/, "", key)
    gsub(/["'\'']/, "", key)
    if (key != "") print key
  }
' "$ENGINE_JS")

for cmd in $ENGINE_COMMANDS; do
  if grep -Eq "(^|[^A-Za-z0-9_-])${cmd}([^A-Za-z0-9_-]|$)" "$CLI_REFERENCE" 2>/dev/null; then
    assert_true "cli-reference.md mentions '$cmd' command" "1"
  else
    assert_true \
      "cli-reference.md mentions '$cmd' command" \
      "0" \
      "Add a 'vela-engine $cmd' example to references/cli-reference.md"
  fi
done

# ─── Category I: checkExitGate cases ↔ gates-and-guards.md ─
# Every exit-gate case in the engine must be documented in the
# gates-and-guards reference. Catches adding a new gate to the
# engine without updating the doc table.
echo ""
echo "📋 Category I: checkExitGate cases documented in gates-and-guards.md"

# Extract `case "xxx":` strings from inside checkExitGate()
GATE_CASES=$(awk '
  /function checkExitGate\(/ {in_fn=1}
  in_fn && /^}/ {if (brace_depth == 0) exit}
  in_fn {
    n_open = gsub(/{/, "{")
    n_close = gsub(/}/, "}")
    brace_depth += n_open - n_close
  }
  in_fn && /case "/ {
    sub(/.*case "/, "")
    sub(/".*/, "")
    print
  }
' "$ENGINE_JS" | sort -u)

for gate in $GATE_CASES; do
  # Skip legacy backward-compat aliases
  case "$gate" in
    leader_approved|leader_review_exists|mode_detected|init_complete|git_clean) continue ;;
  esac
  if grep -Eq "\`?${gate}\`?" "$GATES_GUARDS" 2>/dev/null; then
    assert_true "gates-and-guards.md documents gate '$gate'" "1"
  else
    assert_true \
      "gates-and-guards.md documents gate '$gate'" \
      "0" \
      "Add '$gate' row to the engine exit gate table in references/gates-and-guards.md"
  fi
done

# ─── Category J: agent frontmatter name ↔ filename ────────
# scripts/agents/vela-*.md files must have `name: vela-{stem}`
# matching their filename. Mismatch means Claude Code's subagent
# matcher can't find the agent.
echo ""
echo "📋 Category J: Agent file frontmatter 'name:' matches filename"

for agent_file in "$AGENTS_DIR"/vela-*.md; do
  [ -f "$agent_file" ] || continue
  basename_noext=$(basename "$agent_file" .md)

  # Extract name field (unquoted, no leading/trailing whitespace)
  actual_name=$(awk '/^---$/{f++; next} f==1 && /^name:/ {sub(/^name:[ \t]*/, ""); gsub(/^["'\'']|["'\'']$/, ""); print; exit}' "$agent_file" 2>/dev/null)

  if [ "$actual_name" = "$basename_noext" ]; then
    assert_true "$basename_noext.md frontmatter name='$basename_noext'" "1"
  else
    assert_true \
      "$basename_noext.md frontmatter name='$basename_noext'" \
      "0" \
      "Found: '$actual_name'. Fix frontmatter 'name:' field."
  fi
done

# ─── Category K: install.js FILE_MANIFEST ↔ filesystem ───
# Every src path declared in FILE_MANIFEST must exist on disk.
# A dangling entry silently fails at install time (skipped with
# errno logging).
echo ""
echo "📋 Category K: install.js FILE_MANIFEST entries exist on disk"

MANIFEST_SRCS=$(node -e "
  const fs = require('fs');
  const src = fs.readFileSync('$INSTALL_JS', 'utf8');
  // Heuristic: scan for lines like { src: 'path/to/file', dst: '...' }
  const re = /src:\s*['\"]([^'\"]+)['\"]/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(src))) {
    seen.add(m[1]);
  }
  process.stdout.write(Array.from(seen).sort().join('\n'));
")

while IFS= read -r rel_path; do
  [ -z "$rel_path" ] && continue
  if [ -e "$REPO_ROOT/$rel_path" ]; then
    assert_true "FILE_MANIFEST src exists: $rel_path" "1"
  else
    assert_true \
      "FILE_MANIFEST src exists: $rel_path" \
      "0" \
      "install.js references a missing file. Remove the entry or add the file."
  fi
done <<< "$MANIFEST_SRCS"

# ─── Category L: deploy-common.sh shared coverage ────────
# sync_local_project() in deploy-common.sh copies scripts/shared/*.js
# to .vela/shared/. If it uses a hardcoded list instead of a glob,
# new modules added to scripts/shared/ might be silently dropped.
# We verify by checking that deploy-common.sh either globs shared/
# (cp "$SRC/scripts/shared/"*.js) OR explicitly names every file.
echo ""
echo "📋 Category L: deploy-common.sh deploys every scripts/shared/*.js"

SHARED_FILES=$(find "$REPO_ROOT/scripts/shared" -maxdepth 1 -name "*.js" -type f -exec basename {} \; 2>/dev/null)

# Check if the deploy script uses a glob
if grep -Eq "scripts/shared/[\"']?\*\.js" "$DEPLOY_COMMON" 2>/dev/null; then
  assert_true "deploy-common.sh uses scripts/shared/*.js glob" "1"
else
  # No glob — verify each file is referenced by name
  for f in $SHARED_FILES; do
    if grep -Fq "$f" "$DEPLOY_COMMON" 2>/dev/null; then
      assert_true "deploy-common.sh references scripts/shared/$f" "1"
    else
      assert_true \
        "deploy-common.sh references scripts/shared/$f" \
        "0" \
        "Add $f to sync_local_project() or switch to a glob"
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
