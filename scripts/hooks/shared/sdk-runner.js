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

'use strict';

/**
 * Dynamically import the Claude Agent SDK.
 * Returns the module or null if unavailable.
 * @returns {Promise<{query: Function}|null>}
 */
async function loadSdk() {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    return sdk;
  } catch (err) {
    return { _error: err };
  }
}

/**
 * Run an SDK agent with the given options.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - Required. The prompt to send to the agent.
 * @param {string} [opts.model] - Model identifier (e.g. 'claude-sonnet-4-5-20250929').
 * @param {string} [opts.cwd] - Working directory for the agent.
 * @param {string[]} [opts.allowedTools] - Tools the agent may use.
 * @param {string[]} [opts.disallowedTools] - Tools the agent may NOT use.
 * @param {number} [opts.maxTurns] - Maximum conversation turns.
 * @param {number} [opts.maxBudgetUsd] - Budget cap in USD.
 * @param {string} [opts.permissionMode='bypassPermissions'] - Permission mode.
 * @param {string|Object} [opts.systemPrompt] - System prompt string or preset object.
 * @param {boolean} [opts.persistSession=false] - Whether to persist the session.
 * @param {AbortController} [opts.abortController] - Optional abort controller.
 *
 * @returns {Promise<Object>} Normalized result object:
 *   Success: { ok: true, result, cost, model, sessionId, numTurns, durationMs }
 *   SDK error result: { ok: false, error: subtype, details, cost, numTurns, durationMs }
 *   SDK unavailable: { ok: false, error: 'sdk_not_available', details: errorMessage }
 *   Unexpected error: { ok: false, error: 'unexpected_error', details: errorMessage }
 */
async function runSdkAgent(opts) {
  if (!opts || typeof opts.prompt !== 'string' || opts.prompt.length === 0) {
    return { ok: false, error: 'invalid_input', details: 'prompt is required and must be a non-empty string' };
  }

  // --- Load SDK dynamically ---
  const sdk = await loadSdk();

  if (sdk._error) {
    return {
      ok: false,
      error: 'sdk_not_available',
      details: sdk._error.message || String(sdk._error)
    };
  }

  if (typeof sdk.query !== 'function') {
    return {
      ok: false,
      error: 'sdk_not_available',
      details: 'SDK loaded but query() function not found'
    };
  }

  // --- Build query options ---
  const queryOptions = {
    // Hook isolation: empty settingSources prevents Vela hooks from loading
    // in SDK-spawned agents. Set explicitly — do not rely on SDK defaults.
    settingSources: [],

    // SDK agents run under engine control, not interactive
    permissionMode: opts.permissionMode || 'bypassPermissions',
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
  if (opts.maxBudgetUsd != null) queryOptions.maxBudgetUsd = opts.maxBudgetUsd;
  if (opts.systemPrompt != null) queryOptions.systemPrompt = opts.systemPrompt;
  if (opts.abortController) queryOptions.abortController = opts.abortController;

  // --- Execute query and collect result ---
  try {
    const startMs = Date.now();
    const generator = sdk.query({ prompt: opts.prompt, options: queryOptions });

    let resultMessage = null;
    let sessionId = null;

    for await (const message of generator) {
      // Capture session ID from init message
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        sessionId = message.session_id;
      }

      // Capture the final result message
      if (message.type === 'result') {
        resultMessage = message;
      }
    }

    const elapsedMs = Date.now() - startMs;

    if (!resultMessage) {
      return {
        ok: false,
        error: 'no_result',
        details: 'SDK query completed without producing a result message',
        durationMs: elapsedMs
      };
    }

    // --- Normalize result ---
    if (resultMessage.subtype === 'success') {
      return {
        ok: true,
        result: resultMessage.result,
        cost: resultMessage.total_cost_usd,
        model: resultMessage.model || opts.model || null,
        sessionId: resultMessage.session_id || sessionId,
        numTurns: resultMessage.num_turns,
        durationMs: resultMessage.duration_ms || elapsedMs
      };
    }

    // Error subtypes: 'error_max_turns', 'error_during_execution', etc.
    const errorDetails = Array.isArray(resultMessage.errors)
      ? resultMessage.errors.join(', ')
      : resultMessage.result || 'Unknown error';

    return {
      ok: false,
      error: resultMessage.subtype || 'unknown_error',
      details: errorDetails,
      cost: resultMessage.total_cost_usd,
      numTurns: resultMessage.num_turns,
      durationMs: resultMessage.duration_ms || elapsedMs
    };

  } catch (err) {
    return {
      ok: false,
      error: 'unexpected_error',
      details: err.message || String(err)
    };
  }
}

module.exports = { runSdkAgent };
