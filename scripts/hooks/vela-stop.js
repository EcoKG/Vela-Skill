#!/usr/bin/env node
/**
 * ⛵ Vela Stop Hook — Warns when session ends with active pipeline
 *
 * Fires on the Stop event. If an active pipeline exists,
 * outputs a warning so the user knows work is incomplete.
 */

const fs = require('fs');
const path = require('path');
const { findActivePipeline, readConfig } = require('./shared/pipeline');

async function main() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const velaDir = path.join(cwd, '.vela');
  const config = readConfig(cwd);
  if (!config) process.exit(0);

  const state = findActivePipeline(velaDir);
  if (!state) process.exit(0);

  // ─── Clean up delegation signal ───
  // When PM's turn ends, clear the delegation flag so next PM action
  // must go through a SubAgent again.
  const delegationPath = path.join(velaDir, 'state', 'delegation.json');
  if (fs.existsSync(delegationPath)) {
    try { fs.unlinkSync(delegationPath); } catch (e) {}
  }

  // Active pipeline exists — warn user
  const step = state.current_step || '?';
  const ptype = state.pipeline_type || '?';
  const request = (state.request || '').substring(0, 50);

  process.stdout.write(JSON.stringify({
    systemMessage: `⛵ [Vela] 활성 파이프라인이 있습니다!\n` +
      `  🧭 ${ptype} │ Step: ${step} │ ${request}\n` +
      `  다음 세션에서 /vela 로 재개할 수 있습니다.`
  }));

  process.exit(0);
}

main().catch(() => process.exit(0));
