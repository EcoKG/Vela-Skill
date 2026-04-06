#!/usr/bin/env node
/**
 * ⛵ Vela Report — Generate HTML pipeline dashboard
 *
 * Usage: node .vela/cli/vela-report.js [--html output.html]
 */

const fs = require("fs");
const path = require("path");

const CWD = process.cwd();
const VELA_DIR = path.join(CWD, ".vela");
const ARTIFACTS_DIR = path.join(VELA_DIR, "artifacts");
const args = process.argv.slice(2);
const htmlOutput =
  args.indexOf("--html") >= 0 ? args[args.indexOf("--html") + 1] : null;

/**
 * Extract pipeline data from an artifact directory's pipeline-state.json
 */
function extractPipeline(dirPath, date, slug) {
  const sp = path.join(dirPath, "pipeline-state.json");
  if (!fs.existsSync(sp)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(sp, "utf-8"));
    const allFiles = fs.readdirSync(dirPath);
    const artifacts = allFiles.filter(
      (f) => f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".patch"),
    );

    // Extended: capture steps detail, completed_steps, cost, and approval files
    const steps = state.steps || [];
    const completedSteps = state.completed_steps || [];
    const cost = state.cost != null ? state.cost : null;
    const approvals = allFiles
      .filter((f) => /^approval-.*\.json$/.test(f))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dirPath, f), "utf-8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return {
      date,
      slug,
      status: state.status,
      type: state.pipeline_type,
      request: state.request,
      step: state.current_step,
      completed: completedSteps.length,
      total: steps.length,
      created: state.created_at,
      updated: state.updated_at,
      artifacts,
      git: state.git || null,
      // Enhanced fields
      steps,
      completedSteps,
      cost,
      approvals,
    };
  } catch (e) {
    return null;
  }
}

// Collect all pipelines
const pipelines = [];
if (fs.existsSync(ARTIFACTS_DIR)) {
  const allDirs = fs.readdirSync(ARTIFACTS_DIR).sort().reverse();

  // Flat structure: {YYYYMMDD}T{HHmmss}-{slug}/
  for (const dir of allDirs.filter((d) => /^\d{8}T\d{6}-/.test(d))) {
    const dirPath = path.join(ARTIFACTS_DIR, dir);
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const p = extractPipeline(dirPath, dir.slice(0, 8), dir);
    if (p) pipelines.push(p);
  }
}

if (htmlOutput) {
  const statusColor = (s) =>
    s === "completed"
      ? "#22c55e"
      : s === "active"
        ? "#3b82f6"
        : s === "pending"
          ? "#64748b"
          : "#ef4444";

  // Cost aggregation
  const totalCost = pipelines.reduce((sum, p) => sum + (p.cost || 0), 0);
  const completedCount = pipelines.filter(
    (p) => p.status === "completed",
  ).length;
  const activeCount = pipelines.filter((p) => p.status === "active").length;
  const failedCount = pipelines.filter(
    (p) =>
      p.status !== "completed" &&
      p.status !== "active" &&
      p.status !== "pending",
  ).length;

  // Build step status lookup per pipeline
  function getStepStatus(pipeline, stepName) {
    if (
      pipeline.completedSteps.some(
        (cs) => (typeof cs === "string" ? cs : cs.name) === stepName,
      )
    )
      return "completed";
    if (pipeline.step === stepName) return "active";
    return "pending";
  }
  function getStepDuration(pipeline, stepName) {
    const cs = pipeline.completedSteps.find(
      (c) => typeof c === "object" && c.name === stepName,
    );
    return cs && cs.duration ? cs.duration : "-";
  }

  // Generate paired rows: summary + expandable detail
  const rows = pipelines
    .map((p, idx) => {
      // Step-by-step detail table
      const stepRows = p.steps
        .map((s) => {
          const name = typeof s === "string" ? s : s.name || s;
          const st = getStepStatus(p, name);
          const dur = getStepDuration(p, name);
          return `<tr><td>${name}</td><td><span style="color:${statusColor(st)}">${st}</span></td><td>${dur}</td></tr>`;
        })
        .join("");

      // Timeline bar segments
      const segCount = p.steps.length || 1;
      const segments = p.steps
        .map((s) => {
          const name = typeof s === "string" ? s : s.name || s;
          const st = getStepStatus(p, name);
          return `<div class="timeline-segment" style="flex:1;background:${statusColor(st)}" title="${name}: ${st}"></div>`;
        })
        .join("");

      // Artifact list
      const artifactList =
        p.artifacts.length > 0
          ? p.artifacts
              .map((a) => `<span class="artifact-tag">${a}</span>`)
              .join(" ")
          : '<span style="color:#64748b">No artifacts</span>';

      // Cost display
      const costDisplay =
        p.cost != null ? `$${Number(p.cost).toFixed(4)}` : "-";

      // Approval scores
      const approvalDisplay =
        p.approvals && p.approvals.length > 0
          ? p.approvals
              .map((a) => `${a.score || a.result || "reviewed"}`)
              .join(", ")
          : "";

      return `
    <tr class="summary-row" onclick="toggleDetail(${idx})">
      <td>${p.date}</td>
      <td><span style="color:${statusColor(p.status)}">${p.status}</span></td>
      <td>${p.type}</td>
      <td title="${(p.request || "").replace(/"/g, "&quot;")}">${(p.request || "").substring(0, 40)}</td>
      <td>${p.step || "-"}</td>
      <td>${p.completed}/${p.total}</td>
      <td>${costDisplay}</td>
      <td>${p.git?.pipeline_branch || "-"}</td>
    </tr>
    <tr class="detail-row" id="detail-${idx}">
      <td colspan="8">
        <div class="detail-content">
          <div class="detail-section">
            <h4>Timeline</h4>
            <div class="timeline-bar">${segments || '<div class="timeline-segment" style="flex:1;background:#64748b"></div>'}</div>
          </div>
          <div class="detail-columns">
            <div class="detail-section">
              <h4>Steps</h4>
              ${stepRows ? `<table class="step-table"><tr><th>Step</th><th>Status</th><th>Duration</th></tr>${stepRows}</table>` : '<p style="color:#64748b">No step data</p>'}
            </div>
            <div class="detail-section">
              <h4>Artifacts (${p.artifacts.length})</h4>
              <div class="artifact-list">${artifactList}</div>
              ${approvalDisplay ? `<h4 style="margin-top:0.75rem">Approvals</h4><p>${approvalDisplay}</p>` : ""}
            </div>
          </div>
        </div>
      </td>
    </tr>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>⛵ Vela Dashboard</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem;max-width:1400px;margin:0 auto}
h1{text-align:center;font-size:2rem;margin-bottom:0.5rem}
.subtitle{text-align:center;color:#64748b;font-size:0.9rem;margin-bottom:2rem}
table{width:100%;border-collapse:collapse;margin-top:1.5rem}
th{background:#1e293b;padding:0.75rem;text-align:left;border-bottom:2px solid #334155;font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8}
td{padding:0.75rem;border-bottom:1px solid #1e293b}
.summary-row{cursor:pointer;transition:background 0.15s}
.summary-row:hover{background:#1e293b}
.detail-row{display:none;background:#0c1222}
.detail-row td{padding:1rem 1.5rem}
.detail-content{display:flex;flex-direction:column;gap:1rem}
.detail-columns{display:flex;gap:2rem;flex-wrap:wrap}
.detail-columns>.detail-section{flex:1;min-width:250px}
.detail-section h4{margin:0 0 0.5rem;color:#38bdf8;font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em}
.timeline-bar{display:flex;height:12px;border-radius:6px;overflow:hidden;gap:2px;margin-bottom:0.5rem}
.timeline-segment{border-radius:3px;min-width:8px;transition:opacity 0.15s}
.timeline-segment:hover{opacity:0.8}
.step-table{width:100%;font-size:0.85rem}
.step-table th{padding:0.4rem 0.6rem;background:#1a2332;font-size:0.75rem}
.step-table td{padding:0.4rem 0.6rem;border-bottom:1px solid #1a2332}
.artifact-list{display:flex;flex-wrap:wrap;gap:0.4rem}
.artifact-tag{background:#1e293b;padding:0.2rem 0.6rem;border-radius:4px;font-size:0.8rem;color:#94a3b8;border:1px solid #334155}
.stats{display:flex;gap:1.5rem;justify-content:center;margin-top:1rem;flex-wrap:wrap}
.stat{text-align:center;padding:1rem 2rem;background:#1e293b;border-radius:8px;min-width:120px}
.stat-num{font-size:2rem;font-weight:bold;color:#38bdf8}
.stat-label{font-size:0.85rem;color:#94a3b8}
.cost-summary{text-align:center;margin:1.5rem 0;padding:1rem;background:#1e293b;border-radius:8px;border:1px solid #334155}
.cost-summary .cost-total{font-size:1.5rem;font-weight:bold;color:#fbbf24}
.cost-summary .cost-label{font-size:0.85rem;color:#94a3b8;margin-top:0.25rem}
@media(max-width:768px){
  body{padding:1rem}
  .stats{flex-direction:column;align-items:center}
  .detail-columns{flex-direction:column}
  table{font-size:0.85rem}
  td,th{padding:0.5rem}
}
</style></head><body>
<h1>⛵ Vela Dashboard</h1>
<p class="subtitle">Generated ${new Date().toISOString().split("T")[0]}</p>
<div class="stats">
  <div class="stat"><div class="stat-num">${pipelines.length}</div><div class="stat-label">Total Pipelines</div></div>
  <div class="stat"><div class="stat-num">${completedCount}</div><div class="stat-label">Completed</div></div>
  <div class="stat"><div class="stat-num">${activeCount}</div><div class="stat-label">Active</div></div>
  ${failedCount > 0 ? `<div class="stat"><div class="stat-num" style="color:#ef4444">${failedCount}</div><div class="stat-label">Failed</div></div>` : ""}
</div>
<div class="cost-summary">
  <div class="cost-total">${totalCost > 0 ? "$" + totalCost.toFixed(4) : "-"}</div>
  <div class="cost-label">Total Cost Across All Pipelines</div>
</div>
<table>
<tr><th>Date</th><th>Status</th><th>Type</th><th>Task</th><th>Step</th><th>Progress</th><th>Cost</th><th>Branch</th></tr>
${rows}
${pipelines.length === 0 ? '<tr><td colspan="8" style="text-align:center;color:#64748b;padding:2rem">No pipelines found</td></tr>' : ""}
</table>
<script>
function toggleDetail(idx){var el=document.getElementById('detail-'+idx);if(el){el.style.display=el.style.display==='table-row'?'none':'table-row';}}
</script>
</body></html>`;

  fs.writeFileSync(htmlOutput, html);
  console.log(
    JSON.stringify({
      ok: true,
      command: "report",
      output: htmlOutput,
      pipelines: pipelines.length,
    }),
  );
} else {
  console.log(
    JSON.stringify(
      { ok: true, command: "report", pipelines: pipelines },
      null,
      2,
    ),
  );
}
