/**
 * Vela Worktree Manager
 * Git worktree lifecycle management for pipeline isolation.
 * All worktrees live under `.vela/worktrees/` (gitignored).
 *
 * Consumed by: S03 executor, S04 reviewer, S06 orchestrator.
 */

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** Base directory under the repo root where vela worktrees are created. */
const WORKTREE_BASE = ".vela/worktrees";

/** Branch prefix that distinguishes pipeline worktree branches from normal vela branches. */
const BRANCH_PREFIX = "vela/wt-";

/**
 * Execute a git command synchronously, matching the vela-engine.js gitExec pattern.
 * @param {string} cwd — repository root
 * @param {...string} args — git sub-command and arguments
 * @returns {string} stdout trimmed
 */
function gitExec(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  }).toString();
}

/**
 * Create a new git worktree for a pipeline role.
 *
 * Worktree path: `<cwd>/.vela/worktrees/<pipelineSlug>-<role>`
 * Branch name:   `vela/wt-<pipelineSlug>-<role>` (timestamp suffix on collision)
 *
 * @param {Object} opts
 * @param {string} opts.cwd        — repository root (absolute path)
 * @param {string} opts.pipelineSlug — pipeline identifier (e.g. "M026-S03")
 * @param {string} opts.role       — role name (e.g. "executor", "reviewer")
 * @returns {{ path: string, branch: string }} absolute worktree path and branch name
 */
function create({ cwd, pipelineSlug, role }) {
  if (!cwd || !pipelineSlug || !role) {
    throw new Error(
      "worktree-manager.create: cwd, pipelineSlug, and role are required",
    );
  }

  const baseDir = path.join(cwd, WORKTREE_BASE);
  fs.mkdirSync(baseDir, { recursive: true });

  const dirName = `${pipelineSlug}-${role}`;
  const worktreePath = path.resolve(baseDir, dirName);

  let branchName = `${BRANCH_PREFIX}${dirName}`;

  // Check if branch already exists — append timestamp suffix on collision
  try {
    gitExec(cwd, "rev-parse", "--verify", `refs/heads/${branchName}`);
    // Branch exists — make it unique
    const suffix = Date.now().toString(36);
    branchName = `${branchName}-${suffix}`;
  } catch {
    // Branch does not exist — use the name as-is
  }

  gitExec(cwd, "worktree", "add", worktreePath, "-b", branchName);

  return { path: worktreePath, branch: branchName };
}

/**
 * Remove a git worktree.
 *
 * @param {Object} opts
 * @param {string} opts.cwd           — repository root (absolute path)
 * @param {string} opts.worktreePath  — absolute path to the worktree
 * @param {boolean} [opts.force=false] — pass --force to remove dirty worktrees
 * @returns {{ ok: true }}
 * @throws {Error} if the worktree does not exist or removal fails
 */
function remove({ cwd, worktreePath, force = false }) {
  if (!cwd || !worktreePath) {
    throw new Error(
      "worktree-manager.remove: cwd and worktreePath are required",
    );
  }

  // Verify the path is known to git worktree
  const existing = listAll(cwd);
  const match = existing.find((wt) => wt.path === worktreePath);
  if (!match) {
    throw new Error(
      `worktree-manager.remove: worktree not found at "${worktreePath}"`,
    );
  }

  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);

  gitExec(cwd, ...args);

  // Clean up the branch created for this worktree
  if (match.branch) {
    try {
      gitExec(cwd, "branch", "-D", match.branch);
    } catch {
      // Branch may already be deleted or never created — ignore
    }
  }

  return { ok: true };
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 * @param {string} cwd — repository root
 * @returns {Array<{ path: string, branch: string, head: string }>} all worktrees
 */
function listAll(cwd) {
  let raw;
  try {
    raw = gitExec(cwd, "worktree", "list", "--porcelain");
  } catch {
    return [];
  }

  const entries = [];
  const blocks = raw.trim().split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split("\n");
    const entry = { path: "", branch: "", head: "" };

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        entry.path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        entry.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        // branch refs/heads/vela/wt-xxx → vela/wt-xxx
        entry.branch = line.slice("branch ".length).replace("refs/heads/", "");
      }
    }

    if (entry.path) entries.push(entry);
  }

  return entries;
}

/**
 * List vela pipeline worktrees only.
 * Filters `git worktree list` to entries whose path contains `.vela/worktrees/`.
 *
 * @param {Object} opts
 * @param {string} opts.cwd — repository root (absolute path)
 * @returns {Array<{ path: string, branch: string, head: string }>}
 */
function list({ cwd }) {
  if (!cwd) {
    throw new Error("worktree-manager.list: cwd is required");
  }

  const all = listAll(cwd);
  const velaBase = path.join(cwd, WORKTREE_BASE);

  return all.filter((wt) => wt.path.startsWith(velaBase));
}

/**
 * Remove all vela pipeline worktrees. Idempotent — safe when none exist.
 *
 * @param {Object} opts
 * @param {string} opts.cwd — repository root (absolute path)
 * @returns {{ removed: number }}
 */
function cleanup({ cwd }) {
  if (!cwd) {
    throw new Error("worktree-manager.cleanup: cwd is required");
  }

  const velaWorktrees = list({ cwd });

  let removed = 0;
  for (const wt of velaWorktrees) {
    try {
      remove({ cwd, worktreePath: wt.path, force: true });
      removed++;
    } catch {
      // Best-effort: if one fails, continue with the rest
    }
  }

  // Prune stale worktree references
  try {
    gitExec(cwd, "worktree", "prune");
  } catch {
    // Non-critical
  }

  return { removed };
}

module.exports = { create, remove, list, cleanup };
