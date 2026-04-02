#!/usr/bin/env node
/**
 * ⛵ Vela Wave — Plan.md dependency analyzer & wave parallelization PoC
 *
 * Parses plan.md Task Distribution section, extracts dependency info,
 * performs topological sort (Kahn's algorithm) into parallel waves,
 * and outputs the wave grouping as a dry-run plan.
 *
 * Usage:
 *   node scripts/cli/vela-wave.js <plan.md>          # human-readable output
 *   node scripts/cli/vela-wave.js <plan.md> --json    # JSON output
 *
 * Dependency markers (in task descriptions):
 *   depends: [TaskA, TaskB]
 *   after: [TaskA]
 *   requires: [TaskA]
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Parser ─────────────────────────────────────────────────

/**
 * Extract Task Distribution section from plan.md content.
 * Returns array of { name: string, description: string, depends: string[] }
 *
 * Handles:
 *  - `## Task Distribution` heading (stops at next `##`)
 *  - Task entries: `- TaskName: description` or `N. TaskName: description`
 *  - Dependency markers: depends: [...], after: [...], requires: [...]
 *  - Korean task names (e.g. 분석 태스크)
 */
function parsePlanMd(content) {
  const lines = content.split('\n');
  const tasks = [];

  // 1. Find ## Task Distribution section
  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (/^##\s+Task\s+Distribution/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      // Next section starts — stop
      break;
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  if (sectionLines.length === 0) {
    return tasks;
  }

  // 2. Extract task entries from section lines
  //    Pattern: `- TaskName: description` or `N. TaskName: description`
  //    Task name = first significant text before `:` or end of line
  const taskLineRe = /^(?:\s*[-*]\s+|\s*\d+\.\s+)(.+)$/;

  for (const line of sectionLines) {
    const m = line.match(taskLineRe);
    if (!m) continue;

    const raw = m[1].trim();
    if (!raw) continue;

    // Parse name and description
    // Format: "TaskName: description" or "TaskName (depends: [...])"
    let name, description;
    const colonIdx = raw.indexOf(':');

    // Check if colon is part of a dependency marker at the start
    const isDepMarker = /^(depends|after|requires)\s*:/i.test(raw);

    if (colonIdx > 0 && !isDepMarker) {
      name = raw.slice(0, colonIdx).trim();
      description = raw.slice(colonIdx + 1).trim();
    } else {
      // No colon or it's a dep marker — use entire text as name
      name = raw.replace(/\s*\(.*\)\s*$/, '').trim();
      description = raw;
    }

    // 3. Extract dependency markers from the full raw text
    const depends = extractDependencies(raw);

    tasks.push({ name, description, depends });
  }

  return tasks;
}

/**
 * Extract dependency names from text containing depends:/after:/requires: markers.
 * Supports: depends: [A, B], after: [A], requires: [A, B, C]
 */
function extractDependencies(text) {
  const deps = [];
  // Match all dependency markers: depends: [...], after: [...], requires: [...]
  const markerRe = /(?:depends|after|requires)\s*:\s*\[([^\]]*)\]/gi;
  let match;

  while ((match = markerRe.exec(text)) !== null) {
    const inner = match[1].trim();
    if (inner) {
      const names = inner.split(',').map(s => s.trim()).filter(Boolean);
      deps.push(...names);
    }
  }

  return deps;
}

// ── Dependency Graph ────────────────────────────────────────

/**
 * Build adjacency list and in-degree map from task array.
 * Returns { adjacency: Map<name, dependents[]>, inDegree: Map<name, number>, taskNames: string[] }
 *
 * adjacency[A] = [B] means "A → B" (B depends on A, so after A completes, B can proceed)
 */
function buildDependencyGraph(tasks) {
  const taskNames = tasks.map(t => t.name);
  const nameSet = new Set(taskNames);
  const adjacency = new Map();
  const inDegree = new Map();

  // Initialize all nodes
  for (const name of taskNames) {
    adjacency.set(name, []);
    inDegree.set(name, 0);
  }

  // Build edges: if B depends on A, add edge A → B
  for (const task of tasks) {
    for (const dep of task.depends) {
      if (!nameSet.has(dep)) {
        // Skip unknown dependencies (warn in production, ignore in PoC)
        continue;
      }
      adjacency.get(dep).push(task.name);
      inDegree.set(task.name, inDegree.get(task.name) + 1);
    }
  }

  return { adjacency, inDegree, taskNames };
}

// ── Topological Sort (Kahn's Algorithm) ─────────────────────

/**
 * Kahn's algorithm — returns array of waves.
 * Each wave is an array of task names that can execute in parallel.
 * Throws if a cycle is detected.
 *
 * @param {{ adjacency: Map, inDegree: Map, taskNames: string[] }} graph
 * @returns {string[][]} waves
 */
function topologicalSort(graph) {
  const { adjacency, inDegree, taskNames } = graph;

  // Clone inDegree so we don't mutate input
  const degree = new Map(inDegree);
  const waves = [];
  let processed = 0;

  // Seed queue with all tasks having inDegree 0
  let queue = [];
  for (const name of taskNames) {
    if (degree.get(name) === 0) {
      queue.push(name);
    }
  }

  while (queue.length > 0) {
    // Current wave = all tasks in queue
    waves.push([...queue]);
    processed += queue.length;

    const nextQueue = [];
    for (const name of queue) {
      const dependents = adjacency.get(name) || [];
      for (const dep of dependents) {
        degree.set(dep, degree.get(dep) - 1);
        if (degree.get(dep) === 0) {
          nextQueue.push(dep);
        }
      }
    }
    queue = nextQueue;
  }

  // Cycle detection: if we didn't process all tasks, there's a cycle
  if (processed < taskNames.length) {
    const remaining = taskNames.filter(n => degree.get(n) > 0);
    throw new Error(
      `Cycle detected — cannot schedule ${remaining.length} task(s): ${remaining.join(', ')}`
    );
  }

  return waves;
}

// ── Output Formatter ────────────────────────────────────────

/**
 * Format wave grouping as structured output.
 * Returns { text: string, json: object }
 */
function formatWaveOutput(waves, tasks) {
  const taskMap = new Map(tasks.map(t => [t.name, t]));

  const jsonOutput = {
    totalTasks: tasks.length,
    totalWaves: waves.length,
    waves: waves.map((wave, i) => ({
      wave: i + 1,
      parallel: wave.length,
      tasks: wave.map(name => {
        const t = taskMap.get(name);
        return {
          name,
          depends: t ? t.depends : []
        };
      })
    }))
  };

  // Human-readable text
  const lines = [];
  lines.push(`⛵ Wave Parallelization Plan`);
  lines.push(`───────────────────────────────`);
  lines.push(`Total tasks: ${tasks.length}`);
  lines.push(`Total waves: ${waves.length}`);
  lines.push('');

  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    lines.push(`🌊 Wave ${i + 1} (${wave.length} task${wave.length > 1 ? 's' : ''} in parallel)`);
    for (const name of wave) {
      const t = taskMap.get(name);
      const depStr = t && t.depends.length > 0 ? ` ← [${t.depends.join(', ')}]` : '';
      lines.push(`   • ${name}${depStr}`);
    }
    lines.push('');
  }

  return { text: lines.join('\n'), json: jsonOutput };
}

// ── CLI Entry Point ─────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const filePath = args.find(a => !a.startsWith('--'));

  if (!filePath) {
    console.error('Usage: vela-wave.js <plan.md> [--json]');
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const tasks = parsePlanMd(content);

  if (tasks.length === 0) {
    console.error('No tasks found in Task Distribution section.');
    process.exit(1);
  }

  const graph = buildDependencyGraph(tasks);
  const waves = topologicalSort(graph);
  const output = formatWaveOutput(waves, tasks);

  if (jsonFlag) {
    console.log(JSON.stringify(output.json, null, 2));
  } else {
    console.log(output.text);
  }
}

// Run CLI only when executed directly
if (require.main === module) {
  main();
}

module.exports = { parsePlanMd, buildDependencyGraph, topologicalSort, formatWaveOutput };
