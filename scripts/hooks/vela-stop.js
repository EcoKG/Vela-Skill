#!/usr/bin/env node
/**
 * Vela Stop Hook — Claude Code StopHook Handler
 *
 * Called when Claude Code's main loop is about to stop.
 * If an auto-mode pipeline is active, outputs a block decision
 * to prevent premature session termination.
 *
 * Crash-safe: the .catch() handler always outputs a block decision
 * with the error message and exits 0, ensuring Claude Code sees the
 * block even when an unexpected error occurs.
 *
 * Output format (stdout): JSON with `decision: "block"` field.
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
 * Find the active pipeline state. Returns null if none found.
 */
function findActivePipelineState(cwd) {
  const artifactsDir = path.join(cwd, ".vela", "artifacts");
  if (!fs.existsSync(artifactsDir)) return null;

  const dirs = fs
    .readdirSync(artifactsDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}_/.test(d))
    .sort()
    .reverse();

  for (const dir of dirs) {
    const statePath = path.join(artifactsDir, dir, "pipeline-state.json");
    if (!fs.existsSync(statePath)) continue;
    const state = parseJsonSafe(fs.readFileSync(statePath, "utf8"));
    if (state && state.status === "active") return state;
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const input = parseJsonSafe(raw) || {};

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();

  // Find active pipeline
  const pipelineState = findActivePipelineState(cwd);

  if (pipelineState && pipelineState.auto === true) {
    // Auto-mode pipeline is active — block premature stop
    const output = {
      decision: "block",
      reason: `Auto-mode pipeline is active (step: ${pipelineState.current_step || "unknown"}). Continue until pipeline completes.`,
    };
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: (e && e.message) ? e.message : "Unexpected error in vela-stop hook",
    })
  );
  process.exit(0);
});
