#!/usr/bin/env node
/**
 * Vela Nightly Learning Aggregator — v7.2 M14
 *
 * Summarizes `.vela/learnings/learnings.json` accumulated across
 * pipelines into a single daily markdown report at
 * `.vela/reports/nightly-{YYYY-MM-DD}.md`. Intended to run via
 * CronCreate (user opt-in, e.g. `0 2 * * *`) or manually.
 *
 * Not part of any pipeline — runs standalone. Output is
 * advisory-only; never mutates learnings.json.
 *
 * Usage:
 *   node .vela/cli/vela-nightly.js            # write today's report
 *   node .vela/cli/vela-nightly.js --dry-run  # print to stdout only
 *   node .vela/cli/vela-nightly.js --since 7  # include last 7 days
 *
 * Exit codes:
 *   0 — success (or nothing to report)
 *   1 — unreadable learnings.json / write failure
 */

"use strict";

const fs = require("fs");
const path = require("path");

function walkUpForVelaDir(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".vela"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseArgs(argv) {
  const out = { dryRun: false, sinceDays: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--since") out.sinceDays = Math.max(1, parseInt(argv[++i], 10) || 1);
  }
  return out;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function withinDays(ts, days) {
  try {
    const t = new Date(ts).getTime();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return t >= cutoff;
  } catch {
    return false;
  }
}

function buildReport(learnings, sinceDays) {
  // Bucket patterns by category across recent entries
  const buckets = { weakness: [], strength: [], recurring_issue: [] };
  let total = 0;
  for (const entry of learnings) {
    if (!entry || !entry.timestamp || !Array.isArray(entry.patterns)) continue;
    if (!withinDays(entry.timestamp, sinceDays)) continue;
    total++;
    for (const p of entry.patterns) {
      if (!p || !p.category || !p.description) continue;
      const list = buckets[p.category];
      if (list) list.push({ ...p, request: entry.request, pipeline: entry.pipelineType });
    }
  }

  const lines = [];
  lines.push(`# Vela Nightly Report — ${todayISO()}`);
  lines.push("");
  lines.push(`- Window: last ${sinceDays} day${sinceDays === 1 ? "" : "s"}`);
  lines.push(`- Pipelines aggregated: ${total}`);
  lines.push("");

  for (const [cat, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    lines.push(`## ${cat} (${items.length})`);
    // De-dup by description
    const seen = new Map();
    for (const it of items) {
      const k = it.description;
      if (!seen.has(k)) seen.set(k, { count: 0, pipelines: new Set() });
      const agg = seen.get(k);
      agg.count++;
      if (it.pipeline) agg.pipelines.add(it.pipeline);
    }
    const sorted = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [desc, agg] of sorted) {
      const pipes = agg.pipelines.size ? ` [${[...agg.pipelines].join(", ")}]` : "";
      lines.push(`- **×${agg.count}** ${desc}${pipes}`);
    }
    lines.push("");
  }

  if (total === 0) {
    lines.push("_No learnings within the window._");
    lines.push("");
  }

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = walkUpForVelaDir(process.cwd());
  if (!root) {
    process.stderr.write("vela-nightly: no .vela/ in ancestor chain\n");
    process.exit(1);
  }

  const learningsPath = path.join(root, ".vela", "learnings", "learnings.json");
  if (!fs.existsSync(learningsPath)) {
    // Nothing to do — silent success so cron doesn't spam failures
    // on projects that have never run a pipeline.
    process.exit(0);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(learningsPath, "utf8"));
  } catch {
    process.stderr.write(`vela-nightly: malformed ${learningsPath}\n`);
    process.exit(1);
  }

  const learnings = (raw && Array.isArray(raw.learnings)) ? raw.learnings : [];
  const report = buildReport(learnings, args.sinceDays);

  if (args.dryRun) {
    process.stdout.write(report + "\n");
    return;
  }

  const reportsDir = path.join(root, ".vela", "reports");
  try {
    fs.mkdirSync(reportsDir, { recursive: true });
    const outPath = path.join(reportsDir, `nightly-${todayISO()}.md`);
    fs.writeFileSync(outPath, report);
    process.stdout.write(JSON.stringify({ ok: true, report: outPath, pipelines: learnings.length }) + "\n");
  } catch (err) {
    process.stderr.write(`vela-nightly: write failed: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();
