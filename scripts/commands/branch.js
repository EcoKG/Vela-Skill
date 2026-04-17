/**
 * Vela command — `branch` (v7.3-M4e-p3)
 *
 * Extracted from scripts/cli/vela-engine.js. Creates (or reuses) a
 * feature branch for the active pipeline.
 *
 * Modes (via --mode flag):
 *   auto    (default)  create vela/{slug}-{HHMM} and checkout
 *   prompt             return the suggested command, don't run it
 *   none               record the current branch as pipeline_branch, skip
 *
 * Behavior:
 *   - If already on a non-protected branch → use it as pipeline_branch
 *   - If on main/master/develop → generate branch name from request slug
 *   - Non-git repos → emit fail-loud stderr banner + status:"blocked"
 */

"use strict";

module.exports = function createCmdBranch(ctx) {
  const {
    PROTECTED_BRANCHES,
    getFlag,
    findActiveState,
    gitExec,
    slugify,
    cleanState,
    writeJSON,
    output,
  } = ctx;

  return function cmdBranch() {
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
        "  vela-engine transition",
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
          "vela-engine transition",
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
  };
};
