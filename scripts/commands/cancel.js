/**
 * Vela command — `cancel` (v7.3-M4e-p4)
 *
 * Extracted from scripts/cli/vela-engine.js. Marks the active
 * pipeline as cancelled and emits recovery hints so the user can
 * inspect or roll back the pipeline's work:
 *
 *   recovery.checkpoint_hash  the HEAD at pipeline init
 *   recovery.pipeline_branch  the branch vela-engine created (if any)
 *   recovery.base_branch      the branch the pipeline forked from
 *   recovery.hint             a ready-to-run git command
 *
 * Writing status="cancelled" also tells findActiveState() to stop
 * returning this record, so subsequent init calls can claim a fresh
 * artifact dir without --force.
 */

"use strict";

module.exports = function createCmdCancel(ctx) {
  const { findActiveState, cleanState, writeJSON, output } = ctx;

  return function cmdCancel() {
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
  };
};
