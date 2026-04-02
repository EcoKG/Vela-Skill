/**
 * Vela Custom Tools — MCP Server PoC
 * Builds a Vela-specific MCP tool server using the SDK's createSdkMcpServer()
 * and tool() functions with zod schemas for input validation.
 *
 * Exports an async factory createVelaToolServer(artifactDir) that returns an
 * MCP server config object passable to runSdkAgent({ mcpServers: { 'vela-tools': server } }).
 *
 * Tools provided:
 * - vela_pipeline_status  — reads pipeline-state.json from artifactDir
 * - vela_read_artifact    — reads a named artifact file (path traversal guarded)
 * - vela_record_note      — appends a timestamped note to notes.md
 *
 * CJS module — dynamic ESM import at runtime (same pattern as sdk-runner.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Dynamically import the Claude Agent SDK.
 * Returns the module or an object with _error if unavailable.
 * @returns {Promise<Object>}
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
 * Dynamically import zod for schema validation.
 * Returns the zod module or an object with _error if unavailable.
 * @returns {Promise<Object>}
 */
async function loadZod() {
  try {
    const zod = await import('zod');
    return zod;
  } catch (err) {
    return { _error: err };
  }
}

/**
 * Create a Vela-specific MCP tool server.
 *
 * @param {string} artifactDir - Directory for pipeline artifacts (state, notes, files)
 * @returns {Promise<Object>} MCP server config { type: 'sdk', name, instance }
 *   or { ok: false, error, details } on failure
 */
async function createVelaToolServer(artifactDir) {
  if (!artifactDir || typeof artifactDir !== 'string') {
    return { ok: false, error: 'invalid_input', details: 'artifactDir is required and must be a non-empty string' };
  }

  // --- Load dependencies ---
  const sdk = await loadSdk();
  if (sdk._error) {
    return {
      ok: false,
      error: 'sdk_not_available',
      details: sdk._error.message || String(sdk._error)
    };
  }

  if (typeof sdk.createSdkMcpServer !== 'function' || typeof sdk.tool !== 'function') {
    return {
      ok: false,
      error: 'sdk_not_available',
      details: 'SDK loaded but createSdkMcpServer() or tool() not found'
    };
  }

  const zod = await loadZod();
  if (zod._error) {
    return {
      ok: false,
      error: 'zod_not_available',
      details: zod._error.message || String(zod._error)
    };
  }

  const z = zod.z || zod.default || zod;
  if (typeof z.object !== 'function') {
    return {
      ok: false,
      error: 'zod_not_available',
      details: 'zod loaded but z.object() not found'
    };
  }

  // --- Define tools ---

  // Tool 1: vela_pipeline_status
  const pipelineStatusTool = sdk.tool(
    'vela_pipeline_status',
    'Read the current pipeline status from pipeline-state.json. Returns status, current step, completed steps, and cost.',
    z.object({}),
    async () => {
      try {
        const filePath = path.join(artifactDir, 'pipeline-state.json');
        const raw = fs.readFileSync(filePath, 'utf8');
        const state = JSON.parse(raw);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: state.status || 'unknown',
              current_step: state.current_step || null,
              completed_steps: state.completed_steps || [],
              cost: state.cost || 0
            })
          }]
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Failed to read pipeline state', details: err.message })
          }],
          isError: true
        };
      }
    }
  );

  // Tool 2: vela_read_artifact
  const readArtifactTool = sdk.tool(
    'vela_read_artifact',
    'Read a named artifact file from the artifact directory. Path traversal is blocked for security.',
    z.object({ filename: z.string() }),
    async (input) => {
      const filename = input.filename;

      // Path traversal guard
      if (filename.includes('..')) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Path traversal not allowed', filename })
          }],
          isError: true
        };
      }

      try {
        const filePath = path.join(artifactDir, filename);
        const content = fs.readFileSync(filePath, 'utf8');
        return {
          content: [{
            type: 'text',
            text: content
          }]
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Failed to read artifact', filename, details: err.message })
          }],
          isError: true
        };
      }
    }
  );

  // Tool 3: vela_record_note
  const recordNoteTool = sdk.tool(
    'vela_record_note',
    'Append a timestamped note to notes.md in the artifact directory. Creates the file if it does not exist.',
    z.object({ note: z.string() }),
    async (input) => {
      try {
        const filePath = path.join(artifactDir, 'notes.md');
        const timestamp = new Date().toISOString();
        const entry = `\n[${timestamp}] ${input.note}`;

        // Create directory if it doesn't exist
        if (!fs.existsSync(artifactDir)) {
          fs.mkdirSync(artifactDir, { recursive: true });
        }

        fs.appendFileSync(filePath, entry, 'utf8');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: true, timestamp, note: input.note })
          }]
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Failed to record note', details: err.message })
          }],
          isError: true
        };
      }
    }
  );

  // --- Build and return MCP server ---
  const server = sdk.createSdkMcpServer({
    name: 'vela-tools',
    version: '1.0.0',
    tools: [pipelineStatusTool, readArtifactTool, recordNoteTool]
  });

  return server;
}

module.exports = { createVelaToolServer };
