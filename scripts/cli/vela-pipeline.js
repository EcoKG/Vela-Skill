#!/usr/bin/env node
/**
 * Vela Pipeline Orchestrator — SDK-based Pipeline Execution
 *
 * Drives the Vela pipeline (research→plan→execute→review) using
 * @anthropic-ai/claude-agent-sdk query() calls. Each step spawns
 * an isolated SDK agent with step-specific tools, system prompts,
 * and permission hooks.
 *
 * Commands:
 *   run <request> [--type TYPE]                   — Run full pipeline
 *   resume                                         — Resume active pipeline from current step
 *   status                                         — Show pipeline status
 *   cancel                                         — Cancel active pipeline
 *
 * Architecture:
 *   - vela-engine.js handles state machine (init/transition/record)
 *   - This file handles SDK agent orchestration per step
 *   - constants.js provides guard patterns (bash, secrets, sensitive files)
 *   - pipeline.json defines step sequences per pipeline type
 *
 * Key decisions:
 *   D028: SDK orchestrator approach (query-based, not hook-based)
 *   D029: bypassPermissions mandatory (dontAsk/acceptEdits prompt on Read)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ─── Paths ───
const CWD = process.cwd();
const VELA_DIR = path.join(CWD, ".vela");
const TEMPLATES_DIR = path.join(VELA_DIR, "templates");
const AGENTS_DIR = path.join(VELA_DIR, "scripts", "agents");
const ENGINE_PATH = path.resolve(__dirname, "vela-engine.js");
const LOCK_PATH = path.join(VELA_DIR, "state", ".orchestrator.lock");

// ─── Constants for SDK hooks guards ───
const {
  SAFE_BASH_READ,
  BASH_WRITE_PATTERNS,
  SENSITIVE_FILES,
  SECRET_PATTERNS,
  MODEL_VERSIONS,
} = require("../shared/constants");

// ─── SDK runner ───
const { runSdkAgent } = require("../shared/sdk-runner");

// ─── SDK diff-summary & learning ───
const { sdkDiffSummary } = require("../shared/sdk-diff-summary");
const { sdkLearning } = require("../shared/sdk-learning");

// ─── Project environment detection ───
const { detectProjectEnvironment, formatEnvBlock } = require("../shared/project-env");

// ─── TreeNode cache — path collector ───
const { appendPaths } = require("../cache/treenode");

// ─── CLI Argument Parsing ───
const args = process.argv.slice(2);
const command = args[0];

// ═══════════════════════════════════════════════════════════
//  SDK Hooks — Permission Guards as Callbacks
// ═══════════════════════════════════════════════════════════

/**
 * Guard: Block bash commands that write files in read-only mode.
 * Uses SAFE_BASH_READ regex and BASH_WRITE_PATTERNS from constants.js.
 *
 * @param {string} mode - Current step mode ('read', 'write', 'readwrite')
 * @returns {Function|null} PreToolUse hook callback, or null if mode allows all bash
 */
function createBashGuard(mode) {
  if (mode === "readwrite") return null; // No restrictions in readwrite mode

  return async (input) => {
    if (input.tool_name !== "Bash") return undefined; // Pass through non-bash

    const cmd = input.tool_input?.command || "";

    if (mode === "read") {
      // In read mode: allow safe read commands, block everything else
      if (SAFE_BASH_READ.test(cmd)) return undefined; // Safe read — allow

      // Check for write patterns — explicit block
      for (const pattern of BASH_WRITE_PATTERNS) {
        if (pattern.test(cmd)) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: `[vela-pipeline] Bash write command blocked in read mode: ${cmd.substring(0, 80)}`,
            },
          };
        }
      }

      // Not in safe-read list and not a write pattern — deny conservatively
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `[vela-pipeline] Bash command not in safe-read allowlist: ${cmd.substring(0, 80)}`,
        },
      };
    }

    if (mode === "write") {
      // In write mode: block bash entirely (write via Write/Edit tools only)
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "[vela-pipeline] Bash blocked in write mode. Use Write/Edit tools.",
        },
      };
    }

    return undefined;
  };
}

/**
 * Guard: Block access to sensitive files (.env, credentials.json, etc.)
 * Uses SENSITIVE_FILES list from constants.js.
 *
 * @returns {Function} PreToolUse hook callback
 */
function createSensitiveFileGuard() {
  return async (input) => {
    const toolName = input.tool_name;
    if (!["Read", "Write", "Edit"].includes(toolName)) return undefined;

    const filePath =
      input.tool_input?.file_path || input.tool_input?.path || "";
    const basename = path.basename(filePath);

    if (SENSITIVE_FILES.includes(basename)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `[vela-pipeline] Access to sensitive file blocked: ${basename}`,
        },
      };
    }

    return undefined;
  };
}

/**
 * Guard: Block tool outputs that contain secrets (API keys, tokens, etc.)
 * Uses SECRET_PATTERNS from constants.js.
 *
 * Implemented as PostToolUse hook — inspects tool output after execution.
 * Returns a warning but doesn't block (secrets already leaked to agent context).
 * Primary defense is PreToolUse guards; this is an observability layer.
 *
 * @returns {Function} PostToolUse hook callback
 */
function createSecretGuard() {
  return async (input) => {
    const response = input.tool_response || "";
    const responseStr =
      typeof response === "string" ? response : JSON.stringify(response);

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(responseStr)) {
        console.error(
          `[vela-pipeline] ⚠️ Secret pattern detected in ${input.tool_name} output`,
        );
        // Log but don't block — the output already reached the agent
        break;
      }
    }

    return { continue: true };
  };
}

/**
 * Guard: Block git operations on protected branches.
 *
 * @returns {Function} PreToolUse hook callback
 */
function createProtectedBranchGuard() {
  const PROTECTED = ["main", "master", "develop"];

  return async (input) => {
    if (input.tool_name !== "Bash") return undefined;

    const cmd = input.tool_input?.command || "";
    // Only check git push/merge/rebase commands
    if (!/\bgit\s+(push|merge|rebase)\b/.test(cmd)) return undefined;

    // Check current branch
    try {
      const branch = execFileSync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        {
          cwd: CWD,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        },
      )
        .toString()
        .trim();

      if (PROTECTED.includes(branch)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `[vela-pipeline] Git operation blocked on protected branch: ${branch}`,
          },
        };
      }
    } catch (_e) {
      // Not a git repo or git not available — allow
    }

    return undefined;
  };
}

/**
 * Guard: Restrict Write tool calls to paths inside artifactDir.
 *
 * Used by rw-artifact mode — research/verify steps need Write access but
 * should only create artifact files under the pipeline's artifactDir (e.g.
 * .vela/artifacts/<pipeline-id>/). Arbitrary source file writes are denied.
 *
 * Uses path.resolve() on both the incoming file_path and artifactDir to
 * normalize `.`/`..` segments and block symlink escapes that would
 * otherwise traverse outside the allowed directory.
 *
 * @param {string} artifactDir - Absolute or relative path to allowed write dir
 * @returns {Function|null} PreToolUse hook callback, or null if no artifactDir
 */
function createArtifactPathGuard(artifactDir) {
  if (!artifactDir) return null;

  // Normalize once at creation time — resolve relative to CWD, strip ../
  const allowedRoot = path.resolve(artifactDir);

  return async (input) => {
    if (input.tool_name !== "Write") return undefined;

    const filePath =
      input.tool_input?.file_path || input.tool_input?.path || "";
    if (!filePath) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "[vela-pipeline] Write blocked: missing file_path",
        },
      };
    }

    // Resolve the incoming path against CWD if relative, normalize segments
    const resolved = path.resolve(CWD, filePath);

    // Must be inside allowedRoot — use path separator to avoid prefix collisions
    // (e.g. /tmp/art vs /tmp/art-backup)
    const withSep = allowedRoot.endsWith(path.sep)
      ? allowedRoot
      : allowedRoot + path.sep;

    if (resolved !== allowedRoot && !resolved.startsWith(withSep)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `[vela-pipeline] Write outside artifactDir blocked: ${filePath} (allowed: ${allowedRoot})`,
        },
      };
    }

    return undefined;
  };
}

// ═══════════════════════════════════════════════════════════
//  Step Mode → SDK Options Mapping
// ═══════════════════════════════════════════════════════════

/**
 * Map a pipeline step's mode to SDK query options.
 *
 * Modes (from pipeline.json):
 *   read         — Read-only exploration (plan-check)
 *   write        — Write via Write/Edit tools, no Bash (plan)
 *   readwrite    — Full access (execute)
 *   rw-artifact  — Read-mode Bash policy + Write restricted to artifactDir
 *                  (research, verify — need to run tests AND create artifacts)
 *
 * All modes use bypassPermissions (D029) for non-interactive execution.
 *
 * @param {string} mode - 'read', 'write', 'readwrite', or 'rw-artifact'
 * @param {string|null} artifactDir - Allowed Write dir for rw-artifact mode
 * @returns {Object} SDK query options fragment { tools, disallowedTools, hooks }
 */
function buildModeOptions(mode, artifactDir = null) {
  const sensitiveGuard = createSensitiveFileGuard();
  const secretGuard = createSecretGuard();
  const branchGuard = createProtectedBranchGuard();
  // rw-artifact reuses read-mode Bash policy (read_only)
  const bashGuard = createBashGuard(mode === "rw-artifact" ? "read" : mode);
  const artifactGuard =
    mode === "rw-artifact" ? createArtifactPathGuard(artifactDir) : null;

  // Build PreToolUse hooks array
  const preToolUseHooks = [
    { hooks: [sensitiveGuard] }, // Always active: sensitive file guard
    { hooks: [branchGuard] }, // Always active: protected branch guard
  ];

  if (bashGuard) {
    preToolUseHooks.push({ matcher: "Bash", hooks: [bashGuard] });
  }

  if (artifactGuard) {
    preToolUseHooks.push({ matcher: "Write", hooks: [artifactGuard] });
  }

  const hooks = {
    PreToolUse: preToolUseHooks,
    PostToolUse: [{ hooks: [secretGuard] }],
  };

  switch (mode) {
    case "read":
      return {
        tools: ["Read", "Grep", "Glob", "Bash", "WebSearch"],
        disallowedTools: ["Write", "Edit", "NotebookEdit"],
        hooks,
      };

    case "write":
      return {
        tools: ["Read", "Grep", "Glob", "Write"],
        disallowedTools: ["Edit", "Bash", "NotebookEdit"],
        hooks,
      };

    case "readwrite":
      return {
        // No tools restriction — all available
        disallowedTools: [],
        hooks,
      };

    case "rw-artifact":
      // Read-mode Bash policy (test execution) + Write restricted to artifactDir.
      // Edit/NotebookEdit blocked — Write is the only mutation path, and it is
      // scoped to artifactDir by createArtifactPathGuard.
      return {
        tools: ["Read", "Grep", "Glob", "Bash", "WebSearch", "Write"],
        disallowedTools: ["Edit", "NotebookEdit"],
        hooks,
      };

    default:
      // Unknown mode — default to read-only
      return {
        tools: ["Read", "Grep", "Glob"],
        disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit"],
        hooks,
      };
  }
}

// ═══════════════════════════════════════════════════════════
//  System Prompt Loading
// ═══════════════════════════════════════════════════════════

/**
 * Load agent system prompt from the agents directory.
 * Falls back to a minimal prompt if the file doesn't exist.
 *
 * @param {string} actor - Agent role (e.g., 'researcher', 'planner', 'executor', 'reviewer')
 * @returns {string} System prompt content
 */
function loadAgentPrompt(actor) {
  // Map step actors to agent markdown files
  const actorMap = {
    researcher: "researcher.md",
    planner: "planner.md",
    executor: "executor.md",
    reviewer: "reviewer.md",
    pm: "vela-pm.md",
    agent: null, // Generic — no specific prompt
    user: null, // Human step — no agent prompt needed
  };

  const filename = actorMap[actor];
  if (!filename) return "";

  // Try project-local agents directory first, then scripts/agents
  const localPath = path.join(AGENTS_DIR, filename);
  const scriptsPath = path.join(CWD, "scripts", "agents", filename);

  let promptPath = null;
  if (fs.existsSync(localPath)) {
    promptPath = localPath;
  } else if (fs.existsSync(scriptsPath)) {
    promptPath = scriptsPath;
  }

  if (!promptPath) {
    return `You are a ${actor} agent. Follow the instructions in the prompt carefully.`;
  }

  try {
    return fs.readFileSync(promptPath, "utf-8");
  } catch (_e) {
    return `You are a ${actor} agent. Follow the instructions in the prompt carefully.`;
  }
}

// ═══════════════════════════════════════════════════════════
//  Project Mode Detection — M023/S02
// ═══════════════════════════════════════════════════════════

/**
 * Detect project mode based on codebase state.
 *
 * Modes:
 *   bootstrap   — Empty repo / no code to explore (fileCount === 0)
 *   exploratory — Existing codebase (fileCount > 0)
 *
 * fileCount is derived from `git ls-files` when cwd is a git repo,
 * otherwise from a 1-level recursive fs.readdirSync() that skips
 * node_modules/.git/.gsd/.vela. Errors fall back to 'exploratory'
 * (err on the side of more thorough methodology).
 *
 * @param {string} cwd - Working directory to inspect
 * @returns {'bootstrap'|'exploratory'} project mode
 */
function detectProjectMode(cwd) {
  let fileCount = 0;

  try {
    // Prefer git ls-files — respects .gitignore, cheap on large repos
    const gitDir = path.join(cwd, ".git");
    if (fs.existsSync(gitDir)) {
      try {
        const out = execFileSync("git", ["ls-files"], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        }).toString();
        fileCount = out.split("\n").filter((l) => l.trim().length > 0).length;
      } catch (_e) {
        // git ls-files failed — fall through to fs scan
        fileCount = scanDirRecursive(cwd);
      }
    } else if (fs.existsSync(cwd)) {
      fileCount = scanDirRecursive(cwd);
    } else {
      // cwd doesn't exist — treat as empty
      fileCount = 0;
    }
  } catch (_e) {
    // Unexpected error — fallback to exploratory (conservative)
    console.log(
      `[project-mode] detection error, fallback=exploratory`,
    );
    return "exploratory";
  }

  // Decision tree: bootstrap (empty) or exploratory (has code)
  const mode = fileCount === 0 ? "bootstrap" : "exploratory";

  console.log(`[project-mode] fileCount=${fileCount} → ${mode}`);
  return mode;
}

/**
 * Scan a directory recursively up to 1 extra depth (cwd + 1 subdir level),
 * excluding node_modules/.git/.gsd/.vela. Used as fs fallback when git is
 * unavailable.
 */
function scanDirRecursive(cwd) {
  const EXCLUDE = new Set([
    "node_modules",
    ".git",
    ".gsd",
    ".vela",
    ".bg-shell",
    ".artifacts",
  ]);
  let count = 0;
  let entries;
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch (_e) {
    return 0;
  }
  for (const entry of entries) {
    if (EXCLUDE.has(entry.name)) continue;
    if (entry.isFile()) {
      count += 1;
    } else if (entry.isDirectory()) {
      // 1-depth recursive scan
      let subEntries;
      try {
        subEntries = fs.readdirSync(path.join(cwd, entry.name), {
          withFileTypes: true,
        });
      } catch (_e) {
        continue;
      }
      for (const sub of subEntries) {
        if (EXCLUDE.has(sub.name)) continue;
        if (sub.isFile()) count += 1;
      }
    }
  }
  return count;
}

// ═══════════════════════════════════════════════════════════
//  Engine CLI Bridge
// ═══════════════════════════════════════════════════════════

/**
 * Execute a vela-engine.js command and return parsed JSON result.
 *
// ═══════════════════════════════════════════════════════════
//  Orchestrator Lock — prevents duplicate run/resume
// ═══════════════════════════════════════════════════════════

/**
 * Acquire the orchestrator lock. Writes PID to lock file.
 * If a lock already exists and the holding process is alive, rejects.
 * Stale locks (dead PID) are automatically cleaned up.
 */
function acquireLock() {
  const stateDir = path.dirname(LOCK_PATH);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  if (fs.existsSync(LOCK_PATH)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      // Check if holding process is still alive
      try {
        process.kill(lockData.pid, 0); // signal 0 = check existence
        // Process is alive — reject
        console.error("❌ 오케스트레이터가 이미 실행 중입니다.");
        console.error(`   PID: ${lockData.pid} | 시작: ${lockData.started_at}`);
        console.error("   중복 실행은 파이프라인 상태를 꼬이게 합니다.");
        console.error("   기다리거나, 기존 프로세스가 완료된 후 다시 시도하십시오.");
        process.exit(1);
      } catch (_e) {
        // Process is dead — stale lock, clean up
        fs.unlinkSync(LOCK_PATH);
      }
    } catch (_e) {
      // Corrupt lock file — clean up
      try { fs.unlinkSync(LOCK_PATH); } catch (_e2) {}
    }
  }

  // Write lock
  fs.writeFileSync(LOCK_PATH, JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
  }));
}

/**
 * Release the orchestrator lock.
 */
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      // Only release our own lock
      if (lockData.pid === process.pid) {
        fs.unlinkSync(LOCK_PATH);
      }
    }
  } catch (_e) { /* best-effort cleanup */ }
}

/**
 * @param {string[]} engineArgs - Arguments for vela-engine.js
 * @returns {Object} Parsed JSON output from the engine
 */
function engine(engineArgs) {
  try {
    const result = execFileSync("node", [ENGINE_PATH, ...engineArgs], {
      cwd: CWD,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      env: { ...process.env },
    });
    return JSON.parse(result.toString());
  } catch (err) {
    // Engine might output JSON even on non-zero exit
    const stdout = err.stdout ? err.stdout.toString() : "";
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch (_e) {}
    }
    return { ok: false, error: err.message || "Engine command failed" };
  }
}

// ═══════════════════════════════════════════════════════════
//  Step Runner
// ═══════════════════════════════════════════════════════════

/**
 * Model selection per actor/step role.
 * Maps step characteristics to appropriate models.
 */
const MODEL_MAP = {
  researcher: MODEL_VERSIONS.SONNET, // Sonnet for research analysis
  planner: MODEL_VERSIONS.SONNET, // Sonnet for planning
  executor: MODEL_VERSIONS.SONNET, // Sonnet for implementation
  reviewer: MODEL_VERSIONS.SONNET, // Sonnet for initial review
};

const EFFORT_MAP = {
  researcher: "low",
  planner: "high",
  executor: "high",
  reviewer: "high",
};

/**
 * Thinking budget per actor — extended thinking tokens for analysis-heavy steps.
 * null means thinking disabled (default SDK behavior).
 */
const THINKING_MAP = {
  researcher: { type: "enabled", budget_tokens: 8000 },
  planner: { type: "enabled", budget_tokens: 10000 },
  executor: null,
  reviewer: null,
};

/**
 * Read recent learning patterns from .vela/learnings/learnings.json.
 * Returns formatted markdown block or empty string.
 *
 * @param {string} cwd - Working directory
 * @param {number} [maxEntries=3] - Maximum learning items to include
 * @returns {string}
 */
function buildLearningsBlock(cwd, maxEntries = 3) {
  try {
    const learningsPath = path.join(cwd, ".vela", "learnings", "learnings.json");
    if (!fs.existsSync(learningsPath)) return "";

    const raw = JSON.parse(fs.readFileSync(learningsPath, "utf-8"));
    if (!raw || !Array.isArray(raw.learnings) || raw.learnings.length === 0) return "";

    const items = raw.learnings
      .slice(-3)
      .reverse()
      .flatMap((entry) => {
        if (!entry || !Array.isArray(entry.patterns)) return [];
        return entry.patterns
          .filter((p) => p && (p.category === "weakness" || p.category === "recurring_issue" || p.category === "improvement"))
          .slice(0, 2)
          .map((p) => `- [${p.category}] ${p.description}${p.frequency !== "first_time" ? ` (${p.frequency})` : ""}`);
      })
      .slice(0, maxEntries);

    if (items.length === 0) return "";

    return ["## 이전 파이프라인 학습 (반드시 반영하라)", ...items, ""].join("\n");
  } catch {
    return "";
  }
}

/**
 * Build the user prompt for a specific pipeline step.
 *
 * @param {Object} stepDef - Step definition from pipeline.json
 * @param {Object} state - Current pipeline state
 * @param {string} artifactDir - Path to artifact directory
 * @returns {string} User prompt for the SDK agent
 */
function buildStepPrompt(stepDef, state, artifactDir, reviewFeedback) {
  const request = state.request;
  const stepId = stepDef.id;

  // ─── Project environment block ───────────────────────────
  // Inject environment fingerprint for analysis-heavy steps so agents
  // know the language, test runner, and linter without exploring first.
  let envBlock = "";
  if (["research", "plan", "execute", "verify"].includes(stepId)) {
    try {
      const env = detectProjectEnvironment(CWD);
      if (env && env.language !== "unknown") {
        envBlock = "\n" + formatEnvBlock(env) + "\n";
      }
    } catch { /* silent */ }
  }

  // ─── Learnings block ──────────────────────────────────────
  // Inject recent pipeline learnings so agents avoid known pitfalls.
  let learningsBlock = "";
  if (["plan", "execute"].includes(stepId)) {
    learningsBlock = buildLearningsBlock(CWD);
    if (learningsBlock) learningsBlock = "\n" + learningsBlock;
  }

  // Review feedback injection — when re-executing after a review rejection,
  // prepend the reviewer's feedback so the agent knows what to fix.
  let feedbackBlock = "";
  if (reviewFeedback) {
    feedbackBlock = [
      "",
      `## ⚠️ 이전 리뷰 피드백 (반드시 반영하라)`,
      `이전 제출이 리뷰어에 의해 reject 되었다. 아래 피드백을 읽고 지적 사항을 모두 수정하라.`,
      "",
      reviewFeedback,
      "",
      `---`,
      "",
    ].join("\n");
  }

  // Sub-phase context injection — if step defines sub_phases, query engine for current phase
  let subPhaseBlock = "";
  if (stepDef.sub_phases && stepDef.sub_phases.length > 0) {
    try {
      const status = engine(["status"]);
      const subInfo = status.sub_phase;
      if (subInfo && subInfo.current_phase) {
        subPhaseBlock = [
          "",
          `## 현재 서브 단계`,
          `Current sub-phase: ${subInfo.current_phase}`,
          `Phases: ${subInfo.phases.join(" → ")}`,
          `Progress: ${subInfo.current_index + 1}/${subInfo.phases.length}`,
          "",
        ].join("\n");
      }
    } catch {
      /* engine status unavailable — skip sub-phase injection */
    }
  }

  let basePrompt;

  switch (stepId) {
    case "research": {
      const mode = state.project_mode || "exploratory";
      const modeDescriptions = {
        bootstrap:
          "신규 프로젝트, 탐색할 기존 코드 없음 — 기술 스택 선택과 근거 기록에 집중한다.",
        targeted:
          "기존 코드베이스, 변경 범위 좁음 — 작업 관련 파일/함수만 파악하고 가설은 필요할 때만 1~2개.",
        exploratory:
          "기존 코드베이스 — 작업 요청의 범위에 비례하여 분석한다. 특정 파일/클래스 정리 요청이면 해당 파일과 직접 의존성만 분석한다. 전체 아키텍처 변경이나 원인 불명 버그일 때만 경쟁가설 디버깅 절차(3~5 가설)를 적용한다.",
      };
      const modeDesc = modeDescriptions[mode] || modeDescriptions.exploratory;
      basePrompt = [
        `## 작업 요청\n${request}`,
        envBlock,
        `## 프로젝트 모드`,
        mode,
        "",
        modeDesc,
        "",
        `## 지시사항`,
        `프로젝트를 분석하여 research.md를 작성하라.`,
        `- 프로젝트 구조, 기술 스택, 아키텍처를 파악한다`,
        `- 작업 요청과 관련된 코드를 집중 분석한다`,
        `- project_mode에 따라 적절한 방법론을 선택한다 (bootstrap/targeted/exploratory)`,
        `- 분석 결과를 research.md에 작성한다`,
        "",
        `## 출력`,
        `${artifactDir}/research.md 파일을 작성하라.`,
      ].join("\n");
      break;
    }

    case "plan":
      basePrompt = [
        `## 작업 요청\n${request}`,
        envBlock,
        learningsBlock,
        `## 선행 분석`,
        `${artifactDir}/research.md를 먼저 읽어라.`,
        "",
        `## 지시사항`,
        `research.md를 기반으로 구체적 구현 계획(plan.md)을 작성하라.`,
        `plan.md에는 반드시 다음 섹션을 포함한다:`,
        `- ## Architecture — 레이어 구조, 의존성 방향, 모듈 분리 설계 (200자 이상)`,
        `- ## Class Specification — 인터페이스, 메서드 시그니처, 타입 (200자 이상)`,
        `- ## Test Strategy — 테스트 계획, 테스트 케이스 (200자 이상)`,
        "",
        `## 출력`,
        `${artifactDir}/plan.md 파일을 작성하라.`,
      ].join("\n");
      break;

    case "execute":
      basePrompt = [
        `## 작업 요청\n${request}`,
        envBlock,
        learningsBlock,
        `## 구현 계획`,
        `${artifactDir}/plan.md를 먼저 읽어라.`,
        subPhaseBlock,
        `## 지시사항`,
        `plan.md의 Class Specification에 따라 코드를 구현하라.`,
        `TDD 순서(test → implement → refactor)를 따른다.`,
        `구현 완료 후 ${artifactDir}/task-summary.md를 작성하라.`,
        "",
        `## 출력`,
        `- 소스 코드 구현`,
        `- ${artifactDir}/task-summary.md`,
      ].join("\n");
      break;

    case "verify":
      basePrompt = [
        `## 작업 요청\n${request}`,
        "",
        `## 지시사항`,
        `구현된 코드를 검증하라.`,
        `- 테스트 실행 (npm test, pytest 등)`,
        `- 린트/타입 체크`,
        `- 결과를 ${artifactDir}/verification.md에 작성`,
        "",
        `## 출력`,
        `${artifactDir}/verification.md 파일을 작성하라.`,
      ].join("\n");
      break;

    default:
      basePrompt = `## 작업 요청\n${request}\n\n현재 단계: ${stepDef.name}. 지시에 따라 작업하라.`;
  }

  // Prepend review feedback when re-executing after rejection
  return feedbackBlock ? feedbackBlock + basePrompt : basePrompt;
}

/**
 * Execute a single pipeline step using SDK query().
 *
 * @param {Object} stepDef - Step definition from pipeline.json
 * @param {Object} state - Current pipeline state
 * @param {string} [reviewFeedback] - Previous review feedback to inject into the prompt (for retry after rejection)
 * @returns {Promise<Object>} Step result { ok, stepId, result?, error?, cost? }
 */
async function runStep(stepDef, state, reviewFeedback) {
  const artifactDir = state._artifactDir;
  const mode = stepDef.mode || "read";
  const workerRole =
    (stepDef.team && stepDef.team.worker_role) || stepDef.actor || "agent";

  // Determine the actor for prompt loading
  const actor = workerRole === "agent" ? stepDef.actor : workerRole;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Step: ${stepDef.name} (${stepDef.id})`);
  console.log(`  Mode: ${mode} | Actor: ${actor}`);
  if (reviewFeedback) {
    console.log(`  📋 Review feedback injected (${reviewFeedback.length} chars)`);
  }
  console.log(`${"─".repeat(60)}\n`);

  // Build SDK options from mode. artifactDir is passed so rw-artifact mode
  // can scope Write tool calls to the pipeline's artifact directory.
  const modeOptions = buildModeOptions(mode, artifactDir);

  // Load system prompt
  const systemPrompt = loadAgentPrompt(actor);

  // Build user prompt — includes review feedback when retrying after rejection
  const userPrompt = buildStepPrompt(stepDef, state, artifactDir, reviewFeedback);

  // Select model, effort, and thinking budget
  const model = MODEL_MAP[actor] || MODEL_VERSIONS.SONNET;
  const thinking = THINKING_MAP[actor] || null;
  // Track used tools for observability
  const usedTools = [];
  const deniedTools = [];

  // Add tool tracking PostToolUse hook
  const trackingHook = async (input) => {
    usedTools.push(input.tool_name);

    // ─── TreeNode path collection ───
    // Collect file paths from Read/Glob/Grep results for cache
    try {
      const toolName = input.tool_name;
      if (toolName === "Read") {
        const filePath = input.tool_input?.path;
        if (filePath) {
          const abs = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(CWD, filePath);
          appendPaths([abs]);
        }
      } else if (toolName === "Glob" || toolName === "Grep") {
        // Glob/Grep results contain file paths in tool_output
        const output = input.tool_output || "";
        const paths = output
          .split("\n")
          .map((line) => line.replace(/:.*$/, "").trim())
          .filter((p) => p && !p.startsWith("{") && fs.existsSync(p))
          .map((p) => (path.isAbsolute(p) ? p : path.resolve(CWD, p)));
        if (paths.length > 0) appendPaths([...new Set(paths)]);
      }
    } catch (e) {
      // Silent — cache is non-critical
    }

    return { continue: true };
  };

  // Merge tracking hook with mode hooks
  const hooks = { ...modeOptions.hooks };
  if (hooks.PostToolUse) {
    hooks.PostToolUse = [...hooks.PostToolUse, { hooks: [trackingHook] }];
  } else {
    hooks.PostToolUse = [{ hooks: [trackingHook] }];
  }

  // Track denied tools via PreToolUse wrapper
  const originalPreToolUse = hooks.PreToolUse || [];
  const denyTracker = async (input) => {
    // This runs first to track, but doesn't decide — real guards decide
    return undefined;
  };
  // We track denials by wrapping existing hooks
  const wrappedPreToolUse = originalPreToolUse.map((hookEntry) => {
    const originalHooks = hookEntry.hooks || [];
    return {
      ...hookEntry,
      hooks: originalHooks.map((hookFn) => {
        return async (...args) => {
          const result = await hookFn(...args);
          if (
            result &&
            result.hookSpecificOutput &&
            result.hookSpecificOutput.permissionDecision === "deny"
          ) {
            deniedTools.push({
              tool: args[0]?.tool_name,
              reason: result.hookSpecificOutput.permissionDecisionReason,
            });
          }
          return result;
        };
      }),
    };
  });
  hooks.PreToolUse = wrappedPreToolUse;

  // Execute SDK query
  const startMs = Date.now();

  const sdkOpts = {
    prompt: userPrompt,
    model,
    cwd: CWD,
    systemPrompt,
    allowedTools: modeOptions.tools,
    disallowedTools: modeOptions.disallowedTools,
    hooks,
    effort: EFFORT_MAP[actor] || "medium",
  };

  // Extended thinking for analysis-heavy steps (research, plan)
  if (thinking) {
    sdkOpts.thinking = thinking;
  }

  const sdkResult = await runSdkAgent(sdkOpts);

  const durationMs = Date.now() - startMs;

  // Log result summary
  console.log(`\n  Result: ${sdkResult.ok ? "✅ SUCCESS" : "❌ FAILED"}`);
  console.log(`  Cost: $${(sdkResult.cost || 0).toFixed(4)}`);
  console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
  if (sdkResult.numTurns != null) {
    console.log(`  Turns used: ${sdkResult.numTurns}`);
  }
  console.log(`  Tools used: [${[...new Set(usedTools)].join(", ")}]`);
  if (deniedTools.length > 0) {
    // Persist denied tools detail to artifactDir for post-mortem inspection.
    // K042: non-fatal — file write failure must not abort the pipeline.
    let deniedDetailPath = null;
    try {
      const denialsPath = path.join(artifactDir, "denied-tools.json");
      fs.writeFileSync(
        denialsPath,
        JSON.stringify({ step: stepDef.id, denials: deniedTools }, null, 2) +
          "\n",
      );
      deniedDetailPath = denialsPath;
    } catch (err) {
      console.warn(`  ⚠ denied tools persistence skipped: ${err.message}`);
    }
    const detailSuffix = deniedDetailPath
      ? ` (details: ${deniedDetailPath})`
      : "";
    console.log(
      `  Tools denied: ${deniedTools.length} denial(s)${detailSuffix}`,
    );
  }

  return {
    ok: sdkResult.ok,
    stepId: stepDef.id,
    result: sdkResult.result,
    error: sdkResult.error,
    cost: sdkResult.cost || 0,
    durationMs,
    toolsUsed: [...new Set(usedTools)],
    toolsDenied: deniedTools,
    numTurns: sdkResult.numTurns,
  };
}

// ═══════════════════════════════════════════════════════════
//  Exit Gate Checker
// ═══════════════════════════════════════════════════════════

/**
 * Check if a step's exit gate is met.
 * Delegates to vela-engine.js transition which internally checks gates.
 * Returns { passed, missing } for local pre-check.
 *
 * @param {Object} stepDef - Step definition from pipeline.json
 * @param {string} artifactDir - Path to artifact directory
 * @returns {Object} { passed: boolean, missing: string[] }
 */
function checkLocalGate(stepDef, artifactDir) {
  if (!stepDef.exit_gate || stepDef.exit_gate.length === 0) {
    return { passed: true, missing: [] };
  }

  const missing = [];
  for (const gate of stepDef.exit_gate) {
    switch (gate) {
      case "research_md_exists":
        if (!fs.existsSync(path.join(artifactDir, "research.md")))
          missing.push(gate);
        break;
      case "plan_md_exists":
        if (!fs.existsSync(path.join(artifactDir, "plan.md")))
          missing.push(gate);
        break;
      case "plan_check_pass":
        if (!fs.existsSync(path.join(artifactDir, "plan-check.md")))
          missing.push(gate);
        break;
      case "implementation_complete":
        if (!fs.existsSync(path.join(artifactDir, "task-summary.md")))
          missing.push(gate);
        break;
      case "verification_md_exists":
        if (
          !fs.existsSync(path.join(artifactDir, "verification.md")) &&
          !fs.existsSync(path.join(artifactDir, "verify.md"))
        ) {
          missing.push(gate);
        }
        break;
      case "diff_summary_exists":
        if (!fs.existsSync(path.join(artifactDir, "diff-summary.md")))
          missing.push(gate);
        break;
      case "learning_md_exists":
        if (!fs.existsSync(path.join(artifactDir, "learning.md")))
          missing.push(gate);
        break;
      case "report_md_exists":
        if (!fs.existsSync(path.join(artifactDir, "report.md")))
          missing.push(gate);
        break;
      // Gates handled by engine (approval, git, hmac) — skip local check
      case "ref_integrity": {
        // Change Surface Analysis — verify no broken cross-file references
        // Read baseline_sha from pipeline-state.json
        const statePath = path.join(artifactDir, "pipeline-state.json");
        let baselineSha = null;
        if (fs.existsSync(statePath)) {
          try {
            const pState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
            baselineSha =
              pState.baseline_sha || (pState.git && pState.git.checkpoint_hash);
          } catch {
            /* ignore parse errors */
          }
        }
        if (!baselineSha) {
          // Legacy pipeline without baseline — skip gracefully
          break;
        }
        try {
          const configPath = path.join(TEMPLATES_DIR, "config.json");
          let csaOpts = {};
          if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            if (cfg.changeSurface) {
              if (cfg.changeSurface.enabled === false) break;
              if (cfg.changeSurface.excludePaths) {
                csaOpts.excludePaths = cfg.changeSurface.excludePaths;
              }
            }
          }
          const { analyze } = require("../shared/change-surface.js");
          const result = analyze(baselineSha, { cwd: CWD, ...csaOpts });
          if (!result.verdict.pass) {
            missing.push(
              `ref_integrity_fail:${result.verdict.errorCount} broken ref(s)`,
            );
          }
        } catch (e) {
          // CSA module error — don't block pipeline, warn only
          console.error(`[ref_integrity] Warning: ${e.message}`);
        }
        break;
      }
      default:
        break;
    }
  }

  return { passed: missing.length === 0, missing };
}

// ═══════════════════════════════════════════════════════════
//  Review Step — SDK Review with Retry
// ═══════════════════════════════════════════════════════════

/**
 * Run SDK review for a step and handle approve/reject loop.
 *
 * @param {Object} stepDef - Step definition requiring review
 * @param {Object} state - Current pipeline state
 * @param {number} maxRevisions - Maximum review iterations
 * @returns {Promise<Object>} Review result
 */
async function runReviewLoop(stepDef, state, maxRevisions) {
  const artifactDir = state._artifactDir;
  const { sdkReview } = require("../shared/sdk-reviewer.js");
  let lastReviewScore = null;

  for (let attempt = 1; attempt <= maxRevisions; attempt++) {
    console.log(`\n  📝 Review attempt ${attempt}/${maxRevisions}...`);

    const reviewResult = await sdkReview({
      step: stepDef.id,
      artifactDir,
      cwd: CWD,
    });

    if (!reviewResult.ok) {
      console.log(`  ❌ Review error: ${reviewResult.error}`);
      if (attempt >= maxRevisions) {
        return {
          ok: false,
          error: "review_failed",
          details: reviewResult.error,
          attempts: attempt,
        };
      }
      continue;
    }

    console.log(
      `  📊 Review score: ${reviewResult.score}/25 (${reviewResult.decision})`,
    );
    lastReviewScore = reviewResult.score;

    if (reviewResult.decision === "approve") {
      // sdkReview() already writes approval-{step}.json with richer data
      // (score, threshold, stage, model) — no duplicate write needed
      console.log(`  ✅ Approved (score: ${reviewResult.score}/25)`);

      return {
        ok: true,
        decision: "approve",
        score: reviewResult.score,
        attempts: attempt,
      };
    }

    // Rejected — record and potentially retry the step
    console.log(`  ⚠️ Rejected (score: ${reviewResult.score}/25)`);
    engine([
      "record",
      "reject",
      "--summary",
      `Review rejected: ${reviewResult.score}/25`,
    ]);

    if (attempt >= maxRevisions) {
      return {
        ok: false,
        decision: "reject",
        score: reviewResult.score,
        attempts: attempt,
      };
    }

    // Re-run the execution step with review feedback injected into the prompt.
    // Read review-{step}.md artifact written by the reviewer — contains the
    // detailed critique. Fall back to a score-only summary if the file is missing.
    let feedback = "";
    try {
      const reviewPath = path.join(artifactDir, `review-${stepDef.id}.md`);
      if (fs.existsSync(reviewPath)) {
        feedback = fs.readFileSync(reviewPath, "utf8").trim();
      }
    } catch { /* non-critical — proceed without feedback file */ }
    if (!feedback && reviewResult.result) {
      feedback = reviewResult.result;
    }
    if (!feedback) {
      feedback = `리뷰 점수 ${reviewResult.score}/25 — 기준 미달로 reject됨. 품질을 높여 다시 작성하라.`;
    }

    console.log(`  🔄 Re-executing step with review feedback...`);
    const rerunResult = await runStep(stepDef, state, feedback);
    if (!rerunResult.ok) {
      return {
        ok: false,
        error: "re-execution_failed",
        details: rerunResult.error,
        attempts: attempt,
      };
    }
  }

  return {
    ok: false,
    error: "max_revisions_reached",
    decision: "escalate_to_pm",
    score: lastReviewScore,
    attempts: maxRevisions,
    step: stepDef.id,
  };
}

// ═══════════════════════════════════════════════════════════
//  Verify Retry Loop — execute→code-review→verify cycle
// ═══════════════════════════════════════════════════════════

/**
 * Retry loop for verify failures: re-execute with verification feedback,
 * then code-review, then re-verify. Repeats up to maxRevisions times.
 *
 * When verify fails, reads verification.md for failure details, re-runs
 * execute with that feedback injected, runs code-review via runReviewLoop
 * if the execute step has a reviewer, then re-runs verify.
 *
 * @param {Array} steps - Full step definitions array (to find execute/verify dynamically)
 * @param {Object} state - Current pipeline state
 * @param {number} maxRevisions - Maximum retry iterations
 * @returns {Promise<Object>} { ok, attempts, cost, decision? }
 */
async function runVerifyRetryLoop(steps, state, maxRevisions) {
  const artifactDir = state._artifactDir;

  // Dynamically find execute and verify step definitions — no hardcoding
  const executeDef = steps.find((s) => s.id === "execute");
  const verifyDef = steps.find((s) => s.id === "verify");

  if (!executeDef || !verifyDef) {
    return { ok: false, error: "missing_step_defs", attempts: 0, cost: 0 };
  }

  let totalCost = 0;

  for (let attempt = 1; attempt <= maxRevisions; attempt++) {
    console.log(`\n  🔄 Verify retry attempt ${attempt}/${maxRevisions}`);

    // (a) Read verification failure content for feedback
    let verifyFeedback = "";
    try {
      const verifyPath = path.join(artifactDir, "verification.md");
      if (fs.existsSync(verifyPath)) {
        verifyFeedback = fs.readFileSync(verifyPath, "utf8").trim();
      }
    } catch {
      /* non-critical — proceed without feedback file */
    }

    if (!verifyFeedback) {
      verifyFeedback =
        "Verification 실패. 코드를 검토하고 테스트를 통과하도록 수정하라.";
    }

    // (b) Re-execute with verification feedback
    console.log(
      `  📋 Re-executing with verification feedback (${verifyFeedback.length} chars)`,
    );
    const executeResult = await runStep(executeDef, state, verifyFeedback);
    totalCost += executeResult.cost || 0;

    if (!executeResult.ok) {
      console.log(`  ❌ Re-execution failed: ${executeResult.error}`);
      continue; // Try next attempt
    }

    // (c) Run code-review via runReviewLoop if execute step has a reviewer
    if (executeDef.team && executeDef.team.reviewer_role) {
      const reviewMaxRev = executeDef.max_revisions || 3;
      console.log("  📝 Running code-review after re-execution...");
      const reviewResult = await runReviewLoop(executeDef, state, reviewMaxRev);
      totalCost += reviewResult.cost || 0;

      if (!reviewResult.ok) {
        console.log(
          `  ⚠️ Code-review failed in verify retry: ${reviewResult.error || reviewResult.decision}`,
        );
        continue; // Try next verify retry attempt
      }
    }

    // (d) Re-verify
    console.log("  🔍 Re-running verification...");
    const verifyResult = await runStep(verifyDef, state);
    totalCost += verifyResult.cost || 0;

    if (verifyResult.ok) {
      console.log(`  ✅ Verification passed on retry attempt ${attempt}`);
      return { ok: true, attempts: attempt, cost: totalCost };
    }

    console.log(`  ❌ Verification still failing on attempt ${attempt}`);
  }

  // Max revisions exceeded
  console.log(`\n  🚨 Verify retry exhausted (${maxRevisions} attempts)`);
  return {
    ok: false,
    decision: "escalate_to_pm",
    attempts: maxRevisions,
    cost: totalCost,
  };
}

// ═══════════════════════════════════════════════════════════
//  Master Pipeline Loop
// ═══════════════════════════════════════════════════════════

/**
 * Run the full pipeline from init to completion.
 *
 * @param {string} request - User's task description
 * @param {string} type - Pipeline type (code/code-bug/code-refactor/docs)
 * @returns {Promise<void>}
 */
async function runPipeline(request, type) {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Vela Pipeline Orchestrator");
  console.log(`  Request: ${request}`);
  console.log(`  Type: ${type}`);
  console.log("═══════════════════════════════════════════════════");

  // Step 1: Initialize pipeline via engine
  const engineArgs = [
    "init",
    request,
    "--type",
    type,
    "--auto",
  ];
  if (hasFlag("--force")) engineArgs.push("--force");
  const initResult = engine(engineArgs);

  if (!initResult.ok) {
    console.error(`❌ Init failed: ${initResult.error}`);
    if (initResult.hint) console.error(`   Hint: ${initResult.hint}`);
    process.exit(1);
  }

  console.log(`\n✅ Pipeline initialized: ${initResult.pipeline_type}`);
  console.log(`   Steps: ${initResult.steps.map((s) => s.id).join(" → ")}`);
  console.log(`   Artifact dir: ${initResult.artifact_dir}\n`);

  // Inject project_mode into pipeline-state.json for downstream steps (M023/S02)
  try {
    const projectMode = detectProjectMode(CWD);
    const statePath = path.join(initResult.artifact_dir, "pipeline-state.json");
    if (fs.existsSync(statePath)) {
      const stateData = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      stateData.project_mode = projectMode;
      stateData.updated_at = new Date().toISOString();
      fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2));
    }
  } catch (e) {
    // Non-fatal: project_mode injection is an enhancement, not a hard requirement
    console.log(`[project-mode] injection skipped: ${e.message}`);
  }

  // Load pipeline definition for step details
  const pipelineDef = loadPipelineDefinition();
  if (!pipelineDef) {
    console.error("❌ Pipeline definition not found.");
    process.exit(1);
  }

  const steps = resolveSteps(pipelineDef, initResult.pipeline_type);

  // Track total cost
  let totalCost = 0;
  const stepResults = [];

  await executeStepLoop(steps, stepResults, totalCost);
}

/**
 * Execute pipeline steps sequentially, skipping completed ones.
 * Shared by runPipeline (new pipeline) and cmdResume (existing pipeline).
 *
 * @param {Array} steps - Resolved step definitions
 * @param {Array} stepResults - Accumulator for step results (mutated in-place)
 * @param {number} totalCost - Running cost total
 */
async function executeStepLoop(steps, stepResults, totalCost) {
  // Acquire lock — prevents duplicate run/resume from colliding
  acquireLock();

  // Ensure lock is released on exit (normal, error, or signal)
  const cleanup = () => releaseLock();
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
  for (let i = 0; i < steps.length; i++) {
    const stepDef = steps[i];

    // Refresh state before each step
    const state = getActiveState();
    if (!state) {
      console.error("❌ Pipeline state lost during execution.");
      process.exit(1);
    }

    // Skip steps that are already completed
    if (state.completed_steps && state.completed_steps.includes(stepDef.id)) {
      console.log(`\n⏭️  Skipping completed step: ${stepDef.name}`);
      continue;
    }

    // Skip steps not matching current state
    if (state.current_step !== stepDef.id) {
      continue;
    }

    // Handle human/PM steps — auto-advance
    if (stepDef.actor === "user" || stepDef.actor === "pm") {
      console.log(`\n⏩ Auto-advancing PM/user step: ${stepDef.name}`);

      // For init step, already done above
      if (stepDef.id === "init") {
        engine([
          "record",
          "pass",
          "--summary",
          "Init completed by orchestrator",
        ]);
        const transResult = engine(["transition"]);
        if (!transResult.ok) {
          console.error(
            `❌ Transition failed after init: ${transResult.error}`,
          );
          process.exit(1);
        }
        continue;
      }

      // Branch step — auto create
      if (stepDef.id === "branch") {
        const branchResult = engine(["branch", "--mode", "auto"]);
        console.log(`   Branch: ${branchResult.branch || "skipped"}`);
        engine([
          "record",
          "pass",
          "--summary",
          `Branch: ${branchResult.branch || "skipped"}`,
        ]);
        const transResult = engine(["transition"]);
        if (!transResult.ok && !transResult.completed) {
          console.error(
            `❌ Transition failed after branch: ${transResult.error}`,
          );
          // Non-fatal — gate might not require branch
        }
        continue;
      }

      // Checkpoint — auto-approve in auto mode
      if (stepDef.id === "checkpoint") {
        engine(["record", "pass", "--summary", "Auto-approved checkpoint"]);
        const transResult = engine(["transition"]);
        if (!transResult.ok) {
          console.error(
            `❌ Transition failed at checkpoint: ${transResult.error}`,
          );
          process.exit(1);
        }
        continue;
      }

      // Commit step
      if (stepDef.id === "commit") {
        const commitResult = engine(["commit"]);
        console.log(
          `   Commit: ${commitResult.hash || commitResult.action || "done"}`,
        );
        engine([
          "record",
          "pass",
          "--summary",
          `Committed: ${commitResult.hash || "no changes"}`,
        ]);
        const transResult = engine(["transition"]);
        if (transResult.ok || transResult.completed) continue;
        // Non-fatal if gate fails
        continue;
      }

      // Finalize step
      if (stepDef.id === "finalize") {
        // Generate report
        const reportPath = path.join(state._artifactDir, "report.md");
        const reportContent = generateReport(state, stepResults);
        fs.writeFileSync(reportPath, reportContent);
        console.log(`   Report written: ${reportPath}`);
        engine(["record", "pass", "--summary", "Pipeline report generated"]);
        const transResult = engine(["transition"]);
        if (transResult.ok || transResult.completed) {
          console.log("\n✅ Pipeline completed successfully!");
        }
        continue;
      }

      // Generic PM step — record and advance
      engine(["record", "pass", "--summary", `Auto-advanced: ${stepDef.name}`]);
      engine(["transition"]);
      continue;
    }

    // ─── diff-summary / learning — dedicated SDK module calls (non-fatal) ───
    if (stepDef.id === "diff-summary" || stepDef.id === "learning") {
      const artifactDir = state._artifactDir;
      const pipelineSlug = state.pipeline_slug;
      const stepLabel = stepDef.id === "diff-summary" ? "Diff Summary" : "Learning";

      console.log(`\n${"─".repeat(60)}`);
      console.log(`  Step: ${stepLabel} (${stepDef.id})`);
      console.log(`  Mode: ${stepDef.mode} | Actor: ${stepDef.actor}`);
      console.log(`${"─".repeat(60)}\n`);

      try {
        const sdkFn = stepDef.id === "diff-summary" ? sdkDiffSummary : sdkLearning;
        const sdkResult = await sdkFn({ artifactDir, cwd: CWD, pipelineSlug });

        const stepCost = sdkResult.cost || 0;
        totalCost += stepCost;
        stepResults.push({
          step: stepDef.id,
          ok: sdkResult.ok,
          cost: stepCost,
          durationMs: sdkResult.durationMs || 0,
          numTurns: sdkResult.numTurns,
          error: sdkResult.error,
        });

        if (sdkResult.ok) {
          console.log(`  ✅ ${stepLabel} completed (cost: $${stepCost.toFixed(4)})`);
        } else {
          // Non-fatal — warn and continue
          console.warn(`  ⚠️ ${stepLabel} failed: ${sdkResult.error || "unknown"} — continuing (non-fatal)`);
        }
      } catch (err) {
        // Non-fatal — catch unexpected errors
        console.warn(`  ⚠️ ${stepLabel} error: ${err.message} — continuing (non-fatal)`);
        stepResults.push({
          step: stepDef.id,
          ok: false,
          cost: 0,
          durationMs: 0,
          error: err.message,
        });
      }

      // Always record pass and transition (non-fatal step)
      engine(["record", "pass", "--summary", `${stepLabel}: completed`]);
      const transResult = engine(["transition"]);
      if (transResult.completed) {
        console.log("\n✅ Pipeline completed successfully!");
        break;
      }
      continue;
    }

    // Agent steps — run SDK query
    try {
      const stepResult = await runStep(stepDef, state);
      stepResults.push({ step: stepDef.id, ...stepResult });
      totalCost += stepResult.cost;

      if (!stepResult.ok) {
        // Verify step failure → enter retry loop (execute→code-review→verify)
        if (stepDef.id === "verify") {
          const maxRev = stepDef.max_revisions || 3;
          console.log(`\n  🔄 Verify failed — entering retry loop (max ${maxRev} attempts)`);
          const retryResult = await runVerifyRetryLoop(steps, state, maxRev);
          totalCost += retryResult.cost || 0;

          if (retryResult.ok) {
            // Retry succeeded — record pass and advance
            engine(["record", "pass", "--summary", `Verify passed after ${retryResult.attempts} retry(s)`]);
            // Skip the review/gate/transition below — jump straight to transition
            const transResult = engine(["transition"]);
            if (transResult.completed) {
              console.log("\n✅ Pipeline completed successfully!");
              break;
            }
            continue;
          }

          // Retry exhausted — escalate_to_pm
          console.error(
            `\n🚨 Verify retry exhausted: escalate_to_pm (${retryResult.attempts} attempts)`,
          );
          engine([
            "record",
            "fail",
            "--summary",
            `Verify retry exhausted: escalate_to_pm (${retryResult.attempts} attempts)`,
          ]);
          break; // escalate_to_pm — graceful exit from step loop
        }

        // Generic step failure — record and continue
        console.error(
          `\n❌ Step "${stepDef.name}" failed: ${stepResult.error}`,
        );
        engine(["record", "fail", "--summary", `Failed: ${stepResult.error}`]);
        // Don't exit — try to continue or handle gracefully
        continue;
      }

      // Record success
      engine(["record", "pass", "--summary", `Completed: ${stepDef.name}`]);

      // Advance sub-phase tracking if step defines sub_phases
      if (stepDef.sub_phases && stepDef.sub_phases.length > 0) {
        try {
          engine(["sub-transition"]);
        } catch {
          /* sub-transition failure is non-fatal */
        }
      }

      // Check if step requires review
      if (stepDef.team && stepDef.team.reviewer_role) {
        const maxRev = stepDef.max_revisions || 3;
        const reviewResult = await runReviewLoop(stepDef, state, maxRev);
        if (reviewResult.cost) totalCost += reviewResult.cost;

        // escalate_to_pm — max_revisions exhausted, graceful exit
        if (reviewResult.decision === "escalate_to_pm") {
          const score = reviewResult.score != null ? reviewResult.score : "N/A";
          console.error(
            `\n🚨 Review exhausted for "${stepDef.name}": escalate_to_pm (score: ${score}/25, step: ${reviewResult.step || stepDef.id})`,
          );
          engine([
            "record",
            "fail",
            "--summary",
            `Review exhausted: escalate_to_pm (score: ${score}/25)`,
          ]);
          break; // escalate_to_pm — graceful exit from step loop
        }

        // General review failure — record and exit gracefully
        if (!reviewResult.ok) {
          const reason =
            reviewResult.error || reviewResult.decision || "unknown";
          console.error(`\n❌ Review failed for "${stepDef.name}": ${reason}`);
          engine(["record", "fail", "--summary", `Review failed: ${reason}`]);
          break; // review failure — graceful exit from step loop
        }
      }

      // Check local exit gate
      const gateCheck = checkLocalGate(stepDef, state._artifactDir);
      if (!gateCheck.passed) {
        console.log(
          `\n⚠️  Exit gate not met for "${stepDef.name}": ${gateCheck.missing.join(", ")}`,
        );
        // Try transition anyway — engine has more complete gate checking
      }

      // Advance to next step
      const transResult = engine(["transition"]);
      if (transResult.completed) {
        console.log("\n✅ Pipeline completed successfully!");
        break;
      }
      if (!transResult.ok) {
        console.log(
          `\n⚠️  Transition blocked: ${transResult.error || transResult.message}`,
        );
        if (transResult.missing) {
          console.log(`   Missing: ${transResult.missing.join(", ")}`);
        }
        // Don't exit — might be recoverable in next iteration
      }
    } catch (stepError) {
      console.error(
        `\n💥 Unexpected error in step "${stepDef.name}": ${stepError.message}`,
      );
      engine([
        "record",
        "fail",
        "--summary",
        `Unexpected error: ${stepError.message}`,
      ]);
      break;
    }
  }

  // Final summary
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Pipeline Summary");
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(
    `  Steps completed: ${stepResults.filter((r) => r.ok).length}/${stepResults.length}`,
  );
  console.log("═══════════════════════════════════════════════════");

  } finally {
    releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════
//  Report Generator
// ═══════════════════════════════════════════════════════════

/**
 * Generate a pipeline completion report.
 *
 * @param {Object} state - Final pipeline state
 * @param {Array} stepResults - Array of step results
 * @returns {string} Markdown report content
 */
function generateReport(state, stepResults) {
  const now = new Date().toISOString();
  const totalCost = stepResults.reduce((sum, r) => sum + (r.cost || 0), 0);

  let report = `# Pipeline Report\n\n`;
  report += `**Request:** ${state.request}\n`;
  report += `**Pipeline:** ${state.pipeline_type}\n`;
  report += `**Created:** ${state.created_at}\n`;
  report += `**Completed:** ${now}\n`;
  report += `**Total Cost:** $${totalCost.toFixed(4)}\n\n`;

  report += `## Step Results\n\n`;
  report += `| Step | Status | Cost | Duration | Turns | Tools Used | Denied |\n`;
  report += `|------|--------|------|----------|-------|------------|--------|\n`;

  for (const r of stepResults) {
    const status = r.ok ? "✅ Pass" : "❌ Fail";
    const cost = `$${(r.cost || 0).toFixed(4)}`;
    const duration = `${((r.durationMs || 0) / 1000).toFixed(1)}s`;
    const turns = r.numTurns != null ? String(r.numTurns) : "-";
    const tools = (r.toolsUsed || []).join(", ") || "-";
    const deniedCount = (r.toolsDenied || []).length;
    report += `| ${r.step} | ${status} | ${cost} | ${duration} | ${turns} | ${tools} | ${deniedCount} |\n`;
  }

  if (state.git) {
    report += `\n## Git\n\n`;
    report += `- Branch: ${state.git.pipeline_branch || state.git.current_branch || "-"}\n`;
    report += `- Commit: ${state.git.commit_hash || "-"}\n`;
  }

  return report;
}

// ═══════════════════════════════════════════════════════════
//  Helpers (duplicated from engine for independence)
// ═══════════════════════════════════════════════════════════

function loadPipelineDefinition() {
  const pipelinePath = path.join(TEMPLATES_DIR, "pipeline.json");
  if (!fs.existsSync(pipelinePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pipelinePath, "utf-8"));
  } catch (_e) {
    return null;
  }
}

function resolveSteps(pipelineDef, pipelineType) {
  if (!pipelineDef) return [];
  const pipeline = pipelineDef.pipelines[pipelineType || "standard"];
  if (!pipeline) return [];

  let steps = pipeline.steps;
  if (pipeline.inherits && pipeline.steps_only) {
    const parent = pipelineDef.pipelines[pipeline.inherits];
    if (parent) {
      steps = parent.steps.filter((s) => pipeline.steps_only.includes(s.id));
      if (pipeline.overrides) {
        steps = steps.map((s) =>
          pipeline.overrides[s.id] ? { ...s, ...pipeline.overrides[s.id] } : s,
        );
      }
    }
  }

  return steps;
}

/**
 * Get the active pipeline state (from engine CLI bridge).
 * Uses engine 'state' command for canonical state, reads full state from artifact_dir.
 */
function getActiveState() {
  const result = engine(["state"]);
  if (!result.ok || !result.active) return null;
  if (!result.artifact_dir) return null;

  const statePath = path.join(result.artifact_dir, "pipeline-state.json");
  if (!fs.existsSync(statePath)) return null;

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state._path = statePath;
    state._artifactDir = result.artifact_dir;
    return state;
  } catch (_e) {
    return null;
  }
}

function getFlag(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

// ═══════════════════════════════════════════════════════════
//  CLI Commands
// ═══════════════════════════════════════════════════════════

async function cmdRun() {
  // Find first non-flag argument after 'run' as the request
  const request = args.slice(1).find(a => !a.startsWith("--"));
  if (!request) {
    console.error(
      "Usage: vela-pipeline run <request> [--type <type>] [--force]",
    );
    process.exit(1);
  }

  const type = getFlag("--type") || "code";

  await runPipeline(request, type);
}

/**
 * Resume an existing active pipeline from where it left off.
 * Reads pipeline_type and request from active state — no init needed.
 */
async function cmdResume() {
  const state = getActiveState();
  if (!state) {
    console.error("❌ No active pipeline to resume.");
    console.error("   Use 'run' to start a new pipeline.");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("  Vela Pipeline Orchestrator — RESUME");
  console.log(`  Request: ${state.request}`);
  console.log(`  Type: ${state.pipeline_type}`);
  console.log(`  Current step: ${state.current_step}`);
  console.log(`  Completed: ${(state.completed_steps || []).join(", ") || "none"}`);
  console.log("═══════════════════════════════════════════════════");

  const pipelineDef = loadPipelineDefinition();
  if (!pipelineDef) {
    console.error("❌ Pipeline definition not found.");
    process.exit(1);
  }

  const steps = resolveSteps(pipelineDef, state.pipeline_type);

  let totalCost = 0;
  const stepResults = [];

  await executeStepLoop(steps, stepResults, totalCost);
}

function cmdStatus() {
  const result = engine(["state"]);
  output(result);
}

function cmdCancel() {
  const result = engine(["cancel"]);
  output(result);
}

function showHelp() {
  console.log(`
Vela Pipeline Orchestrator — SDK-based Pipeline Execution

Usage:
  node vela-pipeline.js run <request> [--type <type>]
  node vela-pipeline.js resume
  node vela-pipeline.js status
  node vela-pipeline.js cancel
  node vela-pipeline.js --help

Commands:
  run       Run the full pipeline for a task
  resume    Resume the active pipeline from where it left off
  status    Show current pipeline status
  cancel    Cancel the active pipeline

Options:
  --type    Task type: code, code-bug, code-refactor, docs (default: code)
  --help    Show this help message

Examples:
  node vela-pipeline.js run "Add user authentication"
  node vela-pipeline.js run "Fix typo in README" --type docs
  node vela-pipeline.js resume
  node vela-pipeline.js status
  node vela-pipeline.js cancel
`);
}

// ─── Main Entry Point ───

async function main() {
  if (hasFlag("--help") || hasFlag("-h") || !command) {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case "run":
      await cmdRun();
      break;
    case "resume":
      await cmdResume();
      break;
    case "status":
      cmdStatus();
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

// ─── Module Exports (for testing) ───
module.exports = {
  createBashGuard,
  createSensitiveFileGuard,
  createSecretGuard,
  createProtectedBranchGuard,
  createArtifactPathGuard,
  buildModeOptions,
  loadAgentPrompt,
  buildStepPrompt,
  checkLocalGate,
  runStep,
  runReviewLoop,
  runVerifyRetryLoop,
  generateReport,
  detectProjectMode,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
