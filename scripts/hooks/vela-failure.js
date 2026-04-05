#!/usr/bin/env node
/**
 * Vela Failure Hook — Claude Code PostToolUse Failure Handler
 *
 * Tracks consecutive tool failures per pipeline step.
 * Resets the counter when the pipeline step changes (step transition reset).
 *
 * State file: .vela/state/failure-counter.json
 *   { count: number, step: string }
 *
 * Behavior:
 *   - On each tool failure: increment counter
 *   - On step change: reset counter to 1 (the current failure)
 *   - Always exits 0 (failure tracking is observational, not blocking)
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
  try {
    const artifactsDir = path.join(cwd, ".vela", "artifacts");
    if (!fs.existsSync(artifactsDir)) return null;

    const dirs = fs
      .readdirSync(artifactsDir)
      .filter((d) => /^\d{4}-\d{2}-\d{2}_/.test(d))
      .sort()
      .reverse();

    for (const dir of dirs) {
      try {
        const statePath = path.join(artifactsDir, dir, "pipeline-state.json");
        if (!fs.existsSync(statePath)) continue;
        const state = parseJsonSafe(fs.readFileSync(statePath, "utf8"));
        if (state && state.status === "active") return state;
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
  const stateDir = path.join(cwd, ".vela", "state");
  const counterPath = path.join(stateDir, "failure-counter.json");

  // Get current pipeline step
  const pipelineState = findActivePipelineState(cwd);
  const currentStep = (pipelineState && pipelineState.current_step) || "unknown";

  // Load existing counter
  let counter = null;
  try {
    if (fs.existsSync(counterPath)) {
      counter = parseJsonSafe(fs.readFileSync(counterPath, "utf8"));
    }
  } catch {
    counter = null;
  }

  let newCount;
  if (!counter || counter.step !== currentStep) {
    // Step transition (or first failure): reset to 1
    newCount = 1;
  } else {
    // Same step: increment
    newCount = (counter.count || 0) + 1;
  }

  // Save updated counter
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      counterPath,
      JSON.stringify({ count: newCount, step: currentStep }, null, 2),
      "utf8"
    );
  } catch {
    // Silent — never block on failure tracking errors
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
