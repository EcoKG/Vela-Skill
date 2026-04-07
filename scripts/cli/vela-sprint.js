#!/usr/bin/env node
/**
 * Vela Sprint CLI — Multi-slice Sprint Orchestration
 *
 * Plans and executes multi-slice sprints using sprint-manager queue system.
 * Each slice is executed as an independent pipeline run via vela-pipeline.js
 * CLI bridge (K025). Context from completed dependency slices is passed
 * to subsequent slices via buildSliceContext.
 *
 * Commands:
 *   run <request>       — Plan a sprint and execute all slices sequentially
 *   status [sprint-id]  — Show sprint state and per-slice progress
 *   resume [sprint-id]  — Resume an interrupted sprint from where it stopped
 *   cancel [sprint-id]  — Cancel an active sprint
 *
 * Architecture:
 *   - sdk-sprint-planner.js plans the sprint (Sonnet-based decomposition)
 *   - sprint-manager.js manages sprint state (CRUD, FSM, queue)
 *   - vela-pipeline.js executes each slice (CLI bridge, K025)
 *   - Context passing: buildSliceContext collects dependency results
 *
 * Key decisions:
 *   K025: CLI bridge for per-slice pipeline execution
 *   K030: require.main === module guard
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ─── Paths ───
const CWD = process.cwd();
const VELA_DIR = path.join(CWD, ".vela");
const PIPELINE_PATH = path.resolve(__dirname, "vela-pipeline.js");
const SPRINT_LOCK_PATH = path.join(VELA_DIR, "state", ".sprint.lock");

// ─── Sprint Manager ───
const {
  loadSprint,
  findActiveSprint,
  listSprints,
  updateSliceStatus,
  updateSprintStatus,
  getNextSlice,
  SPRINTS_DIR,
} = require("../shared/sprint-manager");

// ─── Sprint Planner ───
const { sprintPlan } = require("../shared/sdk-sprint-planner");

// ─── CLI Argument Parsing ───
const args = process.argv.slice(2);
const command = args[0];

// ═══════════════════════════════════════════════════════════
//  Sprint Lock — prevents duplicate run/resume
// ═══════════════════════════════════════════════════════════

/**
 * Acquire the sprint lock. Writes PID to lock file.
 * If a lock already exists and the holding process is alive, rejects.
 * Stale locks (dead PID) are automatically cleaned up.
 * Pattern from vela-pipeline.js acquireLock (separate lock path).
 */
function acquireSprintLock() {
  const stateDir = path.dirname(SPRINT_LOCK_PATH);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  if (fs.existsSync(SPRINT_LOCK_PATH)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(SPRINT_LOCK_PATH, "utf8"));
      try {
        process.kill(lockData.pid, 0); // signal 0 = check existence
        console.error("❌ 스프린트가 이미 실행 중입니다.");
        console.error(`   PID: ${lockData.pid} | 시작: ${lockData.started_at}`);
        console.error("   중복 실행은 스프린트 상태를 꼬이게 합니다.");
        console.error("   기다리거나, 기존 프로세스가 완료된 후 다시 시도하십시오.");
        process.exit(1);
      } catch (_e) {
        // Process is dead — stale lock, clean up
        fs.unlinkSync(SPRINT_LOCK_PATH);
      }
    } catch (_e) {
      // Corrupt lock file — clean up
      try {
        fs.unlinkSync(SPRINT_LOCK_PATH);
      } catch (_e2) {
        /* best-effort */
      }
    }
  }

  fs.writeFileSync(
    SPRINT_LOCK_PATH,
    JSON.stringify({
      pid: process.pid,
      started_at: new Date().toISOString(),
    }),
  );
}

/**
 * Release the sprint lock. Only releases if we own it.
 */
function releaseSprintLock() {
  try {
    if (fs.existsSync(SPRINT_LOCK_PATH)) {
      const lockData = JSON.parse(fs.readFileSync(SPRINT_LOCK_PATH, "utf8"));
      if (lockData.pid === process.pid) {
        fs.unlinkSync(SPRINT_LOCK_PATH);
      }
    }
  } catch (_e) {
    /* best-effort cleanup */
  }
}

// ═══════════════════════════════════════════════════════════
//  Context Passing
// ═══════════════════════════════════════════════════════════

/**
 * Collect results from dependency slices for context injection.
 *
 * For each dependency in slice.depends_on, looks up the corresponding
 * slice in the plan. If it's done and has a result field, includes that
 * result in the context string.
 *
 * @param {object} plan - Sprint plan (loaded via loadSprint)
 * @param {object} slice - Current slice to build context for
 * @returns {string|null} Joined context from dependencies, or null if none
 */
function buildSliceContext(plan, slice) {
  const deps = slice.depends_on || [];
  if (deps.length === 0) return null;

  const contextParts = [];

  for (const depId of deps) {
    const depSlice = plan.slices.find((s) => s.id === depId);
    if (!depSlice) continue;
    if (depSlice.status !== "done") continue;
    if (!depSlice.result) continue;

    contextParts.push(
      `### ${depSlice.title} (${depSlice.id})\n${depSlice.result}`,
    );
  }

  if (contextParts.length === 0) return null;

  return contextParts.join("\n\n");
}

/**
 * Assemble the full slice request by prepending dependency context.
 *
 * @param {string|null} context - Context from buildSliceContext
 * @param {string} sliceRequest - The slice's own request text
 * @returns {string} Assembled request string
 */
function assembleSliceRequest(context, sliceRequest) {
  if (!context) return sliceRequest;

  return [
    "## 이전 슬라이스 결과",
    context,
    "",
    "## 현재 작업",
    sliceRequest,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════
//  Sprint Execution Loop
// ═══════════════════════════════════════════════════════════

/**
 * Execute a sprint by processing its slice queue sequentially.
 * Shared by run (after planning) and resume (existing sprint).
 *
 * Uses getNextSlice() to determine the next action, executes each
 * slice via vela-pipeline.js CLI bridge (K025), and updates slice
 * status on success/failure.
 *
 * @param {string} sprintId - Sprint ID to execute
 */
function executeSprint(sprintId) {
  acquireSprintLock();

  // Ensure lock is released on exit
  const cleanup = () => releaseSprintLock();
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    let iteration = 0;

    while (true) {
      iteration++;

      // Reload plan each iteration — state may have changed
      const plan = loadSprint(sprintId);
      const next = getNextSlice(plan);

      console.log(
        `\n── Sprint iteration ${iteration} ── action: ${next.action}`,
      );

      if (next.action === "complete") {
        updateSprintStatus(sprintId, "done");

        // Generate sprint summary artifact (non-fatal — K042 pattern)
        try {
          const completedPlan = loadSprint(sprintId);
          const summaryPath = generateSprintSummary(completedPlan);
          console.log(`\n📄 스프린트 요약 생성됨: ${summaryPath}`);
        } catch (err) {
          console.error(`\n⚠️ 스프린트 요약 생성 실패 (스프린트는 정상 완료): ${err.message}`);
        }

        console.log("\n✅ 스프린트 완료! 모든 슬라이스가 성공적으로 실행되었습니다.");
        break;
      }

      if (next.action === "halt") {
        updateSprintStatus(sprintId, "failed");
        console.error(`\n❌ 스프린트 중단: ${next.reason}`);
        break;
      }

      if (next.action === "blocked") {
        updateSprintStatus(sprintId, "failed");
        console.error(`\n❌ 스프린트 차단됨: ${next.reason}`);
        break;
      }

      if (next.action === "wait") {
        // Shouldn't happen in sequential CLI — treat as error
        console.error(
          `\n⚠️ 예기치 않은 대기 상태: 슬라이스 "${next.slice.id}"가 이미 실행 중`,
        );
        console.error("   순차 실행 모드에서는 발생하지 않아야 합니다.");
        break;
      }

      if (next.action === "run") {
        const slice = next.slice;

        console.log(`\n${"═".repeat(60)}`);
        console.log(`  슬라이스 실행: ${slice.title} (${slice.id})`);
        console.log(
          `  진행: ${plan.completed_slices}/${plan.total_slices} 완료`,
        );
        console.log(`${"═".repeat(60)}`);

        // Transition slice: planned → queued → running
        updateSliceStatus(sprintId, slice.id, { status: "queued" });
        updateSliceStatus(sprintId, slice.id, {
          status: "running",
          started_at: new Date().toISOString(),
        });

        // Build context from dependency slices
        const context = buildSliceContext(plan, slice);
        const request = assembleSliceRequest(
          context,
          slice.request || slice.description || slice.title,
        );

        if (context) {
          console.log(
            `  📋 의존 슬라이스 컨텍스트 주입 (${context.length} chars)`,
          );
        }

        // Execute via vela-pipeline.js CLI bridge (K025)
        try {
          execFileSync(
            "node",
            [PIPELINE_PATH, "run", request, "--force"],
            {
              stdio: "inherit",
              cwd: CWD,
              env: { ...process.env },
            },
          );

          // Success
          updateSliceStatus(sprintId, slice.id, {
            status: "done",
            completed_at: new Date().toISOString(),
          });
          console.log(`\n  ✅ 슬라이스 완료: ${slice.title}`);
        } catch (err) {
          // Pipeline failed
          const exitCode = err.status || "unknown";
          const errorMsg = `Pipeline exited with code ${exitCode}`;

          updateSliceStatus(sprintId, slice.id, {
            status: "failed",
            result: errorMsg,
            completed_at: new Date().toISOString(),
          });
          console.error(`\n  ❌ 슬라이스 실패: ${slice.title} — ${errorMsg}`);
        }
      }
    }
  } finally {
    releaseSprintLock();
  }
}

// ═══════════════════════════════════════════════════════════
//  Sprint Summary Generation
// ═══════════════════════════════════════════════════════════

/**
 * Generate a sprint summary markdown file and write it to the sprint dir.
 *
 * Follows the generateReport() pattern in vela-pipeline.js (K037-style markdown).
 * Produces: header (title, request, timing), per-slice table, overall stats.
 *
 * @param {object} plan - Completed sprint plan (loaded via loadSprint)
 * @returns {string} Path to the written sprint-summary.md
 */
function generateSprintSummary(plan) {
  const now = new Date().toISOString();

  // ─── Header ───
  let md = `# Sprint Summary\n\n`;
  md += `**Title:** ${plan.title}\n`;
  md += `**Request:** ${plan.request}\n`;
  md += `**Created:** ${plan.created_at}\n`;
  md += `**Completed:** ${now}\n`;
  md += `**Status:** ${plan.status}\n\n`;

  // ─── Per-slice table ───
  md += `## Slice Results\n\n`;
  md += `| ID | Title | Status | Duration | Result |\n`;
  md += `|----|-------|--------|----------|--------|\n`;

  let doneCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const slice of plan.slices) {
    const statusIcon =
      slice.status === "done"
        ? "✅"
        : slice.status === "failed"
          ? "❌"
          : slice.status === "skipped"
            ? "⏭️"
            : "⬜";

    // Duration: calculate from started_at/completed_at if both exist
    let duration = "-";
    if (slice.started_at && slice.completed_at) {
      const ms =
        new Date(slice.completed_at).getTime() -
        new Date(slice.started_at).getTime();
      if (ms >= 0) {
        duration = `${(ms / 1000).toFixed(1)}s`;
      }
    }

    // Result snippet: truncate long results
    let resultSnippet = slice.result || "-";
    if (resultSnippet.length > 60) {
      resultSnippet = resultSnippet.substring(0, 57) + "...";
    }
    // Escape pipe characters for table cell
    resultSnippet = resultSnippet.replace(/\|/g, "\\|");

    md += `| ${slice.id} | ${slice.title} | ${statusIcon} ${slice.status} | ${duration} | ${resultSnippet} |\n`;

    // Count stats
    if (slice.status === "done") doneCount++;
    else if (slice.status === "failed") failedCount++;
    else if (slice.status === "skipped") skippedCount++;
  }

  // ─── Overall stats ───
  md += `\n## Stats\n\n`;
  md += `- **Total slices:** ${plan.total_slices}\n`;
  md += `- **Completed:** ${doneCount}\n`;
  md += `- **Failed:** ${failedCount}\n`;
  md += `- **Skipped:** ${skippedCount}\n`;

  // ─── Write to sprint dir ───
  const sprintDir = path.join(SPRINTS_DIR, plan.id);
  const summaryPath = path.join(sprintDir, "sprint-summary.md");

  if (!fs.existsSync(sprintDir)) {
    fs.mkdirSync(sprintDir, { recursive: true });
  }
  fs.writeFileSync(summaryPath, md, "utf8");

  return summaryPath;
}

// ═══════════════════════════════════════════════════════════
//  Status Formatter
// ═══════════════════════════════════════════════════════════

/**
 * Format and display sprint status.
 *
 * @param {object} plan - Sprint plan (loaded)
 */
function displaySprintStatus(plan) {
  const statusIcons = {
    planned: "⬜",
    queued: "🔲",
    running: "🔵",
    done: "✅",
    failed: "❌",
    skipped: "⏭️",
    cancelled: "🚫",
  };

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Sprint: ${plan.title}`);
  console.log(`  ID: ${plan.id}`);
  console.log(
    `  Status: ${statusIcons[plan.status] || "❓"} ${plan.status}`,
  );
  console.log(
    `  Progress: ${plan.completed_slices}/${plan.total_slices} slices`,
  );
  console.log(`  Created: ${plan.created_at}`);
  console.log(`${"═".repeat(60)}`);

  console.log("\n  Slices:");
  console.log(
    `  ${"─".repeat(56)}`,
  );

  for (const slice of plan.slices) {
    const icon = statusIcons[slice.status] || "❓";
    const deps =
      slice.depends_on && slice.depends_on.length > 0
        ? ` (deps: ${slice.depends_on.join(", ")})`
        : "";
    console.log(`  ${icon} ${slice.id}: ${slice.title}${deps}`);

    if (slice.started_at) {
      console.log(`     started: ${slice.started_at}`);
    }
    if (slice.completed_at) {
      console.log(`     completed: ${slice.completed_at}`);
    }
    if (slice.result) {
      console.log(
        `     result: ${slice.result.substring(0, 80)}${slice.result.length > 80 ? "..." : ""}`,
      );
    }
  }

  console.log("");
}

/**
 * Format and display a list of recent sprints.
 *
 * @param {Array} sprints - From listSprints()
 */
function displaySprintList(sprints) {
  if (sprints.length === 0) {
    console.log("\n  스프린트가 없습니다.");
    return;
  }

  const statusIcons = {
    planned: "⬜",
    running: "🔵",
    done: "✅",
    failed: "❌",
    cancelled: "🚫",
  };

  console.log(`\n  최근 스프린트 (${sprints.length}개):`);
  console.log(`  ${"─".repeat(56)}`);

  for (const s of sprints) {
    const icon = statusIcons[s.status] || "❓";
    console.log(
      `  ${icon} ${s.id}`,
    );
    console.log(
      `     ${s.title} — ${s.completed_slices}/${s.total_slices} slices`,
    );
  }

  console.log("");
}

// ═══════════════════════════════════════════════════════════
//  CLI Commands
// ═══════════════════════════════════════════════════════════

/**
 * Run command: plan a sprint from a request and execute all slices.
 */
async function cmdRun() {
  const request = args[1];
  if (!request) {
    console.error("Usage: vela-sprint run <request>");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("  Vela Sprint — Planning");
  console.log(`  Request: ${request}`);
  console.log("═══════════════════════════════════════════════════");

  // Plan the sprint via SDK
  const planResult = await sprintPlan({ request, cwd: CWD });

  if (!planResult.ok) {
    console.error(`\n❌ 스프린트 계획 실패: ${planResult.error}`);
    if (planResult.details) {
      console.error(`   상세: ${planResult.details}`);
    }
    process.exit(1);
  }

  const sprintId = planResult.sprintId;

  console.log(`\n✅ 스프린트 계획 완료: ${planResult.title}`);
  console.log(`   ID: ${sprintId}`);
  console.log(`   슬라이스: ${planResult.slices.length}개`);
  for (const s of planResult.slices) {
    const deps =
      s.depends_on.length > 0 ? ` (deps: ${s.depends_on.join(", ")})` : "";
    console.log(`   - ${s.id}: ${s.title}${deps}`);
  }
  if (planResult.cost > 0) {
    console.log(`   계획 비용: $${planResult.cost.toFixed(4)}`);
  }

  // Start execution
  console.log("\n── 스프린트 실행 시작 ──");
  updateSprintStatus(sprintId, "running");
  executeSprint(sprintId);
}

/**
 * Status command: show sprint state.
 * If sprint-id given, show that sprint.
 * If no sprint-id, try findActiveSprint, else list recent.
 */
function cmdStatus() {
  const sprintId = args[1];

  if (sprintId) {
    try {
      const plan = loadSprint(sprintId);
      displaySprintStatus(plan);
    } catch (err) {
      console.error(`❌ 스프린트를 찾을 수 없습니다: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // No ID — try active sprint first
  const active = findActiveSprint();
  if (active) {
    displaySprintStatus(active);
    return;
  }

  // No active sprint — list recent
  const sprints = listSprints();
  displaySprintList(sprints);
}

/**
 * Resume command: resume an interrupted sprint.
 * If sprint-id given, resume that sprint.
 * If no sprint-id, findActiveSprint.
 */
function cmdResume() {
  const sprintId = args[1];
  let plan;

  if (sprintId) {
    try {
      plan = loadSprint(sprintId);
    } catch (err) {
      console.error(`❌ 스프린트를 찾을 수 없습니다: ${err.message}`);
      process.exit(1);
    }

    if (plan.status !== "running") {
      console.error(
        `❌ 스프린트 상태가 '${plan.status}'입니다. 'running' 상태만 재개 가능합니다.`,
      );
      process.exit(1);
    }
  } else {
    plan = findActiveSprint();
    if (!plan) {
      console.error("❌ 실행 중인 스프린트가 없습니다.");
      console.error("   'vela-sprint run <request>'로 새 스프린트를 시작하세요.");
      process.exit(1);
    }
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("  Vela Sprint — Resume");
  console.log(`  Sprint: ${plan.title}`);
  console.log(`  ID: ${plan.id}`);
  console.log(
    `  Progress: ${plan.completed_slices}/${plan.total_slices} slices`,
  );
  console.log("═══════════════════════════════════════════════════");

  executeSprint(plan.id);
}

/**
 * Cancel command: cancel an active sprint.
 * If sprint-id given, cancel that sprint.
 * If no sprint-id, findActiveSprint.
 */
function cmdCancel() {
  const sprintId = args[1];
  let plan;

  if (sprintId) {
    try {
      plan = loadSprint(sprintId);
    } catch (err) {
      console.error(`❌ 스프린트를 찾을 수 없습니다: ${err.message}`);
      process.exit(1);
    }
  } else {
    plan = findActiveSprint();
    if (!plan) {
      console.error("❌ 실행 중인 스프린트가 없습니다.");
      process.exit(1);
    }
  }

  // Cancel any running slices
  for (const slice of plan.slices) {
    if (slice.status === "running") {
      // running → failed is the only valid transition from running
      updateSliceStatus(plan.id, slice.id, {
        status: "failed",
        result: "Cancelled by user",
        completed_at: new Date().toISOString(),
      });
    }
  }

  // Cancel the sprint
  updateSprintStatus(plan.id, "cancelled");
  console.log(`✅ 스프린트가 취소되었습니다: ${plan.title} (${plan.id})`);
}

// ═══════════════════════════════════════════════════════════
//  Help
// ═══════════════════════════════════════════════════════════

function showHelp() {
  console.log(`
Vela Sprint — Multi-slice Sprint Orchestration

Usage:
  node vela-sprint.js run <request>
  node vela-sprint.js status [sprint-id]
  node vela-sprint.js resume [sprint-id]
  node vela-sprint.js cancel [sprint-id]
  node vela-sprint.js --help

Commands:
  run       Plan a sprint from a request and execute all slices
  status    Show sprint state (active or specific)
  resume    Resume an interrupted sprint
  cancel    Cancel an active sprint

Options:
  --help    Show this help message

Examples:
  node vela-sprint.js run "사용자 인증 시스템 구현"
  node vela-sprint.js status
  node vela-sprint.js status 20260407T120000-auth-system
  node vela-sprint.js resume
  node vela-sprint.js cancel
`);
}

// ─── Helpers ───

function hasFlag(flag) {
  return args.includes(flag);
}

// ─── Module Exports (for testing) ───
module.exports = {
  buildSliceContext,
  assembleSliceRequest,
  executeSprint,
  generateSprintSummary,
  displaySprintStatus,
  displaySprintList,
  acquireSprintLock,
  releaseSprintLock,
};

// ─── Main Entry Point (K030) ───
async function main() {
  if (hasFlag("--help") || hasFlag("-h") || !command) {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case "run":
      await cmdRun();
      break;
    case "status":
      cmdStatus();
      break;
    case "resume":
      cmdResume();
      break;
    case "cancel":
      cmdCancel();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
