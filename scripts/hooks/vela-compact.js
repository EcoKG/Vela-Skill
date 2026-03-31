#!/usr/bin/env node
/**
 * ⛵ Vela Compact Hook — Preserves pipeline state through context compression
 *
 * PreCompact: Saves current pipeline state summary to file
 * PostCompact: Re-injects pipeline state into context
 *
 * Used for BOTH PreCompact and PostCompact events.
 * Detects which event via the hook input.
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

  const stateDir = path.join(velaDir, 'state');
  const compactFile = path.join(stateDir, 'compact-context.json');

  // Determine event type from hook input
  const eventName = input.hook_event_name || '';

  if (eventName === 'PreCompact') {
    // PreCompact: save state only, no output
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

    const compactContext = {
      pipeline_type: state.pipeline_type,
      current_step: state.current_step,
      request: state.request,
      completed_steps: state.completed_steps || [],
      artifact_dir: state._artifactDir,
      git: state.git || null,
      saved_at: new Date().toISOString()
    };

    fs.writeFileSync(compactFile, JSON.stringify(compactContext, null, 2));
    process.exit(0);
  }

  // PostCompact: read saved context and inject additionalContext
  let ctx;
  try {
    ctx = JSON.parse(fs.readFileSync(compactFile, 'utf-8'));
  } catch (e) {
    // No saved context — fall back to live state
    ctx = {
      pipeline_type: state.pipeline_type,
      current_step: state.current_step,
      request: state.request,
      completed_steps: state.completed_steps || [],
      artifact_dir: state._artifactDir
    };
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostCompact',
      additionalContext:
        `⛵ [Vela] 파이프라인 컨텍스트 복원:\n` +
        `  🧭 ${ctx.pipeline_type} │ Step: ${ctx.current_step}\n` +
        `  Task: ${ctx.request}\n` +
        `  Completed: ${(ctx.completed_steps || []).join(' → ')}\n` +
        `  Artifact: ${ctx.artifact_dir}\n` +
        `  이 파이프라인을 계속 진행하세요. node .vela/cli/vela-engine.js state 로 현재 상태를 확인하세요.`
    }
  }));

  process.exit(0);
}

main().catch(() => process.exit(0));
