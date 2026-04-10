#!/usr/bin/env node
/**
 * Vela Gate Keeper — Claude Code PreToolUse Hook
 *
 * Enforces pipeline mode restrictions on every tool call.
 * Implements VK-01 through VK-08 gate rules.
 *
 * Exit codes:
 *   0 — allow the tool call
 *   2 — block the tool call (fail-closed)
 *
 * Fail-closed: any error (corrupt stdin, empty stdin, unhandled exception)
 * results in exit 2 (deny) rather than exit 0 (allow).
 *
 * Gates:
 *   VK-01/VK-02: Bash blocking per mode
 *   VK-03/VK-04: Write/Edit blocking in read mode
 *   VK-07: PM mode — only Read/Glob/Grep allowed; Write/Edit blocked
 *   VK-08: Chain operator blocking (&&, ||, ;, |)
 *   VK-10: write mode — WebFetch/WebSearch blocked (network ops inconsistent with write isolation)
 *
 * NOTE (V6): VK-09 removed. In V6, PM uses the Agent tool directly to spawn role agents
 * (vela-researcher, vela-planner, vela-executor, etc.) — this is the intended orchestration
 * mechanism. Blocking Agent tool would prevent pipeline execution.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { SAFE_BASH_READ } = require("./shared/constants");

// VK-08: Chain operator regex — matches &&, ||, ;, | (pipe)
const CHAIN_OPERATOR_RE = /&&|\|\||;|\|/;

// ─── Helpers ───────────────────────────────────────────────

/**
 * Read all of stdin as a string. Resolves with empty string if stdin is a TTY.
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
 * Find the active pipeline state. Returns null if none found.
 * Searches .vela/artifacts/{YYYYMMDD}T{HHmmss}-{slug}/pipeline-state.json
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
        const statePath = path.join(artifactsDir, dir, "pipeline-state.json");
        if (!fs.existsSync(statePath)) continue;
        const state = parseJsonSafe(fs.readFileSync(statePath, "utf8"));
        if (state && state.status === "active") return state;
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
 * Read pipeline definition from .vela/templates/pipeline.json.
 * Returns null on error.
 */
function readPipelineDefinition(cwd) {
  try {
    const pipelinePath = path.join(cwd, ".vela", "templates", "pipeline.json");
    return parseJsonSafe(fs.readFileSync(pipelinePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Get the mode for the current pipeline step.
 * Returns "readwrite" as a permissive default when mode cannot be determined.
 */
function getCurrentMode(pipelineState, pipelineDef) {
  if (!pipelineState || !pipelineDef) return "readwrite";

  const { pipeline_type, current_step } = pipelineState;
  const pipeline = pipelineDef.pipelines && pipelineDef.pipelines[pipeline_type];
  if (!pipeline) return "readwrite";

  // Resolve steps with inheritance (mirrors resolveSteps in vela-engine.js)
  let steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
  if (pipeline.inherits && pipeline.steps_only) {
    const parent = pipelineDef.pipelines[pipeline.inherits];
    if (parent && Array.isArray(parent.steps)) {
      steps = parent.steps.filter((s) => pipeline.steps_only.includes(s.id));
      if (pipeline.overrides) {
        steps = steps.map((s) =>
          pipeline.overrides[s.id] ? { ...s, ...pipeline.overrides[s.id] } : s,
        );
      }
    }
  }

  const step = steps.find((s) => s.id === current_step);
  return (step && step.mode) || "readwrite";
}

// ─── Main ──────────────────────────────────────────────────

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

  // If sandbox is not enabled → pass through (allow)
  if (config.sandbox == null || config.sandbox.enabled !== true) {
    process.exit(0);
  }

  // Find active pipeline state and mode
  const pipelineState = findActivePipeline(cwd);
  const pipelineDef = readPipelineDefinition(cwd);
  const mode = getCurrentMode(pipelineState, pipelineDef);

  // ─── VK-01/VK-02/VK-08: Bash enforcement ───
  if (toolName === "Bash") {
    const cmd = (typeof toolInput.command === "string" && toolInput.command) || "";

    // VK-08: Block chain operators even in safe commands
    if (CHAIN_OPERATOR_RE.test(cmd)) {
      process.exit(2);
    }

    if (mode === "read") {
      // Allow safe read-only commands; block everything else
      if (SAFE_BASH_READ.test(cmd)) {
        process.exit(0);
      }
      process.exit(2);
    }

    if (mode === "write") {
      // Vela CLI commands are always allowed — PM needs them for state transitions
      if (/node\s+.*\.vela\/cli\/vela-[a-z-]+\.js/.test(cmd)) {
        process.exit(0);
      }
      // All other Bash blocked in write mode (VK-02)
      process.exit(2);
    }

    // readwrite: allow all bash (chain already checked above)
    process.exit(0);
  }

  // ─── VK-03/VK-04/VK-07: Write/Edit/NotebookEdit enforcement ───
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    if (mode === "read") {
      // Allow writes inside .vela/ (except pipeline-state.json)
      const filePath = (typeof toolInput.file_path === "string" && toolInput.file_path)
        || (typeof toolInput.path === "string" && toolInput.path)
        || "";
      const normalized = filePath.replace(/\\/g, "/");
      const inVelaDir =
        normalized.includes("/.vela/") || normalized.startsWith(".vela/");
      const isPipelineState = normalized.includes("pipeline-state.json");

      if (inVelaDir && !isPipelineState) {
        process.exit(0); // .vela/ artifacts/state are writable
      }

      // All other writes blocked in read mode
      process.exit(2);
    }
  }

  // ─── VK-10: write mode — WebFetch/WebSearch blocked ───────────
  // In write mode, only Write/Edit file operations are appropriate.
  // Network operations are inconsistent with isolated write-only mode.
  if (mode === "write" && (toolName === "WebFetch" || toolName === "WebSearch")) {
    process.exit(2);
  }

  // Default: allow
  process.exit(0);
}

main().catch(() => process.exit(2));
