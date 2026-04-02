/**
 * Vela Change Surface Analysis — Phase 1-2
 *
 * Detects tokens that disappeared from a diff and could break
 * cross-file references (exports, constants, headings, config keys, etc.).
 *
 * Phase 1: parseDiff(baselineSha)   — parse `git diff --unified=0` into structured data
 * Phase 2: extractSurface(diff)     — extract Change Surface tokens from removed/added lines
 * Phase 3-4: (implemented in T02)   — searchImpact + verdict
 *
 * Exports: parseDiff, extractSurface, TOKEN_EXTRACTORS
 *
 * Design decisions:
 * - Never throws — returns { files: {}, error } on git failure
 * - MIN_TOKEN_LENGTH = 3 to avoid false-positive explosion on short tokens
 * - Binary files auto-skipped
 * - file_path tokens generated for D (deleted) and R (renamed) files
 * - likely_replacement estimated when exactly one new token of the same type appears
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");

// ─── Constants ───

const MIN_TOKEN_LENGTH = 3;

// ─── Helpers ───

/**
 * Split a comma-separated name list from export declarations.
 * Handles `name as alias` forms — keeps the original name.
 * @param {string} str - Comma-separated string like "foo, bar as baz"
 * @returns {string[]}
 */
function splitNames(str) {
  return str
    .split(",")
    .map((s) => s.trim().split(/\s+/)[0])
    .filter((s) => s && /^\w+$/.test(s));
}

/**
 * Apply all line-based extractors to a single line of content.
 * Skips file_path (handled separately) and respects fileType filters.
 * @param {string} line - Line content (already stripped of diff +/- prefix)
 * @param {string} filePath - Source file path (for extension filtering)
 * @returns {{ token: string, type: string }[]}
 */
function extractTokensFromLine(line, filePath) {
  const ext = path.extname(filePath);
  const results = [];
  for (const ex of TOKEN_EXTRACTORS) {
    if (ex.name === "file_path") continue;
    if (ex.fileTypes && !ex.fileTypes.includes(ext)) continue;
    for (const token of ex.extract(line)) {
      results.push({ token, type: ex.name });
    }
  }
  return results;
}

// ─── Token Extractors (8 types) ───

/**
 * @type {{ name: string, fileTypes?: string[], extract: (line: string) => string[] }[]}
 */
const TOKEN_EXTRACTORS = [
  // 1. JS/TS export symbols (CJS + ESM)
  {
    name: "js_export",
    extract(line) {
      const tokens = [];
      // CJS: module.exports = { name1, name2 }
      let m = line.match(/module\.exports\s*=\s*\{([^}]+)\}/);
      if (m) tokens.push(...splitNames(m[1]));
      // CJS: exports.name = ...
      m = line.match(/exports\.(\w+)\s*=/);
      if (m) tokens.push(m[1]);
      // ESM: export [default] [async] function|const|let|var|class name
      const esmRe =
        /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
      let em;
      while ((em = esmRe.exec(line))) tokens.push(em[1]);
      // ESM: export { name1, name2 }
      m = line.match(/export\s+\{([^}]+)\}/);
      if (m) tokens.push(...splitNames(m[1]));
      return tokens;
    },
  },

  // 2. Function/class definitions
  {
    name: "function_def",
    extract(line) {
      const tokens = [];
      const fnRe = /(?:async\s+)?function\s+(\w+)\s*\(/g;
      let m;
      while ((m = fnRe.exec(line))) tokens.push(m[1]);
      m = line.match(/\bclass\s+([A-Z]\w*)/);
      if (m) tokens.push(m[1]);
      return tokens;
    },
  },

  // 3. UPPER_SNAKE_CASE constants (conventionally exported)
  {
    name: "constant",
    extract(line) {
      const tokens = [];
      const re = /(?:const|let|var|export)\s+([A-Z][A-Z0-9_]{2,})\s*=/g;
      let m;
      while ((m = re.exec(line))) tokens.push(m[1]);
      return tokens;
    },
  },

  // 4. Config keys (JSON/YAML/TOML/ENV)
  {
    name: "config_key",
    fileTypes: [".json", ".yaml", ".yml", ".toml", ".env"],
    extract(line) {
      const tokens = [];
      // JSON: "key":
      const jsonRe = /"(\w+)"\s*:/g;
      let m;
      while ((m = jsonRe.exec(line))) tokens.push(m[1]);
      // YAML/TOML/ENV top-level: key: or key=
      m = line.match(/^(\w[\w.-]*)\s*[:=]/);
      if (m && !tokens.includes(m[1])) tokens.push(m[1]);
      return tokens;
    },
  },

  // 5. Markdown headings (anchors derived in Phase 3)
  {
    name: "doc_heading",
    fileTypes: [".md", ".mdx"],
    extract(line) {
      const m = line.match(/^#{1,6}\s+(.+)$/);
      if (!m) return [];
      return [m[1].trim()];
    },
  },

  // 6. Tree diagram items (├── / └──)
  {
    name: "tree_item",
    fileTypes: [".md"],
    extract(line) {
      const m = line.match(/[├└]──\s+(.+)/);
      if (!m) return [];
      return [m[1].trim()];
    },
  },

  // 7. File paths — special: not line-based, handled in extractSurface for D/R files
  {
    name: "file_path",
    extract() {
      return [];
    },
  },

  // 8. Markdown link targets (internal only, external URLs skipped)
  {
    name: "markdown_link",
    fileTypes: [".md", ".mdx"],
    extract(line) {
      const tokens = [];
      const re = /\[([^\]]*)\]\(([^)]+)\)/g;
      let m;
      while ((m = re.exec(line))) {
        const target = m[2].trim();
        if (target.startsWith("http://") || target.startsWith("https://")) {
          continue;
        }
        tokens.push(target);
      }
      return tokens;
    },
  },
];

// ─── Phase 1: Diff Parse ───

/**
 * Run `git diff` against a baseline SHA and parse the output.
 * @param {string} baselineSha - Git ref to diff against (e.g. HEAD~1, a commit SHA)
 * @param {{ cwd?: string }} [options]
 * @returns {{ files: Object.<string, { status: string, old_path: string|null, removed_lines: { line: number, content: string }[], added_lines: { line: number, content: string }[] }>, error?: string }}
 */
function parseDiff(baselineSha, options = {}) {
  const cwd = options.cwd || process.cwd();

  let rawDiff;
  try {
    rawDiff = execSync(`git diff ${baselineSha} --unified=0 --no-color`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    if (err.stdout !== undefined && err.stdout !== "") {
      rawDiff = err.stdout;
    } else {
      return {
        files: {},
        error: `git diff failed: ${err.message}`,
      };
    }
  }

  if (!rawDiff || !rawDiff.trim()) {
    return { files: {} };
  }

  return parseDiffOutput(rawDiff);
}

/**
 * Parse raw unified diff output into structured file entries.
 * Internal — called by parseDiff.
 * @param {string} raw - Raw `git diff --unified=0` output
 * @returns {{ files: Object }}
 */
function parseDiffOutput(raw) {
  const files = {};
  const lines = raw.split("\n");

  let currentFile = null;
  let isBinary = false;
  let oldLineNum = 0;
  let newLineNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── New file diff header ──
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        currentFile = m[2]; // b-side path (new path for renames)
        isBinary = false;
        files[currentFile] = {
          status: "M",
          old_path: m[1] !== m[2] ? m[1] : null,
          removed_lines: [],
          added_lines: [],
        };
      }
      continue;
    }

    if (!currentFile) continue;

    // ── Status headers ──
    if (line.startsWith("new file mode")) {
      files[currentFile].status = "A";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      files[currentFile].status = "D";
      continue;
    }
    if (line.startsWith("rename from ")) {
      files[currentFile].status = "R";
      files[currentFile].old_path = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) continue;
    if (line.startsWith("similarity index") || line.startsWith("dissimilarity index")) {
      continue;
    }
    if (/^Binary files/.test(line)) {
      isBinary = true;
      files[currentFile].binary = true;
      continue;
    }
    if (line.startsWith("index ")) continue;
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) continue;
    if (isBinary) continue;

    // ── Hunk header ──
    const hunkMatch = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
    );
    if (hunkMatch) {
      oldLineNum = parseInt(hunkMatch[1], 10);
      newLineNum = parseInt(hunkMatch[3], 10);
      continue;
    }

    // ── Content lines ──
    if (line.startsWith("-")) {
      files[currentFile].removed_lines.push({
        line: oldLineNum,
        content: line.slice(1),
      });
      oldLineNum++;
      continue;
    }
    if (line.startsWith("+")) {
      files[currentFile].added_lines.push({
        line: newLineNum,
        content: line.slice(1),
      });
      newLineNum++;
      continue;
    }

    // Context line (shouldn't exist with --unified=0, but handle gracefully)
    if (line.startsWith(" ")) {
      oldLineNum++;
      newLineNum++;
    }
  }

  // Remove binary files from results
  for (const fp of Object.keys(files)) {
    if (files[fp].binary) delete files[fp];
  }

  return { files };
}

// ─── Phase 2: Surface Extract ───

/**
 * Extract Change Surface tokens from a parsed diff result.
 *
 * Surface = tokens removed from the diff that were NOT also added back.
 * These are the tokens that might break cross-file references.
 *
 * @param {{ files: Object }} diffResult - Output of parseDiff()
 * @returns {{ surface: { token: string, type: string, source_file: string, removed_at_line: number|null, likely_replacement: string|null }[] }}
 */
function extractSurface(diffResult) {
  const surface = [];

  if (!diffResult || !diffResult.files) return { surface };

  for (const [filePath, fileData] of Object.entries(diffResult.files)) {
    // ── 2a: Deleted file → file path tokens ──
    if (fileData.status === "D") {
      addFilePathTokens(surface, filePath, null);
    }

    // ── 2b: Renamed file → old path tokens with replacement ──
    if (fileData.status === "R" && fileData.old_path) {
      addFilePathTokens(surface, fileData.old_path, filePath);
    }

    // ── 2c: Extract tokens from removed lines ──
    const removedTokenMap = new Map(); // token → { type, line }
    for (const rl of fileData.removed_lines) {
      for (const { token, type } of extractTokensFromLine(rl.content, filePath)) {
        if (!removedTokenMap.has(token)) {
          removedTokenMap.set(token, { type, line: rl.line });
        }
      }
    }

    // ── 2d: Extract tokens from added lines ──
    const addedTokenSet = new Set();
    const addedTokensByType = new Map(); // type → [{ token, line }]
    for (const al of fileData.added_lines) {
      for (const { token, type } of extractTokensFromLine(al.content, filePath)) {
        addedTokenSet.add(token);
        if (!addedTokensByType.has(type)) addedTokensByType.set(type, []);
        const list = addedTokensByType.get(type);
        if (!list.some((t) => t.token === token)) {
          list.push({ token, line: al.line });
        }
      }
    }

    // ── 2e: Surface = removed NOT in added, min length filter ──
    for (const [token, info] of removedTokenMap) {
      if (addedTokenSet.has(token)) continue; // name unchanged
      if (token.length < MIN_TOKEN_LENGTH) continue; // too short

      // Estimate likely_replacement: if exactly 1 added-only token of same type
      const addedOnly = (addedTokensByType.get(info.type) || []).filter(
        (t) => !removedTokenMap.has(t.token)
      );
      const likely_replacement =
        addedOnly.length === 1 ? addedOnly[0].token : null;

      surface.push({
        token,
        type: info.type,
        source_file: filePath,
        removed_at_line: info.line,
        likely_replacement,
      });
    }
  }

  return { surface };
}

/**
 * Add file path tokens (full path, basename, stem) to the surface.
 * Used for deleted (D) and renamed (R) files.
 * @param {Array} surface - Surface array to push to
 * @param {string} oldPath - The path being removed
 * @param {string|null} newPath - Replacement path (for renames), or null (for deletes)
 */
function addFilePathTokens(surface, oldPath, newPath) {
  const ext = path.extname(oldPath);
  const basename = path.basename(oldPath);
  const stem = path.basename(oldPath, ext);

  // Full path token
  surface.push({
    token: oldPath,
    type: "file_path",
    source_file: oldPath,
    removed_at_line: null,
    likely_replacement: newPath,
  });

  // Basename token (if different from full path)
  if (basename !== oldPath) {
    const newBasename = newPath ? path.basename(newPath) : null;
    surface.push({
      token: basename,
      type: "file_path",
      source_file: oldPath,
      removed_at_line: null,
      likely_replacement:
        newBasename && newBasename !== basename ? newBasename : null,
    });
  }

  // Stem token (without extension, if different from basename and long enough)
  if (stem !== basename && stem.length >= MIN_TOKEN_LENGTH) {
    const newExt = newPath ? path.extname(newPath) : null;
    const newStem = newPath ? path.basename(newPath, newExt) : null;
    surface.push({
      token: stem,
      type: "file_path",
      source_file: oldPath,
      removed_at_line: null,
      likely_replacement: newStem && newStem !== stem ? newStem : null,
    });
  }
}

// ─── CLI Entry Point ───

function main() {
  const sha = process.argv[2];
  if (!sha) {
    console.error("Usage: node change-surface.js <baseline-sha>");
    console.error("  Example: node change-surface.js HEAD~1");
    process.exit(1);
  }

  const diff = parseDiff(sha);
  if (diff.error) {
    console.error(`Error: ${diff.error}`);
    process.exit(1);
  }

  const { surface } = extractSurface(diff);

  if (surface.length === 0) {
    console.log("✅ No Change Surface tokens detected (no cross-file impact).");
  } else {
    console.log(`🔍 Change Surface: ${surface.length} token(s) detected\n`);
    for (const entry of surface) {
      const loc = entry.removed_at_line
        ? `${entry.source_file}:${entry.removed_at_line}`
        : entry.source_file;
      const repl = entry.likely_replacement
        ? ` → ${entry.likely_replacement}`
        : "";
      console.log(`  [${entry.type}] ${entry.token}  (${loc}${repl})`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseDiff, extractSurface, TOKEN_EXTRACTORS };
