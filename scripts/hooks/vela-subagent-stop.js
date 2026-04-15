#!/usr/bin/env node
/**
 * Vela SubagentStop Telemetry Hook — v7.2 M8
 *
 * SubagentStop hook that rolls up per-sub-agent tool usage into
 * `<active-artifact-dir>/agent-telemetry.jsonl`. Consumed by
 * vela-cost.js for per-agent token/tool breakdowns and by
 * vela-stop.js final aggregate.
 *
 * Why it exists (v7.2 plan M8):
 *   - Current vela-stop.js aggregates pipeline-wide numbers but cannot
 *     attribute tool/token usage to individual sub-agent spawns.
 *   - With M2 (per-role model routing) enabled, attributing cost to
 *     role agents is how we actually prove Haiku-for-checks pays off.
 *
 * Non-fatal: always exits 0. The hook is observational.
 *
 * Input: standard Claude Code SubagentStop JSON on stdin. Relevant
 * fields (best-effort — Claude Code versions differ):
 *   - subagent_type, session_id
 *   - cwd
 *   - usage: { input_tokens, output_tokens, cache_read_input_tokens,
 *             cache_creation_input_tokens }
 *   - tool_counts: { Read, Write, Edit, Bash, ... }
 *   - duration_ms
 */

"use strict";

const fs = require("fs");
const path = require("path");

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

function findActiveArtifactDir(cwd) {
  try {
    const artifactsDir = path.join(cwd, ".vela", "artifacts");
    if (!fs.existsSync(artifactsDir)) return null;
    const dirs = fs.readdirSync(artifactsDir)
      .filter(d => /^\d{8}T\d{6}-/.test(d))
      .sort()
      .reverse();
    for (const d of dirs) {
      const sp = path.join(artifactsDir, d, "pipeline-state.json");
      if (!fs.existsSync(sp)) continue;
      try {
        const s = parseJsonSafe(fs.readFileSync(sp, "utf8"));
        if (s && s.status === "active") {
          return path.join(artifactsDir, d);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}

async function main() {
  const raw = await readStdin();
  if (!raw) return process.exit(0);

  const input = parseJsonSafe(raw);
  if (!input) return process.exit(0);

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const artifactDir = findActiveArtifactDir(cwd);
  if (!artifactDir) return process.exit(0);

  const entry = {
    ts: new Date().toISOString(),
    agent: input.subagent_type || "unknown",
    session_id: input.session_id || null,
    usage: input.usage || null,
    tool_counts: input.tool_counts || null,
    duration_ms: typeof input.duration_ms === "number" ? input.duration_ms : null,
    model: input.model || null,
  };

  try {
    const outPath = path.join(artifactDir, "agent-telemetry.jsonl");
    fs.appendFileSync(outPath, JSON.stringify(entry) + "\n");
  } catch { /* silent */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
