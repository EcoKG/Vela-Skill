#!/usr/bin/env node
/**
 * Vela Gate Guard — Claude Code PreToolUse Hook
 *
 * Enforces pipeline-step-level guard rules.
 * Implements VG-03, VG-12 guard rules (and more).
 *
 * Exit codes:
 *   0 — allow the tool call
 *   2 — block the tool call (fail-closed)
 *
 * Fail-closed: any error (corrupt stdin, empty stdin, unhandled exception)
 * results in exit 2 (deny) rather than exit 0 (allow).
 *
 * Guards:
 *   VG-03: Build/test failure check — corrupt signals file blocks git commit
 *   VG-12: PM direct source modification in execute step blocked
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { CODE_EXTENSIONS } = require("./shared/constants");

// ─── Helpers ───────────────────────────────────────────────

/**
 * Read all of stdin as a string.
 */
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

/**
 * Safe JSON parse. Returns null on any error.
 */
function parseJsonSafe(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Read Vela config from cwd/.vela/config.json. Returns {} on error.
 */
function readConfig(cwd) {
  try {
    const configPath = path.join(cwd, ".vela", "config.json");
    const raw = fs.readFileSync(configPath, "utf8");
    return parseJsonSafe(raw) || {};
  } catch {
    return {};
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
        // skip invalid entries
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if delegation.json exists in the artifact directory.
 */
function hasDelegation(artifactDir) {
  try {
    return fs.existsSync(path.join(artifactDir, "delegation.json"));
  } catch {
    return false;
  }
}

/**
 * Check if the tracker-signals file is valid JSON.
 * Returns: "ok" | "corrupt" | "absent"
 */
function checkSignalsFile(cwd) {
  const signalsPath = path.join(cwd, ".vela", "tracker-signals.json");
  try {
    if (!fs.existsSync(signalsPath)) return "absent";
    const raw = fs.readFileSync(signalsPath, "utf8");
    const parsed = parseJsonSafe(raw);
    if (parsed === null) return "corrupt";
    return "ok";
  } catch {
    return "absent";
  }
}

// ─── Main ───────────────────────────────���──────────────────

async function main() {
  const raw = await readStdin();

  // Fail-closed: empty stdin → block
  if (!raw || !raw.trim()) {
    process.exit(2);
  }

  // Fail-closed: corrupt JSON → block
  const input = parseJsonSafe(raw);
  if (!input) {
    process.exit(2);
  }

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const toolName = (typeof input.tool_name === "string" && input.tool_name) || "";
  const toolInput = (input.tool_input && typeof input.tool_input === "object")
    ? input.tool_input
    : {};

  // Read config
  const config = readConfig(cwd);

  // If gate_guard is not enabled → pass through (allow)
  if (!config.gate_guard || config.gate_guard.enabled !== true) {
    process.exit(0);
  }

  // Find active pipeline
  const pipelineResult = findActivePipeline(cwd);

  // ─── VG-03: Corrupt signals file blocks git commit ───
  if (toolName === "Bash") {
    const cmd = (typeof toolInput.command === "string" && toolInput.command) || "";
    if (/\bgit\s+commit\b/.test(cmd)) {
      const signalsStatus = checkSignalsFile(cwd);
      if (signalsStatus === "corrupt") {
        // VG-03: corrupt signals file — block git commit with recovery guidance
        process.exit(2);
      }
    }
  }

  // ─── VG-12: PM direct source modification in execute step ───
  if (
    config.persona === "pm" &&
    pipelineResult &&
    pipelineResult.state.current_step === "execute" &&
    (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit")
  ) {
    // Check if the file being written is a source code file
    const filePath =
      (typeof toolInput.file_path === "string" && toolInput.file_path) ||
      (typeof toolInput.path === "string" && toolInput.path) ||
      "";
    const ext = path.extname(filePath).toLowerCase();

    if (CODE_EXTENSIONS.has(ext)) {
      // Check for delegation — if delegation exists, PM delegated to SDK agent (allow)
      if (!hasDelegation(pipelineResult.artifactDir)) {
        // VG-12: no delegation, direct PM source modification → block
        process.exit(2);
      }
    }
  }

  // Default: allow
  process.exit(0);
}

main().catch(() => process.exit(2));
