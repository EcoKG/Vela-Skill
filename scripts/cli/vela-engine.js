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

// ─── Command Router ───
const args = process.argv.slice(2);
const command = args[0];

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

function cmdInit() {
  const request = getArg(0) || getFlag("--request");
  if (!request) {
    return output({
      ok: false,
      error:
        'Request description required. Usage: vela-engine init "task description"',
    });
  }

  // Block if there's already an active pipeline
  const existing = findActiveState();
  if (existing && !hasFlag("--force")) {
    return output({
      ok: false,
      error: "Active pipeline already exists.",
      current_step: existing.current_step,
      request: existing.request,
      hint: "Complete or cancel the current pipeline first: vela-engine cancel",
    });
  }

  // Clean up cancelled artifacts older than 24 hours
  const cleaned = cleanupCancelledArtifacts(24);

  const type = getFlag("--type") || "code";

  // Load pipeline definition (before creating any directories)
  const pipelineDef = loadPipelineDefinition();
  if (!pipelineDef) {
    return output({
      ok: false,
      error: "Pipeline definition not found. Run /vela:start to initialize the environment.",
    });
  }

  // Scale resolution (v6.1): --scale flag required.
  // If omitted → fall back to "medium" with a deprecation warning.
  // autoDetectScale() is deprecated — word-count heuristics don't reflect
  // actual work weight (e.g. "OAuth 추가" is small but <10 words, "single-
  // line typo fix in auth.ts" is >10 words). Use explicit scale.
  let scaleWarning = null;
  const scaleFlag = getFlag("--scale");
  let scaleName;
  if (scaleFlag) {
    scaleName = scaleFlag;
  } else {
    scaleWarning =
      "⚠️ --scale not specified. Defaulting to 'medium'. " +
      "Use /vela:small | /vela:medium | /vela:large | /vela:ralph | /vela:hotfix " +
      "to be explicit (autoDetectScale was deprecated in v6.1).";
    scaleName = "medium";
  }
  const scalesMap = pipelineDef.scales || {};
  // scalesMap lookup: known scale names (small/medium/large/ralph/hotfix) → pipeline type.
  // If scaleName is already a pipeline type (e.g. "standard"), fall through directly.
  const pipelineType = scalesMap[scaleName] || scaleName || "standard";

  const steps = resolveSteps(pipelineDef, pipelineType);
  if (!steps || steps.length === 0) {
    return output({
      ok: false,
      error: `Pipeline type "${pipelineType}" is not defined in pipeline.json (or has no steps).`,
      pipeline_type: pipelineType,
      scale: scaleName,
      hint: "Add a scales map to pipeline.json that routes this scale to an existing pipeline, or pass --scale <known-pipeline> explicitly.",
    });
  }
  const firstStep = steps[0];

  // Git state snapshot
  const gitState = snapshotGitState();

  // Block if dirty tree (unless --force)
  if (gitState.is_repo && !gitState.is_clean && !hasFlag("--force")) {
    return output({
      ok: false,
      error:
        "Working tree is dirty. Commit or stash changes before starting a pipeline.",
      git: gitState,
      hint: "Use --force to skip this check, or run: git stash",
    });
  }

  // Ensure Vela files are hidden from git
  ensureGitignore();

  // Create artifact directory AFTER validation passes: {YYYYMMDD}T{HHmmss}-{slug}
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  // v7.1 M5: use slugifyEx so we can detect truncation and drop a
  // request.txt side-car with the full original text. Without this,
  // hicoco-style long Korean requests had artifact dirs like
  // "20260101T000000-별도-downloa" with no way to recover the prompt
  // that started the pipeline.
  const slugInfo = slugifyEx(request);
  const slug = slugInfo.slug;
  const artifactDir = path.join(ARTIFACTS_DIR, `${ts}-${slug}`);

  fs.mkdirSync(artifactDir, { recursive: true });

  // v7.1 M5: when the slug had to be truncated, write the full request
  // to a side-car file so downstream agents (and humans) can still see
  // what was asked.
  if (slugInfo.truncated) {
    try {
      fs.writeFileSync(
        path.join(artifactDir, "request.txt"),
        String(request) + "\n",
      );
    } catch { /* best effort */ }
  }

  // Auto mode flag
  const autoMode = hasFlag("--auto");

  // Create pipeline state
  const state = {
    version: "1.2",
    status: "active",
    pipeline_type: pipelineType,
    request: request,
    type: type,
    scale: scaleName,
    current_step: firstStep.id,
    current_step_index: 0,
    steps: steps.map((s) => s.id),
    completed_steps: [],
    revisions: {},
    ...(autoMode ? { auto: true, auto_reject_count: 0 } : {}),
    git: gitState.is_repo
      ? {
          is_repo: true,
          base_branch: gitState.current_branch,
          current_branch: gitState.current_branch,
          pipeline_branch: null,
          checkpoint_hash: gitState.head_hash,
          commit_hash: null,
          stash_ref: gitState.stash_ref || null,
          remote: gitState.remote,
        }
      : null,
    baseline_sha: gitState.is_repo ? gitState.head_hash : null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  // Create meta.json
  const meta = {
    request,
    type,
    scale: scaleName,
    pipeline_type: pipelineType,
    created_at: now.toISOString(),
  };

  writeJSON(path.join(artifactDir, "pipeline-state.json"), state);
  writeJSON(path.join(artifactDir, "meta.json"), meta);

  // v7.1 M1: surface non-git projects at init time so the user finds out
  // immediately instead of at commit 10 steps later. pipelineWarnings is
  // an array because future modules may add more init-time warnings.
  const pipelineWarnings = [];
  if (!gitState.is_repo) {
    pipelineWarnings.push({
      code: "not_a_git_repo",
      severity: "high",
      message:
        "This directory is not a git repository. Commit and branch steps will BLOCK until you run `git init -b main` and make an initial commit. Do this now — you do not want to discover it after execute.",
    });
    process.stderr.write([
      "",
      "⚠️  Vela v7.1 init — non-git project detected.",
      "    commit/branch steps will block until you run:",
      "      git init -b main && git add -A && git commit -m \"chore: initial\"",
      "",
    ].join("\n"));
  }

  output({
    ok: true,
    command: "init",
    pipeline_type: pipelineType,
    scale: scaleName,
    current_step: firstStep.id,
    current_mode: firstStep.mode,
    artifact_dir: artifactDir,
    steps: steps.map((s) => ({ id: s.id, name: s.name, mode: s.mode })),
    cleaned_cancelled: cleaned,
    git: {
      repo: gitState.is_repo,
      branch: gitState.current_branch || null,
      dirty: gitState.is_repo ? !gitState.is_clean : false,
    },
    ...(scaleWarning ? { warning: scaleWarning } : {}),
    ...(pipelineWarnings.length > 0 ? { pipelineWarnings } : {}),
    message:
      `Pipeline initialized. Scale: ${scaleName} → ${pipelineType}. Current step: ${firstStep.name} (${firstStep.mode} mode)` +
      (cleaned > 0 ? ` (cleaned ${cleaned} cancelled artifact(s))` : ""),
  });
}

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
  const table = {
    init: "run `node .vela/cli/vela-engine.js advance` to move into locate",
    locate: "run `node .vela/cli/vela-engine.js locate` (generates targets.json)",
    research: "spawn vela-researcher then vela-reviewer; call `advance pass` on approve",
    plan: "spawn vela-planner then vela-reviewer; call `advance pass` on approve",
    "plan-check": "spawn vela-plan-checker; call `advance pass` if PASS, else re-spawn planner",
    checkpoint: "AskUserQuestion for plan approval; call `advance pass` on approve",
    spec: "spawn vela-planner (mode:spec) then vela-reviewer",
    branch: "run `node .vela/cli/vela-engine.js branch` then `advance`",
    execute: "spawn vela-executor then vela-reviewer",
    patch: "spawn vela-executor with specPath then vela-reviewer",
    verify: "spawn vela-verifier; call `advance pass` if PASS, else re-spawn executor",
    "diff-summary": "spawn vela-diff-summary (non-fatal); always `advance pass`",
    learning: "spawn vela-learning (non-fatal); always `advance pass`",
    commit: "run `node .vela/cli/vela-engine.js commit` then `advance`",
    finalize: "write report.md then `advance pass` to close the pipeline",
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
function cmdDoctor() {
  const checks = [];
  const missing = [];

  function addCheck(name, ok, detail) {
    checks.push({ name, ok, detail: detail || null });
    if (!ok) missing.push(name);
  }

  // 1. Core directories
  const coreDirs = [
    ".vela",
    ".vela/cli",
    ".vela/agents",
    ".vela/templates",
    ".vela/state",
    ".vela/artifacts",
    ".vela/hooks",
    ".vela/shared",
  ];
  for (const d of coreDirs) {
    const abs = path.join(CWD, d);
    addCheck(`dir:${d}`, fs.existsSync(abs) && fs.statSync(abs).isDirectory());
  }

  // 2. Required files
  const coreFiles = [
    ".vela/cli/vela-engine.js",
    ".vela/templates/pipeline.json",
    ".vela/config.json",
    ".vela/state/workspace.json", // v7.0.7
    "CLAUDE.md",
  ];
  for (const f of coreFiles) {
    const abs = path.join(CWD, f);
    addCheck(`file:${f}`, fs.existsSync(abs));
  }

  // 3. Agent manifest — every v7.1 role the PM may spawn
  const agents = [
    "vela.md",
    "vela-researcher.md",
    "vela-planner.md",
    "vela-executor.md",
    "vela-reviewer.md",
    "vela-verifier.md",
    "vela-plan-checker.md",
    "vela-diff-summary.md",
    "vela-learning.md",
    "vela-sprint-planner.md",
  ];
  for (const a of agents) {
    const abs = path.join(CWD, ".vela", "agents", a);
    addCheck(`agent:${a}`, fs.existsSync(abs));
  }

  // 4. pipeline.json parses
  try {
    const raw = fs.readFileSync(
      path.join(CWD, ".vela", "templates", "pipeline.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    addCheck("parse:pipeline.json", !!(parsed && parsed.pipelines && parsed.pipelines.standard));
  } catch (e) {
    addCheck("parse:pipeline.json", false, e.message);
  }

  // 5. config.json parses
  try {
    const raw = fs.readFileSync(path.join(CWD, ".vela", "config.json"), "utf8");
    JSON.parse(raw);
    addCheck("parse:config.json", true);
  } catch (e) {
    addCheck("parse:config.json", false, e.message);
  }

  // 6. v7.1 template + hook additions
  const v71Files = [
    ".vela/templates/role-budgets.json",
    ".vela/templates/plan-templates/quick.md",
    ".vela/templates/guidelines/live-processes.json",
    ".vela/templates/guidelines/smoke-test.sh.example",
    ".vela/hooks/vela-file-read-cache.js",
  ];
  for (const f of v71Files) {
    const abs = path.join(CWD, f);
    addCheck(`file:${f}`, fs.existsSync(abs));
  }

  const allOk = missing.length === 0;
  output({
    ok: allOk,
    command: "doctor",
    checks,
    missing,
    ...(allOk
      ? { message: "All Vela files present and parseable." }
      : {
          message: `${missing.length} missing check(s). Run repair path below.`,
          recovery: "node .vela/install.js validate",
        }),
  });
}

function cmdBranch() {
  const state = findActiveState();
  if (!state) {
    return output({ ok: false, error: "No active pipeline." });
  }

  if (!state.git || !state.git.is_repo) {
    // v7.1 M1: non-git project → loud warning. Same reasoning as cmdCommit.
    // Standard pipeline reaches branch early, so the warning fires once per
    // pipeline instead of only at commit time.
    state.git = state.git || {};
    state.git.pipeline_branch = null;
    state.updated_at = new Date().toISOString();
    writeJSON(state._path, cleanState(state));
    process.stderr.write([
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "⛔  Vela branch BLOCKED — this directory is not a git repository",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "The pipeline cannot create a feature branch without git. All work",
      "produced by this pipeline will eventually fail to commit unless a",
      "repo is initialised now:",
      "",
      "  git init -b main",
      "  git add -A",
      "  git commit -m \"chore: initial commit\"",
      "  node .vela/cli/vela-engine.js transition",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
    ].join("\n"));
    return output({
      ok: true,
      command: "branch",
      status: "blocked",
      reason: "not a git repo",
      recovery: [
        "git init -b main",
        "git add -A && git commit -m \"chore: initial commit\"",
        "node .vela/cli/vela-engine.js transition",
      ],
      message: "Branch blocked — not a git repository. See stderr for recovery steps.",
    });
  }

  const mode = getFlag("--mode") || "auto";
  const currentBranch = gitExec("rev-parse", "--abbrev-ref", "HEAD").trim();
  const isProtected = PROTECTED_BRANCHES.includes(currentBranch);

  // If already on a non-protected branch, use it
  if (!isProtected) {
    state.git.pipeline_branch = currentBranch;
    state.git.current_branch = currentBranch;
    state.updated_at = new Date().toISOString();
    writeJSON(state._path, cleanState(state));
    return output({
      ok: true,
      command: "branch",
      action: "existing",
      branch: currentBranch,
      message: `Already on non-protected branch "${currentBranch}". Using it as pipeline branch.`,
    });
  }

  // Generate branch name
  const slug = slugify(state.request);
  const timeStr = new Date().toTimeString().substring(0, 5).replace(":", "");
  const branchName = `vela/${slug}-${timeStr}`;

  if (mode === "none") {
    state.git.pipeline_branch = currentBranch;
    state.updated_at = new Date().toISOString();
    writeJSON(state._path, cleanState(state));
    return output({
      ok: true,
      command: "branch",
      action: "none",
      branch: currentBranch,
      message: "Branch creation skipped (mode: none).",
    });
  }

  if (mode === "prompt") {
    return output({
      ok: true,
      command: "branch",
      action: "prompt",
      suggested_command: `git checkout -b ${branchName}`,
      message: `Run this command to create the pipeline branch: git checkout -b ${branchName}`,
    });
  }

  // Auto mode: create branch
  try {
    gitExec("checkout", "-b", branchName);
  } catch (e) {
    // Branch might exist, try checkout
    try {
      gitExec("checkout", branchName);
    } catch (e2) {
      return output({
        ok: false,
        error: `Failed to create branch: ${e2.message}`,
      });
    }
  }

  state.git.pipeline_branch = branchName;
  state.git.current_branch = branchName;
  state.git.checkpoint_hash = gitExec("rev-parse", "HEAD").trim();
  state.updated_at = new Date().toISOString();
  writeJSON(state._path, cleanState(state));

  output({
    ok: true,
    command: "branch",
    action: "created",
    branch: branchName,
    base_branch: state.git.base_branch,
    checkpoint_hash: state.git.checkpoint_hash,
    message: `Branch "${branchName}" created from "${state.git.base_branch}".`,
  });
}

function cmdCommit() {
  const state = findActiveState();
  if (!state) {
    return output({ ok: false, error: "No active pipeline." });
  }

  if (!state.git || !state.git.is_repo) {
    // v7.1 M1: non-git project → loud warning.
    //
    // Pre-v7.1 this path emitted a quiet skipped:true status. Analysis of the
    // hicoco session showed 4 pipelines in a row completing commit with
    // skipped:true, never persisting work. The user only realised when
    // reading the final report. Fail-loud semantics: status:"blocked" in
    // the JSON, multi-line stderr banner, exit code still 0 so the
    // pipeline can advance (commit exit_gate already tolerates !is_repo).
    process.stderr.write([
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "⛔  Vela commit BLOCKED — this directory is not a git repository",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "Your pipeline work will NOT be persisted. To save it now:",
      "",
      "  git init -b main",
      "  git add -A",
      "  git commit -m \"chore: initial commit (Vela pipeline output)\"",
      "  node .vela/cli/vela-engine.js transition",
      "",
      "The pipeline will advance past this step so you can finish the",
      "remaining stages, but every subsequent run will keep blocking",
      "here until a .git/ exists.",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
    ].join("\n"));
    return output({
      ok: true,
      command: "commit",
      status: "blocked",
      reason: "not a git repo",
      recovery: [
        "git init -b main",
        "git add -A && git commit -m \"chore: initial commit\"",
        "node .vela/cli/vela-engine.js transition",
      ],
      message: "Commit blocked — not a git repository. See stderr for recovery steps.",
    });
  }

  // Check for uncommitted changes
  const status = gitExec("status", "--porcelain").trim();
  if (!status) {
    state.git.commit_hash = gitExec("rev-parse", "HEAD").trim();
    state.updated_at = new Date().toISOString();
    writeJSON(state._path, cleanState(state));
    return output({
      ok: true,
      command: "commit",
      action: "no_changes",
      message: "No changes to commit.",
    });
  }

  // Generate conventional commit message
  const pipelineDef = loadPipelineDefinition();
  const typeMap = pipelineDef?.git?.commit?.type_map || {
    code: "feat",
    "code-bug": "fix",
    "code-refactor": "refactor",
    docs: "docs",
    infra: "chore",
  };
  const commitType = typeMap[state.type] || "feat";
  const shortDesc = state.request.substring(0, 70);

  const messageFlag = getFlag("--message");
  const commitMessage = messageFlag || `${commitType}: ${shortDesc}`;

  // Capture diff as artifact
  try {
    const diff = gitExec("diff", "HEAD");
    if (diff && state._artifactDir) {
      fs.writeFileSync(path.join(state._artifactDir, "diff.patch"), diff);
    }
  } catch (e) {}

  // Stage all changes (excluding .vela/ internals)
  try {
    gitExec("add", "-A");
    // Unstage .vela/ internal files
    const velaFiles = [
      ".vela/cache/",
      ".vela/state/",
      ".vela/artifacts/",
      ".vela/tracker-signals.json",
      ".vela/write-log.jsonl",
    ];
    for (const vf of velaFiles) {
      try {
        gitExec("reset", "HEAD", "--", vf);
      } catch (e) {}
    }
  } catch (e) {
    return output({ ok: false, error: `Failed to stage files: ${e.message}` });
  }

  // Commit
  try {
    gitExec("commit", "-m", commitMessage);
  } catch (e) {
    return output({ ok: false, error: `Commit failed: ${e.message}` });
  }

  const commitHash = gitExec("rev-parse", "HEAD").trim();
  state.git.commit_hash = commitHash;
  state.updated_at = new Date().toISOString();
  writeJSON(state._path, cleanState(state));

  output({
    ok: true,
    command: "commit",
    action: "committed",
    hash: commitHash,
    commit_message: commitMessage,
    branch: state.git.current_branch || state.git.pipeline_branch,
    files_in_diff: status.split("\n").length,
    message: `Committed: ${commitMessage} (${commitHash.substring(0, 7)})`,
  });
}

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
function cmdLocate() {
  // Resolve target dir + request
  const requestOverride = getFlag("--request");
  const state = findActiveState();
  let artifactDir;
  let request;

  if (requestOverride) {
    request = requestOverride;
    // When called outside an active pipeline, write to a temp inspection dir
    artifactDir =
      (state && state._artifactDir) || path.join(VELA_DIR, "locate-preview");
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }
  } else {
    if (!state) {
      return output({
        ok: false,
        error:
          "No active pipeline. Pass --request \"...\" to locate without a pipeline.",
      });
    }
    request = state.request;
    artifactDir = state._artifactDir;
  }

  // Lazy-load locate module — keeps engine startup fast for other commands
  let locateMod;
  try {
    // Project-local copy first (post-install layout: .vela/shared/locate.js),
    // fall back to source layout for tests and dev runs.
    const candidates = [
      path.join(CWD, ".vela", "shared", "locate.js"),
      path.join(__dirname, "..", "shared", "locate.js"),
    ];
    let resolved = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        resolved = c;
        break;
      }
    }
    if (!resolved) {
      return output({
        ok: false,
        error:
          "locate.js not found. Run `node scripts/install.js` to deploy shared modules.",
      });
    }
    locateMod = require(resolved);
  } catch (e) {
    return output({ ok: false, error: `Failed to load locate.js: ${e.message}` });
  }

  // Run locate
  let result;
  try {
    result = locateMod.locate(request, { cwd: CWD });
  } catch (e) {
    return output({ ok: false, error: `locate() failed: ${e.message}` });
  }

  // Write targets.json
  const targetsPath = path.join(artifactDir, "targets.json");
  try {
    writeJSON(targetsPath, result);
  } catch (e) {
    return output({
      ok: false,
      error: `Failed to write targets.json: ${e.message}`,
      targets_path: targetsPath,
    });
  }

  // Output summary (or full JSON if --json)
  if (hasFlag("--json")) {
    return output({
      ok: true,
      command: "locate",
      targets_path: targetsPath,
      ...result,
    });
  }

  output({
    ok: true,
    command: "locate",
    targets_path: targetsPath,
    confidence: result.confidence,
    primary_count: result.primary.length,
    primary: result.primary.slice(0, 10).map((p) => ({
      file: p.file,
      symbol: p.symbol,
      lines: p.lines,
      match_source: p.match_source,
    })),
    tests_count: result.tests.length,
    blast_radius_count: result.blast_radius.length,
    warnings: result.warnings,
    backend: locateMod.searchBackend(),
  });
}

function cmdCancel() {
  const state = findActiveState();
  if (!state) {
    return output({ ok: false, error: "No active pipeline to cancel." });
  }

  state.status = "cancelled";
  state.updated_at = new Date().toISOString();

  const recovery = {};
  if (state.git && state.git.is_repo) {
    recovery.checkpoint_hash = state.git.checkpoint_hash;
    recovery.pipeline_branch = state.git.pipeline_branch;
    recovery.base_branch = state.git.base_branch;
    recovery.hint = state.git.pipeline_branch
      ? `To discard pipeline branch: git checkout ${state.git.base_branch} && git branch -d ${state.git.pipeline_branch}`
      : `To see pipeline changes: git diff ${state.git.checkpoint_hash}..HEAD`;
  }

  writeJSON(state._path, cleanState(state));

  output({
    ok: true,
    command: "cancel",
    recovery: recovery,
    message: "Pipeline cancelled.",
  });
}

// ─── Git Clean: Scan (read-only, report findings) ───
function cmdCleanScan() {
  try {
    gitExec("rev-parse", "--git-dir");
  } catch (e) {
    return output({ ok: false, error: "Not a git repository." });
  }

  const findings = {};

  // 1. Tracked-but-ignored files
  findings.trackedIgnored = [];
  try {
    const tracked = gitExec("ls-files").trim().split("\n").filter(Boolean);
    for (const file of tracked) {
      try {
        gitExec("check-ignore", "--no-index", "-q", file);
        findings.trackedIgnored.push(file);
      } catch (e) {
        /* not ignored */
      }
    }
  } catch (e) {}

  // 2. Merged vela/ branches
  findings.mergedBranches = [];
  try {
    const mainBranch = detectMainBranch();
    if (mainBranch) {
      const currentBranch = gitExec("rev-parse", "--abbrev-ref", "HEAD").trim();
      const raw = gitExec("branch", "--merged", mainBranch).trim();
      if (raw) {
        findings.mergedBranches = raw
          .split("\n")
          .map((b) => b.replace("*", "").trim())
          .filter(
            (b) =>
              b.startsWith("vela/") && b !== mainBranch && b !== currentBranch,
          );
      }
    }
  } catch (e) {}

  // 3. Ignored files on disk (git clean preview)
  findings.ignoredFiles = { count: 0, preview: [] };
  try {
    const raw = gitExec("clean", "-fdXn").trim();
    if (raw) {
      const lines = raw.split("\n").filter(Boolean);
      findings.ignoredFiles.count = lines.length;
      findings.ignoredFiles.preview = lines
        .slice(0, 20)
        .map((l) => l.replace(/^Would remove /, ""));
    }
  } catch (e) {}

  // 4. Stale Vela artifacts (7+ days, completed/cancelled)
  findings.staleArtifacts = [];
  if (fs.existsSync(ARTIFACTS_DIR)) {
    try {
      for (const d of fs.readdirSync(ARTIFACTS_DIR)) {
        const sp = path.join(ARTIFACTS_DIR, d, "pipeline-state.json");
        if (!fs.existsSync(sp)) continue;
        try {
          const st = JSON.parse(fs.readFileSync(sp, "utf-8"));
          if (st.status === "completed" || st.status === "cancelled") {
            const daysOld = Math.floor(
              (Date.now() - new Date(st.updated_at || 0).getTime()) / 86400000,
            );
            if (daysOld > 7)
              findings.staleArtifacts.push({
                dir: d,
                status: st.status,
                daysOld,
              });
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 5. Vela cache DB files
  findings.cacheFiles = [];
  const cacheDir = path.join(VELA_DIR, "cache");
  if (fs.existsSync(cacheDir)) {
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        if (/\.db(-journal|-wal|-shm)?$/.test(f)) {
          const stat = fs.statSync(path.join(cacheDir, f));
          findings.cacheFiles.push({
            file: f,
            sizeKB: Math.round(stat.size / 1024),
          });
        }
      }
    } catch (e) {}
  }

  // 6. Remote prunable refs
  findings.prunableRefs = [];
  try {
    const raw = gitExecShell("git remote prune origin --dry-run 2>&1").trim();
    if (raw) {
      const pruned = raw.split("\n").filter((l) => l.includes("[would prune]"));
      findings.prunableRefs = pruned.map((l) =>
        l.replace(/.*\[would prune\]\s*/, "").trim(),
      );
    }
  } catch (e) {}

  const total =
    findings.trackedIgnored.length +
    findings.mergedBranches.length +
    findings.ignoredFiles.count +
    findings.staleArtifacts.length +
    findings.cacheFiles.length +
    findings.prunableRefs.length;

  output({
    ok: true,
    command: "clean-scan",
    findings,
    totalItems: total,
    message:
      total === 0
        ? "✅ 프로젝트가 깨끗합니다."
        : `🧹 ${total}개 항목을 정리할 수 있습니다.`,
  });
}

// ─── Git Clean: Execute selected categories ───
function cmdCleanExec() {
  try {
    gitExec("rev-parse", "--git-dir");
  } catch (e) {
    return output({ ok: false, error: "Not a git repository." });
  }

  const categoriesStr = getFlag("--categories") || "";
  if (!categoriesStr) {
    return output({
      ok: false,
      error:
        "No categories specified. Use --categories tracked,branches,ignored,artifacts,cache,prune",
    });
  }
  const selected = new Set(categoriesStr.split(",").map((s) => s.trim()));
  const actions = [];

  if (selected.has("tracked")) {
    try {
      const tracked = gitExec("ls-files").trim().split("\n").filter(Boolean);
      const toUntrack = [];
      for (const file of tracked) {
        try {
          gitExec("check-ignore", "--no-index", "-q", file);
          toUntrack.push(file);
        } catch (e) {}
      }
      if (toUntrack.length > 0) {
        for (const f of toUntrack) {
          try {
            gitExec("rm", "--cached", f);
          } catch (e) {}
        }
        try {
          gitExecShell("git add .gitignore 2>/dev/null || true");
          gitExec("add", "-u");
          gitExec(
            "commit",
            "-m",
            "chore: untrack ignored files",
            "--no-verify",
          );
        } catch (e) {}
        actions.push({
          type: "untracked",
          count: toUntrack.length,
          files: toUntrack,
        });
      }
    } catch (e) {}
  }

  if (selected.has("branches")) {
    try {
      const mainBranch = detectMainBranch();
      const currentBranch = gitExec("rev-parse", "--abbrev-ref", "HEAD").trim();
      if (mainBranch) {
        const raw = gitExec("branch", "--merged", mainBranch).trim();
        if (raw) {
          raw
            .split("\n")
            .map((b) => b.replace("*", "").trim())
            .filter(
              (b) =>
                b.startsWith("vela/") &&
                b !== mainBranch &&
                b !== currentBranch,
            )
            .forEach((b) => {
              try {
                gitExec("branch", "-d", b);
                actions.push({ type: "branch_deleted", branch: b });
              } catch (e) {}
            });
        }
      }
    } catch (e) {}
  }

  if (selected.has("ignored")) {
    try {
      const cleaned = gitExec("clean", "-fdX").trim();
      if (cleaned)
        actions.push({
          type: "ignored_cleaned",
          count: cleaned.split("\n").filter(Boolean).length,
        });
    } catch (e) {}
  }

  if (selected.has("artifacts")) {
    if (fs.existsSync(ARTIFACTS_DIR)) {
      try {
        for (const d of fs.readdirSync(ARTIFACTS_DIR)) {
          const sp = path.join(ARTIFACTS_DIR, d, "pipeline-state.json");
          if (!fs.existsSync(sp)) continue;
          try {
            const st = JSON.parse(fs.readFileSync(sp, "utf-8"));
            if (
              (st.status === "completed" || st.status === "cancelled") &&
              Math.floor(
                (Date.now() - new Date(st.updated_at || 0).getTime()) /
                  86400000,
              ) > 7
            ) {
              fs.rmSync(path.join(ARTIFACTS_DIR, d), {
                recursive: true,
                force: true,
              });
              actions.push({ type: "artifact_removed", dir: d });
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  if (selected.has("cache")) {
    const cacheDir = path.join(VELA_DIR, "cache");
    if (fs.existsSync(cacheDir)) {
      try {
        for (const f of fs.readdirSync(cacheDir)) {
          if (/\.db(-journal|-wal|-shm)?$/.test(f)) {
            fs.unlinkSync(path.join(cacheDir, f));
            actions.push({ type: "cache_removed", file: f });
          }
        }
      } catch (e) {}
    }
  }

  if (selected.has("prune")) {
    try {
      gitExec("remote", "prune", "origin");
      actions.push({ type: "remote_pruned" });
    } catch (e) {}
  }

  output({
    ok: true,
    command: "clean-exec",
    actions,
    message: `🧹 ${actions.length}개 작업 완료.`,
  });
}

function detectMainBranch() {
  try {
    gitExec("rev-parse", "--verify", "main");
    return "main";
  } catch (e) {}
  try {
    gitExec("rev-parse", "--verify", "master");
    return "master";
  } catch (e) {}
  return null;
}

function cmdHistory() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    return output({
      ok: true,
      command: "history",
      pipelines: [],
      message: "No pipeline history.",
    });
  }

  const pipelines = [];
  try {
    const allDirs = fs.readdirSync(ARTIFACTS_DIR).sort().reverse();

    // Flat: {YYYYMMDD}T{HHmmss}-{slug}/
    for (const dir of allDirs.filter((d) => /^\d{8}T\d{6}-/.test(d))) {
      const dirPath = path.join(ARTIFACTS_DIR, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const statePath = path.join(dirPath, "pipeline-state.json");
      if (!fs.existsSync(statePath)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        pipelines.push({
          date: dir.slice(0, 8),
          slug: dir,
          status: state.status,
          type: state.pipeline_type,
          request: (state.request || "").substring(0, 60),
          step: state.current_step,
          steps_completed: (state.completed_steps || []).length,
          steps_total: (state.steps || []).length,
          created: state.created_at,
          updated: state.updated_at,
        });
      } catch (e) {}
    }

  } catch (e) {}

  output({
    ok: true,
    command: "history",
    count: pipelines.length,
    pipelines: pipelines,
  });
}

// ─── Helpers ───

// getOrCreateTeam REMOVED (V4.1). V6 uses Agent(subagent_type=...) directly.

function findActiveState() {
  if (!fs.existsSync(ARTIFACTS_DIR)) return null;

  try {
    const allDirs = fs.readdirSync(ARTIFACTS_DIR).sort().reverse();

    // Flat: {YYYYMMDD}T{HHmmss}-{slug}/
    for (const dir of allDirs.filter((d) => /^\d{8}T\d{6}-/.test(d))) {
      const dirPath = path.join(ARTIFACTS_DIR, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const statePath = path.join(dirPath, "pipeline-state.json");
      if (!fs.existsSync(statePath)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        if (state.status === "completed" || state.status === "cancelled")
          continue;
        state._path = statePath;
        state._artifactDir = dirPath;
        // Mark stale if untouched for 24 hours
        const mtime = fs.statSync(statePath).mtimeMs;
        if (Date.now() - mtime > 24 * 60 * 60 * 1000) {
          state._stale = true;
        }
        return state;
      } catch (e) {
        continue;
      }
    }

  } catch (e) {}

  return null;
}

function loadPipelineDefinition() {
  const pipelinePath = path.join(TEMPLATES_DIR, "pipeline.json");
  if (!fs.existsSync(pipelinePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pipelinePath, "utf-8"));
  } catch (e) {
    return null;
  }
}

function resolveSteps(pipelineDef, pipelineType) {
  if (!pipelineDef) return [];
  const pipeline = pipelineDef.pipelines[pipelineType || "standard"];
  if (!pipeline) return [];

  // Resolve base step list:
  //   - inherits + steps_only → pull from parent, filter by steps_only
  //   - no inherits + steps_only → own `steps` array, filter by steps_only
  //     (this is the case for "standard" after v7.0 skeleton commit —
  //     the steps array contains extra v7 skeletons like spec/patch
  //     that must be excluded from the default standard flow)
  //   - no steps_only → own `steps` array as-is
  let steps;
  if (pipeline.inherits) {
    const parent = pipelineDef.pipelines[pipeline.inherits];
    if (!parent) return [];
    steps = pipeline.steps_only
      ? parent.steps.filter((s) => pipeline.steps_only.includes(s.id))
      : parent.steps;
  } else {
    steps = pipeline.steps_only
      ? pipeline.steps.filter((s) => pipeline.steps_only.includes(s.id))
      : pipeline.steps;
  }

  // Apply per-step overrides if declared
  if (pipeline.overrides) {
    steps = steps.map((s) =>
      pipeline.overrides[s.id] ? { ...s, ...pipeline.overrides[s.id] } : s,
    );
  }

  return steps;
}

function checkExitGate(stepDef, state) {
  if (!stepDef || !stepDef.exit_gate || stepDef.exit_gate.length === 0) {
    return { passed: true, missing: [] };
  }

  const artifactDir = state._artifactDir;
  const missing = [];

  for (const gate of stepDef.exit_gate) {
    switch (gate) {
      case "artifact_dir_created":
        if (!artifactDir || !fs.existsSync(artifactDir)) missing.push(gate);
        break;
      case "mode_detected":
        // Always passes after init
        break;
      case "init_complete":
        if (!state.completed_steps.includes("init")) missing.push(gate);
        break;
      case "research_md_exists":
        if (
          !artifactDir ||
          !fs.existsSync(path.join(artifactDir, "research.md"))
        )
          missing.push(gate);
        break;
      case "targets_json_exists":
        // v6.1 universal locate gate — every pipeline scale's `locate` step
        // produces this artifact via `vela-engine locate`
        if (
          !artifactDir ||
          !fs.existsSync(path.join(artifactDir, "targets.json"))
        )
          missing.push(gate);
        break;
      case "plan_md_exists":
        if (!artifactDir || !fs.existsSync(path.join(artifactDir, "plan.md")))
          missing.push(gate);
        break;
      case "plan_check_pass":
        if (
          !artifactDir ||
          !fs.existsSync(path.join(artifactDir, "plan-check.md"))
        )
          missing.push(gate);
        break;
      case "user_approved":
        // Checkpoint is acknowledged when a record has been made for this step.
        // We check revisions instead of completed_steps because transition()
        // adds to completed_steps AFTER the exit gate check.
        if (
          state.current_step === "checkpoint" &&
          (!state.revisions.checkpoint || state.revisions.checkpoint < 1)
        ) {
          // Auto mode: if plan-check.md exists, auto-pass the checkpoint
          if (
            state.auto === true &&
            state.current_step === "checkpoint" &&
            artifactDir &&
            fs.existsSync(path.join(artifactDir, "plan-check.md"))
          ) {
            // plan-check gate passed — auto-approve checkpoint
            break;
          }
          missing.push(gate);
        }
        break;
      case "patch_spec_complete":
        // v7.0 skeleton exit gate — patch-spec.md must exist with required
        // sections. Mirrors plan_architecture_complete but for spec stage.
        // Required sections: ## Before, ## After, ## Explicitly out of scope
        if (artifactDir && fs.existsSync(path.join(artifactDir, "patch-spec.md"))) {
          const specContent = fs.readFileSync(
            path.join(artifactDir, "patch-spec.md"),
            "utf-8",
          );
          const required = [
            "## Before",
            "## After",
            "## Explicitly out of scope",
          ];
          for (const section of required) {
            if (!specContent.includes(section)) {
              missing.push(`patch_spec_missing_section:${section}`);
            }
          }
        } else {
          missing.push("patch_spec_missing:patch-spec.md");
        }
        break;
      case "plan_architecture_complete":
        // Standard pipeline: plan.md must contain architecture sections with substance
        if (artifactDir && fs.existsSync(path.join(artifactDir, "plan.md"))) {
          const planContent = fs.readFileSync(
            path.join(artifactDir, "plan.md"),
            "utf-8",
          );
          const requiredSections = [
            "## Architecture",
            "## Class Specification",
            "## Test Strategy",
          ];
          for (const section of requiredSections) {
            if (!planContent.includes(section)) {
              missing.push(`plan_missing_section:${section}`);
            } else {
              // Check section has substance (not just a header)
              const sectionIdx = planContent.indexOf(section);
              const nextSectionIdx = planContent.indexOf(
                "\n## ",
                sectionIdx + section.length,
              );
              const sectionContent =
                nextSectionIdx > 0
                  ? planContent.substring(
                      sectionIdx + section.length,
                      nextSectionIdx,
                    )
                  : planContent.substring(sectionIdx + section.length);
              if (sectionContent.trim().length < 200) {
                missing.push(`plan_section_too_short:${section}`);
              }
            }
          }
        }
        break;
      case "approval_exists":
      case "leader_approved": // backward compatibility
        // File-based: PM writes approval-{step}.json with decision: "approve"
        if (artifactDir) {
          const approvalPath = path.join(
            artifactDir,
            `approval-${state.current_step}.json`,
          );
          if (!fs.existsSync(approvalPath)) {
            missing.push(
              `approval_missing:approval-${state.current_step}.json`,
            );
          } else {
            try {
              const approval = JSON.parse(
                fs.readFileSync(approvalPath, "utf-8"),
              );
              if (approval.decision !== "approve") {
                missing.push(`rejected:${state.current_step}`);
              }
            } catch (e) {
              missing.push(`approval_invalid:${state.current_step}`);
            }
          }
        }
        break;
      case "review_exists":
      case "leader_review_exists": // backward compatibility
        // Reviewer subagent writes review-{step}.md
        if (artifactDir) {
          const reviewPath = path.join(
            artifactDir,
            `review-${state.current_step}.md`,
          );
          if (!fs.existsSync(reviewPath)) {
            missing.push(`review_missing:review-${state.current_step}.md`);
          }
        }
        break;
      case "implementation_complete":
        // File-based: approval-{current_step}.json must exist with decision: "approve"
        // v7.0: this gate is reused by both the legacy `execute` step and the
        // new `patch` step (surgical pipeline). Resolve the approval filename
        // from state.current_step so both steps share one implementation.
        if (artifactDir) {
          const implStep = state.current_step || "execute";
          const approvalFile = `approval-${implStep}.json`;
          const implApprovalPath = path.join(artifactDir, approvalFile);
          if (!fs.existsSync(implApprovalPath)) {
            missing.push(`approval_missing:${approvalFile}`);
          } else {
            try {
              const approval = JSON.parse(
                fs.readFileSync(implApprovalPath, "utf-8"),
              );
              if (approval.decision !== "approve") {
                missing.push(`rejected:${implStep}`);
              }
            } catch (e) {
              missing.push(`approval_invalid:${implStep}`);
            }
          }
        }
        break;
      case "git_clean":
        // Init gate: working tree must be clean (checked during init, always passes after)
        break;
      case "branch_created":
        // Branch gate: pipeline branch recorded in state
        if (state.git && state.git.is_repo) {
          if (!state.git.pipeline_branch && state.current_step === "branch") {
            // Check if branch step was recorded (revisions > 0)
            if (!state.revisions.branch || state.revisions.branch < 1) {
              missing.push(gate);
            }
          }
        }
        break;
      case "changes_committed":
        // Commit gate: commit hash recorded in state
        if (state.git && state.git.is_repo) {
          if (!state.git.commit_hash && state.current_step === "commit") {
            if (!state.revisions.commit || state.revisions.commit < 1) {
              missing.push(gate);
            }
          }
        }
        break;
      case "verification_md_exists":
        if (
          !artifactDir ||
          (!fs.existsSync(path.join(artifactDir, "verification.md")) &&
            !fs.existsSync(path.join(artifactDir, "verify.md")))
        )
          missing.push(gate);
        break;
      case "report_md_exists":
        // Finalize gate - report is the output of this step
        break;
      case "ref_integrity": {
        // Change Surface Analysis — verify no broken cross-file references
        const baselineSha =
          state.baseline_sha || (state.git && state.git.checkpoint_hash);
        if (!baselineSha) {
          // Legacy pipeline without baseline — skip gracefully
          break;
        }
        try {
          const configPath = path.join(VELA_DIR, "templates", "config.json");
          let csaOpts = {};
          if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            if (cfg.changeSurface) {
              if (cfg.changeSurface.enabled === false) break;
              if (cfg.changeSurface.excludePaths) {
                csaOpts.excludePaths = cfg.changeSurface.excludePaths;
              }
            }
          }
          const { analyze } = require("../shared/change-surface.js");
          const result = analyze(baselineSha, { cwd: CWD, ...csaOpts });
          if (!result.verdict.pass) {
            missing.push(
              `ref_integrity_fail:${result.verdict.errorCount} broken ref(s)`,
            );
          }
        } catch (e) {
          // CSA module error — don't block pipeline, warn only
          console.error(`[ref_integrity] Warning: ${e.message}`);
        }
        break;
      }
      default:
        // Unknown gate, skip
        break;
    }
  }

  return { passed: missing.length === 0, missing };
}

/**
 * @deprecated since v6.1 — scheduled for removal in v7.0.
 *
 * Word-count heuristic doesn't reflect actual work weight.
 * Users should pick scale explicitly via /vela:small, /vela:medium,
 * /vela:large, /vela:ralph, or /vela:hotfix. When --scale is omitted,
 * cmdInit() now falls back to "medium" with a deprecation warning
 * instead of calling this function.
 *
 * Left in place only to avoid breaking any external callers that
 * require('./vela-engine') this module. Will be deleted in v7.0
 * along with the /vela:start slash command removal.
 */
function autoDetectScale(request) {
  const words = request.split(/\s+/).length;
  if (words <= 10) return "small";
  if (words <= 30) return "medium";
  return "large";
}

/**
 * v7.1 M5: fs-safe slugify.
 *
 * Pre-v7.1 this used `.substring(0, 30)`, a JS char count. In the hicoco
 * session Korean requests produced artifact directories named
 * "별도-downloa", "대상-사이", "baseurl" — the 30-char limit truncated
 * mid-word because a Korean syllable is 1 JS char but 3 UTF-8 bytes, and
 * nothing enforced cutting on a word boundary.
 *
 * v7.1 behaviour:
 *   1. normalise (lowercase, strip non-[a-z0-9가-힣] except `-` and space)
 *   2. collapse whitespace to `-`
 *   3. cap at 64 UTF-8 bytes, not chars
 *   4. if we had to truncate, walk back to the nearest `-` boundary so we
 *      never cut through a word or a multi-byte codepoint
 *   5. if truncated, append `-trunc` so the caller can tell at a glance
 *
 * Returns an object so callers can decide whether to write a side-car
 * request.txt with the full original request (cmdInit does this when
 * truncated).
 */
function slugifyEx(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const MAX_BYTES = 64;
  // v7.1 M5: always leave headroom for the "-trunc" suffix. Pre-v7.1 the
  // cap was applied first and the suffix was appended afterwards, which
  // meant a request that landed at exactly MAX_BYTES would overflow once
  // "-trunc" got tacked on. Budget the suffix in from the start so the
  // post-truncate directory name is guaranteed ≤ MAX_BYTES.
  const TRUNC_SUFFIX = "-trunc";
  const BUDGET = MAX_BYTES - Buffer.byteLength(TRUNC_SUFFIX, "utf8");

  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes <= MAX_BYTES) {
    return { slug: normalized || "task", truncated: false };
  }

  // Walk down codepoint by codepoint until we are within the byte budget.
  // Buffer.byteLength is the authoritative check — substring() would
  // happily split a multi-byte char.
  let cut = normalized;
  while (Buffer.byteLength(cut, "utf8") > BUDGET) {
    cut = cut.slice(0, -1);
  }
  // Prefer a `-` boundary so we never cut mid-word.
  const lastDash = cut.lastIndexOf("-");
  if (lastDash > 8) {
    // Only snap back if we keep at least 8 chars — don't collapse a long
    // request into "a-trunc" because the first word happened to be "a-".
    cut = cut.slice(0, lastDash);
  }
  cut = cut.replace(/-+$/g, "");
  if (!cut) cut = "task";
  return { slug: cut + TRUNC_SUFFIX, truncated: true, originalBytes: bytes };
}

/**
 * Back-compat wrapper. Existing callers (cmdBranch, cmdInit) used to get a
 * plain string, so slugify() still does. Use slugifyEx() when you need the
 * truncation flag — cmdInit does, because it writes a request.txt side-car
 * when the slug had to be shortened.
 */
function slugify(text) {
  return slugifyEx(text).slug;
}

function cleanState(state) {
  const clean = { ...state };
  delete clean._path;
  delete clean._artifactDir;
  delete clean._stale;
  return clean;
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2));
}

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

/**
 * Remove cancelled pipeline artifact directories older than `hoursOld` hours.
 * Only deletes directories where pipeline-state.json has status: "cancelled".
 * Completed pipelines are preserved (they contain reports and history).
 * Returns count of cleaned directories.
 */
function cleanupCancelledArtifacts(hoursOld) {
  if (!fs.existsSync(ARTIFACTS_DIR)) return 0;

  const cutoff = Date.now() - hoursOld * 60 * 60 * 1000;
  let cleaned = 0;

  function tryCleanDir(dirPath) {
    const statePath = path.join(dirPath, "pipeline-state.json");

    // Remove empty artifact directories (no pipeline-state.json = never used)
    if (!fs.existsSync(statePath)) {
      try {
        const files = fs.readdirSync(dirPath);
        if (files.length === 0) {
          fs.rmdirSync(dirPath);
          cleaned++;
        }
      } catch (e) {}
      return;
    }

    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // Clean cancelled and completed pipelines older than cutoff
      if (state.status !== "cancelled" && state.status !== "completed") return;
      const mtime = fs.statSync(statePath).mtimeMs;
      if (mtime > cutoff) return;
      fs.rmSync(dirPath, { recursive: true, force: true });
      cleaned++;
    } catch (e) {}
  }

  try {
    const allDirs = fs.readdirSync(ARTIFACTS_DIR);

    // Flat: {YYYYMMDD}T{HHmmss}-{slug}/
    for (const dir of allDirs.filter((d) => /^\d{8}T\d{6}-/.test(d))) {
      const dirPath = path.join(ARTIFACTS_DIR, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      tryCleanDir(dirPath);
    }

  } catch (e) {}

  return cleaned;
}

// ─── Git Helpers ───

function gitExec(...args) {
  return execFileSync("git", args, {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  }).toString();
}

function gitExecShell(cmd) {
  return execSync(cmd, {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  }).toString();
}

function snapshotGitState() {
  try {
    gitExec("rev-parse", "--git-dir");
  } catch (e) {
    return { is_repo: false };
  }

  try {
    const currentBranch = gitExec("rev-parse", "--abbrev-ref", "HEAD").trim();
    // -uno: exclude untracked files from dirty check — untracked files
    // (e.g. .bg-shell/, src/test/) should not block pipeline init
    const status = gitExec("status", "--porcelain", "-uno").trim();
    const headHash = gitExec("rev-parse", "HEAD").trim();

    let remote = null;
    try {
      remote = gitExec("remote").trim().split("\n")[0] || null;
    } catch (e) {}

    return {
      is_repo: true,
      current_branch: currentBranch,
      is_clean: status === "",
      dirty_files: status ? status.split("\n").length : 0,
      head_hash: headHash,
      remote: remote,
      is_protected: PROTECTED_BRANCHES.includes(currentBranch),
    };
  } catch (e) {
    return { is_repo: true, error: e.message };
  }
}

function ensureGitignore() {
  const gitignorePath = path.join(CWD, ".gitignore");
  const velaEntries = [
    "# Vela Engine (auto-managed)",
    ".vela/",
    ".claude/",
    "CLAUDE.md",
  ];

  // Step 1: Remove already-tracked Vela files BEFORE updating .gitignore
  // (if .gitignore lists them first, git silently drops the staged deletions)
  try {
    const tracked = execSync("git ls-files .vela/ .claude/ CLAUDE.md", {
      cwd: CWD,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (tracked) {
      execSync(
        "git rm -r --cached --ignore-unmatch .vela/ .claude/ CLAUDE.md",
        {
          cwd: CWD,
          stdio: "pipe",
          timeout: 10000,
        },
      );
      execSync(
        'git commit -m "chore: untrack Vela files from git" --no-verify',
        {
          cwd: CWD,
          stdio: "pipe",
          timeout: 10000,
        },
      );
    }
  } catch (e) {
    // Not a git repo, git not available, or nothing to commit — skip
  }

  // Step 2: Update .gitignore (after deletions are committed)
  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf-8");
  }

  const missingEntries = velaEntries.filter(
    (entry) => !entry.startsWith("#") && !content.includes(entry),
  );

  if (missingEntries.length > 0) {
    if (!content.includes("# Vela Engine")) {
      fs.appendFileSync(gitignorePath, "\n" + velaEntries.join("\n") + "\n");
    } else {
      fs.appendFileSync(gitignorePath, missingEntries.join("\n") + "\n");
    }
  }
}
