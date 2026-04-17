/**
 * Vela Core — CLI utility primitives (v7.3-M4e)
 *
 * Extracted from scripts/cli/vela-engine.js during the v8.0 engine
 * decomposition. These are the pure, stateless helpers that every
 * Vela command touches:
 *
 *   slugifyEx        — fs-safe UTF-8 byte-aware slug (v7.1 M5)
 *   slugify          — back-compat string-returning wrapper
 *   cleanState       — strip internal underscore-prefixed fields
 *   writeJSON        — atomic write (tmp + rename) with mkdir -p
 *   output           — pretty-print a JSON blob to stdout
 *   autoDetectScale  — heuristic scale picker (small/medium/large)
 *
 * These functions must remain pure — no hidden dependencies on the
 * engine's module-level constants (CWD, ARTIFACTS_DIR, args). That
 * constraint is what makes them safe to extract as a leaf module.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/**
 * v7.1 M5: fs-safe slugify.
 *
 * Pre-v7.1 this used `.substring(0, 30)`, a JS char count. In the hicoco
 * session Korean requests produced artifact directories named
 * "별도-downloa", "대상-사이", "baseurl" — the 30-char limit truncated
 * mid-word because a Korean syllable is 1 JS char but 3 UTF-8 bytes, and
 * nothing enforced cutting on a word boundary.
 *
 * v7.1 behaviour:
 *   1. normalise (lowercase, strip non-[a-z0-9가-힣] except `-` and space)
 *   2. collapse whitespace to `-`
 *   3. cap at 64 UTF-8 bytes, not chars
 *   4. if we had to truncate, walk back to the nearest `-` boundary so we
 *      never cut through a word or a multi-byte codepoint
 *   5. if truncated, append `-trunc` so the caller can tell at a glance
 *
 * Returns an object so callers can decide whether to write a side-car
 * request.txt with the full original request (cmdInit does this when
 * truncated).
 */
function slugifyEx(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const MAX_BYTES = 64;
  // v7.1 M5: always leave headroom for the "-trunc" suffix. Pre-v7.1 the
  // cap was applied first and the suffix was appended afterwards, which
  // meant a request that landed at exactly MAX_BYTES would overflow once
  // "-trunc" got tacked on. Budget the suffix in from the start so the
  // post-truncate directory name is guaranteed ≤ MAX_BYTES.
  const TRUNC_SUFFIX = "-trunc";
  const BUDGET = MAX_BYTES - Buffer.byteLength(TRUNC_SUFFIX, "utf8");

  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes <= MAX_BYTES) {
    return { slug: normalized || "task", truncated: false };
  }

  // Walk down codepoint by codepoint until we are within the byte budget.
  // Buffer.byteLength is the authoritative check — substring() would
  // happily split a multi-byte char.
  let cut = normalized;
  while (Buffer.byteLength(cut, "utf8") > BUDGET) {
    cut = cut.slice(0, -1);
  }
  // Prefer a `-` boundary so we never cut mid-word.
  const lastDash = cut.lastIndexOf("-");
  if (lastDash > 8) {
    // Only snap back if we keep at least 8 chars — don't collapse a long
    // request into "a-trunc" because the first word happened to be "a-".
    cut = cut.slice(0, lastDash);
  }
  cut = cut.replace(/-+$/g, "");
  if (!cut) cut = "task";
  return { slug: cut + TRUNC_SUFFIX, truncated: true, originalBytes: bytes };
}

/**
 * Back-compat wrapper. Existing callers (cmdBranch, cmdInit) used to get a
 * plain string, so slugify() still does. Use slugifyEx() when you need the
 * truncation flag — cmdInit does, because it writes a request.txt side-car
 * when the slug had to be shortened.
 */
function slugify(text) {
  return slugifyEx(text).slug;
}

/**
 * Strip internal-use underscore-prefixed fields from a state object
 * before serialising to disk or emitting over stdout.
 */
function cleanState(state) {
  const clean = { ...state };
  delete clean._path;
  delete clean._artifactDir;
  delete clean._stale;
  return clean;
}

/**
 * Atomic JSON write. Writes to `${filePath}.tmp` then renames so a
 * crash mid-write never leaves a partially-written state file.
 * Ensures the parent directory exists (mkdir -p).
 */
function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Emit a JSON blob to stdout with two-space indent. Every CLI
 * command's final response goes through this — the engine speaks
 * only JSON so callers (PM, tests, shell scripts) can parse it.
 */
function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2));
}

/**
 * Word-count-based scale heuristic. Used only as a last-resort
 * fallback when no explicit `--scale` flag is passed.
 */
function autoDetectScale(request) {
  const words = request.split(/\s+/).length;
  if (words <= 10) return "small";
  if (words <= 30) return "medium";
  return "large";
}

module.exports = {
  slugifyEx,
  slugify,
  cleanState,
  writeJSON,
  output,
  autoDetectScale,
};
