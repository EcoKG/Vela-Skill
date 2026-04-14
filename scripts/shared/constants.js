/**
 * Vela Shared Constants
 * Single source of truth for gate-keeper, gate-guard, orchestrator, and tracker hooks.
 */

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyw",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".tf",
  ".hcl",
  ".dockerfile",
  ".containerfile",
]);

const SKIP_PATHS = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  "vendor/",
  "__pycache__/",
  ".venv/",
  "venv/",
  ".cache/",
  "coverage/",
  ".vela/cache/",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
];

const SENSITIVE_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
];

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

const SECRET_PATTERNS = [
  /(?:AKIA|ASIA)[A-Z0-9]{16}/, // AWS access key
  /ghp_[A-Za-z0-9_]{36}/, // GitHub PAT
  /gho_[A-Za-z0-9_]{36}/, // GitHub OAuth
  /sk-[A-Za-z0-9]{48}/, // OpenAI key
  /sk-ant-[A-Za-z0-9-]{90,}/, // Anthropic key
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /sk_live_[A-Za-z0-9]{24,}/, // Stripe live key
  /rk_live_[A-Za-z0-9]{24,}/, // Stripe restricted key
  /mongodb\+srv:\/\/[^:]+:[^@]+@/, // MongoDB connection
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@/, // PostgreSQL connection
  /mysql:\/\/[^:]+:[^@]+@/, // MySQL connection
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, // Private key
  /xox[bpsar]-[A-Za-z0-9-]{10,}/, // Slack token
  /AIza[A-Za-z0-9_-]{35}/, // Google API key
  /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/, // SendGrid key
];

// Bash commands that are safe in read-only mode
// Includes: basic read utilities, version checks, git read-only, and standard build/test/lint runners
const SAFE_BASH_READ =
  /^\s*(ls|cat|head|tail|find|grep|rg|wc|file|stat|tree|pwd|echo|which|node\s+.*--version|node\s+.*\.vela\/cli\/vela-[a-z-]+\.js|python3?\s+--version|git\s+(status|log|diff|branch|show|blame|remote|ls-files|ls-tree|rev-parse|describe|tag|config\s+--get)|(npm|yarn|pnpm)\s+(run\s+)?(test|build|lint|check|typecheck)|npx\s+(jest|vitest|eslint|prettier|tsc)|cargo\s+(test|build|check|clippy|fmt)|go\s+(test|build|vet)|pytest|python3?\s+-m\s+(pytest|unittest)|tsc|make|dotnet\s+(test|build))\b/;

// Bash commands that write files
const BASH_WRITE_PATTERNS = [
  /(?<!\d)>\s*\S/, // redirect to file (but not 2>&1 stderr merge)
  /\|\s*tee\s/, // pipe to tee
  /\bcp\s/, // copy
  /\bmv\s/, // move
  /\brm\s/, // remove
  /\bmkdir\s/, // create dir
  /\btouch\s/, // create file
  /\bsed\s+-i/, // sed in-place
  /\bchmod\s/, // change permissions
  /\bchown\s/, // change ownership
  /\bgit\s+(add|commit|push|merge|rebase|reset|checkout|stash)/,
  /\bnpm\s+(install|uninstall|update|publish)/,
  /\byarn\s+(add|remove|install)/,
  /\bpip\s+(install|uninstall)/,
];

const MODEL_VERSIONS = {
  HAIKU: "haiku",
  SONNET: "sonnet",
  OPUS: "opus",
};

// ─── Gate block codes (structured stderr + recovery hint) ─────
//
// When a hook blocks a tool call with `exit 2`, we additionally
// write one human-readable line to stderr so Claude Code sees
// the block code and recovery path rather than a silent denial.
//
// Entries here MUST stay in sync with
// `scripts/agents/pm/block-recovery.md` — that file is the PM
// agent's recovery playbook; this table is the runtime half.
//
// summary: short Korean sentence describing the violation.
// recovery: "→ …" one-liner pointing at the correct next move.
//
// HARD_BLOCK_CODES are intentionally omitted from the educational
// stderr path because surfacing the exact reason would leak info
// useful to an attacker (secret patterns, config-tamper paths).
// Those remain silent `exit 2` — defense-in-depth.
const BLOCK_CODES = {
  "VK-01": {
    summary: "읽기 모드에서 쓰기 Bash 차단",
    recovery:
      "→ Read/Glob/Grep으로 대체하거나 transition → 쓰기 가능 단계로 전이",
  },
  "VK-02": {
    summary: "write 모드에서 Bash 차단 — Vela CLI만 허용",
    recovery: "→ Write/Edit 도구 사용, 또는 transition → readwrite 단계",
  },
  "VK-04": {
    summary: "읽기 모드에서 Write/Edit/NotebookEdit 차단",
    recovery: "→ vela-engine transition 으로 쓰기 가능 단계로 이동",
  },
  "VK-08": {
    summary: "Bash 체인 연산자 (&&, ||, ;, |) 차단",
    recovery: "→ 단일 명령으로 분리하여 별도 Bash 호출로 순차 실행",
  },
  "VK-10": {
    summary: "write 모드에서 WebFetch/WebSearch 차단",
    recovery: "→ research 단계에서 조회하거나, vela-researcher 재호출",
  },
  "M11": {
    summary: "researcher targets.json scope 밖 Read 차단",
    recovery:
      "→ primary/blast_radius/tests 내 파일만 Read. 범위 확장 필요 시 locate 재실행",
  },
  "VG-03": {
    summary: "corrupt .vela/tracker-signals.json → git commit 차단",
    recovery:
      "→ .vela/tracker-signals.json 삭제 또는 유효한 JSON으로 복구 후 재시도",
  },
  "VG-15": {
    summary: "연속 실패 ≥5 — circuit breaker OPEN",
    recovery:
      "→ .vela/state/circuit-open.json 삭제 후 실패 원인 확인. AskUserQuestion으로 사용자 보고",
  },
};

const HARD_BLOCK_CODES = new Set([
  "VG-13", // pipeline.json tamper
  "VG-14", // secret in Write content
  "CORRUPT_INPUT", // malformed hook stdin
]);

/**
 * Format a one-line stderr message for a block code.
 * Returns empty string for HARD_BLOCK_CODES (silent hard-block).
 */
function formatBlockStderr(code, extra) {
  if (HARD_BLOCK_CODES.has(code)) return "";
  const entry = BLOCK_CODES[code];
  if (!entry) return `[${code}] blocked`;
  const tail = extra ? ` (${extra})` : "";
  return `[${code}] ${entry.summary}${tail}. ${entry.recovery}`;
}

/**
 * Append a single JSON line to .vela/state/gate-events.jsonl.
 * Silent on any failure — a telemetry write must never break a hook.
 *
 * event fields:
 *   ts       — ISO8601
 *   code     — VK-XX / VG-XX / M11 / CORRUPT_INPUT
 *   tool     — tool_name (Bash, Write, …)
 *   step     — pipeline current_step if available
 *   mode     — pipeline step mode (read/write/readwrite)
 *   decision — "deny" | "ask" | "warn"
 *   summary  — optional short note (e.g. cmd excerpt)
 */
function writeGateEvent(cwd, event) {
  try {
    const fs = require("fs");
    const path = require("path");
    const stateDir = path.join(cwd, ".vela", "state");
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    });
    fs.appendFileSync(path.join(stateDir, "gate-events.jsonl"), line + "\n");
  } catch {
    // Silent — telemetry failures must never break a hook.
  }
}

module.exports = {
  MODEL_VERSIONS,
  CODE_EXTENSIONS,
  SKIP_PATHS,
  SENSITIVE_FILES,
  WRITE_TOOLS,
  READ_TOOLS,
  SECRET_PATTERNS,
  SAFE_BASH_READ,
  BASH_WRITE_PATTERNS,
  BLOCK_CODES,
  HARD_BLOCK_CODES,
  formatBlockStderr,
  writeGateEvent,
};
