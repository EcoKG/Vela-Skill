#!/usr/bin/env node
/**
 * Vela Compact Hook — Claude Code PreCompact / PostCompact Hook
 *
 * PreCompact:  Saves rich pipeline + session context to .vela/state/compact-context.json.
 *              Captures: active pipeline state, recent learnings, failure counter,
 *              session analytics summary, and git context.
 *              Produces no stdout output (silent save).
 *
 * PostCompact: Reads saved context and injects it back as additionalContext
 *              so Claude Code fully restores pipeline state after compaction.
 *
 * Exit codes:
 *   0 — continue (normal)
 *   Non-zero errors are suppressed to avoid blocking compaction.
 */

"use strict";

const fs = require("fs");
const path = require("path");

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
 * Find the active pipeline state.
 * Returns { state, artifactDir } or null if none found.
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
        // skip
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const input = parseJsonSafe(raw) || {};

  const cwd = (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const eventType = input.hook_event_name || "";
  const stateDir = path.join(cwd, ".vela", "state");
  const contextPath = path.join(stateDir, "compact-context.json");

  if (eventType === "PreCompact") {
    // Save rich pipeline + session context (silent — no stdout)
    try {
      const pipelineResult = findActivePipeline(cwd);

      // Read recent learnings (top 3 patterns)
      let learningsSummary = [];
      try {
        const learningsPath = path.join(cwd, ".vela", "learnings", "learnings.json");
        if (fs.existsSync(learningsPath)) {
          const raw = parseJsonSafe(fs.readFileSync(learningsPath, "utf8"));
          if (raw && Array.isArray(raw.learnings)) {
            learningsSummary = raw.learnings
              .slice(-2)
              .reverse()
              .flatMap((entry) => {
                if (!entry || !Array.isArray(entry.patterns)) return [];
                return entry.patterns
                  .filter((p) => p && (p.category === "weakness" || p.category === "recurring_issue"))
                  .slice(0, 2)
                  .map((p) => `[${p.category}] ${p.description}`);
              })
              .slice(0, 3);
          }
        }
      } catch { /* skip */ }

      // Read failure counter
      let failureCounter = null;
      try {
        const counterPath = path.join(cwd, ".vela", "state", "failure-counter.json");
        if (fs.existsSync(counterPath)) {
          failureCounter = parseJsonSafe(fs.readFileSync(counterPath, "utf8"));
        }
      } catch { /* skip */ }

      // Read session analytics summary
      let analyticsSummary = null;
      try {
        const analyticsPath = path.join(cwd, ".vela", "state", "session-analytics.json");
        if (fs.existsSync(analyticsPath)) {
          const analytics = parseJsonSafe(fs.readFileSync(analyticsPath, "utf8"));
          if (analytics && analytics.summary) {
            analyticsSummary = {
              totalCalls: analytics.summary.totalCalls || 0,
              denials: analytics.summary.denials || 0,
            };
          }
        }
      } catch { /* skip */ }

      // Read git context
      let gitContext = null;
      try {
        const { execFileSync } = require("child_process");
        const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 3000,
        }).toString().trim();
        const lastCommit = execFileSync("git", ["log", "--oneline", "-1"], {
          cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 3000,
        }).toString().trim();
        gitContext = { branch, lastCommit };
      } catch { /* skip */ }

      const context = {
        timestamp: new Date().toISOString(),
        cwd,
        activePipeline: pipelineResult ? pipelineResult.state : null,
        artifactDir: pipelineResult ? pipelineResult.artifactDir : null,
        learningsSummary,
        failureCounter,
        analyticsSummary,
        gitContext,
      };
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf8");
    } catch {
      // Silent — never fail compaction
    }
    process.exit(0);
  }

  if (eventType === "PostCompact") {
    // Read saved context and inject as rich additionalContext
    try {
      let savedContext = null;
      if (fs.existsSync(contextPath)) {
        savedContext = parseJsonSafe(fs.readFileSync(contextPath, "utf8"));
      }

      const pipeline = savedContext && savedContext.activePipeline;
      const SEP = "━".repeat(47);
      const lines = ["⛵ Vela Pipeline Context (압축 후 복원)", SEP];

      if (pipeline) {
        const completedCount = Array.isArray(pipeline.completed_steps) ? pipeline.completed_steps.length : 0;
        const totalSteps = Array.isArray(pipeline.steps) ? pipeline.steps.length : "?";
        lines.push(`- 파이프라인: ${pipeline.pipeline_type || "standard"} | 단계: ${pipeline.current_step || "unknown"} (${completedCount + 1}/${totalSteps})`);
        lines.push(`- 상태: ${pipeline.status || "unknown"}`);
        if (pipeline.request) lines.push(`- 작업: ${pipeline.request}`);
        if (pipeline.auto) lines.push("- 모드: ⚡ AUTO");
        if (pipeline.git && pipeline.git.pipeline_branch) {
          lines.push(`- 브랜치: ${pipeline.git.pipeline_branch}`);
        }
      } else {
        lines.push("- 압축 시점에 활성 파이프라인 없음.");
      }

      // Git context
      if (savedContext && savedContext.gitContext) {
        const g = savedContext.gitContext;
        lines.push(`- Git: ${g.branch}${g.lastCommit ? ` | ${g.lastCommit}` : ""}`);
      }

      // Failure counter
      if (savedContext && savedContext.failureCounter && savedContext.failureCounter.count > 0) {
        lines.push(`- 실패 카운터: ${savedContext.failureCounter.count}회 (단계: ${savedContext.failureCounter.step})`);
      }

      // Analytics summary
      if (savedContext && savedContext.analyticsSummary) {
        const a = savedContext.analyticsSummary;
        lines.push(`- 세션 통계: 툴 호출 ${a.totalCalls}회 | 차단 ${a.denials}회`);
      }

      // Learnings
      if (savedContext && Array.isArray(savedContext.learningsSummary) && savedContext.learningsSummary.length > 0) {
        lines.push("- 최근 학습:");
        savedContext.learningsSummary.forEach((l) => lines.push(`  • ${l}`));
      }

      lines.push(SEP);

      if (pipeline) {
        lines.push("");
        lines.push("[SYSTEM INSTRUCTION FOR CLAUDE]");
        lines.push(`활성 파이프라인이 복원되었습니다 (단계: ${pipeline.current_step || "unknown"}).`);
        lines.push("계속하려면: node .vela/cli/vela-pipeline.js resume");
        lines.push("[END SYSTEM INSTRUCTION]");
      }

      const output = {
        additionalContext: lines.join("\n"),
      };
      process.stdout.write(JSON.stringify(output));
    } catch {
      // Fallback: minimal additionalContext
      process.stdout.write(
        JSON.stringify({ additionalContext: "⛵ Vela context: compaction complete." })
      );
    }
    process.exit(0);
  }

  // Unknown event — silent exit
  process.exit(0);
}

main().catch(() => process.exit(0));
