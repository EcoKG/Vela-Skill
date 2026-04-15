#!/usr/bin/env node
/**
 * Vela PostToolUse Learning Capture Hook — v7.2 M8
 *
 * PostToolUse hook that appends a one-line JSON record to
 * `<active-artifact-dir>/edit-journal.jsonl` every time Write or Edit
 * completes successfully. The vela-learning agent consumes this file to
 * extract change patterns without re-reading the whole diff.
 *
 * Why it exists (v7.2 plan M8):
 *   - learning agent currently derives patterns by re-reading git diff,
 *     which is expensive for large pipelines. An append-only journal
 *     keyed by tool_name + file_path + timestamp lets it skim in O(n).
 *   - complements PreToolUse vela-file-read-cache.js (v7.1 M10) —
 *     that one counts reads; this one counts writes.
 *
 * Non-fatal: always exits 0. Any internal error is swallowed. The
 * journal file is best-effort; an absent file is not a bug.
 *
 * Output:
 *   stdout — empty
 *   stderr — empty (we never warn on writes; write noise is expected)
 *
 * Input: standard Claude Code PostToolUse JSON on stdin.
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

  // Only Write and Edit emit meaningful journal entries. (NotebookEdit
  // is skipped — its semantics differ and vela-learning does not
  // consume it yet; can be added when the learning agent grows
  // notebook-aware patterns.)
  const tool = input.tool_name;
  if (tool !== "Write" && tool !== "Edit") return process.exit(0);

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const ti = (input.tool_input && typeof input.tool_input === "object") ? input.tool_input : {};
  const filePath = (typeof ti.file_path === "string" && ti.file_path) || "";
  if (!filePath) return process.exit(0);

  const artifactDir = findActiveArtifactDir(cwd);
  if (!artifactDir) return process.exit(0); // no active pipeline — no-op

  // Minimal entry: just what vela-learning needs to count patterns.
  // We DO NOT embed the diff body — the journal stays small; the
  // learning agent reads the file directly when it needs contents.
  const entry = {
    ts: new Date().toISOString(),
    tool,
    file: filePath,
    agent: input.subagent_type || input.session_id || "unknown",
    // Write has no old_string; Edit does. Surface operation type so the
    // learning agent can distinguish create-vs-modify without rereading.
    op: tool === "Write" ? "write" : (ti.replace_all ? "edit-replace-all" : "edit"),
  };

  try {
    const outPath = path.join(artifactDir, "edit-journal.jsonl");
    fs.appendFileSync(outPath, JSON.stringify(entry) + "\n");
  } catch { /* silent */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
