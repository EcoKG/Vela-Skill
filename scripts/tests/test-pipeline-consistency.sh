#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-pipeline-consistency.sh — templates/pipeline.json invariants
#
# Validates structural invariants between pipeline.json steps and the
# modes section, so that mode/artifacts contradictions (M023/S01) stay
# fixed going forward.
#
# Invariants checked:
#   (a) Every step.mode resolves to a key defined in pipeline.modes.
#   (b) No (actor=agent, mode=read, artifacts.length>0) combination —
#       SDK agents can't write artifacts under read mode.
#   (c) No (mode=write, step.id=verify) combination — write mode blocks
#       Bash (needed to run tests) and verify must execute commands.
#
# On violation: prints a structured violations array to stderr and
# exits 1. On success: prints "OK" to stdout and exits 0.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIPELINE_JSON="$PROJECT_ROOT/templates/pipeline.json"

if [ ! -f "$PIPELINE_JSON" ]; then
  echo "ERROR: pipeline.json not found at $PIPELINE_JSON" >&2
  exit 2
fi

echo "═══════════════════════════════════════════════════"
echo "  pipeline.json consistency checks"
echo "═══════════════════════════════════════════════════"

node -e "
  const fs = require('fs');
  const path = '$PIPELINE_JSON';
  const pj = JSON.parse(fs.readFileSync(path, 'utf8'));

  const definedModes = Object.keys(pj.modes || {});
  const violations = [];

  // Known-deferred violations (documented exceptions). Each entry gives the
  // rule, location, and the slice/issue where it will be addressed.
  //
  // plan-check declares actor=agent/mode=read/artifacts=[plan-check.md] in
  // pipeline.json, but plan-check.md is actually written by vela-engine.js
  // cmdPlanCheck (pm-invoked CLI command using SDK internally). T01/T02 of
  // M023/S01 scoped this out as a deferred defect — the right fix is to
  // either flip actor to 'pm' or wire vela-pipeline.js to call
  // engine('plan-check') for this step. Tracked for a future slice.
  const knownDeferred = [
    { rule: 'agent_read_with_artifacts', step: 'standard:plan-check' },
  ];
  const isDeferred = (v) => knownDeferred.some(
    (k) => k.rule === v.rule && k.step === v.step,
  );

  // Walk every step across every pipeline definition.
  for (const [pipelineId, pipeline] of Object.entries(pj.pipelines || {})) {
    const steps = pipeline.steps || [];
    for (const step of steps) {
      const loc = pipelineId + ':' + (step.id || '(unknown)');
      const mode = step.mode;
      const actor = step.actor;
      const artifacts = Array.isArray(step.artifacts) ? step.artifacts : [];

      // (a) step.mode must be defined in pipeline.modes
      if (mode && !definedModes.includes(mode)) {
        violations.push({
          rule: 'undefined_mode',
          step: loc,
          mode: mode,
          defined: definedModes,
        });
      }

      // (b) actor=agent + mode=read + artifacts>0 → contradiction
      if (actor === 'agent' && mode === 'read' && artifacts.length > 0) {
        violations.push({
          rule: 'agent_read_with_artifacts',
          step: loc,
          actor: actor,
          mode: mode,
          artifacts: artifacts,
        });
      }

      // (c) mode=write + step.id=verify → contradiction
      if (mode === 'write' && step.id === 'verify') {
        violations.push({
          rule: 'verify_in_write_mode',
          step: loc,
          mode: mode,
        });
      }
    }
  }

  // Partition violations into deferred (warning) vs fatal.
  const deferred = violations.filter(isDeferred);
  const fatal = violations.filter((v) => !isDeferred(v));

  if (deferred.length > 0) {
    process.stderr.write('⚠️  pipeline.json known-deferred violations (allowlisted):\n');
    process.stderr.write(JSON.stringify(deferred, null, 2) + '\n');
  }

  if (fatal.length > 0) {
    process.stderr.write('❌ pipeline.json consistency violations:\n');
    process.stderr.write(JSON.stringify(fatal, null, 2) + '\n');
    process.exit(1);
  }

  console.log('OK');
  process.exit(0);
"

RC=$?
if [ $RC -eq 0 ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  ✅ PASS: pipeline.json consistent"
  echo "═══════════════════════════════════════════════════"
  exit 0
else
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  ❌ FAIL: pipeline.json has consistency violations"
  echo "═══════════════════════════════════════════════════"
  exit 1
fi
