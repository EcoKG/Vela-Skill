#!/usr/bin/env node
/**
 * Vela Gate — Unified PreToolUse hook (v7.3-M4c)
 *
 * Merged from vela-gate-keeper.js (604 LOC, VK-01~10) + vela-gate-guard.js
 * (287 LOC, VG-03/13/14/15). Both were PreToolUse hooks firing on the
 * same event; running them as a single process cuts PreToolUse latency
 * in half (one stdin parse, one active-pipeline lookup, one config read).
 *
 * Enforcement order (fail-closed throughout):
 *
 *   1. fail-closed stdin checks       — empty/corrupt → exit 2
 *   2. findActivePipeline             — no active pipeline → exit 0 (allow all)
 *   3. Gate Keeper phase (VK codes)
 *       VK-01/02/08 Bash enforcement + chain-operator policy
 *       VK-03/04/07 Write/Edit mode enforcement
 *       VK-10       WebFetch/WebSearch in write mode
 *       M11         researcher targeted-scope Read enforcement
 *       → if nothing blocks, fall through to guard phase
 *   4. Gate Guard phase (VG codes)
 *       VG-03       corrupt tracker-signals blocks git commit
 *       VG-13       writes to .vela/templates/pipeline.json
 *       VG-14       secret patterns in Write content
 *       VG-15       failure circuit breaker
 *   5. Default: exit 0
 *
 * Every block path exits 2 with educational stderr via blockWithReason
 * (except HARD_BLOCK_CODES which exit silently for security reasons).
 * Every allow path exits 0.
 *
 * NOTE (V6): VK-09 and VG-12 were removed pre-M4c. In V6, PM delegates
 * to role agents via Agent(subagent_type=...) — blocking the Agent tool
 * would prevent orchestration. PM write protection is handled by VK-07.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {
  SAFE_BASH_READ,
  SECRET_PATTERNS,
  formatBlockStderr,
  writeGateEvent,
} = require("./shared/constants");

// ─── Block helpers ─────────────────────────────────────────

/**
 * Final block decision — educational stderr + telemetry + exit 2.
 * Merged keeper+guard behavior: `mode` field is optional (guard checks
 * don't know/care about pipeline mode).
 */
function blockWithReason(cwd, { code, tool, step, mode, extra, summary }) {
  const msg = formatBlockStderr(code, extra);
  if (msg) {
    try {
      process.stderr.write(msg + "\n");
    } catch {
      /* stderr closed — irrelevant, still exit 2 */
    }
  }
  writeGateEvent(cwd, {
    code,
    tool,
    step: step || null,
    mode: mode || null,
    decision: "deny",
    summary: summary || extra || "",
  });
  process.exit(2);
}

/**
 * Policy-driven soft block. Used when a rule is configurable via
 * `.vela/config.json#gate_policy`:
 *   "block" (default) → exit 2 via blockWithReason
 *   "ask"             → stdout {decision:"ask", reason} + exit 0
 *   "allow"           → warn event, exit 0
 */
function policyBlock(cwd, policy, { code, tool, step, mode, extra }) {
  if (policy === "allow") {
    writeGateEvent(cwd, { code, tool, step, mode, decision: "warn", summary: extra || "" });
    process.exit(0);
  }
  if (policy === "ask") {
    const entry = formatBlockStderr(code, extra) || `[${code}] blocked`;
    try {
      process.stdout.write(
        JSON.stringify({
          decision: "ask",
          reason: entry,
        }),
      );
    } catch {
      /* best-effort */
    }
    writeGateEvent(cwd, { code, tool, step, mode, decision: "ask", summary: extra || "" });
    process.exit(0);
  }
  blockWithReason(cwd, { code, tool, step, mode, extra });
}

/**
 * Read .vela/config.json#gate_policy with defaults preserving
 * existing behavior (everything = "block").
 */
function readGatePolicy(cwd) {
  const defaults = {
    chain_operator: "block",
    web_in_write: "block",
    researcher_scope: "block",
    event_log: true,
  };
  try {
    const p = path.join(cwd, ".vela", "config.json");
    if (!fs.existsSync(p)) return defaults;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    const gp = parsed && parsed.gate_policy;
    if (!gp || typeof gp !== "object") return defaults;
    return { ...defaults, ...gp };
  } catch {
    return defaults;
  }
}

// ─── VK-08: chain operator + verify safelist ───────────────

const CHAIN_OPERATOR_RE = /&&|\|\||;|\|/;

// v7.1 M2: verify-step safelist — narrow allowlist of test/lint runners
// that may pipe (tee/grep/jq) during the verify step. Non-verify steps
// still go through the strict chain-operator check.
const VERIFY_SAFELIST_PATTERNS = [
  /\bnode\s+--check\b/,
  /\bnpm\s+(test|run\s+(test|lint|typecheck|check|build)\b)/,
  /\byarn\s+(test|run\s+(test|lint|typecheck|check|build)\b)/,
  /\bpnpm\s+(test|run\s+(test|lint|typecheck|check|build)\b)/,
  /\bnpx\s+(jest|vitest|eslint|prettier|tsc|biome|playwright)\b/,
  /\btsc\s+--noEmit\b/,
  /\bpytest\b/,
  /\bpython3?\s+-m\s+(pytest|unittest|mypy|ruff|flake8|black)/,
  /\bruff\b/,
  /\bmypy\b/,
  /\bgo\s+(test|vet|build)\b/,
  /\bcargo\s+(test|build|check|clippy|fmt)\b/,
  /\bmake\s+(test|check|lint)\b/,
  /\bdotnet\s+(test|build)\b/,
  /\bmvn\s+(test|verify|-B|compile)\b/,
  /\bgradle\s+(test|check|build)\b/,
  /\bbash\s+scripts\/tests\//,
  /\bbash\s+\.vela\/guidelines\/smoke-test\.sh\b/,
  /\b\.vela\/guidelines\/smoke-test\.sh\b/,
  /\bcurl\s+-fs\S*\s+http:\/\/(localhost|127\.0\.0\.1)/,
];

/**
 * Read optional .vela/guidelines/verify-commands.txt for project-specific
 * extra ripgrep-style patterns. Returns an array of RegExp.
 */
function loadVerifyExtras(cwd) {
  try {
    const extrasPath = path.join(cwd, ".vela", "guidelines", "verify-commands.txt");
    if (!fs.existsSync(extrasPath)) return [];
    return fs
      .readFileSync(extrasPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        try {
          return new RegExp(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isVerifyStepSafe(cmd, cwd) {
  if (typeof cmd !== "string" || !cmd) return false;
  for (const pat of VERIFY_SAFELIST_PATTERNS) {
    if (pat.test(cmd)) return true;
  }
  for (const pat of loadVerifyExtras(cwd)) {
    if (pat.test(cmd)) return true;
  }
  return false;
}

// ─── Stdin / pipeline helpers ──────────────────────────────

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
 * Find the active pipeline state. Returns { state, artifactDir } or
 * null if none found.
 */
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
      try {
        const artifactDir = path.join(artifactsDir, dir);
        const statePath = path.join(artifactDir, "pipeline-state.json");
        if (!fs.existsSync(statePath)) continue;
        const state = parseJsonSafe(fs.readFileSync(statePath, "utf8"));
        if (state && state.status === "active") {
          return { state, artifactDir };
        }
      } catch {
        /* skip invalid entries */
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readPipelineDefinition(cwd) {
  try {
    const pipelinePath = path.join(cwd, ".vela", "templates", "pipeline.json");
    return parseJsonSafe(fs.readFileSync(pipelinePath, "utf8"));
  } catch {
    return null;
  }
}

function getCurrentMode(pipelineState, pipelineDef) {
  if (!pipelineState || !pipelineDef) return "readwrite";
  const { pipeline_type, current_step } = pipelineState;
  const pipeline = pipelineDef.pipelines && pipelineDef.pipelines[pipeline_type];
  if (!pipeline) return "readwrite";

  // Resolve steps with inheritance (mirrors resolveSteps in vela-engine.js)
  let steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
  if (pipeline.inherits && pipeline.steps_only) {
    const parent = pipelineDef.pipelines[pipeline.inherits];
    if (parent && Array.isArray(parent.steps)) {
      steps = parent.steps.filter((s) => pipeline.steps_only.includes(s.id));
      if (pipeline.overrides) {
        steps = steps.map((s) =>
          pipeline.overrides[s.id] ? { ...s, ...pipeline.overrides[s.id] } : s,
        );
      }
    }
  }

  const step = steps.find((s) => s.id === current_step);
  return (step && step.mode) || "readwrite";
}

// ─── M11 researcher scope helper ───────────────────────────

/**
 * v7.1 M11 — return true if `filePath` is outside the researcher's
 * allowed scope for the current pipeline. Returns false (allow) when
 * any of the following:
 *   - targets.json missing (legacy path)
 *   - confidence !== high && confidence !== medium
 *   - file matches primary / blast_radius / tests
 *   - file is project metadata (package.json, README, etc.)
 *   - file is inside .vela/ (artifacts, config, agent prompts)
 */
function isResearcherReadOutOfScope(cwd, pipelineResult, filePath) {
  try {
    if (!pipelineResult) return false;
    const tp = path.join(pipelineResult.artifactDir, "targets.json");
    if (!fs.existsSync(tp)) return false;
    const targetsJson = parseJsonSafe(fs.readFileSync(tp, "utf8"));
    if (!targetsJson) return false;
    const confidence = targetsJson.confidence;
    if (confidence !== "high" && confidence !== "medium") return false;

    let rel = filePath.replace(/\\/g, "/");
    if (rel.startsWith(cwd.replace(/\\/g, "/") + "/")) {
      rel = rel.slice(cwd.length + 1);
    }
    if (rel.startsWith("./")) rel = rel.slice(2);

    const META_ALLOW = [
      "package.json",
      "pyproject.toml",
      "go.mod",
      "go.sum",
      "Cargo.toml",
      "Cargo.lock",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "Gemfile",
      "README.md",
      "CONTRIBUTING.md",
      "CLAUDE.md",
    ];
    if (META_ALLOW.includes(rel) || META_ALLOW.includes(rel.split("/").pop())) {
      return false;
    }
    if (rel.startsWith(".vela/") || rel.includes("/.vela/")) return false;

    const isInList = (list, target) => {
      if (!Array.isArray(list)) return false;
      for (const entry of list) {
        const file = typeof entry === "string" ? entry : entry && entry.file;
        if (typeof file !== "string") continue;
        const normEntry = file.replace(/\\/g, "/").replace(/^\.\//, "");
        if (normEntry === target) return true;
        if (normEntry.endsWith("/") && target.startsWith(normEntry)) return true;
      }
      return false;
    };
    if (isInList(targetsJson.primary, rel)) return false;
    if (isInList(targetsJson.blast_radius, rel)) return false;
    if (isInList(targetsJson.tests, rel)) return false;

    return true;
  } catch {
    return false;
  }
}

// ─── Gate Guard helpers (VG codes) ─────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 5;

function isProtectedConfig(filePath, cwd) {
  try {
    const normalized = path.resolve(cwd, filePath).replace(/\\/g, "/");
    const pipelineJson = path
      .resolve(cwd, ".vela", "templates", "pipeline.json")
      .replace(/\\/g, "/");
    return normalized === pipelineJson;
  } catch {
    return false;
  }
}

function contentHasSecret(content) {
  if (typeof content !== "string" || content.length === 0) return false;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) return true;
  }
  return false;
}

function isCircuitOpen(cwd) {
  try {
    const circuitPath = path.join(cwd, ".vela", "state", "circuit-open.json");
    if (!fs.existsSync(circuitPath)) return false;
    const data = JSON.parse(fs.readFileSync(circuitPath, "utf8"));
    return (
      data &&
      typeof data.count === "number" &&
      data.count >= CIRCUIT_BREAKER_THRESHOLD
    );
  } catch {
    return false;
  }
}

function checkSignalsFile(cwd) {
  const signalsPath = path.join(cwd, ".vela", "tracker-signals.json");
  try {
    if (!fs.existsSync(signalsPath)) return "absent";
    const raw = fs.readFileSync(signalsPath, "utf8");
    const parsed = parseJsonSafe(raw);
    if (parsed === null) return "corrupt";
    return "ok";
  } catch {
    return "absent";
  }
}

// ─── Gate Keeper phase (VK codes) ──────────────────────────

/**
 * Runs all VK-* checks. If a check blocks, this function does not
 * return (blockWithReason / policyBlock exit the process). If all
 * checks pass, returns normally so the guard phase can run.
 *
 * ctx: { cwd, toolName, toolInput, pipelineResult, pipelineState,
 *        mode, step, gatePolicy }
 */
function runGateKeeper(ctx) {
  const { cwd, toolName, toolInput, pipelineResult, pipelineState, mode, step, gatePolicy } = ctx;

  // ─── VK-01/VK-02/VK-08: Bash enforcement ───
  if (toolName === "Bash") {
    const cmd = (typeof toolInput.command === "string" && toolInput.command) || "";

    // v7.1 M2: verify step safelist bypass
    const isVerifyStep = pipelineState && pipelineState.current_step === "verify";
    if (isVerifyStep && isVerifyStepSafe(cmd, cwd)) {
      return; // allow — fall through to guard phase
    }

    // VK-08: Block chain operators (policy-driven)
    if (CHAIN_OPERATOR_RE.test(cmd)) {
      policyBlock(cwd, gatePolicy.chain_operator, {
        code: "VK-08",
        tool: "Bash",
        step,
        mode,
        extra: cmd.slice(0, 80),
      });
      // policyBlock with "allow" exits 0. "ask" exits 0. "block" exits 2.
      // If we reach here, the process has already exited in policyBlock.
    }

    if (mode === "read") {
      if (SAFE_BASH_READ.test(cmd)) {
        return; // allow — fall through
      }
      blockWithReason(cwd, {
        code: "VK-01",
        tool: "Bash",
        step,
        mode,
        extra: cmd.slice(0, 80),
      });
    }

    if (mode === "write") {
      // Vela CLI commands are always allowed — PM needs them for state transitions
      if (/node\s+.*\.vela\/cli\/vela-[a-z-]+\.js/.test(cmd)) {
        return;
      }
      blockWithReason(cwd, {
        code: "VK-02",
        tool: "Bash",
        step,
        mode,
        extra: cmd.slice(0, 80),
      });
    }

    // readwrite: allow all bash (chain already checked above)
    return;
  }

  // ─── VK-03/VK-04/VK-07: Write/Edit/NotebookEdit enforcement ───
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    if (mode === "read") {
      const filePath =
        (typeof toolInput.file_path === "string" && toolInput.file_path) ||
        (typeof toolInput.path === "string" && toolInput.path) ||
        "";
      const normalized = filePath.replace(/\\/g, "/");
      const inVelaDir =
        normalized.includes("/.vela/") || normalized.startsWith(".vela/");
      const isPipelineState = normalized.includes("pipeline-state.json");

      if (inVelaDir && !isPipelineState) {
        return; // .vela/ artifacts/state are writable — fall through
      }

      blockWithReason(cwd, {
        code: "VK-04",
        tool: toolName,
        step,
        mode,
        extra: normalized,
      });
    }
  }

  // ─── VK-10: write mode — WebFetch/WebSearch blocked ─────
  if (mode === "write" && (toolName === "WebFetch" || toolName === "WebSearch")) {
    policyBlock(cwd, gatePolicy.web_in_write, {
      code: "VK-10",
      tool: toolName,
      step,
      mode,
      extra: toolName,
    });
  }

  // ─── v7.1 M11: researcher targeted-scope Read enforcement ──
  if (toolName === "Read" && pipelineState && pipelineState.current_step === "research") {
    const filePath =
      (typeof toolInput.file_path === "string" && toolInput.file_path) ||
      (typeof toolInput.path === "string" && toolInput.path) ||
      "";
    if (filePath) {
      const denied = isResearcherReadOutOfScope(cwd, pipelineResult, filePath);
      if (denied) {
        policyBlock(cwd, gatePolicy.researcher_scope, {
          code: "M11",
          tool: "Read",
          step,
          mode,
          extra: filePath,
        });
      }
    }
  }

  // All VK checks passed — fall through to guard phase
}

// ─── Gate Guard phase (VG codes) ───────────────────────────

/**
 * Runs all VG-* checks. If a check blocks, this function does not
 * return. Otherwise returns normally and main() exits 0.
 */
function runGateGuard(ctx) {
  const { cwd, toolName, toolInput, pipelineResult, step } = ctx;

  // ─── VG-03: Corrupt signals file blocks git commit ───
  if (toolName === "Bash") {
    const cmd = (typeof toolInput.command === "string" && toolInput.command) || "";
    if (/\bgit\s+commit\b/.test(cmd)) {
      const signalsStatus = checkSignalsFile(cwd);
      if (signalsStatus === "corrupt") {
        blockWithReason(cwd, {
          code: "VG-03",
          tool: "Bash",
          step,
          extra: "git commit",
        });
      }
    }
  }

  // ─── VG-13: Protected config file write ─────────────────
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const filePath =
      (typeof toolInput.file_path === "string" && toolInput.file_path) ||
      (typeof toolInput.path === "string" && toolInput.path) ||
      "";
    if (filePath && isProtectedConfig(filePath, cwd)) {
      blockWithReason(cwd, {
        code: "VG-13",
        tool: toolName,
        step,
        extra: filePath,
      });
    }
  }

  // ─── VG-14: Secret pattern in Write content ─────────────
  if (toolName === "Write") {
    const content = typeof toolInput.content === "string" ? toolInput.content : "";
    if (contentHasSecret(content)) {
      blockWithReason(cwd, {
        code: "VG-14",
        tool: "Write",
        step,
        extra: "", // never leak content excerpt for secrets
      });
    }
  }

  // ─── VG-15: Failure circuit breaker ─────────────────────
  if (pipelineResult && isCircuitOpen(cwd)) {
    blockWithReason(cwd, {
      code: "VG-15",
      tool: toolName,
      step,
      extra: "circuit-open",
    });
  }
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();

  // Fail-closed: empty stdin → silent hard block
  if (!raw || !raw.trim()) {
    process.exit(2);
  }

  // Fail-closed: corrupt JSON → silent hard block
  const input = parseJsonSafe(raw);
  if (!input) {
    process.exit(2);
  }

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const toolName = (typeof input.tool_name === "string" && input.tool_name) || "";
  const toolInput =
    input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};

  // Hooks are globally registered — only activate when a Vela pipeline is active
  const pipelineResult = findActivePipeline(cwd);
  if (!pipelineResult) {
    process.exit(0); // No active Vela pipeline — allow all tools
  }

  const pipelineState = pipelineResult.state;
  const pipelineDef = readPipelineDefinition(cwd);
  const mode = getCurrentMode(pipelineState, pipelineDef);
  const step = pipelineState && pipelineState.current_step;
  const gatePolicy = readGatePolicy(cwd);

  const ctx = {
    cwd,
    toolName,
    toolInput,
    pipelineResult,
    pipelineState,
    pipelineDef,
    mode,
    step,
    gatePolicy,
  };

  // Phase 1: gate keeper (VK codes). Returns if allowed; blocks exit 2.
  runGateKeeper(ctx);

  // Phase 2: gate guard (VG codes). Returns if allowed; blocks exit 2.
  runGateGuard(ctx);

  // Default: allow
  process.exit(0);
}

main().catch(() => process.exit(2));
