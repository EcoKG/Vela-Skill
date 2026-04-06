/**
 * Vela Wave Executor
 * Executes plan.md tasks in parallel waves using topological ordering.
 *
 * Combines vela-wave.js (wave grouping via Kahn's algorithm) with
 * sdk-executor.js (worktree-isolated SDK execution) to run independent
 * tasks concurrently within each wave, while respecting dependency order
 * across waves.
 *
 * Design:
 * - Wave N+1 starts only after Wave N fully settles (all promises resolved/rejected)
 * - Within a wave, tasks run via Promise.allSettled() — one failure doesn't block siblings
 * - Each task gets a unique pipelineSlug for worktree isolation
 * - Produces wave-summary.md artifact in artifactDir
 *
 * Exports: executeWaves({ artifactDir, cwd, pipelineSlug })
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {
  parsePlanMd,
  buildDependencyGraph,
  topologicalSort,
} = require("../cli/vela-wave.js");
const { sdkExecute } = require("./sdk-executor");

// ── Helpers ──────────────────────────────────────────────────

/**
 * Sanitize a task name into a slug-safe string.
 * Removes non-alphanumeric chars (except hyphens), lowercases, trims dashes.
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Generate wave-summary.md content from execution results.
 */
function buildWaveSummary(result) {
  const lines = [];
  lines.push("# Wave Execution Summary");
  lines.push("");
  lines.push(`- **Status:** ${result.ok ? "✅ All waves completed" : "❌ Failures detected"}`);
  lines.push(`- **Total tasks:** ${result.totalTasks}`);
  lines.push(`- **Total waves:** ${result.totalWaves}`);
  lines.push(`- **Total cost:** $${result.totalCost.toFixed(4)}`);
  lines.push(`- **Total duration:** ${result.totalDurationMs}ms`);
  lines.push("");

  for (const wave of result.waves) {
    const waveOk = wave.tasks.every((t) => t.ok);
    lines.push(`## 🌊 Wave ${wave.wave} (${wave.parallel} parallel)`);
    lines.push(`Status: ${waveOk ? "✅" : "❌"}`);
    lines.push("");
    lines.push("| Task | Status | Cost | Duration |");
    lines.push("|------|--------|------|----------|");
    for (const t of wave.tasks) {
      lines.push(
        `| ${t.name} | ${t.ok ? "✅" : "❌"} | $${t.cost.toFixed(4)} | ${t.durationMs}ms |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Core Executor ────────────────────────────────────────────

/**
 * Execute plan.md tasks in parallel waves.
 *
 * Reads plan.md from artifactDir, groups tasks into dependency-ordered waves
 * via vela-wave.js, then executes each wave's tasks concurrently using
 * sdk-executor.js with Promise.allSettled().
 *
 * @param {Object} opts
 * @param {string} opts.artifactDir - Directory containing plan.md
 * @param {string} opts.cwd - Project root working directory
 * @param {string} opts.pipelineSlug - Base pipeline slug for worktree naming
 * @returns {Promise<Object>} Result:
 *   Success: { ok, totalTasks, totalWaves, waves, totalCost, totalDurationMs }
 *   No tasks: { ok: false, error: 'no_tasks_found' }
 *   No plan: { ok: false, error: 'plan_not_found' }
 */
async function executeWaves(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    return { ok: false, error: "invalid_input" };
  }

  const { artifactDir, cwd, pipelineSlug } = opts;

  // ── 1. Read plan.md ────────────────────────────────────────
  const planPath = path.join(artifactDir, "plan.md");
  if (!fs.existsSync(planPath)) {
    return { ok: false, error: "plan_not_found" };
  }

  const content = fs.readFileSync(planPath, "utf-8");

  // ── 2. Parse and compute waves ─────────────────────────────
  const tasks = parsePlanMd(content);
  if (tasks.length === 0) {
    return { ok: false, error: "no_tasks_found" };
  }

  let waves;
  try {
    const graph = buildDependencyGraph(tasks);
    waves = topologicalSort(graph);
  } catch (err) {
    return { ok: false, error: "cycle_detected", details: err.message };
  }

  // ── 3. Execute waves sequentially, tasks within wave in parallel ──
  const overallStart = Date.now();
  const waveResults = [];
  let totalCost = 0;
  let allOk = true;

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const waveTaskNames = waves[waveIdx];
    const waveStart = Date.now();

    // Launch all tasks in this wave concurrently
    const taskPromises = waveTaskNames.map(async (taskName) => {
      const taskSlug = `${pipelineSlug}-w${waveIdx + 1}-${slugify(taskName)}`;
      const taskStart = Date.now();

      try {
        const result = await sdkExecute({
          step: taskName,
          artifactDir,
          cwd,
          pipelineSlug: taskSlug,
        });

        const durationMs = Date.now() - taskStart;
        const cost = result.cost || 0;

        return {
          name: taskName,
          ok: result.ok === true,
          cost,
          durationMs,
          error: result.ok ? undefined : result.error,
        };
      } catch (err) {
        const durationMs = Date.now() - taskStart;
        return {
          name: taskName,
          ok: false,
          cost: 0,
          durationMs,
          error: err.message,
        };
      }
    });

    // Wait for all tasks in this wave to settle
    const settled = await Promise.allSettled(taskPromises);

    const taskResults = settled.map((s) => {
      if (s.status === "fulfilled") {
        return s.value;
      }
      // Rejected promise — should not happen since we catch inside, but handle defensively
      return {
        name: "unknown",
        ok: false,
        cost: 0,
        durationMs: 0,
        error: s.reason?.message || String(s.reason),
      };
    });

    const waveCost = taskResults.reduce((sum, t) => sum + t.cost, 0);
    totalCost += waveCost;

    const waveOk = taskResults.every((t) => t.ok);
    if (!waveOk) allOk = false;

    waveResults.push({
      wave: waveIdx + 1,
      parallel: waveTaskNames.length,
      tasks: taskResults,
    });
  }

  const totalDurationMs = Date.now() - overallStart;

  // ── 4. Build result ────────────────────────────────────────
  const result = {
    ok: allOk,
    totalTasks: tasks.length,
    totalWaves: waves.length,
    waves: waveResults,
    totalCost,
    totalDurationMs,
  };

  // ── 5. Write wave-summary.md artifact ─────────────────────
  try {
    const summaryContent = buildWaveSummary(result);
    const summaryPath = path.join(artifactDir, "wave-summary.md");
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, summaryContent, "utf8");
  } catch (err) {
    // Non-fatal — don't fail the execution because summary writing failed
    process.stderr.write(
      `[wave-executor] Failed to write wave-summary.md: ${err.message}\n`
    );
  }

  return result;
}

module.exports = { executeWaves };
