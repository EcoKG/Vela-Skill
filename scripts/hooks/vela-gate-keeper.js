#!/usr/bin/env node
/**
 * Vela Gate Keeper — Claude Code PreToolUse Hook
 *
 * Enforces pipeline mode restrictions on every tool call.
 * Implements VK-01 through VK-08 gate rules.
 *
 * Exit codes:
 *   0 — allow the tool call
 *   2 — block the tool call (fail-closed)
 *
 * Fail-closed: any error (corrupt stdin, empty stdin, unhandled exception)
 * results in exit 2 (deny) rather than exit 0 (allow).
 *
 * Gates:
 *   VK-01/VK-02: Bash blocking per mode
 *   VK-03/VK-04: Write/Edit blocking in read mode
 *   VK-07: PM mode — only Read/Glob/Grep allowed; Write/Edit blocked
 *   VK-08: Chain operator blocking (&&, ||, ;, |)
 *   VK-10: write mode — WebFetch/WebSearch blocked (network ops inconsistent with write isolation)
 *
 * NOTE (V6): VK-09 removed. In V6, PM uses the Agent tool directly to spawn role agents
 * (vela-researcher, vela-planner, vela-executor, etc.) — this is the intended orchestration
 * mechanism. Blocking Agent tool would prevent pipeline execution.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { SAFE_BASH_READ } = require("./shared/constants");

// VK-08: Chain operator regex — matches &&, ||, ;, | (pipe)
const CHAIN_OPERATOR_RE = /&&|\|\||;|\|/;

// v7.1 M2: verify-step safelist.
//
// The verify step runs the project's existing test and lint tooling.
// Before v7.1, VK-08 blocked any command containing `|` (to catch
// generic chain operators), and that included legitimate verifier
// patterns like `npm test | tee /tmp/out.log` or `npx vitest run |
// grep FAIL`. In the hicoco T081421 session the verifier had to
// fall back to static-only analysis because every useful Bash call
// was rejected.
//
// v7.1 solution: when the current pipeline step is `verify`, the
// gate keeper matches the command against this regex *first*. A
// match skips both the chain operator check and the generic
// bash-policy check — the verifier's Bash is allowed to pipe,
// because the whole point of verify is running the project's
// tests end-to-end.
//
// The patterns listed here are intentionally conservative: they
// cover the standard Node/Python/Go/Rust/.NET/Java test runners,
// the linters that ship with them, and `node --check` style AST
// syntax validators. Everything else still goes through VK-08
// and the regular mode policy, so a malicious verifier can't
// use this as an escape hatch for `git reset` or `rm -rf`.
//
// Projects can extend the list via .vela/guidelines/verify-commands.txt
// (one extra ripgrep-style regex per line). loadVerifyExtras reads it
// at hook-invocation time so edits are picked up without restarting
// Claude Code.
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
  /\bcurl\s+-fs\S*\s+http:\/\/(localhost|127\.0\.0\.1)/, // smoke-test health checks
];

/**
 * Load project-local verify-command extras if the user has dropped
 * a `.vela/guidelines/verify-commands.txt` file in their project.
 * One pattern per line, blank lines and `#` comments allowed.
 * Patterns are treated as ripgrep-style regex literals.
 *
 * Safe on any error — returns an empty array and falls through to
 * the built-in safelist. Never crashes the hook.
 */
function loadVerifyExtras(cwd) {
  try {
    const p = path.join(cwd, ".vela", "guidelines", "verify-commands.txt");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        out.push(new RegExp(trimmed));
      } catch {
        // Malformed regex — skip silently, verifier falls back to
        // built-in list. Logging from a gate hook would pollute
        // unrelated tool outputs.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function isVerifyStepSafe(cmd, cwd) {
  for (const re of VERIFY_SAFELIST_PATTERNS) {
    if (re.test(cmd)) return true;
  }
  for (const re of loadVerifyExtras(cwd)) {
    if (re.test(cmd)) return true;
  }
  return false;
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Read all of stdin as a string. Resolves with empty string if stdin is a TTY.
 */
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

/**
 * Safe JSON parse. Returns null on any error.
 */
function parseJsonSafe(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Find the active pipeline state. Returns null if none found.
 * Searches .vela/artifacts/{YYYYMMDD}T{HHmmss}-{slug}/pipeline-state.json
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
        const statePath = path.join(artifactsDir, dir, "pipeline-state.json");
        if (!fs.existsSync(statePath)) continue;
        const state = parseJsonSafe(fs.readFileSync(statePath, "utf8"));
        if (state && state.status === "active") return state;
      } catch {
        // skip invalid entries
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read pipeline definition from .vela/templates/pipeline.json.
 * Returns null on error.
 */
function readPipelineDefinition(cwd) {
  try {
    const pipelinePath = path.join(cwd, ".vela", "templates", "pipeline.json");
    return parseJsonSafe(fs.readFileSync(pipelinePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Get the mode for the current pipeline step.
 * Returns "readwrite" as a permissive default when mode cannot be determined.
 */
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

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();

  // Fail-closed: empty stdin → block
  if (!raw || !raw.trim()) {
    process.exit(2);
  }

  // Fail-closed: corrupt JSON → block
  const input = parseJsonSafe(raw);
  if (!input) {
    process.exit(2);
  }

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const toolName = (typeof input.tool_name === "string" && input.tool_name) || "";
  const toolInput = (input.tool_input && typeof input.tool_input === "object")
    ? input.tool_input
    : {};

  // Hooks are globally registered — only activate when a Vela pipeline is active
  const pipelineState = findActivePipeline(cwd);
  if (!pipelineState) {
    process.exit(0); // No active Vela pipeline — allow all tools
  }

  // Find pipeline definition and current mode
  const pipelineDef = readPipelineDefinition(cwd);
  const mode = getCurrentMode(pipelineState, pipelineDef);

  // ─── VK-01/VK-02/VK-08: Bash enforcement ───
  if (toolName === "Bash") {
    const cmd = (typeof toolInput.command === "string" && toolInput.command) || "";

    // v7.1 M2: verify step gets a whitelisted bypass of the chain-
    // operator check so the verifier can pipe test output through
    // tee/grep/jq. The safelist is narrow — only known test/lint
    // runners — so a malicious verifier can't use this to tunnel
    // `git reset --hard` or `rm -rf` through a `|` pipe.
    const isVerifyStep =
      pipelineState && pipelineState.current_step === "verify";
    if (isVerifyStep && isVerifyStepSafe(cmd, cwd)) {
      process.exit(0);
    }

    // VK-08: Block chain operators even in safe commands
    if (CHAIN_OPERATOR_RE.test(cmd)) {
      process.exit(2);
    }

    if (mode === "read") {
      // Allow safe read-only commands; block everything else
      if (SAFE_BASH_READ.test(cmd)) {
        process.exit(0);
      }
      process.exit(2);
    }

    if (mode === "write") {
      // Vela CLI commands are always allowed — PM needs them for state transitions
      if (/node\s+.*\.vela\/cli\/vela-[a-z-]+\.js/.test(cmd)) {
        process.exit(0);
      }
      // All other Bash blocked in write mode (VK-02)
      process.exit(2);
    }

    // readwrite: allow all bash (chain already checked above)
    process.exit(0);
  }

  // ─── VK-03/VK-04/VK-07: Write/Edit/NotebookEdit enforcement ───
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    if (mode === "read") {
      // Allow writes inside .vela/ (except pipeline-state.json)
      const filePath = (typeof toolInput.file_path === "string" && toolInput.file_path)
        || (typeof toolInput.path === "string" && toolInput.path)
        || "";
      const normalized = filePath.replace(/\\/g, "/");
      const inVelaDir =
        normalized.includes("/.vela/") || normalized.startsWith(".vela/");
      const isPipelineState = normalized.includes("pipeline-state.json");

      if (inVelaDir && !isPipelineState) {
        process.exit(0); // .vela/ artifacts/state are writable
      }

      // All other writes blocked in read mode
      process.exit(2);
    }
  }

  // ─── VK-10: write mode — WebFetch/WebSearch blocked ───────────
  // In write mode, only Write/Edit file operations are appropriate.
  // Network operations are inconsistent with isolated write-only mode.
  if (mode === "write" && (toolName === "WebFetch" || toolName === "WebSearch")) {
    process.exit(2);
  }

  // ─── v7.1 M11: researcher targeted-scope Read enforcement ───
  //
  // When the active pipeline is on the `research` step AND the
  // locate targets.json has confidence ∈ {high, medium}, the researcher
  // is only allowed to Read files in primary[] ∪ blast_radius[] ∪ tests[]
  // plus a small allowlist of project-metadata files. Pre-v7.1 a researcher
  // could happily `Read` server/index.js and client/src/App.jsx even when
  // locate's primary[] was two files in scraper/, which is how hicoco
  // research averaged 12 tool_use per session.
  //
  // Failure mode: we can't positively identify that the current Read is
  // coming from a `vela-researcher` sub-agent (Claude Code doesn't pass
  // the sub-agent type through tool_input), so we use pipeline
  // current_step as a proxy: anything Read during the `research` step is
  // assumed to be researcher activity. The PM itself may also Read during
  // research (to look at review-research.md) — we exempt artifact files
  // and config files below so PM operations still go through.
  if (
    toolName === "Read" &&
    pipelineState &&
    pipelineState.current_step === "research"
  ) {
    const filePath =
      (typeof toolInput.file_path === "string" && toolInput.file_path) ||
      (typeof toolInput.path === "string" && toolInput.path) ||
      "";
    if (filePath) {
      const denied = isResearcherReadOutOfScope(cwd, pipelineState, filePath);
      if (denied) {
        process.exit(2);
      }
    }
  }

  // Default: allow
  process.exit(0);
}

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
function isResearcherReadOutOfScope(cwd, pipelineState, filePath) {
  try {
    // Locate the artifactDir belonging to the active pipeline.
    // pipelineState lives at .vela/artifacts/{slug}/pipeline-state.json.
    // We don't carry the slug in state so we re-derive it.
    const artifactsDir = path.join(cwd, ".vela", "artifacts");
    if (!fs.existsSync(artifactsDir)) return false;
    const dirs = fs
      .readdirSync(artifactsDir)
      .filter((d) => /^\d{8}T\d{6}-/.test(d))
      .sort()
      .reverse();

    let targetsJson = null;
    for (const dir of dirs) {
      const sp = path.join(artifactsDir, dir, "pipeline-state.json");
      if (!fs.existsSync(sp)) continue;
      try {
        const s = parseJsonSafe(fs.readFileSync(sp, "utf8"));
        if (!s || s.status !== "active") continue;
        const tp = path.join(artifactsDir, dir, "targets.json");
        if (fs.existsSync(tp)) {
          targetsJson = parseJsonSafe(fs.readFileSync(tp, "utf8"));
        }
        break;
      } catch {
        /* skip */
      }
    }

    // No targets.json or low confidence → we don't enforce M11 scope
    // (fall through to regular allow).
    if (!targetsJson) return false;
    const confidence = targetsJson.confidence;
    if (confidence !== "high" && confidence !== "medium") return false;

    // Normalise the path for comparison. Strip leading "./" and any
    // cwd-relative absolute prefix so we compare in project-relative form.
    let rel = filePath.replace(/\\/g, "/");
    if (rel.startsWith(cwd.replace(/\\/g, "/") + "/")) {
      rel = rel.slice(cwd.length + 1);
    }
    if (rel.startsWith("./")) rel = rel.slice(2);

    // Allowlist: metadata + .vela/ artifacts + researcher self-refs
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

    // Check against primary/blast_radius/tests
    const isInList = (list, target) => {
      if (!Array.isArray(list)) return false;
      for (const entry of list) {
        const file = typeof entry === "string" ? entry : entry && entry.file;
        if (typeof file !== "string") continue;
        const normEntry = file.replace(/\\/g, "/").replace(/^\.\//, "");
        if (normEntry === target) return true;
        // Allow subdir match: if entry is a directory-ish path, permit
        // files under it (locate.js sometimes emits "scraper/" style).
        if (normEntry.endsWith("/") && target.startsWith(normEntry)) return true;
      }
      return false;
    };
    if (isInList(targetsJson.primary, rel)) return false;
    if (isInList(targetsJson.blast_radius, rel)) return false;
    if (isInList(targetsJson.tests, rel)) return false;

    // Nothing matched — out of scope.
    return true;
  } catch {
    // On any error, fall through to allow — gate-keeper must never
    // break a pipeline because its own scope helper crashed.
    return false;
  }
}

main().catch(() => process.exit(2));
