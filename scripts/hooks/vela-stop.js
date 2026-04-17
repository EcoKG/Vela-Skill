#!/usr/bin/env node
/**
 * Vela Stop Hook — Unified Stop + SubagentStop handler (v7.3-M4d)
 *
 * Dispatches on stdin's `hook_event_name`:
 *
 *   Stop (main loop about to stop):
 *     1. Review Gate — if reviewer returned APPROVE for a reviewed step
 *        and fewer than the configured validation rounds have completed,
 *        block and prompt the PM to re-invoke the reviewer.
 *     2. Auto-mode block — if an auto-mode pipeline is active, block
 *        premature stop.
 *     3. Dirty-tree warning — if uncommitted git changes exist inside
 *        an active pipeline, emit a non-fatal warning.
 *     4. Session-end snapshot — always save a snapshot to
 *        .vela/state/session-end.json (analytics + pipeline state +
 *        uncommitted changes + budget-exceeded roll-up).
 *
 *   SubagentStop (a sub-agent just finished):
 *     Append a per-agent telemetry entry to
 *     <active-artifact-dir>/agent-telemetry.jsonl. Consumed by
 *     vela-cost.js for per-role token/tool attribution (v7.2 M8).
 *
 * Crash-safe: the main loop's .catch() always emits a block decision with
 * the error message for Stop events (so Claude Code sees it even if the
 * hook faults). SubagentStop is observational and exits 0 on error.
 *
 * v7.3-M4d (2026-04-17): Merged from
 *   vela-stop.js (254 LOC) + vela-review-gate.js (252 LOC) + vela-subagent-stop.js (99 LOC)
 * into a single dispatch hook. Hooks: 6 → 5.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { writeGateEvent } = require("./shared/constants");

// ─── Review-gate defaults ───────────────────────────────────
// Conservative: one confirming re-validation on execute only.
// Execute is the single step where executor→reviewer drift actually
// occurs (generated code vs. quality judgment). Users can override
// via .vela/config.json review_gate.{validation_rounds,steps}.
const DEFAULT_ROUNDS = 1;
const DEFAULT_STEPS = ["execute"];

// ─── Shared helpers ─────────────────────────────────────────

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

function findActivePipeline(cwd) {
  try {
    const artifactsDir = path.join(cwd, ".vela", "artifacts");
    if (!fs.existsSync(artifactsDir)) return null;

    const dirs = fs
      .readdirSync(artifactsDir)
      .filter((d) => /^\d{8}T\d{6}-/.test(d))
      .sort()
      .reverse();

    for (const dir of dirs) {
      const artifactDir = path.join(artifactsDir, dir);
      const statePath = path.join(artifactDir, "pipeline-state.json");
      if (!fs.existsSync(statePath)) continue;
      const state = parseJsonSafe(fs.readFileSync(statePath, "utf8"));
      if (state && state.status === "active") {
        return { state, artifactDir };
      }
    }
  } catch {
    /* skip */
  }
  return null;
}

// ─── Stop: session-end snapshot ─────────────────────────────

function checkUncommittedChanges(cwd) {
  try {
    const { execFileSync } = require("child_process");
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    })
      .toString()
      .trim();
    if (!status) return { dirty: false, summary: "" };
    const lines = status.split("\n").filter(Boolean);
    return { dirty: true, summary: `${lines.length} uncommitted change(s)` };
  } catch {
    return { dirty: false, summary: "" };
  }
}

/**
 * v7.1 M9 (v7.3-M4: M10 roll-up 제거) — budget-exceeded.json 집계만.
 * Non-fatal on any error.
 */
function rollupToolUsage(cwd, pipelineResult) {
  const rollup = { budgetExceeded: null, duplicateReads: null };
  if (!pipelineResult) return rollup;
  try {
    const bePath = path.join(pipelineResult.artifactDir, "budget-exceeded.json");
    if (fs.existsSync(bePath)) {
      try {
        rollup.budgetExceeded = parseJsonSafe(fs.readFileSync(bePath, "utf8"));
      } catch {
        /* skip */
      }
    }
    try {
      const toolUsagePath = path.join(pipelineResult.artifactDir, "tool-usage.json");
      fs.writeFileSync(
        toolUsagePath,
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            budgetExceeded: rollup.budgetExceeded,
            duplicateReads: rollup.duplicateReads || [],
          },
          null,
          2,
        ),
      );
    } catch {
      /* skip */
    }
  } catch {
    /* all rollup failures are non-fatal */
  }
  return rollup;
}

function saveSessionEnd(cwd, pipelineResult, changes) {
  try {
    const stateDir = path.join(cwd, ".vela", "state");
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

    let analyticsSummary = null;
    try {
      const analyticsPath = path.join(stateDir, "session-analytics.json");
      if (fs.existsSync(analyticsPath)) {
        const analytics = parseJsonSafe(fs.readFileSync(analyticsPath, "utf8"));
        if (analytics && analytics.summary) analyticsSummary = analytics.summary;
      }
    } catch {
      /* skip */
    }

    const rollup = rollupToolUsage(cwd, pipelineResult);
    const pipelineState = pipelineResult ? pipelineResult.state : null;
    const snapshot = {
      endedAt: new Date().toISOString(),
      activePipeline: pipelineState
        ? {
            step: pipelineState.current_step,
            request: pipelineState.request,
            auto: pipelineState.auto,
          }
        : null,
      uncommittedChanges: changes.dirty ? changes.summary : null,
      analytics: analyticsSummary,
      toolUsage: rollup,
    };

    fs.writeFileSync(
      path.join(stateDir, "session-end.json"),
      JSON.stringify(snapshot, null, 2),
      "utf8",
    );
  } catch {
    /* Silent — never fail on snapshot errors */
  }
}

// ─── Stop: review-gate ──────────────────────────────────────

function readConfig(cwd) {
  try {
    const configPath = path.join(cwd, ".vela", "config.json");
    if (!fs.existsSync(configPath)) return {};
    return parseJsonSafe(fs.readFileSync(configPath, "utf8")) || {};
  } catch {
    return {};
  }
}

function extractVerdict(content) {
  const isApprove =
    /판정:\s*APPROVE/i.test(content) || /Verdict:\s*APPROVE/i.test(content);
  const isReject =
    /판정:\s*REJECT/i.test(content) || /Verdict:\s*REJECT/i.test(content);
  if (isApprove && !isReject) return "approve";
  if (isReject) return "reject";
  return null;
}

function readGateState(stateDir, step) {
  try {
    const p = path.join(stateDir, `review-gate-${step}.json`);
    if (!fs.existsSync(p)) return { count: 0 };
    return parseJsonSafe(fs.readFileSync(p, "utf8")) || { count: 0 };
  } catch {
    return { count: 0 };
  }
}

function writeGateState(stateDir, step, data) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `review-gate-${step}.json`),
      JSON.stringify(data, null, 2),
      "utf8",
    );
  } catch {
    /* silent — never fail on state write errors */
  }
}

/**
 * Evaluate the review-gate policy. Returns either:
 *   - an object { decision: "block", reason } to emit and stop further work, or
 *   - null if the gate has no opinion (unreviewed, all rounds complete,
 *     opted out, or not a reviewed step).
 */
function evaluateReviewGate(cwd, pipelineResult) {
  if (!pipelineResult) return null;
  const { state, artifactDir } = pipelineResult;
  const step = state.current_step;
  if (!step || step === "done") return null;

  const config = readConfig(cwd);
  const gateConfig = config.review_gate || {};
  if (gateConfig.enabled === false) return null;

  const rounds =
    typeof gateConfig.validation_rounds === "number"
      ? gateConfig.validation_rounds
      : DEFAULT_ROUNDS;
  const allowedSteps = Array.isArray(gateConfig.steps)
    ? gateConfig.steps
    : DEFAULT_STEPS;
  if (!allowedSteps.includes(step)) return null;

  const reviewFile = path.join(artifactDir, `review-${step}.md`);
  if (!fs.existsSync(reviewFile)) return null;

  const verdict = extractVerdict(fs.readFileSync(reviewFile, "utf8"));
  if (verdict !== "approve") return null;

  const stateDir = path.join(cwd, ".vela", "state");
  const gateState = readGateState(stateDir, step);
  const completedCount = gateState.count || 0;
  if (completedCount >= rounds) return null;

  const newCount = completedCount + 1;
  writeGateState(stateDir, step, {
    step,
    count: newCount,
    rounds,
    lastReviewAt: new Date().toISOString(),
  });

  const remaining = rounds - newCount;
  const agentName =
    step === "execute"
      ? "vela-executor"
      : step === "research"
        ? "vela-researcher"
        : step === "plan"
          ? "vela-planner"
          : `vela-${step}`;

  writeGateEvent(cwd, {
    code: "REVIEW_GATE",
    tool: "Stop",
    step,
    mode: null,
    decision: "deny",
    summary: `round ${newCount}/${rounds}`,
  });

  return {
    decision: "block",
    reason: [
      `[VELA REVIEW GATE] ${step.toUpperCase()} 재검증 ${newCount}/${rounds} — ${remaining}회 남음.`,
      `이전 검증: APPROVE. 품질 확보를 위해 추가 검증이 필요합니다.`,
      `→ Agent(subagent_type="vela-reviewer")를 다시 호출하세요.`,
      `→ 리뷰어가 다시 APPROVE하면 ${remaining > 1 ? "계속 검증" : "record pass → transition"}.`,
      `→ 리뷰어가 REJECT하면 Agent(subagent_type="${agentName}")로 수정 후 재검증.`,
      `(설정: ${rounds}회 연속 APPROVE 필요 — .vela/config.json review_gate.validation_rounds)`,
    ].join("\n"),
  };
}

// ─── Main dispatchers ───────────────────────────────────────

/**
 * Handle a Stop event.
 *
 * Priority of block decisions:
 *   1. Review gate (most specific signal — reviewer APPROVED, needs more rounds)
 *   2. Auto-mode active (block premature stop during autonomous run)
 *   3. Dirty tree inside active pipeline (informational warning)
 *
 * Always runs saveSessionEnd (non-blocking).
 */
async function runStop(input, cwd) {
  const pipelineResult = findActivePipeline(cwd);
  const changes = checkUncommittedChanges(cwd);

  // Always record session-end snapshot (non-fatal).
  saveSessionEnd(cwd, pipelineResult, changes);

  if (!pipelineResult) {
    process.exit(0);
  }

  // Priority 1: review-gate re-validation
  const reviewBlock = evaluateReviewGate(cwd, pipelineResult);
  if (reviewBlock) {
    process.stdout.write(JSON.stringify(reviewBlock));
    process.exit(0);
  }

  const pipelineState = pipelineResult.state;

  // Priority 2: auto-mode block
  if (pipelineState.auto === true) {
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

  // Priority 3: dirty-tree warning (blocks once; user re-runs stop to bypass)
  if (changes.dirty) {
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
  }

  process.exit(0);
}

/**
 * Handle a SubagentStop event.
 *
 * Observational only — append to agent-telemetry.jsonl for vela-cost.js
 * aggregation. Silent on any error.
 */
async function runSubagentStop(input, cwd) {
  const pipelineResult = findActivePipeline(cwd);
  if (!pipelineResult) process.exit(0);

  const entry = {
    ts: new Date().toISOString(),
    agent: input.subagent_type || "unknown",
    session_id: input.session_id || null,
    usage: input.usage || null,
    tool_counts: input.tool_counts || null,
    duration_ms:
      typeof input.duration_ms === "number" ? input.duration_ms : null,
    model: input.model || null,
  };

  try {
    const outPath = path.join(pipelineResult.artifactDir, "agent-telemetry.jsonl");
    fs.appendFileSync(outPath, JSON.stringify(entry) + "\n");
  } catch {
    /* silent */
  }

  process.exit(0);
}

// ─── Entrypoint ─────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const input = parseJsonSafe(raw) || {};
  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const event = input.hook_event_name;

  if (event === "SubagentStop") {
    return runSubagentStop(input, cwd);
  }
  return runStop(input, cwd);
}

main().catch((e) => {
  // Crash-safe: emit block decision with error message so Claude Code
  // still sees a response. SubagentStop is observational and unaffected
  // by a block, so emitting for all events is harmless.
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason:
        e && e.message ? e.message : "Unexpected error in vela-stop hook",
    }),
  );
  process.exit(0);
});
