#!/usr/bin/env node
/**
 * Vela SessionStart hook — Version check with update prompt injection
 *
 * Triggered on every Claude Code session start. Compares the locally-installed
 * global Vela skill version against the latest GitHub main branch version.
 * If a new version is available, injects a system instruction into session
 * context telling Claude to ask the user whether to update.
 *
 * Fast & silent: 24-hour cache, 2s network timeout, silent on any error.
 *
 * Registered via install.sh/update.sh in ~/.claude/settings.json.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

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

/**
 * Safely read and parse a JSON file. Returns null on any error.
 */
function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Safely write a JSON file. Silent on any error.
 */
function writeJsonSafe(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // ignore
  }
}

/**
 * Fetch the latest version from GitHub. Returns null on timeout/error.
 */
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

/**
 * Compare semver strings. Returns 1 if a>b, -1 if a<b, 0 if equal/invalid.
 */
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
 * Read stdin JSON (SessionStart hook input). Returns null on error.
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve(null);
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

async function main() {
  // Consume stdin to avoid blocking (we don't use the payload currently)
  await readStdin();

  // 1. Read local version
  const localPkg = readJsonSafe(GLOBAL_SKILL_PACKAGE_JSON);
  if (!localPkg || !localPkg.version) {
    // Vela not installed globally — silent exit
    process.exit(0);
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
    // 3. Fetch latest version from GitHub
    latestVersion = await fetchLatestVersion();
    if (!latestVersion) {
      // Network failed — silent exit (no output, no cache bust)
      process.exit(0);
    }
    // Persist cache
    writeJsonSafe(CACHE_FILE, {
      checkedAt: now,
      localVersion,
      latestVersion,
    });
  }

  // 4. Compare versions
  const cmp = compareVersions(latestVersion, localVersion);
  if (cmp <= 0) {
    // Up to date or local is newer — silent exit
    process.exit(0);
  }

  // 5. New version available — inject context for Claude
  const message = [
    "",
    "⛵ VELA UPDATE AVAILABLE",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `  Current: v${localVersion}`,
    `  Latest:  v${latestVersion}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "[SYSTEM INSTRUCTION FOR CLAUDE]",
    `Vela \uc5d4\uc9c4\uc758 \uc0c8 \ubc84\uc804(v${latestVersion})\uc774 \ub9b4\ub9ac\uc2a4\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \ud604\uc7ac \uc124\uce58\ub41c \ubc84\uc804\uc740 v${localVersion}\uc785\ub2c8\ub2e4.`,
    "",
    "\ub2e4\uc74c \uc808\ucc28\ub97c \uc218\ud589\ud558\uc138\uc694:",
    `1. AskUserQuestion\uc73c\ub85c \"\u26f5 Vela \uc5d4\uc9c4\uc5d0 \uc0c8 \ubc84\uc804(v${localVersion} \u2192 v${latestVersion})\uc774 \uc788\uc2b5\ub2c8\ub2e4. \uc9c0\uae08 \uc5c5\ub370\uc774\ud2b8\ud560\uae4c\uc694?\" \ub77c\uace0 \ubb3c\uc5b4\ubcf4\uc138\uc694. \uc120\ud0dd\uc9c0\ub294 \"\uc9c0\uae08 \uc5c5\ub370\uc774\ud2b8 (Recommended)\", \"\ub098\uc911\uc5d0\" \ub450 \uac1c.`,
    '2. \uc0ac\uc6a9\uc790\uac00 "\uc9c0\uae08 \uc5c5\ub370\uc774\ud2b8"\ub97c \uc120\ud0dd\ud558\uba74 `/vela:update` \uc2a4\ud0ac\uc744 \uc2e4\ud589\ud558\uc138\uc694.',
    '3. \uc0ac\uc6a9\uc790\uac00 "\ub098\uc911\uc5d0" \ub610\ub294 "None of the above"\ub97c \uc120\ud0dd\ud558\uba74 \uc774 \uc9c0\uc2dc\uc0ac\ud56d\uc744 \ubb34\uc2dc\ud558\uace0 \uba48\ucd94\uc138\uc694.',
    "4. \ubcc4\ub3c4\uc758 \uc778\uc0ac\ub098 \uc124\uba85 \uc5c6\uc774 \ubc14\ub85c \uc774 \uc9c8\ubb38\ubd80\ud130 \uba3c\uc800 \ubcf4\uc5ec\uc8fc\uc138\uc694.",
    "",
    "[END SYSTEM INSTRUCTION]",
    "",
  ].join("\n");

  // SessionStart stdout is injected as context Claude can see
  process.stdout.write(message);
  process.exit(0);
}

main().catch(() => process.exit(0));
