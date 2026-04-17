/**
 * Vela Core — Pipeline state I/O (v7.3-M4e)
 *
 * Extracted from scripts/cli/vela-engine.js during the v8.0 engine
 * decomposition. Owns every direct read/write of
 *   .vela/artifacts/{YYYYMMDD}T{HHmmss}-{slug}/pipeline-state.json
 *
 * Two concerns:
 *
 *   findActiveState()
 *     Scan the artifacts dir newest-first, return the first
 *     non-completed / non-cancelled pipeline-state.json it finds.
 *     Decorates the returned state with three underscore-prefixed
 *     internal fields (stripped by cleanState before serialisation):
 *       _path          absolute path to pipeline-state.json
 *       _artifactDir   absolute path to the containing artifact dir
 *       _stale         true if the state file hasn't been touched in 24h
 *
 *   cleanupCancelledArtifacts(hoursOld)
 *     Remove empty artifact dirs (never-written) plus cancelled/
 *     completed dirs older than `hoursOld` hours. Called from cmdInit
 *     to keep .vela/artifacts/ from growing unbounded.
 *
 * Both are bound to an artifactsDir at factory-call time so the 10+
 * call sites inside vela-engine.js don't have to thread the path
 * through every invocation.
 *
 * Usage:
 *   const { findActiveState, cleanupCancelledArtifacts } =
 *     require("../core/state")(ARTIFACTS_DIR);
 */

"use strict";

const fs = require("fs");
const path = require("path");

const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} artifactsDir — absolute path to .vela/artifacts/
 */
function createStateIO(artifactsDir) {
  function findActiveState() {
    if (!fs.existsSync(artifactsDir)) return null;

    try {
      const allDirs = fs.readdirSync(artifactsDir).sort().reverse();

      // Flat: {YYYYMMDD}T{HHmmss}-{slug}/
      for (const dir of allDirs.filter((d) => /^\d{8}T\d{6}-/.test(d))) {
        const dirPath = path.join(artifactsDir, dir);
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
          if (Date.now() - mtime > STALE_MS) {
            state._stale = true;
          }
          return state;
        } catch (e) {
          continue;
        }
      }
    } catch (e) {
      /* skip */
    }

    return null;
  }

  /**
   * Remove cancelled/completed pipeline artifact directories older than
   * `hoursOld` hours AND empty artifact directories (no
   * pipeline-state.json = never used). Returns the count of cleaned
   * directories. Active pipelines are always preserved.
   */
  function cleanupCancelledArtifacts(hoursOld) {
    if (!fs.existsSync(artifactsDir)) return 0;

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
      const allDirs = fs.readdirSync(artifactsDir);

      // Flat: {YYYYMMDD}T{HHmmss}-{slug}/
      for (const dir of allDirs.filter((d) => /^\d{8}T\d{6}-/.test(d))) {
        const dirPath = path.join(artifactsDir, dir);
        try {
          if (!fs.statSync(dirPath).isDirectory()) continue;
        } catch {
          continue;
        }
        tryCleanDir(dirPath);
      }
    } catch (e) {
      /* skip */
    }

    return cleaned;
  }

  return { findActiveState, cleanupCancelledArtifacts };
}

module.exports = createStateIO;
