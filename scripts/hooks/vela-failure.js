#!/usr/bin/env node
/**
 * Vela Failure Hook — Claude Code PostToolUse Error Tracker
 *
 * Registered as PostToolUse (ToolError is not a valid Claude Code hook event).
 * Fires on every tool call; only increments counter when tool_response
 * indicates an actual error (exit code, error message patterns, is_error).
 *
 * State files:
 *   .vela/state/failure-counter.json — { count: number, step: string }
 *   .vela/state/circuit-open.json    — { step, count, openAt } (created at threshold)
 *
 * Behavior:
 *   - On each tool error: increment counter
 *   - On step change: reset counter to 1, close circuit
 *   - At CIRCUIT_THRESHOLD consecutive failures: write circuit-open.json
 *     (VG-15 gate guard reads this to block further execution)
 *   - Always exits 0 (failure tracking is observational, not blocking)
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Circuit breaker threshold ──────────────────────────────
const CIRCUIT_THRESHOLD = 5;

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
      .filter((d) => /^\d{8}T\d{6}-/.test(d))
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

// ─── Error detection ─────────────────────────────────────────

/**
 * Determine if the tool call resulted in an actual error.
 * PostToolUse receives tool_response — check for error indicators.
 */
function isToolError(input) {
  // Explicit is_error flag
  if (input.is_error === true) return true;

  const resp = input.tool_response;
  if (!resp) return false;

  const s = typeof resp === "string" ? resp : JSON.stringify(resp);

  // Bash: non-zero exit code
  if (/Exit code [1-9]\d*/.test(s)) return true;
  // Explicit error patterns (not gate-keeper denials which are handled separately)
  if (/^Error:|error occurred|failed to|ENOENT|EACCES|EPERM|command not found/im.test(s)) return true;
  // Structured error response
  if (typeof resp === "object" && resp !== null && resp.is_error === true) return true;

  return false;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const input = parseJsonSafe(raw) || {};

  // Only track actual errors, not successful tool calls
  if (!isToolError(input)) {
    process.exit(0);
    return;
  }

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

  const circuitPath = path.join(stateDir, "circuit-open.json");
  let newCount;
  const stepChanged = !counter || counter.step !== currentStep;

  if (stepChanged) {
    // Step transition (or first failure): reset to 1, close any open circuit
    newCount = 1;
    try {
      if (fs.existsSync(circuitPath)) {
        fs.unlinkSync(circuitPath);
      }
    } catch { /* silent */ }
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

  // ─── Circuit breaker: open circuit at threshold ──────────
  // Write circuit-open.json which VG-15 gate guard reads.
  if (newCount >= CIRCUIT_THRESHOLD) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        circuitPath,
        JSON.stringify({
          step: currentStep,
          count: newCount,
          openAt: new Date().toISOString(),
        }, null, 2),
        "utf8"
      );
    } catch { /* silent */ }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
