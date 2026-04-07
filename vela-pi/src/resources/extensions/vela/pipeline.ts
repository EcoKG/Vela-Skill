/**
 * Vela Pipeline State
 *
 * Read-side port of vela-engine.js: locates the active pipeline-state.json,
 * resolves the current step, and derives the effective tool-access mode.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PipelineMode = "read" | "write" | "readwrite" | "rw-artifact";

export interface PipelineStep {
  id: string;
  name: string;
  actor: "pm" | "agent" | "user";
  mode: PipelineMode;
  entry_gate: string[];
  exit_gate: string[];
  artifacts: string[];
  max_revisions: number;
  skip_when?: string[];
  sub_phases?: string[];
}

export interface PipelineDef {
  version: string;
  pipelines: Record<string, { description: string; steps: PipelineStep[] }>;
  modes: Record<
    string,
    {
      allowed_tools: string[];
      blocked_tools: string[];
      bash_policy: string;
      treenode_cache?: boolean;
      artifact_write_only?: boolean;
    }
  >;
}

export interface PipelineState {
  pipeline_id: string;
  pipeline_type: string;
  status: "active" | "completed" | "cancelled" | "failed";
  current_step: string;
  request: string;
  task_type: string;
  artifact_dir: string;
  created_at: string;
  updated_at: string;
  revisions?: number;
  sub_phase?: string;
}

// ─── State Location ───────────────────────────────────────────────────────────

/**
 * Scan .vela/artifacts/ for the most-recent active pipeline-state.json.
 * Directories are sorted reverse-chronologically (timestamp prefix ensures this).
 */
export function findActivePipelineState(cwd: string): PipelineState | null {
  try {
    const artifactsDir = join(cwd, ".vela", "artifacts");
    if (!existsSync(artifactsDir)) return null;

    const dirs = readdirSync(artifactsDir)
      .filter((d) => /^\d{8}T\d{6}-/.test(d))
      .sort()
      .reverse();

    for (const dir of dirs) {
      const statePath = join(artifactsDir, dir, "pipeline-state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(
          readFileSync(statePath, "utf8")
        ) as PipelineState;
        if (state.status === "active") return state;
      } catch {
        // corrupt state file — skip
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Pipeline Definition ──────────────────────────────────────────────────────

/**
 * Load pipeline.json from .vela/templates/ (deployed) or the extension's own
 * templates/ directory (development).
 */
export function loadPipelineDefinition(
  cwd: string,
  extensionDir?: string
): PipelineDef | null {
  const candidates = [
    join(cwd, ".vela", "templates", "pipeline.json"),
    ...(extensionDir
      ? [join(extensionDir, "templates", "pipeline.json")]
      : []),
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as PipelineDef;
    } catch {
      // malformed — try next
    }
  }
  return null;
}

// ─── Step Resolution ──────────────────────────────────────────────────────────

export function getCurrentStep(
  state: PipelineState,
  def: PipelineDef
): PipelineStep | null {
  const pipeline = def.pipelines[state.pipeline_type];
  if (!pipeline) return null;
  return pipeline.steps.find((s) => s.id === state.current_step) ?? null;
}

/**
 * Derive the effective PipelineMode for the current step.
 * Falls back to "readwrite" (permissive) if state or definition is unavailable.
 */
export function getCurrentMode(
  state: PipelineState | null,
  def: PipelineDef | null
): PipelineMode {
  if (!state || !def) return "readwrite";
  const step = getCurrentStep(state, def);
  return (step?.mode as PipelineMode) ?? "readwrite";
}

// ─── State Writing ────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync, renameSync } from "node:fs";

/** Atomic JSON write via tmp → rename. */
export function writeJSON(filePath: string, data: unknown): void {
  const dir = join(filePath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

/** Generate a URL-safe slug from a string (max 40 chars). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** Format a Date as YYYYMMDDTHHMMSS. */
export function formatTimestamp(d: Date = new Date()): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
