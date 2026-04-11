/**
 * Mechanical Locate — Deterministic file/symbol identification from a request.
 *
 * Tier 1 of v6.1 Universal Locate (LLM-free).
 *
 * Purpose:
 *   Given a natural-language work description, identify the file(s)/symbol(s)
 *   the user wants to modify. Replaces PM/executor's grep-by-guess approach
 *   with a deterministic, LLM-free coordinate identification.
 *
 * Algorithm:
 *   1. Extract candidate identifiers from the request (regex-based, language-agnostic)
 *   2. Resolve file_path tokens via git ls-files (highest precision)
 *   3. Resolve symbol tokens via ripgrep word-boundary matching
 *   4. Compute blast_radius (files that import the primary files)
 *   5. Output targets.json with confidence verdict
 *
 * Confidence verdict:
 *   high   — single file_path match OR ≤3 symbol matches with one clearly dominant file
 *   medium — 4-10 primary files matched (PM should AskUserQuestion to confirm)
 *   low    — no matches OR >10 matches → fall back to semantic locate or ask user
 *
 * No LLM calls. ripgrep + git only. Average runtime: 0.2-2 seconds.
 *
 * @module locate
 * @see docs/v6.1-rfc-precision-locate.md
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────

const SAFE_RG_TIMEOUT_MS = 10_000;
const MAX_RG_BUFFER = 5 * 1024 * 1024;
const SAFE_GIT_TIMEOUT_MS = 5_000;

/**
 * Files/dirs to exclude from ripgrep — overridable via options.excludePaths.
 * Mirrors change-surface.js DEFAULT_EXCLUDE_PATHS plus build artifacts.
 */
const DEFAULT_EXCLUDE_PATHS = [
  "node_modules",
  ".git",
  ".vela/artifacts",
  ".vela/cache",
  ".vela/state",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  ".nuxt",
];

/**
 * Korean and English noise words filtered out of token extraction.
 * These never identify a file or symbol — they describe the action.
 */
const NOISE_TOKENS = new Set([
  // Korean nouns/verbs
  "함수", "파일", "모듈", "추가", "수정", "변경", "삭제", "제거",
  "구현", "리팩토링", "리팩터링", "버그", "오류", "에러", "기능",
  "테스트", "검증", "확인", "분석", "이거", "그거", "저거",
  "처리", "관리", "사용자", "사용", "지원", "필요", "가능",
  // English fillers
  "the", "and", "for", "with", "from", "into", "this", "that",
  "function", "file", "module", "add", "remove", "delete",
  "fix", "implement", "refactor", "test", "feature", "support",
  "create", "update", "change", "modify", "verify", "check",
]);

/**
 * Token extractors — ordered by weight (file paths win).
 * Each extractor returns matched substrings from a request line.
 *
 * weight: relative confidence (higher = more reliable signal)
 * pattern: regex with capturing group(s); first group = the token
 */
const REQUEST_TOKEN_EXTRACTORS = [
  // 1. Explicit file paths — highest confidence
  //    Matches: "src/auth.ts", "auth.ts", "auth.ts:42"
  //    Extensions ordered LONGEST FIRST so alternation picks the
  //    longest match (e.g. `.json` before `.js`, `.tsx` before `.ts`).
  //    JS regex alternation is left-to-right, so a naive `.js|.json`
  //    would match `.js` in `pipeline.json` and lose the `on` suffix.
  {
    name: "file_path",
    weight: 10,
    pattern:
      /([\w./@-]+\.(?:svelte|scss|toml|yaml|bash|json|java|swift|tsx|jsx|mjs|cjs|html|mdx|yml|sql|css|vue|cpp|md|js|ts|py|go|rb|php|cs|sh|kt|rs|c|h))(?::(\d+))?/g,
  },

  // 2. Quoted identifiers — high confidence (user explicitly delimited)
  //    Matches: "loginHandler", `auth`, 'UserService'
  {
    name: "quoted",
    weight: 8,
    pattern: /[`'"]([\w.@/-]{2,})[`'"]/g,
  },

  // 3. PascalCase — class/type/component name conventions
  //    Matches: "LoginHandler", "UserRepository"
  //    Excludes single capital words like "API", "URL" (those go to constants)
  {
    name: "pascal_case",
    weight: 6,
    pattern: /\b([A-Z][a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+|[A-Z][a-z]+[A-Z][a-zA-Z0-9]*)\b/g,
  },

  // 4. camelCase — function/variable name conventions
  //    Matches: "loginHandler", "getUserById"
  {
    name: "camel_case",
    weight: 6,
    pattern: /\b([a-z][a-z0-9]+[A-Z][a-zA-Z0-9]+)\b/g,
  },

  // 5. UPPER_SNAKE_CASE — constants
  {
    name: "upper_snake",
    weight: 5,
    pattern: /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g,
  },

  // 6. snake_case — Python/Ruby/Rust function names
  {
    name: "snake_case",
    weight: 5,
    pattern: /\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/g,
  },

  // 7. kebab-case — CLI command / file basename style
  //    Matches: "vela-engine", "auth-middleware"
  {
    name: "kebab_case",
    weight: 4,
    pattern: /\b([a-z][a-z0-9]+(?:-[a-z0-9]+){1,})\b/g,
  },
];

// ─── Token Extraction ─────────────────────────────────────────

/**
 * Extract candidate tokens from a natural-language request.
 * Returns deduplicated, weight-ranked token list.
 *
 * @param {string} request - Natural language work description
 * @returns {Array<{ token: string, type: string, weight: number, lineHint?: number }>}
 */
function extractRequestTokens(request) {
  if (!request || typeof request !== "string") return [];

  const found = new Map(); // lowercase token → { token, type, weight, lineHint }

  for (const extractor of REQUEST_TOKEN_EXTRACTORS) {
    // Re-create regex for each extractor (preserve flags, reset lastIndex)
    const re = new RegExp(extractor.pattern.source, extractor.pattern.flags);
    let m;
    while ((m = re.exec(request)) !== null) {
      const token = m[1];
      if (!token || token.length < 2) continue;
      if (NOISE_TOKENS.has(token.toLowerCase())) continue;

      // Capture line hint if extractor is file_path (e.g. "auth.ts:42" → 42)
      const lineHint =
        extractor.name === "file_path" && m[2] ? parseInt(m[2], 10) : undefined;

      const key = token.toLowerCase();
      const existing = found.get(key);
      // Keep the highest-weight extractor's match for this token
      if (!existing || existing.weight < extractor.weight) {
        found.set(key, {
          token,
          type: extractor.name,
          weight: extractor.weight,
          lineHint,
        });
      }
    }
  }

  // Sort by weight descending, then by length descending (more specific first)
  return Array.from(found.values()).sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.token.length - a.token.length;
  });
}

// ─── grep / git Helpers ───────────────────────────────────────

/**
 * Check tool availability — ripgrep first, git grep as fallback.
 * Cached after first call.
 */
let _rgAvailable = null;
let _gitGrepAvailable = null;

function isRgAvailable() {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    execSync("rg --version", { stdio: "ignore", timeout: 2000 });
    _rgAvailable = true;
  } catch {
    _rgAvailable = false;
  }
  return _rgAvailable;
}

function isGitGrepAvailable() {
  if (_gitGrepAvailable !== null) return _gitGrepAvailable;
  try {
    // git grep needs to be in a git repo to work; we just check the binary
    execSync("git --version", { stdio: "ignore", timeout: 2000 });
    _gitGrepAvailable = true;
  } catch {
    _gitGrepAvailable = false;
  }
  return _gitGrepAvailable;
}

/**
 * Returns one of: "rg" | "git" | "none".
 * Used by callers that want to know which backend is in use.
 */
function searchBackend() {
  if (isRgAvailable()) return "rg";
  if (isGitGrepAvailable()) return "git";
  return "none";
}

/**
 * Reset cached availability — for tests.
 */
function _resetRgCache() {
  _rgAvailable = null;
  _gitGrepAvailable = null;
}

/**
 * Shell-escape a token for safe shell argument usage.
 */
function shellEscape(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

/**
 * Search via ripgrep. Returns matches in normalized form.
 * @private
 */
function _rgSearchImpl(token, options) {
  const cwd = options.cwd || process.cwd();
  const excludePaths = options.excludePaths || DEFAULT_EXCLUDE_PATHS;
  const maxCount = options.maxCount || 50;
  const wordFlag = options.wordBoundary !== false ? "--word-regexp" : "";
  // For each exclude path, emit BOTH the exact match and the subtree match
  // so files and directories are both handled uniformly.
  const excludeArgs = excludePaths
    .flatMap((p) => [`--glob '!${p}'`, `--glob '!${p}/**'`])
    .join(" ");

  // Escape regex metacharacters when word-boundary mode (which uses regex)
  const escapedToken =
    options.wordBoundary !== false
      ? token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : token;
  const fixedFlag = options.wordBoundary !== false ? "" : "--fixed-strings";

  let raw;
  try {
    raw = execSync(
      `rg ${fixedFlag} ${wordFlag} --line-number --no-heading --max-count ${maxCount} ${excludeArgs} -- ${shellEscape(escapedToken)} .`,
      {
        cwd,
        encoding: "utf-8",
        maxBuffer: MAX_RG_BUFFER,
        timeout: SAFE_RG_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    if (err.status === 1) return []; // no matches
    return [];
  }

  return _parseGrepOutput(raw);
}

/**
 * Search via git grep. Used as fallback when ripgrep is unavailable.
 * Searches tracked files only, but that's the right scope (Vela only
 * cares about repository contents anyway).
 * @private
 */
function _gitGrepSearchImpl(token, options) {
  const cwd = options.cwd || process.cwd();
  const excludePaths = options.excludePaths || DEFAULT_EXCLUDE_PATHS;
  const maxCount = options.maxCount || 50;

  // git grep pathspec exclusion: ":(exclude)pattern"
  // Emit both exact + subtree forms so single files and directories both
  // get excluded (e.g. "scripts/tests/test-locate.sh" is a file; the "/**"
  // form alone would never match).
  const excludeArgs = excludePaths
    .flatMap((p) => [`':(exclude)${p}'`, `':(exclude)${p}/**'`])
    .join(" ");

  // git grep flags:
  //   -n line numbers, -I skip binaries, -F fixed string, -w word boundary
  //   --max-count caps per-file matches (git 2.21+)
  const wordFlag = options.wordBoundary !== false ? "-w" : "";
  const fixedFlag = "-F";

  let raw;
  try {
    raw = execSync(
      `git grep -n -I ${fixedFlag} ${wordFlag} --max-count=${maxCount} -- ${shellEscape(token)} ${excludeArgs}`,
      {
        cwd,
        encoding: "utf-8",
        maxBuffer: MAX_RG_BUFFER,
        timeout: SAFE_RG_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    if (err.status === 1) return []; // no matches
    return [];
  }

  return _parseGrepOutput(raw);
}

/**
 * Parse `file:line:content` output from rg or git grep.
 * @private
 */
function _parseGrepOutput(raw) {
  if (!raw || !raw.trim()) return [];
  const matches = [];
  for (const rgLine of raw.trim().split("\n")) {
    const colonIdx1 = rgLine.indexOf(":");
    if (colonIdx1 === -1) continue;
    const colonIdx2 = rgLine.indexOf(":", colonIdx1 + 1);
    if (colonIdx2 === -1) continue;

    const file = rgLine.slice(0, colonIdx1).replace(/^\.\//, "");
    const lineNum = parseInt(rgLine.slice(colonIdx1 + 1, colonIdx2), 10);
    const content = rgLine.slice(colonIdx2 + 1);

    if (Number.isNaN(lineNum)) continue;
    matches.push({ file, line: lineNum, content: content.trim() });
  }
  return matches;
}

/**
 * Run a grep search for a single token. Tries ripgrep first, falls back
 * to `git grep` if rg is unavailable. Both backends return the same
 * normalized format.
 *
 * @param {string} token
 * @param {{ cwd?: string, excludePaths?: string[], wordBoundary?: boolean, maxCount?: number }} [options]
 * @returns {Array<{ file: string, line: number, content: string }>}
 */
function rgSearch(token, options = {}) {
  if (!token || token.length < 2) return [];
  const backend = searchBackend();
  if (backend === "rg") return _rgSearchImpl(token, options);
  if (backend === "git") return _gitGrepSearchImpl(token, options);
  return [];
}

/**
 * List all tracked + untracked (non-ignored) files in the repo.
 * Cached per cwd for the duration of a single locate() call.
 * @private
 */
function _listRepoFiles(cwd) {
  try {
    const raw = execSync(
      "git ls-files --cached --others --exclude-standard",
      {
        cwd,
        encoding: "utf-8",
        maxBuffer: MAX_RG_BUFFER,
        timeout: SAFE_GIT_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return raw ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a file_path token to actual tracked files via git ls-files.
 * Uses 3-tier matching: exact → ends-with → basename.
 *
 * @param {string} fileToken - e.g. "auth.ts" or "src/auth.ts"
 * @param {{ cwd: string }} options
 * @returns {string[]} matching tracked file paths (relative to cwd)
 */
function findFilesByPathToken(fileToken, options = {}) {
  if (!fileToken) return [];
  const cwd = options.cwd || process.cwd();
  const files = _listRepoFiles(cwd);
  if (files.length === 0) return [];

  const lowerToken = fileToken.toLowerCase().replace(/^\.\//, "");

  // Tier 1: exact full-path match
  const exact = files.filter((f) => f.toLowerCase() === lowerToken);
  if (exact.length > 0) return exact;

  // Tier 2: ends with the token (e.g. "auth.ts" matches "src/auth.ts")
  const endsWith = files.filter(
    (f) =>
      f.toLowerCase().endsWith("/" + lowerToken) ||
      f.toLowerCase() === lowerToken,
  );
  if (endsWith.length > 0) return endsWith;

  // Tier 3: basename match (e.g. "auth.ts" matches "anywhere/auth.ts")
  const basename = files.filter(
    (f) => path.basename(f).toLowerCase() === lowerToken,
  );
  return basename;
}

/**
 * Find files whose basename CONTAINS the token as a substring.
 * Used for kebab-case tokens that look like filename stems
 * (e.g. "vela-engine" → "scripts/cli/vela-engine.js").
 *
 * Capped at 10 matches — if more, returns empty (token too generic).
 *
 * @param {string} token
 * @param {{ cwd: string }} options
 * @returns {string[]}
 */
function findFilesByBasenameSubstring(token, options = {}) {
  if (!token || token.length < 4) return [];
  const cwd = options.cwd || process.cwd();
  const files = _listRepoFiles(cwd);
  if (files.length === 0) return [];

  const lowerToken = token.toLowerCase();
  const matches = files.filter((f) =>
    path.basename(f).toLowerCase().includes(lowerToken),
  );

  // If too many matches, the token is too generic — caller will fall back
  // to grep or ask the user.
  if (matches.length > 10) return [];

  return matches;
}

// ─── Blast Radius ─────────────────────────────────────────────

/**
 * Determine which files import or reference the primary files.
 * Uses simple basename grep with import-context filter.
 *
 * @param {string[]} primaryFiles - Files identified as primary targets
 * @param {{ cwd: string, excludePaths?: string[] }} options
 * @returns {Array<{ file: string, reason: string, match_source: string }>}
 */
function computeBlastRadius(primaryFiles, options = {}) {
  if (!primaryFiles || primaryFiles.length === 0) return [];

  const blast = [];
  const seen = new Set();

  for (const primary of primaryFiles) {
    // Use basename without extension as the import-target name
    const basename = path.basename(primary).replace(/\.[^.]+$/, "");
    if (basename.length < 3) continue;

    const matches = rgSearch(basename, {
      cwd: options.cwd,
      excludePaths: options.excludePaths,
      wordBoundary: true,
      maxCount: 30,
    });

    for (const m of matches) {
      if (m.file === primary) continue; // skip self
      if (seen.has(m.file)) continue;

      // Only count import-like contexts
      // Patterns: `import ... from`, `require(...)`, `from .basename import`, `include`
      if (
        /\b(?:import|require|from\s+['"]?[\w./]*|include)\b/i.test(m.content) ||
        /['"][\w./]*\b(?:basename)\b['"]?/.test(m.content)
      ) {
        seen.add(m.file);
        blast.push({
          file: m.file,
          reason: `references ${basename}`,
          match_source: "import_grep",
        });
      }
    }
  }

  return blast;
}

// ─── Test File Detection ──────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /_test\.(go|py|rb)$/,
  /^test_.+\.py$/,
  /\/test_.+\.py$/,
  /Test\.java$/,
  /Tests?\.cs$/,
];

function isTestFile(filePath) {
  if (!filePath) return false;
  return TEST_FILE_PATTERNS.some((re) => re.test(filePath));
}

// ─── Main Entry Point ─────────────────────────────────────────

/**
 * Perform mechanical locate for a given request.
 *
 * @param {string} request - Natural-language work description
 * @param {{ cwd?: string, excludePaths?: string[] }} [options]
 * @returns {{
 *   primary: Array<{ file: string, symbol?: string, lines?: string, match_source: string }>,
 *   tests: Array<{ file: string, reason: string, match_source: string }>,
 *   blast_radius: Array<{ file: string, reason: string, match_source: string }>,
 *   confidence: "high" | "medium" | "low",
 *   tier: "mechanical",
 *   warnings: string[],
 *   tokens_extracted: Array<{ token: string, type: string, weight: number, lineHint?: number }>
 * }}
 */
function locate(request, options = {}) {
  const cwd = options.cwd || process.cwd();
  const warnings = [];

  // Step 1: extract candidate tokens
  const tokens = extractRequestTokens(request);
  if (tokens.length === 0) {
    return {
      primary: [],
      tests: [],
      blast_radius: [],
      confidence: "low",
      tier: "mechanical",
      warnings: ["No identifiers extracted from request"],
      tokens_extracted: [],
    };
  }

  // Only warn when no search backend is available at all.
  // git grep is a perfectly fine fallback — users don't need to know which one.
  const backend = searchBackend();
  if (backend === "none") {
    warnings.push(
      "Neither ripgrep nor git is available — locate cannot search code",
    );
  }

  // Step 2a: split tokens by type
  const fileTokens = tokens.filter((t) => t.type === "file_path");
  const symbolTokens = tokens.filter((t) => t.type !== "file_path");

  const primaryMap = new Map(); // file → entry

  // Step 2b: resolve file_path tokens (highest precision)
  for (const t of fileTokens) {
    const matches = findFilesByPathToken(t.token, { cwd });
    for (const file of matches) {
      if (!primaryMap.has(file)) {
        primaryMap.set(file, {
          file,
          lines: t.lineHint ? String(t.lineHint) : undefined,
          match_source: "file_path",
        });
      } else if (t.lineHint && !primaryMap.get(file).lines) {
        primaryMap.get(file).lines = String(t.lineHint);
      }
    }
  }

  // Step 2b.5: kebab-case tokens almost always look like filename stems.
  // Grep alone misses the *defining* file because it doesn't contain its
  // own name in its content (e.g. vela-review-gate.js doesn't grep itself).
  // Try basename substring matching first; track which kebab tokens succeeded
  // so we can skip grep for them (grep would just add noise from references).
  const kebabBasenameSucceeded = new Set();
  const kebabTokens = tokens.filter((t) => t.type === "kebab_case");
  for (const t of kebabTokens) {
    const matches = findFilesByBasenameSubstring(t.token, { cwd });
    if (matches.length > 0) {
      kebabBasenameSucceeded.add(t.token);
    }
    for (const file of matches) {
      if (!primaryMap.has(file)) {
        primaryMap.set(file, {
          file,
          match_source: "filename_substring",
        });
      }
    }
  }

  // Step 2c: resolve symbol tokens via ripgrep
  for (const t of symbolTokens) {
    // Skip grep for kebab tokens that already matched filename — grep would
    // just dilute confidence with reference sites in docs/tests/configs.
    if (t.type === "kebab_case" && kebabBasenameSucceeded.has(t.token)) {
      continue;
    }

    // kebab-case tokens contain hyphens, which are word boundaries in regex.
    // `vela-engine` with -w would never match because - splits the word.
    // Disable word-boundary for kebab-case so we get substring matches.
    const useWordBoundary = t.type !== "kebab_case";

    const matches = rgSearch(t.token, {
      cwd,
      excludePaths: options.excludePaths,
      wordBoundary: useWordBoundary,
    });

    // Group matches by file
    const byFile = new Map();
    for (const m of matches) {
      if (!byFile.has(m.file)) byFile.set(m.file, []);
      byFile.get(m.file).push(m);
    }

    // Skip tokens that match too broadly (likely common words).
    // For kebab_case tokens, try basename substring matching as a fallback —
    // kebab tokens often look like filenames (e.g. "vela-engine" → "vela-engine.js").
    if (byFile.size > 20) {
      if (t.type === "kebab_case") {
        const filenameMatches = findFilesByBasenameSubstring(t.token, { cwd });
        if (filenameMatches.length > 0) {
          for (const file of filenameMatches) {
            if (!primaryMap.has(file)) {
              primaryMap.set(file, {
                file,
                match_source: "filename_substring",
              });
            }
          }
          continue;
        }
      }
      warnings.push(
        `Token "${t.token}" matched ${byFile.size} files — too broad, skipped`,
      );
      continue;
    }

    // Narrowing heuristic: if 5+ files matched, prefer files whose
    // basename actually contains the token. The definition file usually
    // shares its name with the symbol it exports (e.g. vela-review-gate
    // → vela-review-gate.js). Other files just reference it.
    let candidateFiles = Array.from(byFile.entries());
    if (candidateFiles.length >= 5) {
      const lowerToken = t.token.toLowerCase();
      const filenameMatches = candidateFiles.filter(([file]) =>
        path.basename(file).toLowerCase().includes(lowerToken),
      );
      if (filenameMatches.length > 0 && filenameMatches.length < candidateFiles.length) {
        candidateFiles = filenameMatches;
      }
    }

    // Add each surviving candidate file
    for (const [file, fileMatches] of candidateFiles) {
      if (primaryMap.has(file)) {
        const entry = primaryMap.get(file);
        if (!entry.symbol) entry.symbol = t.token;
        if (!entry.lines) {
          const minLine = Math.min(...fileMatches.map((m) => m.line));
          entry.lines = String(minLine);
        }
      } else {
        const minLine = Math.min(...fileMatches.map((m) => m.line));
        primaryMap.set(file, {
          file,
          symbol: t.token,
          lines: String(minLine),
          match_source: "symbol_grep",
        });
      }
    }
  }

  const allPrimary = Array.from(primaryMap.values());

  // Step 3: separate test files from primary
  const tests = [];
  const primaryNonTest = [];
  for (const entry of allPrimary) {
    if (isTestFile(entry.file)) {
      tests.push({
        file: entry.file,
        reason: "test file matched",
        match_source: entry.match_source,
      });
    } else {
      primaryNonTest.push(entry);
    }
  }

  // Step 4: confidence verdict
  let confidence;
  if (primaryNonTest.length === 0) {
    confidence = "low";
    if (tests.length > 0) {
      warnings.push(
        "Only test files matched — primary source file unclear",
      );
    }
  } else if (primaryNonTest.length === 1) {
    confidence = "high";
  } else if (primaryNonTest.length <= 3) {
    // Check if there's a clear file_path match dominating
    const hasFilePathMatch = primaryNonTest.some(
      (p) => p.match_source === "file_path",
    );
    confidence = hasFilePathMatch ? "high" : "medium";
  } else if (primaryNonTest.length <= 10) {
    confidence = "medium";
    warnings.push(
      `${primaryNonTest.length} primary files matched — review for over-broad scope`,
    );
  } else {
    confidence = "low";
    warnings.push(
      `${primaryNonTest.length} primary files matched — too broad, low confidence`,
    );
  }

  // Step 5: blast_radius (only when confidence is high or medium, scope is reasonable)
  let blast_radius = [];
  if (confidence !== "low" && primaryNonTest.length <= 5) {
    blast_radius = computeBlastRadius(
      primaryNonTest.map((p) => p.file),
      { cwd, excludePaths: options.excludePaths },
    );
  }

  return {
    primary: primaryNonTest,
    tests,
    blast_radius,
    confidence,
    tier: "mechanical",
    warnings,
    tokens_extracted: tokens,
  };
}

// ─── Exports ──────────────────────────────────────────────────

module.exports = {
  locate,
  extractRequestTokens,
  rgSearch,
  findFilesByPathToken,
  findFilesByBasenameSubstring,
  computeBlastRadius,
  isRgAvailable,
  isGitGrepAvailable,
  searchBackend,
  isTestFile,
  shellEscape,
  REQUEST_TOKEN_EXTRACTORS,
  NOISE_TOKENS,
  DEFAULT_EXCLUDE_PATHS,
  // Test helpers (not part of public API)
  _resetRgCache,
};
