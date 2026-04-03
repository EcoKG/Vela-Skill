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

  // ─── Title Page ───
  body += `<header>
  <div class="logo">⛵</div>
  <h1>Vela Analysis Report</h1>
  <div class="subtitle">Automated Code & Dependency Analysis</div>
  <div class="date">${esc(dateStr)}</div>
  ${data.selectedItems ? `<div class="scope">${esc(data.selectedItems.join(" · ").toUpperCase())}</div>` : ""}
</header>`;

  // ─── Dashboard Summary ───
  if (hasDeps) {
    const riskLevel = (bySev.critical || 0) > 0 ? "critical" : (bySev.high || 0) > 0 ? "high" : (bySev.moderate || 0) > 0 ? "moderate" : "healthy";
    const riskLabel = { critical: "🔴 Critical Risk", high: "🟠 High Risk", moderate: "🟡 Moderate Risk", healthy: "🟢 Healthy" }[riskLevel];
    const riskColor = { critical: "#DC2626", high: "#EA580C", moderate: "#D97706", healthy: "#16A34A" }[riskLevel];

    body += `<section class="dashboard">
  <h2>📊 Overview</h2>
  <div class="risk-badge" style="background:${riskColor}">${riskLabel}</div>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-value">${totalVuln}</div><div class="stat-label">Vulnerabilities</div></div>
    <div class="stat-card"><div class="stat-value">${meta.outdatedCount || 0}</div><div class="stat-label">Outdated</div></div>
    <div class="stat-card"><div class="stat-value">${meta.totalDependencies || "—"}</div><div class="stat-label">Dependencies</div></div>
    <div class="stat-card"><div class="stat-value">${data.codeAnalysis ? (data.codeAnalysis.perspectives || []).filter(p => p.ok).length : "—"}</div><div class="stat-label">Perspectives</div></div>
  </div>
  ${totalVuln > 0 ? `<div class="sev-bar">
    ${(bySev.critical || 0) > 0 ? `<span class="sev-pill sev-critical">${bySev.critical} Critical</span>` : ""}
    ${(bySev.high || 0) > 0 ? `<span class="sev-pill sev-high">${bySev.high} High</span>` : ""}
    ${(bySev.moderate || 0) > 0 ? `<span class="sev-pill sev-moderate">${bySev.moderate} Moderate</span>` : ""}
    ${(bySev.low || 0) > 0 ? `<span class="sev-pill sev-low">${bySev.low} Low</span>` : ""}
    ${(bySev.info || 0) > 0 ? `<span class="sev-pill sev-info">${bySev.info} Info</span>` : ""}
  </div>` : ""}
</section>`;

    // ─── Vulnerability Findings ───
    const findings = depData.findings || [];
    body += `<section class="findings">
  <h2>🔒 Vulnerability Findings</h2>`;

    if (findings.length === 0) {
      body += `<div class="empty-state">
  <div class="empty-icon">✅</div>
  <p>No vulnerabilities found.</p>
</div>`;
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

        body += `<div class="sev-group">
  <h3><span class="sev-pill sev-${sev}">${sev.toUpperCase()}</span> <span class="sev-count">${grouped[sev].length} finding${grouped[sev].length > 1 ? "s" : ""}</span></h3>`;

        for (const f of grouped[sev]) {
          body += `<div class="finding-card">
  <div class="finding-header"><strong>${esc(f.name)}</strong></div>
  ${f.title ? `<p class="finding-title">${esc(f.title)}</p>` : ""}
  <div class="finding-meta">
    <span>${f.isDirect ? "📦 Direct" : "📎 Transitive"}</span>
    <span>${f.fixAvailable ? "🔧 Fix Available" : "⚠ No Fix"}</span>
  </div>
  ${f.url ? `<p class="finding-url"><a href="${esc(f.url)}">${esc(f.url)}</a></p>` : ""}
</div>`;
        }
        body += `</div>`;
      }
    }
    body += `</section>`;

    // ─── Outdated Packages ───
    const outdated = depData.outdated || [];
    body += `<section class="outdated">
  <h2>📦 Outdated Packages</h2>`;

    if (outdated.length === 0) {
      body += `<div class="empty-state">
  <div class="empty-icon">✅</div>
  <p>All packages are up to date.</p>
</div>`;
    } else {
      body += `<table>
  <thead><tr><th>Package</th><th>Current</th><th>Wanted</th><th>Latest</th><th>Gap</th></tr></thead>
  <tbody>`;
      for (const pkg of outdated) {
        const curMajor = (pkg.current || "").split(".")[0];
        const latMajor = (pkg.latest || "").split(".")[0];
        const isMajor = curMajor !== latMajor;
        body += `<tr${isMajor ? ' class="major-update"' : ""}>
  <td><strong>${esc(pkg.name)}</strong></td>
  <td><code>${esc(pkg.current)}</code></td>
  <td><code>${esc(pkg.wanted)}</code></td>
  <td><code>${esc(pkg.latest)}</code></td>
  <td>${isMajor ? '<span class="sev-pill sev-high" style="font-size:8pt">MAJOR</span>' : '<span class="sev-pill sev-info" style="font-size:8pt">minor</span>'}</td>
</tr>`;
      }
      body += `</tbody></table>`;
    }
    body += `</section>`;
  }

  // ─── Code Analysis ───
  if (data.codeAnalysis) {
    body += `<section class="code-analysis">
  <h2>🔍 Code Analysis</h2>`;

    if (
      !data.codeAnalysis.ok &&
      (!data.codeAnalysis.perspectives || data.codeAnalysis.perspectives.length === 0)
    ) {
      body += `<div class="error-card"><p>⚠ Code analysis failed: ${esc(data.codeAnalysis.error || "Unknown error")}</p></div>`;
    } else {
      const perspectives = data.codeAnalysis.perspectives || [];

      for (const p of perspectives) {
        const pName =
          (p.perspective || "unknown").charAt(0).toUpperCase() +
          (p.perspective || "unknown").slice(1);

        const pIcon = { security: "🔐", bugs: "🐛", performance: "⚡", "code-quality": "✨", architecture: "🏗" }[p.perspective] || "📋";

        body += `<div class="perspective-card">
  <h3>${pIcon} ${esc(pName)}</h3>`;

        if (!p.ok) {
          body += `<div class="error-card"><p>Analysis failed: ${esc(p.error || "Unknown error")}</p></div></div>`;
          continue;
        }

        body += `<div class="perspective-meta">
  <span>${(p.findings || []).length} findings</span>
  <span>Cost: $${(p.cost || 0).toFixed(3)}</span>
  <span>Duration: ${((p.durationMs || 0) / 1000).toFixed(1)}s</span>
</div>`;

        const pFindings = p.findings || [];
        if (pFindings.length === 0) {
          body += `<p class="no-findings">No issues found. ✅</p></div>`;
          continue;
        }

        for (const f of pFindings) {
          const sev = (f.severity || "info").toLowerCase();

          body += `<div class="code-finding">
  <div class="cf-header">
    <span class="sev-pill sev-${sev}">${sev.toUpperCase()}</span>
    <strong>${esc(f.name || f.description || "Finding")}</strong>
  </div>
  ${f.file ? `<div class="cf-location"><code>${esc(f.file)}${f.line ? ":" + f.line : ""}</code></div>` : ""}
  ${f.description ? `<p class="cf-desc">${esc(f.description)}</p>` : ""}
  ${f.suggestion ? `<div class="cf-fix"><span class="fix-label">💡 Fix:</span> ${esc(f.suggestion)}</div>` : ""}
</div>`;
        }
        body += `</div>`;
      }

      // Code analysis summary
      const okPerspectives = perspectives.filter((p) => p.ok);
      const totalFindings = perspectives.reduce((sum, p) => sum + (p.findings || []).length, 0);
      body += `<div class="analysis-footer">
  <p><strong>${okPerspectives.length}/${perspectives.length}</strong> perspectives analyzed · <strong>${totalFindings}</strong> total findings</p>
  ${data.codeAnalysis.totalCost != null ? `<p>Total cost: $${data.codeAnalysis.totalCost.toFixed(3)}</p>` : ""}
</div>`;
    }
    body += `</section>`;
  }

  // ─── Footer ───
  body += `<footer>
  <div class="footer-line"></div>
  <p>Generated by <strong>Vela Analyzer</strong> · ${esc(dateStr)}</p>
</footer>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>Vela Analysis Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}

/* ─── Base ─── */
body{
  font-family:system-ui,-apple-system,'Segoe UI','Noto Sans KR',sans-serif;
  background:#fff;color:#1a1a2e;
  padding:0 50px 40px;max-width:820px;margin:0 auto;
  font-size:10.5pt;line-height:1.65;
}

/* ─── Title Page ─── */
header{
  text-align:center;padding:60px 0 40px;
  border-bottom:3px solid #1a1a2e;margin-bottom:2rem;
}
header .logo{font-size:48pt;margin-bottom:0.3rem}
header h1{font-size:26pt;font-weight:800;letter-spacing:-0.5px;color:#1a1a2e;margin-bottom:0.2rem}
header .subtitle{font-size:11pt;color:#64748b;font-weight:400;margin-bottom:1rem}
header .date{font-size:11pt;color:#64748b;font-weight:500}
header .scope{
  display:inline-block;margin-top:0.8rem;padding:4px 16px;
  background:#f1f5f9;border-radius:20px;font-size:9pt;
  color:#475569;letter-spacing:1px;font-weight:600;
}

/* ─── Section Headers ─── */
h2{
  font-size:15pt;font-weight:700;color:#1a1a2e;
  border-bottom:2px solid #e2e8f0;padding-bottom:6px;
  margin:2rem 0 0.8rem;
}
h3{font-size:12pt;font-weight:600;margin:0.8rem 0 0.4rem;color:#334155}

/* ─── Dashboard ─── */
.dashboard{margin-bottom:1.5rem}
.risk-badge{
  display:inline-block;padding:6px 20px;border-radius:20px;
  color:#fff;font-size:11pt;font-weight:700;margin-bottom:1rem;
}
.stat-grid{
  display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:1rem;
}
.stat-card{
  background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;
  padding:14px 12px;text-align:center;
}
.stat-value{font-size:22pt;font-weight:800;color:#1e293b;line-height:1.1}
.stat-label{font-size:8.5pt;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;font-weight:600}
.sev-bar{display:flex;gap:8px;flex-wrap:wrap;margin-top:0.5rem}

/* ─── Severity Pills ─── */
.sev-pill{
  display:inline-block;padding:2px 10px;border-radius:12px;
  font-size:9pt;font-weight:700;color:#fff;
}
.sev-critical{background:#DC2626}
.sev-high{background:#EA580C}
.sev-moderate{background:#D97706}
.sev-low{background:#64748B}
.sev-info{background:#2563EB}

/* ─── Finding Cards ─── */
.finding-card{
  background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;
  padding:10px 14px;margin:6px 0;
}
.finding-header{font-size:10.5pt;color:#1e293b}
.finding-title{font-size:9.5pt;color:#475569;margin:2px 0}
.finding-meta{display:flex;gap:12px;font-size:9pt;color:#64748b;margin-top:4px}
.finding-url{font-size:8.5pt;margin-top:3px}
.finding-url a{color:#2563EB;text-decoration:none}

.sev-group{margin-bottom:1rem}
.sev-count{font-size:10pt;color:#64748b;font-weight:400}

/* ─── Empty State ─── */
.empty-state{text-align:center;padding:1.5rem;color:#64748b;font-size:11pt}
.empty-icon{font-size:24pt;margin-bottom:0.3rem}

/* ─── Tables ─── */
table{width:100%;border-collapse:collapse;margin:0.5rem 0;font-size:9.5pt}
th{
  background:#f1f5f9;padding:8px 12px;text-align:left;
  border-bottom:2px solid #cbd5e1;color:#334155;
  font-size:9pt;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;
}
td{padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#334155}
tr:hover td{background:#f8fafc}
tr.major-update td{background:#fef2f2}
code{
  font-family:'SF Mono','Fira Code',monospace;font-size:9pt;
  background:#f1f5f9;padding:1px 5px;border-radius:4px;color:#334155;
}

/* ─── Perspective Cards ─── */
.perspective-card{
  background:#fff;border:1px solid #e2e8f0;border-radius:10px;
  padding:16px 18px;margin:10px 0;
}
.perspective-card h3{margin:0 0 6px;font-size:12pt}
.perspective-meta{
  display:flex;gap:16px;font-size:9pt;color:#64748b;
  padding-bottom:8px;border-bottom:1px solid #f1f5f9;margin-bottom:8px;
}
.no-findings{color:#16A34A;font-weight:500;padding:6px 0}

/* ─── Code Findings ─── */
.code-finding{
  padding:8px 12px;margin:6px 0;
  border-left:3px solid #e2e8f0;background:#fafafa;border-radius:0 6px 6px 0;
}
.cf-header{display:flex;align-items:center;gap:8px;font-size:10pt}
.cf-location{font-size:9pt;margin:3px 0}
.cf-location code{background:#e2e8f0}
.cf-desc{font-size:9.5pt;color:#475569;margin:4px 0;line-height:1.5}
.cf-fix{
  font-size:9pt;color:#15803d;margin-top:4px;padding:6px 10px;
  background:#f0fdf4;border-radius:6px;
}
.fix-label{font-weight:600}

/* ─── Error ─── */
.error-card{
  background:#fef2f2;border:1px solid #fecaca;border-radius:8px;
  padding:10px 14px;color:#991B1B;font-size:10pt;
}

/* ─── Analysis Footer ─── */
.analysis-footer{
  text-align:center;padding:12px 0;margin-top:1rem;
  border-top:1px solid #e2e8f0;font-size:10pt;color:#64748b;
}

/* ─── Footer ─── */
footer{margin-top:2.5rem;text-align:center;color:#94a3b8;font-size:8.5pt}
.footer-line{
  height:1px;background:linear-gradient(90deg,transparent,#cbd5e1,transparent);
  margin-bottom:12px;
}
footer strong{color:#64748b}

/* ─── Print ─── */
@media print{
  body{padding:20px 30px}
  .perspective-card{break-inside:avoid}
  .finding-card{break-inside:avoid}
  .code-finding{break-inside:avoid}
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
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
