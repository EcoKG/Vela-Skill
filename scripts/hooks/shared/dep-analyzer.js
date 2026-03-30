/**
 * Vela Dependency Analyzer
 * Parses npm audit and npm outdated JSON output into normalized findings.
 * Pure CLI-based — no SDK or AI dependency.
 *
 * Exports: analyzeDeps({ cwd })
 *
 * Design decisions:
 * - npm audit exit code 1 is normal (means vulnerabilities found), not an error
 * - npm outdated exit code 1 is normal (means outdated packages exist), not an error
 * - Never throws — always returns { ok: true/false, ... }
 * - execSync used intentionally (synchronous module for pipeline integration)
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Helpers ───

/**
 * Run a CLI command, tolerating non-zero exit codes.
 * npm audit/outdated return exit 1 as normal business logic.
 * @param {string} cmd - Command to execute
 * @param {string} cwd - Working directory
 * @returns {{ stdout: string, exitCode: number, error: string|null }}
 */
function runCommand(cmd, cwd) {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { stdout, exitCode: 0, error: null };
  } catch (err) {
    // execSync throws on non-zero exit. stdout is still available.
    if (err.stdout !== undefined) {
      return {
        stdout: err.stdout,
        exitCode: err.status || 1,
        error: null,
      };
    }
    // Genuine execution failure (command not found, timeout, etc.)
    return {
      stdout: '',
      exitCode: err.status || 127,
      error: err.message || 'command execution failed',
    };
  }
}

/**
 * Safely parse JSON, returning null on failure.
 * @param {string} text
 * @returns {any|null}
 */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Audit parsing ───

/**
 * Parse npm audit v2 JSON into normalized findings.
 * @param {Object} auditJson - Parsed audit JSON (v2 schema)
 * @returns {{ findings: Array, bySeverity: Object, totalVulnerabilities: number }}
 */
function parseAuditV2(auditJson) {
  const findings = [];
  const vulns = auditJson.vulnerabilities || {};

  for (const [name, entry] of Object.entries(vulns)) {
    findings.push({
      name,
      severity: entry.severity || 'unknown',
      isDirect: entry.isDirect || false,
      title: (entry.via && Array.isArray(entry.via) && entry.via[0])
        ? (typeof entry.via[0] === 'object' ? entry.via[0].title || '' : String(entry.via[0]))
        : '',
      url: (entry.via && Array.isArray(entry.via) && entry.via[0] && typeof entry.via[0] === 'object')
        ? entry.via[0].url || ''
        : '',
      fixAvailable: entry.fixAvailable !== undefined
        ? (typeof entry.fixAvailable === 'boolean' ? entry.fixAvailable : true)
        : false,
    });
  }

  const meta = auditJson.metadata || {};
  const vulnCounts = meta.vulnerabilities || {};
  const bySeverity = {
    info: vulnCounts.info || 0,
    low: vulnCounts.low || 0,
    moderate: vulnCounts.moderate || 0,
    high: vulnCounts.high || 0,
    critical: vulnCounts.critical || 0,
  };
  const totalVulnerabilities = vulnCounts.total || findings.length;

  return { findings, bySeverity, totalVulnerabilities };
}

// ─── Outdated parsing ───

/**
 * Parse npm outdated JSON into normalized array.
 * @param {Object} outdatedJson - Parsed outdated JSON
 * @returns {Array<{ name: string, current: string, wanted: string, latest: string }>}
 */
function parseOutdated(outdatedJson) {
  const outdated = [];
  for (const [name, entry] of Object.entries(outdatedJson)) {
    outdated.push({
      name,
      current: entry.current || 'N/A',
      wanted: entry.wanted || 'N/A',
      latest: entry.latest || 'N/A',
    });
  }
  return outdated;
}

// ─── Main export ───

/**
 * Analyze project dependencies via npm audit and npm outdated.
 *
 * @param {Object} [opts] - Options
 * @param {string} opts.cwd - Project root directory (required)
 * @returns {Object} Result:
 *   Success: { ok: true, findings: [...], outdated: [...], metadata: { totalVulnerabilities, bySeverity, outdatedCount } }
 *   Failure: { ok: false, error: string }
 */
function analyzeDeps(opts) {
  // ─── Parameter validation ───
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'options object is required' };
  }

  const { cwd } = opts;
  if (!cwd || typeof cwd !== 'string') {
    return { ok: false, error: 'cwd is required and must be a string' };
  }

  // Verify cwd exists and has package.json
  try {
    if (!fs.existsSync(cwd)) {
      return { ok: false, error: `cwd does not exist: ${cwd}` };
    }
    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
      return { ok: false, error: `no package.json found in: ${cwd}` };
    }
  } catch (err) {
    return { ok: false, error: `cwd validation failed: ${err.message}` };
  }

  // ─── npm audit ───
  const auditResult = runCommand('npm audit --json', cwd);
  if (auditResult.error) {
    return { ok: false, error: `npm audit failed: ${auditResult.error}` };
  }

  const auditJson = safeJsonParse(auditResult.stdout);
  if (!auditJson) {
    return { ok: false, error: 'audit parse failed: npm audit output is not valid JSON' };
  }

  const { findings, bySeverity, totalVulnerabilities } = parseAuditV2(auditJson);

  // ─── npm outdated ───
  const outdatedResult = runCommand('npm outdated --json', cwd);
  if (outdatedResult.error) {
    return { ok: false, error: `npm outdated failed: ${outdatedResult.error}` };
  }

  // Empty stdout means no outdated packages — normalize to {}
  const outdatedRaw = outdatedResult.stdout.trim();
  let outdatedJson;
  if (outdatedRaw === '') {
    outdatedJson = {};
  } else {
    outdatedJson = safeJsonParse(outdatedRaw);
    if (outdatedJson === null) {
      return { ok: false, error: 'outdated parse failed: npm outdated output is not valid JSON' };
    }
  }

  const outdated = parseOutdated(outdatedJson);

  // ─── Compose result ───
  return {
    ok: true,
    findings,
    outdated,
    metadata: {
      totalVulnerabilities,
      bySeverity,
      outdatedCount: outdated.length,
    },
  };
}

module.exports = { analyzeDeps };
