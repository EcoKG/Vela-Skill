/**
 * Vela Guards — Tool Call Gate Enforcement
 *
 * TypeScript port of:
 *   - scripts/shared/constants.js   (guard patterns)
 *   - scripts/hooks/vela-gate-keeper.js  (VK-01 through VK-08 rules)
 *
 * All logic runs synchronously inside the Pi SDK tool_call event handler,
 * replacing the old Claude Code Hook subprocess with a deterministic function.
 */

import type { PipelineMode } from "./pipeline.js";

// ─── Guard Patterns (ported from constants.js) ────────────────────────────────

/** Bash commands safe in read-only mode */
export const SAFE_BASH_READ =
  /^\s*(ls|cat|head|tail|find|grep|rg|wc|file|stat|tree|pwd|echo|which|node\s+.*--version|python3?\s+--version|git\s+(status|log|diff|branch|show|blame|remote|ls-files|ls-tree|rev-parse|describe|tag|config\s+--get)|(npm|yarn|pnpm)\s+(run\s+)?(test|build|lint|check|typecheck)|npx\s+(jest|vitest|eslint|prettier|tsc)|cargo\s+(test|build|check|clippy|fmt)|go\s+(test|build|vet)|pytest|python3?\s+-m\s+(pytest|unittest)|tsc|make|dotnet\s+(test|build))\b/;

/** Bash patterns that write to the filesystem */
export const BASH_WRITE_PATTERNS: RegExp[] = [
  /(?<!\d)>\s*\S/, // redirect to file (not 2>&1)
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

/** Chain operators that allow bash injection even in safe commands */
export const CHAIN_OPERATOR_RE = /&&|\|\||;|\|/;

/** Secret patterns — block writes containing these (VK-06) */
export const SECRET_PATTERNS: RegExp[] = [
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

/** Sensitive files that should never be written (VK-05) */
export const SENSITIVE_FILES: string[] = [
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

/** Tools that write files */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

// ─── Guard Result ─────────────────────────────────────────────────────────────

export interface GuardResult {
  blocked: boolean;
  reason?: string;
  code?: string;
}

// ─── Main Guard Function ──────────────────────────────────────────────────────

/**
 * Evaluate all applicable gate rules for a tool call.
 *
 * Returns { blocked: false } to allow, or { blocked: true, reason, code } to deny.
 * Implements VK-01 through VK-08 from gates-and-guards.md.
 */
export function checkToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  mode: PipelineMode
): GuardResult {
  // ── VK-01 / VK-02: Bash enforcement ──────────────────────────────────────
  if (toolName === "Bash") {
    const cmd =
      typeof toolInput.command === "string" ? toolInput.command : "";

    // VK-08: Chain operators block safe-read commands from becoming write commands
    if (CHAIN_OPERATOR_RE.test(cmd)) {
      return {
        blocked: true,
        reason: `[Vela VK-08] Bash chain operator (&&, ||, ;, |) blocked. Run commands separately.`,
        code: "VK-08",
      };
    }

    if (mode === "read" || mode === "rw-artifact") {
      // Allow safe read-only commands
      if (SAFE_BASH_READ.test(cmd)) return { blocked: false };

      // Block any write pattern
      for (const pattern of BASH_WRITE_PATTERNS) {
        if (pattern.test(cmd)) {
          return {
            blocked: true,
            reason: `[Vela VK-01] Bash write command blocked in ${mode} mode: ${cmd.slice(0, 80)}`,
            code: "VK-01",
          };
        }
      }

      // Not in safe-read list and not an explicit write — deny conservatively
      return {
        blocked: true,
        reason: `[Vela VK-02] Bash command not in safe-read allowlist (mode: ${mode}). Use Read/Glob/Grep instead.`,
        code: "VK-02",
      };
    }

    if (mode === "write") {
      // Write mode: Bash is blocked entirely (use Write/Edit tools instead)
      return {
        blocked: true,
        reason: `[Vela VK-01] Bash is blocked in write mode. Use Write/Edit tools.`,
        code: "VK-01",
      };
    }

    // readwrite: Bash allowed (with restrictions applied by the agent's own judgement)
    return { blocked: false };
  }

  // ── VK-03 / VK-04: Write/Edit tools in read mode ────────────────────────
  if (WRITE_TOOLS.has(toolName)) {
    if (mode === "read") {
      return {
        blocked: true,
        reason: `[Vela VK-03] ${toolName} blocked in read mode.`,
        code: "VK-03",
      };
    }

    if (mode === "rw-artifact") {
      // Only allow writes to the artifact directory (VK-04 equivalent)
      const filePath =
        typeof toolInput.file_path === "string"
          ? toolInput.file_path
          : typeof toolInput.path === "string"
            ? toolInput.path
            : "";

      if (filePath && !filePath.includes("/.vela/artifacts/")) {
        return {
          blocked: true,
          reason: `[Vela VK-04] ${toolName} in rw-artifact mode may only write inside .vela/artifacts/. Path: ${filePath}`,
          code: "VK-04",
        };
      }
    }

    // ── VK-05: Sensitive file protection ──────────────────────────────────
    const filePath =
      typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : typeof toolInput.path === "string"
          ? toolInput.path
          : "";

    if (filePath) {
      const basename = filePath.split("/").pop() ?? "";
      if (SENSITIVE_FILES.some((sf) => basename === sf || filePath.endsWith("/" + sf))) {
        return {
          blocked: true,
          reason: `[Vela VK-05] Write to sensitive file blocked: ${filePath}`,
          code: "VK-05",
        };
      }
    }

    // ── VK-06: Secret detection ────────────────────────────────────────────
    const content =
      typeof toolInput.content === "string"
        ? toolInput.content
        : typeof toolInput.new_string === "string"
          ? toolInput.new_string
          : "";

    if (content) {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) {
          return {
            blocked: true,
            reason: `[Vela VK-06] Potential secret detected in ${toolName} content. Blocked.`,
            code: "VK-06",
          };
        }
      }
    }
  }

  // ── VK-07: PM mode — Read/Glob/Grep only ──────────────────────────────────
  // Note: PM mode is enforced separately by the pipeline dispatcher (Phase 3).
  // Included here as a no-op placeholder for future integration.

  return { blocked: false };
}
