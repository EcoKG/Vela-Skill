'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constants ───

const SPRINT_VERSION = '1.0';

const SPRINT_STATUSES = ['planned', 'running', 'done', 'failed', 'cancelled'];
const SLICE_STATUSES = ['planned', 'queued', 'running', 'done', 'failed', 'skipped'];

const SPRINTS_DIR = '.vela/sprints';

/**
 * Valid slice status transitions.
 * Map from current status → Set of allowed next statuses.
 */
const SLICE_TRANSITIONS = {
  planned: new Set(['queued', 'skipped']),
  queued:   new Set(['running', 'skipped']),
  running:  new Set(['done', 'failed']),
};

/**
 * Valid sprint status transitions.
 * Map from current status → Set of allowed next statuses.
 */
const SPRINT_TRANSITIONS = {
  planned: new Set(['running', 'cancelled']),
  running: new Set(['done', 'failed', 'cancelled']),
};

// ─── Low-level helpers ───

/**
 * Atomic JSON write via tmp→rename.
 * Pattern from vela-engine.js writeJSON (line 1676).
 */
function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Strip internal bookkeeping fields before persisting.
 * Pattern from vela-engine.js cleanState (line 1668).
 */
function cleanSprint(plan) {
  const clean = { ...plan };
  delete clean._path;
  delete clean._sprintDir;
  return clean;
}

/**
 * Generate a slug from a title string.
 * Lowercase, replace non-alphanumeric with hyphens, collapse runs, trim, cap at 30 chars.
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
    .replace(/-$/, '');
}

/**
 * ISO-like timestamp string: YYYYMMDDTHHmmss
 */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ─── Validation ───

/**
 * Validate a sprint plan object.
 *
 * Checks:
 *   - Required top-level fields (version, id, title, request, status, slices[])
 *   - Sprint status is a known value
 *   - Slice ID uniqueness
 *   - Slice status values are known
 *   - depends_on references point to existing slice IDs
 *   - No dependency cycles (Kahn's algorithm, pattern from vela-wave.js line 169)
 *
 * @param {object} plan
 * @returns {{ valid: boolean, errors?: string[] }}
 */
function validateSprintPlan(plan) {
  const errors = [];

  // ── Required top-level fields ──
  for (const field of ['version', 'id', 'title', 'request', 'status']) {
    if (plan[field] == null || plan[field] === '') {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (!Array.isArray(plan.slices)) {
    errors.push('slices must be an array');
    return { valid: false, errors }; // can't do further slice checks
  }

  if (!SPRINT_STATUSES.includes(plan.status)) {
    errors.push(`invalid sprint status: ${plan.status}`);
  }

  // ── Slice-level checks ──
  const sliceIds = new Set();
  for (const slice of plan.slices) {
    if (!slice.id) {
      errors.push('slice missing id');
      continue;
    }
    if (sliceIds.has(slice.id)) {
      errors.push(`duplicate slice id: ${slice.id}`);
    }
    sliceIds.add(slice.id);

    if (slice.status && !SLICE_STATUSES.includes(slice.status)) {
      errors.push(`slice ${slice.id}: invalid status "${slice.status}"`);
    }
  }

  // ── depends_on reference validity ──
  for (const slice of plan.slices) {
    if (!Array.isArray(slice.depends_on)) continue;
    for (const dep of slice.depends_on) {
      if (!sliceIds.has(dep)) {
        errors.push(`slice ${slice.id}: depends_on references unknown slice "${dep}"`);
      }
    }
  }

  // ── Cycle detection via Kahn's algorithm ──
  if (errors.length === 0) {
    const inDegree = new Map();
    const adjacency = new Map();
    const ids = [...sliceIds];

    for (const id of ids) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }
    for (const slice of plan.slices) {
      if (!Array.isArray(slice.depends_on)) continue;
      for (const dep of slice.depends_on) {
        adjacency.get(dep).push(slice.id);
        inDegree.set(slice.id, inDegree.get(slice.id) + 1);
      }
    }

    let queue = ids.filter((id) => inDegree.get(id) === 0);
    let processed = 0;
    while (queue.length > 0) {
      processed += queue.length;
      const next = [];
      for (const id of queue) {
        for (const dependent of adjacency.get(id)) {
          inDegree.set(dependent, inDegree.get(dependent) - 1);
          if (inDegree.get(dependent) === 0) next.push(dependent);
        }
      }
      queue = next;
    }

    if (processed < ids.length) {
      const remaining = ids.filter((id) => inDegree.get(id) > 0);
      errors.push(`dependency cycle detected among slices: ${remaining.join(', ')}`);
    }
  }

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

// ─── CRUD ───

/**
 * Create a new sprint.
 *
 * @param {{ title: string, request: string, slices: Array<{ id: string, title: string, depends_on?: string[] }> }} opts
 * @returns {object} plan with _path and _sprintDir attached
 */
function createSprint({ title, request, slices }) {
  if (!title) throw new Error('createSprint: title is required');
  if (!request) throw new Error('createSprint: request is required');
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new Error('createSprint: at least one slice is required');
  }

  const id = `${timestamp()}-${slugify(title)}`;
  const sprintDir = path.join(SPRINTS_DIR, id);
  const planPath = path.join(sprintDir, 'sprint-plan.json');

  const now = new Date().toISOString();

  // Fill in defaults for each slice
  const normalizedSlices = slices.map((s) => ({
    id: s.id,
    title: s.title || s.id,
    status: 'planned',
    depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
    artifact_dir: null,
    result: null,
    started_at: null,
    completed_at: null,
  }));

  const plan = {
    version: SPRINT_VERSION,
    id,
    title,
    request,
    status: 'planned',
    created_at: now,
    updated_at: now,
    slices: normalizedSlices,
    context_passing: true,
    total_cost: 0,
    completed_slices: 0,
    total_slices: normalizedSlices.length,
  };

  // Validate before persisting
  const validation = validateSprintPlan(plan);
  if (!validation.valid) {
    throw new Error(`createSprint: invalid plan — ${validation.errors.join('; ')}`);
  }

  writeJSON(planPath, plan);

  // Attach internal fields for in-memory use
  plan._path = planPath;
  plan._sprintDir = sprintDir;
  return plan;
}

/**
 * Load a sprint by ID.
 *
 * @param {string} sprintId
 * @returns {object} plan with _path and _sprintDir attached
 */
function loadSprint(sprintId) {
  const sprintDir = path.join(SPRINTS_DIR, sprintId);
  const planPath = path.join(sprintDir, 'sprint-plan.json');

  if (!fs.existsSync(planPath)) {
    throw new Error(`loadSprint: sprint not found — ${planPath}`);
  }

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  plan._path = planPath;
  plan._sprintDir = sprintDir;
  return plan;
}

/**
 * Find the most recent active (status=running) sprint.
 * Scans sprint directories in reverse chronological order.
 * Pattern from vela-engine.js findActiveState (line 1350).
 *
 * @returns {object|null} plan with _path/_sprintDir, or null
 */
function findActiveSprint() {
  if (!fs.existsSync(SPRINTS_DIR)) return null;

  try {
    const allDirs = fs.readdirSync(SPRINTS_DIR).sort().reverse();

    for (const dir of allDirs.filter((d) => /^\d{8}T\d{6}-/.test(d))) {
      const dirPath = path.join(SPRINTS_DIR, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const planPath = path.join(dirPath, 'sprint-plan.json');
      if (!fs.existsSync(planPath)) continue;
      try {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
        if (plan.status !== 'running') continue;
        plan._path = planPath;
        plan._sprintDir = dirPath;
        return plan;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * List all sprints with summary info.
 *
 * @returns {Array<{ id: string, title: string, status: string, created_at: string, total_slices: number, completed_slices: number }>}
 */
function listSprints() {
  if (!fs.existsSync(SPRINTS_DIR)) return [];

  const results = [];
  try {
    const allDirs = fs.readdirSync(SPRINTS_DIR).sort().reverse();

    for (const dir of allDirs.filter((d) => /^\d{8}T\d{6}-/.test(d))) {
      const dirPath = path.join(SPRINTS_DIR, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const planPath = path.join(dirPath, 'sprint-plan.json');
      if (!fs.existsSync(planPath)) continue;
      try {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
        results.push({
          id: plan.id,
          title: plan.title,
          status: plan.status,
          created_at: plan.created_at,
          total_slices: plan.total_slices || 0,
          completed_slices: plan.completed_slices || 0,
        });
      } catch {
        continue;
      }
    }
  } catch {
    // directory read failure — return what we have
  }

  return results;
}

// ─── State Machine ───

/**
 * Update a slice's status within a sprint, with FSM transition validation.
 *
 * @param {string} sprintId - Sprint ID
 * @param {string} sliceId - Slice ID within the sprint
 * @param {object} updates - Fields to merge: { status, artifact_dir, result, started_at, completed_at }
 * @returns {object} Updated plan (with _path/_sprintDir)
 */
function updateSliceStatus(sprintId, sliceId, updates) {
  const plan = loadSprint(sprintId);

  const slice = plan.slices.find((s) => s.id === sliceId);
  if (!slice) {
    throw new Error(`updateSliceStatus: slice "${sliceId}" not found in sprint "${sprintId}"`);
  }

  // Validate status transition if status is being changed
  if (updates.status && updates.status !== slice.status) {
    const allowed = SLICE_TRANSITIONS[slice.status];
    if (!allowed || !allowed.has(updates.status)) {
      throw new Error(
        `updateSliceStatus: invalid transition "${slice.status}" → "${updates.status}" for slice "${sliceId}"`
      );
    }
  }

  // Merge allowed fields
  const mergeableFields = ['status', 'artifact_dir', 'result', 'started_at', 'completed_at'];
  for (const field of mergeableFields) {
    if (updates[field] !== undefined) {
      slice[field] = updates[field];
    }
  }

  // Recompute completed_slices count
  plan.completed_slices = plan.slices.filter(
    (s) => s.status === 'done' || s.status === 'skipped'
  ).length;

  plan.updated_at = new Date().toISOString();

  // Persist — strip internal fields before writing
  writeJSON(plan._path, cleanSprint(plan));

  return plan;
}

/**
 * Update a sprint's top-level status with FSM transition validation.
 *
 * @param {string} sprintId - Sprint ID
 * @param {string} status - New status
 * @returns {object} Updated plan (with _path/_sprintDir)
 */
function updateSprintStatus(sprintId, status) {
  const plan = loadSprint(sprintId);

  const allowed = SPRINT_TRANSITIONS[plan.status];
  if (!allowed || !allowed.has(status)) {
    throw new Error(
      `updateSprintStatus: invalid transition "${plan.status}" → "${status}" for sprint "${sprintId}"`
    );
  }

  plan.status = status;
  plan.updated_at = new Date().toISOString();

  writeJSON(plan._path, cleanSprint(plan));

  return plan;
}

// ─── Queue System ───

/**
 * Determine the next action for a sprint based on slice states and dependencies.
 * Pure function — no side effects. Operates on an in-memory plan object.
 *
 * @param {object} sprintPlan - A loaded sprint plan
 * @returns {{ action: string, slice?: object, reason?: string }}
 *   - { action: 'halt', reason }    — a slice failed, sprint should stop
 *   - { action: 'complete' }        — all slices are done/skipped
 *   - { action: 'wait', slice }     — a slice is currently running
 *   - { action: 'run', slice }      — next slice ready to execute
 *   - { action: 'blocked', reason } — no slice can run (unresolved deps)
 */
function getNextSlice(sprintPlan) {
  const slices = sprintPlan.slices;

  // 1. Check for failed slices
  const failed = slices.find((s) => s.status === 'failed');
  if (failed) {
    return { action: 'halt', reason: `slice "${failed.id}" failed` };
  }

  // 2. Check if all slices are terminal (done or skipped)
  const allTerminal = slices.every((s) => s.status === 'done' || s.status === 'skipped');
  if (allTerminal) {
    return { action: 'complete' };
  }

  // 3. Check for running slices
  const running = slices.find((s) => s.status === 'running');
  if (running) {
    return { action: 'wait', slice: running };
  }

  // 4. Find the first planned slice whose dependencies are all satisfied
  const terminalIds = new Set(
    slices.filter((s) => s.status === 'done' || s.status === 'skipped').map((s) => s.id)
  );

  for (const slice of slices) {
    if (slice.status !== 'planned') continue;

    const deps = slice.depends_on || [];
    const depsSatisfied = deps.every((dep) => terminalIds.has(dep));
    if (depsSatisfied) {
      return { action: 'run', slice };
    }
  }

  // 5. Remaining slices exist but none can run
  const pending = slices.filter((s) => s.status !== 'done' && s.status !== 'skipped');
  return {
    action: 'blocked',
    reason: `${pending.length} slice(s) pending but dependencies not met`,
  };
}

// ─── Exports ───

module.exports = {
  // Constants
  SPRINT_VERSION,
  SPRINT_STATUSES,
  SLICE_STATUSES,
  SPRINTS_DIR,
  SLICE_TRANSITIONS,
  SPRINT_TRANSITIONS,

  // Helpers
  writeJSON,
  cleanSprint,
  slugify,

  // CRUD
  createSprint,
  loadSprint,
  findActiveSprint,
  listSprints,

  // Validation
  validateSprintPlan,

  // State Machine
  updateSliceStatus,
  updateSprintStatus,

  // Queue System
  getNextSlice,
};
