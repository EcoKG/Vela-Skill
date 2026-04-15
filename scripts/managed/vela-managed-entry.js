#!/usr/bin/env node
/**
 * Vela Managed Agents Entry — v7.2 M15 (experimental)
 *
 * Thin wrapper invoked by Anthropic Managed Agents to kick off a
 * Vela pipeline from a CI / webhook / cron trigger. Reads request
 * and scale from env vars, then hands control to vela-engine.js init.
 *
 * After this script returns, the Managed Agents container's Claude
 * Code session resumes with an active pipeline already registered —
 * the PM behavior is identical to a local session from that point.
 *
 * Env contract (see docs/managed-agents.md):
 *   VELA_REQUEST  (required) — natural-language task
 *   VELA_SCALE    (optional) — small|medium|large|fix|ralph|hotfix
 *   VELA_AUTO_PR  (optional) — "1" to auto-open PR after commit
 *
 * Exits non-zero on missing/invalid env or init failure, so the
 * Managed Agents orchestrator can surface a clear error.
 */

"use strict";

const path = require("path");
const { execFileSync } = require("child_process");
const fs = require("fs");

function fail(msg, code) {
  process.stderr.write(`vela-managed-entry: ${msg}\n`);
  process.exit(code || 1);
}

function main() {
  const request = process.env.VELA_REQUEST;
  if (!request || !request.trim()) {
    fail("VELA_REQUEST env var is required", 2);
  }

  const scale = process.env.VELA_SCALE || "medium";
  const validScales = ["small", "medium", "large", "fix", "ralph", "hotfix"];
  if (!validScales.includes(scale)) {
    fail(`invalid VELA_SCALE=${scale} (want one of ${validScales.join("|")})`, 2);
  }

  const cwd = process.cwd();
  const engine = path.join(cwd, ".vela", "cli", "vela-engine.js");
  if (!fs.existsSync(engine)) {
    fail(`engine not found at ${engine} — run install first`, 3);
  }

  const args = ["init", request, "--scale", scale];
  if (process.env.VELA_AUTO_PR === "1") args.push("--auto");

  try {
    const out = execFileSync("node", [engine, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 60000,
    });
    process.stdout.write(out);
  } catch (err) {
    fail(`engine init failed: ${err.message}`, 4);
  }
}

if (require.main === module) main();
