/**
 * Vela Slash Commands
 *
 * Registers /vela with sub-command routing:
 *   /vela start "<request>"  — initialise a new pipeline
 *   /vela status             — show current pipeline state
 *   /vela cancel             — cancel the active pipeline
 *   /vela help               — show usage
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@gsd/pi-coding-agent";
import {
  findActivePipelineState,
  formatTimestamp,
  loadPipelineDefinition,
  slugify,
  writeJSON,
  type PipelineState,
} from "./pipeline.js";

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerVelaCommands(pi: ExtensionAPI): void {
  pi.registerCommand("vela", {
    description:
      "Vela pipeline engine — /vela start|status|cancel|help",
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

  // Strip surrounding quotes if present
  const cleanRequest = request.replace(/^["']|["']$/g, "").trim();
  if (!cleanRequest) {
    ctx.ui.notify(
      "Usage: /vela start \"<task description>\"",
      "warning"
    );
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

  // Detect task type from request heuristics
  const taskType = detectTaskType(cleanRequest);

  // Generate artifact directory name
  const ts = formatTimestamp();
  const slug = slugify(cleanRequest);
  const artifactDirName = `${ts}-${slug}`;
  const artifactDir = join(cwd, ".vela", "artifacts", artifactDirName);

  // Ensure .vela/templates/pipeline.json is present
  ensurePipelineTemplate(cwd, ctx);

  // Create artifact directory + pipeline-state.json + meta.json
  mkdirSync(artifactDir, { recursive: true });

  const pipelineId = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const state: PipelineState = {
    pipeline_id: pipelineId,
    pipeline_type: "standard",
    status: "active",
    current_step: "init",
    request: cleanRequest,
    task_type: taskType,
    artifact_dir: artifactDir,
    created_at: now,
    updated_at: now,
    revisions: 0,
  };

  writeJSON(join(artifactDir, "pipeline-state.json"), state);
  writeJSON(join(artifactDir, "meta.json"), {
    pipeline_id: pipelineId,
    request: cleanRequest,
    task_type: taskType,
    created_at: now,
    vela_version: "1.0.0",
  });

  // Ensure .gitignore entries exist
  ensureGitignore(cwd);

  ctx.ui.notify(
    `[Vela] Pipeline initialised (${taskType}).\n` +
      `  Step: init → research → plan → plan-check → checkpoint → branch → execute → verify → diff-summary → learning → commit → finalize\n` +
      `  Artifact dir: .vela/artifacts/${artifactDirName}\n\n` +
      `Run /vela status to check state. The PM agent will drive the pipeline steps.`,
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
  const pipeline = def?.pipelines[state.pipeline_type];
  const steps = pipeline?.steps ?? [];
  const stepIdx = steps.findIndex((s) => s.id === state.current_step);
  const currentStep = steps[stepIdx];

  const lines = [
    `[Vela] Pipeline status`,
    `  ID:       ${state.pipeline_id}`,
    `  Request:  ${state.request}`,
    `  Type:     ${state.task_type}`,
    `  Status:   ${state.status}`,
    `  Step:     ${state.current_step} (${stepIdx + 1}/${steps.length})`,
    `  Mode:     ${currentStep?.mode ?? "unknown"}`,
    `  Actor:    ${currentStep?.actor ?? "unknown"}`,
    `  Artifact: .vela/artifacts/${state.artifact_dir.split("/").pop()}`,
  ];

  if (state.sub_phase) {
    lines.push(`  Sub-phase: ${state.sub_phase}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdCancel(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline to cancel.", "info");
    return;
  }

  const statePath = join(state.artifact_dir, "pipeline-state.json");
  const updated: PipelineState = {
    ...state,
    status: "cancelled",
    updated_at: new Date().toISOString(),
  };

  writeJSON(statePath, updated);

  ctx.ui.notify(
    `[Vela] Pipeline cancelled at step "${state.current_step}".\n` +
      `  Artifact: .vela/artifacts/${state.artifact_dir.split("/").pop()}`,
    "info"
  );
}

function cmdHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    [
      "[Vela] Pipeline commands:",
      "  /vela start \"<request>\"  — start a new pipeline for the given task",
      "  /vela status             — show current pipeline state and step",
      "  /vela cancel             — cancel the active pipeline",
      "  /vela help               — show this help",
      "",
      "The PM agent drives the 12-step pipeline automatically:",
      "  init → research → plan → plan-check → checkpoint →",
      "  branch → execute → verify → diff-summary → learning → commit → finalize",
    ].join("\n"),
    "info"
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectTaskType(request: string): string {
  const lower = request.toLowerCase();
  if (/\b(fix|bug|error|crash|broken|regression)\b/.test(lower))
    return "code-bug";
  if (/\b(refactor|cleanup|clean up|restructure|reorganize)\b/.test(lower))
    return "code-refactor";
  if (/\b(doc|docs|documentation|readme|comment|jsdoc)\b/.test(lower))
    return "docs";
  if (/\b(analyze|analyse|analysis|report|audit)\b/.test(lower))
    return "analysis";
  return "code";
}

function ensurePipelineTemplate(cwd: string, ctx: ExtensionCommandContext): void {
  const dest = join(cwd, ".vela", "templates", "pipeline.json");
  if (existsSync(dest)) return;

  // Look for pipeline.json bundled with the extension
  const candidates = [
    // Development: running from source
    new URL("./templates/pipeline.json", import.meta.url).pathname,
    // Production: running from dist/
    join(
      new URL(".", import.meta.url).pathname,
      "templates",
      "pipeline.json"
    ),
  ];

  const src = candidates.find((p) => existsSync(p));
  if (!src) {
    ctx.ui.notify(
      "[Vela] Warning: pipeline.json template not found. Pipeline step validation will be limited.",
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

  let content = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";

  const missing = entries.filter((e) => !content.includes(e));
  if (missing.length > 0) {
    const addition =
      (content.endsWith("\n") ? "" : "\n") +
      "# Vela\n" +
      missing.join("\n") +
      "\n";
    writeFileSync(gitignorePath, content + addition);
  }
}
