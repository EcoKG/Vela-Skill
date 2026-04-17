/**
 * Vela command — `commit` (v7.3-M4e-p3)
 *
 * Extracted from scripts/cli/vela-engine.js. Commits the active
 * pipeline's changes with a conventional-commits message, writing
 * diff.patch to the artifact dir and recording the commit hash
 * back into pipeline-state.json.
 *
 * Behavior:
 *   - Non-git project → loud stderr banner + status:"blocked"
 *   - No changes to commit → record HEAD as commit_hash + no_changes
 *   - Message generation: {type}: {request[0:70]} (from state.type)
 *     or --message override
 *   - `.vela/` internal files are explicitly unstaged before commit
 */

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function createCmdCommit(ctx) {
  const {
    getFlag,
    findActiveState,
    loadPipelineDefinition,
    gitExec,
    cleanState,
    writeJSON,
    output,
  } = ctx;

  return function cmdCommit() {
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
        "  vela-engine transition",
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
          "vela-engine transition",
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
  };
};
