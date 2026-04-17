#!/usr/bin/env node
/**
 * Vela SessionStart Hook — Unified session hook (v8.0)
 *
 * Triggered on every Claude Code session start. Does two things:
 *
 *   1. VERSION CHECK — compares the locally-installed global Vela skill
 *      version against the latest GitHub main branch version. If a new
 *      version is available, injects a system instruction into session
 *      context telling Claude to ask the user whether to update.
 *      24-hour cache, 2s network timeout, silent on any error.
 *
 *   2. RICH CONTEXT — injects rich project and pipeline context into the
 *      session so Claude immediately understands the project state
 *      without extra exploration:
 *        - Active pipeline: step, request, auto mode, branch
 *        - Recent learnings: top 3 patterns from learnings.json
 *        - Failure counter: consecutive failures in current step
 *        - Project environment: language, framework, test runner
 *        - Git context: current branch + last 3 commits
 *
 * Both sections write to stdout, which SessionStart injects as session
 * context Claude can see. Always exits 0.
 *
 * Registered globally via deploy-common.sh register_session_start_hook().
 *
 * v7.3-M4b (2026-04-17): Merged from session-start-version-check.js
 * (209 lines) + vela-session-start.js (297 lines) → single vela-session.js.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFileSync } = require("child_process");

// ─── Version check constants ────────────────────────────────
const HOME = os.homedir();
const GLOBAL_SKILL_PACKAGE_JSON = path.join(
  HOME,
  ".claude",
  "skills",
  "vela",
  "package.json",
);
const CACHE_FILE = path.join(HOME, ".claude", "vela-version-check.json");
const REMOTE_PACKAGE_JSON_URL =
  "https://raw.githubusercontent.com/EcoKG/Vela-Skill/main/package.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NETWORK_TIMEOUT_MS = 2000;

// ─── Helpers ────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    });
    process.stdin.on("error", () => resolve(null));
  });
}

// ─── Version check ──────────────────────────────────────────

function fetchLatestVersion() {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    const req = https.get(REMOTE_PACKAGE_JSON_URL, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return done(null);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const pkg = JSON.parse(body);
          done(pkg.version || null);
        } catch {
          done(null);
        }
      });
    });

    req.on("error", () => done(null));
    req.setTimeout(NETWORK_TIMEOUT_MS, () => {
      req.destroy();
      done(null);
    });
  });
}

function compareVersions(a, b) {
  if (!a || !b) return 0;
  const parseVer = (v) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const va = parseVer(a);
  const vb = parseVer(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const ai = va[i] || 0;
    const bi = vb[i] || 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

/**
 * Check for new version. Returns a string block to prepend to stdout,
 * or empty string if no update available / Vela not installed.
 */
async function buildVersionCheckBlock() {
  // 1. Read local version
  const localPkg = readJsonSafe(GLOBAL_SKILL_PACKAGE_JSON);
  if (!localPkg || !localPkg.version) {
    return "";
  }
  const localVersion = localPkg.version;

  // 2. Check cache — skip network if recent
  let latestVersion = null;
  const cache = readJsonSafe(CACHE_FILE);
  const now = Date.now();
  const cacheValid =
    cache &&
    typeof cache.checkedAt === "number" &&
    now - cache.checkedAt < CACHE_TTL_MS &&
    cache.latestVersion;

  if (cacheValid) {
    latestVersion = cache.latestVersion;
  } else {
    latestVersion = await fetchLatestVersion();
    if (!latestVersion) {
      return "";
    }
    writeJsonSafe(CACHE_FILE, {
      checkedAt: now,
      localVersion,
      latestVersion,
    });
  }

  // 3. Compare versions
  const cmp = compareVersions(latestVersion, localVersion);
  if (cmp <= 0) return "";

  // 4. Build update notice
  return [
    "",
    "⛵ VELA UPDATE AVAILABLE",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `  Current: v${localVersion}`,
    `  Latest:  v${latestVersion}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "[SYSTEM INSTRUCTION FOR CLAUDE]",
    `Vela 엔진의 새 버전(v${latestVersion})이 릴리스되었습니다. 현재 설치된 버전은 v${localVersion}입니다.`,
    "",
    "다음 절차를 수행하세요:",
    `1. AskUserQuestion으로 "⛵ Vela 엔진에 새 버전(v${localVersion} → v${latestVersion})이 있습니다. 지금 업데이트할까요?" 라고 물어보세요. 선택지는 "지금 업데이트 (Recommended)", "나중에" 두 개.`,
    '2. 사용자가 "지금 업데이트"를 선택하면 `/vela:update` 스킬을 실행하세요.',
    '3. 사용자가 "나중에" 또는 "None of the above"를 선택하면 이 지시사항을 무시하고 멈추세요.',
    "4. 별도의 인사나 설명 없이 바로 이 질문부터 먼저 보여주세요.",
    "",
    "[END SYSTEM INSTRUCTION]",
    "",
  ].join("\n");
}

// ─── Rich context (active pipeline / git / env / learnings) ──

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
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return null;
}

function readRecentLearnings(velaDir, n) {
  try {
    const learningsPath = path.join(velaDir, "learnings", "learnings.json");
    if (!fs.existsSync(learningsPath)) return [];

    const raw = readJsonSafe(learningsPath);
    if (!raw || !Array.isArray(raw.learnings)) return [];

    return raw.learnings
      .slice(-n)
      .reverse()
      .flatMap((entry) => {
        if (!entry || !Array.isArray(entry.patterns)) return [];
        return entry.patterns
          .filter(
            (p) =>
              p &&
              (p.category === "weakness" ||
                p.category === "recurring_issue"),
          )
          .slice(0, 2)
          .map(
            (p) =>
              `[${p.category}] ${p.description}${
                p.frequency !== "first_time" ? ` (${p.frequency})` : ""
              }`,
          );
      })
      .slice(0, n);
  } catch {
    return [];
  }
}

function readGitContext(cwd) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    })
      .toString()
      .trim();

    const log = execFileSync("git", ["log", "--oneline", "-3"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    })
      .toString()
      .trim();

    const recentCommits = log
      .split("\n")
      .filter(Boolean)
      .map((l) => l.trim());

    return { branch, recentCommits };
  } catch {
    return null;
  }
}

function readFailureCounter(velaDir) {
  return readJsonSafe(path.join(velaDir, "state", "failure-counter.json"));
}

function readProjectEnv(cwd, skillDir) {
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
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * v8.0-M4: detect pre-plugin (v7.x) Vela installation leftovers that
 * would cause hook-firing duplication (legacy settings.json entry
 * runs alongside the plugin-registered hook). Returns an array of
 * findings, empty array if clean.
 */
function detectLegacyInstallation() {
  const findings = [];

  // Only report legacy when plugin is active — otherwise v7.x is the
  // expected state and we don't want to nag users who haven't
  // migrated yet.
  if (!process.env.CLAUDE_PLUGIN_ROOT) return findings;

  // 1. ~/.vela/hooks/ directory exists
  const legacyHooksDir = path.join(HOME, ".vela", "hooks");
  if (fs.existsSync(legacyHooksDir)) {
    try {
      const files = fs.readdirSync(legacyHooksDir).filter((f) => f.endsWith(".js"));
      if (files.length > 0) {
        findings.push(`~/.vela/hooks/ (${files.length} .js files, pre-plugin layout)`);
      }
    } catch {
      /* unreadable — skip */
    }
  }

  // 2. ~/.claude/skills/vela*/ directories
  const skillsRoot = path.join(HOME, ".claude", "skills");
  if (fs.existsSync(skillsRoot)) {
    try {
      for (const name of fs.readdirSync(skillsRoot)) {
        if (name === "vela" || name.startsWith("vela-")) {
          findings.push(`~/.claude/skills/${name}/ (pre-plugin skill)`);
          break; // one is enough to signal
        }
      }
    } catch {
      /* unreadable — skip */
    }
  }

  // 3. ~/.claude/settings.json _velaId entries
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = readJsonSafe(settingsPath);
      if (settings && settings.hooks) {
        let count = 0;
        for (const event of Object.keys(settings.hooks)) {
          for (const entry of settings.hooks[event]) {
            if (entry && entry._velaId && entry._velaId.startsWith("vela-")) count++;
          }
        }
        if (count > 0) {
          findings.push(`${count} legacy _velaId entries in ~/.claude/settings.json`);
        }
      }
    } catch {
      /* skip */
    }
  }

  return findings;
}

/**
 * Build rich context block. Returns a string or empty string if
 * there's nothing to show.
 */
function buildContextBlock(cwd) {
  const velaDir = path.join(cwd, ".vela");

  // If .vela/ does not exist, this project has no Vela — no context
  if (!fs.existsSync(velaDir)) return "";

  const config = readJsonSafe(path.join(velaDir, "config.json"));
  const sections = [];

  // ── Prompt Cache TTL Check (v7.2 M1) ─────────────────────
  try {
    const cacheCfg = config && config.cache;
    const wantsOneHour = cacheCfg && cacheCfg.ttl === "1h";
    const envOn =
      process.env.ENABLE_PROMPT_CACHING_1H === "1" ||
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
  } catch {
    /* non-fatal */
  }

  // ── Active Pipeline ──────────────────────────────────────
  const pipelineResult = findActivePipeline(velaDir);
  if (pipelineResult) {
    const { state } = pipelineResult;
    const completedCount = Array.isArray(state.completed_steps)
      ? state.completed_steps.length
      : 0;
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
      lines: [
        `  연속 실패: ${failureCounter.count}회 (단계: ${failureCounter.step})`,
      ],
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
  const skillDir = path.join(HOME, ".claude", "skills", "vela");
  const env = readProjectEnv(cwd, skillDir);
  if (env && env.language !== "unknown") {
    const envLines = [
      `  언어: ${env.language}${env.hasTypeScript ? " (TypeScript)" : ""}`,
    ];
    if (env.framework) envLines.push(`  프레임워크: ${env.framework}`);
    if (env.testRunner)
      envLines.push(
        `  테스트: ${env.testRunner}${env.testDir ? ` (${env.testDir}/)` : ""}`,
      );
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

  if (sections.length === 0) return "";

  // ── Build Output ─────────────────────────────────────────
  const SEP = "━".repeat(47);
  const lines = ["", "⛵ VELA SESSION CONTEXT", SEP];
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
    lines.push(
      `활성 파이프라인이 감지되었습니다 (단계: ${pipelineResult.state.current_step}).`,
    );
    lines.push(
      "작업을 계속하려면 PM이 vela-engine.js state로 현재 단계를 확인하세요.",
    );
    lines.push("또는 /vela:ship 로 새 파이프라인을 시작하세요.");
    lines.push("[END SYSTEM INSTRUCTION]");
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────

/**
 * v8.0-M4: emit a standalone legacy-installation warning block that
 * fires even when the current project has no .vela/ (so users see
 * the nudge as soon as they open Claude Code in any project after
 * installing the plugin on top of a v7.x curl install).
 */
function buildLegacyBlock() {
  const findings = detectLegacyInstallation();
  if (findings.length === 0) return "";
  const SEP = "━".repeat(47);
  const lines = [
    "",
    "⚠️  LEGACY VELA INSTALLATION DETECTED",
    SEP,
    "Pre-plugin (v7.x curl-install) leftovers present:",
    ...findings.map((f) => `  • ${f}`),
    "",
    "Each hook event currently fires twice (legacy + plugin).",
    "Run `/vela:install --cleanup-legacy=auto` to migrate cleanly.",
    SEP,
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const input = await readStdin();
  const cwd =
    (input && typeof input.cwd === "string" && input.cwd) || process.cwd();

  // Run version check and context build in parallel to minimize hook time.
  // Legacy block is cheap (3 filesystem checks) so it runs inline.
  const [versionBlock, contextBlock] = await Promise.all([
    buildVersionCheckBlock().catch(() => ""),
    Promise.resolve().then(() => {
      try {
        return buildContextBlock(cwd);
      } catch {
        return "";
      }
    }),
  ]);

  let legacyBlock = "";
  try {
    legacyBlock = buildLegacyBlock();
  } catch {
    /* non-fatal */
  }

  const output = versionBlock + legacyBlock + contextBlock;
  if (output) {
    process.stdout.write(output);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
