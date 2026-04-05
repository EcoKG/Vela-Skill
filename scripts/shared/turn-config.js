/**
 * turn-config.js — Centralized SDK agent maxTurns configuration.
 *
 * Provides a single source of truth for maxTurns limits across all SDK
 * consumers (vela-pipeline, sdk-reviewer). Replaces the TURNS_MAP constant
 * in vela-pipeline.js and the three hardcoded maxTurns literals (5/8/10)
 * in sdk-reviewer.js.
 *
 * BASE_LIMITS exposes two series:
 *   - 'researcher'/'planner'/'executor'/'reviewer'
 *       Pipeline-role keys consumed by vela-pipeline.js. The 'reviewer' key
 *       is a legacy fallback retained for completeness — current code paths
 *       dispatch to the stage-specific keys below.
 *   - 'reviewer-haiku'/'reviewer-sonnet'/'reviewer-opus'
 *       Stage-specific keys consumed by sdk-reviewer.js's 3-stage review
 *       ladder (Haiku fast → Sonnet deep → Opus escalation).
 *
 * SCALE_MULTIPLIERS adjusts limits based on request complexity:
 *   - small/medium: 1.0x (no adjustment)
 *   - large: 1.5x (scaled values rounded up via Math.ceil)
 *
 * Unknown role → 15 (safe default). Unknown/undefined scale → 1.0x.
 */

const BASE_LIMITS = {
  researcher: 15,
  planner: 15,
  executor: 25,
  reviewer: 10,
  "reviewer-haiku": 5,
  "reviewer-sonnet": 8,
  "reviewer-opus": 10,
};

const SCALE_MULTIPLIERS = {
  small: 1.0,
  medium: 1.0,
  large: 1.5,
};

/**
 * Resolve the maxTurns limit for a given role and scale.
 *
 * @param {string} role - Pipeline role or reviewer stage key
 *   (e.g. 'researcher', 'executor', 'reviewer-haiku').
 * @param {string} [scale='medium'] - Request complexity scale
 *   ('small' | 'medium' | 'large').
 * @returns {number} Integer maxTurns limit (Math.ceil applied for scaled values).
 */
function getTurnLimit(role, scale) {
  const base = BASE_LIMITS[role] !== undefined ? BASE_LIMITS[role] : 15;
  const multiplier =
    scale !== undefined && SCALE_MULTIPLIERS[scale] !== undefined
      ? SCALE_MULTIPLIERS[scale]
      : 1.0;
  return Math.ceil(base * multiplier);
}

module.exports = {
  getTurnLimit,
  BASE_LIMITS,
  SCALE_MULTIPLIERS,
};
