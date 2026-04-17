#!/usr/bin/env node
/**
 * Vela Stop Hook — Claude Code StopHook Handler
 *
 * Called when Claude Code's main loop is about to stop.
 *
 * Behaviors:
 * 1. If auto-mode pipeline is active → block premature stop (existing behavior)
 * 2. Always save a session-end snapshot to .vela/state/session-end.json
 *    (analytics summary, pipeline state, uncommitted changes warning)
 * 3. If uncommitted git changes exist → inject a warning into stop reason
 *    (does NOT block — informational only)
 *
 * Crash-safe: the .catch() handler always outputs a block decision
 * with the error message and exits 0, ensuring Claude Code sees the
 * block even when an unexpected error occurs.
 *
 * Output format (stdout): JSON with `decision: "block"` field (when blocking)
 *                          or empty stdout (when allowing stop).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { writeGateEvent } = require("./shared/constants");

// ─── Helpers ────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function parseJsonSafe(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Check for uncommitted git changes. Returns { dirty: boolean, summary: string }.
 */
function checkUncommittedChanges(cwd) {
  try {
    const { execFileSync } = require("child_process");
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 3000,
    }).toString().trim();
    if (!status) return { dirty: false, summary: "" };
    const lines = status.split("\n").filter(Boolean);
    return { dirty: true, summary: `${lines.length} uncommitted change(s)` };
  } catch {
    return { dirty: false, summary: "" };
  }
}

/**
 * v7.1 M9 (v7.3-M4: M10 roll-up 제거) — budget-exceeded.json 집계만.
 * active pipeline's artifact dir into tool-usage.json. Called from
 * saveSessionEnd so /vela:analyze can aggregate across sessions without
 * re-walking artifact trees.
 *
 * Non-fatal on any error; returns an object with whatever it managed to
 * extract.
 */
function rollupToolUsage(cwd, pipelineState) {
  const rollup = {
    budgetExceeded: null,
    duplicateReads: null,
  };
  if (!pipelineState) return rollup;
  try {
    const artifactsDir = path.join(cwd, ".vela", "artifacts");
    if (!fs.existsSync(artifactsDir)) return rollup;
    const dirs = fs.readdirSync(artifactsDir)
      .filter(d => /^\d{8}T\d{6}-/.test(d))
      .sort()
      .reverse();
    let activeArtifactDir = null;
    for (const d of dirs) {
      const sp = path.join(artifactsDir, d, "pipeline-state.json");
      if (!fs.existsSync(sp)) continue;
      try {
        const s = parseJsonSafe(fs.readFileSync(sp, "utf8"));
        if (s && s.status === "active") { activeArtifactDir = path.join(artifactsDir, d); break; }
      } catch {/* skip */}
    }
    if (!activeArtifactDir) return rollup;

    // M9: budget-exceeded.json (written by agents when their counter
    // passed the injected budget)
    const bePath = path.join(activeArtifactDir, "budget-exceeded.json");
    if (fs.existsSync(bePath)) {
      try {
        rollup.budgetExceeded = parseJsonSafe(fs.readFileSync(bePath, "utf8"));
      } catch {/* skip */}
    }

    // v7.3-M4: M10 read-cache.jsonl 처리 블록 제거 — vela-file-read-cache 훅 삭제됨.
    // Claude Code v2026 내장 파일 읽기 캐시가 중복 Read 측정 역할 대체.

    // Write a consolidated tool-usage.json next to the artifacts for
    // /vela:analyze to aggregate later.
    try {
      const toolUsagePath = path.join(activeArtifactDir, "tool-usage.json");
      fs.writeFileSync(toolUsagePath, JSON.stringify({
        updatedAt: new Date().toISOString(),
        budgetExceeded: rollup.budgetExceeded,
        duplicateReads: rollup.duplicateReads || [],
      }, null, 2));
    } catch {/* skip */}
  } catch {/* all rollup failures are non-fatal */}
  return rollup;
}

/**
 * Save session-end snapshot to .vela/state/session-end.json.
 */
function saveSessionEnd(cwd, pipelineState, changes) {
  try {
    const stateDir = path.join(cwd, ".vela", "state");
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

    // Read analytics summary if available
    let analyticsSummary = null;
    try {
      const analyticsPath = path.join(stateDir, "session-analytics.json");
      if (fs.existsSync(analyticsPath)) {
        const analytics = parseJsonSafe(fs.readFileSync(analyticsPath, "utf8"));
        if (analytics && analytics.summary) {
          analyticsSummary = analytics.summary;
        }
      }
    } catch { /* skip */ }

    const rollup = rollupToolUsage(cwd, pipelineState);

    const snapshot = {
      endedAt: new Date().toISOString(),
      activePipeline: pipelineState
        ? { step: pipelineState.current_step, request: pipelineState.request, auto: pipelineState.auto }
        : null,
      uncommittedChanges: changes.dirty ? changes.summary : null,
      analytics: analyticsSummary,
      toolUsage: rollup,
    };

    fs.writeFileSync(
      path.join(stateDir, "session-end.json"),
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
  } catch {
    // Silent — never fail on snapshot errors
  }
}

/**
 * Find the active pipeline state. Returns null if none found.
 */
function findActivePipelineState(cwd) {
  const artifactsDir = path.join(cwd, ".vela", "artifacts");
  if (!fs.existsSync(artifactsDir)) return null;

  const dirs = fs
    .readdirSync(artifactsDir)
    .filter((d) => /^\d{8}T\d{6}-/.test(d))
    .sort()
    .reverse();

  for (const dir of dirs) {
    const statePath = path.join(artifactsDir, dir, "pipeline-state.json");
    if (!fs.existsSync(statePath)) continue;
    const state = parseJsonSafe(fs.readFileSync(statePath, "utf8"));
    if (state && state.status === "active") return state;
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const input = parseJsonSafe(raw) || {};

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();

  // Find active pipeline
  const pipelineState = findActivePipelineState(cwd);

  // Check uncommitted git changes
  const changes = checkUncommittedChanges(cwd);

  // Save session-end snapshot (always, non-blocking)
  saveSessionEnd(cwd, pipelineState, changes);

  if (pipelineState && pipelineState.auto === true) {
    // Auto-mode pipeline is active — block premature stop
    const output = {
      decision: "block",
      reason: `Auto-mode pipeline is active (step: ${pipelineState.current_step || "unknown"}). Continue until pipeline completes.`,
    };
    writeGateEvent(cwd, {
      code: "STOP_AUTO",
      tool: "Stop",
      step: pipelineState.current_step || null,
      mode: null,
      decision: "deny",
      summary: "auto-mode active",
    });
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  // Warn about uncommitted changes (non-blocking — informational only)
  if (changes.dirty && pipelineState) {
    const output = {
      decision: "block",
      reason: `⚠️ 활성 파이프라인에 미커밋 변경사항이 있습니다 (${changes.summary}). 커밋하거나 stash한 후 종료하세요. 강제 종료하려면 다시 stop을 실행하세요.`,
    };
    writeGateEvent(cwd, {
      code: "STOP_DIRTY",
      tool: "Stop",
      step: pipelineState.current_step || null,
      mode: null,
      decision: "warn",
      summary: changes.summary,
    });
    process.stdout.write(JSON.stringify(output));
    // Reset dirty flag so second stop attempt passes through
    // (we can't track "second stop" in a stateless hook, so we allow once warned)
  }

  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: (e && e.message) ? e.message : "Unexpected error in vela-stop hook",
    })
  );
  process.exit(0);
});
