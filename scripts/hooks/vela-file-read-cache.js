#!/usr/bin/env node
/**
 * Vela File Read Cache Hook — v7.1 M10
 *
 * Claude Code PreToolUse hook that logs every Read tool call to
 * `<active-artifact-dir>/read-cache.jsonl`, one JSON line per Read.
 * Used by /vela:analyze and vela-stop.js to detect duplicate file
 * reads across sub-agent sessions and report top offenders.
 *
 * Why it exists: v7.1 M7 (Context Pack) is the primary defense
 * against sub-agents re-scanning the project tree each pipeline.
 * This hook is the measurement: if the numbers drop after M7 lands,
 * we know Context Pack worked. If not, we know where to tighten.
 *
 * Exit code: always 0 — this hook is purely observational and must
 * never block a Read tool call. Any internal error is swallowed.
 *
 * Output format (stdout): nothing. This hook writes to disk only.
 *
 * Input: standard Claude Code PreToolUse JSON on stdin.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
 * Walk .vela/artifacts/ for the active pipeline directory.
 * Returns the absolute path or null.
 */
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

/**
 * Cheap file content fingerprint — first 16 hex chars of sha256(contents).
 * Used so we can tell "same file read twice" apart from "same path,
 * file changed between reads". Large files are hashed in full, which is
 * fine because read cost dominates hook cost.
 */
function sha16(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

async function main() {
  const raw = await readStdin();
  if (!raw) return process.exit(0);

  const input = parseJsonSafe(raw);
  if (!input) return process.exit(0);

  // Only Read tool calls are interesting. Everything else passes through.
  if (input.tool_name !== "Read") return process.exit(0);

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const ti = (input.tool_input && typeof input.tool_input === "object") ? input.tool_input : {};
  const filePath = (typeof ti.file_path === "string" && ti.file_path) ||
                   (typeof ti.path === "string" && ti.path) || "";
  if (!filePath) return process.exit(0);

  const artifactDir = findActiveArtifactDir(cwd);
  if (!artifactDir) {
    // No active Vela pipeline — don't log anything. Hook is a no-op
    // outside Vela's context.
    return process.exit(0);
  }

  // Sub-agent identity proxy: Claude Code doesn't expose subagent_type
  // through the hook input, so we use the `session_id` as a per-sub-agent
  // stand-in. Two sub-agents in the same pipeline get different session
  // ids, which is what we want for duplicate detection across agents.
  const agent = input.subagent_type || input.session_id || "unknown";
  const sha = sha16(filePath);

  const entry = {
    ts: new Date().toISOString(),
    agent,
    file: filePath,
    sha,
  };

  try {
    const outPath = path.join(artifactDir, "read-cache.jsonl");
    fs.appendFileSync(outPath, JSON.stringify(entry) + "\n");
  } catch { /* silent */ }

  // Count duplicates across all lines for this (agent,file,sha) combo.
  // If we're over 4, emit a stderr warning — pre-v7.1 baselines showed
  // researchers reading the same file 5+ times, which is usually a sign
  // of context-pack underuse.
  try {
    const outPath = path.join(artifactDir, "read-cache.jsonl");
    const raw2 = fs.readFileSync(outPath, "utf8");
    let count = 0;
    for (const line of raw2.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const obj = parseJsonSafe(t);
      if (!obj) continue;
      if (obj.agent === agent && obj.file === filePath && obj.sha === sha) {
        count++;
      }
    }
    if (count >= 4) {
      process.stderr.write(
        `⚠️ vela v7.1 M10: repeated read of ${filePath} by ${agent} (${count}× this pipeline)\n`,
      );
    }
  } catch { /* silent */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
