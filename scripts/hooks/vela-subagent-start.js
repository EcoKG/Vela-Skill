#!/usr/bin/env node
/**
 * ⛵ Vela SubagentStart Hook — Injects pipeline context into subagents
 *
 * When a subagent starts, inject the current pipeline state
 * so the agent is aware of which step it's in.
 */

const fs = require('fs');
const path = require('path');
const { findActivePipeline, readConfig } = require('./shared/pipeline');
const { signJSON, readKey } = require('./shared/hmac');

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

  // ─── Delegation signal for GUARD 12 ───
  // When a subagent starts during execute step, write delegation.json
  // so gate-guard knows source edits are being done by a delegated agent.
  if (state.current_step === 'execute') {
    const stateDir = path.join(velaDir, 'state');
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const delegationPath = path.join(stateDir, 'delegation.json');
    const delegationObj = {
      active: true,
      step: state.current_step,
      started_at: Date.now()
    };
    // Sign with HMAC if key exists (pre-HMAC pipelines skip silently)
    const hmacKey = readKey(velaDir);
    if (hmacKey) {
      delegationObj._hmac = signJSON(delegationObj, hmacKey);
    }
    fs.writeFileSync(delegationPath, JSON.stringify(delegationObj, null, 2));
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext:
        `⛵ [Vela] 현재 파이프라인 상태:\n` +
        `  🧭 ${state.pipeline_type} │ Step: ${state.current_step}\n` +
        `  Task: ${state.request || ''}\n` +
        `  Artifact: ${state._artifactDir || ''}\n` +
        `  .vela/agents/ 디렉토리의 지시사항을 따르세요.`
    }
  }));

  process.exit(0);
}

main().catch(() => process.exit(0));
