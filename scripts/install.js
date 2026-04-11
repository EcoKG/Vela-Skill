#!/usr/bin/env node
/**
 * Vela Installer
 *
 * Registers Vela permissions, agent, and UI settings into the
 * PROJECT-LOCAL .claude/settings.local.json.
 *
 * Why project-local instead of global (~/.claude/settings.json)?
 * - Vela is a sandbox — settings should not leak outside the project
 * - No performance overhead on non-Vela projects
 * - Multiple Vela projects can have independent configurations
 * - Deleting the project automatically removes registrations
 *
 * Usage:
 *   node install.js                    — Install Vela settings
 *   node install.js verify             — Verify installation
 *   node install.js upgrade            — Update all Vela files to latest version
 *   node install.js uninstall          — Remove all Vela settings
 *   node install.js status             — Show current status
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJECT_ROOT = findProjectRoot(process.cwd());
const SETTINGS_PATH = path.join(PROJECT_ROOT, ".claude", "settings.local.json");
const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const GLOBAL_VELA_HOOKS_DIR = path.join(os.homedir(), ".vela", "hooks");

/**
 * Walk up from cwd to find the project root (where .vela/ lives).
 */
function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".vela"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

const HOOK_PREFIX = "vela-";

// ─── Permission deny rules ───
// Claude Code's deny rules are absolute — denied at any level = blocked everywhere.
// These rules provide a second layer of defense alongside Gate Keeper/Guard hooks.
const VELA_PERMISSIONS = {
  deny: [
    // Destructive file operations
    "Bash(rm -rf *)",
    "Bash(rm -r *)",
    // Force push — all variants
    "Bash(git push --force *)",
    "Bash(git push -f *)",
    "Bash(git push --force-with-lease *)",
    "Bash(git push origin +*)",
    // Hard reset — destroys uncommitted work
    "Bash(git reset --hard *)",
    // Skip hooks — Vela hooks must never be bypassed
    "Bash(git commit --no-verify *)",
    "Bash(git commit -n *)",
    // Clean untracked files — can delete work
    "Bash(git clean -f *)",
    "Bash(git clean -fd *)",
    // Direct database drops
    "Bash(drop database *)",
    "Bash(DROP DATABASE *)",
  ],
  allow: [
    // Vela CLI tools — always allowed through Bash
    "Bash(node .vela/*)",
    "Bash(python .vela/*)",
    "Bash(python3 .vela/*)",
    // Read-only tools — eliminate repetitive permission prompts
    "Read(*)",
    "Glob(*)",
    "Grep(*)",
  ],
};

// ─── File Manifest (single source of truth for managed files) ───

const FILE_MANIFEST = [
  // Shared modules (used by CLI tools)
  { src: "scripts/shared/constants.js", dst: "shared/constants.js" },
  { src: "scripts/shared/dep-analyzer.js", dst: "shared/dep-analyzer.js" },
  { src: "scripts/shared/global-require.js", dst: "shared/global-require.js" },
  { src: "scripts/shared/sprint-manager.js", dst: "shared/sprint-manager.js" },
  { src: "scripts/shared/worktree-manager.js", dst: "shared/worktree-manager.js" },
  { src: "scripts/shared/change-surface.js", dst: "shared/change-surface.js" },
  // v6.1 Universal Locate (used by vela-engine locate command)
  { src: "scripts/shared/locate.js", dst: "shared/locate.js" },
  // Environment detection (used by session-start hook)
  { src: "scripts/shared/project-env.js", dst: "shared/project-env.js" },
  // CLI tools (V6 — no SDK orchestrators)
  { src: "scripts/cli/vela-engine.js", dst: "cli/vela-engine.js" },
  { src: "scripts/cli/vela-analyze.js", dst: "cli/vela-analyze.js" },
  { src: "scripts/cli/vela-cost.js", dst: "cli/vela-cost.js" },
  { src: "scripts/cli/vela-report.js", dst: "cli/vela-report.js" },
  // Cache
  { src: "scripts/cache/treenode.js", dst: "cache/treenode.js" },
  // Root-level managed files
  { src: "scripts/statusline.sh", dst: "statusline.sh" },
  // PM agent file
  { src: "scripts/agents/vela.md", dst: "agents/vela.md" },
  // V6 role agents (deployed to .vela/agents/ AND .claude/agents/)
  { src: "scripts/agents/vela-researcher.md", dst: "agents/vela-researcher.md" },
  { src: "scripts/agents/vela-planner.md", dst: "agents/vela-planner.md" },
  { src: "scripts/agents/vela-executor.md", dst: "agents/vela-executor.md" },
  { src: "scripts/agents/vela-reviewer.md", dst: "agents/vela-reviewer.md" },
  { src: "scripts/agents/vela-plan-checker.md", dst: "agents/vela-plan-checker.md" },
  { src: "scripts/agents/vela-verifier.md", dst: "agents/vela-verifier.md" },
  { src: "scripts/agents/vela-diff-summary.md", dst: "agents/vela-diff-summary.md" },
  { src: "scripts/agents/vela-learning.md", dst: "agents/vela-learning.md" },
  { src: "scripts/agents/vela-sprint-planner.md", dst: "agents/vela-sprint-planner.md" },
  { src: "scripts/agents/vela-analyzer.md", dst: "agents/vela-analyzer.md" },
  // Templates
  { src: "templates/pipeline.json", dst: "templates/pipeline.json" },
  {
    src: "templates/config.json",
    dst: "templates/config.json",
    skipOnUpgrade: true,
  },
  // v7.1 M3 — verifier Phase 0/3 templates. Example-only files live
  // under .vela/templates/guidelines/ so users can copy them to
  // .vela/guidelines/*.json or .vela/guidelines/*.sh when they need
  // them. Install.js ships them as examples — never overwrites a
  // file the user copied into the active guidelines dir.
  {
    src: "templates/guidelines/live-processes.json",
    dst: "templates/guidelines/live-processes.json",
  },
  {
    src: "templates/guidelines/smoke-test.sh.example",
    dst: "templates/guidelines/smoke-test.sh.example",
  },
  // v7.1 M4 — Architecture Guardrails sample plan. vela-planner.md
  // references this to show what Allowed/Forbidden/Injection sections
  // look like. Deployed to .vela/templates/plan-templates/quick.md so
  // planners can open it as a starting skeleton.
  {
    src: "templates/plan-templates/quick.md",
    dst: "templates/plan-templates/quick.md",
  },
  // v7.1 M9 — per-scale tool_use budgets. PM injects the budget for
  // each Agent spawn; exceeding triggers a budget-exceeded.json marker
  // inside artifactDir (non-fatal). /vela:analyze rolls them up.
  {
    src: "templates/role-budgets.json",
    dst: "templates/role-budgets.json",
  },
  // References
  { src: "references/interactive-ui.md", dst: "references/interactive-ui.md" },
  {
    src: "references/gates-and-guards.md",
    dst: "references/gates-and-guards.md",
  },
  { src: "references/cli-reference.md", dst: "references/cli-reference.md" },
  { src: "references/messages-en.md", dst: "references/messages-en.md" },
  // Agent tree — PM
  { src: "scripts/agents/pm/index.md", dst: "agents/pm/index.md" },
  {
    src: "scripts/agents/pm/prompt-optimizer.md",
    dst: "agents/pm/prompt-optimizer.md",
  },
  {
    src: "scripts/agents/pm/pipeline-flow.md",
    dst: "agents/pm/pipeline-flow.md",
  },
  { src: "scripts/agents/pm/team-rules.md", dst: "agents/pm/team-rules.md" },
  {
    src: "scripts/agents/pm/model-strategy.md",
    dst: "agents/pm/model-strategy.md",
  },
  {
    src: "scripts/agents/pm/block-recovery.md",
    dst: "agents/pm/block-recovery.md",
  },
  {
    src: "scripts/agents/pm/failure-recovery.md",
    dst: "agents/pm/failure-recovery.md",
  },
  // Agent tree — Researcher
  {
    src: "scripts/agents/researcher/index.md",
    dst: "agents/researcher/index.md",
  },
  {
    src: "scripts/agents/researcher/hypothesis.md",
    dst: "agents/researcher/hypothesis.md",
  },
  {
    src: "scripts/agents/researcher/security.md",
    dst: "agents/researcher/security.md",
  },
  {
    src: "scripts/agents/researcher/architecture.md",
    dst: "agents/researcher/architecture.md",
  },
  {
    src: "scripts/agents/researcher/quality.md",
    dst: "agents/researcher/quality.md",
  },
  // Agent tree — Executor
  { src: "scripts/agents/executor/index.md", dst: "agents/executor/index.md" },
  { src: "scripts/agents/executor/tdd.md", dst: "agents/executor/tdd.md" },
  {
    src: "scripts/agents/executor/file-ownership.md",
    dst: "agents/executor/file-ownership.md",
  },
  {
    src: "scripts/agents/executor/worktree.md",
    dst: "agents/executor/worktree.md",
  },
  // Agent tree — Planner (only files read by vela-planner.md)
  {
    src: "scripts/agents/planner/spec-format.md",
    dst: "agents/planner/spec-format.md",
  },
  {
    src: "scripts/agents/planner/crosslayer.md",
    dst: "agents/planner/crosslayer.md",
  },
  // Agent tree — Reviewer (only files read by vela-reviewer.md)
  {
    src: "scripts/agents/reviewer/scoring.md",
    dst: "agents/reviewer/scoring.md",
  },
  // Guidelines
  { src: "scripts/guidelines/index.md", dst: "guidelines/index.md" },
  {
    src: "scripts/guidelines/coding-standards.md",
    dst: "guidelines/coding-standards.md",
  },
  {
    src: "scripts/guidelines/error-handling.md",
    dst: "guidelines/error-handling.md",
  },
  {
    src: "scripts/guidelines/testing-strategy.md",
    dst: "guidelines/testing-strategy.md",
  },
  // Hooks (staging for registerGlobalHooks — copied to ~/.vela/hooks/ at install time)
  { src: "scripts/hooks/vela-gate-keeper.js", dst: "hooks/vela-gate-keeper.js" },
  { src: "scripts/hooks/vela-gate-guard.js",  dst: "hooks/vela-gate-guard.js"  },
  { src: "scripts/hooks/vela-stop.js",        dst: "hooks/vela-stop.js"        },
  { src: "scripts/hooks/vela-review-gate.js", dst: "hooks/vela-review-gate.js" },
  // v7.1 M10 — file read cache hook. Purely observational (exit 0 on
  // every call). Logs Read calls to <artifactDir>/read-cache.jsonl
  // so vela-stop.js and /vela:analyze can aggregate duplicates.
  { src: "scripts/hooks/vela-file-read-cache.js", dst: "hooks/vela-file-read-cache.js" },
  { src: "scripts/hooks/shared/constants.js", dst: "hooks/shared/constants.js" },
];

// Subdirectories managed by Vela — orphan cleanup scans only these.
// Never touch: config.json (root), persona.md (root), install.js (root),
// state/, artifacts/, templates/, test-fixtures/, statusline.sh (root)
const MANAGED_DIRS = [
  "shared",
  "cli",
  "cache",
  "agents",
  "guidelines",
  "references",
  "hooks",
];

/**
 * Recursively collect all files under a directory.
 * Returns paths relative to baseDir (e.g. 'hooks/old-file.js').
 */
function collectFiles(dir, baseDir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  return files;
}

/**
 * v7.0.7: Pin the workspace root.
 *
 * Claude Code's Bash tool has a persistent working directory — a bare
 * `cd subdir` inside one tool call changes cwd for every later tool
 * call in the same session. When the PM later runs
 * `node .vela/cli/vela-engine.js state`, Node's module loader resolves
 * the relative path against whatever directory the Bash tool is now
 * parked in, and fails at load time with "Cannot find module".
 *
 * v7.0.6 patched this via a walk-up search for `.vela/`. That works,
 * but it's a heuristic: it can pick the wrong ancestor on symlinked
 * trees, bind mounts, or nested Vela projects, and it hides the fact
 * that cwd ever drifted in the first place.
 *
 * v7.0.7 replaces the heuristic with an explicit record. At install,
 * upgrade, and validate time we write an absolute path to
 * `.vela/state/workspace.json`. The engine reads that file on every
 * invocation and chdirs back to it (loudly, via stderr warning) if
 * cwd has drifted. `.vela/state/` is already gitignored, so this
 * record is per-checkout and safe for multi-user / multi-environment
 * use. If the user later `mv`s the project, the recorded path goes
 * stale and the engine emits a clear error pointing at the fix
 * (re-run `node .vela/install.js validate`) rather than silently
 * running in the wrong directory.
 */
function writeWorkspaceRecord(projectRoot) {
  try {
    const stateDir = path.join(projectRoot, ".vela", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const record = {
      projectRoot,
      recordedAt: new Date().toISOString(),
      recordedBy: "install.js",
      hostName: os.hostname(),
    };
    // Read velaVersion from the deployed skill's package.json for
    // diagnostics. Best-effort — version is informational only.
    try {
      const pkgPath = path.resolve(__dirname, "..", "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg && pkg.version) record.velaVersion = pkg.version;
      }
    } catch {
      /* version is optional */
    }
    fs.writeFileSync(
      path.join(stateDir, "workspace.json"),
      JSON.stringify(record, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Find orphan files in managed subdirectories of velaDir.
 * An orphan is any file inside MANAGED_DIRS that is NOT in FILE_MANIFEST's dst list.
 * Returns array of relative paths (e.g. 'agents/old-file.md').
 */
function findOrphans(velaDir) {
  const managedDsts = new Set(FILE_MANIFEST.map((f) => f.dst));
  const orphans = [];
  for (const dir of MANAGED_DIRS) {
    const dirPath = path.join(velaDir, dir);
    const files = collectFiles(dirPath, velaDir);
    for (const file of files) {
      if (!managedDsts.has(file)) {
        orphans.push(file);
      }
    }
  }
  return orphans;
}

/**
 * Remove empty directories bottom-up within managed dirs.
 * Only removes dirs that are completely empty after orphan deletion.
 */
function removeEmptyDirs(velaDir) {
  const removed = [];
  for (const dir of MANAGED_DIRS) {
    const dirPath = path.join(velaDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    // Walk bottom-up: collect all subdirs, sort by depth descending
    const subdirs = [];
    function walkDirs(d) {
      if (!fs.existsSync(d)) return;
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const full = path.join(d, entry.name);
          walkDirs(full);
          subdirs.push(full);
        }
      }
    }
    walkDirs(dirPath);
    // Sort deepest first
    subdirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
    for (const sd of subdirs) {
      try {
        const entries = fs.readdirSync(sd);
        if (entries.length === 0) {
          fs.rmdirSync(sd);
          removed.push(path.relative(velaDir, sd));
        }
      } catch (e) {
        /* permission or race — skip */
      }
    }
  }
  return removed;
}

// ─── Config Migration (shallow merge for upgrade) ───

/**
 * Migrate user config.json by shallow-merging new template keys.
 * - Adds top-level keys from template that are missing in user config
 * - Never overwrites existing user values
 * - Restores entire template if user config is broken JSON
 * - Skips if user config.json doesn't exist (fresh install — config comes from install())
 *
 * @param {string} velaDir - Path to .vela/ in the target project
 * @param {string} skillBase - Path to the skill repository root
 * @returns {{ added: string[], preserved: string[], restored: boolean, skipped: boolean }}
 */
function migrateConfig(velaDir, skillBase) {
  const result = { added: [], preserved: [], restored: false, skipped: false };

  const userConfigPath = path.join(velaDir, "config.json");
  const templatePath = path.join(skillBase, "templates", "config.json");

  // No user config → fresh install, skip (install() copies config.json)
  if (!fs.existsSync(userConfigPath)) {
    result.skipped = true;
    return result;
  }

  // Load template
  let template;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
  } catch (e) {
    // Template itself is broken or missing — nothing to merge from
    result.skipped = true;
    return result;
  }

  // Load user config
  let userConfig;
  try {
    const raw = fs.readFileSync(userConfigPath, "utf-8");
    if (raw.trim() === "") throw new Error("empty file");
    userConfig = JSON.parse(raw);
  } catch (e) {
    // Broken or empty user config → restore entire template
    fs.writeFileSync(userConfigPath, JSON.stringify(template, null, 2));
    result.restored = true;
    result.added = Object.keys(template);
    return result;
  }

  // Shallow merge: add missing top-level keys only
  let changed = false;
  for (const key of Object.keys(template)) {
    if (!(key in userConfig)) {
      userConfig[key] = template[key];
      result.added.push(key);
      changed = true;
    } else {
      result.preserved.push(key);
    }
  }

  if (changed) {
    fs.writeFileSync(userConfigPath, JSON.stringify(userConfig, null, 2));
  }

  return result;
}

const command =
  process.argv[2] && !process.argv[2].startsWith("-")
    ? process.argv[2]
    : "install";

switch (command) {
  case "install":
    install();
    break;
  case "verify":
    verify();
    break;
  case "uninstall":
    uninstall();
    break;
  case "validate": {
    const results = validate();
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: "validate",
          fixed: results.fixed.length,
          refreshed: results.refreshed.length,
          warnings: results.warnings.length,
          details: results,
        },
        null,
        2,
      ),
    );
    break;
  }
  case "status":
    status();
    break;
  case "upgrade":
    upgrade();
    break;
  default:
    console.log(
      JSON.stringify({ ok: false, error: `Unknown command: ${command}` }),
    );
    process.exit(1);
}

function install() {
  // ─── Phase 0: Validate & Repair ───
  const validation = validate();

  // Ensure .claude/ directory exists
  const claudeDir = path.join(PROJECT_ROOT, ".claude");
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settings = readSettings();

  const errors = [];

  // ─── Register permission rules ───
  if (!settings.permissions) {
    settings.permissions = {};
  }

  // Merge deny rules (deduplicate)
  const existingDeny = new Set(settings.permissions.deny || []);
  for (const rule of VELA_PERMISSIONS.deny) {
    existingDeny.add(rule);
  }
  settings.permissions.deny = [...existingDeny];

  // Merge allow rules (deduplicate)
  const existingAllow = new Set(settings.permissions.allow || []);
  for (const rule of VELA_PERMISSIONS.allow) {
    existingAllow.add(rule);
  }
  settings.permissions.allow = [...existingAllow];

  // ─── Set default agent to vela ───
  settings.agent = "vela";

  // ─── Set statusLine ───
  const statusLinePath = path.join(PROJECT_ROOT, ".vela", "statusline.sh");
  if (fs.existsSync(statusLinePath)) {
    settings.statusLine = {
      type: "command",
      command: statusLinePath,
      padding: 2,
    };
  }

  // ─── Spinner Verbs (항해 테마) ───
  settings.spinnerVerbs = {
    mode: "replace",
    verbs: [
      "⛵ 돛을 올리는 중",
      "🧭 해도를 펼치는 중",
      "✦ 별자리를 읽는 중",
      "🔭 수평선을 살피는 중",
      "⚓ 닻을 내리는 중",
      "🌟 항성을 추적하는 중",
      "🌊 조류를 읽는 중",
      "⛵ 순풍을 잡는 중",
      "✦ 자오선을 넘는 중",
      "🧭 경도를 측정하는 중",
      "🔭 성운을 관측하는 중",
      "🌟 천구를 회전하는 중",
    ],
  };

  // ─── Spinner Tips (Vela 철학) ───
  settings.spinnerTipsOverride = {
    excludeDefault: true,
    tips: [
      "⛵ 별을 따라 항해하라 — 모든 파이프라인은 목적지로 향한다",
      "🌟 품질은 지시가 아닌 구조로 강제된다",
      "🧭 연구 → 계획 → 실행 → 검증 — 항로를 건너뛰지 마라",
      "✦ Reviewer는 독립적으로 판단한다 — 편향 없는 별빛",
      "⛵ Vela(돛자리)는 하늘에서 가장 큰 별자리의 일부였다",
      "🔭 각 단계는 산출물로 증명된다 — 기록 없는 항해는 없다",
      "🧭 /vela:start 로 새로운 항해를 시작하세요",
      "✦ 같은 세션에서 자기 작업을 검증하면 편향이 생긴다",
      "⚓ Gate Keeper는 수문장, Gate Guard는 항해 규칙의 안내자",
      "🌟 승인 없이는 다음 항구로 갈 수 없다 — 검증이 통행증이다",
      "🌊 Agent Teams — 독립된 선원들이 각자의 관점으로 항해한다",
      "⛵ 구조로 강제하라, 지시에 의존하지 마라",
    ],
  };

  // ─── Startup Announcements ───
  settings.companyAnnouncements = [
    "⛵ Vela Engine 기관 점화 — 별자리가 오늘의 항로를 안내합니다.",
    "✦ 구조로 강제하고, 독립으로 검증하고, 기록으로 추적한다 — Vela의 세 가지 원칙.",
    "🧭 연구 → 계획 → 실행 → 검증. 돛자리의 네 별이 항로를 비춥니다.",
    "🌟 모든 위대한 항해는 첫 닻을 올리는 것에서 시작됩니다. /vela:start",
  ];

  // ─── Attribution (커밋/PR에 Vela 참조) ───
  settings.attribution = {
    commit: "⛵ Navigated by Vela Engine (https://github.com/EcoKG/vela)",
    pr: "⛵ This PR was navigated by [Vela Engine](https://github.com/EcoKG/vela) — 별자리 항해 기반 개발 거버넌스.",
  };

  // ─── Auto Mode (sandbox-safe bash auto-allow) ───
  settings.autoMode = {
    allow: [
      "Bash commands within .vela/ directory",
      "Bash commands for git status, log, diff, branch",
      "Read operations on any file",
    ],
    soft_deny: [
      "Bash commands that modify files outside .vela/",
      "Git push, reset, clean operations",
    ],
    environment: [
      "Project uses Vela pipeline governance",
      "All modifications require active pipeline",
    ],
  };

  // ─── V6.2: Hooks are now GLOBAL (registered in ~/.claude/settings.json) ───
  // settings.local.json manages permissions + agent + statusLine only.
  // Migration: remove any per-project hook entries from settings.local.json.
  if (settings.hooks) {
    delete settings.hooks;
  }

  writeSettings(settings);

  // ─── Register global hooks ───
  // Copies hook scripts to ~/.vela/hooks/ and registers them in ~/.claude/settings.json.
  // Hooks self-activate only when an active Vela pipeline is found (process.cwd()).
  const hooksVelaDir = path.join(PROJECT_ROOT, ".vela", "hooks");
  registerGlobalHooks(hooksVelaDir);

  // Create state directory for session tracking (project-local)
  const stateDir = path.join(PROJECT_ROOT, ".vela", "state");
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // ─── Deploy vela agents to .claude/agents/ ───
  // V6: PM + all role agents are deployed so PM can spawn them via Agent tool.
  const agentsDir = path.join(PROJECT_ROOT, ".claude", "agents");
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }
  const CLAUDE_AGENTS = [
    "vela.md",
    "vela-researcher.md",
    "vela-planner.md",
    "vela-executor.md",
    "vela-reviewer.md",
    "vela-plan-checker.md",
    "vela-verifier.md",
    "vela-diff-summary.md",
    "vela-learning.md",
    "vela-sprint-planner.md",
    "vela-analyzer.md",
  ];
  for (const agentFile of CLAUDE_AGENTS) {
    const src = path.join(PROJECT_ROOT, ".vela", "agents", agentFile);
    const dst = path.join(agentsDir, agentFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  // ─── Create CLAUDE.md if not exists ───
  const claudeMdPath = path.join(PROJECT_ROOT, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(
      claudeMdPath,
      `# Development Workflow — Vela V6

This project uses Vela for development governance.

- To explore/read code: use normal tools freely (Explore mode).
- To modify code: ALWAYS start with \`node .vela/cli/vela-engine.js init "<task>"\` then follow the pipeline steps.
- PM (vela agent) orchestrates the pipeline by spawning role agents via the Agent tool.
- Follow pipeline steps in order. Do NOT skip steps or bypass the pipeline.
- Do NOT modify pipeline-state.json directly — use vela-engine.js CLI only.

## Bash tool — never use bare \`cd\` inside a single invocation

Claude Code's Bash tool has a persistent working directory that survives
between tool calls. A bare \`cd subdir\` inside one Bash invocation will
cause every subsequent Bash call (including the PM's
\`node .vela/cli/vela-engine.js ...\` invocations) to run from that
subdirectory, and Node's module loader will fail with \`Cannot find
module\` before the engine ever runs.

- **Wrong**: \`cd server/data && node build.js\` (leaks the cwd change)
- **Right**: \`( cd server/data && node build.js )\` (subshell isolates it)
- **Also right**: pass absolute paths — \`node /abs/path/to/build.js\`

Vela v7.0.7+ records the true project root in
\`.vela/state/workspace.json\` at install time and the engine will
\`chdir\` back on every invocation if cwd has drifted, printing a
warning to stderr. Treat that warning as a bug in the calling code
(usually a stray \`cd\` inside a Bash tool) and fix it rather than
relying on the auto-recovery.
`,
    );
  }

  // ─── Pin the workspace root (v7.0.7) ───
  // Writes .vela/state/workspace.json with PROJECT_ROOT so the engine
  // can chdir back on every invocation regardless of how the Bash tool's
  // working directory has drifted mid-session. Runs on EVERY install,
  // not just first-time ones, so existing projects get the pin after
  // an `upgrade` or `validate` too. Silent on failure — the walk-up
  // fallback in vela-engine.js still works.
  writeWorkspaceRecord(PROJECT_ROOT);

  // Human-readable output (JSON with --json flag)
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0,
          command: "install",
          validation,
          agent: "vela",
          permissions: {
            deny: VELA_PERMISSIONS.deny.length,
            allow: VELA_PERMISSIONS.allow.length,
          },
          errors,
          settings_path: SETTINGS_PATH,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("");
    console.log("✦ Vela Engine — Installation Complete ✦");
    console.log("");
    console.log(
      `  🌟 Permissions: ${VELA_PERMISSIONS.deny.length} deny + ${VELA_PERMISSIONS.allow.length} allow`,
    );
    console.log(`  🧭 Agent: vela`);
    console.log(`  🔭 StatusLine: active`);
    console.log(`  ✦ Spinner: ${12} nautical verbs`);
    console.log(
      `  ⛵ CLAUDE.md: ${fs.existsSync(claudeMdPath) ? "exists" : "created"}`,
    );
    if (validation.fixed.length > 0) {
      console.log("");
      console.log("  🔧 Auto-repaired:");
      validation.fixed.forEach((f) => console.log(`     ✓ ${f}`));
    }
    if (validation.warnings.length > 0) {
      console.log("");
      console.log("  ⚠ Warnings:");
      validation.warnings.forEach((w) => console.log(`     ! ${w}`));
    }
    if (errors.length > 0) {
      console.log("");
      console.log("  ❌ Errors:");
      errors.forEach((e) => console.log(`     ✗ ${e}`));
    }
    console.log("");
    console.log("✦─────────────────────✦");
    console.log("");
  }
}

function verify() {
  const settings = readSettings();
  const results = [];
  const velaDir = path.join(PROJECT_ROOT, ".vela");
  const skillBase = path.resolve(__dirname, "..");

  // Verify FILE_MANIFEST files exist at destination
  let missingFiles = 0;
  for (const f of FILE_MANIFEST) {
    const dstPath = path.join(velaDir, f.dst);
    const exists = fs.existsSync(dstPath);
    if (!exists) missingFiles++;
    results.push({ file: f.dst, exists, status: exists ? "OK" : "MISSING" });
  }

  // Verify permissions are registered
  const denyOk = VELA_PERMISSIONS.deny.every((r) =>
    (settings.permissions?.deny || []).includes(r),
  );
  const allowOk = VELA_PERMISSIONS.allow.every((r) =>
    (settings.permissions?.allow || []).includes(r),
  );

  const allOk = missingFiles === 0 && denyOk && allowOk;

  console.log(
    JSON.stringify(
      {
        ok: allOk,
        command: "verify",
        files: results,
        permissions: { deny: denyOk, allow: allowOk },
        message: allOk
          ? "All Vela files and permissions verified successfully."
          : `Verification issues: ${missingFiles} missing files, deny=${denyOk}, allow=${allowOk}`,
      },
      null,
      2,
    ),
  );
}

function uninstall() {
  const settings = readSettings();
  let removedHooks = 0;
  let removedPerms = 0;

  // Remove hooks (both new and legacy format)
  if (settings.hooks) {
    for (const matcher of Object.keys(settings.hooks)) {
      const before = settings.hooks[matcher].length;
      settings.hooks[matcher] = settings.hooks[matcher].filter((entry) => {
        // Remove _velaId prompt hooks (check before nested format — entry may have both)
        if (entry._velaId && entry._velaId.startsWith(HOOK_PREFIX))
          return false;
        // Remove legacy flat format: { command: "...vela...", description: "..." }
        if (
          entry.command &&
          !entry.hooks &&
          entry.command.includes(HOOK_PREFIX)
        )
          return false;
        // Remove new nested format: { matcher, hooks: [{ command: "...vela..." }] }
        if (entry.hooks && Array.isArray(entry.hooks)) {
          return !entry.hooks.some(
            (h) => h.command && h.command.includes(HOOK_PREFIX),
          );
        }
        return true;
      });
      removedHooks += before - settings.hooks[matcher].length;

      if (settings.hooks[matcher].length === 0) {
        delete settings.hooks[matcher];
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  // Remove Vela permission rules
  if (settings.permissions) {
    const velaRules = new Set([
      ...VELA_PERMISSIONS.deny,
      ...VELA_PERMISSIONS.allow,
    ]);

    if (settings.permissions.deny) {
      const before = settings.permissions.deny.length;
      settings.permissions.deny = settings.permissions.deny.filter(
        (r) => !velaRules.has(r),
      );
      removedPerms += before - settings.permissions.deny.length;
      if (settings.permissions.deny.length === 0)
        delete settings.permissions.deny;
    }

    if (settings.permissions.allow) {
      const before = settings.permissions.allow.length;
      settings.permissions.allow = settings.permissions.allow.filter(
        (r) => !velaRules.has(r),
      );
      removedPerms += before - settings.permissions.allow.length;
      if (settings.permissions.allow.length === 0)
        delete settings.permissions.allow;
    }

    if (Object.keys(settings.permissions).length === 0) {
      delete settings.permissions;
    }
  }

  writeSettings(settings);

  // ── Also remove Vela hooks from the GLOBAL ~/.claude/settings.json ──
  // registerGlobalHooks writes there during install, so uninstall must
  // mirror that cleanup. Previously uninstall only touched the project
  // settings.local.json, leaving the 4 global hooks firing on every
  // Claude Code session in every project after a user "uninstalled".
  let removedGlobalHooks = 0;
  try {
    if (fs.existsSync(GLOBAL_SETTINGS_PATH)) {
      const globalSettings = JSON.parse(
        fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf-8"),
      );
      if (globalSettings.hooks) {
        for (const event of Object.keys(globalSettings.hooks)) {
          const before = globalSettings.hooks[event].length;
          globalSettings.hooks[event] = globalSettings.hooks[event].filter(
            (entry) => {
              if (entry && entry._velaId && entry._velaId.startsWith(HOOK_PREFIX))
                return false;
              if (entry && entry.hooks && Array.isArray(entry.hooks)) {
                return !entry.hooks.some(
                  (h) =>
                    h &&
                    h.command &&
                    (h.command.includes(HOOK_PREFIX) ||
                      h.command.includes(GLOBAL_VELA_HOOKS_DIR)),
                );
              }
              if (
                entry &&
                entry.command &&
                (entry.command.includes(HOOK_PREFIX) ||
                  entry.command.includes(GLOBAL_VELA_HOOKS_DIR))
              ) {
                return false;
              }
              return true;
            },
          );
          removedGlobalHooks += before - globalSettings.hooks[event].length;
          if (globalSettings.hooks[event].length === 0) {
            delete globalSettings.hooks[event];
          }
        }
        if (Object.keys(globalSettings.hooks).length === 0) {
          delete globalSettings.hooks;
        }
      }
      writeSettings(globalSettings, GLOBAL_SETTINGS_PATH);
    }
  } catch (e) {
    // Non-fatal — uninstall should still report success for the local part.
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "uninstall",
        removed_hooks: removedHooks,
        removed_global_hooks: removedGlobalHooks,
        removed_permissions: removedPerms,
        message: `Removed ${removedHooks} local + ${removedGlobalHooks} global hooks + ${removedPerms} permission rules.`,
      },
      null,
      2,
    ),
  );
}

function status() {
  const settings = readSettings();
  const registered = [];

  if (settings.hooks) {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      for (const entry of entries) {
        if (entry.hooks && Array.isArray(entry.hooks)) {
          for (const hook of entry.hooks) {
            if (hook.command && hook.command.includes(HOOK_PREFIX)) {
              registered.push({
                event,
                matcher: entry.matcher || "",
                command: hook.command,
                description: hook.statusMessage || "",
              });
            }
          }
        }
      }
    }
  }

  // Check permissions
  const permissions = {
    deny: (settings.permissions?.deny || []).filter((r) =>
      VELA_PERMISSIONS.deny.includes(r),
    ),
    allow: (settings.permissions?.allow || []).filter((r) =>
      VELA_PERMISSIONS.allow.includes(r),
    ),
  };

  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "status",
        vela_hooks: registered,
        hook_count: registered.length,
        vela_permissions: permissions,
        permission_count: permissions.deny.length + permissions.allow.length,
        settings_path: SETTINGS_PATH,
      },
      null,
      2,
    ),
  );
}

// ─── Upgrade ───

function upgrade() {
  const velaDir = path.join(PROJECT_ROOT, ".vela");
  if (!fs.existsSync(velaDir)) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "Vela not installed. Run install first.",
      }),
    );
    process.exit(1);
  }

  const skillBase = path.resolve(__dirname, "..");
  const results = { updated: [], added: [], skipped: [], errors: [] };

  // Filtered view: exclude files marked skipOnUpgrade (e.g. config.json)
  const upgradeFiles = FILE_MANIFEST.filter((f) => !f.skipOnUpgrade);

  // Do NOT overwrite config.json (user may have customized it)
  // Do NOT overwrite install.js itself

  for (const f of upgradeFiles) {
    const srcPath = path.join(skillBase, f.src);
    const dstPath = path.join(velaDir, f.dst);

    if (!fs.existsSync(srcPath)) {
      results.skipped.push(f.dst);
      continue;
    }

    try {
      const dstDir = path.dirname(dstPath);
      if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });

      const isNew = !fs.existsSync(dstPath);
      fs.copyFileSync(srcPath, dstPath);

      if (isNew) {
        results.added.push(f.dst);
      } else {
        results.updated.push(f.dst);
      }
    } catch (e) {
      results.errors.push(`${f.dst}: ${e.message}`);
    }
  }

  // Also update all V6 agents in .claude/agents/
  const agentsDir = path.join(PROJECT_ROOT, ".claude", "agents");
  if (fs.existsSync(agentsDir)) {
    const CLAUDE_AGENTS = [
      "vela.md",
      "vela-researcher.md",
      "vela-planner.md",
      "vela-executor.md",
      "vela-reviewer.md",
      "vela-plan-checker.md",
      "vela-verifier.md",
      "vela-diff-summary.md",
      "vela-learning.md",
      "vela-sprint-planner.md",
      "vela-analyzer.md",
    ];
    for (const agentFile of CLAUDE_AGENTS) {
      const src = path.join(velaDir, "agents", agentFile);
      const dst = path.join(agentsDir, agentFile);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, dst);
          results.updated.push(`.claude/agents/${agentFile}`);
        } catch (e) {
          results.errors.push(`.claude/agents/${agentFile}: ${e.message}`);
        }
      }
    }
  }

  // ── Config migration: merge new template keys into user config.json ──
  results.configMigration = migrateConfig(velaDir, skillBase);

  // ── Orphan cleanup: remove files in managed dirs not in FILE_MANIFEST ──
  results.orphansRemoved = [];
  try {
    const orphans = findOrphans(velaDir);
    for (const orphan of orphans) {
      const orphanPath = path.join(velaDir, orphan);
      try {
        fs.unlinkSync(orphanPath);
        results.orphansRemoved.push(orphan);
      } catch (e) {
        results.errors.push(`orphan cleanup ${orphan}: ${e.message}`);
      }
    }
    // Clean up empty directories left behind
    const emptied = removeEmptyDirs(velaDir);
    if (emptied.length > 0) {
      results.orphansRemoved.push(...emptied.map((d) => `${d}/ (empty dir)`));
    }
  } catch (e) {
    results.errors.push(`orphan cleanup scan: ${e.message}`);
  }

  // ─── Pin the workspace root (v7.0.7) ───
  // upgrade() also refreshes .vela/state/workspace.json so existing
  // users get the pin on their next `node .vela/install.js upgrade`.
  writeWorkspaceRecord(PROJECT_ROOT);

  // ─── v7.1 M12: CLAUDE.md — inject the `cd` rule on upgrade ───
  //
  // The "Bash tool — never use bare `cd`" section was added to the
  // template in v7.0.7 via install() only. Projects that were first
  // initialised before v7.0.7 have a CLAUDE.md that was never touched
  // by upgrade() (upgrade skips CLAUDE.md precisely because user may
  // have customised it), so they never get the rule and continue
  // hitting the subshell-cd footgun on every session.
  //
  // v7.1 closes that loophole: upgrade() reads the existing CLAUDE.md,
  // checks for the marker text, and appends the section if absent.
  // Idempotent — re-running upgrade after the first injection is a
  // no-op because the marker is already present.
  try {
    const claudeMdPath = path.join(PROJECT_ROOT, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, "utf8");
      const MARKER = "Bash tool — never use bare `cd`";
      if (!existing.includes(MARKER)) {
        const appendage = `
## ${MARKER} inside a single invocation

Claude Code's Bash tool has a persistent working directory that survives
between tool calls. A bare \`cd subdir\` inside one Bash invocation will
cause every subsequent Bash call (including the PM's
\`node .vela/cli/vela-engine.js ...\` invocations) to run from that
subdirectory, and Node's module loader will fail with \`Cannot find
module\` before the engine ever runs.

- **Wrong**: \`cd server/data && node build.js\` (leaks the cwd change)
- **Right**: \`( cd server/data && node build.js )\` (subshell isolates it)
- **Also right**: pass absolute paths — \`node /abs/path/to/build.js\`

Vela v7.0.7+ records the true project root in
\`.vela/state/workspace.json\` at install time and the engine will
\`chdir\` back on every invocation if cwd has drifted, printing a
warning to stderr. Treat that warning as a bug in the calling code
(usually a stray \`cd\` inside a Bash tool) and fix it rather than
relying on the auto-recovery.
`;
        fs.appendFileSync(claudeMdPath, appendage);
        results.claudeMdInjected = true;
      } else {
        results.claudeMdInjected = false;
      }
    } else {
      // No CLAUDE.md at all — install() handles first-time creation,
      // so upgrade() should not create one from scratch. Users who
      // deleted their CLAUDE.md intentionally stay deleted.
      results.claudeMdInjected = false;
    }
  } catch (e) {
    results.errors.push(`CLAUDE.md injection: ${e.message}`);
    results.claudeMdInjected = false;
  }

  console.log(
    JSON.stringify(
      {
        ok: results.errors.length === 0,
        command: "upgrade",
        updated: results.updated.length,
        added: results.added.length,
        skipped: results.skipped.length,
        orphansRemoved: results.orphansRemoved.length,
        configMigration: results.configMigration,
        claudeMdInjected: !!results.claudeMdInjected,
        errors: results.errors,
        details: results,
      },
      null,
      2,
    ),
  );
}

// ─── Validate & Repair ───

function validate() {
  const results = { fixed: [], refreshed: [], warnings: [], ok: [] };
  const velaDir = path.join(PROJECT_ROOT, ".vela");

  // 1. Required directories
  const requiredDirs = [
    "shared",
    "cli",
    "cache",
    "templates",
    "state",
    "artifacts",
    "agents",
    "references",
    "guidelines",
    "agents/pm",
    "agents/researcher",
    "agents/executor",
    "agents/planner",
    "agents/reviewer",
  ];
  for (const dir of requiredDirs) {
    const dirPath = path.join(velaDir, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      results.fixed.push(`Created missing directory: .vela/${dir}`);
    }
  }

  // 2. Required files — check and copy from skill if missing
  const skillBase = path.resolve(__dirname, "..");
  const requiredFiles = FILE_MANIFEST;

  for (const f of requiredFiles) {
    const dstPath = path.join(velaDir, f.dst);
    const srcPath = path.join(skillBase, f.src);
    if (!fs.existsSync(dstPath)) {
      // Missing — try to restore from skill directory
      if (fs.existsSync(srcPath)) {
        const dstDir = path.dirname(dstPath);
        if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
        results.fixed.push(`Restored missing file: .vela/${f.dst}`);
      } else {
        results.warnings.push(
          `Missing file: .vela/${f.dst} (source not found)`,
        );
      }
    } else if (fs.existsSync(srcPath)) {
      // Exists — check if content is current (binary comparison)
      const srcBuf = fs.readFileSync(srcPath);
      const dstBuf = fs.readFileSync(dstPath);
      if (!srcBuf.equals(dstBuf)) {
        const dstDir = path.dirname(dstPath);
        if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
        results.refreshed.push(`Refreshed stale file: .vela/${f.dst}`);
      } else {
        results.ok.push(f.dst);
      }
    } else {
      results.ok.push(f.dst);
    }
  }

  // 3. config.json validity
  const configPath = path.join(velaDir, "config.json");
  const templateConfig = path.join(velaDir, "templates", "config.json");
  if (fs.existsSync(configPath)) {
    try {
      JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
      // Broken config — restore from template
      if (fs.existsSync(templateConfig)) {
        fs.copyFileSync(templateConfig, configPath);
        results.fixed.push("Repaired broken config.json from template");
      }
    }
  } else {
    // Missing config.json — copy from template
    if (fs.existsSync(templateConfig)) {
      fs.copyFileSync(templateConfig, configPath);
      results.fixed.push("Copied missing config.json from template");
    }
  }

  // 4. Clean up orphan files in managed directories (manifest-based)
  try {
    const orphans = findOrphans(velaDir);
    for (const orphan of orphans) {
      const orphanPath = path.join(velaDir, orphan);
      try {
        fs.unlinkSync(orphanPath);
        results.fixed.push(`Removed orphan file: .vela/${orphan}`);
      } catch (e) {
        // File may have been removed already — skip
      }
    }
    const emptied = removeEmptyDirs(velaDir);
    for (const dir of emptied) {
      results.fixed.push(`Removed empty directory: .vela/${dir}`);
    }
  } catch (e) {
    // Orphan scan failure is non-fatal in validate
  }

  // 5. Fix settings.local.json — remove old format hooks
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      let fixed = false;

      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          const before = settings.hooks[event].length;
          settings.hooks[event] = settings.hooks[event].filter((entry) => {
            // Remove _velaId prompt hooks (check before nested format — entry may have both)
            if (entry._velaId && entry._velaId.startsWith(HOOK_PREFIX))
              return false;
            // Remove legacy flat format: { command: "...vela...", description: "..." }
            if (
              entry.command &&
              !entry.hooks &&
              entry.command.includes(HOOK_PREFIX)
            )
              return false;
            // Remove new nested format: { matcher, hooks: [{ command: "...vela..." }] }
            if (entry.hooks && Array.isArray(entry.hooks)) {
              return !entry.hooks.some(
                (h) => h.command && h.command.includes(HOOK_PREFIX),
              );
            }
            return true;
          });
          if (settings.hooks[event].length !== before) fixed = true;
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }

      // Remove old agent name
      if (settings.agent === "vela-pm") {
        settings.agent = "vela";
        fixed = true;
      }

      if (fixed) {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        results.fixed.push(
          "Cleaned legacy hooks/settings from settings.local.json",
        );
      }
    } catch (e) {
      // Broken settings — will be overwritten by install
      results.fixed.push("settings.local.json was broken, will be recreated");
    }
  }

  // 6. Statusline.sh line endings (CRLF → LF)
  const statuslinePath = path.join(velaDir, "statusline.sh");
  if (fs.existsSync(statuslinePath)) {
    const content = fs.readFileSync(statuslinePath, "utf-8");
    if (content.includes("\r\n")) {
      fs.writeFileSync(statuslinePath, content.replace(/\r\n/g, "\n"));
      results.fixed.push("Fixed CRLF line endings in statusline.sh");
    }
  }

  // 7. .gitignore — ensure all Vela files are hidden from git
  const { execSync } = require("child_process");
  const gitignorePath = path.join(PROJECT_ROOT, ".gitignore");
  const velaGitEntries = [".vela/", ".claude/", "CLAUDE.md"];

  // Step 1: Remove already-tracked Vela files BEFORE updating .gitignore
  try {
    const tracked = execSync("git ls-files .vela/ .claude/ CLAUDE.md", {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (tracked) {
      execSync(
        "git rm -r --cached --ignore-unmatch .vela/ .claude/ CLAUDE.md",
        {
          cwd: PROJECT_ROOT,
          stdio: "pipe",
          timeout: 10000,
        },
      );
      execSync(
        'git commit -m "chore: untrack Vela files from git" --no-verify',
        {
          cwd: PROJECT_ROOT,
          stdio: "pipe",
          timeout: 10000,
        },
      );
      results.fixed.push(
        "Removed Vela files from git tracking (files kept on disk)",
      );
    }
  } catch (e) {
    // Not a git repo or git not available
  }

  // Step 2: Update .gitignore (after deletions are committed)
  let gitignoreContent = "";
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
  }
  const missingGit = velaGitEntries.filter(
    (e) => !gitignoreContent.includes(e),
  );
  if (missingGit.length > 0) {
    const block = gitignoreContent.includes("# Vela Engine")
      ? missingGit.join("\n") + "\n"
      : "\n# Vela Engine (auto-managed)\n" + velaGitEntries.join("\n") + "\n";
    fs.appendFileSync(gitignorePath, block);
    results.fixed.push(
      `Added ${missingGit.length} entries to .gitignore: ${missingGit.join(", ")}`,
    );
  }

  // 8. System dependencies — install if missing

  // jq (required for statusline.sh)
  try {
    execSync("which jq", { stdio: "pipe" });
    results.ok.push("jq");
  } catch (e) {
    // Try to install jq
    const platform = process.platform;
    let installed = false;
    const cmds = [
      "sudo apt-get install -y jq 2>/dev/null",
      "sudo yum install -y jq 2>/dev/null",
      "brew install jq 2>/dev/null",
      "apk add jq 2>/dev/null",
    ];
    for (const cmd of cmds) {
      try {
        execSync(cmd, { stdio: "pipe", timeout: 30000 });
        installed = true;
        results.fixed.push("Installed missing dependency: jq");
        break;
      } catch (e2) {}
    }
    if (!installed) {
      results.warnings.push(
        "jq not found and auto-install failed. Install manually: sudo apt install jq",
      );
    }
  }

  // SQLite backend for TreeNode cache (optional — multiple fallbacks available)
  const { globalRequire: gReq } = require("./shared/global-require");
  let sqliteBackend = "none";
  try {
    gReq("better-sqlite3");
    sqliteBackend = "better-sqlite3";
  } catch (e) {
    try {
      gReq("sql.js");
      sqliteBackend = "sql.js";
    } catch (e2) {
      try {
        execSync("which sqlite3", { stdio: "pipe" });
        sqliteBackend = "sqlite3-cli";
      } catch (e3) {
        /* will use JSON fallback */
      }
    }
  }
  if (sqliteBackend !== "none") {
    results.ok.push(`TreeNode cache: ${sqliteBackend}`);
  } else {
    results.warnings.push(
      "No SQLite backend found — TreeNode cache will use JSON fallback. Run: npm install better-sqlite3 (or sql.js for WSL1/proxy)",
    );
  }

  // 9. Global pollution cleanup — remove ONLY explicitly-known legacy
  //    directories from ~/.claude/skills/.
  //
  // v7.0.5: This block used to be an allow-list of five hardcoded
  // directory names that deleted every other vela-* directory as
  // "pollution". That design coupled install.js to the skills/
  // catalog — whenever a new slash command skill was added to the
  // repo (v6.1 added vela-small/medium/large/ralph/hotfix, v7.0
  // added vela-fix) install.js would delete them on every /vela:large
  // run, silently breaking slash-command autocomplete. update.sh and
  // install.js disagreed on the single source of truth.
  //
  // The fix is to invert it into a BLOCK-LIST of directory names that
  // were *explicitly* retired in past Vela versions. Every other
  // vela-* directory is preserved, regardless of whether install.js
  // "knows" about it. Adding a new slash-command skill now requires
  // touching ONLY install.sh/update.sh, never this file.
  const HOME = process.env.HOME || process.env.USERPROFILE;
  const KNOWN_LEGACY_SKILLS = new Set([
    "vela-init", // removed in v6.2 (used to be the `/vela init` wrapper)
    "vela-auto", // removed in v6.2 (used to be the `/vela auto` wrapper)
  ]);
  if (HOME) {
    const globalSkillsDir = path.join(HOME, ".claude", "skills");
    if (fs.existsSync(globalSkillsDir)) {
      const velaDirs = [];
      try {
        for (const entry of fs.readdirSync(globalSkillsDir)) {
          // Only remove vela-* dirs explicitly on the legacy block-list.
          // Everything else — including the main `vela` skill and every
          // current slash-command skill (vela-start, vela-fix, vela-small
          // etc.) — is preserved.
          if (KNOWN_LEGACY_SKILLS.has(entry)) {
            velaDirs.push(entry);
          }
        }
      } catch (e) {
        /* permission error — skip */
      }

      for (const dir of velaDirs) {
        const dirPath = path.join(globalSkillsDir, dir);
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
          results.fixed.push(
            `Removed legacy global skill: ~/.claude/skills/${dir}`,
          );
        } catch (e) {
          results.warnings.push(
            `Could not remove ~/.claude/skills/${dir}: ${e.message}`,
          );
        }
      }
    }

    // Also clean up global commands/vela/ (legacy v1/v2)
    const globalCmdsDir = path.join(HOME, ".claude", "commands", "vela");
    if (fs.existsSync(globalCmdsDir)) {
      try {
        fs.rmSync(globalCmdsDir, { recursive: true, force: true });
        results.fixed.push(
          "Removed legacy global commands: ~/.claude/commands/vela/",
        );
      } catch (e) {
        results.warnings.push(
          `Could not remove ~/.claude/commands/vela/: ${e.message}`,
        );
      }
    }
  }

  // ─── Pin the workspace root (v7.0.7) ───
  // validate() is the path most likely to run on an existing project
  // (triggered by /vela:large and friends via install.js invocation).
  // Refreshing workspace.json here means any project touched by a
  // scale skill gets the pin without needing a full install/upgrade.
  if (writeWorkspaceRecord(PROJECT_ROOT)) {
    results.ok.push("workspace.json pinned");
  } else {
    results.warnings.push(
      "Could not write .vela/state/workspace.json — engine will fall back to walk-up",
    );
  }

  return results;
}

// ─── Settings I/O ───

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    // Create settings directory if needed
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch (e) {
    return {};
  }
}

function writeSettings(settings, targetPath) {
  const p = targetPath || SETTINGS_PATH;
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Direct write (atomic rename fails on some WSL+Windows filesystems)
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

/**
 * Register global hooks in ~/.claude/settings.json.
 * Copies the four active V6.2 hook scripts (gate-keeper, gate-guard, stop,
 * review-gate) to ~/.vela/hooks/ so they are available globally across all
 * projects. Hooks self-activate only when an active Vela pipeline exists in cwd.
 */
function registerGlobalHooks(hooksSourceDir) {
  // Deploy hook scripts to ~/.vela/hooks/
  try {
    fs.mkdirSync(GLOBAL_VELA_HOOKS_DIR, { recursive: true });
    fs.mkdirSync(path.join(GLOBAL_VELA_HOOKS_DIR, "shared"), { recursive: true });

    const hookFiles = ["vela-gate-keeper.js", "vela-gate-guard.js", "vela-stop.js", "vela-review-gate.js", "vela-file-read-cache.js"];
    for (const file of hookFiles) {
      const src = path.join(hooksSourceDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(GLOBAL_VELA_HOOKS_DIR, file));
      }
    }
    const sharedSrc = path.join(hooksSourceDir, "shared", "constants.js");
    if (fs.existsSync(sharedSrc)) {
      fs.copyFileSync(sharedSrc, path.join(GLOBAL_VELA_HOOKS_DIR, "shared", "constants.js"));
    }
  } catch { /* silent — hooks may already be deployed */ }

  // Read existing global settings
  let globalSettings = {};
  try {
    if (fs.existsSync(GLOBAL_SETTINGS_PATH)) {
      globalSettings = JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf8")) || {};
    }
  } catch { globalSettings = {}; }

  globalSettings.hooks = globalSettings.hooks || {};

  // ── Heal existing duplicates from the pre-fix Stop-hook bug ──
  // Before the idempotency fix (PR #8), every install() re-pushed the Stop
  // hooks because the dedup key "vela-gate-stop" never matched the command
  // string "vela-stop.js". Users who installed multiple times accumulated
  // 2, 4, 6, 8, ... duplicate Stop hook entries. This pass removes those
  // duplicates by keeping only the first entry whose stringified form
  // contains a given vela hook filename.
  function dedupVelaHooks(event) {
    const list = globalSettings.hooks[event];
    if (!Array.isArray(list) || list.length === 0) return 0;
    const VELA_HOOK_FILES = [
      "vela-gate-keeper.js",
      "vela-gate-guard.js",
      "vela-stop.js",
      "vela-review-gate.js",
    ];
    const seen = new Set();
    const kept = [];
    let removed = 0;
    for (const entry of list) {
      const stringified = JSON.stringify(entry);
      // Find which vela hook (if any) this entry registers. A well-formed
      // entry matches exactly one hook filename.
      const matchedHook = VELA_HOOK_FILES.find((f) => stringified.includes(f));
      if (matchedHook) {
        if (seen.has(matchedHook)) {
          removed++;
          continue; // duplicate — drop it
        }
        seen.add(matchedHook);
      }
      kept.push(entry);
    }
    globalSettings.hooks[event] = kept;
    return removed;
  }
  dedupVelaHooks("PreToolUse");
  dedupVelaHooks("Stop");

  // Idempotent hook registration. `id` must be a substring of the
  // stringified hook entry (we match against the hook filename). Previously
  // the Stop hook was registered with id "vela-gate-stop" while the command
  // referenced "vela-stop.js" — the includes() check never matched so every
  // install re-pushed the Stop hooks, growing ~/.claude/settings.json on
  // every run.
  function addGlobalHook(event, id, command, timeout) {
    globalSettings.hooks[event] = globalSettings.hooks[event] || [];
    const already = globalSettings.hooks[event].some(
      (e) => JSON.stringify(e).includes(id)
    );
    if (!already) {
      globalSettings.hooks[event].push({
        hooks: [{ type: "command", command, timeout }],
      });
    }
  }

  // IDs match the hook filename basename (without .js) so the stringified
  // command always contains the id.
  addGlobalHook("PreToolUse", "vela-gate-keeper",
    `node ${path.join(GLOBAL_VELA_HOOKS_DIR, "vela-gate-keeper.js")}`, 10);
  addGlobalHook("PreToolUse", "vela-gate-guard",
    `node ${path.join(GLOBAL_VELA_HOOKS_DIR, "vela-gate-guard.js")}`, 10);
  // v7.1 M10 — file read cache is also PreToolUse, but purely
  // observational. The hook always returns exit 0 even on internal
  // error, so adding it cannot break an otherwise-working project.
  addGlobalHook("PreToolUse", "vela-file-read-cache",
    `node ${path.join(GLOBAL_VELA_HOOKS_DIR, "vela-file-read-cache.js")}`, 5);
  addGlobalHook("Stop", "vela-stop",
    `node ${path.join(GLOBAL_VELA_HOOKS_DIR, "vela-stop.js")}`, 10);
  addGlobalHook("Stop", "vela-review-gate",
    `node ${path.join(GLOBAL_VELA_HOOKS_DIR, "vela-review-gate.js")}`, 10);

  writeSettings(globalSettings, GLOBAL_SETTINGS_PATH);
}
