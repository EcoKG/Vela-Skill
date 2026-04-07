/**
 * Vela Slash Commands — Phase 2
 *
 * /vela start "<request>"        — initialise a new pipeline
 * /vela status                   — show current pipeline state
 * /vela transition               — advance to next step
 * /vela record <pass|fail|reject> [--summary TEXT]  — record step verdict
 * /vela sub-transition           — advance TDD sub-phase
 * /vela branch [--mode auto|prompt|none]            — create feature branch
 * /vela commit [--message TEXT]  — commit pipeline changes
 * /vela history                  — list pipeline history
 * /vela auto                     — toggle auto mode
 * /vela cancel                   — cancel the active pipeline
 * /vela help                     — show usage
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@gsd/pi-coding-agent";
import {
  cleanupCancelledArtifacts,
  commitPipeline,
  createPipelineBranch,
  findActivePipelineState,
  formatTimestamp,
  getCurrentMode,
  listPipelineHistory,
  loadPipelineDefinition,
  recordStep,
  resolveSteps,
  slugify,
  snapshotGitState,
  subTransitionPipeline,
  transitionPipeline,
  writeJSON,
  type PipelineState,
} from "./pipeline.js";
import { runVelaAgent, getAvailableRoles } from "./dispatch.js";
import {
  createSprint,
  findActiveSprint,
  listSprints,
  loadSprint,
  updateSliceStatus,
  updateSprintStatus,
  getNextSlice,
  generateSprintSummary,
  buildSliceContext,
  type SprintPlan,
  type SprintSlice,
} from "./sprint.js";

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerVelaCommands(pi: ExtensionAPI): void {
  pi.registerCommand("vela", {
    description: "Vela pipeline engine — /vela start|status|transition|record|dispatch|branch|commit|history|auto|cancel|help",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      switch (sub) {
        case "start":
          await cmdStart(parts.slice(1).join(" "), ctx);
          break;
        case "status":
          await cmdStatus(ctx);
          break;
        case "transition":
          await cmdTransition(ctx);
          break;
        case "record":
          await cmdRecord(parts.slice(1), ctx);
          break;
        case "sub-transition":
          await cmdSubTransition(ctx);
          break;
        case "branch":
          await cmdBranch(parts.slice(1), ctx);
          break;
        case "commit":
          await cmdCommit(parts.slice(1), ctx);
          break;
        case "history":
          await cmdHistory(ctx);
          break;
        case "dispatch":
          await cmdDispatch(parts.slice(1), ctx);
          break;
        case "sprint":
          await cmdSprint(parts.slice(1), ctx);
          break;
        case "auto":
          await cmdAuto(ctx);
          break;
        case "cancel":
          await cmdCancel(ctx);
          break;
        default:
          cmdHelp(ctx);
      }
    },
  });
}

// ─── Sub-commands ─────────────────────────────────────────────────────────────

async function cmdStart(
  request: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;

  const cleanRequest = request.replace(/^["']|["']$/g, "").trim();
  if (!cleanRequest) {
    ctx.ui.notify('Usage: /vela start "<task description>"', "warning");
    return;
  }

  // Block if there is already an active pipeline
  const existing = findActivePipelineState(cwd);
  if (existing) {
    ctx.ui.notify(
      `[Vela] Active pipeline already exists at step "${existing.current_step}". ` +
        "Use /vela cancel first.",
      "warning"
    );
    return;
  }

  // Clean up old cancelled artifacts
  const cleaned = cleanupCancelledArtifacts(cwd, 24);

  // Load pipeline definition
  const def = loadPipelineDefinition(cwd);
  if (!def) {
    ensurePipelineTemplate(cwd, ctx);
  }

  const taskType = detectTaskType(cleanRequest);
  const pipelineType = "standard";

  // Git state snapshot
  const gitState = snapshotGitState(cwd);

  // Block on dirty working tree
  if (gitState.is_repo && !gitState.is_clean) {
    ctx.ui.notify(
      "[Vela] Working tree is dirty. Commit or stash changes before starting a pipeline.\n" +
        `  Dirty files: ${gitState.dirty_files}\n` +
        "  Run: git stash",
      "warning"
    );
    return;
  }

  // Ensure .vela/templates/pipeline.json is present
  ensurePipelineTemplate(cwd, ctx);

  // Resolve steps from definition (for init)
  const pipelineDef = loadPipelineDefinition(cwd);
  const steps = pipelineDef ? resolveSteps(pipelineDef, pipelineType) : [];
  const firstStep = steps[0];

  // Create artifact directory
  const ts = formatTimestamp();
  const slug = slugify(cleanRequest);
  const artifactDirName = `${ts}-${slug}`;
  const artifactDir = join(cwd, ".vela", "artifacts", artifactDirName);
  mkdirSync(artifactDir, { recursive: true });

  const pipelineId = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const state: PipelineState = {
    version: "1.1",
    pipeline_id: pipelineId,
    pipeline_type: pipelineType,
    status: "active",
    current_step: firstStep?.id ?? "init",
    current_step_index: 0,
    request: cleanRequest,
    task_type: taskType,
    type: taskType,
    scale: "standard",
    steps: steps.map((s) => s.id),
    completed_steps: [],
    revisions: {},
    git: gitState.is_repo
      ? {
          is_repo: true,
          base_branch: gitState.current_branch,
          current_branch: gitState.current_branch,
          pipeline_branch: null,
          checkpoint_hash: gitState.head_hash,
          commit_hash: null,
          stash_ref: gitState.stash_ref ?? null,
          remote: gitState.remote ?? null,
        }
      : undefined,
    baseline_sha: gitState.is_repo ? gitState.head_hash : null,
    artifact_dir: artifactDir,
    created_at: now,
    updated_at: now,
  };

  writeJSON(join(artifactDir, "pipeline-state.json"), state);
  writeJSON(join(artifactDir, "meta.json"), {
    pipeline_id: pipelineId,
    request: cleanRequest,
    task_type: taskType,
    created_at: now,
    vela_version: "1.0.0",
  });

  ensureGitignore(cwd);

  const stepList = steps.map((s) => s.id).join(" → ");

  ctx.ui.notify(
    `[Vela] Pipeline initialised (${taskType}).\n` +
      `  Step: ${stepList}\n` +
      `  Artifact dir: .vela/artifacts/${artifactDirName}\n` +
      (cleaned > 0 ? `  Cleaned ${cleaned} old cancelled artifact(s).\n` : "") +
      "\nRun /vela status to check state.",
    "success"
  );
}

async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "info");
    return;
  }

  const def = loadPipelineDefinition(cwd);
  const steps = def ? resolveSteps(def, state.pipeline_type) : [];
  const stepIdx = steps.findIndex((s) => s.id === state.current_step);
  const currentStep = steps[stepIdx];

  const lines = [
    `[Vela] Pipeline status`,
    `  ID:       ${state.pipeline_id ?? "—"}`,
    `  Request:  ${state.request}`,
    `  Type:     ${state.task_type ?? state.type ?? "—"}`,
    `  Status:   ${state.status}`,
    `  Step:     ${state.current_step} (${stepIdx + 1}/${steps.length})`,
    `  Mode:     ${currentStep?.mode ?? "unknown"}`,
    `  Actor:    ${currentStep?.actor ?? "unknown"}`,
    `  Artifact: .vela/artifacts/${state._artifactDir?.split("/").pop() ?? state.artifact_dir.split("/").pop()}`,
  ];

  if (state.auto) lines.push(`  Auto:     ON`);

  const revisions = state.revisions ?? {};
  if (revisions[state.current_step]) {
    lines.push(`  Revisions: ${revisions[state.current_step]}`);
  }

  const sp = state.sub_phases?.[state.current_step];
  if (sp) {
    lines.push(`  Sub-phase: ${sp.current_phase} (${sp.current_index + 1}/${sp.phases.length})`);
  }

  if (state.git?.pipeline_branch) {
    lines.push(`  Branch:   ${state.git.pipeline_branch}`);
  }

  if (state._stale) {
    lines.push(`  ⚠ Pipeline is stale (no activity for >24h)`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdTransition(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline to transition.", "warning");
    return;
  }

  const def = loadPipelineDefinition(cwd);
  if (!def) {
    ctx.ui.notify("[Vela] Pipeline definition not found.", "error" as Parameters<typeof ctx.ui.notify>[1]);
    return;
  }

  const result = transitionPipeline(state, def);

  if (!result.ok) {
    const missingList = result.missing?.join("\n    ") ?? "";
    ctx.ui.notify(
      `[Vela] Cannot transition: ${result.error}\n` +
        (missingList ? `  Missing:\n    ${missingList}` : ""),
      "warning"
    );
    return;
  }

  if (result.completed) {
    ctx.ui.notify("[Vela] Pipeline completed successfully! 🎉", "success");
    return;
  }

  ctx.ui.notify(
    `[Vela] Advanced: ${result.previous_step} → ${result.current_step}\n` +
      `  Step: ${result.current_step_name}\n` +
      `  Mode: ${result.current_mode}`,
    "success"
  );
}

async function cmdRecord(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = findActivePipelineState(ctx.cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const verdict = parts[0];
  if (!verdict) {
    ctx.ui.notify("Usage: /vela record <pass|fail|reject> [--summary TEXT]", "warning");
    return;
  }

  // Extract --summary flag
  const summaryIdx = parts.indexOf("--summary");
  const summary = summaryIdx >= 0 ? parts.slice(summaryIdx + 1).join(" ") : undefined;

  const result = recordStep(state, verdict, summary);
  if (!result.ok) {
    ctx.ui.notify(`[Vela] ${result.error}`, "warning");
    return;
  }

  const autoNote = result.auto_disabled
    ? "\n  ⚠ Auto mode disabled: 2 consecutive rejects."
    : "";

  ctx.ui.notify(
    `[Vela] Recorded ${result.verdict} for step "${result.step}" (revision ${result.revision}).${autoNote}`,
    "success"
  );
}

async function cmdSubTransition(ctx: ExtensionCommandContext): Promise<void> {
  const state = findActivePipelineState(ctx.cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const result = subTransitionPipeline(state);
  if (!result.ok) {
    ctx.ui.notify(`[Vela] ${result.error}`, "warning");
    return;
  }

  if (result.completed) {
    ctx.ui.notify(
      `[Vela] All sub-phases completed for "${state.current_step}".`,
      "success"
    );
    return;
  }

  ctx.ui.notify(
    `[Vela] Sub-phase: ${result.previous_phase} → ${result.current_phase}\n` +
      (result.remaining?.length
        ? `  Remaining: ${result.remaining.join(", ")}`
        : "  (last sub-phase)"),
    "success"
  );
}

async function cmdBranch(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const modeIdx = parts.indexOf("--mode");
  const rawMode = modeIdx >= 0 ? parts[modeIdx + 1] : "auto";
  const mode = (["auto", "prompt", "none"].includes(rawMode ?? "")
    ? rawMode
    : "auto") as "auto" | "prompt" | "none";

  const result = createPipelineBranch(cwd, state, mode);

  if (!result.ok) {
    ctx.ui.notify(`[Vela] Branch error: ${result.error}`, "warning");
    return;
  }

  switch (result.action) {
    case "skipped":
      ctx.ui.notify("[Vela] Not a git repository. Branch step skipped.", "info");
      break;
    case "existing":
      ctx.ui.notify(
        `[Vela] Already on non-protected branch "${result.branch}". Using as pipeline branch.`,
        "info"
      );
      break;
    case "none":
      ctx.ui.notify(`[Vela] Branch creation skipped (mode: none).`, "info");
      break;
    case "prompt":
      ctx.ui.notify(
        `[Vela] Run this command to create the pipeline branch:\n  ${result.suggested_command}`,
        "info"
      );
      break;
    case "created":
      ctx.ui.notify(`[Vela] Branch "${result.branch}" created.`, "success");
      break;
  }
}

async function cmdCommit(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const msgIdx = parts.indexOf("--message");
  const messageOverride = msgIdx >= 0 ? parts.slice(msgIdx + 1).join(" ") : undefined;

  const def = loadPipelineDefinition(cwd);
  const result = commitPipeline(cwd, state, def, messageOverride);

  if (!result.ok) {
    ctx.ui.notify(`[Vela] Commit failed: ${result.error}`, "warning");
    return;
  }

  switch (result.action) {
    case "skipped":
      ctx.ui.notify("[Vela] Not a git repository. Commit skipped.", "info");
      break;
    case "no_changes":
      ctx.ui.notify("[Vela] No changes to commit.", "info");
      break;
    case "committed":
      ctx.ui.notify(
        `[Vela] Committed: ${result.commit_message}\n  Hash: ${result.hash?.substring(0, 7)}`,
        "success"
      );
      break;
  }
}

async function cmdHistory(ctx: ExtensionCommandContext): Promise<void> {
  const pipelines = listPipelineHistory(ctx.cwd);

  if (pipelines.length === 0) {
    ctx.ui.notify("[Vela] No pipeline history.", "info");
    return;
  }

  const lines = ["[Vela] Pipeline history:"];
  for (const p of pipelines.slice(0, 20)) {
    const icon =
      p.status === "completed" ? "✅" : p.status === "cancelled" ? "❌" : "🔄";
    lines.push(
      `  ${icon} ${p.date} ${p.slug.split("-").slice(2).join("-").substring(0, 25).padEnd(25)} ` +
        `${p.status.padEnd(10)} step:${p.step}`
    );
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Sprint Command ───────────────────────────────────────────────────────────

async function cmdSprint(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const sub = parts[0]?.toLowerCase();

  switch (sub) {
    case "run": {
      const request = parts.slice(1).join(" ").replace(/^["']|["']$/g, "").trim();
      if (!request) {
        ctx.ui.notify('Usage: /vela sprint run "<request>"', "warning");
        return;
      }
      await cmdSprintRun(request, cwd, ctx);
      break;
    }
    case "status": {
      const sprintId = parts[1];
      cmdSprintStatus(sprintId, cwd, ctx);
      break;
    }
    case "resume": {
      const sprintId = parts[1];
      await cmdSprintResume(sprintId, cwd, ctx);
      break;
    }
    case "cancel": {
      const sprintId = parts[1];
      cmdSprintCancel(sprintId, cwd, ctx);
      break;
    }
    default:
      ctx.ui.notify(
        [
          "[Vela] Sprint commands:",
          '  /vela sprint run "<request>"   — plan and execute a sprint',
          "  /vela sprint status [id]       — show sprint state",
          "  /vela sprint resume [id]       — resume an interrupted sprint",
          "  /vela sprint cancel [id]       — cancel an active sprint",
        ].join("\n"),
        "info"
      );
  }
}

async function cmdSprintRun(
  request: string,
  cwd: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  ctx.ui.notify(
    `[Vela] Planning sprint: "${request}"\n  Dispatching sprint planner...`,
    "info"
  );

  // Use sprint planner agent to decompose the request
  const planResult = await runVelaAgent({
    role: "sprint-planner",
    cwd,
    artifactDir: join(cwd, ".vela", "state"),
    request,
    taskType: "code",
  });

  // Parse slices from planner output
  let slices: Array<{ id: string; title: string; description: string; depends_on: string[] }> = [];
  let title = request.substring(0, 50);

  if (planResult.ok && planResult.text) {
    try {
      // Try to extract JSON from the planner response
      const jsonMatch = planResult.text.match(/```json\n([\s\S]*?)\n```/) ||
                        planResult.text.match(/\{[\s\S]*"slices"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as {
          title?: string;
          slices?: typeof slices;
        };
        if (parsed.title) title = parsed.title;
        if (Array.isArray(parsed.slices)) slices = parsed.slices;
      }
    } catch {
      // Fallback: create a single-slice sprint
    }
  }

  // Fallback: single slice
  if (slices.length === 0) {
    slices = [{ id: "slice-01", title: request.substring(0, 60), description: request, depends_on: [] }];
  }

  // Create the sprint
  const plan = createSprint({ title, request, slices }, cwd);
  updateSprintStatus(plan.id, "running", cwd);

  ctx.ui.notify(
    `[Vela] Sprint created: "${plan.title}"\n` +
      `  ID: ${plan.id}\n` +
      `  Slices: ${slices.length}\n` +
      slices.map((s) => `    • ${s.id}: ${s.title}`).join("\n") +
      "\n\nStarting execution...",
    "success"
  );

  // Execute slices sequentially
  await executeSprintSlices(plan.id, cwd, ctx);
}

async function executeSprintSlices(
  sprintId: string,
  cwd: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  let iteration = 0;

  while (true) {
    iteration++;
    const plan = loadSprint(sprintId, cwd);
    const next = getNextSlice(plan);

    if (next.action === "complete") {
      updateSprintStatus(sprintId, "done", cwd);
      try {
        const completedPlan = loadSprint(sprintId, cwd);
        const summaryPath = generateSprintSummary(completedPlan, cwd);
        ctx.ui.notify(
          `[Vela] Sprint completed!\n  Summary: ${summaryPath}`,
          "success"
        );
      } catch {
        ctx.ui.notify("[Vela] Sprint completed!", "success");
      }
      return;
    }

    if (next.action === "halt" || next.action === "blocked") {
      updateSprintStatus(sprintId, "failed", cwd);
      ctx.ui.notify(`[Vela] Sprint stopped: ${next.reason}`, "warning");
      return;
    }

    if (next.action === "run" && next.slice) {
      const slice = next.slice;
      ctx.ui.notify(
        `[Vela] Executing slice ${iteration}/${plan.total_slices}: ${slice.title}`,
        "info"
      );

      updateSliceStatus(sprintId, slice.id, { status: "queued" }, cwd);
      updateSliceStatus(sprintId, slice.id, { status: "running", started_at: new Date().toISOString() }, cwd);

      const context = buildSliceContext(plan, slice);
      const sliceRequest = context
        ? `## Previous slice context\n${context}\n\n## Current task\n${slice.request || slice.title}`
        : (slice.request || slice.title);

      // Run the full pipeline for this slice via dispatch
      const result = await runVelaAgent({
        role: "executor",
        cwd,
        artifactDir: join(cwd, ".vela", "artifacts", `sprint-${sprintId}-${slice.id}`),
        request: sliceRequest,
        taskType: "code",
      });

      if (result.ok) {
        updateSliceStatus(sprintId, slice.id, {
          status: "done",
          result: result.text?.substring(0, 200),
          completed_at: new Date().toISOString(),
        }, cwd);
        ctx.ui.notify(`[Vela] Slice done: ${slice.title}`, "success");
      } else {
        updateSliceStatus(sprintId, slice.id, {
          status: "failed",
          result: result.error ?? "unknown error",
          completed_at: new Date().toISOString(),
        }, cwd);
        ctx.ui.notify(`[Vela] Slice failed: ${slice.title} — ${result.error}`, "warning");
        // Halt on slice failure
        updateSprintStatus(sprintId, "failed", cwd);
        return;
      }
    }
  }
}

function cmdSprintStatus(
  sprintId: string | undefined,
  cwd: string,
  ctx: ExtensionCommandContext
): void {
  const STATUS_ICON: Record<string, string> = {
    planned: "⬜", running: "🔵", done: "✅", failed: "❌", cancelled: "🚫",
    queued: "🔲", skipped: "⏭",
  };

  if (sprintId) {
    try {
      const plan = loadSprint(sprintId, cwd);
      formatSprintStatus(plan, STATUS_ICON, ctx);
    } catch (e) {
      ctx.ui.notify(`[Vela] Sprint not found: ${sprintId}`, "warning");
    }
    return;
  }

  const active = findActiveSprint(cwd);
  if (active) {
    formatSprintStatus(active, STATUS_ICON, ctx);
    return;
  }

  const sprints = listSprints(cwd);
  if (sprints.length === 0) {
    ctx.ui.notify("[Vela] No sprint history.", "info");
    return;
  }

  const lines = ["[Vela] Recent sprints:"];
  for (const s of sprints.slice(0, 10)) {
    const icon = STATUS_ICON[s.status] ?? "❓";
    lines.push(`  ${icon} ${s.id.split("-").slice(2).join("-").substring(0, 20).padEnd(20)} ${s.status.padEnd(10)} ${s.completed_slices}/${s.total_slices} slices`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function formatSprintStatus(
  plan: SprintPlan,
  icons: Record<string, string>,
  ctx: ExtensionCommandContext
): void {
  const lines = [
    `[Vela] Sprint: ${plan.title}`,
    `  ID:       ${plan.id}`,
    `  Status:   ${icons[plan.status] ?? ""} ${plan.status}`,
    `  Progress: ${plan.completed_slices}/${plan.total_slices} slices`,
    "",
    "  Slices:",
  ];
  for (const s of plan.slices) {
    const icon = icons[s.status] ?? "❓";
    const deps = s.depends_on.length > 0 ? ` (deps: ${s.depends_on.join(", ")})` : "";
    lines.push(`    ${icon} ${s.id}: ${s.title}${deps}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdSprintResume(
  sprintId: string | undefined,
  cwd: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  let plan: SprintPlan;
  if (sprintId) {
    try {
      plan = loadSprint(sprintId, cwd);
    } catch {
      ctx.ui.notify(`[Vela] Sprint not found: ${sprintId}`, "warning");
      return;
    }
  } else {
    const active = findActiveSprint(cwd);
    if (!active) {
      ctx.ui.notify("[Vela] No active sprint to resume.", "info");
      return;
    }
    plan = active;
  }

  ctx.ui.notify(`[Vela] Resuming sprint: ${plan.title} (${plan.completed_slices}/${plan.total_slices} done)`, "info");
  await executeSprintSlices(plan.id, cwd, ctx);
}

function cmdSprintCancel(
  sprintId: string | undefined,
  cwd: string,
  ctx: ExtensionCommandContext
): void {
  let plan: SprintPlan;
  if (sprintId) {
    try {
      plan = loadSprint(sprintId, cwd);
    } catch {
      ctx.ui.notify(`[Vela] Sprint not found: ${sprintId}`, "warning");
      return;
    }
  } else {
    const active = findActiveSprint(cwd);
    if (!active) {
      ctx.ui.notify("[Vela] No active sprint to cancel.", "info");
      return;
    }
    plan = active;
  }

  // Cancel running slices
  for (const s of plan.slices) {
    if (s.status === "running") {
      updateSliceStatus(plan.id, s.id, { status: "failed", result: "Cancelled", completed_at: new Date().toISOString() }, cwd);
    }
  }
  updateSprintStatus(plan.id, "cancelled", cwd);
  ctx.ui.notify(`[Vela] Sprint cancelled: ${plan.title}`, "info");
}

async function cmdDispatch(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  // Determine role: --role flag, or derive from current step
  const roleIdx = parts.indexOf("--role");
  const role = roleIdx >= 0 ? parts[roleIdx + 1] : state.current_step;

  if (!role) {
    ctx.ui.notify(
      `[Vela] No role specified. Available: ${getAvailableRoles().join(", ")}`,
      "warning"
    );
    return;
  }

  const artifactDir = state._artifactDir ?? state.artifact_dir;
  if (!artifactDir) {
    ctx.ui.notify("[Vela] No artifact directory found.", "warning");
    return;
  }

  const def = loadPipelineDefinition(cwd);
  const mode = getCurrentMode(state, def);

  ctx.ui.notify(
    `[Vela] Dispatching agent: role=${role}, mode=${mode}\n  This may take a few minutes...`,
    "info"
  );

  const result = await runVelaAgent({
    role,
    cwd,
    artifactDir,
    request: state.request,
    taskType: state.task_type ?? state.type ?? "code",
    pipelineMode: mode,
  });

  if (!result.ok) {
    ctx.ui.notify(
      `[Vela] Agent dispatch failed (${role}): ${result.error}`,
      "warning"
    );
    return;
  }

  const duration = result.durationMs ? `${Math.round(result.durationMs / 1000)}s` : "";
  ctx.ui.notify(
    `[Vela] Agent completed: ${role}\n` +
      `  Artifact: ${result.artifact ?? "—"}\n` +
      (duration ? `  Duration: ${duration}\n` : "") +
      "\nRun /vela transition when ready to advance.",
    "success"
  );
}

async function cmdAuto(ctx: ExtensionCommandContext): Promise<void> {
  const state = findActivePipelineState(ctx.cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const wasAuto = state.auto === true;
  state.auto = !wasAuto;
  if (state.auto) state.auto_reject_count = 0;
  state.updated_at = new Date().toISOString();

  if (state._path) {
    const clean = { ...state };
    delete clean._path;
    delete clean._artifactDir;
    delete clean._stale;
    const { writeJSON: wj } = await import("./pipeline.js");
    wj(state._path, clean);
  }

  ctx.ui.notify(
    state.auto
      ? "[Vela] ⚡ Auto mode ON — pipeline will advance automatically."
      : "[Vela] ⏸ Auto mode OFF — manual mode.",
    "info"
  );
}

async function cmdCancel(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline to cancel.", "info");
    return;
  }

  state.status = "cancelled";
  state.updated_at = new Date().toISOString();

  if (state._path) {
    const clean = { ...state };
    delete clean._path;
    delete clean._artifactDir;
    delete clean._stale;
    writeJSON(state._path, clean);
  }

  const hints: string[] = [];
  if (state.git?.is_repo) {
    if (state.git.pipeline_branch) {
      hints.push(
        `To discard pipeline branch: git checkout ${state.git.base_branch} && git branch -d ${state.git.pipeline_branch}`
      );
    } else if (state.git.checkpoint_hash) {
      hints.push(`To see pipeline changes: git diff ${state.git.checkpoint_hash}..HEAD`);
    }
  }

  ctx.ui.notify(
    `[Vela] Pipeline cancelled at step "${state.current_step}".\n` +
      `  Artifact: .vela/artifacts/${state._artifactDir?.split("/").pop() ?? ""}` +
      (hints.length ? "\n  " + hints.join("\n  ") : ""),
    "info"
  );
}

function cmdHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    [
      "[Vela] Pipeline commands:",
      "  /vela start \"<request>\"        — start a new pipeline",
      "  /vela status                   — show current step and state",
      "  /vela transition               — advance to next step (checks exit gate)",
      "  /vela record <pass|fail|reject> [--summary TEXT]",
      "                                 — record step verdict",
      "  /vela sub-transition           — advance TDD sub-phase (execute step)",
      "  /vela branch [--mode auto|prompt|none]",
      "                                 — create feature branch",
      "  /vela commit [--message TEXT]  — commit pipeline changes",
      "  /vela history                  — show pipeline history",
      "  /vela dispatch [--role ROLE]   — run an agent for the current (or specified) step",
      "  /vela auto                     — toggle auto-advance mode",
      "  /vela cancel                   — cancel the active pipeline",
      "  /vela help                     — show this help",
      "",
      "12-step pipeline:",
      "  init → research → plan → plan-check → checkpoint →",
      "  branch → execute → verify → diff-summary → learning → commit → finalize",
    ].join("\n"),
    "info"
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectTaskType(request: string): string {
  const lower = request.toLowerCase();
  if (/\b(fix|bug|error|crash|broken|regression)\b/.test(lower)) return "code-bug";
  if (/\b(refactor|cleanup|clean up|restructure|reorganize)\b/.test(lower)) return "code-refactor";
  if (/\b(doc|docs|documentation|readme|comment|jsdoc)\b/.test(lower)) return "docs";
  if (/\b(analyze|analyse|analysis|report|audit)\b/.test(lower)) return "analysis";
  return "code";
}

function ensurePipelineTemplate(cwd: string, ctx: ExtensionCommandContext): void {
  const dest = join(cwd, ".vela", "templates", "pipeline.json");
  if (existsSync(dest)) return;

  const candidates = [
    new URL("./templates/pipeline.json", import.meta.url).pathname,
    join(new URL(".", import.meta.url).pathname, "templates", "pipeline.json"),
  ];

  const src = candidates.find((p) => existsSync(p));
  if (!src) {
    ctx.ui.notify(
      "[Vela] Warning: pipeline.json template not found. Step validation will be limited.",
      "warning"
    );
    return;
  }

  mkdirSync(join(cwd, ".vela", "templates"), { recursive: true });
  writeFileSync(dest, readFileSync(src));
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  const entries = [
    ".vela/cache/",
    ".vela/state/",
    ".vela/artifacts/",
    ".vela/sprints/",
    ".vela/tracker-signals.json",
    ".vela/write-log.jsonl",
    "*.vela-tmp",
  ];

  let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";

  const missing = entries.filter((e) => !content.includes(e));
  if (missing.length > 0) {
    const addition =
      (content.endsWith("\n") ? "" : "\n") + "# Vela\n" + missing.join("\n") + "\n";
    writeFileSync(gitignorePath, content + addition);
  }
}
