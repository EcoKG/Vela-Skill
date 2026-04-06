#!/usr/bin/env node
/**
 * Vela Compact Hook — Claude Code PreCompact / PostCompact Hook
 *
 * PreCompact:  Saves active pipeline context to .vela/state/compact-context.json.
 *              Produces no stdout output (silent save).
 *
 * PostCompact: Reads saved context and injects it back as additionalContext
 *              so Claude Code restores pipeline state after compaction.
 *
 * Exit codes:
 *   0 — continue (normal)
 *   Non-zero errors are suppressed to avoid blocking compaction.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Helpers ────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function parseJsonSafe(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Find the active pipeline state.
 * Returns { state, artifactDir } or null if none found.
 */
function findActivePipeline(cwd) {
  try {
    const artifactsDir = path.join(cwd, ".vela", "artifacts");
    if (!fs.existsSync(artifactsDir)) return null;

    const dirs = fs
      .readdirSync(artifactsDir)
      .filter((d) => /^\d{8}T\d{6}-/.test(d))
      .sort()
      .reverse();

    for (const dir of dirs) {
      try {
        const artifactDir = path.join(artifactsDir, dir);
        const statePath = path.join(artifactDir, "pipeline-state.json");
        if (!fs.existsSync(statePath)) continue;
        const state = parseJsonSafe(fs.readFileSync(statePath, "utf8"));
        if (state && state.status === "active") {
          return { state, artifactDir };
        }
      } catch {
        // skip
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const input = parseJsonSafe(raw) || {};

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const eventType = input.hook_event_name || "";
  const stateDir = path.join(cwd, ".vela", "state");
  const contextPath = path.join(stateDir, "compact-context.json");

  if (eventType === "PreCompact") {
    // Save active pipeline context (silent — no stdout)
    try {
      const pipelineResult = findActivePipeline(cwd);
      const context = {
        timestamp: new Date().toISOString(),
        cwd,
        activePipeline: pipelineResult ? pipelineResult.state : null,
        artifactDir: pipelineResult ? pipelineResult.artifactDir : null,
      };
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf8");
    } catch {
      // Silent — never fail compaction
    }
    process.exit(0);
  }

  if (eventType === "PostCompact") {
    // Read saved context and inject as additionalContext
    try {
      let savedContext = null;
      if (fs.existsSync(contextPath)) {
        savedContext = parseJsonSafe(fs.readFileSync(contextPath, "utf8"));
      }

      const pipeline = savedContext && savedContext.activePipeline;
      const lines = ["⛵ Vela Pipeline Context (restored after compaction)"];

      if (pipeline) {
        lines.push(`- Pipeline type: ${pipeline.pipeline_type || "unknown"}`);
        lines.push(`- Current step: ${pipeline.current_step || "unknown"}`);
        lines.push(`- Status: ${pipeline.status || "unknown"}`);
        if (pipeline.request) {
          lines.push(`- Request: ${pipeline.request}`);
        }
      } else {
        lines.push("- No active pipeline at time of compaction.");
      }

      const output = {
        additionalContext: lines.join("\n"),
      };
      process.stdout.write(JSON.stringify(output));
    } catch {
      // Fallback: minimal additionalContext
      process.stdout.write(
        JSON.stringify({ additionalContext: "⛵ Vela context: compaction complete." })
      );
    }
    process.exit(0);
  }

  // Unknown event — silent exit
  process.exit(0);
}

main().catch(() => process.exit(0));
