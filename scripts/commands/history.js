/**
 * Vela command — `history` (v7.3-M4e-p4)
 *
 * Extracted from scripts/cli/vela-engine.js. Lists every pipeline
 * artifact directory under .vela/artifacts/{YYYYMMDD}T{HHmmss}-{slug}/
 * newest-first, surfacing status, scale, current step, and completion
 * progress. Read-only — never modifies any state files.
 *
 * Each entry trims the request to 60 chars so terminal output stays
 * scannable. For full state, read the underlying pipeline-state.json.
 */

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function createCmdHistory(ctx) {
  const { ARTIFACTS_DIR, output } = ctx;

  return function cmdHistory() {
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
  };
};
