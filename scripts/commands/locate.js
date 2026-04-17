/**
 * Vela command — `locate` (v7.3-M4e-p4)
 *
 * Extracted from scripts/cli/vela-engine.js. Runs the mechanical
 * Universal Locate algorithm (scripts/shared/locate.js, v6.1) against
 * the active pipeline's request and writes
 *   {artifactDir}/targets.json
 *
 * LLM-free — deterministic grep + git ls-files. Used by every
 * pipeline scale's `locate` step to hand downstream agents a precise
 * file:line target list.
 *
 * Flags:
 *   --request "..."   Override the request (defaults to active pipeline's)
 *   --json            Print the full targets.json instead of the summary
 *
 * Exit gate dependency:
 *   targets_json_exists  (checked by core/pipeline.js checkExitGate)
 */

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function createCmdLocate(ctx) {
  const { CWD, VELA_DIR, getFlag, hasFlag, findActiveState, writeJSON, output } = ctx;

  return function cmdLocate() {
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

    // Lazy-load locate module — keeps engine startup fast for other commands.
    // Both `scripts/commands/` (this file) and the old `scripts/cli/` layout
    // are siblings of `scripts/shared/`, so the `../shared/locate.js`
    // fallback resolves correctly from either location.
    let locateMod;
    try {
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
  };
};
