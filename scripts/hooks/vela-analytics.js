#!/usr/bin/env node
/**
 * Vela Analytics Hook — Claude Code PostToolUse Observability
 *
 * Records every tool call as a structured event to a per-session analytics
 * file. Provides an observability layer for pipeline health monitoring,
 * denial-rate tracking, and session-end reporting.
 *
 * State file: .vela/state/session-analytics.json
 *   { sessionId, startedAt, updatedAt, events: [...], summary: {...} }
 *
 * Event structure:
 *   { ts, tool, step, ok, durationMs? }
 *
 * Behavior:
 *   - Append each tool call event (capped at 500 entries, FIFO trim)
 *   - Update running summary (totalCalls, denials, byStep, byTool)
 *   - Always exits 0 — observability layer NEVER blocks execution
 *
 * Design notes:
 * - File writes are synchronous (hook is short-lived process)
 * - FIFO trim at 500 prevents unbounded file growth
 * - Corrupt/missing state is handled gracefully (reset to empty)
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Constants ───────────────────────────────────────────────
const MAX_EVENTS = 500;

// ─── Helpers ─────────────────────────────────────────────────

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
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Find the active pipeline state (step info only).
 */
function findActivePipelineStep(cwd) {
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
        if (state && state.status === "active") {
          return state.current_step || "unknown";
        }
      } catch { /* skip */ }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load existing analytics state. Returns fresh state on any error.
 */
function loadAnalytics(analyticsPath) {
  try {
    if (fs.existsSync(analyticsPath)) {
      const raw = parseJsonSafe(fs.readFileSync(analyticsPath, "utf8"));
      if (raw && Array.isArray(raw.events)) return raw;
    }
  } catch { /* fall through */ }

  return {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    summary: {
      totalCalls: 0,
      denials: 0,
      byStep: {},
      byTool: {},
    },
  };
}

/**
 * Determine if the tool call resulted in a denial.
 * PostToolUse receives tool_response — a denial contains a specific pattern.
 */
function isDenial(toolResponse) {
  if (!toolResponse) return false;
  const s = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
  return /permissionDecision.*deny|Permission denied|blocked in|not in safe-read/i.test(s);
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const input = parseJsonSafe(raw) || {};

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const velaDir = path.join(cwd, ".vela");

  // No .vela/ — not a Vela project, silent exit
  if (!fs.existsSync(velaDir)) {
    process.exit(0);
  }

  const stateDir = path.join(velaDir, "state");
  const analyticsPath = path.join(stateDir, "session-analytics.json");

  // Extract event data from stdin
  const toolName = (typeof input.tool_name === "string" && input.tool_name) || "unknown";
  const toolResponse = input.tool_response;
  const ok = !isDenial(toolResponse);

  // Get current pipeline step (best-effort)
  const step = findActivePipelineStep(cwd) || "explore";

  // Build event
  const event = {
    ts: new Date().toISOString(),
    tool: toolName,
    step,
    ok,
  };

  try {
    fs.mkdirSync(stateDir, { recursive: true });

    const analytics = loadAnalytics(analyticsPath);

    // Append event (FIFO trim at MAX_EVENTS)
    analytics.events.push(event);
    if (analytics.events.length > MAX_EVENTS) {
      analytics.events = analytics.events.slice(analytics.events.length - MAX_EVENTS);
    }

    // Update running summary
    analytics.summary.totalCalls = (analytics.summary.totalCalls || 0) + 1;
    if (!ok) {
      analytics.summary.denials = (analytics.summary.denials || 0) + 1;
    }

    // By step
    if (!analytics.summary.byStep[step]) {
      analytics.summary.byStep[step] = { calls: 0, denials: 0 };
    }
    analytics.summary.byStep[step].calls += 1;
    if (!ok) analytics.summary.byStep[step].denials += 1;

    // By tool
    if (!analytics.summary.byTool[toolName]) {
      analytics.summary.byTool[toolName] = { calls: 0, denials: 0 };
    }
    analytics.summary.byTool[toolName].calls += 1;
    if (!ok) analytics.summary.byTool[toolName].denials += 1;

    analytics.updatedAt = new Date().toISOString();

    fs.writeFileSync(analyticsPath, JSON.stringify(analytics, null, 2), "utf8");
  } catch {
    // Silent — never fail on analytics errors
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
