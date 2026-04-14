#!/usr/bin/env node
/**
 * Vela Review Gate — Stop Hook for Multi-Round Reviewer Validation
 *
 * When a reviewer returns APPROVE for a pipeline step, this hook enforces
 * N additional validation rounds before the PM may proceed with `record pass`.
 *
 * Design:
 *   - Failure retries (REJECT → retry researcher/executor) are PM's responsibility.
 *   - This hook ONLY handles the success-side re-validation loop.
 *   - Each time the PM stops after a reviewer APPROVE, this hook checks how many
 *     validation rounds have been completed. If fewer than the configured count,
 *     it blocks stop and prompts the PM to re-invoke the reviewer.
 *   - State tracked in .vela/state/review-gate-{step}.json (reset on transition).
 *
 * Config (.vela/config.json):
 *   review_gate.enabled            — boolean  (default: true)
 *   review_gate.validation_rounds  — number   (default: 3)
 *   review_gate.steps              — string[] (default: ["research", "execute", "plan"])
 *
 * Gate state file: .vela/state/review-gate-{step}.json
 *   { step, count, rounds, lastReviewAt }
 *   Deleted automatically by vela-engine.js transition command.
 *
 * Stop decisions:
 *   APPROVE + count < rounds  → block + "Re-validate round N/M: run reviewer again"
 *   APPROVE + count >= rounds → exit 0 (all rounds complete — allow PM to proceed)
 *   REJECT                    → exit 0 (PM handles failure retry separately)
 *   No review file            → exit 0 (step not yet reviewed)
 *   Step not in config        → exit 0 (not a reviewed step)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { writeGateEvent } = require("./shared/constants");

// ─── Defaults ────────────────────────────────────────────────
// Conservative defaults: one confirming re-validation on the execute step only.
// Execute is the single step where executor→reviewer drift actually occurs
// (generated code vs. quality judgment), so one extra review is worth the cost.
// Research/plan re-validation yields diminishing returns — the primary review
// already enforces CRITICAL detection and 20/25 scoring. Users who want stricter
// verification can set review_gate.validation_rounds + steps in .vela/config.json.
const DEFAULT_ROUNDS = 1;
const DEFAULT_STEPS = ["execute"];

// ─── Helpers ─────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
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
 * Find the currently active pipeline.
 * Returns { state, artifactDir } or null.
 */
function findActivePipeline(cwd) {
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
    if (state && state.status === "active") {
      return { state, artifactDir: path.join(artifactsDir, dir) };
    }
  }
  return null;
}

/**
 * Read .vela/config.json, return {} on any error.
 */
function readConfig(cwd) {
  try {
    const configPath = path.join(cwd, ".vela", "config.json");
    if (!fs.existsSync(configPath)) return {};
    return parseJsonSafe(fs.readFileSync(configPath, "utf8")) || {};
  } catch {
    return {};
  }
}

/**
 * Parse the reviewer verdict from review-{step}.md content.
 * Returns "approve", "reject", or null (undetermined).
 */
function extractVerdict(content) {
  const isApprove =
    /판정:\s*APPROVE/i.test(content) || /Verdict:\s*APPROVE/i.test(content);
  const isReject =
    /판정:\s*REJECT/i.test(content) || /Verdict:\s*REJECT/i.test(content);
  if (isApprove && !isReject) return "approve";
  if (isReject) return "reject";
  return null;
}

/**
 * Read per-step gate state from .vela/state/review-gate-{step}.json.
 */
function readGateState(stateDir, step) {
  try {
    const p = path.join(stateDir, `review-gate-${step}.json`);
    if (!fs.existsSync(p)) return { count: 0 };
    return parseJsonSafe(fs.readFileSync(p, "utf8")) || { count: 0 };
  } catch {
    return { count: 0 };
  }
}

/**
 * Write per-step gate state.
 */
function writeGateState(stateDir, step, data) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `review-gate-${step}.json`),
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch {
    /* silent — never fail on state write errors */
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const input = parseJsonSafe(raw) || {};
  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();

  // Find active pipeline — exit silently if none
  const pipelineResult = findActivePipeline(cwd);
  if (!pipelineResult) process.exit(0);

  const { state, artifactDir } = pipelineResult;
  const step = state.current_step;
  if (!step || step === "done") process.exit(0);

  // Read project config
  const config = readConfig(cwd);
  const gateConfig = config.review_gate || {};

  // Allow opt-out via config
  if (gateConfig.enabled === false) process.exit(0);

  const rounds =
    typeof gateConfig.validation_rounds === "number"
      ? gateConfig.validation_rounds
      : DEFAULT_ROUNDS;

  const allowedSteps = Array.isArray(gateConfig.steps)
    ? gateConfig.steps
    : DEFAULT_STEPS;

  // Only activate for configured steps
  if (!allowedSteps.includes(step)) process.exit(0);

  // Read review-{step}.md
  const reviewFile = path.join(artifactDir, `review-${step}.md`);
  if (!fs.existsSync(reviewFile)) process.exit(0);

  const reviewContent = fs.readFileSync(reviewFile, "utf8");
  const verdict = extractVerdict(reviewContent);

  // Only act on APPROVE — REJECT is the PM's responsibility (failure retry path)
  if (verdict !== "approve") process.exit(0);

  // Read current gate state
  const stateDir = path.join(cwd, ".vela", "state");
  const gateState = readGateState(stateDir, step);
  const completedCount = gateState.count || 0;

  if (completedCount >= rounds) {
    // All validation rounds complete — allow PM to proceed
    process.exit(0);
  }

  // Need more validation rounds — record progress and block
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

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: [
        `[VELA REVIEW GATE] ${step.toUpperCase()} 재검증 ${newCount}/${rounds} — ${remaining}회 남음.`,
        `이전 검증: APPROVE. 품질 확보를 위해 추가 검증이 필요합니다.`,
        `→ Agent(subagent_type="vela-reviewer")를 다시 호출하세요.`,
        `→ 리뷰어가 다시 APPROVE하면 ${remaining > 1 ? "계속 검증" : "record pass → transition"}.`,
        `→ 리뷰어가 REJECT하면 Agent(subagent_type="${agentName}")로 수정 후 재검증.`,
        `(설정: ${rounds}회 연속 APPROVE 필요 — .vela/config.json review_gate.validation_rounds)`,
      ].join("\n"),
    })
  );
  process.exit(0);
}

main().catch(() => {
  // Never block on unexpected errors — fail open
  process.exit(0);
});
