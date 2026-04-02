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

const PROJECT_ROOT = findProjectRoot(process.cwd());
const SETTINGS_PATH = path.join(PROJECT_ROOT, ".claude", "settings.local.json");

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
  ],
};

// ─── File Manifest (single source of truth for managed files) ───

const FILE_MANIFEST = [
  // Shared modules (used by CLI tools)
  { src: "scripts/shared/constants.js", dst: "shared/constants.js" },
  { src: "scripts/shared/dep-analyzer.js", dst: "shared/dep-analyzer.js" },
  // CLI tools
  { src: "scripts/cli/vela-engine.js", dst: "cli/vela-engine.js" },
  { src: "scripts/cli/vela-analyze.js", dst: "cli/vela-analyze.js" },
  { src: "scripts/cli/vela-cost.js", dst: "cli/vela-cost.js" },
  { src: "scripts/cli/vela-report.js", dst: "cli/vela-report.js" },
  { src: "scripts/cli/vela-pipeline.js", dst: "cli/vela-pipeline.js" },
  // Cache
  { src: "scripts/cache/treenode.js", dst: "cache/treenode.js" },
  // Root-level managed files
  { src: "scripts/statusline.sh", dst: "statusline.sh" },
  // Top-level agent files
  { src: "scripts/agents/vela.md", dst: "agents/vela.md" },
  { src: "scripts/agents/researcher.md", dst: "agents/researcher.md" },
  { src: "scripts/agents/planner.md", dst: "agents/planner.md" },
  { src: "scripts/agents/executor.md", dst: "agents/executor.md" },
  { src: "scripts/agents/reviewer.md", dst: "agents/reviewer.md" },
  { src: "scripts/agents/leader.md", dst: "agents/leader.md" },
  {
    src: "scripts/agents/conflict-manager.md",
    dst: "agents/conflict-manager.md",
  },
  { src: "scripts/agents/vela-pm.md", dst: "agents/vela-pm.md" },
  // Templates
  { src: "templates/pipeline.json", dst: "templates/pipeline.json" },
  { src: "templates/presets.json", dst: "templates/presets.json" },
  {
    src: "templates/config.json",
    dst: "templates/config.json",
    skipOnUpgrade: true,
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
  // Agent tree — Planner
  { src: "scripts/agents/planner/index.md", dst: "agents/planner/index.md" },
  {
    src: "scripts/agents/planner/spec-format.md",
    dst: "agents/planner/spec-format.md",
  },
  {
    src: "scripts/agents/planner/crosslayer.md",
    dst: "agents/planner/crosslayer.md",
  },
  // Agent tree — Reviewer
  { src: "scripts/agents/reviewer/index.md", dst: "agents/reviewer/index.md" },
  {
    src: "scripts/agents/reviewer/scoring.md",
    dst: "agents/reviewer/scoring.md",
  },
  // Agent tree — Conflict Manager
  {
    src: "scripts/agents/conflict-manager/index.md",
    dst: "agents/conflict-manager/index.md",
  },
  {
    src: "scripts/agents/conflict-manager/merge-procedure.md",
    dst: "agents/conflict-manager/merge-procedure.md",
  },
  {
    src: "scripts/agents/conflict-manager/interface-watch.md",
    dst: "agents/conflict-manager/interface-watch.md",
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
  // SDK modules (optional — require @anthropic-ai/claude-agent-sdk)
  { src: "scripts/shared/sdk-runner.js", dst: "shared/sdk-runner.js" },
  { src: "scripts/shared/sdk-reviewer.js", dst: "shared/sdk-reviewer.js" },
  {
    src: "scripts/shared/sdk-plan-checker.js",
    dst: "shared/sdk-plan-checker.js",
  },
  { src: "scripts/shared/sdk-researcher.js", dst: "shared/sdk-researcher.js" },
  { src: "scripts/shared/sdk-executor.js", dst: "shared/sdk-executor.js" },
  { src: "scripts/shared/sdk-analyzer.js", dst: "shared/sdk-analyzer.js" },
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

  writeSettings(settings);

  // Create state directory for session tracking (project-local)
  const stateDir = path.join(PROJECT_ROOT, ".vela", "state");
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // ─── Deploy vela agent ───
  const agentsDir = path.join(PROJECT_ROOT, ".claude", "agents");
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }
  const pmSourcePath = path.join(PROJECT_ROOT, ".vela", "agents", "vela.md");
  const pmTargetPath = path.join(agentsDir, "vela.md");
  if (fs.existsSync(pmSourcePath)) {
    fs.copyFileSync(pmSourcePath, pmTargetPath);
  }

  // ─── Create CLAUDE.md if not exists ───
  const claudeMdPath = path.join(PROJECT_ROOT, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(
      claudeMdPath,
      `# Development Workflow — Vela

This project uses Vela for development governance.

- To explore/read code: use normal tools freely (Explore mode).
- To modify code: ALWAYS start with \`node .vela/cli/vela-engine.js init "<task>" --scale <small|medium|large>\`
- Follow pipeline steps in order. Do NOT use TaskCreate/TaskUpdate during pipeline execution.
- Do NOT skip pipeline steps or create your own plans outside the pipeline.
- Each team step uses Teammate (소통 필요) or Subagent (독립 작업). Model: Haiku(탐색), Sonnet(코딩/리뷰), Opus(설계/분석).
`,
    );
  }

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

  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "uninstall",
        removed_hooks: removedHooks,
        removed_permissions: removedPerms,
        message: `Removed ${removedHooks} hooks + ${removedPerms} permission rules.`,
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

  // Also update the PM agent in .claude/agents/
  const pmSrc = path.join(velaDir, "agents", "vela.md");
  const pmDst = path.join(PROJECT_ROOT, ".claude", "agents", "vela.md");
  if (fs.existsSync(pmSrc) && fs.existsSync(path.dirname(pmDst))) {
    try {
      fs.copyFileSync(pmSrc, pmDst);
      results.updated.push(".claude/agents/vela.md");
    } catch (e) {
      results.errors.push(`.claude/agents/vela.md: ${e.message}`);
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
    "agents/conflict-manager",
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
  if (fs.existsSync(configPath)) {
    try {
      JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
      // Broken config — restore from template
      const templateConfig = path.join(velaDir, "templates", "config.json");
      if (fs.existsSync(templateConfig)) {
        fs.copyFileSync(templateConfig, configPath);
        results.fixed.push("Repaired broken config.json from template");
      }
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
  let sqliteBackend = "none";
  try {
    require("better-sqlite3");
    sqliteBackend = "better-sqlite3";
  } catch (e) {
    try {
      require("sql.js");
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

  // 9. Global pollution cleanup — remove legacy vela files from ~/.claude/
  // Valid entries: vela/ (main skill), vela-init/ vela-start/ vela-auto/ vela-analyze/ vela-git-clean/ (sub-skills)
  // Invalid (legacy): commands/vela/ (v1/v2 slash commands), any other vela-* dirs
  const HOME = process.env.HOME || process.env.USERPROFILE;
  const VALID_SUB_SKILLS = new Set([
    "vela",
    "vela-init",
    "vela-start",
    "vela-auto",
    "vela-analyze",
    "vela-git-clean",
  ]);
  if (HOME) {
    const globalSkillsDir = path.join(HOME, ".claude", "skills");
    if (fs.existsSync(globalSkillsDir)) {
      const velaDirs = [];
      try {
        for (const entry of fs.readdirSync(globalSkillsDir)) {
          // Only remove vela-* dirs that are NOT valid sub-skills
          if (
            (entry === "vela" || entry.startsWith("vela-")) &&
            !VALID_SUB_SKILLS.has(entry)
          ) {
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
            `Removed global pollution: ~/.claude/skills/${dir}`,
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

function writeSettings(settings) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Direct write (atomic rename fails on some WSL+Windows filesystems)
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}
