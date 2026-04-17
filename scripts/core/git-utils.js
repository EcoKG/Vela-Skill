/**
 * Vela Core — Git helpers (v7.3-M4e)
 *
 * Extracted from scripts/cli/vela-engine.js during the v8.0 engine
 * decomposition. The engine touches git at three levels:
 *
 *   1. Read-only queries         (gitExec, gitExecShell, snapshotGitState)
 *   2. Branch + commit ops       (gitExec passthrough, called by cmdBranch/Commit)
 *   3. Repo-health maintenance   (ensureGitignore — untrack + append)
 *
 * All four helpers are bound to a specific working directory at
 * factory-call time so downstream callers don't have to thread `cwd`
 * through every invocation. This preserves the 43 existing call sites
 * inside vela-engine.js verbatim (just the import line changes).
 *
 * Usage:
 *   const { gitExec, snapshotGitState, ensureGitignore } =
 *     require("../core/git-utils")(CWD, PROTECTED_BRANCHES);
 *
 * The factory accepts the repo root + the array of protected branches
 * (main/master/develop by convention). The module itself is stateless —
 * each factory call creates a fresh set of closures. Two different
 * command processes hitting two different repos would each get their
 * own bound helpers.
 *
 * All commands use 15s execFileSync timeout except the gitignore
 * maintenance pass, which allocates smaller budgets for its three
 * sub-operations (5s ls-files, 10s rm + commit).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

/**
 * @param {string} cwd                 — project root (git working tree)
 * @param {string[]} protectedBranches — branches that trigger is_protected=true
 */
function createGitUtils(cwd, protectedBranches) {
  function gitExec(...args) {
    return execFileSync("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    }).toString();
  }

  function gitExecShell(cmd) {
    return execSync(cmd, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    }).toString();
  }

  function snapshotGitState() {
    try {
      gitExec("rev-parse", "--git-dir");
    } catch (e) {
      return { is_repo: false };
    }

    try {
      const currentBranch = gitExec("rev-parse", "--abbrev-ref", "HEAD").trim();
      // -uno: exclude untracked files from dirty check — untracked files
      // (e.g. .bg-shell/, src/test/) should not block pipeline init
      const status = gitExec("status", "--porcelain", "-uno").trim();
      const headHash = gitExec("rev-parse", "HEAD").trim();

      let remote = null;
      try {
        remote = gitExec("remote").trim().split("\n")[0] || null;
      } catch (e) {}

      return {
        is_repo: true,
        current_branch: currentBranch,
        is_clean: status === "",
        dirty_files: status ? status.split("\n").length : 0,
        head_hash: headHash,
        remote: remote,
        is_protected: protectedBranches.includes(currentBranch),
      };
    } catch (e) {
      return { is_repo: true, error: e.message };
    }
  }

  function ensureGitignore() {
    const gitignorePath = path.join(cwd, ".gitignore");
    const velaEntries = [
      "# Vela Engine (auto-managed)",
      ".vela/",
      ".claude/",
      "CLAUDE.md",
    ];

    // Step 1: Remove already-tracked Vela files BEFORE updating .gitignore
    // (if .gitignore lists them first, git silently drops the staged deletions)
    try {
      const tracked = execSync("git ls-files .vela/ .claude/ CLAUDE.md", {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      })
        .toString()
        .trim();
      if (tracked) {
        execSync(
          "git rm -r --cached --ignore-unmatch .vela/ .claude/ CLAUDE.md",
          {
            cwd,
            stdio: "pipe",
            timeout: 10000,
          },
        );
        execSync(
          'git commit -m "chore: untrack Vela files from git" --no-verify',
          {
            cwd,
            stdio: "pipe",
            timeout: 10000,
          },
        );
      }
    } catch (e) {
      // Not a git repo, git not available, or nothing to commit — skip
    }

    // Step 2: Update .gitignore (after deletions are committed)
    let content = "";
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf-8");
    }

    const missingEntries = velaEntries.filter(
      (entry) => !entry.startsWith("#") && !content.includes(entry),
    );

    if (missingEntries.length > 0) {
      if (!content.includes("# Vela Engine")) {
        fs.appendFileSync(gitignorePath, "\n" + velaEntries.join("\n") + "\n");
      } else {
        fs.appendFileSync(gitignorePath, missingEntries.join("\n") + "\n");
      }
    }
  }

  return { gitExec, gitExecShell, snapshotGitState, ensureGitignore };
}

module.exports = createGitUtils;
