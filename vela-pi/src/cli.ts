/**
 * Vela Standalone CLI — Phase 7
 *
 * Direct Pi SDK entry point — replaces the gsd-pi/dist/cli.js dependency.
 * Eliminates GSD-specific startup (preferences, RTK, managed tools, web mode, etc.)
 * and loads ONLY the Vela extension.
 *
 * Flow:
 *   loader.ts sets PI_PACKAGE_DIR, NODE_PATH, GSD_BUNDLED_EXTENSION_PATHS (vela only)
 *     → imports this file directly instead of gsd-pi/dist/cli.js
 *
 * Supported flags (matching gsd-pi's interface for drop-in compatibility):
 *   --version / -v           print version
 *   --help / -h              print help
 *   --print / -p <msg>       single-shot print mode
 *   --mode text|json|rpc     output mode (print mode variant)
 *   --model <id>             override model
 *   --continue / -c          continue most recent session
 *   --no-session             ephemeral session (no disk persistence)
 *   --append-system-prompt <text|file>  append to system prompt
 *   --list-models            list available models and exit
 *   <message>                initial message (interactive mode)
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createAgentSession,
  InteractiveMode,
  runPrintMode,
  runRpcMode,
} from "@gsd/pi-coding-agent";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const req = createRequire(import.meta.url);
const pkg = req(join(__dirname, "..", "package.json")) as {
  version: string;
  piConfig?: { name?: string; configDir?: string };
};

const APP_NAME = process.env.PI_APP_NAME ?? pkg.piConfig?.name ?? "vela";
const APP_VERSION = pkg.version;

const agentDir =
  process.env.GSD_CODING_AGENT_DIR ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? "", `.${APP_NAME}`, "agent");

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

interface CliFlags {
  print?: boolean;
  mode?: "text" | "json" | "rpc";
  model?: string;
  continue?: boolean;
  noSession?: boolean;
  appendSystemPrompt?: string;
  listModels?: boolean | string;
  messages: string[];
  extensions: string[];
  verbose?: boolean;
  _selectedSessionPath?: string;
}

function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { messages: [], extensions: [] };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode" && i + 1 < args.length) {
      const m = args[++i];
      if (m === "text" || m === "json" || m === "rpc") flags.mode = m;
    } else if (arg === "--print" || arg === "-p") {
      flags.print = true;
    } else if (arg === "--continue" || arg === "-c") {
      flags.continue = true;
    } else if (arg === "--no-session") {
      flags.noSession = true;
    } else if (arg === "--model" && i + 1 < args.length) {
      flags.model = args[++i];
    } else if (arg === "--extension" && i + 1 < args.length) {
      flags.extensions.push(args[++i]);
    } else if (arg === "--append-system-prompt" && i + 1 < args.length) {
      flags.appendSystemPrompt = args[++i];
    } else if (arg === "--list-models") {
      flags.listModels =
        i + 1 < args.length && !args[i + 1].startsWith("-")
          ? args[++i]
          : true;
    } else if (arg === "--version" || arg === "-v") {
      process.stdout.write(APP_VERSION + "\n");
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--verbose") {
      flags.verbose = true;
    } else if (!arg.startsWith("--") && !arg.startsWith("-")) {
      flags.messages.push(arg);
    }
  }

  return flags;
}

function printHelp(): void {
  process.stdout.write(
    `${APP_NAME} v${APP_VERSION} — Vela deterministic pipeline engine\n\n` +
      `Usage: ${APP_NAME} [options] [message]\n\n` +
      `Options:\n` +
      `  --print, -p <msg>    Single-shot: send message, print response, exit\n` +
      `  --mode text|json|rpc Output mode (use with --print)\n` +
      `  --model <id>         Override model (e.g. anthropic/claude-opus-4-5)\n` +
      `  --continue, -c       Continue most recent session\n` +
      `  --no-session         Ephemeral session (no disk persistence)\n` +
      `  --list-models        List available models and exit\n` +
      `  --verbose            Verbose startup output\n` +
      `  --version, -v        Print version\n` +
      `  --help, -h           Print this help\n\n` +
      `Vela commands (inside session):\n` +
      `  /vela start "<request>"   Start a new pipeline\n` +
      `  /vela status              Show pipeline state\n` +
      `  /vela transition          Advance to next step\n` +
      `  /vela dispatch            Run agent for current step\n` +
      `  /vela help                Show all Vela commands\n`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const cliFlags = parseCliArgs(process.argv);
const isPrintMode = cliFlags.print === true || cliFlags.mode !== undefined;

// TTY check (interactive mode requires a terminal)
if (!process.stdin.isTTY && !isPrintMode && cliFlags.listModels === undefined) {
  process.stderr.write(
    `[${APP_NAME}] Error: Interactive mode requires a terminal (TTY).\n` +
      `[${APP_NAME}] Non-interactive alternatives:\n` +
      `[${APP_NAME}]   ${APP_NAME} --print "your message"     Single-shot prompt\n` +
      `[${APP_NAME}]   ${APP_NAME} --mode rpc                 JSON-RPC over stdin/stdout\n`
  );
  process.exit(1);
}

// V8 compile cache (Node 22+)
if (parseInt(process.versions.node) >= 22) {
  process.env.NODE_COMPILE_CACHE ??= join(agentDir, ".compile-cache");
}

// ─── Shared Setup ─────────────────────────────────────────────────────────────

const authFilePath = join(agentDir, "auth.json");
const authStorage = AuthStorage.create(authFilePath);

// Load stored API keys from auth.json into process.env
try {
  const { loadStoredEnvKeys } = (await import(
    `${dirname(req.resolve("gsd-pi/package.json"))}/dist/wizard.js`
  )) as { loadStoredEnvKeys: (auth: typeof authStorage) => void };
  loadStoredEnvKeys(authStorage);
} catch {
  // Non-fatal: auth may come from env vars directly (ANTHROPIC_API_KEY, etc.)
}

const modelsJsonPath = join(agentDir, "models.json");
const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath);
const settingsManager = SettingsManager.create(agentDir);

// Quiet startup — Vela uses its own branding
if (!settingsManager.getQuietStartup()) {
  settingsManager.setQuietStartup(true);
}
if (!settingsManager.getCollapseChangelog()) {
  settingsManager.setCollapseChangelog(true);
}

// ─── --list-models ────────────────────────────────────────────────────────────

if (cliFlags.listModels !== undefined) {
  const models = modelRegistry.getAvailable();
  if (models.length === 0) {
    console.log("No models available. Set API keys in environment variables.");
    process.exit(0);
  }

  const searchPattern =
    typeof cliFlags.listModels === "string" ? cliFlags.listModels : undefined;
  let filtered = models;
  if (searchPattern) {
    const q = searchPattern.toLowerCase();
    filtered = models.filter((m) =>
      `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q)
    );
  }
  filtered.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

  const hdrs = ["provider", "model", "name"];
  const rows = filtered.map((m) => [m.provider, m.id, m.name]);
  const widths = hdrs.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(hdrs.map((h, i) => pad(h, widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
  }
  process.exit(0);
}

// ─── Resource Loader ─────────────────────────────────────────────────────────

// Read --append-system-prompt (may be a file path or literal text)
let appendSystemPrompt: string | undefined;
if (cliFlags.appendSystemPrompt) {
  try {
    if (existsSync(cliFlags.appendSystemPrompt)) {
      appendSystemPrompt = readFileSync(cliFlags.appendSystemPrompt, "utf-8");
    } else {
      appendSystemPrompt = cliFlags.appendSystemPrompt;
    }
  } catch {
    appendSystemPrompt = cliFlags.appendSystemPrompt;
  }
}

const resourceLoader = new DefaultResourceLoader({
  agentDir,
  additionalExtensionPaths:
    cliFlags.extensions.length > 0 ? cliFlags.extensions : undefined,
  appendSystemPrompt,
});
await resourceLoader.reload();

// ─── Session Manager ──────────────────────────────────────────────────────────

let sessionManager: SessionManager;
if (cliFlags.noSession) {
  sessionManager = SessionManager.inMemory();
} else if (cliFlags._selectedSessionPath) {
  sessionManager = SessionManager.open(cliFlags._selectedSessionPath);
} else if (cliFlags.continue) {
  sessionManager = SessionManager.continueRecent(process.cwd());
} else {
  sessionManager = SessionManager.create(process.cwd());
}

// ─── Agent Session ────────────────────────────────────────────────────────────

const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager,
  resourceLoader,
});

// Log extension errors (non-fatal)
for (const err of extensionsResult.errors) {
  process.stderr.write(`[${APP_NAME}] Extension error: ${err.error}\n`);
}

// Apply --model override
if (cliFlags.model) {
  const available = modelRegistry.getAvailable();
  const match =
    available.find((m) => m.id === cliFlags.model) ||
    available.find((m) => `${m.provider}/${m.id}` === cliFlags.model);
  if (match) {
    try {
      await session.setModel(match);
    } catch {
      // non-fatal
    }
  }
}

// ─── Print Mode ───────────────────────────────────────────────────────────────

if (isPrintMode) {
  const mode = cliFlags.mode ?? "text";

  if (mode === "rpc") {
    await runRpcMode(session);
    session.dispose();
    process.exit(0);
  }

  const initialMessage = cliFlags.messages[0];
  await runPrintMode(session, {
    mode: mode === "json" ? "json" : "text",
    initialMessage,
    messages: cliFlags.messages.slice(1),
  });
  session.dispose();
  process.exit(0);
}

// ─── Interactive TUI Mode ─────────────────────────────────────────────────────

const initialMessage = cliFlags.messages.length > 0 ? cliFlags.messages.join(" ") : undefined;

const interactiveMode = new InteractiveMode(session, {
  modelFallbackMessage,
  initialMessage,
  verbose: cliFlags.verbose === true,
});

await interactiveMode.run();
session.dispose();
process.exit(0);
