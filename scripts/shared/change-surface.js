/**
 * Vela Change Surface Analysis
 *
 * Detects tokens that disappeared from a diff and could break
 * cross-file references (exports, constants, headings, config keys, etc.).
 *
 * Phase 1: parseDiff(baselineSha)              — parse `git diff --unified=0` into structured data
 * Phase 2: extractSurface(diff)                — extract Change Surface tokens from removed/added lines
 * Phase 3: searchImpact(surface, changed, opt) — ripgrep search for token refs outside diff
 * Phase 4: verdict(impactResult)               — pass/fail with formatted report
 *        + analyze(baselineSha, opt)            — all 4 phases in one call
 *
 * Exports: parseDiff, extractSurface, searchImpact, verdict, analyze, TOKEN_EXTRACTORS
 *
 * Design decisions:
 * - Never throws — returns { files: {}, error } on git failure
 * - MIN_TOKEN_LENGTH = 3 to avoid false-positive explosion on short tokens
 * - Binary files auto-skipped
 * - file_path tokens generated for D (deleted) and R (renamed) files
 * - likely_replacement estimated when exactly one new token of the same type appears
 * - rg unavailable → graceful skip with warning, verdict = pass
 * - Word boundary filter prevents partial matches (e.g. READ ≠ READONLY)
 * - References inside comments/code blocks get severity "warn" (don't fail the check)
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");

// ─── Constants ───

const MIN_TOKEN_LENGTH = 3;

/** Default glob patterns to exclude from impact search */
const DEFAULT_EXCLUDE_PATHS = [
  "node_modules",
  ".git",
  ".gsd",
  ".vela/artifacts",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

/** Patterns indicating a line is a comment or inside a code block (severity → warn) */
const COMMENT_PATTERNS = [
  /^\s*\/\//, // JS single-line comment
  /^\s*#/,    // Shell/YAML/Python comment
  /^\s*\*/,   // JSDoc / block comment continuation
  /^\s*<!--/, // HTML comment
  /```/,      // Markdown code fence
];

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

  // 9. Universal identifier extractor (language-agnostic)
  //    Extracts all identifier-shaped words (3+ chars) from any file.
  //    No fileTypes filter — works on every programming language.
  //    Language keywords are excluded to reduce false positives.
  {
    name: "identifier",
    extract(line) {
      const identRe = /\b([a-zA-Z_]\w{2,})\b/g;
      const tokens = [];
      let m;
      while ((m = identRe.exec(line))) tokens.push(m[1]);

      const KEYWORDS = new Set([
        // Control flow
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
        'return', 'throw', 'try', 'catch', 'finally', 'new', 'this', 'super',
        'import', 'from', 'export', 'default', 'null', 'undefined', 'true', 'false',
        'void', 'typeof', 'instanceof', 'delete', 'yield', 'await', 'async',
        // OOP
        'class', 'interface', 'extends', 'implements', 'abstract', 'final',
        'public', 'private', 'protected', 'static', 'const', 'let', 'var', 'val',
        'function', 'def', 'func', 'fun', 'override', 'virtual', 'extern',
        // Types & structures
        'struct', 'enum', 'union', 'type', 'namespace', 'package', 'module',
        'string', 'number', 'boolean', 'int', 'float', 'double', 'long', 'short',
        'byte', 'char', 'bool', 'void', 'object', 'any', 'never',
        // Python / Ruby / misc
        'with', 'pass', 'raise', 'except', 'lambda', 'self', 'cls', 'None',
        'elif', 'not', 'and', 'println', 'print', 'require', 'include',
        'begin', 'end', 'then', 'elsif', 'unless', 'when', 'use', 'where',
      ]);
      return tokens.filter(t => !KEYWORDS.has(t));
    },
  },

  // 10. Java/Kotlin getter/setter → property name extraction
  {
    name: "getter_setter",
    fileTypes: [".java", ".kt", ".scala"],
    extract(line) {
      const tokens = [];
      const gsRe = /(?:get|set|is)([A-Z]\w{2,})\s*\(/g;
      let m;
      while ((m = gsRe.exec(line))) {
        const prop = m[1];
        // PascalCase → camelCase (UserName → userName)
        tokens.push(prop.charAt(0).toLowerCase() + prop.slice(1));
        // PascalCase → snake_case (UserName → user_name)
        tokens.push(prop.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''));
      }
      return tokens;
    },
  },

  // 11. Template expression variable extraction
  //     JSP EL, Thymeleaf, Jinja2, Django, ERB, Blade, etc.
  {
    name: "template_expr",
    fileTypes: [".jsp", ".jspx", ".html", ".htm", ".ftl", ".vm", ".erb",
                ".blade.php", ".twig", ".j2", ".jinja2", ".mustache", ".hbs",
                ".ejs", ".pug", ".jade", ".vue", ".svelte"],
    extract(line) {
      const tokens = [];
      let m;
      // JSP EL: ${obj.property} / Thymeleaf: #{msg.key}
      const elRe = /[\$#]\{([^}]+)\}/g;
      while ((m = elRe.exec(line))) {
        const parts = m[1].split(/[.\[\]]+/).filter(p => p && /^\w+$/.test(p));
        for (const p of parts) {
          if (p.length >= 3) tokens.push(p);
        }
      }
      // Jinja2/Django: {{ obj.property }} / {% if obj.property %}
      const jinjaRe = /\{\{([^}]+)\}\}|\{%([^%]+)%\}/g;
      while ((m = jinjaRe.exec(line))) {
        const expr = m[1] || m[2];
        const parts = expr.split(/[.\[\]\s|:,()]+/).filter(p => p && /^\w{3,}$/.test(p));
        for (const p of parts) tokens.push(p);
      }
      // ERB: <%= obj.property %>
      const erbRe = /<%=?\s*([^%]+)%>/g;
      while ((m = erbRe.exec(line))) {
        const parts = m[1].split(/[.\[\]\s|:,()]+/).filter(p => p && /^\w{3,}$/.test(p));
        for (const p of parts) tokens.push(p);
      }
      return tokens;
    },
  },

  // 12. XML attribute/property extraction
  //     MyBatis mapper, Spring XML, pom.xml, etc.
  {
    name: "xml_attr",
    fileTypes: [".xml", ".xsl", ".xslt", ".xsd", ".wsdl", ".pom"],
    extract(line) {
      const tokens = [];
      const attrRe = /(?:property|column|name|field|ref|bean|id|parameterType|resultType|type)\s*=\s*"([^"]+)"/gi;
      let m;
      while ((m = attrRe.exec(line))) {
        const val = m[1];
        // For package names (com.example.MyClass), keep only the last segment
        if (val.includes('.')) {
          const last = val.split('.').pop();
          if (last && last.length >= 3) tokens.push(last);
        } else if (val.length >= 3) {
          tokens.push(val);
        }
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

// ─── Phase 3: Impact Search ───

/**
 * Check whether ripgrep (rg) is available on the system.
 * @returns {boolean}
 */
function isRgAvailable() {
  try {
    execSync("rg --version", { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine whether a matching line is likely a comment or code block.
 * @param {string} lineContent
 * @returns {boolean}
 */
function isCommentOrCodeBlock(lineContent) {
  return COMMENT_PATTERNS.some((pat) => pat.test(lineContent));
}

/**
 * Check word boundary — ensure the token appears as a whole word, not as a
 * substring of a larger identifier (e.g. "READ" inside "READONLY").
 * @param {string} lineContent - Full line text
 * @param {string} token - Token to check
 * @returns {boolean} true if the token matches as a whole word
 */
function isWholeWordMatch(lineContent, token) {
  // For file paths and markdown links, exact substring is sufficient
  if (token.includes("/") || token.includes(".")) return true;
  // For identifiers, check word boundaries
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`);
  return re.test(lineContent);
}

/**
 * Search for references to Change Surface tokens outside the changed files.
 *
 * @param {{ surface: Array }} surfaceResult - Output of extractSurface()
 * @param {string[]} changedFiles - Files from the diff (excluded from search)
 * @param {{ cwd?: string, excludePaths?: string[] }} [options]
 * @returns {{ impacts: { token: string, type: string, source_file: string, likely_replacement: string|null, refs: { file: string, line: number, content: string, severity: string, in_diff: boolean }[] }[], rg_available: boolean, warning?: string }}
 */
function searchImpact(surfaceResult, changedFiles, options = {}) {
  const cwd = options.cwd || process.cwd();
  const excludePaths = options.excludePaths || DEFAULT_EXCLUDE_PATHS;

  // Check rg availability
  if (!isRgAvailable()) {
    return {
      impacts: [],
      rg_available: false,
      warning: "ripgrep (rg) not found — impact search skipped. Install rg for full analysis.",
    };
  }

  const { surface } = surfaceResult;
  if (!surface || surface.length === 0) {
    return { impacts: [], rg_available: true };
  }

  const changedSet = new Set(changedFiles);
  const impacts = [];

  // Build exclude args once
  const excludeArgs = excludePaths
    .map((p) => `--glob '!${p}'`)
    .join(" ");

  for (const entry of surface) {
    const { token, type, source_file, likely_replacement } = entry;

    // Skip empty or whitespace-only tokens
    if (!token || !token.trim()) continue;

    // Run rg with fixed-string search
    // Note: --glob args must come BEFORE -- (end-of-options separator)
    // Explicit '.' path forces filesystem search — without it, rg may
    // detect a pipe on stdin (from execSync) and read stdin instead.
    let rgOutput;
    try {
      rgOutput = execSync(
        `rg --fixed-strings --line-number --no-heading ${excludeArgs} -- ${shellEscape(token)} .`,
        { cwd, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (err) {
      // rg exits 1 when no matches found — that's fine
      if (err.status === 1) continue;
      // rg exits 2 on error — skip this token
      continue;
    }

    if (!rgOutput || !rgOutput.trim()) continue;

    const refs = [];
    const lines = rgOutput.trim().split("\n");

    for (const rgLine of lines) {
      // rg format: file:line:content
      const colonIdx1 = rgLine.indexOf(":");
      if (colonIdx1 === -1) continue;
      const colonIdx2 = rgLine.indexOf(":", colonIdx1 + 1);
      if (colonIdx2 === -1) continue;

      const file = rgLine.slice(0, colonIdx1);
      const lineNum = parseInt(rgLine.slice(colonIdx1 + 1, colonIdx2), 10);
      const content = rgLine.slice(colonIdx2 + 1);

      // Skip matches in changed files (those are already in the diff)
      const inDiff = changedSet.has(file);

      // Apply word boundary filter
      if (!isWholeWordMatch(content, token)) continue;

      // Determine severity
      const severity = isCommentOrCodeBlock(content) ? "warn" : "error";

      refs.push({ file, line: lineNum, content: content.trim(), severity, in_diff: inDiff });
    }

    if (refs.length > 0) {
      impacts.push({
        token,
        type,
        source_file,
        likely_replacement,
        refs,
      });
    }
  }

  return { impacts, rg_available: true };
}

/**
 * Escape a string for safe shell argument usage.
 * @param {string} str
 * @returns {string}
 */
function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ─── Phase 4: Verdict ───

/**
 * Determine pass/fail based on impact search results.
 *
 * FAIL when any impact ref has severity=error AND in_diff=false.
 * Severity=warn refs (comments/code blocks) don't fail.
 *
 * @param {{ impacts: Array, rg_available: boolean, warning?: string }} impactResult
 * @returns {{ pass: boolean, errorCount: number, warnCount: number, report: string }}
 */
function verdict(impactResult) {
  // If rg was not available, pass with warning
  if (!impactResult.rg_available) {
    return {
      pass: true,
      errorCount: 0,
      warnCount: 0,
      report: `⚠️  ${impactResult.warning || "Impact search skipped."}`,
    };
  }

  const { impacts } = impactResult;

  let errorCount = 0;
  let warnCount = 0;
  const reportLines = [];

  for (const impact of impacts) {
    const externalErrors = impact.refs.filter((r) => r.severity === "error" && !r.in_diff);
    const externalWarns = impact.refs.filter((r) => r.severity === "warn" && !r.in_diff);

    errorCount += externalErrors.length;
    warnCount += externalWarns.length;

    if (externalErrors.length > 0 || externalWarns.length > 0) {
      const repl = impact.likely_replacement
        ? ` (likely replacement: ${impact.likely_replacement})`
        : "";
      reportLines.push(`\n  [${impact.type}] ${impact.token}${repl}`);
      reportLines.push(`    Source: ${impact.source_file}`);

      for (const ref of externalErrors) {
        reportLines.push(`    ❌ ${ref.file}:${ref.line}  ${ref.content}`);
      }
      for (const ref of externalWarns) {
        reportLines.push(`    ⚠️  ${ref.file}:${ref.line}  ${ref.content}  (comment/code block)`);
      }
    }
  }

  const pass = errorCount === 0;

  let report;
  if (pass && warnCount === 0) {
    report = "✅ No broken cross-file references detected.";
  } else if (pass && warnCount > 0) {
    report =
      `✅ Pass (${warnCount} warning(s) in comments/code blocks)\n` +
      reportLines.join("\n");
  } else {
    report =
      `❌ FAIL: ${errorCount} broken reference(s) found` +
      (warnCount > 0 ? `, ${warnCount} warning(s)` : "") +
      "\n" +
      reportLines.join("\n");
  }

  return { pass, errorCount, warnCount, report };
}

// ─── Convenience: Full Analysis ───

/**
 * Run all 4 phases in sequence: diff → surface → impact → verdict.
 *
 * @param {string} baselineSha - Git ref to diff against
 * @param {{ cwd?: string, excludePaths?: string[] }} [options]
 * @returns {{ diff: Object, surface: Object, impact: Object, verdict: Object }}
 */
function analyze(baselineSha, options = {}) {
  // Phase 1: Parse diff
  const diff = parseDiff(baselineSha, options);
  if (diff.error) {
    return {
      diff,
      surface: { surface: [] },
      impact: { impacts: [], rg_available: false, warning: diff.error },
      verdict: { pass: false, errorCount: 0, warnCount: 0, report: `Error: ${diff.error}` },
    };
  }

  // Phase 2: Extract surface
  const surfaceResult = extractSurface(diff);

  // Phase 3: Search impact
  const changedFiles = Object.keys(diff.files);
  const impactResult = searchImpact(surfaceResult, changedFiles, options);

  // Phase 4: Verdict
  const verdictResult = verdict(impactResult);

  return {
    diff,
    surface: surfaceResult,
    impact: impactResult,
    verdict: verdictResult,
  };
}

// ─── CLI Entry Point ───

function main() {
  const sha = process.argv[2];
  if (!sha) {
    console.error("Usage: node change-surface.js <baseline-sha>");
    console.error("  Example: node change-surface.js HEAD~1");
    process.exit(1);
  }

  const result = analyze(sha);

  // Print report
  console.log(result.verdict.report);

  // Print surface details when tokens exist
  if (result.surface.surface.length > 0 && result.verdict.pass) {
    console.log(`\n🔍 Change Surface: ${result.surface.surface.length} token(s) scanned, all references intact.`);
  }

  // Exit code: 0 = pass, 1 = fail
  process.exit(result.verdict.pass ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { parseDiff, extractSurface, searchImpact, verdict, analyze, TOKEN_EXTRACTORS };
