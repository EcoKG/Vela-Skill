#!/usr/bin/env node
/**
 * Vela SessionStart Hook — Rich Environment & Context Injection
 *
 * Triggered on every Claude Code session start (globally registered).
 * Injects rich project and pipeline context into the session so Claude
 * immediately understands the project state without extra exploration.
 *
 * Context injected (all optional, graceful-degraded if unavailable):
 *   - Active pipeline: step, request, auto mode, branch
 *   - Recent learnings: top 3 patterns from .vela/learnings/learnings.json
 *   - Failure counter: consecutive failures in current step
 *   - Project environment: language, framework, test runner (from project-env.js)
 *   - Git context: current branch + last 3 commits
 *
 * Output format:
 *   stdout → plain text injected as session context (Claude reads it)
 *   exit 0 — SessionStart hooks should always exit 0
 *
 * Fast & silent: all errors are suppressed, 2s network timeout,
 * falls back gracefully when .vela/ does not exist.
 *
 * Registered globally via deploy-common.sh register_session_start_hook().
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ─── Helpers ────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); }
    });
    process.stdin.on("error", () => resolve(null));
  });
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Find the active pipeline state under .vela/artifacts/.
 * Returns { state, artifactDir } or null.
 */
function findActivePipeline(velaDir) {
  try {
    const artifactsDir = path.join(velaDir, "artifacts");
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
        const state = readJsonSafe(statePath);
        if (state && state.status === "active") {
          return { state, artifactDir };
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}

/**
 * Read top-N recent learning patterns from learnings.json.
 * Returns string[] of short descriptions.
 */
function readRecentLearnings(velaDir, n) {
  try {
    const learningsPath = path.join(velaDir, "learnings", "learnings.json");
    if (!fs.existsSync(learningsPath)) return [];

    const raw = readJsonSafe(learningsPath);
    if (!raw || !Array.isArray(raw.learnings)) return [];

    // Most recent first, take top-n patterns
    return raw.learnings
      .slice(-n)
      .reverse()
      .flatMap((entry) => {
        if (!entry || !Array.isArray(entry.patterns)) return [];
        return entry.patterns
          .filter((p) => p && (p.category === "weakness" || p.category === "recurring_issue"))
          .slice(0, 2)
          .map((p) => `[${p.category}] ${p.description}${p.frequency !== "first_time" ? ` (${p.frequency})` : ""}`);
      })
      .slice(0, n);
  } catch {
    return [];
  }
}

/**
 * Read git context: current branch + last 3 commits.
 * Returns { branch, recentCommits } or null.
 */
function readGitContext(cwd) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 3000,
    }).toString().trim();

    const log = execFileSync("git", ["log", "--oneline", "-3"], {
      cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 3000,
    }).toString().trim();

    const recentCommits = log.split("\n").filter(Boolean).map((l) => l.trim());

    return { branch, recentCommits };
  } catch {
    return null;
  }
}

/**
 * Read failure counter state.
 */
function readFailureCounter(velaDir) {
  return readJsonSafe(path.join(velaDir, "state", "failure-counter.json"));
}

/**
 * Read project environment using project-env.js if available.
 */
function readProjectEnv(cwd, skillDir) {
  // Try project-local .vela/shared/project-env.js first, then skill source
  const candidates = [
    path.join(cwd, ".vela", "shared", "project-env.js"),
    path.join(skillDir, "scripts", "shared", "project-env.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const { detectProjectEnvironment } = require(candidate);
        return detectProjectEnvironment(cwd);
      }
    } catch { /* fall through */ }
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const input = await readStdin();

  // Determine cwd from stdin (SessionStart passes session info)
  const cwd = (input && typeof input.cwd === "string" && input.cwd) || process.cwd();
  const velaDir = path.join(cwd, ".vela");

  // If .vela/ does not exist, this project has no Vela — silent exit
  if (!fs.existsSync(velaDir)) {
    process.exit(0);
  }

  // Read config to check if Vela is enabled
  const config = readJsonSafe(path.join(velaDir, "config.json"));

  // Collect context sections
  const sections = [];

  // ── Prompt Cache TTL Check (v7.2 M1) ─────────────────────
  // The 1h TTL env var must be set in the user's shell before launching
  // `claude`; hooks cannot mutate the parent process env. If config asks
  // for 1h caching but the env var is missing, emit a one-line nudge so
  // the user can export it next session. Silent when already set.
  try {
    const cacheCfg = config && config.cache;
    const wantsOneHour = cacheCfg && cacheCfg.ttl === "1h";
    const envOn = process.env.ENABLE_PROMPT_CACHING_1H === "1" ||
                  process.env.ENABLE_PROMPT_CACHING_1H === "true";
    if (wantsOneHour && !envOn) {
      sections.push({
        header: "프롬프트 캐시 경고 (v7.2 M1)",
        lines: [
          "  config.cache.ttl=1h 인데 ENABLE_PROMPT_CACHING_1H 미설정.",
          "  → 다음 세션 전에 `export ENABLE_PROMPT_CACHING_1H=1` 추가 권장.",
        ],
      });
    }
  } catch { /* non-fatal */ }

  // ── Active Pipeline ──────────────────────────────────────
  const pipelineResult = findActivePipeline(velaDir);
  if (pipelineResult) {
    const { state } = pipelineResult;
    const completedCount = Array.isArray(state.completed_steps) ? state.completed_steps.length : 0;
    const totalSteps = Array.isArray(state.steps) ? state.steps.length : "?";
    const autoTag = state.auto ? " ⚡AUTO" : "";

    const pipelineLines = [
      `  파이프라인: ${state.current_step} (${completedCount + 1}/${totalSteps})${autoTag}`,
      `  작업: ${state.request || "unknown"}`,
      `  유형: ${state.type || "code"} | 상태: ${state.pipeline_type || "standard"}`,
    ];
    if (state.git && state.git.pipeline_branch) {
      pipelineLines.push(`  브랜치: ${state.git.pipeline_branch}`);
    }
    sections.push({ header: "활성 파이프라인", lines: pipelineLines });
  }

  // ── Failure Counter ──────────────────────────────────────
  const failureCounter = readFailureCounter(velaDir);
  if (failureCounter && failureCounter.count > 0) {
    sections.push({
      header: "실패 카운터",
      lines: [`  연속 실패: ${failureCounter.count}회 (단계: ${failureCounter.step})`],
    });
  }

  // ── Recent Learnings ─────────────────────────────────────
  const learnings = readRecentLearnings(velaDir, 3);
  if (learnings.length > 0) {
    sections.push({
      header: "최근 학습 패턴",
      lines: learnings.map((l) => `  • ${l}`),
    });
  }

  // ── Project Environment ──────────────────────────────────
  const skillDir = path.join(require("os").homedir(), ".claude", "skills", "vela");
  const env = readProjectEnv(cwd, skillDir);
  if (env && env.language !== "unknown") {
    const envLines = [`  언어: ${env.language}${env.hasTypeScript ? " (TypeScript)" : ""}`];
    if (env.framework) envLines.push(`  프레임워크: ${env.framework}`);
    if (env.testRunner) envLines.push(`  테스트: ${env.testRunner}${env.testDir ? ` (${env.testDir}/)` : ""}`);
    if (env.linter) envLines.push(`  린터: ${env.linter}`);
    sections.push({ header: "프로젝트 환경", lines: envLines });
  }

  // ── Git Context ──────────────────────────────────────────
  const gitCtx = readGitContext(cwd);
  if (gitCtx) {
    const gitLines = [`  브랜치: ${gitCtx.branch}`];
    if (gitCtx.recentCommits.length > 0) {
      gitLines.push("  최근 커밋:");
      gitCtx.recentCommits.forEach((c) => gitLines.push(`    ${c}`));
    }
    sections.push({ header: "Git", lines: gitLines });
  }

  // If nothing to show, silent exit
  if (sections.length === 0) {
    process.exit(0);
  }

  // ── Build Output ─────────────────────────────────────────
  const SEP = "━".repeat(47);
  const lines = [
    "",
    "⛵ VELA SESSION CONTEXT",
    SEP,
  ];
  for (const section of sections) {
    lines.push(`[${section.header}]`);
    lines.push(...section.lines);
    lines.push("");
  }
  lines.push(SEP);

  // Inject system instruction when pipeline is active
  if (pipelineResult) {
    lines.push("");
    lines.push("[SYSTEM INSTRUCTION FOR CLAUDE]");
    lines.push(`활성 파이프라인이 감지되었습니다 (단계: ${pipelineResult.state.current_step}).`);
    lines.push("작업을 계속하려면 PM이 vela-engine.js state로 현재 단계를 확인하세요.");
    lines.push("또는 /vela:start 로 새 파이프라인을 시작하세요.");
    lines.push("[END SYSTEM INSTRUCTION]");
  }
  lines.push("");

  process.stdout.write(lines.join("\n"));
  process.exit(0);
}

main().catch(() => process.exit(0));
