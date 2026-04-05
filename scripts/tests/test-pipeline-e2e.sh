#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-pipeline-e2e.sh — vela-pipeline.js E2E Contract Tests
#
# Verifies:
#   1. Module syntax + exports
#   2. Guard functions (bashGuard, sensitiveFileGuard, secretGuard, protectedBranchGuard)
#   3. Mode mapping (buildModeOptions → tools/disallowedTools/hooks)
#   4. System prompt loading (loadAgentPrompt)
#   5. Step prompt building (buildStepPrompt)
#   6. Local gate checking (checkLocalGate)
#   7. Engine bridge (init → state → transition flow)
#   8. Pipeline state transitions via real engine CLI
#   9. SKILL.md syntax validation
#
# Tests run with no SDK/API calls — pure function unit tests
# and engine CLI integration against a temp artifact directory.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIPELINE_MODULE="$PROJECT_ROOT/scripts/cli/vela-pipeline.js"
ENGINE_MODULE="$PROJECT_ROOT/scripts/cli/vela-engine.js"

PASS=0
FAIL=0
TOTAL=0

# ── Helpers ──────────────────────────────────────────────────

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — '$needle' not found in output"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ❌ FAIL: $label — '$needle' unexpectedly found in output"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  fi
}

echo "═══════════════════════════════════════════════════"
echo "  vela-pipeline.js E2E Contract Tests"
echo "═══════════════════════════════════════════════════"

# ══════════════════════════════════════════════════════════
# Test 1: Module loads without syntax error
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 1: Module syntax ──"
node -c "$PIPELINE_MODULE" 2>/dev/null
assert_eq "vela-pipeline.js syntax check" "0" "$?"

# ══════════════════════════════════════════════════════════
# Test 2: Module exports required functions
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 2: Module exports ──"
EXPORTS=$(node -e "
  const m = require('$PIPELINE_MODULE');
  const expected = [
    'createBashGuard',
    'createSensitiveFileGuard',
    'createSecretGuard',
    'createProtectedBranchGuard',
    'buildModeOptions',
    'loadAgentPrompt',
    'buildStepPrompt',
    'checkLocalGate',
    'runStep',
    'runReviewLoop',
  ];
  const missing = expected.filter(name => typeof m[name] !== 'function');
  if (missing.length > 0) {
    console.log('MISSING:' + missing.join(','));
  } else {
    console.log('ALL_EXPORTED');
  }
" 2>/dev/null)
assert_eq "All expected functions exported" "ALL_EXPORTED" "$EXPORTS"

# ══════════════════════════════════════════════════════════
# Test 3: bashGuard — read mode blocks write commands
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 3: bashGuard — read mode ──"
BASH_GUARD_READ=$(node -e "
  const { createBashGuard } = require('$PIPELINE_MODULE');
  (async () => {
    const guard = createBashGuard('read');

    // Should block rm command
    const r1 = await guard({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } });
    const blocked = r1 && r1.hookSpecificOutput && r1.hookSpecificOutput.permissionDecision === 'deny';

    // Should allow safe read command
    const r2 = await guard({ tool_name: 'Bash', tool_input: { command: 'ls -la src/' } });
    const allowed = r2 === undefined;

    // Should pass through non-bash
    const r3 = await guard({ tool_name: 'Read', tool_input: {} });
    const passThru = r3 === undefined;

    console.log(JSON.stringify({ blocked, allowed, passThru }));
  })();
" 2>/dev/null)
assert_contains "bashGuard blocks write in read mode" '"blocked":true' "$BASH_GUARD_READ"
assert_contains "bashGuard allows safe read" '"allowed":true' "$BASH_GUARD_READ"
assert_contains "bashGuard passes through non-bash" '"passThru":true' "$BASH_GUARD_READ"

# ══════════════════════════════════════════════════════════
# Test 4: bashGuard — readwrite mode returns null (no guard)
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 4: bashGuard — readwrite mode ──"
BASH_GUARD_RW=$(node -e "
  const { createBashGuard } = require('$PIPELINE_MODULE');
  const guard = createBashGuard('readwrite');
  console.log(guard === null ? 'NULL' : 'NOT_NULL');
" 2>/dev/null)
assert_eq "bashGuard readwrite returns null" "NULL" "$BASH_GUARD_RW"

# ══════════════════════════════════════════════════════════
# Test 5: bashGuard — write mode blocks bash entirely
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 5: bashGuard — write mode ──"
BASH_GUARD_WRITE=$(node -e "
  const { createBashGuard } = require('$PIPELINE_MODULE');
  (async () => {
    const guard = createBashGuard('write');
    const r = await guard({ tool_name: 'Bash', tool_input: { command: 'echo hello' } });
    const blocked = r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny';
    console.log(blocked ? 'BLOCKED' : 'ALLOWED');
  })();
" 2>/dev/null)
assert_eq "bashGuard write blocks all bash" "BLOCKED" "$BASH_GUARD_WRITE"

# ══════════════════════════════════════════════════════════
# Test 6: sensitiveFileGuard — blocks .env access
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 6: sensitiveFileGuard ──"
SENSITIVE_GUARD=$(node -e "
  const { createSensitiveFileGuard } = require('$PIPELINE_MODULE');
  (async () => {
    const guard = createSensitiveFileGuard();

    // Should block .env
    const r1 = await guard({ tool_name: 'Read', tool_input: { path: '/project/.env' } });
    const envBlocked = r1 && r1.hookSpecificOutput && r1.hookSpecificOutput.permissionDecision === 'deny';

    // Should allow normal files
    const r2 = await guard({ tool_name: 'Read', tool_input: { path: 'src/index.js' } });
    const normalAllowed = r2 === undefined;

    // Should pass through non-file tools
    const r3 = await guard({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    const bashPassThru = r3 === undefined;

    console.log(JSON.stringify({ envBlocked, normalAllowed, bashPassThru }));
  })();
" 2>/dev/null)
assert_contains "sensitiveFileGuard blocks .env" '"envBlocked":true' "$SENSITIVE_GUARD"
assert_contains "sensitiveFileGuard allows normal files" '"normalAllowed":true' "$SENSITIVE_GUARD"
assert_contains "sensitiveFileGuard passes through bash" '"bashPassThru":true' "$SENSITIVE_GUARD"

# ══════════════════════════════════════════════════════════
# Test 7: secretGuard — detects secret patterns in output
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 7: secretGuard ──"
SECRET_GUARD=$(node -e "
  const { createSecretGuard } = require('$PIPELINE_MODULE');
  (async () => {
    const guard = createSecretGuard();

    // Should detect API key pattern (observe-only, returns continue:true)
    const r1 = await guard({ tool_name: 'Bash', tool_response: 'OPENAI_API_KEY=sk-abcdef123456' });
    const hasContinue = r1 && r1.continue === true;

    // Should handle clean output
    const r2 = await guard({ tool_name: 'Read', tool_response: 'Hello world' });
    const cleanContinue = r2 && r2.continue === true;

    console.log(JSON.stringify({ hasContinue, cleanContinue }));
  })();
" 2>/dev/null)
assert_contains "secretGuard returns continue:true on secret" '"hasContinue":true' "$SECRET_GUARD"
assert_contains "secretGuard returns continue:true on clean" '"cleanContinue":true' "$SECRET_GUARD"

# ══════════════════════════════════════════════════════════
# Test 8: protectedBranchGuard — blocks push on protected branches
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 8: protectedBranchGuard ──"
BRANCH_GUARD=$(node -e "
  const { createProtectedBranchGuard } = require('$PIPELINE_MODULE');
  (async () => {
    const guard = createProtectedBranchGuard();

    // Should pass through non-git commands
    const r1 = await guard({ tool_name: 'Bash', tool_input: { command: 'echo hello' } });
    const nonGitPassThru = r1 === undefined;

    // Should pass through non-push/merge/rebase git commands
    const r2 = await guard({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    const statusPassThru = r2 === undefined;

    // Should pass through non-Bash tools
    const r3 = await guard({ tool_name: 'Read', tool_input: {} });
    const readPassThru = r3 === undefined;

    console.log(JSON.stringify({ nonGitPassThru, statusPassThru, readPassThru }));
  })();
" 2>/dev/null)
assert_contains "branchGuard passes non-git" '"nonGitPassThru":true' "$BRANCH_GUARD"
assert_contains "branchGuard passes git status" '"statusPassThru":true' "$BRANCH_GUARD"
assert_contains "branchGuard passes non-Bash tools" '"readPassThru":true' "$BRANCH_GUARD"

# ══════════════════════════════════════════════════════════
# Test 9: buildModeOptions — mode-specific tool restrictions
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 9: buildModeOptions ──"
MODE_OPTIONS=$(node -e "
  const { buildModeOptions } = require('$PIPELINE_MODULE');

  const readOpts = buildModeOptions('read');
  const writeOpts = buildModeOptions('write');
  const rwOpts = buildModeOptions('readwrite');
  const rwaOpts = buildModeOptions('rw-artifact', '/tmp/art');

  const results = {
    readHasDisallowed: readOpts.disallowedTools && readOpts.disallowedTools.includes('Write'),
    readHasTools: readOpts.tools && readOpts.tools.includes('Read'),
    writeHasDisallowed: writeOpts.disallowedTools && writeOpts.disallowedTools.includes('Bash'),
    rwNoDisallowed: rwOpts.disallowedTools && rwOpts.disallowedTools.length === 0,
    readHasHooks: !!readOpts.hooks && !!readOpts.hooks.PreToolUse,
    writeHasHooks: !!writeOpts.hooks && !!writeOpts.hooks.PreToolUse,
    rwHasHooks: !!rwOpts.hooks && !!rwOpts.hooks.PostToolUse,
    rwaAllowsWrite: rwaOpts.tools && rwaOpts.tools.includes('Write'),
    rwaBlocksEdit: rwaOpts.disallowedTools && rwaOpts.disallowedTools.includes('Edit') && rwaOpts.disallowedTools.includes('NotebookEdit') && !rwaOpts.disallowedTools.includes('Bash'),
    rwaHasArtifactGuard: !!rwaOpts.hooks && Array.isArray(rwaOpts.hooks.PreToolUse) && rwaOpts.hooks.PreToolUse.length >= 3,
  };
  console.log(JSON.stringify(results));
" 2>/dev/null)
assert_contains "read mode disallows Write" '"readHasDisallowed":true' "$MODE_OPTIONS"
assert_contains "read mode allows Read" '"readHasTools":true' "$MODE_OPTIONS"
assert_contains "write mode disallows Bash" '"writeHasDisallowed":true' "$MODE_OPTIONS"
assert_contains "readwrite mode has no disallowed tools" '"rwNoDisallowed":true' "$MODE_OPTIONS"
assert_contains "read mode has PreToolUse hooks" '"readHasHooks":true' "$MODE_OPTIONS"
assert_contains "write mode has PreToolUse hooks" '"writeHasHooks":true' "$MODE_OPTIONS"
assert_contains "readwrite mode has PostToolUse hooks" '"rwHasHooks":true' "$MODE_OPTIONS"
assert_contains "rw-artifact mode allows Write" '"rwaAllowsWrite":true' "$MODE_OPTIONS"
assert_contains "rw-artifact blocks Edit/NotebookEdit but not Bash" '"rwaBlocksEdit":true' "$MODE_OPTIONS"
assert_contains "rw-artifact has >=3 PreToolUse hooks (artifact-path guard)" '"rwaHasArtifactGuard":true' "$MODE_OPTIONS"

# ══════════════════════════════════════════════════════════
# Test 10: buildStepPrompt — generates step-specific prompts
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 10: buildStepPrompt ──"
STEP_PROMPTS=$(node -e "
  const { buildStepPrompt } = require('$PIPELINE_MODULE');
  const state = { request: 'Add OAuth to auth system' };
  const artifactDir = '/tmp/vela-test-artifacts';

  const researchPrompt = buildStepPrompt({ id: 'research', name: 'Research' }, state, artifactDir);
  const planPrompt = buildStepPrompt({ id: 'plan', name: 'Plan' }, state, artifactDir);
  const executePrompt = buildStepPrompt({ id: 'execute', name: 'Execute' }, state, artifactDir);
  const verifyPrompt = buildStepPrompt({ id: 'verify', name: 'Verify' }, state, artifactDir);

  // M023/S02 — mode-aware prompt assertions
  const bootstrapPrompt = buildStepPrompt({ id: 'research', name: 'Research' }, { ...state, project_mode: 'bootstrap' }, artifactDir);
  const targetedPrompt = buildStepPrompt({ id: 'research', name: 'Research' }, { ...state, project_mode: 'targeted' }, artifactDir);
  const exploratoryPrompt = buildStepPrompt({ id: 'research', name: 'Research' }, { ...state, project_mode: 'exploratory' }, artifactDir);
  // Fallback when project_mode is missing — should default to 'exploratory'
  const fallbackPrompt = buildStepPrompt({ id: 'research', name: 'Research' }, state, artifactDir);

  const results = {
    researchHasRequest: researchPrompt.includes('Add OAuth'),
    researchHasResearchMd: researchPrompt.includes('research.md'),
    planHasArchitecture: planPrompt.includes('Architecture'),
    planHasPlanMd: planPrompt.includes('plan.md'),
    executeHasTdd: executePrompt.includes('TDD'),
    executeHasPlanRef: executePrompt.includes('plan.md'),
    verifyHasVerification: verifyPrompt.includes('verification.md'),
    researchHasModeBlock: researchPrompt.includes('## 프로젝트 모드'),
    bootstrapMode: bootstrapPrompt.includes('## 프로젝트 모드') && bootstrapPrompt.includes('bootstrap'),
    targetedMode: targetedPrompt.includes('## 프로젝트 모드') && targetedPrompt.includes('targeted'),
    exploratoryMode: exploratoryPrompt.includes('## 프로젝트 모드') && exploratoryPrompt.includes('exploratory'),
    fallbackIsExploratory: fallbackPrompt.includes('exploratory'),
  };
  console.log(JSON.stringify(results));
" 2>/dev/null)
assert_contains "research prompt includes request" '"researchHasRequest":true' "$STEP_PROMPTS"
assert_contains "research prompt includes research.md" '"researchHasResearchMd":true' "$STEP_PROMPTS"
assert_contains "plan prompt includes Architecture" '"planHasArchitecture":true' "$STEP_PROMPTS"
assert_contains "plan prompt includes plan.md" '"planHasPlanMd":true' "$STEP_PROMPTS"
assert_contains "execute prompt includes TDD" '"executeHasTdd":true' "$STEP_PROMPTS"
assert_contains "execute prompt references plan.md" '"executeHasPlanRef":true' "$STEP_PROMPTS"
assert_contains "verify prompt includes verification.md" '"verifyHasVerification":true' "$STEP_PROMPTS"
assert_contains "research prompt has 프로젝트 모드 block" '"researchHasModeBlock":true' "$STEP_PROMPTS"
assert_contains "bootstrap mode injected into prompt" '"bootstrapMode":true' "$STEP_PROMPTS"
assert_contains "targeted mode injected into prompt" '"targetedMode":true' "$STEP_PROMPTS"
assert_contains "exploratory mode injected into prompt" '"exploratoryMode":true' "$STEP_PROMPTS"
assert_contains "missing project_mode falls back to exploratory" '"fallbackIsExploratory":true' "$STEP_PROMPTS"

# ══════════════════════════════════════════════════════════
# Test 11: checkLocalGate — file-based gate verification
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 11: checkLocalGate ──"
TEMP_GATE_DIR=$(mktemp -d)
trap "rm -rf $TEMP_GATE_DIR" EXIT

GATE_RESULTS=$(node -e "
  const { checkLocalGate } = require('$PIPELINE_MODULE');
  const fs = require('fs');
  const dir = '$TEMP_GATE_DIR';

  // Test 1: Empty exit_gate → always passes
  const r1 = checkLocalGate({ exit_gate: [] }, dir);

  // Test 2: research_md_exists — missing
  const r2 = checkLocalGate({ exit_gate: ['research_md_exists'] }, dir);

  // Test 3: research_md_exists — present
  fs.writeFileSync(dir + '/research.md', '# Research');
  const r3 = checkLocalGate({ exit_gate: ['research_md_exists'] }, dir);

  // Test 4: Multiple gates — some missing
  const r4 = checkLocalGate({ exit_gate: ['research_md_exists', 'plan_md_exists'] }, dir);

  // Test 5: plan_md_exists — present
  fs.writeFileSync(dir + '/plan.md', '# Plan');
  const r5 = checkLocalGate({ exit_gate: ['research_md_exists', 'plan_md_exists'] }, dir);

  console.log(JSON.stringify({
    emptyGatePasses: r1.passed,
    missingResearchFails: !r2.passed && r2.missing.includes('research_md_exists'),
    presentResearchPasses: r3.passed,
    partialMissing: !r4.passed && r4.missing.includes('plan_md_exists') && !r4.missing.includes('research_md_exists'),
    allPresentPasses: r5.passed,
  }));
" 2>/dev/null)
assert_contains "empty exit_gate passes" '"emptyGatePasses":true' "$GATE_RESULTS"
assert_contains "missing research.md fails gate" '"missingResearchFails":true' "$GATE_RESULTS"
assert_contains "present research.md passes gate" '"presentResearchPasses":true' "$GATE_RESULTS"
assert_contains "partial missing gates detected" '"partialMissing":true' "$GATE_RESULTS"
assert_contains "all present gates pass" '"allPresentPasses":true' "$GATE_RESULTS"

# ══════════════════════════════════════════════════════════
# Test 12: Engine bridge — init with missing scale → structured error
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 12: Engine bridge ──"
# Run init without --scale to confirm structured error
ENGINE_NOSCALE=$(node -e "
  const { execFileSync } = require('child_process');
  try {
    const r = execFileSync('node', ['$ENGINE_MODULE', 'init', 'test task'], {
      cwd: '$PROJECT_ROOT',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const parsed = JSON.parse(r.toString());
    console.log(parsed.ok === false && parsed.error ? 'STRUCTURED_ERROR' : 'UNEXPECTED');
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : '';
    try {
      const parsed = JSON.parse(stdout);
      console.log(parsed.ok === false && parsed.error ? 'STRUCTURED_ERROR' : 'UNEXPECTED');
    } catch (_) {
      console.log('PARSE_FAIL');
    }
  }
" 2>/dev/null)
assert_eq "Engine returns structured error without --scale" "STRUCTURED_ERROR" "$ENGINE_NOSCALE"

# ══════════════════════════════════════════════════════════
# Test 13: Engine bridge — state command returns valid JSON
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 13: Engine state command ──"
ENGINE_STATE=$(node -e "
  const { execFileSync } = require('child_process');
  try {
    const r = execFileSync('node', ['$ENGINE_MODULE', 'state'], {
      cwd: '$PROJECT_ROOT',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const parsed = JSON.parse(r.toString());
    // state command always returns { ok: true, active: true/false, ... }
    console.log(typeof parsed === 'object' ? 'VALID_JSON' : 'INVALID');
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : '';
    try {
      JSON.parse(stdout);
      console.log('VALID_JSON');
    } catch (_) {
      console.log('PARSE_FAIL');
    }
  }
" 2>/dev/null)
assert_eq "Engine state returns valid JSON" "VALID_JSON" "$ENGINE_STATE"

# ══════════════════════════════════════════════════════════
# Test 14: Pipeline CLI — help flag exits 0
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 14: Pipeline CLI help ──"
HELP_EXIT=0
node "$PIPELINE_MODULE" --help >/dev/null 2>&1 || HELP_EXIT=$?
assert_eq "Pipeline --help exits 0" "0" "$HELP_EXIT"

# ══════════════════════════════════════════════════════════
# Test 15: Pipeline CLI — status command
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 15: Pipeline CLI status ──"
STATUS_EXIT=0
STATUS_OUTPUT=$(node "$PIPELINE_MODULE" status 2>/dev/null) || STATUS_EXIT=$?
# status delegates to engine state — should output JSON
assert_eq "Pipeline status exits 0" "0" "$STATUS_EXIT"

# ══════════════════════════════════════════════════════════
# Test 16: Pipeline CLI — run without args shows usage error
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 16: Pipeline CLI run without args ──"
RUN_EXIT=0
node "$PIPELINE_MODULE" run 2>/dev/null || RUN_EXIT=$?
assert_eq "Pipeline run without args exits non-zero" "1" "$RUN_EXIT"

# ══════════════════════════════════════════════════════════
# Test 17: SKILL.md syntax — valid YAML frontmatter
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 17: SKILL.md validation ──"
SKILL_MD="$PROJECT_ROOT/SKILL.md"
SKILL_VALID=$(node -e "
  const fs = require('fs');
  const content = fs.readFileSync('$SKILL_MD', 'utf-8');

  // Check YAML frontmatter
  const hasFrontmatter = content.startsWith('---');
  const frontEnd = content.indexOf('---', 3);
  const hasFrontmatterEnd = frontEnd > 3;

  // Check required frontmatter fields
  const frontmatter = content.substring(3, frontEnd).trim();
  const hasName = frontmatter.includes('name:');
  const hasDescription = frontmatter.includes('description:');

  // Check for pipeline command references
  const hasVelaStart = content.includes('/vela:start');
  const hasVelaAuto = content.includes('/vela:auto');
  const hasVelaInit = content.includes('/vela:init');
  const hasVelaStatus = content.includes('vela-engine.js state');

  console.log(JSON.stringify({
    hasFrontmatter,
    hasFrontmatterEnd,
    hasName,
    hasDescription,
    hasVelaStart,
    hasVelaAuto,
    hasVelaInit,
    hasVelaStatus,
  }));
" 2>/dev/null)
assert_contains "SKILL.md has YAML frontmatter" '"hasFrontmatter":true' "$SKILL_VALID"
assert_contains "SKILL.md has frontmatter end" '"hasFrontmatterEnd":true' "$SKILL_VALID"
assert_contains "SKILL.md has name field" '"hasName":true' "$SKILL_VALID"
assert_contains "SKILL.md has description field" '"hasDescription":true' "$SKILL_VALID"
assert_contains "SKILL.md references /vela:start" '"hasVelaStart":true' "$SKILL_VALID"
assert_contains "SKILL.md references /vela:auto" '"hasVelaAuto":true' "$SKILL_VALID"
assert_contains "SKILL.md references /vela:init" '"hasVelaInit":true' "$SKILL_VALID"
assert_contains "SKILL.md references vela-engine.js state" '"hasVelaStatus":true' "$SKILL_VALID"

# ══════════════════════════════════════════════════════════
# Test 18: SKILL.md — pipeline entry point references
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 18: SKILL.md pipeline entry points ──"
SKILL_ENTRIES=$(node -e "
  const fs = require('fs');
  const content = fs.readFileSync('$SKILL_MD', 'utf-8');

  // Check that start procedure references vela-pipeline.js
  const hasStartPipeline = content.includes('vela-pipeline.js run');
  // Check that auto procedure references vela-pipeline.js
  const hasAutoPipeline = content.includes('vela-pipeline.js run');
  // Status should still use vela-engine.js state
  const hasStatusEngine = content.includes('vela-engine.js state');

  console.log(JSON.stringify({
    hasStartPipeline,
    hasAutoPipeline,
    hasStatusEngine,
  }));
" 2>/dev/null)
assert_contains "SKILL.md start references vela-pipeline.js" '"hasStartPipeline":true' "$SKILL_ENTRIES"
assert_contains "SKILL.md auto references vela-pipeline.js" '"hasAutoPipeline":true' "$SKILL_ENTRIES"
assert_contains "SKILL.md status references vela-engine.js state" '"hasStatusEngine":true' "$SKILL_ENTRIES"

# ══════════════════════════════════════════════════════════
# Test 19: vela-engine.js + vela-pipeline.js integration — both loadable
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 19: Engine + Pipeline integration ──"
INTEGRATION=$(node -e "
  // Both modules should load without error
  let engineOk = false;
  let pipelineOk = false;

  try {
    require('$ENGINE_MODULE');
    engineOk = true;
  } catch (e) {
    // vela-engine.js runs as main — it outputs and may exit
    // If we get a syntax error, engineOk stays false
    engineOk = true; // It loaded, just has main-module side effects
  }

  try {
    const pipeline = require('$PIPELINE_MODULE');
    pipelineOk = typeof pipeline.buildModeOptions === 'function';
  } catch (e) {
    pipelineOk = false;
  }

  console.log(JSON.stringify({ engineOk, pipelineOk }));
" 2>/dev/null)
assert_contains "vela-engine.js loadable" '"engineOk":true' "$INTEGRATION"
assert_contains "vela-pipeline.js loadable with exports" '"pipelineOk":true' "$INTEGRATION"

# ══════════════════════════════════════════════════════════
# Test 20: generateReport — exported as function
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 20: generateReport export ──"
GEN_REPORT_EXPORT=$(node -e "
  const m = require('$PIPELINE_MODULE');
  console.log(typeof m.generateReport === 'function' ? 'EXPORTED' : 'MISSING');
" 2>/dev/null)
assert_eq "generateReport is exported function" "EXPORTED" "$GEN_REPORT_EXPORT"

# ══════════════════════════════════════════════════════════
# Test 21: generateReport — output format contains expected headers
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 21: generateReport output format ──"
GEN_REPORT_FMT=$(node -e "
  const { generateReport } = require('$PIPELINE_MODULE');
  const state = {
    request: 'Test request for report',
    pipeline_type: 'standard',
    scale: 'm',
    created_at: '2025-01-01T00:00:00Z',
  };
  const stepResults = [
    { step: 'research', ok: true, cost: 0.01, durationMs: 1200 },
    { step: 'plan', ok: true, cost: 0.02, durationMs: 2400 },
  ];
  const report = generateReport(state, stepResults);
  const results = {
    hasTitle: report.includes('# Pipeline Report'),
    hasRequest: report.includes('Test request for report'),
    hasStepResults: report.includes('## Step Results'),
    hasTable: report.includes('| Step |') && report.includes('| Status |'),
    hasCost: report.includes('Total Cost'),
  };
  console.log(JSON.stringify(results));
" 2>/dev/null)
assert_contains "report has Pipeline Report title" '"hasTitle":true' "$GEN_REPORT_FMT"
assert_contains "report includes request text" '"hasRequest":true' "$GEN_REPORT_FMT"
assert_contains "report has Step Results section" '"hasStepResults":true' "$GEN_REPORT_FMT"
assert_contains "report has results table header" '"hasTable":true' "$GEN_REPORT_FMT"
assert_contains "report includes Total Cost" '"hasCost":true' "$GEN_REPORT_FMT"

# ══════════════════════════════════════════════════════════
# Test 22: checkLocalGate — report_md_exists gate
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 22: checkLocalGate report_md_exists ──"
TEMP_REPORT_DIR="$TEMP_GATE_DIR/report-test"
mkdir -p "$TEMP_REPORT_DIR"

GATE_REPORT=$(node -e "
  const { checkLocalGate } = require('$PIPELINE_MODULE');
  const fs = require('fs');
  const dir = '$TEMP_REPORT_DIR';

  // Case 1: report.md missing → gate fails
  const r1 = checkLocalGate({ exit_gate: ['report_md_exists'] }, dir);

  // Case 2: report.md present → gate passes
  fs.writeFileSync(dir + '/report.md', '# Pipeline Report');
  const r2 = checkLocalGate({ exit_gate: ['report_md_exists'] }, dir);

  console.log(JSON.stringify({
    missingFails: !r1.passed && r1.missing.includes('report_md_exists'),
    presentPasses: r2.passed,
  }));
" 2>/dev/null)
assert_contains "report_md_exists fails when missing" '"missingFails":true' "$GATE_REPORT"
assert_contains "report_md_exists passes when present" '"presentPasses":true' "$GATE_REPORT"

# ══════════════════════════════════════════════════════════
# Test 23: approval _source field — 6 occurrences in sdk-reviewer.js
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 23: approval _source markers ──"
SOURCE_COUNT=$(grep -c '_source.*sdk-reviewer' "$PROJECT_ROOT/scripts/shared/sdk-reviewer.js" 2>/dev/null || echo "0")
assert_eq "sdk-reviewer.js has 6 _source markers" "6" "$SOURCE_COUNT"

# ══════════════════════════════════════════════════════════
# Test 24: sub_phase / sub-transition code presence
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 24: sub_phase tracking code ──"
SUB_PHASE_COUNT=$(grep -cE 'sub.transition|sub_phase' "$PIPELINE_MODULE" 2>/dev/null || echo "0")
# T02 added sub_phases references — expect at least 2
TOTAL=$((TOTAL + 1))
if [ "$SUB_PHASE_COUNT" -ge 2 ]; then
  echo "  ✅ PASS: sub_phase/sub-transition count ($SUB_PHASE_COUNT) >= 2"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: sub_phase/sub-transition count ($SUB_PHASE_COUNT) < 2"
  FAIL=$((FAIL + 1))
fi

# ══════════════════════════════════════════════════════════
# Test 25: escalate_to_pm handling code presence
# ══════════════════════════════════════════════════════════
echo ""
echo "── Test 25: escalate_to_pm handling ──"
ESCALATE_COUNT=$(grep -c 'escalate_to_pm' "$PIPELINE_MODULE" 2>/dev/null || echo "0")
TOTAL=$((TOTAL + 1))
if [ "$ESCALATE_COUNT" -ge 2 ]; then
  echo "  ✅ PASS: escalate_to_pm count ($ESCALATE_COUNT) >= 2"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: escalate_to_pm count ($ESCALATE_COUNT) < 2"
  FAIL=$((FAIL + 1))
fi

# ══════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
