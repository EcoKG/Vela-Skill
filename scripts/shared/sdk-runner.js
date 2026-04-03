/**
 * Vela SDK Runner
 * Wraps @anthropic-ai/claude-agent-sdk `query()` for spawning SDK agents
 * from within Claude Code hooks. CJS module — dynamic ESM import at runtime.
 *
 * Key design decisions:
 * - settingSources: [] — prevents Vela hooks from loading in SDK-spawned agents (hook isolation)
 * - permissionMode: 'bypassPermissions' — SDK agents run under engine control, not interactive
 * - Auth inherited from process.env (ANTHROPIC_API_KEY) — no explicit key handling
 * - Entire invocation wrapped in try/catch — SDK errors never crash the caller
 */

"use strict";

/**
 * Dynamically import the Claude Agent SDK.
 * Uses 3-tier fallback to handle ESM import() resolution gaps (K009):
 *   1. Normal bare specifier — works when SDK is in the module resolution chain
 *   2. Absolute path to skill install location ($HOME/.claude/skills/vela/node_modules/)
 *   3. Returns { _error } — caller handles as sdk_not_available
 *
 * Tier 2 is needed because deploy-common.sh copies scripts to .vela/shared/
 * but doesn't copy node_modules. ESM import() resolves from the importing
 * module's directory, so .vela/shared/sdk-runner.js can't find the SDK
 * installed at ~/.claude/skills/vela/node_modules/.
 *
 * @returns {Promise<{query: Function}|{_error: Error}>}
 */
async function loadSdk() {
  // Tier 1: normal ESM resolution (works in source repo & when SDK is in ancestor node_modules)
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return sdk;
  } catch (_) {
    // fall through to tier 2
  }

  // Tier 2: absolute path to skill install location
  try {
    const os = require("os");
    const path = require("path");
    const sdkPath = path.join(
      os.homedir(),
      ".claude",
      "skills",
      "vela",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "sdk.mjs",
    );
    const sdk = await import(sdkPath);
    return sdk;
  } catch (_) {
    // fall through to tier 3
  }

  // Tier 3: global npm root (npm install -g)
  try {
    const { globalImport } = require("./global-require");
    const sdk = await globalImport("@anthropic-ai/claude-agent-sdk");
    return sdk;
  } catch (err) {
    return { _error: err };
  }
}

/**
 * Language directive map — maps language codes to system prompt directives.
 * @type {Object.<string, string>}
 */
const LANGUAGE_DIRECTIVES = {
  ko: "# 언어 지시\n모든 응답, 분석 결과, 보고서, 리뷰를 반드시 **한국어**로 작성하라. 코드, 명령어, 기술 용어(예: SQL injection, race condition)는 원어 그대로 사용하되, 설명과 문장은 한국어로 작성한다.",
  en: "# Language Directive\nAll responses, analysis results, reports, and reviews MUST be written in **English**.",
  ja: "# 言語指示\nすべての応答、分析結果、レポート、レビューを必ず**日本語**で作成すること。",
  zh: "# 语言指令\n所有回复、分析结果、报告和审查必须用**中文**撰写。",
};

/** Cache for config.json language value per cwd */
let _langCache = {};

/**
 * Read language from config.json and return a system prompt directive.
 * Looks for .vela/config.json (deployed) or templates/config.json (source repo).
 * Caches per cwd to avoid repeated filesystem reads.
 *
 * @param {string} [cwd] - Working directory to search for config.json
 * @returns {string|null} Language directive string, or null if not configured
 */
function _getLanguageDirective(cwd) {
  const dir = cwd || process.cwd();
  if (_langCache[dir] !== undefined) return _langCache[dir];

  const fs = require("fs");
  const p = require("path");

  // Try .vela/config.json (deployed project), then templates/config.json (source repo)
  const candidates = [
    p.join(dir, ".vela", "config.json"),
    p.join(dir, "templates", "config.json"),
  ];

  let lang = null;
  for (const cfgPath of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      if (cfg.language) {
        lang = cfg.language;
        break;
      }
    } catch {
      // file not found or invalid JSON — try next
    }
  }

  const directive = lang && LANGUAGE_DIRECTIVES[lang] ? LANGUAGE_DIRECTIVES[lang] : null;
  _langCache[dir] = directive;
  return directive;
}

/**
 * Compute retry delay with exponential backoff, clamped to [1000, 60000]ms.
 * If resetsAt timestamp is available and in the future, uses that instead.
 *
 * @param {number} attempt - Zero-based attempt index
 * @param {number} baseDelayMs - Base delay in milliseconds
 * @param {number|null} resetsAt - Optional Unix timestamp (ms) when rate limit resets
 * @returns {number} Delay in milliseconds
 */
function computeRetryDelay(attempt, baseDelayMs, resetsAt) {
  const MIN_DELAY = 1000;
  const MAX_DELAY = 60000;

  // If resetsAt is available and in the future, use it
  if (resetsAt != null) {
    const waitMs = resetsAt - Date.now();
    if (waitMs > 0) {
      return Math.min(Math.max(waitMs, MIN_DELAY), MAX_DELAY);
    }
  }

  // Exponential backoff: 2^attempt * baseDelayMs
  const delay = Math.pow(2, attempt) * baseDelayMs;
  return Math.min(Math.max(delay, MIN_DELAY), MAX_DELAY);
}

/**
 * Run an SDK agent with the given options.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - Required. The prompt to send to the agent.
 * @param {string} [opts.model] - Model identifier (e.g. 'sonnet', 'opus'. Omit to use Claude Code default.).
 * @param {string} [opts.cwd] - Working directory for the agent.
 * @param {string[]} [opts.allowedTools] - Tools the agent may use.
 * @param {string[]} [opts.disallowedTools] - Tools the agent may NOT use.
 * @param {number} [opts.maxTurns] - Maximum conversation turns.
 * @param {string} [opts.permissionMode='bypassPermissions'] - Permission mode.
 * @param {string|Object} [opts.systemPrompt] - System prompt string or preset object.
 * @param {boolean} [opts.persistSession=false] - Whether to persist the session.
 * @param {AbortController} [opts.abortController] - Optional abort controller.
 * @param {number} [opts.maxRetries=3] - Maximum retry attempts on rate limit errors.
 * @param {number} [opts.retryDelayMs=2000] - Base delay for exponential backoff (ms).
 * @param {Object} [opts.outputFormat] - JSON schema for structured output (SDK outputFormat).
 * @param {string} [opts.effort] - Effort level ('low'|'medium'|'high') for cost/speed tradeoff.
 * @param {Object} [opts.thinking] - Thinking configuration (e.g. { type: 'enabled', budget_tokens: N }).
 * @param {string} [opts.fallbackModel] - Fallback model identifier if primary model fails.
 * @param {Object} [opts.hooks] - SDK hooks object for lifecycle callbacks.
 * @param {boolean} [opts.enableFileCheckpointing] - Enable file checkpointing for state persistence.
 * @param {Object} [opts.extraArgs] - Additional arguments passed through to SDK query options.
 * @param {Object} [opts.mcpServers] - MCP server configurations for custom tools.
 *
 * @returns {Promise<Object>} Normalized result object:
 *   Success: { ok: true, result, structuredOutput, checkpoints, cost, model, sessionId, numTurns, durationMs }
 *     checkpoints: string[] — UUIDs captured from user messages during iteration (empty if none)
 *   SDK error result: { ok: false, error: subtype, details, cost, numTurns, durationMs, retriesAttempted? }
 *     Known error subtypes: 'error_max_turns', 'error_during_execution', 'error_max_structured_output_retries'
 *   SDK unavailable: { ok: false, error: 'sdk_not_available', details: errorMessage }
 *   Unexpected error: { ok: false, error: 'unexpected_error', details: errorMessage }
 */
async function runSdkAgent(opts) {
  if (!opts || typeof opts.prompt !== "string" || opts.prompt.length === 0) {
    return {
      ok: false,
      error: "invalid_input",
      details: "prompt is required and must be a non-empty string",
    };
  }

  // --- Load SDK dynamically ---
  const sdk = await loadSdk();

  if (sdk._error) {
    return {
      ok: false,
      error: "sdk_not_available",
      details: sdk._error.message || String(sdk._error),
    };
  }

  if (typeof sdk.query !== "function") {
    return {
      ok: false,
      error: "sdk_not_available",
      details: "SDK loaded but query() function not found",
    };
  }

  // --- Build query options ---
  const queryOptions = {
    // Hook isolation: empty settingSources prevents Vela hooks from loading
    // in SDK-spawned agents. Set explicitly — do not rely on SDK defaults.
    settingSources: [],

    // SDK agents run under engine control, not interactive
    permissionMode: opts.permissionMode || "bypassPermissions",
    allowDangerouslySkipPermissions: true,

    // Ephemeral by default
    persistSession: opts.persistSession === true ? true : false,
  };

  // Optional fields — only set if provided
  if (opts.model) queryOptions.model = opts.model;
  if (opts.cwd) queryOptions.cwd = opts.cwd;
  if (opts.allowedTools) queryOptions.allowedTools = opts.allowedTools;
  if (opts.disallowedTools) queryOptions.disallowedTools = opts.disallowedTools;
  if (opts.maxTurns != null) queryOptions.maxTurns = opts.maxTurns;
  if (opts.systemPrompt != null) queryOptions.systemPrompt = opts.systemPrompt;
  if (opts.abortController) queryOptions.abortController = opts.abortController;

  // --- Language directive injection ---
  // Read language from config.json and prepend a language directive to the system prompt.
  // This ensures all SDK agent outputs (review, research, plan-check, analysis) respect
  // the user's configured language without modifying each module individually.
  if (queryOptions.systemPrompt) {
    const langDirective = _getLanguageDirective(opts.cwd);
    if (langDirective) {
      queryOptions.systemPrompt = langDirective + "\n\n" + queryOptions.systemPrompt;
    }
  }

  // Structured output / effort / thinking options (S07)
  if (opts.outputFormat != null) queryOptions.outputFormat = opts.outputFormat;
  if (opts.effort != null) queryOptions.effort = opts.effort;
  if (opts.thinking != null) queryOptions.thinking = opts.thinking;
  if (opts.fallbackModel != null)
    queryOptions.fallbackModel = opts.fallbackModel;
  if (opts.hooks != null) queryOptions.hooks = opts.hooks;

  // Checkpointing / custom tools / extra args (S08)
  if (opts.enableFileCheckpointing != null)
    queryOptions.enableFileCheckpointing = opts.enableFileCheckpointing;
  if (opts.extraArgs != null) queryOptions.extraArgs = opts.extraArgs;
  if (opts.mcpServers != null) queryOptions.mcpServers = opts.mcpServers;

  // --- Rate limit retry parameters ---
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
  const retryDelayMs = opts.retryDelayMs != null ? opts.retryDelayMs : 2000;

  let totalCost = 0;
  let retriesAttempted = 0;

  // --- Execute query with rate-limit retry loop ---
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const startMs = Date.now();
      const generator = sdk.query({
        prompt: opts.prompt,
        options: queryOptions,
      });

      let resultMessage = null;
      let sessionId = null;
      let sawRateLimit = false;
      let resetsAt = null;
      const checkpoints = [];

      for await (const message of generator) {
        // Capture checkpoint UUIDs from user messages
        if (message.type === "user" && message.uuid) {
          checkpoints.push(message.uuid);
        }

        // Capture session ID from init message
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.session_id
        ) {
          sessionId = message.session_id;
        }

        // Detect rate limit events during execution
        if (
          message.type === "rate_limit_event" ||
          (message.type === "system" && message.subtype === "rate_limit_event")
        ) {
          sawRateLimit = true;
          if (message.resets_at) resetsAt = message.resets_at;
        }

        // Capture the final result message
        if (message.type === "result") {
          resultMessage = message;
        }
      }

      const elapsedMs = Date.now() - startMs;

      if (!resultMessage) {
        return {
          ok: false,
          error: "no_result",
          details: "SDK query completed without producing a result message",
          durationMs: elapsedMs,
          ...(retriesAttempted > 0
            ? { retriesAttempted, cost: totalCost }
            : {}),
        };
      }

      // Accumulate cost from this attempt
      if (resultMessage.total_cost_usd != null) {
        totalCost += resultMessage.total_cost_usd;
      }

      // --- Normalize result ---
      if (resultMessage.subtype === "success") {
        return {
          ok: true,
          result: resultMessage.result,
          structuredOutput: resultMessage.structured_output || null,
          checkpoints,
          cost: totalCost,
          model: resultMessage.model || opts.model || null,
          sessionId: resultMessage.session_id || sessionId,
          numTurns: resultMessage.num_turns,
          durationMs: resultMessage.duration_ms || elapsedMs,
          ...(retriesAttempted > 0 ? { retriesAttempted } : {}),
        };
      }

      // --- Rate limit retry logic ---
      // If the result is error_during_execution and we saw a rate limit event,
      // retry with exponential backoff (unless we've exhausted retries).
      if (
        sawRateLimit &&
        resultMessage.subtype === "error_during_execution" &&
        attempt < maxRetries
      ) {
        retriesAttempted = attempt + 1;
        const delay = computeRetryDelay(attempt, retryDelayMs, resetsAt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue; // retry
      }

      // Error subtypes: 'error_max_turns', 'error_during_execution', etc.
      const errorDetails = Array.isArray(resultMessage.errors)
        ? resultMessage.errors.join(", ")
        : resultMessage.result || "Unknown error";

      return {
        ok: false,
        error: resultMessage.subtype || "unknown_error",
        details: errorDetails,
        cost: totalCost,
        numTurns: resultMessage.num_turns,
        durationMs: resultMessage.duration_ms || elapsedMs,
        ...(retriesAttempted > 0 ? { retriesAttempted } : {}),
      };
    } catch (err) {
      const msg = err.message || String(err);
      const errorType = /max.*turns|maximum.*turns/i.test(msg)
        ? "max_turns_exceeded"
        : "unexpected_error";
      return {
        ok: false,
        error: errorType,
        details: msg,
        ...(retriesAttempted > 0 ? { retriesAttempted, cost: totalCost } : {}),
      };
    }
  }
}

module.exports = { runSdkAgent, computeRetryDelay };
