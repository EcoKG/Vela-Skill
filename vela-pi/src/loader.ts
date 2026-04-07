#!/usr/bin/env node
/**
 * Vela-Pi Startup Loader
 *
 * Mirrors gsd-pi's dist/loader.js pattern but:
 *   - Points PI_PACKAGE_DIR to vela-pi/pkg/ (piConfig: name=vela, configDir=.vela)
 *   - Discovers Vela extension + GSD bundled extensions for GSD_BUNDLED_EXTENSION_PATHS
 *   - Imports gsd-pi/dist/cli.js directly (bypasses GSD's loader.js which would
 *     overwrite PI_PACKAGE_DIR with its own pkg/)
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Paths ───────────────────────────────────────────────────────────────────

const velaRoot = resolve(__dirname, "..");
const pkgDir = join(velaRoot, "pkg");

// ─── PI_PACKAGE_DIR — MUST be set before any gsd-pi import fires ─────────────
// config.js in pi-coding-agent reads this to determine APP_NAME and CONFIG_DIR_NAME.
process.env.PI_PACKAGE_DIR = pkgDir;
process.title = "vela";

// ─── Fast-path: --version / --help ───────────────────────────────────────────
const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-v") {
  const req = createRequire(import.meta.url);
  const pkg = req(join(velaRoot, "package.json")) as { version: string };
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

// ─── Node version check ───────────────────────────────────────────────────────
const MIN_NODE_MAJOR = 22;
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(
    `\nError: Vela requires Node.js >= ${MIN_NODE_MAJOR}.0.0\n` +
      `       You are running Node.js ${process.versions.node}\n\n`
  );
  process.exit(1);
}

// ─── Resolve gsd-pi root ──────────────────────────────────────────────────────
const req = createRequire(import.meta.url);
let gsdPiRoot: string;
try {
  gsdPiRoot = dirname(req.resolve("gsd-pi/package.json"));
} catch {
  process.stderr.write(
    "\nError: gsd-pi not found. Run: npm install -g vela-pi\n\n"
  );
  process.exit(1);
}

// ─── NODE_PATH — make gsd-pi's node_modules resolvable by extensions ─────────
// Extensions loaded via jiti/dynamic import resolve from pi-coding-agent's
// location, not ours. Prepending gsd-pi's node_modules fixes this.
const gsdNodeModules = join(gsdPiRoot, "node_modules");
process.env.NODE_PATH = [gsdNodeModules, process.env.NODE_PATH]
  .filter(Boolean)
  .join(delimiter);

// Force Node to re-evaluate module search paths with the updated NODE_PATH.
// Must happen synchronously before the cli.js dynamic import.
const { Module } = await import("module");
(Module as unknown as { _initPaths?: () => void })._initPaths?.();

// ─── Workspace packages — link @gsd/* from gsd-pi/packages/ ─────────────────
// gsd-pi uses npm workspaces. When installed globally the packages are at
// gsd-pi/packages/. We symlink them into gsd-pi/node_modules/@gsd/ so that
// imports of @gsd/pi-coding-agent etc. resolve correctly.
const gsdScopeDir = join(gsdNodeModules, "@gsd");
const packagesDir = join(gsdPiRoot, "packages");
const wsPackages = [
  "native",
  "pi-agent-core",
  "pi-ai",
  "pi-coding-agent",
  "pi-tui",
];

try {
  if (!existsSync(gsdScopeDir)) mkdirSync(gsdScopeDir, { recursive: true });
  for (const pkg of wsPackages) {
    const target = join(gsdScopeDir, pkg);
    const source = join(packagesDir, pkg);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      symlinkSync(source, target, "junction");
    } catch {
      // Symlink failed (Windows without Developer Mode / no admin rights).
      // Fall back to a directory copy — slower but universally works.
      try {
        cpSync(source, target, { recursive: true });
      } catch {
        // non-fatal
      }
    }
  }
} catch {
  // non-fatal — startup will surface any missing package errors naturally
}

// ─── GSD_BUNDLED_EXTENSION_PATHS ─────────────────────────────────────────────
// gsd-pi/dist/cli.js reads this env var to decide which extensions to load.
// We include:
//   1. GSD's bundled extensions (gsd-pi/dist/resources/extensions/) — needed
//      because cli.js imports ./resources/extensions/gsd/preferences.js at
//      startup and several GSD extensions provide platform-level features.
//   2. Our Vela extension (dist/resources/extensions/vela/index.js).
const { serializeBundledExtensionPaths } = (await import(
  `${gsdPiRoot}/dist/bundled-extension-paths.js`
)) as {
  serializeBundledExtensionPaths: (paths: string[]) => string;
};

const { discoverExtensionEntryPaths } = (await import(
  `${gsdPiRoot}/dist/extension-discovery.js`
)) as {
  discoverExtensionEntryPaths: (dir: string) => string[];
};

// GSD bundled extensions (from gsd-pi's dist/)
const gsdDistExtDir = join(gsdPiRoot, "dist", "resources", "extensions");
const gsdExtPaths = existsSync(gsdDistExtDir)
  ? discoverExtensionEntryPaths(gsdDistExtDir)
  : [];

// Vela extension (from our dist/ after build)
const velaExtPath = join(
  velaRoot,
  "dist",
  "resources",
  "extensions",
  "vela",
  "index.js"
);

const allExtPaths = [...gsdExtPaths, velaExtPath].filter((p) => existsSync(p));
process.env.GSD_BUNDLED_EXTENSION_PATHS =
  serializeBundledExtensionPaths(allExtPaths);

// ─── GSD_CODING_AGENT_DIR — point to ~/.vela/agent/ instead of ~/.gsd/agent/ ─
// gsd-pi/dist/cli.js uses agentDir from app-paths.js which honours this var.
const homeDir = process.env.HOME || process.env.USERPROFILE || "";
process.env.GSD_CODING_AGENT_DIR = join(homeDir, ".vela", "agent");

// ─── Suppress GSD's own update check ─────────────────────────────────────────
process.env.PI_SKIP_VERSION_CHECK = "1";

// ─── Import gsd-pi/dist/cli.js (the Pi platform) ─────────────────────────────
// We import cli.js directly — NOT gsd-pi/dist/loader.js — because loader.js
// would overwrite PI_PACKAGE_DIR with GSD's own pkg/ directory, breaking
// our .vela config dir and "vela" branding.
await import(`${gsdPiRoot}/dist/cli.js`);
