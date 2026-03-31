#!/usr/bin/env node
/**
 * Vela Hook Installer
 *
 * Registers Vela hooks into the PROJECT-LOCAL .claude/settings.local.json
 * so they only trigger within this Vela-enabled project.
 *
 * Why project-local instead of global (~/.claude/settings.json)?
 * - Vela is a sandbox — hooks should not leak outside the project
 * - No performance overhead on non-Vela projects
 * - Multiple Vela projects can have independent configurations
 * - Deleting the project automatically removes hook registrations
 *
 * Usage:
 *   node install.js                    — Install hooks
 *   node install.js verify             — Verify installation
 *   node install.js upgrade            — Update all Vela files to latest version
 *   node install.js uninstall          — Remove all Vela hooks
 *   node install.js status             — Show current hook status
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = findProjectRoot(process.cwd());
const SETTINGS_PATH = path.join(PROJECT_ROOT, '.claude', 'settings.local.json');
const VELA_HOOKS_DIR = path.join(PROJECT_ROOT, '.vela', 'hooks');

/**
 * Walk up from cwd to find the project root (where .vela/ lives).
 */
function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.vela'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

const HOOK_PREFIX = 'vela-';

// ─── Permission deny rules ───
// Claude Code's deny rules are absolute — denied at any level = blocked everywhere.
// These rules provide a second layer of defense alongside Gate Keeper/Guard hooks.
const VELA_PERMISSIONS = {
  deny: [
    // Destructive file operations
    'Bash(rm -rf *)',
    'Bash(rm -r *)',
    // Force push — all variants
    'Bash(git push --force *)',
    'Bash(git push -f *)',
    'Bash(git push --force-with-lease *)',
    'Bash(git push origin +*)',
    // Hard reset — destroys uncommitted work
    'Bash(git reset --hard *)',
    // Skip hooks — Vela hooks must never be bypassed
    'Bash(git commit --no-verify *)',
    'Bash(git commit -n *)',
    // Clean untracked files — can delete work
    'Bash(git clean -f *)',
    'Bash(git clean -fd *)',
    // Direct database drops
    'Bash(drop database *)',
    'Bash(DROP DATABASE *)',
  ],
  allow: [
    // Vela CLI tools — always allowed through Bash
    'Bash(node .vela/*)',
    'Bash(python .vela/*)',
    'Bash(python3 .vela/*)',
  ]
};

const VELA_HOOKS = [
  {
    matcher: 'PreToolUse',
    hookId: 'vela-gate-keeper',
    script: 'vela-gate-keeper.js',
    description: '⚓ 수문장이 입항을 허가합니다...'
  },
  {
    matcher: 'PreToolUse',
    hookId: 'vela-gate-guard',
    script: 'vela-gate-guard.js',
    description: '🧭 항해 규칙을 대조합니다...'
  },
  {
    matcher: 'UserPromptSubmit',
    hookId: 'vela-orchestrator',
    script: 'vela-orchestrator.js',
    description: '✦ 별자리를 읽고 항로를 설정합니다...'
  },
  {
    matcher: 'PostToolUse',
    hookId: 'vela-tracker',
    script: 'vela-tracker.js',
    description: '🔭 항해 일지에 기록합니다...'
  },
  {
    matcher: 'Stop',
    hookId: 'vela-stop',
    script: 'vela-stop.js',
    description: '⚓ 정박 준비를 확인합니다...'
  },
  {
    matcher: 'SessionStart',
    hookId: 'vela-session-start',
    script: 'vela-session-start.js',
    description: '🔭 이전 항해의 흔적을 탐색합니다...'
  },
  {
    matcher: 'PreCompact',
    hookId: 'vela-compact',
    script: 'vela-compact.js',
    description: '✦ 항해 기억을 보존합니다...'
  },
  {
    matcher: 'PostCompact',
    hookId: 'vela-compact',
    script: 'vela-compact.js',
    description: '✦ 항해 기억을 복원합니다...'
  },
  {
    matcher: 'SubagentStart',
    hookId: 'vela-subagent-start',
    script: 'vela-subagent-start.js',
    description: '🌟 선원에게 임무를 전달합니다...'
  },
  {
    matcher: 'TaskCompleted',
    hookId: 'vela-task-completed',
    script: 'vela-task-completed.js',
    description: '🌟 항해 이정표를 확인합니다...'
  },
  {
    matcher: 'SubagentStop',
    hookId: 'vela-subagent-stop',
    script: 'vela-subagent-stop.js',
    description: '🧭 선원의 보고를 수집합니다...'
  },
  {
    matcher: 'PermissionRequest',
    hookId: 'vela-permission',
    script: 'vela-permission.js',
    if: 'Write(*)|Edit(*)|NotebookEdit(*)',
    description: '⛵ 조타 권한을 확인합니다...'
  },
  {
    matcher: 'PostToolUseFailure',
    hookId: 'vela-failure',
    script: 'vela-failure.js',
    description: '🛟 항해 사고를 기록합니다...'
  },
  {
    matcher: 'StopFailure',
    hookId: 'vela-stop-failure',
    script: 'vela-stop-failure.js',
    description: '🛟 비상 상태를 보존합니다...'
  },
  {
    matcher: 'TeammateIdle',
    hookId: 'vela-teammate-idle',
    script: 'vela-teammate-idle.js',
    description: '🌊 대기 선원의 상태를 점검합니다...'
  },
  {
    matcher: 'PostToolUse',
    hookId: 'vela-review-prompt',
    hookType: 'prompt',
    toolMatcher: 'Edit(*)|Write(*)',
    prompt: 'If the file is a markdown (.md), JSON (.json), YAML (.yaml/.yml), or config file, respond with {"ok": true}. Only review source code files (.js, .ts, .py, .go, .rs, .java, .sh, etc). For source code: review for bugs, security issues, and style problems. Context: $ARGUMENTS. Respond with JSON: {"ok": true} if acceptable, or {"ok": false, "reason": "brief description"} if there are critical bugs or security vulnerabilities. Ignore style nitpicks. Be concise.',
    description: '🔭 코드 변경을 검수합니다...'
  },
  {
    matcher: 'PostToolUse',
    hookId: 'vela-test-async',
    hookType: 'command',
    toolMatcher: 'Edit|Write',
    script: 'vela-test-async.js',
    async: true,
    description: '🌊 시험 항해를 실행합니다...'
  },
  {
    matcher: 'Notification',
    hookId: 'vela-notification',
    script: 'vela-notification.js',
    description: '🌟 신호탄을 발사합니다...'
  }
];

// ─── File Manifest (single source of truth for managed files) ───

const FILE_MANIFEST = [
  // Hook files
  { src: 'scripts/hooks/vela-gate-keeper.js', dst: 'hooks/vela-gate-keeper.js' },
  { src: 'scripts/hooks/vela-gate-guard.js', dst: 'hooks/vela-gate-guard.js' },
  { src: 'scripts/hooks/vela-orchestrator.js', dst: 'hooks/vela-orchestrator.js' },
  { src: 'scripts/hooks/vela-tracker.js', dst: 'hooks/vela-tracker.js' },
  { src: 'scripts/hooks/vela-stop.js', dst: 'hooks/vela-stop.js' },
  { src: 'scripts/hooks/vela-session-start.js', dst: 'hooks/vela-session-start.js' },
  { src: 'scripts/hooks/vela-compact.js', dst: 'hooks/vela-compact.js' },
  { src: 'scripts/hooks/vela-subagent-start.js', dst: 'hooks/vela-subagent-start.js' },
  { src: 'scripts/hooks/vela-task-completed.js', dst: 'hooks/vela-task-completed.js' },
  { src: 'scripts/hooks/vela-subagent-stop.js', dst: 'hooks/vela-subagent-stop.js' },
  { src: 'scripts/hooks/vela-permission.js', dst: 'hooks/vela-permission.js' },
  { src: 'scripts/hooks/vela-failure.js', dst: 'hooks/vela-failure.js' },
  { src: 'scripts/hooks/vela-stop-failure.js', dst: 'hooks/vela-stop-failure.js' },
  { src: 'scripts/hooks/vela-teammate-idle.js', dst: 'hooks/vela-teammate-idle.js' },
  { src: 'scripts/hooks/vela-test-async.js', dst: 'hooks/vela-test-async.js' },
  { src: 'scripts/hooks/vela-notification.js', dst: 'hooks/vela-notification.js' },
  { src: 'scripts/hooks/shared/constants.js', dst: 'hooks/shared/constants.js' },
  { src: 'scripts/hooks/shared/pipeline.js', dst: 'hooks/shared/pipeline.js' },
  { src: 'scripts/hooks/shared/dep-analyzer.js', dst: 'hooks/shared/dep-analyzer.js' },
  // CLI tools
  { src: 'scripts/cli/vela-engine.js', dst: 'cli/vela-engine.js' },
  { src: 'scripts/cli/vela-read.js', dst: 'cli/vela-read.js' },
  { src: 'scripts/cli/vela-write.js', dst: 'cli/vela-write.js' },
  { src: 'scripts/cli/vela-analyze.js', dst: 'cli/vela-analyze.js' },
  { src: 'scripts/cli/vela-cost.js', dst: 'cli/vela-cost.js' },
  { src: 'scripts/cli/vela-report.js', dst: 'cli/vela-report.js' },
  // Cache
  { src: 'scripts/cache/treenode.js', dst: 'cache/treenode.js' },
  // Root-level managed files
  { src: 'scripts/statusline.sh', dst: 'statusline.sh' },
  // Top-level agent files
  { src: 'scripts/agents/vela.md', dst: 'agents/vela.md' },
  { src: 'scripts/agents/researcher.md', dst: 'agents/researcher.md' },
  { src: 'scripts/agents/planner.md', dst: 'agents/planner.md' },
  { src: 'scripts/agents/executor.md', dst: 'agents/executor.md' },
  { src: 'scripts/agents/reviewer.md', dst: 'agents/reviewer.md' },
  { src: 'scripts/agents/leader.md', dst: 'agents/leader.md' },
  { src: 'scripts/agents/conflict-manager.md', dst: 'agents/conflict-manager.md' },
  // Templates
  { src: 'templates/pipeline.json', dst: 'templates/pipeline.json' },
  { src: 'templates/presets.json', dst: 'templates/presets.json' },
  { src: 'templates/config.json', dst: 'templates/config.json', skipOnUpgrade: true },
  // References
  { src: 'references/interactive-ui.md', dst: 'references/interactive-ui.md' },
  { src: 'references/gates-and-guards.md', dst: 'references/gates-and-guards.md' },
  { src: 'references/cli-reference.md', dst: 'references/cli-reference.md' },
  { src: 'references/messages-en.md', dst: 'references/messages-en.md' },
  // Agent tree — PM
  { src: 'scripts/agents/pm/index.md', dst: 'agents/pm/index.md' },
  { src: 'scripts/agents/pm/prompt-optimizer.md', dst: 'agents/pm/prompt-optimizer.md' },
  { src: 'scripts/agents/pm/pipeline-flow.md', dst: 'agents/pm/pipeline-flow.md' },
  { src: 'scripts/agents/pm/team-rules.md', dst: 'agents/pm/team-rules.md' },
  { src: 'scripts/agents/pm/model-strategy.md', dst: 'agents/pm/model-strategy.md' },
  { src: 'scripts/agents/pm/block-recovery.md', dst: 'agents/pm/block-recovery.md' },
  // Agent tree — Researcher
  { src: 'scripts/agents/researcher/index.md', dst: 'agents/researcher/index.md' },
  { src: 'scripts/agents/researcher/hypothesis.md', dst: 'agents/researcher/hypothesis.md' },
  { src: 'scripts/agents/researcher/security.md', dst: 'agents/researcher/security.md' },
  { src: 'scripts/agents/researcher/architecture.md', dst: 'agents/researcher/architecture.md' },
  { src: 'scripts/agents/researcher/quality.md', dst: 'agents/researcher/quality.md' },
  // Agent tree — Executor
  { src: 'scripts/agents/executor/index.md', dst: 'agents/executor/index.md' },
  { src: 'scripts/agents/executor/tdd.md', dst: 'agents/executor/tdd.md' },
  { src: 'scripts/agents/executor/file-ownership.md', dst: 'agents/executor/file-ownership.md' },
  { src: 'scripts/agents/executor/worktree.md', dst: 'agents/executor/worktree.md' },
  // Agent tree — Planner
  { src: 'scripts/agents/planner/index.md', dst: 'agents/planner/index.md' },
  { src: 'scripts/agents/planner/spec-format.md', dst: 'agents/planner/spec-format.md' },
  { src: 'scripts/agents/planner/crosslayer.md', dst: 'agents/planner/crosslayer.md' },
  // Agent tree — Reviewer
  { src: 'scripts/agents/reviewer/index.md', dst: 'agents/reviewer/index.md' },
  { src: 'scripts/agents/reviewer/scoring.md', dst: 'agents/reviewer/scoring.md' },
  // Agent tree — Conflict Manager
  { src: 'scripts/agents/conflict-manager/index.md', dst: 'agents/conflict-manager/index.md' },
  { src: 'scripts/agents/conflict-manager/merge-procedure.md', dst: 'agents/conflict-manager/merge-procedure.md' },
  { src: 'scripts/agents/conflict-manager/interface-watch.md', dst: 'agents/conflict-manager/interface-watch.md' },
  // Guidelines
  { src: 'scripts/guidelines/index.md', dst: 'guidelines/index.md' },
  { src: 'scripts/guidelines/coding-standards.md', dst: 'guidelines/coding-standards.md' },
  { src: 'scripts/guidelines/error-handling.md', dst: 'guidelines/error-handling.md' },
  { src: 'scripts/guidelines/testing-strategy.md', dst: 'guidelines/testing-strategy.md' },
  // SDK modules (optional — require @anthropic-ai/claude-agent-sdk)
  { src: 'scripts/hooks/shared/sdk-runner.js', dst: 'hooks/shared/sdk-runner.js' },
  { src: 'scripts/hooks/shared/sdk-reviewer.js', dst: 'hooks/shared/sdk-reviewer.js' },
  { src: 'scripts/hooks/shared/sdk-plan-checker.js', dst: 'hooks/shared/sdk-plan-checker.js' },
  { src: 'scripts/hooks/shared/sdk-researcher.js', dst: 'hooks/shared/sdk-researcher.js' },
  { src: 'scripts/hooks/shared/sdk-executor.js', dst: 'hooks/shared/sdk-executor.js' },
  { src: 'scripts/hooks/shared/sdk-analyzer.js', dst: 'hooks/shared/sdk-analyzer.js' },
  // Security modules
  { src: 'scripts/hooks/shared/hmac.js', dst: 'hooks/shared/hmac.js' },
];

// Subdirectories managed by Vela — orphan cleanup scans only these.
// Never touch: config.json (root), persona.md (root), install.js (root),
// state/, artifacts/, templates/, test-fixtures/, statusline.sh (root)
const MANAGED_DIRS = ['hooks', 'cli', 'cache', 'agents', 'guidelines', 'references'];

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
 * Returns array of relative paths (e.g. 'hooks/vela-pm.md').
 */
function findOrphans(velaDir) {
  const managedDsts = new Set(FILE_MANIFEST.map(f => f.dst));
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
      } catch (e) { /* permission or race — skip */ }
    }
  }
  return removed;
}

const command = (process.argv[2] && !process.argv[2].startsWith('-')) ? process.argv[2] : 'install';

switch (command) {
  case 'install': install(); break;
  case 'verify': verify(); break;
  case 'uninstall': uninstall(); break;
  case 'validate': {
    const results = validate();
    console.log(JSON.stringify({
      ok: true,
      command: 'validate',
      fixed: results.fixed.length,
      refreshed: results.refreshed.length,
      warnings: results.warnings.length,
      details: results
    }, null, 2));
    break;
  }
  case 'status': status(); break;
  case 'upgrade': upgrade(); break;
  default:
    console.log(JSON.stringify({ ok: false, error: `Unknown command: ${command}` }));
    process.exit(1);
}

function install() {
  // ─── Phase 0: Validate & Repair ───
  const validation = validate();

  // Ensure .claude/ directory exists
  const claudeDir = path.join(PROJECT_ROOT, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settings = readSettings();

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const installed = [];
  const errors = [];

  for (const hook of VELA_HOOKS) {
    const scriptPath = path.join(VELA_HOOKS_DIR, hook.script || '');

    // Verify script exists (skip for prompt-type hooks which have no script)
    if (hook.hookType !== 'prompt') {
      if (!fs.existsSync(scriptPath)) {
        errors.push(`Script not found: ${scriptPath}`);
        continue;
      }
    }

    // Initialize event array if needed
    if (!settings.hooks[hook.matcher]) {
      settings.hooks[hook.matcher] = [];
    }

    // Remove existing Vela hook entry with same ID (both legacy and new format)
    settings.hooks[hook.matcher] = settings.hooks[hook.matcher].filter(entry => {
      // Remove legacy flat format
      if (entry.command && !entry.hooks && entry.command.includes(hook.hookId)) return false;
      // Remove new nested format
      if (entry.hooks && Array.isArray(entry.hooks)) {
        return !entry.hooks.some(h =>
          (h.command && h.command.includes(hook.hookId)) ||
          (h.prompt && h.type === 'prompt' && entry._velaId === hook.hookId)
        );
      }
      return true;
    });

    // Build hookEntry based on hookType
    let hookEntry;
    if (hook.hookType === 'prompt') {
      hookEntry = {
        type: 'prompt',
        prompt: hook.prompt,
        timeout: 30,
        statusMessage: hook.description
      };
    } else {
      hookEntry = {
        type: 'command',
        command: `node "${scriptPath}"`,
        statusMessage: hook.description
      };
    }

    // Add async flag if present
    if (hook.async) {
      hookEntry.async = true;
    }

    // Add model field if present
    if (hook.model) {
      hookEntry.model = hook.model;
    }

    // Add if condition if present (tool events only)
    if (hook.if) {
      hookEntry.if = hook.if;
    }

    // Add the hook in correct Claude Code format:
    // { matcher: "ToolName", hooks: [{ type: "command"|"prompt", ... }] }
    const settingsEntry = {
      matcher: hook.toolMatcher || '',
      hooks: [hookEntry]
    };

    // Tag with vela ID for prompt hooks (no command string to match on)
    if (hook.hookType === 'prompt') {
      settingsEntry._velaId = hook.hookId;
    }

    settings.hooks[hook.matcher].push(settingsEntry);

    installed.push(hook.hookId);
  }

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
  settings.agent = 'vela';

  // ─── Set statusLine ───
  const statusLinePath = path.join(PROJECT_ROOT, '.vela', 'statusline.sh');
  if (fs.existsSync(statusLinePath)) {
    settings.statusLine = {
      type: 'command',
      command: statusLinePath,
      padding: 2
    };
  }

  // ─── Spinner Verbs (항해 테마) ───
  settings.spinnerVerbs = {
    mode: 'replace',
    verbs: [
      '⛵ 돛을 올리는 중', '🧭 해도를 펼치는 중', '✦ 별자리를 읽는 중',
      '🔭 수평선을 살피는 중', '⚓ 닻을 내리는 중', '🌟 항성을 추적하는 중',
      '🌊 조류를 읽는 중', '⛵ 순풍을 잡는 중', '✦ 자오선을 넘는 중',
      '🧭 경도를 측정하는 중', '🔭 성운을 관측하는 중', '🌟 천구를 회전하는 중'
    ]
  };

  // ─── Spinner Tips (Vela 철학) ───
  settings.spinnerTipsOverride = {
    excludeDefault: true,
    tips: [
      '⛵ 별을 따라 항해하라 — 모든 파이프라인은 목적지로 향한다',
      '🌟 품질은 지시가 아닌 구조로 강제된다',
      '🧭 연구 → 계획 → 실행 → 검증 — 항로를 건너뛰지 마라',
      '✦ Reviewer는 독립적으로 판단한다 — 편향 없는 별빛',
      '⛵ Vela(돛자리)는 하늘에서 가장 큰 별자리의 일부였다',
      '🔭 각 단계는 산출물로 증명된다 — 기록 없는 항해는 없다',
      '🧭 /vela:start 로 새로운 항해를 시작하세요',
      '✦ 같은 세션에서 자기 작업을 검증하면 편향이 생긴다',
      '⚓ Gate Keeper는 수문장, Gate Guard는 항해 규칙의 안내자',
      '🌟 승인 없이는 다음 항구로 갈 수 없다 — 검증이 통행증이다',
      '🌊 Agent Teams — 독립된 선원들이 각자의 관점으로 항해한다',
      '⛵ 구조로 강제하라, 지시에 의존하지 마라'
    ]
  };

  // ─── Startup Announcements ───
  settings.companyAnnouncements = [
    '⛵ Vela Engine 기관 점화 — 별자리가 오늘의 항로를 안내합니다.',
    '✦ 구조로 강제하고, 독립으로 검증하고, 기록으로 추적한다 — Vela의 세 가지 원칙.',
    '🧭 연구 → 계획 → 실행 → 검증. 돛자리의 네 별이 항로를 비춥니다.',
    '🌟 모든 위대한 항해는 첫 닻을 올리는 것에서 시작됩니다. /vela:start'
  ];

  // ─── Attribution (커밋/PR에 Vela 참조) ───
  settings.attribution = {
    commit: '⛵ Navigated by Vela Engine (https://github.com/EcoKG/vela)',
    pr: '⛵ This PR was navigated by [Vela Engine](https://github.com/EcoKG/vela) — 별자리 항해 기반 개발 거버넌스.'
  };

  // ─── Auto Mode (sandbox-safe bash auto-allow) ───
  settings.autoMode = {
    allow: [
      'Bash commands within .vela/ directory',
      'Bash commands for git status, log, diff, branch',
      'Read operations on any file'
    ],
    soft_deny: [
      'Bash commands that modify files outside .vela/',
      'Git push, reset, clean operations'
    ],
    environment: [
      'Project uses Vela pipeline governance',
      'All modifications require active pipeline'
    ]
  };

  writeSettings(settings);

  // Create state directory for session tracking (project-local)
  const stateDir = path.join(PROJECT_ROOT, '.vela', 'state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // ─── Deploy vela agent ───
  const agentsDir = path.join(PROJECT_ROOT, '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }
  const pmSourcePath = path.join(PROJECT_ROOT, '.vela', 'agents', 'vela.md');
  const pmTargetPath = path.join(agentsDir, 'vela.md');
  if (fs.existsSync(pmSourcePath)) {
    fs.copyFileSync(pmSourcePath, pmTargetPath);
  }

  // ─── Create CLAUDE.md if not exists ───
  const claudeMdPath = path.join(PROJECT_ROOT, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, `# Development Workflow — Vela

This project uses Vela for development governance.

- To explore/read code: use normal tools freely (Explore mode).
- To modify code: ALWAYS start with \`node .vela/cli/vela-engine.js init "<task>" --scale <small|medium|large>\`
- Follow pipeline steps in order. Do NOT use TaskCreate/TaskUpdate during pipeline execution.
- Do NOT skip pipeline steps or create your own plans outside the pipeline.
- Each team step uses Teammate (소통 필요) or Subagent (독립 작업). Model: Haiku(탐색), Sonnet(코딩/리뷰), Opus(설계/분석).
`);
  }

  const permissionCount = VELA_PERMISSIONS.deny.length + VELA_PERMISSIONS.allow.length;

  // Human-readable output (JSON with --json flag)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      ok: errors.length === 0, command: 'install', validation, installed,
      agent: 'vela', permissions: { deny: VELA_PERMISSIONS.deny.length, allow: VELA_PERMISSIONS.allow.length },
      errors, settings_path: SETTINGS_PATH
    }, null, 2));
  } else {
    console.log('');
    console.log('✦ Vela Engine — Installation Complete ✦');
    console.log('');
    console.log(`  ⛵ Hooks: ${installed.length} registered`);
    installed.forEach(h => console.log(`     ✓ ${h}`));
    console.log(`  🌟 Permissions: ${VELA_PERMISSIONS.deny.length} deny + ${VELA_PERMISSIONS.allow.length} allow`);
    console.log(`  🧭 Agent: vela`);
    console.log(`  🔭 StatusLine: active`);
    console.log(`  ✦ Spinner: ${12} nautical verbs`);
    console.log(`  ⛵ CLAUDE.md: ${fs.existsSync(claudeMdPath) ? 'exists' : 'created'}`);
    if (validation.fixed.length > 0) {
      console.log('');
      console.log('  🔧 Auto-repaired:');
      validation.fixed.forEach(f => console.log(`     ✓ ${f}`));
    }
    if (validation.warnings.length > 0) {
      console.log('');
      console.log('  ⚠ Warnings:');
      validation.warnings.forEach(w => console.log(`     ! ${w}`));
    }
    if (errors.length > 0) {
      console.log('');
      console.log('  ❌ Errors:');
      errors.forEach(e => console.log(`     ✗ ${e}`));
    }
    console.log('');
    console.log('✦─────────────────────✦');
    console.log('');
  }
}

function verify() {
  const settings = readSettings();
  const results = [];

  for (const hook of VELA_HOOKS) {
    const scriptPath = path.join(VELA_HOOKS_DIR, hook.script || '');

    // For prompt hooks, no script file to check
    const scriptExists = hook.hookType === 'prompt' ? true : fs.existsSync(scriptPath);

    const matcherHooks = settings.hooks?.[hook.matcher] || [];
    let registered;

    if (hook.hookType === 'prompt') {
      // Prompt hooks: check for type:'prompt' entry with matching _velaId or prompt content
      registered = matcherHooks.some(entry =>
        entry.hooks && Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h.type === 'prompt' && h.prompt) &&
        (entry._velaId === hook.hookId || (entry.hooks.some(h => h.prompt === hook.prompt)))
      );
    } else {
      // Command hooks: check for command string containing hookId
      registered = matcherHooks.some(entry =>
        entry.hooks && Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h.command && h.command.includes(hook.hookId))
      );
    }

    results.push({
      id: hook.hookId,
      matcher: hook.matcher,
      hookType: hook.hookType || 'command',
      script_exists: scriptExists,
      registered: registered,
      status: scriptExists && registered ? 'OK' : 'MISSING'
    });
  }

  const allOk = results.every(r => r.status === 'OK');

  console.log(JSON.stringify({
    ok: allOk,
    command: 'verify',
    hooks: results,
    message: allOk
      ? 'All Vela hooks verified successfully.'
      : 'Some hooks are missing or not registered.'
  }, null, 2));
}

function uninstall() {
  const settings = readSettings();
  let removedHooks = 0;
  let removedPerms = 0;

  // Remove hooks (both new and legacy format)
  if (settings.hooks) {
    for (const matcher of Object.keys(settings.hooks)) {
      const before = settings.hooks[matcher].length;
      settings.hooks[matcher] = settings.hooks[matcher].filter(entry => {
        // Remove legacy flat format: { command: "...vela...", description: "..." }
        if (entry.command && !entry.hooks && entry.command.includes(HOOK_PREFIX)) return false;
        // Remove new nested format: { matcher, hooks: [{ command: "...vela..." }] }
        if (entry.hooks && Array.isArray(entry.hooks)) {
          return !entry.hooks.some(h => h.command && h.command.includes(HOOK_PREFIX));
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
    const velaRules = new Set([...VELA_PERMISSIONS.deny, ...VELA_PERMISSIONS.allow]);

    if (settings.permissions.deny) {
      const before = settings.permissions.deny.length;
      settings.permissions.deny = settings.permissions.deny.filter(r => !velaRules.has(r));
      removedPerms += before - settings.permissions.deny.length;
      if (settings.permissions.deny.length === 0) delete settings.permissions.deny;
    }

    if (settings.permissions.allow) {
      const before = settings.permissions.allow.length;
      settings.permissions.allow = settings.permissions.allow.filter(r => !velaRules.has(r));
      removedPerms += before - settings.permissions.allow.length;
      if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
    }

    if (Object.keys(settings.permissions).length === 0) {
      delete settings.permissions;
    }
  }

  writeSettings(settings);

  console.log(JSON.stringify({
    ok: true,
    command: 'uninstall',
    removed_hooks: removedHooks,
    removed_permissions: removedPerms,
    message: `Removed ${removedHooks} hooks + ${removedPerms} permission rules.`
  }, null, 2));
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
                matcher: entry.matcher || '',
                command: hook.command,
                description: hook.statusMessage || ''
              });
            }
          }
        }
      }
    }
  }

  // Check permissions
  const permissions = {
    deny: (settings.permissions?.deny || []).filter(r => VELA_PERMISSIONS.deny.includes(r)),
    allow: (settings.permissions?.allow || []).filter(r => VELA_PERMISSIONS.allow.includes(r))
  };

  console.log(JSON.stringify({
    ok: true,
    command: 'status',
    vela_hooks: registered,
    hook_count: registered.length,
    vela_permissions: permissions,
    permission_count: permissions.deny.length + permissions.allow.length,
    settings_path: SETTINGS_PATH
  }, null, 2));
}

// ─── Upgrade ───

function upgrade() {
  const velaDir = path.join(PROJECT_ROOT, '.vela');
  if (!fs.existsSync(velaDir)) {
    console.log(JSON.stringify({ ok: false, error: 'Vela not installed. Run install first.' }));
    process.exit(1);
  }

  const skillBase = path.resolve(__dirname, '..');
  const results = { updated: [], added: [], skipped: [], errors: [] };

  // Filtered view: exclude files marked skipOnUpgrade (e.g. config.json)
  const upgradeFiles = FILE_MANIFEST.filter(f => !f.skipOnUpgrade);

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
  const pmSrc = path.join(velaDir, 'agents', 'vela.md');
  const pmDst = path.join(PROJECT_ROOT, '.claude', 'agents', 'vela.md');
  if (fs.existsSync(pmSrc) && fs.existsSync(path.dirname(pmDst))) {
    try {
      fs.copyFileSync(pmSrc, pmDst);
      results.updated.push('.claude/agents/vela.md');
    } catch (e) {
      results.errors.push(`.claude/agents/vela.md: ${e.message}`);
    }
  }

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
      results.orphansRemoved.push(...emptied.map(d => `${d}/ (empty dir)`));
    }
  } catch (e) {
    results.errors.push(`orphan cleanup scan: ${e.message}`);
  }

  console.log(JSON.stringify({
    ok: results.errors.length === 0,
    command: 'upgrade',
    updated: results.updated.length,
    added: results.added.length,
    skipped: results.skipped.length,
    orphansRemoved: results.orphansRemoved.length,
    errors: results.errors,
    details: results
  }, null, 2));
}

// ─── Validate & Repair ───

function validate() {
  const results = { fixed: [], refreshed: [], warnings: [], ok: [] };
  const velaDir = path.join(PROJECT_ROOT, '.vela');

  // 1. Required directories
  const requiredDirs = [
    'hooks', 'hooks/shared', 'cli', 'cache', 'templates',
    'state', 'artifacts', 'agents', 'references', 'guidelines',
    'agents/pm', 'agents/researcher', 'agents/executor',
    'agents/planner', 'agents/reviewer', 'agents/conflict-manager'
  ];
  for (const dir of requiredDirs) {
    const dirPath = path.join(velaDir, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      results.fixed.push(`Created missing directory: .vela/${dir}`);
    }
  }

  // 2. Required files — check and copy from skill if missing
  const skillBase = path.resolve(__dirname, '..');
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
        results.warnings.push(`Missing file: .vela/${f.dst} (source not found)`);
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
  const configPath = path.join(velaDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      // Broken config — restore from template
      const templateConfig = path.join(velaDir, 'templates', 'config.json');
      if (fs.existsSync(templateConfig)) {
        fs.copyFileSync(templateConfig, configPath);
        results.fixed.push('Repaired broken config.json from template');
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
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      let fixed = false;

      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          const before = settings.hooks[event].length;
          // Remove flat format hooks (legacy)
          settings.hooks[event] = settings.hooks[event].filter(entry => {
            if (entry.command && !entry.hooks) return false; // legacy flat format
            return true;
          });
          if (settings.hooks[event].length !== before) fixed = true;
        }
      }

      // Remove old agent name
      if (settings.agent === 'vela-pm') {
        settings.agent = 'vela';
        fixed = true;
      }

      if (fixed) {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        results.fixed.push('Cleaned legacy hooks/settings from settings.local.json');
      }
    } catch (e) {
      // Broken settings — will be overwritten by install
      results.fixed.push('settings.local.json was broken, will be recreated');
    }
  }

  // 6. Statusline.sh line endings (CRLF → LF)
  const statuslinePath = path.join(velaDir, 'statusline.sh');
  if (fs.existsSync(statuslinePath)) {
    const content = fs.readFileSync(statuslinePath, 'utf-8');
    if (content.includes('\r\n')) {
      fs.writeFileSync(statuslinePath, content.replace(/\r\n/g, '\n'));
      results.fixed.push('Fixed CRLF line endings in statusline.sh');
    }
  }

  // 7. .gitignore — ensure all Vela files are hidden from git
  const { execSync } = require('child_process');
  const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
  const velaGitEntries = ['.vela/', '.claude/', 'CLAUDE.md'];

  // Step 1: Remove already-tracked Vela files BEFORE updating .gitignore
  try {
    const tracked = execSync('git ls-files .vela/ .claude/ CLAUDE.md', {
      cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
    }).toString().trim();
    if (tracked) {
      execSync('git rm -r --cached --ignore-unmatch .vela/ .claude/ CLAUDE.md', {
        cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 10000
      });
      execSync('git commit -m "chore: untrack Vela files from git" --no-verify', {
        cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 10000
      });
      results.fixed.push('Removed Vela files from git tracking (files kept on disk)');
    }
  } catch (e) {
    // Not a git repo or git not available
  }

  // Step 2: Update .gitignore (after deletions are committed)
  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
  }
  const missingGit = velaGitEntries.filter(e => !gitignoreContent.includes(e));
  if (missingGit.length > 0) {
    const block = gitignoreContent.includes('# Vela Engine')
      ? missingGit.join('\n') + '\n'
      : '\n# Vela Engine (auto-managed)\n' + velaGitEntries.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, block);
    results.fixed.push(`Added ${missingGit.length} entries to .gitignore: ${missingGit.join(', ')}`);
  }

  // 8. System dependencies — install if missing

  // jq (required for statusline.sh)
  try {
    execSync('which jq', { stdio: 'pipe' });
    results.ok.push('jq');
  } catch (e) {
    // Try to install jq
    const platform = process.platform;
    let installed = false;
    const cmds = [
      'sudo apt-get install -y jq 2>/dev/null',
      'sudo yum install -y jq 2>/dev/null',
      'brew install jq 2>/dev/null',
      'apk add jq 2>/dev/null'
    ];
    for (const cmd of cmds) {
      try {
        execSync(cmd, { stdio: 'pipe', timeout: 30000 });
        installed = true;
        results.fixed.push('Installed missing dependency: jq');
        break;
      } catch (e2) {}
    }
    if (!installed) {
      results.warnings.push('jq not found and auto-install failed. Install manually: sudo apt install jq');
    }
  }

  // SQLite backend for TreeNode cache (optional — multiple fallbacks available)
  let sqliteBackend = 'none';
  try { require('better-sqlite3'); sqliteBackend = 'better-sqlite3'; }
  catch (e) {
    try { require('sql.js'); sqliteBackend = 'sql.js'; }
    catch (e2) {
      try { execSync('which sqlite3', { stdio: 'pipe' }); sqliteBackend = 'sqlite3-cli'; }
      catch (e3) { /* will use JSON fallback */ }
    }
  }
  if (sqliteBackend !== 'none') {
    results.ok.push(`TreeNode cache: ${sqliteBackend}`);
  } else {
    results.warnings.push('No SQLite backend found — TreeNode cache will use JSON fallback. Run: npm install better-sqlite3 (or sql.js for WSL1/proxy)');
  }

  // 9. Global pollution cleanup — remove vela files from ~/.claude/skills/
  // These should never exist; skills live only in the skill repository.
  // AI agents sometimes copy skills to ~/.claude/skills/ by mistake.
  const HOME = process.env.HOME || process.env.USERPROFILE;
  if (HOME) {
    const globalSkillsDir = path.join(HOME, '.claude', 'skills');
    if (fs.existsSync(globalSkillsDir)) {
      const velaDirs = [];
      try {
        for (const entry of fs.readdirSync(globalSkillsDir)) {
          if (entry === 'vela' || entry.startsWith('vela-')) {
            velaDirs.push(entry);
          }
        }
      } catch (e) { /* permission error — skip */ }

      for (const dir of velaDirs) {
        const dirPath = path.join(globalSkillsDir, dir);
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
          results.fixed.push(`Removed global pollution: ~/.claude/skills/${dir}`);
        } catch (e) {
          results.warnings.push(`Could not remove ~/.claude/skills/${dir}: ${e.message}`);
        }
      }
    }

    // Also clean up global commands/vela/ (legacy v1/v2)
    const globalCmdsDir = path.join(HOME, '.claude', 'commands', 'vela');
    if (fs.existsSync(globalCmdsDir)) {
      try {
        fs.rmSync(globalCmdsDir, { recursive: true, force: true });
        results.fixed.push('Removed legacy global commands: ~/.claude/commands/vela/');
      } catch (e) {
        results.warnings.push(`Could not remove ~/.claude/commands/vela/: ${e.message}`);
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
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
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
