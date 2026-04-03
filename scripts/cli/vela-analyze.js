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

  let body = "";

  // ─── Header (Title Page) ───
  body += `<header>
  <h1>Vela Analysis Report</h1>
  <p class="date">${esc(dateStr)}</p>
  ${data.selectedItems ? `<p class="scope">Analysis scope: ${esc(data.selectedItems.join(", "))}</p>` : ""}
</header>`;

  // ─── Dependency Sections ───
  if (hasDeps) {
    const meta = depData.metadata || {};
    const bySev = meta.bySeverity || {};

    // Summary Statistics
    body += `<section class="summary">
  <h2>Summary</h2>
  <p>Total Vulnerabilities: ${meta.totalVulnerabilities || 0}</p>
  <p class="severity-row">
    <span style="color:${SEV_COLORS.critical}">Critical: ${bySev.critical || 0}</span>
    <span style="color:${SEV_COLORS.high}">High: ${bySev.high || 0}</span>
    <span style="color:${SEV_COLORS.moderate}">Moderate: ${bySev.moderate || 0}</span>
    <span style="color:${SEV_COLORS.low}">Low: ${bySev.low || 0}</span>
    <span style="color:${SEV_COLORS.info}">Info: ${bySev.info || 0}</span>
  </p>
  <p>Outdated Packages: ${meta.outdatedCount || 0}</p>
</section>`;

    // Vulnerability Findings
    const findings = depData.findings || [];
    body += `<section class="findings">
  <h2>Vulnerability Findings</h2>`;

    if (findings.length === 0) {
      body += `<p>No vulnerabilities found.</p>`;
    } else {
      const severityOrder = ["critical", "high", "moderate", "low", "info", "unknown"];
      const grouped = {};
      for (const f of findings) {
        const sev = (f.severity || "unknown").toLowerCase();
        if (!grouped[sev]) grouped[sev] = [];
        grouped[sev].push(f);
      }

      for (const sev of severityOrder) {
        if (!grouped[sev] || grouped[sev].length === 0) continue;
        const color = SEV_COLORS[sev] || "#000000";

        body += `<h3 style="color:${color}">${sev.toUpperCase()} (${grouped[sev].length})</h3>`;

        for (const f of grouped[sev]) {
          body += `<div class="finding-item">
  <p><strong>Package:</strong> ${esc(f.name)}</p>
  ${f.title ? `<p><strong>Title:</strong> ${esc(f.title)}</p>` : ""}
  <p><strong>Direct:</strong> ${f.isDirect ? "Yes" : "No"} &nbsp; <strong>Fix Available:</strong> ${f.fixAvailable ? "Yes" : "No"}</p>
  ${f.url ? `<p><strong>URL:</strong> <a href="${esc(f.url)}">${esc(f.url)}</a></p>` : ""}
</div>`;
        }
      }
    }
    body += `</section>`;

    // Outdated Packages
    const outdated = depData.outdated || [];
    body += `<section class="outdated">
  <h2>Outdated Packages</h2>`;

    if (outdated.length === 0) {
      body += `<p>All packages are up to date.</p>`;
    } else {
      body += `<table>
  <thead><tr><th>Package</th><th>Current</th><th>Wanted</th><th>Latest</th></tr></thead>
  <tbody>`;
      for (const pkg of outdated) {
        body += `<tr><td>${esc(pkg.name)}</td><td>${esc(pkg.current)}</td><td>${esc(pkg.wanted)}</td><td>${esc(pkg.latest)}</td></tr>`;
      }
      body += `</tbody></table>`;
    }
    body += `</section>`;
  }

  // ─── Code Analysis ───
  if (data.codeAnalysis) {
    body += `<section class="code-analysis">
  <h2>Code Analysis</h2>`;

    if (
      !data.codeAnalysis.ok &&
      (!data.codeAnalysis.perspectives || data.codeAnalysis.perspectives.length === 0)
    ) {
      body += `<p class="error">Code analysis failed: ${esc(data.codeAnalysis.error || "Unknown error")}</p>`;
    } else {
      const perspectives = data.codeAnalysis.perspectives || [];

      for (const p of perspectives) {
        const pName =
          (p.perspective || "unknown").charAt(0).toUpperCase() +
          (p.perspective || "unknown").slice(1);

        body += `<div class="perspective">
  <h3 style="color:#2255AA">${esc(pName)} Analysis</h3>`;

        if (!p.ok) {
          body += `<p class="error">Analysis failed: ${esc(p.error || "Unknown error")}</p></div>`;
          continue;
        }

        body += `<p class="meta">Findings: ${(p.findings || []).length} &nbsp; Cost: $${(p.cost || 0).toFixed(3)} &nbsp; Duration: ${((p.durationMs || 0) / 1000).toFixed(1)}s</p>`;

        const pFindings = p.findings || [];
        if (pFindings.length === 0) {
          body += `<p>No findings.</p></div>`;
          continue;
        }

        for (const f of pFindings) {
          const sev = (f.severity || "info").toLowerCase();
          const color = SEV_COLORS[sev] || "#000000";

          body += `<div class="code-finding">
  <p style="color:${color}"><strong>[${sev.toUpperCase()}]</strong> ${esc(f.name || f.description || "Finding")}</p>
  ${f.file ? `<p class="file">File: ${esc(f.file)}${f.line ? ":" + f.line : ""}</p>` : ""}
  ${f.description ? `<p class="desc">${esc(f.description)}</p>` : ""}
  ${f.suggestion ? `<p class="fix">Fix: ${esc(f.suggestion)}</p>` : ""}
</div>`;
        }
        body += `</div>`;
      }

      // Code analysis summary
      const okPerspectives = perspectives.filter((p) => p.ok);
      body += `<div class="analysis-summary">
  <p>Perspectives analyzed: ${okPerspectives.length}/${perspectives.length}</p>
  ${data.codeAnalysis.totalCost != null ? `<p>Total analysis cost: $${data.codeAnalysis.totalCost.toFixed(3)}</p>` : ""}
</div>`;
    }
    body += `</section>`;
  }

  // ─── Footer ───
  body += `<footer><p>Generated by Vela Analyzer</p></footer>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>Vela Analysis Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#fff;color:#111;padding:40px 50px;max-width:800px;margin:0 auto;font-size:11pt;line-height:1.5}
header{text-align:center;margin-bottom:2rem}
header h1{font-size:24pt;margin-bottom:0.3rem}
header .date{color:#666;font-size:12pt}
header .scope{color:#888;font-size:10pt}
h2{font-size:16pt;border-bottom:1px solid #ccc;padding-bottom:4px;margin:1.5rem 0 0.5rem}
h3{font-size:13pt;margin:0.8rem 0 0.3rem}
section{margin-bottom:1rem}
.severity-row{display:flex;gap:1.5rem;flex-wrap:wrap}
.severity-row span{font-weight:600}
.finding-item{margin:0.4rem 0 0.8rem 0.5rem;padding-left:0.5rem;border-left:3px solid #eee}
.finding-item p{margin:0.1rem 0}
table{width:100%;border-collapse:collapse;margin:0.5rem 0}
th{background:#f5f5f5;padding:6px 10px;text-align:left;border-bottom:2px solid #ccc;font-size:10pt;color:#444}
td{padding:6px 10px;border-bottom:1px solid #eee;font-size:10pt}
.perspective{margin-bottom:1rem}
.meta{font-size:10pt;color:#666;margin-bottom:0.3rem}
.code-finding{margin:0.3rem 0 0.6rem 0.5rem;padding-left:0.5rem;border-left:3px solid #eee}
.code-finding p{margin:0.1rem 0}
.code-finding .file{font-size:10pt;color:#555;font-family:monospace}
.code-finding .desc{font-size:10pt}
.code-finding .fix{font-size:10pt;color:#336633}
.error{color:#CC0000}
.analysis-summary{margin-top:0.5rem;font-size:11pt}
footer{margin-top:2rem;text-align:center;color:#999;font-size:9pt}
a{color:#4488CC;text-decoration:none}
@media print{body{padding:20px}}
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
    const { chromium } = require("playwright");
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
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
