/**
 * Vela command — `doctor` (v7.3-M4e-p5)
 *
 * Extracted from scripts/cli/vela-engine.js. Health check that verifies
 * every file/directory Vela depends on at runtime is present and
 * parseable. Used by CI smoke tests and by users after an install or
 * upgrade.
 *
 * Checks (each adds one row to `checks[]`):
 *   1. Core directories     .vela, cli, agents, templates, state, ...
 *   2. Required files       cli/vela-engine.js, templates/pipeline.json,
 *                           config.json, state/workspace.json, CLAUDE.md
 *   3. Agent manifest       vela.md + 4 role agents (v8.0)
 *   4. pipeline.json parses + contains the standard pipeline
 *   5. config.json parses as JSON
 *   6. v7.1 template additions (role-budgets, plan-templates, guidelines)
 *
 * Output: JSON with ok/checks/missing/recovery. `recovery` points at
 * `node .vela/install.js validate` for self-heal.
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

    // 1. Core directories
    const coreDirs = [
      ".vela",
      ".vela/cli",
      ".vela/agents",
      ".vela/templates",
      ".vela/state",
      ".vela/artifacts",
      ".vela/hooks",
      ".vela/shared",
    ];
    for (const d of coreDirs) {
      const abs = path.join(CWD, d);
      addCheck(
        `dir:${d}`,
        fs.existsSync(abs) && fs.statSync(abs).isDirectory(),
      );
    }

    // 2. Required files
    const coreFiles = [
      ".vela/cli/vela-engine.js",
      ".vela/templates/pipeline.json",
      ".vela/config.json",
      ".vela/state/workspace.json", // v7.0.7
      "CLAUDE.md",
    ];
    for (const f of coreFiles) {
      const abs = path.join(CWD, f);
      addCheck(`file:${f}`, fs.existsSync(abs));
    }

    // 3. Agent manifest — every v7.1 role the PM may spawn
    const agents = [
      "vela.md",
      "vela-researcher.md",
      "vela-planner.md",
      "vela-executor.md",
      "vela-reviewer.md",
    ];
    for (const a of agents) {
      const abs = path.join(CWD, ".vela", "agents", a);
      addCheck(`agent:${a}`, fs.existsSync(abs));
    }

    // 4. pipeline.json parses
    try {
      const raw = fs.readFileSync(
        path.join(CWD, ".vela", "templates", "pipeline.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw);
      addCheck(
        "parse:pipeline.json",
        !!(parsed && parsed.pipelines && parsed.pipelines.standard),
      );
    } catch (e) {
      addCheck("parse:pipeline.json", false, e.message);
    }

    // 5. config.json parses
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

    // 6. v7.1 template + hook additions
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
    output({
      ok: allOk,
      command: "doctor",
      checks,
      missing,
      ...(allOk
        ? { message: "All Vela files present and parseable." }
        : {
            message: `${missing.length} missing check(s). Run repair path below.`,
            recovery: "node .vela/install.js validate",
          }),
    });
  };
};
