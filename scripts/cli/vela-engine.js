#!/usr/bin/env node
/**
 * Vela Engine CLI — Pipeline State Management
 *
 * The engine is the single source of truth for pipeline state.
 * All state transitions happen through this CLI, never by direct file edits.
 *
 * Commands:
 *   init <request> [--type TYPE] [--scale SIZE] [--auto]  — Start a new pipeline
 *   state                         — Show current pipeline state
 *   transition                    — Advance to the next step (with circuit-breaker reset)
 *   record <verdict>              — Record step result (pass|fail|reject); circuit-breaker on fail
 *   branch [--mode auto|prompt|none]  — Create feature branch
 *   commit [--message TEXT]       — Commit changes
 *   cancel                        — Cancel active pipeline
 *   history                       — Show pipeline history
 *   clean-scan                    — Scan git workspace (dry-run)
 *   clean-exec                    — Execute git workspace cleanup
 *
 * V6: PM orchestrates via Agent(subagent_type=...) directly.
 * Approval tracked via file artifacts (approval-{step}.json).
 *
 * All commands output JSON to stdout.
 */

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

/**
 * Walk up from `startDir` looking for the nearest ancestor that
 * contains a `.vela/` directory. Returns null if none is found — the
 * caller decides whether to fall back to cwd or error out.
 *
 * v7.0.6: introduced to rescue engine invocations launched from a
 * project subdirectory (Claude Code sessions don't always start at
 * the project root).
 */
function walkUpForVelaDir(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".vela"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolve the project root for this invocation.
 *
 * v7.0.7: Prior versions relied purely on walk-up, which is a
 * heuristic — it can pick the wrong ancestor on symlinked trees,
 * bind mounts, or nested Vela projects, and it hides the fact that
 * cwd ever drifted.
 *
 * The installer (scripts/install.js → writeWorkspaceRecord) now
 * pins the true project root in `.vela/state/workspace.json` on
 * every install/upgrade/validate. This function reads that pin,
 * validates it, and falls back to the walk-up heuristic only when
 * the pin is absent or stale:
 *
 *   1. walk up from cwd to find any `.vela/` ancestor (velaDir)
 *   2. read `<velaDir>/.vela/state/workspace.json` if present
 *   3. if the recorded projectRoot still has a `.vela/`, use it
 *   4. otherwise use the walked-up velaDir (v7.0.6 behavior)
 *   5. if there is no `.vela/` anywhere, return process.cwd()
 *      unchanged — downstream commands that actually need .vela/
 *      will surface their own clear errors.
 *
 * When the resolved root differs from process.cwd() (i.e. cwd has
 * drifted — almost always because a prior Bash tool invocation in
 * the same session ran a bare `cd subdir`), the engine emits a
 * loud stderr warning so the root cause is visible and process.chdir
 * back so git/node child processes see a consistent cwd.
 */
function resolveProjectRoot() {
  const originalCwd = process.cwd();
  const velaDir = walkUpForVelaDir(originalCwd);
  if (!velaDir) {
    // No .vela/ anywhere in the ancestor chain. Leave cwd as-is.
    return originalCwd;
  }

  // Try the pinned workspace first.
  const wsPath = path.join(velaDir, ".vela", "state", "workspace.json");
  let pinned = null;
  if (fs.existsSync(wsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(wsPath, "utf8"));
      if (raw && typeof raw.projectRoot === "string" && raw.projectRoot) {
        // A stale pin (project was `mv`d) points at a path that no
        // longer has .vela/. In that case we must NOT chdir there —
        // fall through to the walk-up result.
        if (fs.existsSync(path.join(raw.projectRoot, ".vela"))) {
          pinned = raw.projectRoot;
        } else {
          process.stderr.write(
            `⚠️  Vela: .vela/state/workspace.json points at ${raw.projectRoot} but that path no longer has .vela/ — falling back to walk-up. Re-run \`node .vela/install.js validate\` from the new project location to refresh the pin.\n`,
          );
        }
      }
    } catch {
      /* malformed workspace.json — fall back to walk-up */
    }
  }

  const resolved = pinned || velaDir;

  if (resolved !== originalCwd) {
    // Loud warning so the root cause — usually a stray `cd subdir`
    // inside a prior Bash tool invocation — gets noticed and fixed,
    // rather than being silently masked by auto-recovery.
    process.stderr.write(
      `⚠️  Vela: chdir ${originalCwd} → ${resolved} (cwd drift detected; a prior Bash tool call probably ran a bare \`cd\` — use \`( cd dir && cmd )\` subshell isolation or absolute paths instead)\n`,
    );
    try {
      process.chdir(resolved);
    } catch {
      /* chdir may fail in exotic environments — downstream path.join
         calls use the returned value directly so we still succeed */
    }
  }

  return resolved;
}

const CWD = resolveProjectRoot();
const VELA_DIR = path.join(CWD, ".vela");
const ARTIFACTS_DIR = path.join(VELA_DIR, "artifacts");
const TEMPLATES_DIR = path.join(VELA_DIR, "templates");
const PROTECTED_BRANCHES = ["main", "master", "develop"];
// CIRCUIT_BREAKER_THRESHOLD moved to scripts/commands/state-machine.js (v7.3-M4e-p6)
// — only the VG-15 path (record/advance) touched it.

// ─── Core helpers (v7.3-M4e engine split) ───
// Pure utilities (slugify/writeJSON/output/autoDetectScale/cleanState)
// live in ../core/cli-utils.js and have no dependency on engine state.
// Git helpers bind to CWD + PROTECTED_BRANCHES via factory so the 43
// call sites below don't have to thread cwd through every invocation.
// State I/O and pipeline resolution are split into their own modules
// so the engine file becomes navigable command definitions rather
// than a mix of helpers + commands.
const {
  slugifyEx,
  slugify,
  cleanState,
  writeJSON,
  output,
  autoDetectScale,
} = require("../core/cli-utils");
const {
  gitExec,
  gitExecShell,
  snapshotGitState,
  ensureGitignore,
} = require("../core/git-utils")(CWD, PROTECTED_BRANCHES);
const {
  findActiveState,
  cleanupCancelledArtifacts,
} = require("../core/state")(ARTIFACTS_DIR);
const {
  loadPipelineDefinition,
  resolveSteps,
  checkExitGate,
} = require("../core/pipeline")({
  templatesDir: TEMPLATES_DIR,
  velaDir: VELA_DIR,
  cwd: CWD,
});

// ─── Command Router ───
const args = process.argv.slice(2);
const command = args[0];

// ─── Command context (v7.3-M4e-p3) ───
// Shared dependency bundle passed to extracted command modules under
// scripts/commands/. Function references (getArg/getFlag/hasFlag) rely
// on JS function hoisting — their declarations at the bottom of the
// file are hoisted above this object literal at load time. All paths +
// core helpers are already resolved by the factory calls above.
const ctx = {
  // paths + constants
  CWD,
  VELA_DIR,
  ARTIFACTS_DIR,
  TEMPLATES_DIR,
  PROTECTED_BRANCHES,
  // core/cli-utils (pure)
  slugifyEx,
  slugify,
  cleanState,
  writeJSON,
  output,
  autoDetectScale,
  // core/git-utils (factory-bound)
  gitExec,
  gitExecShell,
  snapshotGitState,
  ensureGitignore,
  // core/state (factory-bound)
  findActiveState,
  cleanupCancelledArtifacts,
  // core/pipeline (factory-bound)
  loadPipelineDefinition,
  resolveSteps,
  checkExitGate,
  // engine-local arg parsers (hoisted from EOF)
  getArg,
  getFlag,
  hasFlag,
};

// Extracted commands (v7.3-M4e-p3)
const cmdInit = require("../commands/init")(ctx);
const cmdBranch = require("../commands/branch")(ctx);
const cmdCommit = require("../commands/commit")(ctx);
// Extracted commands (v7.3-M4e-p4)
const cmdLocate = require("../commands/locate")(ctx);
const cmdCancel = require("../commands/cancel")(ctx);
const cmdHistory = require("../commands/history")(ctx);
// Extracted commands (v7.3-M4e-p5)
const cmdDoctor = require("../commands/doctor")(ctx);
const { cmdCleanScan, cmdCleanExec } = require("../commands/clean")(ctx);
// Extracted state-machine cluster (v7.3-M4e-p6)
const { cmdState, cmdTransition, cmdRecord, cmdAdvance } = require("../commands/state-machine")(ctx);
// Plugin bootstrap (v8.0-M3) — seeds {project}/.vela/ from the plugin install root
const cmdInitProject = require("../commands/init-project")(ctx);

const commands = {
  init: cmdInit,
  "init-project": cmdInitProject, // v8.0 — /vela:install backend
  state: cmdState,
  transition: cmdTransition,
  record: cmdRecord,
  advance: cmdAdvance, // v7.1 M8: record+transition one-shot
  doctor: cmdDoctor,   // v7.1 M6: health check
  branch: cmdBranch,
  commit: cmdCommit,
  cancel: cmdCancel,
  history: cmdHistory,
  locate: cmdLocate,
  "clean-scan": cmdCleanScan,
  "clean-exec": cmdCleanExec,
};

if (require.main === module) {
  if (!command || !commands[command]) {
    output({
      ok: false,
      error: `Unknown command: ${command || "(none)"}`,
      available: Object.keys(commands),
    });
    process.exit(1);
  }

  const result = commands[command]();
  if (result && typeof result.then === "function") {
    result.catch((err) => {
      output({ ok: false, error: err.message });
      process.exit(1);
    });
  }
}

// ─── Commands ───

// cmdInit moved to scripts/commands/init.js (v7.3-M4e-p3)

// cmdState moved to scripts/commands/state-machine.js (v7.3-M4e-p6)

// cmdTransition moved to scripts/commands/state-machine.js (v7.3-M4e-p6)

// cmdRecord moved to scripts/commands/state-machine.js (v7.3-M4e-p6)

/**
 * v7.1 M8: Apply a verdict (pass/fail/reject) to the active pipeline state
 * in memory. Returns the mutated state plus auto-mode side effects, but
 * does NOT write to disk — callers compose this with applyTransition()
 * when running the advance shortcut, so both mutations flush in one
 * writeJSON call.
 *
 * Factored out of cmdRecord so `advance` can reuse exactly the same
 * circuit-breaker, auto-mode, and revision-counter rules that `record`
 * has carried since v4.
 */
// applyVerdict moved to scripts/commands/state-machine.js (v7.3-M4e-p6)

/**
 * v7.1 M8: advance — record(verdict) + transition as one atomic CLI call.
 *
 * Motivation: hicoco session analysis showed the PM's top-level Bash
 * count was 146, the largest single consumer being "record pass" followed
 * immediately by "transition" on every successful step. advance halves
 * that latency and also lets the engine return a `nextAction` hint so the
 * PM can skip an extra `state` round-trip just to find out which agent to
 * spawn next.
 *
 * Behaviour by verdict:
 *   pass  (default) — record pass, transition to next step
 *   fail  — record fail, stay on current step (no transition)
 *   reject — record reject, stay on current step (no transition)
 *
 * Output JSON includes: previousStep, currentStep, nextStep, active,
 * circuitOpen, and nextAction (a one-line hint like "spawn vela-executor"
 * or "commit via `vela-engine commit`").
 *
 * Backward compat: cmdRecord and cmdTransition remain untouched so any
 * existing automation still works.
 */
// cmdAdvance moved to scripts/commands/state-machine.js (v7.3-M4e-p6)

/**
 * v7.1 M8: return a short one-line hint for what the PM should do next
 * at a given step. Used by `advance` (and `state` when added) so the PM
 * can skip an extra `state` round-trip to decide which agent to spawn.
 *
 * Non-authoritative: hints are pure strings. The PM is still the decision
 * maker. Keep the table tiny — if a step is missing it falls back to
 * "see agents/vela.md for this step".
 */
// nextActionHint moved to scripts/commands/state-machine.js (v7.3-M4e-p6)

/**
 * v7.1 M6: engine doctor — validate that all Vela-managed files are
 * present and parseable. Returns { ok, missing, recovery } shaped JSON.
 *
 * Used by:
 *   - Session-start flow in agents/vela.md so the PM fails loud when
 *     .vela/ is incomplete instead of limping along until the first
 *     agent spawn dies with "file not found"
 *   - /vela:analyze pre-flight
 *
 * Reverse from FILE_MANIFEST: doctor doesn't re-download anything, it
 * only reports. install.js validate is the repair path.
 */
// cmdDoctor moved to scripts/commands/doctor.js (v7.3-M4e-p5)

// cmdBranch moved to scripts/commands/branch.js (v7.3-M4e-p3)

// cmdCommit moved to scripts/commands/commit.js (v7.3-M4e-p3)

/**
 * cmdLocate — Mechanical Locate (v6.1)
 *
 * Runs scripts/shared/locate.js against the active pipeline's request and
 * writes {artifactDir}/targets.json. LLM-free: deterministic grep + git
 * ls-files. Used by every scale's locate step (small/medium/large/ralph/hotfix)
 * to give downstream agents a precise file:line target list.
 *
 * Flags:
 *   --request "..."   Override the request (defaults to active pipeline's request)
 *   --json            Print the full targets.json to stdout (default: summary)
 *
 * Exit gates that depend on this:
 *   - targets_json_exists  (added in checkExitGate)
 */
// cmdLocate moved to scripts/commands/locate.js (v7.3-M4e-p4)

// cmdCancel moved to scripts/commands/cancel.js (v7.3-M4e-p4)

// ─── Git Clean: Scan (read-only, report findings) ───
// cmdCleanScan moved to scripts/commands/clean.js (v7.3-M4e-p5)

// ─── Git Clean: Execute selected categories ───
// cmdCleanExec moved to scripts/commands/clean.js (v7.3-M4e-p5)

// detectMainBranch moved to scripts/commands/clean.js (inlined helper) (v7.3-M4e-p5)

// cmdHistory moved to scripts/commands/history.js (v7.3-M4e-p4)

// ─── Helpers ───

// getOrCreateTeam REMOVED (V4.1). V6 uses Agent(subagent_type=...) directly.

// findActiveState moved to scripts/core/state.js (v7.3-M4e engine split).
// See top-of-file `require("../core/state")(ARTIFACTS_DIR)` for the
// factory-bound import.

// loadPipelineDefinition + resolveSteps + checkExitGate moved to
// scripts/core/pipeline.js (v7.3-M4e engine split). See top-of-file
// `require("../core/pipeline")({templatesDir, velaDir, cwd})` for the
// factory-bound import.

// slugify/slugifyEx/cleanState/writeJSON/output/autoDetectScale moved
// to scripts/core/cli-utils.js (v7.3-M4e engine split). See top-of-file
// `require("../core/cli-utils")` for the import.

// Return the Nth positional argument after the command, skipping flags.
// Previously this was `args[index + 1]` which returned "--scale" for
// `init --scale large "task"`, causing slugify("--scale") for the request.
// Known boolean flags are inlined to avoid a TDZ reference (this function
// runs at top-level load time via the command dispatch on line ~64).
function getArg(index) {
  const booleanFlags = new Set(["--auto", "--force", "--json"]);
  const positionals = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (typeof a === "string" && a.startsWith("--")) {
      if (!booleanFlags.has(a)) {
        i++; // consume the flag's value
      }
      continue;
    }
    positionals.push(a);
  }
  return positionals[index] || null;
}

function getFlag(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

// ─── Cleanup ───

// cleanupCancelledArtifacts moved to scripts/core/state.js (v7.3-M4e
// engine split). See top-of-file `require("../core/state")(ARTIFACTS_DIR)`
// for the factory-bound import.

// Git helpers (gitExec/gitExecShell/snapshotGitState/ensureGitignore)
// moved to scripts/core/git-utils.js (v7.3-M4e engine split). See
// top-of-file `require("../core/git-utils")(CWD, PROTECTED_BRANCHES)`
// for the factory-bound import.
