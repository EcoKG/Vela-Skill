/**
 * Vela command — `init-project` (v8.0-M3)
 *
 * Bootstrap a project's `.vela/` directory from the Claude Code
 * plugin's install root. Called by the `/vela:install` slash command.
 *
 * What it does:
 *   1. Create .vela/ directory tree:
 *        config.json (seeded from plugin templates, skipIfExists)
 *        templates/ (pipeline.json, presets.json, guidelines/, plan-templates/)
 *        references/ (docs shipped in the plugin)
 *        state/workspace.json (projectRoot + pluginRoot + version pin)
 *        artifacts/ + learnings/ (empty)
 *   2. Ensure .gitignore hides Vela's runtime state (never git-tracked)
 *   3. Optionally clean pre-plugin (v7.x) curl-install leftovers:
 *        ~/.vela/hooks/ directory + its *.js files
 *        ~/.claude/skills/vela* directories
 *        ~/.claude/settings.json entries with _velaId starting with "vela-"
 *
 * The plugin root is resolved in this order:
 *   a. process.env.CLAUDE_PLUGIN_ROOT  (set by Claude Code when a
 *      plugin command fires)
 *   b. __dirname walk-up to the nearest .claude-plugin/plugin.json
 *      (allows direct-node invocation for local development)
 *
 * Output: JSON summary (velaDir, pluginRoot, created, cleanup).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Plugin-root resolution ─────────────────────────────────

function resolvePluginRoot() {
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv && fs.existsSync(path.join(fromEnv, ".claude-plugin", "plugin.json"))) {
    return fromEnv;
  }
  // Walk up from this file's location to find .claude-plugin/plugin.json.
  // When running from inside the plugin cache, __dirname is
  // ~/.claude/plugins/cache/vela/scripts/commands; its parent twice up is
  // the plugin root. Same holds for the source repo.
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not resolve plugin root — set CLAUDE_PLUGIN_ROOT or run from the plugin directory.",
  );
}

// ─── Directory copy (no external deps) ──────────────────────

function copyTree(srcDir, dstDir, { skipIfExists = [] } = {}) {
  if (!fs.existsSync(srcDir)) return { copied: 0, skipped: 0 };
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      const r = copyTree(s, d, { skipIfExists });
      copied += r.copied;
      skipped += r.skipped;
      continue;
    }
    if (skipIfExists.includes(entry.name) && fs.existsSync(d)) {
      skipped++;
      continue;
    }
    fs.copyFileSync(s, d);
    copied++;
  }
  return { copied, skipped };
}

// ─── .gitignore management ──────────────────────────────────

function ensureGitignoreBlock(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const velaEntries = [
    "# Vela Engine (auto-managed)",
    ".vela/artifacts/",
    ".vela/cache/",
    ".vela/state/",
    ".vela/learnings/",
  ];
  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf-8");
  }
  const missing = velaEntries.filter(
    (e) => !e.startsWith("#") && !content.includes(e),
  );
  if (missing.length === 0) return { updated: false };
  if (!content.includes("# Vela Engine")) {
    fs.appendFileSync(gitignorePath, "\n" + velaEntries.join("\n") + "\n");
  } else {
    fs.appendFileSync(gitignorePath, missing.join("\n") + "\n");
  }
  return { updated: true, added: missing };
}

// ─── Legacy (pre-plugin v7.x) cleanup ───────────────────────

const LEGACY_GLOBAL_HOOKS_DIR = path.join(os.homedir(), ".vela", "hooks");
const LEGACY_GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_PREFIX = "vela-";

function cleanupLegacy({ apply }) {
  const report = {
    globalHooksDir: null,
    globalSkillDirs: [],
    settingsEntriesRemoved: 0,
    settingsBackup: null,
  };

  // 1. ~/.vela/hooks/ — replaced by plugin cache
  if (fs.existsSync(LEGACY_GLOBAL_HOOKS_DIR)) {
    const files = fs.readdirSync(LEGACY_GLOBAL_HOOKS_DIR);
    report.globalHooksDir = { path: LEGACY_GLOBAL_HOOKS_DIR, files: files.length };
    if (apply) {
      fs.rmSync(LEGACY_GLOBAL_HOOKS_DIR, { recursive: true, force: true });
    }
  }

  // 2. ~/.claude/skills/vela*/ — replaced by plugin
  if (fs.existsSync(LEGACY_GLOBAL_SKILLS_DIR)) {
    for (const name of fs.readdirSync(LEGACY_GLOBAL_SKILLS_DIR)) {
      if (name === "vela" || name.startsWith("vela-") || name.startsWith("vela:")) {
        const p = path.join(LEGACY_GLOBAL_SKILLS_DIR, name);
        report.globalSkillDirs.push(p);
        if (apply) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      }
    }
  }

  // 3. ~/.claude/settings.json — remove _velaId entries (plugin hooks.json replaces)
  if (fs.existsSync(GLOBAL_SETTINGS_PATH)) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf-8"));
    } catch {
      settings = null;
    }
    if (settings && settings.hooks) {
      let removed = 0;
      for (const event of Object.keys(settings.hooks)) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter((entry) => {
          if (!entry) return false;
          if (entry._velaId && entry._velaId.startsWith(HOOK_PREFIX)) return false;
          if (entry.hooks && Array.isArray(entry.hooks)) {
            const has = entry.hooks.some(
              (h) =>
                h &&
                h.command &&
                (h.command.includes("/.vela/hooks/") ||
                  h.command.includes("/skills/vela")),
            );
            if (has) return false;
          }
          if (entry.command && (entry.command.includes("/.vela/hooks/") ||
                                 entry.command.includes("/skills/vela"))) {
            return false;
          }
          return true;
        });
        const after = settings.hooks[event].length;
        removed += before - after;
        if (after === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      report.settingsEntriesRemoved = removed;

      if (apply && removed > 0) {
        const backup = `${GLOBAL_SETTINGS_PATH}.pre-plugin-backup-${Date.now()}`;
        fs.copyFileSync(GLOBAL_SETTINGS_PATH, backup);
        fs.writeFileSync(
          GLOBAL_SETTINGS_PATH,
          JSON.stringify(settings, null, 2) + "\n",
          "utf-8",
        );
        report.settingsBackup = backup;
      }
    }
  }

  return report;
}

// ─── Main command ───────────────────────────────────────────

module.exports = function createCmdInitProject(ctx) {
  const { CWD, getFlag, hasFlag, output } = ctx;

  return function cmdInitProject() {
    let pluginRoot;
    try {
      pluginRoot = resolvePluginRoot();
    } catch (e) {
      return output({ ok: false, error: e.message });
    }

    // Determine target directory. vela-engine's resolveProjectRoot walks UP
    // looking for an existing `.vela/` — that's wrong for init-project,
    // which creates `.vela/` from scratch. Resolution order:
    //   1. --dir <path>           explicit override
    //   2. process.env.INIT_CWD   npm/node style pre-chdir cwd
    //   3. process.env.PWD        shell-set working directory (before chdir)
    //   4. CWD                    engine-resolved (walk-up result) fallback
    const dirFlag = getFlag("--dir");
    const preChdirCwd = process.env.INIT_CWD || process.env.PWD;
    const targetDir = dirFlag
      ? path.resolve(dirFlag)
      : preChdirCwd && fs.existsSync(preChdirCwd)
        ? preChdirCwd
        : CWD;

    const velaDir = path.join(targetDir, ".vela");
    const created = [];
    const skipped = [];

    // 1. Ensure all top-level dirs exist
    const dirs = ["templates", "references", "state", "artifacts", "learnings", "cache"];
    for (const d of dirs) {
      const p = path.join(velaDir, d);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        created.push(d + "/");
      } else {
        skipped.push(d + "/ (already exists)");
      }
    }

    // 2. Copy templates/ (skipIfExists config.json — user-owned)
    const tplSrc = path.join(pluginRoot, "templates");
    const tplDst = path.join(velaDir, "templates");
    const tplResult = copyTree(tplSrc, tplDst, { skipIfExists: ["config.json"] });

    // 3. Seed config.json at .vela/config.json (not nested under templates/)
    // This is the project-local, user-customisable config. skipIfExists.
    const configSrc = path.join(pluginRoot, "templates", "config.json");
    const configDst = path.join(velaDir, "config.json");
    if (fs.existsSync(configSrc) && !fs.existsSync(configDst)) {
      fs.copyFileSync(configSrc, configDst);
      created.push("config.json");
    } else if (fs.existsSync(configDst)) {
      skipped.push("config.json (user-owned, preserved)");
    }

    // 4. Copy references/
    const refSrc = path.join(pluginRoot, "references");
    const refDst = path.join(velaDir, "references");
    const refResult = copyTree(refSrc, refDst);

    // 5. Pin workspace.json (projectRoot + pluginRoot)
    let version = "8.0.0";
    try {
      version = JSON.parse(
        fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf-8"),
      ).version;
    } catch { /* keep default */ }
    fs.writeFileSync(
      path.join(velaDir, "state", "workspace.json"),
      JSON.stringify(
        {
          projectRoot: targetDir,
          pluginRoot,
          version,
          initializedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    created.push("state/workspace.json");

    // 6. .gitignore block
    const gi = ensureGitignoreBlock(targetDir);

    // 7. Legacy cleanup (default: auto unless --cleanup-legacy=skip)
    const cleanupFlag = getFlag("--cleanup-legacy") || "auto";
    let cleanup = null;
    if (cleanupFlag !== "skip" && cleanupFlag !== "false") {
      cleanup = cleanupLegacy({ apply: true });

      // Report to stderr so user sees it even when JSON is piped
      if (
        cleanup.globalHooksDir ||
        cleanup.globalSkillDirs.length > 0 ||
        cleanup.settingsEntriesRemoved > 0
      ) {
        process.stderr.write("\n⚠️  Vela legacy cleanup (pre-plugin v7.x):\n");
        if (cleanup.globalHooksDir) {
          process.stderr.write(
            `  ✓ Removed ${cleanup.globalHooksDir.path} (${cleanup.globalHooksDir.files} files)\n`,
          );
        }
        for (const p of cleanup.globalSkillDirs) {
          process.stderr.write(`  ✓ Removed ${p}\n`);
        }
        if (cleanup.settingsEntriesRemoved > 0) {
          process.stderr.write(
            `  ✓ Removed ${cleanup.settingsEntriesRemoved} legacy _velaId entries from ${GLOBAL_SETTINGS_PATH}\n`,
          );
          if (cleanup.settingsBackup) {
            process.stderr.write(`    Backup: ${cleanup.settingsBackup}\n`);
          }
        }
        process.stderr.write("\n");
      }
    }

    output({
      ok: true,
      command: "init-project",
      velaDir,
      pluginRoot,
      version,
      created,
      skipped,
      templates: tplResult,
      references: refResult,
      gitignore: gi,
      legacyCleanup: cleanup,
      message: `Vela initialized at ${velaDir}. Next: run \`vela-engine init "your task"\` or \`/vela:ship\`.`,
    });
  };
};
