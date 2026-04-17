/**
 * Vela command — `doctor` (v8.0 — plugin-aware)
 *
 * Extracted from scripts/cli/vela-engine.js. Health check that verifies
 * both the plugin's install location and the project's local `.vela/`
 * are intact and parseable. Used by CI smoke tests and by users after
 * an install, upgrade, or `/vela:install --resync`.
 *
 * Checks (each adds one row to `checks[]`):
 *   1. Plugin root        CLAUDE_PLUGIN_ROOT env var set + dir exists
 *   2. Plugin artifacts   scripts/cli/vela-engine.js, hooks/hooks.json,
 *                         .claude-plugin/plugin.json, agents/vela.md
 *   3. Project .vela/     templates/, state/workspace.json, config.json
 *   4. Pipeline parseable templates/pipeline.json has ship/fix/hotfix
 *   5. Config parseable   config.json parses as JSON
 *   6. v7.1 template      role-budgets.json, plan-templates, guidelines
 *      artifacts present
 *
 * Output: JSON with ok/checks/missing/recovery. Recovery points at
 * `/vela:install --resync` for self-heal of project state, or
 * `/plugin update vela` for plugin-side issues.
 *
 * v8.0-M6: rewrote for plugin layout. v7.x .vela/cli/,
 * .vela/agents/, .vela/hooks/, .vela/shared/ checks removed — those
 * directories live at ${CLAUDE_PLUGIN_ROOT}/scripts/ and
 * ${CLAUDE_PLUGIN_ROOT}/agents/ now.
 */

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function createCmdDoctor(ctx) {
  const { CWD, output } = ctx;

  return function cmdDoctor() {
    const checks = [];
    const missing = [];

    function addCheck(name, ok, detail) {
      checks.push({ name, ok, detail: detail || null });
      if (!ok) missing.push(name);
    }

    // ── 1. Plugin root (v8.0) ─────────────────────────────
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const pluginRootOk = !!(
      pluginRoot &&
      fs.existsSync(pluginRoot) &&
      fs.existsSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"))
    );
    addCheck(
      "plugin:CLAUDE_PLUGIN_ROOT",
      pluginRootOk,
      pluginRoot || "(env var not set)",
    );

    // ── 2. Plugin artifacts (v8.0) ───────────────────────
    if (pluginRootOk) {
      const pluginFiles = [
        ".claude-plugin/plugin.json",
        "hooks/hooks.json",
        "scripts/cli/vela-engine.js",
        "scripts/hooks/vela-gate.js",
        "scripts/hooks/vela-stop.js",
        "scripts/hooks/vela-session.js",
        "agents/vela.md",
        "agents/vela-researcher.md",
        "agents/vela-planner.md",
        "agents/vela-executor.md",
        "agents/vela-reviewer.md",
      ];
      for (const f of pluginFiles) {
        addCheck(`plugin:${f}`, fs.existsSync(path.join(pluginRoot, f)));
      }
    }

    // ── 3. Project .vela/ directories ───────────────────
    const projectDirs = [
      ".vela",
      ".vela/templates",
      ".vela/state",
      ".vela/artifacts",
    ];
    for (const d of projectDirs) {
      const abs = path.join(CWD, d);
      addCheck(
        `dir:${d}`,
        fs.existsSync(abs) && fs.statSync(abs).isDirectory(),
      );
    }

    // ── 4. Project files ────────────────────────────────
    const projectFiles = [
      ".vela/config.json",
      ".vela/templates/pipeline.json",
      ".vela/state/workspace.json",
    ];
    for (const f of projectFiles) {
      const abs = path.join(CWD, f);
      addCheck(`file:${f}`, fs.existsSync(abs));
    }

    // ── 5. pipeline.json parses + has v8.0 pipelines ───
    try {
      const raw = fs.readFileSync(
        path.join(CWD, ".vela", "templates", "pipeline.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw);
      const hasV80Pipelines = !!(
        parsed &&
        parsed.pipelines &&
        parsed.pipelines.ship &&
        parsed.pipelines.fix &&
        parsed.pipelines.hotfix
      );
      addCheck("parse:pipeline.json", hasV80Pipelines);
    } catch (e) {
      addCheck("parse:pipeline.json", false, e.message);
    }

    // ── 6. config.json parses ───────────────────────────
    try {
      const raw = fs.readFileSync(
        path.join(CWD, ".vela", "config.json"),
        "utf8",
      );
      JSON.parse(raw);
      addCheck("parse:config.json", true);
    } catch (e) {
      addCheck("parse:config.json", false, e.message);
    }

    // ── 7. v7.1 template additions (project-local) ─────
    const v71Files = [
      ".vela/templates/role-budgets.json",
      ".vela/templates/plan-templates/quick.md",
      ".vela/templates/guidelines/live-processes.json",
      ".vela/templates/guidelines/smoke-test.sh.example",
    ];
    for (const f of v71Files) {
      const abs = path.join(CWD, f);
      addCheck(`file:${f}`, fs.existsSync(abs));
    }

    const allOk = missing.length === 0;
    let recovery;
    if (!pluginRootOk) {
      recovery = "/plugin install vela@EcoKG/Vela-Skill";
    } else if (missing.some((m) => m.startsWith("plugin:"))) {
      recovery = "/plugin update vela";
    } else {
      recovery = "/vela:install --resync";
    }

    output({
      ok: allOk,
      command: "doctor",
      pluginRoot: pluginRoot || null,
      checks,
      missing,
      ...(allOk
        ? { message: "All Vela plugin + project files present and parseable." }
        : {
            message: `${missing.length} missing check(s). Run repair: ${recovery}`,
            recovery,
          }),
    });
  };
};
