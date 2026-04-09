/**
 * Vela Project Environment Detector
 *
 * Detects the project's language, framework, test runner, linter, and
 * package manager by inspecting well-known config files and directory
 * structure. Results are used to enrich SDK agent step prompts and the
 * SessionStart hook with project-aware context.
 *
 * Exports: detectProjectEnvironment(cwd) → ProjectEnv
 *
 * Design decisions:
 * - Pure fs/path — no child_process, no SDK dependency
 * - All errors are suppressed (try/catch) — never crashes the caller
 * - Results cached per cwd for process lifetime
 * - Returns conservative defaults when detection is ambiguous
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Cache ────────────────────────────────────────────────────
/** @type {Object.<string, ProjectEnv>} */
const _cache = {};

// ─── Types ────────────────────────────────────────────────────

/**
 * @typedef {Object} ProjectEnv
 * @property {"node"|"python"|"rust"|"go"|"java"|"kotlin"|"ruby"|"php"|"unknown"} language
 * @property {"jest"|"vitest"|"mocha"|"tap"|"pytest"|"unittest"|"cargo"|"go test"|"rspec"|"phpunit"|null} testRunner
 * @property {"eslint"|"biome"|"tslint"|"ruff"|"flake8"|"pylint"|"clippy"|"golangci"|null} linter
 * @property {"react"|"vue"|"svelte"|"angular"|"next"|"nuxt"|"express"|"fastapi"|"django"|"flask"|"actix"|"axum"|"gin"|null} framework
 * @property {"npm"|"yarn"|"pnpm"|"pip"|"poetry"|"cargo"|"go"|"bundler"|"composer"|null} packageManager
 * @property {boolean} hasTests
 * @property {string|null} testDir
 * @property {boolean} hasTypeScript
 * @property {number} fileCount
 * @property {string} summary  — one-line human readable description
 */

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Safely read and JSON-parse a file. Returns null on any error.
 * @param {string} filePath
 * @returns {any|null}
 */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Check if a file exists. Returns false on any error.
 * @param {string} filePath
 * @returns {boolean}
 */
function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Count files tracked by git (or via shallow fs scan as fallback).
 * @param {string} cwd
 * @returns {number}
 */
function countFiles(cwd) {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("git", ["ls-files"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).toString();
    return out.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    // Fallback: shallow scan excluding noisy dirs
    const EXCLUDE = new Set(["node_modules", ".git", ".vela", "dist", "build", "__pycache__"]);
    let count = 0;
    try {
      for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
        if (EXCLUDE.has(entry.name)) continue;
        if (entry.isFile()) count++;
        else if (entry.isDirectory()) {
          try {
            for (const sub of fs.readdirSync(path.join(cwd, entry.name), { withFileTypes: true })) {
              if (!EXCLUDE.has(sub.name) && sub.isFile()) count++;
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
    return count;
  }
}

// ─── Detection Helpers ────────────────────────────────────────

/**
 * Detect language + package manager from well-known config files.
 */
function detectLanguage(cwd) {
  // Node.js
  if (exists(path.join(cwd, "package.json"))) {
    const pm = exists(path.join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : exists(path.join(cwd, "yarn.lock"))
      ? "yarn"
      : "npm";
    return { language: "node", packageManager: pm };
  }
  // Python
  if (exists(path.join(cwd, "pyproject.toml")) || exists(path.join(cwd, "setup.py")) || exists(path.join(cwd, "requirements.txt"))) {
    const pm = exists(path.join(cwd, "poetry.lock")) ? "poetry" : "pip";
    return { language: "python", packageManager: pm };
  }
  // Rust
  if (exists(path.join(cwd, "Cargo.toml"))) {
    return { language: "rust", packageManager: "cargo" };
  }
  // Go
  if (exists(path.join(cwd, "go.mod"))) {
    return { language: "go", packageManager: "go" };
  }
  // Java / Kotlin
  if (exists(path.join(cwd, "pom.xml")) || exists(path.join(cwd, "build.gradle")) || exists(path.join(cwd, "build.gradle.kts"))) {
    return { language: "java", packageManager: null };
  }
  // Ruby
  if (exists(path.join(cwd, "Gemfile"))) {
    return { language: "ruby", packageManager: "bundler" };
  }
  // PHP
  if (exists(path.join(cwd, "composer.json"))) {
    return { language: "php", packageManager: "composer" };
  }

  return { language: "unknown", packageManager: null };
}

/**
 * Detect test runner from package.json scripts / config files.
 */
function detectTestRunner(cwd, language) {
  if (language === "node") {
    const pkg = readJson(path.join(cwd, "package.json"));
    if (pkg) {
      const devDeps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (devDeps.vitest) return "vitest";
      if (devDeps.jest) return "jest";
      if (devDeps.mocha) return "mocha";
      if (devDeps.tap || devDeps["node:test"]) return "tap";
      // Check scripts
      const scripts = pkg.scripts || {};
      const testScript = scripts.test || "";
      if (/vitest/.test(testScript)) return "vitest";
      if (/jest/.test(testScript)) return "jest";
      if (/mocha/.test(testScript)) return "mocha";
    }
  }
  if (language === "python") {
    if (exists(path.join(cwd, "pytest.ini")) || exists(path.join(cwd, "conftest.py"))) return "pytest";
    const pyproject = exists(path.join(cwd, "pyproject.toml"))
      ? fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf-8")
      : "";
    if (/\[tool\.pytest/.test(pyproject)) return "pytest";
    if (/\[tool\.unittest/.test(pyproject)) return "unittest";
    return "pytest"; // default Python
  }
  if (language === "rust") return "cargo";
  if (language === "go") return "go test";
  if (language === "ruby") return "rspec";
  if (language === "php") return "phpunit";
  return null;
}

/**
 * Detect linter.
 */
function detectLinter(cwd, language) {
  if (language === "node") {
    if (exists(path.join(cwd, "biome.json")) || exists(path.join(cwd, "biome.jsonc"))) return "biome";
    if (
      exists(path.join(cwd, ".eslintrc.js")) ||
      exists(path.join(cwd, ".eslintrc.json")) ||
      exists(path.join(cwd, ".eslintrc.cjs")) ||
      exists(path.join(cwd, "eslint.config.js")) ||
      exists(path.join(cwd, "eslint.config.mjs"))
    ) return "eslint";
    const pkg = readJson(path.join(cwd, "package.json"));
    if (pkg && pkg.devDependencies) {
      if (pkg.devDependencies.biome) return "biome";
      if (pkg.devDependencies.eslint) return "eslint";
      if (pkg.devDependencies.tslint) return "tslint";
    }
  }
  if (language === "python") {
    if (exists(path.join(cwd, "ruff.toml")) || exists(path.join(cwd, ".ruff.toml"))) return "ruff";
    const pyproject = exists(path.join(cwd, "pyproject.toml"))
      ? fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf-8")
      : "";
    if (/\[tool\.ruff/.test(pyproject)) return "ruff";
    if (/\[tool\.flake8/.test(pyproject) || exists(path.join(cwd, ".flake8"))) return "flake8";
    if (/\[tool\.pylint/.test(pyproject)) return "pylint";
  }
  if (language === "rust") return "clippy";
  if (language === "go") return "golangci";
  return null;
}

/**
 * Detect framework from package.json deps / config files.
 */
function detectFramework(cwd, language) {
  if (language === "node") {
    const pkg = readJson(path.join(cwd, "package.json"));
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return "next";
      if (deps.nuxt) return "nuxt";
      if (deps["@sveltejs/kit"] || deps.svelte) return "svelte";
      if (deps["@angular/core"]) return "angular";
      if (deps.react) return "react";
      if (deps.vue) return "vue";
      if (deps.express) return "express";
      if (deps.fastify) return "fastify";
      if (deps.koa) return "koa";
    }
  }
  if (language === "python") {
    const req = exists(path.join(cwd, "requirements.txt"))
      ? fs.readFileSync(path.join(cwd, "requirements.txt"), "utf-8").toLowerCase()
      : "";
    const pyproject = exists(path.join(cwd, "pyproject.toml"))
      ? fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf-8").toLowerCase()
      : "";
    const combined = req + pyproject;
    if (/fastapi/.test(combined)) return "fastapi";
    if (/django/.test(combined)) return "django";
    if (/flask/.test(combined)) return "flask";
  }
  if (language === "rust") {
    const cargoToml = exists(path.join(cwd, "Cargo.toml"))
      ? fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf-8").toLowerCase()
      : "";
    if (/axum/.test(cargoToml)) return "axum";
    if (/actix/.test(cargoToml)) return "actix";
    if (/rocket/.test(cargoToml)) return "rocket";
  }
  if (language === "go") {
    const goSum = exists(path.join(cwd, "go.sum"))
      ? fs.readFileSync(path.join(cwd, "go.sum"), "utf-8").toLowerCase()
      : "";
    if (/gin-gonic\/gin/.test(goSum)) return "gin";
    if (/gofiber\/fiber/.test(goSum)) return "fiber";
  }
  return null;
}

/**
 * Detect TypeScript usage.
 */
function detectTypeScript(cwd) {
  return exists(path.join(cwd, "tsconfig.json")) || exists(path.join(cwd, "tsconfig.base.json"));
}

/**
 * Detect test directory.
 */
function detectTestDir(cwd) {
  const candidates = ["test", "tests", "__tests__", "spec", "specs", "src/__tests__", "src/test"];
  for (const candidate of candidates) {
    if (exists(path.join(cwd, candidate))) return candidate;
  }
  return null;
}

// ─── Main Export ──────────────────────────────────────────────

/**
 * Detect and return the project environment fingerprint.
 * Results are cached per-cwd.
 *
 * @param {string} [cwd] - Working directory to inspect (defaults to process.cwd())
 * @returns {ProjectEnv}
 */
function detectProjectEnvironment(cwd) {
  const dir = (typeof cwd === "string" && cwd) || process.cwd();

  // Cache hit
  if (_cache[dir]) return _cache[dir];

  /** @type {ProjectEnv} */
  const env = {
    language: "unknown",
    testRunner: null,
    linter: null,
    framework: null,
    packageManager: null,
    hasTests: false,
    testDir: null,
    hasTypeScript: false,
    fileCount: 0,
    summary: "unknown project",
  };

  try {
    const { language, packageManager } = detectLanguage(dir);
    env.language = language;
    env.packageManager = packageManager;
    env.testRunner = detectTestRunner(dir, language);
    env.linter = detectLinter(dir, language);
    env.framework = detectFramework(dir, language);
    env.hasTypeScript = detectTypeScript(dir);
    env.testDir = detectTestDir(dir);
    env.hasTests = env.testDir !== null;
    env.fileCount = countFiles(dir);

    // Build human-readable summary
    const parts = [language];
    if (env.framework) parts.push(env.framework);
    if (env.hasTypeScript && language === "node") parts.push("TypeScript");
    if (env.testRunner) parts.push(`test:${env.testRunner}`);
    if (env.linter) parts.push(`lint:${env.linter}`);
    env.summary = parts.join(" | ");
  } catch {
    // Silent — return defaults
  }

  _cache[dir] = env;
  return env;
}

/**
 * Format a ProjectEnv as a markdown block for injection into agent prompts.
 *
 * @param {ProjectEnv} env
 * @returns {string}
 */
function formatEnvBlock(env) {
  const lines = ["## 프로젝트 환경"];
  lines.push(`- 언어: ${env.language}${env.hasTypeScript ? " (TypeScript)" : ""}`);
  if (env.framework) lines.push(`- 프레임워크: ${env.framework}`);
  if (env.packageManager) lines.push(`- 패키지 관리자: ${env.packageManager}`);
  if (env.testRunner) lines.push(`- 테스트 러너: ${env.testRunner}${env.testDir ? ` (${env.testDir}/)` : ""}`);
  if (env.linter) lines.push(`- 린터: ${env.linter}`);
  lines.push(`- 파일 수: ${env.fileCount}`);
  return lines.join("\n");
}

module.exports = { detectProjectEnvironment, formatEnvBlock };
