#!/usr/bin/env node
/**
 * ⛵ Vela Analyze — Dependency analysis + PDF report generation
 *
 * Subcommands:
 *   deps              Run npm audit/outdated analysis, output JSON to stdout
 *   report --input <file> [--output <file>]   Generate PDF report from analysis JSON
 *
 * Usage:
 *   node vela-analyze.js deps
 *   node vela-analyze.js report --input analysis.json --output report.pdf
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { MODEL_VERSIONS } = require("../shared/constants");

// ─── Argument Parsing ───

const args = process.argv.slice(2);
const subcommand = args[0];

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

// ─── Module-Level Constants ───

const VALID_PERSPECTIVES = [
  "security",
  "bugs",
  "performance",
  "code-quality",
  "architecture",
];
const MODEL_MAP = {
  haiku: MODEL_VERSIONS.HAIKU,
  sonnet: MODEL_VERSIONS.SONNET,
  opus: MODEL_VERSIONS.OPUS,
};

function printUsage() {
  console.error(`Usage:
  node vela-analyze.js deps                          — Run dependency analysis (JSON stdout)
  node vela-analyze.js report --input <file> [--output <file>]  — Generate PDF report
  node vela-analyze.js run --perspectives <list> [--model haiku|sonnet|opus]  — Run SDK code analysis
  node vela-analyze.js full --items <list> [--model haiku|sonnet|opus] [--output <file>]  — Run combined analysis + PDF

  run options:
    --perspectives  Comma-separated list of: security,bugs,performance,code-quality,architecture (required)
    --model         Analysis model: haiku (default), sonnet, or opus

  full options:
    --items         Comma-separated list of: deps,security,bugs,performance,code-quality,architecture (required)
    --model         Analysis model: haiku (default), sonnet, or opus
    --output        Output PDF path (default: ./vela-report-{timestamp}.pdf)`);
}

// ─── HTML Report Builder ───

const SEV_COLORS = {
  critical: "#CC0000",
  high: "#DD4400",
  moderate: "#DD8800",
  low: "#888888",
  info: "#4488CC",
  unknown: "#666666",
};

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a complete HTML string for the analysis report.
 * Uses inline CSS for print-optimized, self-contained rendering.
 * @param {Object} data - Analysis result (flat or combined format)
 * @returns {string} Full HTML document string
 */
function buildReportHtml(data) {
  const depData = data.deps || data;
  const hasDeps = !!(depData.findings || depData.outdated || depData.metadata);
  const dateStr = (data.generatedAt || new Date().toISOString()).split("T")[0];
  const meta = (hasDeps && depData.metadata) || {};
  const bySev = meta.bySeverity || {};
  const totalVuln = meta.totalVulnerabilities || 0;

  let body = "";

  // ─── Cover ───
  body += `<header>
  <div class="cover-rule"></div>
  <h1>Analysis Report</h1>
  <p class="cover-project">Vela Analyzer</p>
  <p class="cover-date">${esc(dateStr)}</p>
  ${data.selectedItems ? `<p class="cover-scope">${esc(data.selectedItems.join("  ·  "))}</p>` : ""}
  <div class="cover-rule"></div>
</header>`;

  // ─── Table of Contents ───
  const tocItems = [];
  if (hasDeps) {
    tocItems.push("Executive Summary");
    tocItems.push("Vulnerability Findings");
    tocItems.push("Outdated Packages");
  }
  if (data.codeAnalysis) {
    tocItems.push("Code Analysis");
  }
  if (tocItems.length > 1) {
    body += `<nav class="toc"><h2>Contents</h2><ol>`;
    for (const item of tocItems) body += `<li>${esc(item)}</li>`;
    body += `</ol></nav>`;
  }

  // ─── Executive Summary ───
  if (hasDeps) {
    const sevEntries = [
      { label: "Critical", count: bySev.critical || 0, cls: "sev-critical" },
      { label: "High", count: bySev.high || 0, cls: "sev-high" },
      { label: "Moderate", count: bySev.moderate || 0, cls: "sev-moderate" },
      { label: "Low", count: bySev.low || 0, cls: "sev-low" },
      { label: "Info", count: bySev.info || 0, cls: "sev-info" },
    ];

    body += `<section>
  <h2>1. Executive Summary</h2>
  <table class="summary-table">
    <tbody>
      <tr><td class="label">Total Vulnerabilities</td><td class="value">${totalVuln}</td></tr>
      <tr><td class="label">Outdated Packages</td><td class="value">${meta.outdatedCount || 0}</td></tr>
      <tr><td class="label">Total Dependencies</td><td class="value">${meta.totalDependencies || "—"}</td></tr>
      ${data.codeAnalysis ? `<tr><td class="label">Code Perspectives Analyzed</td><td class="value">${(data.codeAnalysis.perspectives || []).filter((p) => p.ok).length} / ${(data.codeAnalysis.perspectives || []).length}</td></tr>` : ""}
    </tbody>
  </table>

  ${
    totalVuln > 0
      ? `<h3>Severity Distribution</h3>
  <table class="dist-table">
    <thead><tr>${sevEntries.map((s) => `<th class="${s.cls}">${s.label}</th>`).join("")}</tr></thead>
    <tbody><tr>${sevEntries.map((s) => `<td>${s.count}</td>`).join("")}</tr></tbody>
  </table>`
      : `<p class="note">No vulnerabilities detected.</p>`
  }
</section>`;

    // ─── Vulnerability Findings ───
    const findings = depData.findings || [];
    body += `<section>
  <h2>2. Vulnerability Findings</h2>`;

    if (findings.length === 0) {
      body += `<p class="note">No vulnerabilities found.</p>`;
    } else {
      body += `<table class="findings-table">
  <thead><tr><th>Severity</th><th>Package</th><th>Title</th><th>Direct</th><th>Fix</th></tr></thead>
  <tbody>`;
      const severityOrder = [
        "critical",
        "high",
        "moderate",
        "low",
        "info",
        "unknown",
      ];
      const sorted = [...findings].sort(
        (a, b) =>
          severityOrder.indexOf((a.severity || "unknown").toLowerCase()) -
          severityOrder.indexOf((b.severity || "unknown").toLowerCase()),
      );

      for (const f of sorted) {
        const sev = (f.severity || "unknown").toLowerCase();
        body += `<tr>
  <td><span class="tag ${sev}">${sev.toUpperCase()}</span></td>
  <td>${esc(f.name)}</td>
  <td>${esc(f.title || "—")}</td>
  <td>${f.isDirect ? "Yes" : "No"}</td>
  <td>${f.fixAvailable ? "Available" : "—"}</td>
</tr>`;
      }
      body += `</tbody></table>`;

      // Detail blocks for critical/high
      const serious = sorted.filter((f) =>
        ["critical", "high"].includes((f.severity || "").toLowerCase()),
      );
      if (serious.length > 0) {
        body += `<h3>Detail — Critical &amp; High</h3>`;
        for (const f of serious) {
          const sev = (f.severity || "unknown").toLowerCase();
          body += `<div class="detail-block ${sev}-border">
  <p class="detail-title"><span class="tag ${sev}">${sev.toUpperCase()}</span> ${esc(f.name)}</p>
  ${f.title ? `<p>${esc(f.title)}</p>` : ""}
  ${f.url ? `<p class="ref"><a href="${esc(f.url)}">${esc(f.url)}</a></p>` : ""}
</div>`;
        }
      }
    }
    body += `</section>`;

    // ─── Outdated Packages ───
    const outdated = depData.outdated || [];
    body += `<section>
  <h2>3. Outdated Packages</h2>`;

    if (outdated.length === 0) {
      body += `<p class="note">All packages are up to date.</p>`;
    } else {
      body += `<table class="pkg-table">
  <thead><tr><th>Package</th><th>Current</th><th>Wanted</th><th>Latest</th><th>Type</th></tr></thead>
  <tbody>`;
      for (const pkg of outdated) {
        const curMajor = (pkg.current || "").split(".")[0];
        const latMajor = (pkg.latest || "").split(".")[0];
        const isMajor = curMajor !== latMajor;
        body += `<tr>
  <td>${esc(pkg.name)}</td>
  <td><code>${esc(pkg.current)}</code></td>
  <td><code>${esc(pkg.wanted)}</code></td>
  <td><code>${esc(pkg.latest)}</code></td>
  <td>${isMajor ? '<span class="tag critical">MAJOR</span>' : '<span class="tag info">patch</span>'}</td>
</tr>`;
      }
      body += `</tbody></table>`;
    }
    body += `</section>`;
  }

  // ─── Code Analysis ───
  if (data.codeAnalysis) {
    const sectionNum = hasDeps ? 4 : 1;
    body += `<section>
  <h2>${sectionNum}. Code Analysis</h2>`;

    if (
      !data.codeAnalysis.ok &&
      (!data.codeAnalysis.perspectives ||
        data.codeAnalysis.perspectives.length === 0)
    ) {
      body += `<p class="error">Analysis failed: ${esc(data.codeAnalysis.error || "Unknown error")}</p>`;
    } else {
      const perspectives = data.codeAnalysis.perspectives || [];

      for (const p of perspectives) {
        const pName =
          (p.perspective || "unknown").charAt(0).toUpperCase() +
          (p.perspective || "unknown").slice(1);

        body += `<div class="perspective">
  <h3>${esc(pName)}</h3>`;

        if (!p.ok) {
          body += `<p class="error">Analysis failed: ${esc(p.error || "Unknown error")}</p></div>`;
          continue;
        }

        const pFindings = p.findings || [];
        body += `<p class="meta">Findings: ${pFindings.length} &ensp;|&ensp; Cost: $${(p.cost || 0).toFixed(3)} &ensp;|&ensp; ${((p.durationMs || 0) / 1000).toFixed(1)}s</p>`;

        if (pFindings.length === 0) {
          body += `<p class="note">No issues found.</p></div>`;
          continue;
        }

        body += `<table class="findings-table">
  <thead><tr><th>Severity</th><th>Issue</th><th>Location</th></tr></thead>
  <tbody>`;
        for (const f of pFindings) {
          const sev = (f.severity || "info").toLowerCase();
          body += `<tr>
  <td><span class="tag ${sev}">${sev.toUpperCase()}</span></td>
  <td>${esc(f.name || f.description || "Finding")}</td>
  <td>${f.file ? `<code>${esc(f.file)}${f.line ? ":" + f.line : ""}</code>` : "—"}</td>
</tr>`;
        }
        body += `</tbody></table>`;

        // Expanded details for each finding
        for (const f of pFindings) {
          if (!f.description && !f.suggestion) continue;
          const sev = (f.severity || "info").toLowerCase();
          body += `<div class="detail-block ${sev}-border">
  <p class="detail-title">${esc(f.name || "Finding")}</p>
  ${f.description ? `<p>${esc(f.description)}</p>` : ""}
  ${f.suggestion ? `<p class="fix">Recommendation: ${esc(f.suggestion)}</p>` : ""}
</div>`;
        }
        body += `</div>`;
      }

      // Totals
      const okP = perspectives.filter((p) => p.ok);
      const totalF = perspectives.reduce(
        (s, p) => s + (p.findings || []).length,
        0,
      );
      body += `<div class="totals">
  <p>${okP.length} / ${perspectives.length} perspectives completed &ensp;|&ensp; ${totalF} total findings${data.codeAnalysis.totalCost != null ? ` &ensp;|&ensp; Total cost: $${data.codeAnalysis.totalCost.toFixed(3)}` : ""}</p>
</div>`;
    }
    body += `</section>`;
  }

  // ─── Footer ───
  body += `<footer>
  <div class="footer-rule"></div>
  <p>Vela Analyzer &mdash; ${esc(dateStr)}</p>
  <p class="confidential">CONFIDENTIAL</p>
</footer>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>Vela Analysis Report — ${esc(dateStr)}</title>
<style>
/* ══════════════════════════════════════
   Vela Analysis Report — Print-Optimized
   ══════════════════════════════════════ */
@page { margin: 18mm 16mm; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Noto Sans KR', system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
  color: #1e1e2e; background: #fff;
  font-size: 9.5pt; line-height: 1.7;
  max-width: 720px; margin: 0 auto; padding: 0;
}

/* ── Cover ── */
header { text-align: center; padding: 56px 0 32px; margin-bottom: 24px; }
.cover-rule { height: 2px; background: #1e1e2e; margin: 0 auto; width: 100%; }
header h1 {
  font-size: 28pt; font-weight: 300; letter-spacing: 3px;
  text-transform: uppercase; color: #1e1e2e; margin: 28px 0 6px;
}
.cover-project { font-size: 10pt; letter-spacing: 2px; color: #6b7280; text-transform: uppercase; }
.cover-date { font-size: 10pt; color: #6b7280; margin: 16px 0 4px; }
.cover-scope { font-size: 9pt; color: #9ca3af; margin-bottom: 28px; }

/* ── Table of Contents ── */
.toc { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; }
.toc h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: 1.5px; color: #6b7280; border: none; margin-bottom: 8px; }
.toc ol { padding-left: 20px; font-size: 9.5pt; color: #374151; }
.toc li { margin: 2px 0; }

/* ── Headings ── */
h2 {
  font-size: 12pt; font-weight: 700; color: #1e1e2e;
  text-transform: uppercase; letter-spacing: 0.8px;
  border-bottom: 1px solid #d1d5db; padding-bottom: 4px;
  margin: 28px 0 12px;
}
h3 { font-size: 10pt; font-weight: 600; color: #374151; margin: 14px 0 6px; }

/* ── Summary Table ── */
.summary-table { width: auto; margin: 8px 0 16px; border-collapse: collapse; }
.summary-table td { padding: 5px 0; font-size: 9.5pt; border: none; }
.summary-table .label { color: #6b7280; padding-right: 32px; }
.summary-table .value { font-weight: 700; color: #1e1e2e; }

/* ── Distribution Table ── */
.dist-table { width: auto; border-collapse: collapse; margin: 4px 0 16px; font-size: 9pt; }
.dist-table th { padding: 4px 18px; font-weight: 600; color: #fff; text-align: center; }
.dist-table td { padding: 4px 18px; text-align: center; font-weight: 700; font-size: 11pt; border-bottom: none; }
.dist-table .sev-critical { background: #991b1b; }
.dist-table .sev-high { background: #c2410c; }
.dist-table .sev-moderate { background: #a16207; }
.dist-table .sev-low { background: #4b5563; }
.dist-table .sev-info { background: #1d4ed8; }

/* ── Data Tables ── */
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 9pt; }
thead th {
  background: #f9fafb; padding: 6px 10px; text-align: left;
  font-size: 8pt; font-weight: 700; color: #4b5563;
  text-transform: uppercase; letter-spacing: 0.5px;
  border-bottom: 1.5px solid #d1d5db;
}
tbody td { padding: 6px 10px; border-bottom: 1px solid #f3f4f6; color: #374151; vertical-align: top; }
tbody tr:last-child td { border-bottom: 1.5px solid #e5e7eb; }
code {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 8.5pt; color: #374151;
}

/* ── Tags ── */
.tag {
  display: inline-block; padding: 1px 8px; border-radius: 3px;
  font-size: 7.5pt; font-weight: 700; letter-spacing: 0.3px; color: #fff;
}
.tag.critical { background: #991b1b; }
.tag.high { background: #c2410c; }
.tag.moderate { background: #a16207; }
.tag.low { background: #4b5563; }
.tag.info { background: #1d4ed8; }
.tag.unknown { background: #6b7280; }

/* ── Detail Blocks ── */
.detail-block {
  margin: 8px 0; padding: 8px 14px;
  border-left: 3px solid #d1d5db; background: #fafafa;
  font-size: 9pt; break-inside: avoid;
}
.critical-border { border-left-color: #991b1b; }
.high-border { border-left-color: #c2410c; }
.moderate-border { border-left-color: #a16207; }
.low-border { border-left-color: #4b5563; }
.info-border { border-left-color: #1d4ed8; }
.detail-title { font-weight: 600; margin-bottom: 3px; }
.detail-block .ref { font-size: 8.5pt; color: #6b7280; }
.detail-block .ref a { color: #2563eb; text-decoration: none; }
.fix { color: #166534; margin-top: 4px; }

/* ── Perspective ── */
.perspective { margin-bottom: 18px; }
.perspective h3 { border-bottom: 1px dotted #e5e7eb; padding-bottom: 3px; }
.meta { font-size: 8.5pt; color: #6b7280; margin-bottom: 6px; }

/* ── Notes & Errors ── */
.note { color: #6b7280; font-style: italic; margin: 6px 0; }
.error { color: #991b1b; font-weight: 500; margin: 6px 0; }

/* ── Totals ── */
.totals {
  margin-top: 16px; padding-top: 8px;
  border-top: 1px solid #e5e7eb;
  font-size: 9pt; color: #6b7280; text-align: right;
}

/* ── Footer ── */
footer { margin-top: 40px; text-align: center; font-size: 8pt; color: #9ca3af; }
.footer-rule { height: 1px; background: #d1d5db; margin-bottom: 10px; }
.confidential { font-size: 7pt; letter-spacing: 2px; text-transform: uppercase; margin-top: 4px; color: #d1d5db; }

/* ── Print ── */
@media print {
  body { padding: 0; }
  section { break-inside: avoid; }
  .detail-block { break-inside: avoid; }
  table { break-inside: auto; }
  tr { break-inside: avoid; }
}
</style></head><body>
${body}
</body></html>`;
}

// ─── PDF Generation ───

/**
 * Generate a PDF report from normalized analysis data using Playwright HTML→PDF.
 * @param {Object} data - Analysis result from dep-analyzer.js
 * @param {string} outputPath - Destination PDF file path
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
async function generatePdf(data, outputPath) {
  let browser;
  try {
    const { globalRequire } = require("../shared/global-require");
    const { chromium } = globalRequire("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage();

    const html = buildReportHtml(data);
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.pdf({ path: outputPath, format: "A4", printBackground: true });

    return { ok: true, path: outputPath };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── Main ───

async function main() {
  if (!subcommand) {
    printUsage();
    process.exit(1);
  }

  switch (subcommand) {
    case "deps": {
      const { analyzeDeps } = require(
        path.join(__dirname, "..", "shared", "dep-analyzer.js"),
      );
      const result = analyzeDeps({ cwd: process.cwd() });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case "report": {
      const inputPath = getFlag("--input");
      if (!inputPath) {
        console.error(
          "Error: --input <file> is required for the report subcommand.",
        );
        printUsage();
        process.exit(1);
      }

      // Validate input file exists
      const resolvedInput = path.resolve(inputPath);
      if (!fs.existsSync(resolvedInput)) {
        console.error(`Error: Input file not found: ${resolvedInput}`);
        process.exit(1);
      }

      // Parse input JSON
      let data;
      try {
        const raw = fs.readFileSync(resolvedInput, "utf-8");
        data = JSON.parse(raw);
      } catch (err) {
        console.error(`Error: Failed to parse input JSON: ${err.message}`);
        process.exit(1);
      }

      // Determine output path
      const outputFlag = getFlag("--output");
      const outputPath = outputFlag
        ? path.resolve(outputFlag)
        : path.resolve(`./vela-report-${Date.now()}.pdf`);

      const result = await generatePdf(data, outputPath);
      if (result.ok) {
        console.log(JSON.stringify({ ok: true, path: result.path }));
      } else {
        console.error(`Error: PDF generation failed: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case "run": {
      const perspectivesRaw = getFlag("--perspectives");
      if (!perspectivesRaw) {
        console.error(
          "Error: --perspectives <list> is required for the run subcommand.",
        );
        console.error(`  Valid perspectives: ${VALID_PERSPECTIVES.join(", ")}`);
        printUsage();
        process.exit(1);
      }

      const requested = perspectivesRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const invalid = requested.filter((p) => !VALID_PERSPECTIVES.includes(p));
      if (invalid.length > 0) {
        console.error(`Error: Unknown perspective(s): ${invalid.join(", ")}`);
        console.error(`  Valid perspectives: ${VALID_PERSPECTIVES.join(", ")}`);
        process.exit(1);
      }

      const modelName = getFlag("--model") || "haiku";
      if (!(modelName in MODEL_MAP)) {
        console.error(
          `Error: Unknown model "${modelName}". Valid values: ${Object.keys(MODEL_MAP).join(", ")}`,
        );
        process.exit(1);
      }

      const { sdkAnalyze } = require(
        path.join(__dirname, "..", "shared", "sdk-analyzer.js"),
      );
      const result = await sdkAnalyze({
        perspectives: requested,
        cwd: process.cwd(),
        model: MODEL_MAP[modelName],
      });

      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case "full": {
      // ─── Validate --items flag ───
      const VALID_ITEMS = ["deps", ...VALID_PERSPECTIVES];
      const itemsRaw = getFlag("--items");
      if (!itemsRaw) {
        console.error(
          "Error: --items <list> is required for the full subcommand.",
        );
        console.error(`  Valid items: ${VALID_ITEMS.join(", ")}`);
        printUsage();
        process.exit(1);
      }

      const items = itemsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length === 0) {
        console.error("Error: --items list is empty.");
        console.error(`  Valid items: ${VALID_ITEMS.join(", ")}`);
        process.exit(1);
      }

      const invalidItems = items.filter((i) => !VALID_ITEMS.includes(i));
      if (invalidItems.length > 0) {
        console.error(`Error: Unknown item(s): ${invalidItems.join(", ")}`);
        console.error(`  Valid items: ${VALID_ITEMS.join(", ")}`);
        process.exit(1);
      }

      // ─── Validate --model flag ───
      const fullModelName = getFlag("--model") || "haiku";
      if (!(fullModelName in MODEL_MAP)) {
        console.error(
          `Error: Unknown model "${fullModelName}". Valid values: ${Object.keys(MODEL_MAP).join(", ")}`,
        );
        process.exit(1);
      }

      // ─── Determine output path ───
      const fullOutputFlag = getFlag("--output");
      const fullOutputPath = fullOutputFlag
        ? path.resolve(fullOutputFlag)
        : path.resolve(`./vela-report-${Date.now()}.pdf`);

      // ─── Run selected analyses ───
      const wantDeps = items.includes("deps");
      const sdkPerspectives = items.filter((i) => i !== "deps");
      const combinedData = {
        ok: true,
        selectedItems: items,
        generatedAt: new Date().toISOString(),
      };

      // Run dep-analyzer if requested
      if (wantDeps) {
        try {
          const { analyzeDeps } = require(
            path.join(__dirname, "..", "shared", "dep-analyzer.js"),
          );
          const depResult = analyzeDeps({ cwd: process.cwd() });
          combinedData.deps = depResult;
        } catch (err) {
          combinedData.deps = {
            ok: false,
            error: err.message,
            findings: [],
            outdated: [],
            metadata: {},
          };
        }
      }

      // Run SDK analysis if any perspectives requested
      if (sdkPerspectives.length > 0) {
        try {
          const { sdkAnalyze } = require(
            path.join(__dirname, "..", "shared", "sdk-analyzer.js"),
          );
          const sdkResult = await sdkAnalyze({
            perspectives: sdkPerspectives,
            cwd: process.cwd(),
            model: MODEL_MAP[fullModelName],
          });
          combinedData.codeAnalysis = sdkResult;
        } catch (err) {
          combinedData.codeAnalysis = {
            ok: false,
            error: err.message,
            perspectives: [],
            totalCost: 0,
            totalDurationMs: 0,
            model: MODEL_MAP[fullModelName],
          };
        }
      }

      // Determine overall ok status
      const depsOk = combinedData.deps ? combinedData.deps.ok : true;
      const codeOk = combinedData.codeAnalysis
        ? combinedData.codeAnalysis.ok
        : true;
      combinedData.ok = depsOk || codeOk; // ok if at least one succeeded

      // ─── Generate PDF ───
      const fullPdfResult = await generatePdf(combinedData, fullOutputPath);
      if (fullPdfResult.ok) {
        console.log(
          JSON.stringify({
            ok: true,
            path: fullPdfResult.path,
            selectedItems: items,
          }),
        );
      } else {
        console.error(`Error: PDF generation failed: ${fullPdfResult.error}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: "${subcommand}"`);
      printUsage();
      process.exit(1);
  }
}

module.exports = { main, generatePdf };

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    });
}
