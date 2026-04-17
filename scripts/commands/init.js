/**
 * Vela command — `init` (v7.3-M4e-p3)
 *
 * Extracted from scripts/cli/vela-engine.js. Bootstraps a pipeline:
 *   1. validate request + block if another pipeline is active
 *   2. prune cancelled/completed artifacts older than 24h
 *   3. load pipeline definition + resolve scale → pipeline_type
 *   4. snapshot git state (block dirty tree unless --force)
 *   5. ensure .gitignore hides Vela internals
 *   6. mint artifact dir {YYYYMMDD}T{HHmmss}-{slug}
 *   7. write pipeline-state.json + meta.json (atomic)
 *   8. emit JSON response with next-step info
 *
 * All dependencies are injected via `ctx` (built once in vela-engine.js
 * after the core/* factory calls). This module has no module-level state
 * so it can be required multiple times without side effects.
 */

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function createCmdInit(ctx) {
  const {
    ARTIFACTS_DIR,
    getArg,
    getFlag,
    hasFlag,
    findActiveState,
    cleanupCancelledArtifacts,
    loadPipelineDefinition,
    resolveSteps,
    snapshotGitState,
    ensureGitignore,
    slugifyEx,
    writeJSON,
    output,
  } = ctx;

  return function cmdInit() {
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
  };
};
