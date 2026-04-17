#!/usr/bin/env node
/**
 * Vela Engine CLI — Pipeline State Management
 *
 * The engine is the single source of truth for pipeline state.
 * All state transitions happen through this CLI, never by direct file edits.
 *
 * Commands:
 *   init <request> [--type TYPE] [--scale SIZE] [--auto]  — Start a new pipeline
 *   state                         — Show current pipeline state
 *   transition                    — Advance to the next step (with circuit-breaker reset)
 *   record <verdict>              — Record step result (pass|fail|reject); circuit-breaker on fail
 *   branch [--mode auto|prompt|none]  — Create feature branch
 *   commit [--message TEXT]       — Commit changes
 *   cancel                        — Cancel active pipeline
 *   history                       — Show pipeline history
 *   clean-scan                    — Scan git workspace (dry-run)
 *   clean-exec                    — Execute git workspace cleanup
 *
 * V6: PM orchestrates via Agent(subagent_type=...) directly.
 * Approval tracked via file artifacts (approval-{step}.json).
 *
 * All commands output JSON to stdout.
 */

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

/**
 * Walk up from `startDir` looking for the nearest ancestor that
 * contains a `.vela/` directory. Returns null if none is found — the
 * caller decides whether to fall back to cwd or error out.
 *
 * v7.0.6: introduced to rescue engine invocations launched from a
 * project subdirectory (Claude Code sessions don't always start at
 * the project root).
 */
function walkUpForVelaDir(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".vela"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolve the project root for this invocation.
 *
 * v7.0.7: Prior versions relied purely on walk-up, which is a
 * heuristic — it can pick the wrong ancestor on symlinked trees,
 * bind mounts, or nested Vela projects, and it hides the fact that
 * cwd ever drifted.
 *
 * The installer (scripts/install.js → writeWorkspaceRecord) now
 * pins the true project root in `.vela/state/workspace.json` on
 * every install/upgrade/validate. This function reads that pin,
 * validates it, and falls back to the walk-up heuristic only when
 * the pin is absent or stale:
 *
 *   1. walk up from cwd to find any `.vela/` ancestor (velaDir)
 *   2. read `<velaDir>/.vela/state/workspace.json` if present
 *   3. if the recorded projectRoot still has a `.vela/`, use it
 *   4. otherwise use the walked-up velaDir (v7.0.6 behavior)
 *   5. if there is no `.vela/` anywhere, return process.cwd()
 *      unchanged — downstream commands that actually need .vela/
 *      will surface their own clear errors.
 *
 * When the resolved root differs from process.cwd() (i.e. cwd has
 * drifted — almost always because a prior Bash tool invocation in
 * the same session ran a bare `cd subdir`), the engine emits a
 * loud stderr warning so the root cause is visible and process.chdir
 * back so git/node child processes see a consistent cwd.
 */
function resolveProjectRoot() {
  const originalCwd = process.cwd();
  const velaDir = walkUpForVelaDir(originalCwd);
  if (!velaDir) {
    // No .vela/ anywhere in the ancestor chain. Leave cwd as-is.
    return originalCwd;
  }

  // Try the pinned workspace first.
  const wsPath = path.join(velaDir, ".vela", "state", "workspace.json");
  let pinned = null;
  if (fs.existsSync(wsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(wsPath, "utf8"));
      if (raw && typeof raw.projectRoot === "string" && raw.projectRoot) {
        // A stale pin (project was `mv`d) points at a path that no
        // longer has .vela/. In that case we must NOT chdir there —
        // fall through to the walk-up result.
        if (fs.existsSync(path.join(raw.projectRoot, ".vela"))) {
          pinned = raw.projectRoot;
        } else {
          process.stderr.write(
            `⚠️  Vela: .vela/state/workspace.json points at ${raw.projectRoot} but that path no longer has .vela/ — falling back to walk-up. Re-run \`node .vela/install.js validate\` from the new project location to refresh the pin.\n`,
          );
        }
      }
    } catch {
      /* malformed workspace.json — fall back to walk-up */
    }
  }

  const resolved = pinned || velaDir;

  if (resolved !== originalCwd) {
    // Loud warning so the root cause — usually a stray `cd subdir`
    // inside a prior Bash tool invocation — gets noticed and fixed,
    // rather than being silently masked by auto-recovery.
    process.stderr.write(
      `⚠️  Vela: chdir ${originalCwd} → ${resolved} (cwd drift detected; a prior Bash tool call probably ran a bare \`cd\` — use \`( cd dir && cmd )\` subshell isolation or absolute paths instead)\n`,
    );
    try {
      process.chdir(resolved);
    } catch {
      /* chdir may fail in exotic environments — downstream path.join
         calls use the returned value directly so we still succeed */
    }
  }

  return resolved;
}

const CWD = resolveProjectRoot();
const VELA_DIR = path.join(CWD, ".vela");
const ARTIFACTS_DIR = path.join(VELA_DIR, "artifacts");
const TEMPLATES_DIR = path.join(VELA_DIR, "templates");
const PROTECTED_BRANCHES = ["main", "master", "develop"];
const CIRCUIT_BREAKER_THRESHOLD = 5;

// ─── Core helpers (v7.3-M4e engine split) ───
// Pure utilities (slugify/writeJSON/output/autoDetectScale/cleanState)
// live in ../core/cli-utils.js and have no dependency on engine state.
// Git helpers bind to CWD + PROTECTED_BRANCHES via factory so the 43
// call sites below don't have to thread cwd through every invocation.
// State I/O and pipeline resolution are split into their own modules
// so the engine file becomes navigable command definitions rather
// than a mix of helpers + commands.
const {
  slugifyEx,
  slugify,
  cleanState,
  writeJSON,
  output,
  autoDetectScale,
} = require("../core/cli-utils");
const {
  gitExec,
  gitExecShell,
  snapshotGitState,
  ensureGitignore,
} = require("../core/git-utils")(CWD, PROTECTED_BRANCHES);
const {
  findActiveState,
  cleanupCancelledArtifacts,
} = require("../core/state")(ARTIFACTS_DIR);
const {
  loadPipelineDefinition,
  resolveSteps,
  checkExitGate,
} = require("../core/pipeline")({
  templatesDir: TEMPLATES_DIR,
  velaDir: VELA_DIR,
  cwd: CWD,
});

// ─── Command Router ───
const args = process.argv.slice(2);
const command = args[0];

// ─── Command context (v7.3-M4e-p3) ───
// Shared dependency bundle passed to extracted command modules under
// scripts/commands/. Function references (getArg/getFlag/hasFlag) rely
// on JS function hoisting — their declarations at the bottom of the
// file are hoisted above this object literal at load time. All paths +
// core helpers are already resolved by the factory calls above.
const ctx = {
  // paths + constants
  CWD,
  VELA_DIR,
  ARTIFACTS_DIR,
  TEMPLATES_DIR,
  PROTECTED_BRANCHES,
  // core/cli-utils (pure)
  slugifyEx,
  slugify,
  cleanState,
  writeJSON,
  output,
  autoDetectScale,
  // core/git-utils (factory-bound)
  gitExec,
  gitExecShell,
  snapshotGitState,
  ensureGitignore,
  // core/state (factory-bound)
  findActiveState,
  cleanupCancelledArtifacts,
  // core/pipeline (factory-bound)
  loadPipelineDefinition,
  resolveSteps,
  checkExitGate,
  // engine-local arg parsers (hoisted from EOF)
  getArg,
  getFlag,
  hasFlag,
};

// Extracted commands (v7.3-M4e-p3)
const cmdInit = require("../commands/init")(ctx);
const cmdBranch = require("../commands/branch")(ctx);
const cmdCommit = require("../commands/commit")(ctx);
// Extracted commands (v7.3-M4e-p4)
const cmdLocate = require("../commands/locate")(ctx);
const cmdCancel = require("../commands/cancel")(ctx);
const cmdHistory = require("../commands/history")(ctx);
// Extracted commands (v7.3-M4e-p5)
const cmdDoctor = require("../commands/doctor")(ctx);
const { cmdCleanScan, cmdCleanExec } = require("../commands/clean")(ctx);

const commands = {
  init: cmdInit,
  state: cmdState,
  transition: cmdTransition,
  record: cmdRecord,
  advance: cmdAdvance, // v7.1 M8: record+transition one-shot
  doctor: cmdDoctor,   // v7.1 M6: health check
  branch: cmdBranch,
  commit: cmdCommit,
  cancel: cmdCancel,
  history: cmdHistory,
  locate: cmdLocate,
  "clean-scan": cmdCleanScan,
  "clean-exec": cmdCleanExec,
};

if (require.main === module) {
  if (!command || !commands[command]) {
    output({
      ok: false,
      error: `Unknown command: ${command || "(none)"}`,
      available: Object.keys(commands),
    });
    process.exit(1);
  }

  const result = commands[command]();
  if (result && typeof result.then === "function") {
    result.catch((err) => {
      output({ ok: false, error: err.message });
      process.exit(1);
    });
  }
}

// ─── Commands ───

// cmdInit moved to scripts/commands/init.js (v7.3-M4e-p3)

function cmdState() {
  const state = findActiveState();
  if (!state) {
    return output({
      ok: true,
      command: "state",
      active: false,
      message: "No active pipeline.",
    });
  }

  const pipelineDef = loadPipelineDefinition();
  const steps = resolveSteps(pipelineDef, state.pipeline_type);
  const currentStepDef = steps.find((s) => s.id === state.current_step);

  // v7.2 M1/M2 — Derive per-role model recommendation + cache policy
  // from .vela/config.json. PM passes recommended_model into Agent()
  // spawns; missing config → null (PM inherits session model).
  let recommendedModel = null;
  let cacheConfig = null;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(VELA_DIR, "config.json"), "utf8"),
    );
    if (cfg && typeof cfg === "object") {
      const models = cfg.models;
      if (models && typeof models === "object") {
        const stepKey = String(state.current_step || "").replace(/-/g, "_");
        recommendedModel = models[stepKey] || models.default || null;
      }
      cacheConfig = cfg.cache || null;
    }
  } catch {
    /* config missing or malformed — non-fatal, defaults to null */
  }

  output({
    ok: true,
    command: "state",
    active: true,
    pipeline_type: state.pipeline_type,
    scale: state.scale || "standard",
    request: state.request,
    current_step: state.current_step,
    current_step_name: currentStepDef
      ? currentStepDef.name
      : state.current_step,
    current_mode: currentStepDef ? currentStepDef.mode : "read",
    completed_steps: state.completed_steps,
    remaining_steps: state.steps.filter(
      (s) => !state.completed_steps.includes(s),
    ),
    auto: state.auto || false,
    revisions: state.revisions,
    sub_phase: state.sub_phases
      ? state.sub_phases[state.current_step] || null
      : null,
    git: state.git || null,
    artifact_dir: state._artifactDir,
    recommended_model: recommendedModel,
    cache_config: cacheConfig,
    // v7.2 M13 — Pipeline steps as task records, suitable for the PM
    // to hand to Claude Code's session-level task-list tool on init and
    // to update on each transition. Engine cannot call Claude Code tools
    // itself; this is the structured input it hands to the PM.
    tasks: Array.isArray(state.steps) ? state.steps.map((id, idx) => {
      const def = steps.find((s) => s.id === id);
      const isDone = Array.isArray(state.completed_steps) && state.completed_steps.includes(id);
      const isCurrent = id === state.current_step;
      return {
        id: `vela-${state.pipeline_type || "pipeline"}-${idx}-${id}`,
        content: def ? def.name || id : id,
        status: isDone ? "completed" : (isCurrent ? "in_progress" : "pending"),
      };
    }) : [],
    // v7.1 M7: surface context-pack path so the PM can hand it to
    // executor/verifier spawns without having to check the filesystem
    // itself. Also exposes budget-exceeded.json if it was dropped.
    contextPackPath: state._artifactDir && fs.existsSync(
      path.join(state._artifactDir, "context-pack.json"),
    ) ? path.join(state._artifactDir, "context-pack.json") : null,
    requestTxtPath: state._artifactDir && fs.existsSync(
      path.join(state._artifactDir, "request.txt"),
    ) ? path.join(state._artifactDir, "request.txt") : null,
  });
}

function cmdTransition() {
  const state = findActiveState();
  if (!state) {
    return output({ ok: false, error: "No active pipeline to transition." });
  }

  const pipelineDef = loadPipelineDefinition();
  const steps = resolveSteps(pipelineDef, state.pipeline_type);
  const currentIdx = steps.findIndex((s) => s.id === state.current_step);

  if (currentIdx < 0) {
    return output({
      ok: false,
      error: `Current step "${state.current_step}" not found in pipeline.`,
    });
  }

  // Check exit gate for current step
  const currentStepDef = steps[currentIdx];
  const gateResult = checkExitGate(currentStepDef, state);
  if (!gateResult.passed) {
    return output({
      ok: false,
      error: `Exit gate not met for step "${state.current_step}"`,
      missing: gateResult.missing,
      message: `Complete these requirements before advancing: ${gateResult.missing.join(", ")}`,
    });
  }

  // Mark current step as completed
  if (!state.completed_steps.includes(state.current_step)) {
    state.completed_steps.push(state.current_step);
  }

  // Check if this was the last step
  if (currentIdx >= steps.length - 1) {
    state.status = "completed";
    state.current_step = "done";
    state.updated_at = new Date().toISOString();
    writeJSON(state._path, cleanState(state));

    return output({
      ok: true,
      command: "transition",
      completed: true,
      message: "Pipeline completed successfully.",
    });
  }

  // Reset circuit state for the step we're leaving
  const prevFailKey = `_step_failures_${state.current_step}`;
  delete state[prevFailKey];
  try {
    const circuitPath = path.join(CWD, ".vela", "state", "circuit-open.json");
    if (fs.existsSync(circuitPath)) fs.unlinkSync(circuitPath);
  } catch { /* silent */ }

  // Reset review gate state for the step we're leaving
  try {
    const gateStatePath = path.join(CWD, ".vela", "state", `review-gate-${state.current_step}.json`);
    if (fs.existsSync(gateStatePath)) fs.unlinkSync(gateStatePath);
  } catch { /* silent */ }

  // Advance to next step
  const nextStep = steps[currentIdx + 1];
  state.current_step = nextStep.id;
  state.current_step_index = currentIdx + 1;
  state.updated_at = new Date().toISOString();

  // V6: no in-memory team state needed.
  // PM orchestrates via Agent(subagent_type=...) + file artifacts (approval-{step}.json, review-{step}.md).

  // Initialize sub-phase tracking if step has sub_phases and tracking enabled
  if (nextStep.sub_phases && nextStep.sub_phase_tracking) {
    if (!state.sub_phases) state.sub_phases = {};
    state.sub_phases[nextStep.id] = {
      phases: nextStep.sub_phases,
      current_index: 0,
      current_phase: nextStep.sub_phases[0],
      completed_phases: [],
    };
  }

  writeJSON(state._path, cleanState(state));

  output({
    ok: true,
    command: "transition",
    previous_step: currentStepDef.id,
    current_step: nextStep.id,
    current_step_name: nextStep.name,
    current_mode: nextStep.mode,
    completed: false,
    message: `Advanced to: ${nextStep.name} (${nextStep.mode} mode)`,
  });
}

function cmdRecord() {
  const verdict = getArg(0);
  if (!verdict || !["pass", "fail", "reject"].includes(verdict.toLowerCase())) {
    return output({
      ok: false,
      error: "Verdict required: pass, fail, or reject",
    });
  }

  const state = findActiveState();
  if (!state) {
    return output({ ok: false, error: "No active pipeline." });
  }

  const summary = getFlag("--summary") || "";

  // Track revisions
  if (!state.revisions[state.current_step]) {
    state.revisions[state.current_step] = 0;
  }
  state.revisions[state.current_step]++;

  // Auto mode: reject counter and reset logic
  const verdictLower = verdict.toLowerCase();
  if (state.auto === true) {
    if (verdictLower === "reject" || verdictLower === "fail") {
      state.auto_reject_count = (state.auto_reject_count || 0) + 1;
      if (state.auto_reject_count >= 2) {
        state.auto = false;
      }
    } else if (verdictLower === "pass" || verdictLower === "approve") {
      state.auto_reject_count = 0;
    }
  }

  // Circuit breaker: track consecutive fail/reject verdicts on this step
  // Written to circuit-open.json which VG-15 gate-guard reads to block further execution.
  const failKey = `_step_failures_${state.current_step}`;
  if (verdictLower === "fail" || verdictLower === "reject") {
    state[failKey] = (state[failKey] || 0) + 1;
    if (state[failKey] >= CIRCUIT_BREAKER_THRESHOLD) {
      try {
        const stateDir = path.join(CWD, ".vela", "state");
        fs.mkdirSync(stateDir, { recursive: true });
        writeJSON(path.join(stateDir, "circuit-open.json"), {
          step: state.current_step,
          count: state[failKey],
          openAt: new Date().toISOString(),
        });
      } catch { /* silent */ }
    }
  } else if (verdictLower === "pass") {
    state[failKey] = 0;
    try {
      const circuitPath = path.join(CWD, ".vela", "state", "circuit-open.json");
      if (fs.existsSync(circuitPath)) fs.unlinkSync(circuitPath);
    } catch { /* silent */ }
  }

  state.updated_at = new Date().toISOString();

  writeJSON(state._path, cleanState(state));

  const result = {
    ok: true,
    command: "record",
    step: state.current_step,
    verdict: verdictLower,
    revision: state.revisions[state.current_step],
    summary: summary,
  };

  // Warn when auto mode is disabled due to consecutive rejects
  if (
    state.auto === false &&
    verdictLower === "reject" &&
    (state.auto_reject_count || 0) >= 2
  ) {
    result.auto_disabled = true;
    result.auto_warning =
      "⚠️ Auto mode disabled: 2 consecutive rejects reached.";
  }

  output(result);
}

/**
 * v7.1 M8: Apply a verdict (pass/fail/reject) to the active pipeline state
 * in memory. Returns the mutated state plus auto-mode side effects, but
 * does NOT write to disk — callers compose this with applyTransition()
 * when running the advance shortcut, so both mutations flush in one
 * writeJSON call.
 *
 * Factored out of cmdRecord so `advance` can reuse exactly the same
 * circuit-breaker, auto-mode, and revision-counter rules that `record`
 * has carried since v4.
 */
function applyVerdict(state, verdictLower) {
  if (!state.revisions[state.current_step]) {
    state.revisions[state.current_step] = 0;
  }
  state.revisions[state.current_step]++;

  const result = {
    autoDisabled: false,
    autoWarning: null,
    circuitOpened: false,
  };

  if (state.auto === true) {
    if (verdictLower === "reject" || verdictLower === "fail") {
      state.auto_reject_count = (state.auto_reject_count || 0) + 1;
      if (state.auto_reject_count >= 2) {
        state.auto = false;
        result.autoDisabled = true;
        result.autoWarning =
          "⚠️ Auto mode disabled: 2 consecutive rejects reached.";
      }
    } else if (verdictLower === "pass" || verdictLower === "approve") {
      state.auto_reject_count = 0;
    }
  }

  const failKey = `_step_failures_${state.current_step}`;
  if (verdictLower === "fail" || verdictLower === "reject") {
    state[failKey] = (state[failKey] || 0) + 1;
    if (state[failKey] >= CIRCUIT_BREAKER_THRESHOLD) {
      result.circuitOpened = true;
      try {
        const stateDir = path.join(CWD, ".vela", "state");
        fs.mkdirSync(stateDir, { recursive: true });
        writeJSON(path.join(stateDir, "circuit-open.json"), {
          step: state.current_step,
          count: state[failKey],
          openAt: new Date().toISOString(),
        });
      } catch { /* silent */ }
    }
  } else if (verdictLower === "pass") {
    state[failKey] = 0;
    try {
      const circuitPath = path.join(CWD, ".vela", "state", "circuit-open.json");
      if (fs.existsSync(circuitPath)) fs.unlinkSync(circuitPath);
    } catch { /* silent */ }
  }

  state.updated_at = new Date().toISOString();
  return result;
}

/**
 * v7.1 M8: advance — record(verdict) + transition as one atomic CLI call.
 *
 * Motivation: hicoco session analysis showed the PM's top-level Bash
 * count was 146, the largest single consumer being "record pass" followed
 * immediately by "transition" on every successful step. advance halves
 * that latency and also lets the engine return a `nextAction` hint so the
 * PM can skip an extra `state` round-trip just to find out which agent to
 * spawn next.
 *
 * Behaviour by verdict:
 *   pass  (default) — record pass, transition to next step
 *   fail  — record fail, stay on current step (no transition)
 *   reject — record reject, stay on current step (no transition)
 *
 * Output JSON includes: previousStep, currentStep, nextStep, active,
 * circuitOpen, and nextAction (a one-line hint like "spawn vela-executor"
 * or "commit via `node .vela/cli/vela-engine.js commit`").
 *
 * Backward compat: cmdRecord and cmdTransition remain untouched so any
 * existing automation still works.
 */
function cmdAdvance() {
  const rawVerdict = getArg(0) || "pass";
  const verdictLower = rawVerdict.toLowerCase();
  if (!["pass", "fail", "reject"].includes(verdictLower)) {
    return output({
      ok: false,
      command: "advance",
      error: "Verdict must be one of pass|fail|reject (default: pass)",
    });
  }

  const state = findActiveState();
  if (!state) {
    return output({
      ok: false,
      command: "advance",
      error: "No active pipeline.",
    });
  }

  const previousStep = state.current_step;
  const verdictResult = applyVerdict(state, verdictLower);

  // fail/reject: stay on the same step — same semantics as cmdRecord alone.
  if (verdictLower !== "pass") {
    writeJSON(state._path, cleanState(state));
    return output({
      ok: true,
      command: "advance",
      verdict: verdictLower,
      previousStep,
      currentStep: state.current_step,
      nextStep: null,
      active: true,
      circuitOpen: verdictResult.circuitOpened,
      revision: state.revisions[previousStep],
      ...(verdictResult.autoDisabled ? {
        autoDisabled: true,
        autoWarning: verdictResult.autoWarning,
      } : {}),
      nextAction: nextActionHint(state, previousStep, false),
      message: `Recorded ${verdictLower} on step ${previousStep}. Pipeline stays on ${previousStep} for retry.`,
    });
  }

  // pass → advance. Reuse cmdTransition's logic by inlining the minimal
  // subset we need (the full cmdTransition does exit-gate checks we want
  // to preserve, so we delegate to it explicitly by re-reading state).
  writeJSON(state._path, cleanState(state));

  // cmdTransition rereads the active state from disk and performs the
  // exit-gate check + step advancement. We intercept its output() call
  // by temporarily replacing process.stdout.write, capture the JSON it
  // would emit, then re-emit a merged advance response.
  let transitionResult = null;
  const origOutput = output;
  // Poor man's intercept: override the module-level `output` only for
  // this call, restore afterwards. output is a top-level `function`
  // declaration so it's hoisted; we shadow via a local that the closure
  // around cmdTransition doesn't see. Instead of shadowing, we call
  // a reimplementation here.
  //
  // The cleanest implementation is to factor cmdTransition's core into a
  // pure helper and call both cmdTransition and cmdAdvance through it.
  // That refactor is larger than M8 should carry — so instead we replay
  // cmdTransition's minimal core here, keeping the exit-gate check and
  // the step advancement, and return the advance-shaped result.
  void origOutput;

  const fresh = findActiveState();
  if (!fresh) {
    return output({
      ok: false,
      command: "advance",
      error: "Pipeline disappeared mid-advance (race?). Run `state`.",
    });
  }
  const pipelineDef = loadPipelineDefinition();
  const steps = resolveSteps(pipelineDef, fresh.pipeline_type);
  const currentIdx = steps.findIndex((s) => s.id === fresh.current_step);
  if (currentIdx < 0) {
    return output({
      ok: false,
      command: "advance",
      error: `Current step "${fresh.current_step}" not found in pipeline.`,
    });
  }

  const currentStepDef = steps[currentIdx];
  const gateResult = checkExitGate(currentStepDef, fresh);
  if (!gateResult.passed) {
    return output({
      ok: false,
      command: "advance",
      error: `Exit gate not met for step "${fresh.current_step}"`,
      missing: gateResult.missing,
      message: `Complete these requirements before advancing: ${gateResult.missing.join(", ")}`,
    });
  }

  if (!fresh.completed_steps.includes(fresh.current_step)) {
    fresh.completed_steps.push(fresh.current_step);
  }

  if (currentIdx >= steps.length - 1) {
    fresh.status = "completed";
    fresh.current_step = "done";
    fresh.updated_at = new Date().toISOString();
    writeJSON(fresh._path, cleanState(fresh));
    return output({
      ok: true,
      command: "advance",
      verdict: "pass",
      previousStep,
      currentStep: "done",
      nextStep: null,
      active: false,
      completed: true,
      revision: fresh.revisions[previousStep] || 1,
      circuitOpen: false,
      nextAction: "pipeline-complete",
      message: "Pipeline completed successfully.",
    });
  }

  // Same cleanup cmdTransition does
  const prevFailKey = `_step_failures_${fresh.current_step}`;
  delete fresh[prevFailKey];
  try {
    const circuitPath = path.join(CWD, ".vela", "state", "circuit-open.json");
    if (fs.existsSync(circuitPath)) fs.unlinkSync(circuitPath);
  } catch { /* silent */ }
  try {
    const gateStatePath = path.join(
      CWD, ".vela", "state", `review-gate-${fresh.current_step}.json`,
    );
    if (fs.existsSync(gateStatePath)) fs.unlinkSync(gateStatePath);
  } catch { /* silent */ }

  const nextStep = steps[currentIdx + 1];
  fresh.current_step = nextStep.id;
  fresh.current_step_index = currentIdx + 1;
  fresh.updated_at = new Date().toISOString();
  if (nextStep.sub_phases && nextStep.sub_phase_tracking) {
    if (!fresh.sub_phases) fresh.sub_phases = {};
    fresh.sub_phases[nextStep.id] = {
      phases: nextStep.sub_phases,
      current_index: 0,
      current_phase: nextStep.sub_phases[0],
      completed_phases: [],
    };
  }
  writeJSON(fresh._path, cleanState(fresh));

  const nextNextStep = steps[currentIdx + 2] || null;
  output({
    ok: true,
    command: "advance",
    verdict: "pass",
    previousStep,
    currentStep: nextStep.id,
    currentStepName: nextStep.name,
    currentMode: nextStep.mode,
    nextStep: nextNextStep ? nextNextStep.id : null,
    active: true,
    completed: false,
    revision: fresh.revisions[previousStep] || 1,
    circuitOpen: false,
    nextAction: nextActionHint(fresh, nextStep.id, true),
    message: `Recorded pass on ${previousStep} → advanced to ${nextStep.name} (${nextStep.mode} mode)`,
  });
}

/**
 * v7.1 M8: return a short one-line hint for what the PM should do next
 * at a given step. Used by `advance` (and `state` when added) so the PM
 * can skip an extra `state` round-trip to decide which agent to spawn.
 *
 * Non-authoritative: hints are pure strings. The PM is still the decision
 * maker. Keep the table tiny — if a step is missing it falls back to
 * "see agents/vela.md for this step".
 */
function nextActionHint(state, stepId, justAdvanced) {
  // justAdvanced === true → we're saying "you just moved INTO stepId, here's
  // what to run". false → "you're still ON stepId, here's the retry path".
  const pipelineType = state && state.pipeline_type;
  // v8.0 (v7.3-M3): ship 파이프라인 6단계 고정 매핑. plan이 research+plan-check 흡수, reviewer가 verify+diff-summary 흡수, commit이 branch+finalize 흡수.
  const table = {
    init: "run `node .vela/cli/vela-engine.js advance` to move into locate (init도 vela/{slug} 브랜치 자동 생성)",
    locate: "run `node .vela/cli/vela-engine.js locate` (generates targets.json)",
    plan: "spawn vela-planner (research+plan+self-check 통합) then vela-reviewer; call `advance pass` on approve. fix 파이프라인에선 mode=spec로 patch-spec.md 생성.",
    execute: "spawn vela-executor then vela-reviewer; call `advance pass` on approve",
    verify: "spawn vela-reviewer (테스트+린트+타입체크+diff 요약 통합); >500 LOC diff이면 /ultrareview 번들 스킬 에스컬레이션",
    commit: "run `node .vela/cli/vela-engine.js commit` — Conventional Commits + git diff --stat 요약으로 파이프라인 종료",
  };
  const hint = table[stepId];
  if (!hint) return `see agents/vela.md for step ${stepId} (${pipelineType || "unknown pipeline"})`;
  return justAdvanced ? hint : `retry: ${hint}`;
}

/**
 * v7.1 M6: engine doctor — validate that all Vela-managed files are
 * present and parseable. Returns { ok, missing, recovery } shaped JSON.
 *
 * Used by:
 *   - Session-start flow in agents/vela.md so the PM fails loud when
 *     .vela/ is incomplete instead of limping along until the first
 *     agent spawn dies with "file not found"
 *   - /vela:analyze pre-flight
 *
 * Reverse from FILE_MANIFEST: doctor doesn't re-download anything, it
 * only reports. install.js validate is the repair path.
 */
// cmdDoctor moved to scripts/commands/doctor.js (v7.3-M4e-p5)

// cmdBranch moved to scripts/commands/branch.js (v7.3-M4e-p3)

// cmdCommit moved to scripts/commands/commit.js (v7.3-M4e-p3)

/**
 * cmdLocate — Mechanical Locate (v6.1)
 *
 * Runs scripts/shared/locate.js against the active pipeline's request and
 * writes {artifactDir}/targets.json. LLM-free: deterministic grep + git
 * ls-files. Used by every scale's locate step (small/medium/large/ralph/hotfix)
 * to give downstream agents a precise file:line target list.
 *
 * Flags:
 *   --request "..."   Override the request (defaults to active pipeline's request)
 *   --json            Print the full targets.json to stdout (default: summary)
 *
 * Exit gates that depend on this:
 *   - targets_json_exists  (added in checkExitGate)
 */
// cmdLocate moved to scripts/commands/locate.js (v7.3-M4e-p4)

// cmdCancel moved to scripts/commands/cancel.js (v7.3-M4e-p4)

// ─── Git Clean: Scan (read-only, report findings) ───
// cmdCleanScan moved to scripts/commands/clean.js (v7.3-M4e-p5)

// ─── Git Clean: Execute selected categories ───
// cmdCleanExec moved to scripts/commands/clean.js (v7.3-M4e-p5)

// detectMainBranch moved to scripts/commands/clean.js (inlined helper) (v7.3-M4e-p5)

// cmdHistory moved to scripts/commands/history.js (v7.3-M4e-p4)

// ─── Helpers ───

// getOrCreateTeam REMOVED (V4.1). V6 uses Agent(subagent_type=...) directly.

// findActiveState moved to scripts/core/state.js (v7.3-M4e engine split).
// See top-of-file `require("../core/state")(ARTIFACTS_DIR)` for the
// factory-bound import.

// loadPipelineDefinition + resolveSteps + checkExitGate moved to
// scripts/core/pipeline.js (v7.3-M4e engine split). See top-of-file
// `require("../core/pipeline")({templatesDir, velaDir, cwd})` for the
// factory-bound import.

// slugify/slugifyEx/cleanState/writeJSON/output/autoDetectScale moved
// to scripts/core/cli-utils.js (v7.3-M4e engine split). See top-of-file
// `require("../core/cli-utils")` for the import.

// Return the Nth positional argument after the command, skipping flags.
// Previously this was `args[index + 1]` which returned "--scale" for
// `init --scale large "task"`, causing slugify("--scale") for the request.
// Known boolean flags are inlined to avoid a TDZ reference (this function
// runs at top-level load time via the command dispatch on line ~64).
function getArg(index) {
  const booleanFlags = new Set(["--auto", "--force", "--json"]);
  const positionals = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (typeof a === "string" && a.startsWith("--")) {
      if (!booleanFlags.has(a)) {
        i++; // consume the flag's value
      }
      continue;
    }
    positionals.push(a);
  }
  return positionals[index] || null;
}

function getFlag(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

// ─── Cleanup ───

// cleanupCancelledArtifacts moved to scripts/core/state.js (v7.3-M4e
// engine split). See top-of-file `require("../core/state")(ARTIFACTS_DIR)`
// for the factory-bound import.

// Git helpers (gitExec/gitExecShell/snapshotGitState/ensureGitignore)
// moved to scripts/core/git-utils.js (v7.3-M4e engine split). See
// top-of-file `require("../core/git-utils")(CWD, PROTECTED_BRANCHES)`
// for the factory-bound import.
