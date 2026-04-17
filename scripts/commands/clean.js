/**
 * Vela commands — `clean-scan` + `clean-exec` (v7.3-M4e-p5)
 *
 * Extracted from scripts/cli/vela-engine.js. Two paired commands for
 * tidying a Vela-managed repo:
 *
 *   clean-scan  (read-only, dry-run)
 *     Reports six categories of residue:
 *       tracked   — files in git that match .gitignore
 *       branches  — vela/* branches already merged to main/master
 *       ignored   — untracked files that .gitignore now matches
 *       artifacts — completed/cancelled pipelines older than 7 days
 *       cache     — .vela/cache/*.db* files + sizes
 *       prune     — remote refs deleted upstream (git remote prune --dry-run)
 *
 *   clean-exec --categories foo,bar
 *     Executes the selected categories and reports `actions[]`.
 *     Requires explicit --categories — no "clean everything" mode by
 *     design so a stray invocation never discards work.
 *
 * Shared helper detectMainBranch() lives in this module because both
 * commands need it and it has no other callers.
 */

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function createCleanCommands(ctx) {
  const {
    VELA_DIR,
    ARTIFACTS_DIR,
    getFlag,
    gitExec,
    gitExecShell,
    output,
  } = ctx;

  function detectMainBranch() {
    try {
      gitExec("rev-parse", "--verify", "main");
      return "main";
    } catch (e) {}
    try {
      gitExec("rev-parse", "--verify", "master");
      return "master";
    } catch (e) {}
    return null;
  }

  function cmdCleanScan() {
    try {
      gitExec("rev-parse", "--git-dir");
    } catch (e) {
      return output({ ok: false, error: "Not a git repository." });
    }

    const findings = {};

    // 1. Tracked-but-ignored files
    findings.trackedIgnored = [];
    try {
      const tracked = gitExec("ls-files").trim().split("\n").filter(Boolean);
      for (const file of tracked) {
        try {
          gitExec("check-ignore", "--no-index", "-q", file);
          findings.trackedIgnored.push(file);
        } catch (e) {
          /* not ignored */
        }
      }
    } catch (e) {}

    // 2. Merged vela/ branches
    findings.mergedBranches = [];
    try {
      const mainBranch = detectMainBranch();
      if (mainBranch) {
        const currentBranch = gitExec("rev-parse", "--abbrev-ref", "HEAD").trim();
        const raw = gitExec("branch", "--merged", mainBranch).trim();
        if (raw) {
          findings.mergedBranches = raw
            .split("\n")
            .map((b) => b.replace("*", "").trim())
            .filter(
              (b) =>
                b.startsWith("vela/") && b !== mainBranch && b !== currentBranch,
            );
        }
      }
    } catch (e) {}

    // 3. Ignored files on disk (git clean preview)
    findings.ignoredFiles = { count: 0, preview: [] };
    try {
      const raw = gitExec("clean", "-fdXn").trim();
      if (raw) {
        const lines = raw.split("\n").filter(Boolean);
        findings.ignoredFiles.count = lines.length;
        findings.ignoredFiles.preview = lines
          .slice(0, 20)
          .map((l) => l.replace(/^Would remove /, ""));
      }
    } catch (e) {}

    // 4. Stale Vela artifacts (7+ days, completed/cancelled)
    findings.staleArtifacts = [];
    if (fs.existsSync(ARTIFACTS_DIR)) {
      try {
        for (const d of fs.readdirSync(ARTIFACTS_DIR)) {
          const sp = path.join(ARTIFACTS_DIR, d, "pipeline-state.json");
          if (!fs.existsSync(sp)) continue;
          try {
            const st = JSON.parse(fs.readFileSync(sp, "utf-8"));
            if (st.status === "completed" || st.status === "cancelled") {
              const daysOld = Math.floor(
                (Date.now() - new Date(st.updated_at || 0).getTime()) / 86400000,
              );
              if (daysOld > 7)
                findings.staleArtifacts.push({
                  dir: d,
                  status: st.status,
                  daysOld,
                });
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    // 5. Vela cache DB files
    findings.cacheFiles = [];
    const cacheDir = path.join(VELA_DIR, "cache");
    if (fs.existsSync(cacheDir)) {
      try {
        for (const f of fs.readdirSync(cacheDir)) {
          if (/\.db(-journal|-wal|-shm)?$/.test(f)) {
            const stat = fs.statSync(path.join(cacheDir, f));
            findings.cacheFiles.push({
              file: f,
              sizeKB: Math.round(stat.size / 1024),
            });
          }
        }
      } catch (e) {}
    }

    // 6. Remote prunable refs
    findings.prunableRefs = [];
    try {
      const raw = gitExecShell("git remote prune origin --dry-run 2>&1").trim();
      if (raw) {
        const pruned = raw.split("\n").filter((l) => l.includes("[would prune]"));
        findings.prunableRefs = pruned.map((l) =>
          l.replace(/.*\[would prune\]\s*/, "").trim(),
        );
      }
    } catch (e) {}

    const total =
      findings.trackedIgnored.length +
      findings.mergedBranches.length +
      findings.ignoredFiles.count +
      findings.staleArtifacts.length +
      findings.cacheFiles.length +
      findings.prunableRefs.length;

    output({
      ok: true,
      command: "clean-scan",
      findings,
      totalItems: total,
      message:
        total === 0
          ? "✅ 프로젝트가 깨끗합니다."
          : `🧹 ${total}개 항목을 정리할 수 있습니다.`,
    });
  }

  function cmdCleanExec() {
    try {
      gitExec("rev-parse", "--git-dir");
    } catch (e) {
      return output({ ok: false, error: "Not a git repository." });
    }

    const categoriesStr = getFlag("--categories") || "";
    if (!categoriesStr) {
      return output({
        ok: false,
        error:
          "No categories specified. Use --categories tracked,branches,ignored,artifacts,cache,prune",
      });
    }
    const selected = new Set(categoriesStr.split(",").map((s) => s.trim()));
    const actions = [];

    if (selected.has("tracked")) {
      try {
        const tracked = gitExec("ls-files").trim().split("\n").filter(Boolean);
        const toUntrack = [];
        for (const file of tracked) {
          try {
            gitExec("check-ignore", "--no-index", "-q", file);
            toUntrack.push(file);
          } catch (e) {}
        }
        if (toUntrack.length > 0) {
          for (const f of toUntrack) {
            try {
              gitExec("rm", "--cached", f);
            } catch (e) {}
          }
          try {
            gitExecShell("git add .gitignore 2>/dev/null || true");
            gitExec("add", "-u");
            gitExec(
              "commit",
              "-m",
              "chore: untrack ignored files",
              "--no-verify",
            );
          } catch (e) {}
          actions.push({
            type: "untracked",
            count: toUntrack.length,
            files: toUntrack,
          });
        }
      } catch (e) {}
    }

    if (selected.has("branches")) {
      try {
        const mainBranch = detectMainBranch();
        const currentBranch = gitExec("rev-parse", "--abbrev-ref", "HEAD").trim();
        if (mainBranch) {
          const raw = gitExec("branch", "--merged", mainBranch).trim();
          if (raw) {
            raw
              .split("\n")
              .map((b) => b.replace("*", "").trim())
              .filter(
                (b) =>
                  b.startsWith("vela/") &&
                  b !== mainBranch &&
                  b !== currentBranch,
              )
              .forEach((b) => {
                try {
                  gitExec("branch", "-d", b);
                  actions.push({ type: "branch_deleted", branch: b });
                } catch (e) {}
              });
          }
        }
      } catch (e) {}
    }

    if (selected.has("ignored")) {
      try {
        const cleaned = gitExec("clean", "-fdX").trim();
        if (cleaned)
          actions.push({
            type: "ignored_cleaned",
            count: cleaned.split("\n").filter(Boolean).length,
          });
      } catch (e) {}
    }

    if (selected.has("artifacts")) {
      if (fs.existsSync(ARTIFACTS_DIR)) {
        try {
          for (const d of fs.readdirSync(ARTIFACTS_DIR)) {
            const sp = path.join(ARTIFACTS_DIR, d, "pipeline-state.json");
            if (!fs.existsSync(sp)) continue;
            try {
              const st = JSON.parse(fs.readFileSync(sp, "utf-8"));
              if (
                (st.status === "completed" || st.status === "cancelled") &&
                Math.floor(
                  (Date.now() - new Date(st.updated_at || 0).getTime()) /
                    86400000,
                ) > 7
              ) {
                fs.rmSync(path.join(ARTIFACTS_DIR, d), {
                  recursive: true,
                  force: true,
                });
                actions.push({ type: "artifact_removed", dir: d });
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
    }

    if (selected.has("cache")) {
      const cacheDir = path.join(VELA_DIR, "cache");
      if (fs.existsSync(cacheDir)) {
        try {
          for (const f of fs.readdirSync(cacheDir)) {
            if (/\.db(-journal|-wal|-shm)?$/.test(f)) {
              fs.unlinkSync(path.join(cacheDir, f));
              actions.push({ type: "cache_removed", file: f });
            }
          }
        } catch (e) {}
      }
    }

    if (selected.has("prune")) {
      try {
        gitExec("remote", "prune", "origin");
        actions.push({ type: "remote_pruned" });
      } catch (e) {}
    }

    output({
      ok: true,
      command: "clean-exec",
      actions,
      message: `🧹 ${actions.length}개 작업 완료.`,
    });
  }

  return { cmdCleanScan, cmdCleanExec };
};
