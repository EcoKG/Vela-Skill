#!/usr/bin/env node
/**
 * Vela Pipeline Orchestrator — SDK-based Pipeline Execution
 *
 * Drives the Vela pipeline (research→plan→execute→review) using
 * @anthropic-ai/claude-agent-sdk query() calls. Each step spawns
 * an isolated SDK agent with step-specific tools, system prompts,
 * and permission hooks.
 *
 * Commands:
 *   run <request> --scale <s/m/l> [--type TYPE]  — Run full pipeline
 *   status                                         — Show pipeline status
 *   cancel                                         — Cancel active pipeline
 *
 * Architecture:
 *   - vela-engine.js handles state machine (init/transition/record)
 *   - This file handles SDK agent orchestration per step
 *   - constants.js provides guard patterns (bash, secrets, sensitive files)
 *   - pipeline.json defines step sequences per pipeline type
 *
 * Key decisions:
 *   D028: SDK orchestrator approach (query-based, not hook-based)
 *   D029: bypassPermissions mandatory (dontAsk/acceptEdits prompt on Read)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ─── Paths ───
const CWD = process.cwd();
const VELA_DIR = path.join(CWD, '.vela');
const TEMPLATES_DIR = path.join(VELA_DIR, 'templates');
const AGENTS_DIR = path.join(VELA_DIR, 'scripts', 'agents');
const ENGINE_PATH = path.resolve(__dirname, 'vela-engine.js');

// ─── Constants for SDK hooks guards ───
const {
  SAFE_BASH_READ,
  BASH_WRITE_PATTERNS,
  SENSITIVE_FILES,
  SECRET_PATTERNS,
  MODEL_VERSIONS
} = require('../shared/constants');

// ─── SDK runner ───
const { runSdkAgent } = require('../shared/sdk-runner');

// ─── CLI Argument Parsing ───
const args = process.argv.slice(2);
const command = args[0];

// ═══════════════════════════════════════════════════════════
//  SDK Hooks — Permission Guards as Callbacks
// ═══════════════════════════════════════════════════════════

/**
 * Guard: Block bash commands that write files in read-only mode.
 * Uses SAFE_BASH_READ regex and BASH_WRITE_PATTERNS from constants.js.
 *
 * @param {string} mode - Current step mode ('read', 'write', 'readwrite')
 * @returns {Function|null} PreToolUse hook callback, or null if mode allows all bash
 */
function createBashGuard(mode) {
  if (mode === 'readwrite') return null; // No restrictions in readwrite mode

  return async (input) => {
    if (input.tool_name !== 'Bash') return undefined; // Pass through non-bash

    const cmd = input.tool_input?.command || '';

    if (mode === 'read') {
      // In read mode: allow safe read commands, block everything else
      if (SAFE_BASH_READ.test(cmd)) return undefined; // Safe read — allow

      // Check for write patterns — explicit block
      for (const pattern of BASH_WRITE_PATTERNS) {
        if (pattern.test(cmd)) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `[vela-pipeline] Bash write command blocked in read mode: ${cmd.substring(0, 80)}`,
            },
          };
        }
      }

      // Not in safe-read list and not a write pattern — deny conservatively
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `[vela-pipeline] Bash command not in safe-read allowlist: ${cmd.substring(0, 80)}`,
        },
      };
    }

    if (mode === 'write') {
      // In write mode: block bash entirely (write via Write/Edit tools only)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: '[vela-pipeline] Bash blocked in write mode. Use Write/Edit tools.',
        },
      };
    }

    return undefined;
  };
}

/**
 * Guard: Block access to sensitive files (.env, credentials.json, etc.)
 * Uses SENSITIVE_FILES list from constants.js.
 *
 * @returns {Function} PreToolUse hook callback
 */
function createSensitiveFileGuard() {
  return async (input) => {
    const toolName = input.tool_name;
    if (!['Read', 'Write', 'Edit'].includes(toolName)) return undefined;

    const filePath = input.tool_input?.file_path || input.tool_input?.path || '';
    const basename = path.basename(filePath);

    if (SENSITIVE_FILES.includes(basename)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `[vela-pipeline] Access to sensitive file blocked: ${basename}`,
        },
      };
    }

    return undefined;
  };
}

/**
 * Guard: Block tool outputs that contain secrets (API keys, tokens, etc.)
 * Uses SECRET_PATTERNS from constants.js.
 *
 * Implemented as PostToolUse hook — inspects tool output after execution.
 * Returns a warning but doesn't block (secrets already leaked to agent context).
 * Primary defense is PreToolUse guards; this is an observability layer.
 *
 * @returns {Function} PostToolUse hook callback
 */
function createSecretGuard() {
  return async (input) => {
    const response = input.tool_response || '';
    const responseStr = typeof response === 'string' ? response : JSON.stringify(response);

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(responseStr)) {
        console.error(`[vela-pipeline] ⚠️ Secret pattern detected in ${input.tool_name} output`);
        // Log but don't block — the output already reached the agent
        break;
      }
    }

    return { continue: true };
  };
}

/**
 * Guard: Block git operations on protected branches.
 *
 * @returns {Function} PreToolUse hook callback
 */
function createProtectedBranchGuard() {
  const PROTECTED = ['main', 'master', 'develop'];

  return async (input) => {
    if (input.tool_name !== 'Bash') return undefined;

    const cmd = input.tool_input?.command || '';
    // Only check git push/merge/rebase commands
    if (!/\bgit\s+(push|merge|rebase)\b/.test(cmd)) return undefined;

    // Check current branch
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
      }).toString().trim();

      if (PROTECTED.includes(branch)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `[vela-pipeline] Git operation blocked on protected branch: ${branch}`,
          },
        };
      }
    } catch (_e) {
      // Not a git repo or git not available — allow
    }

    return undefined;
  };
}

// ═══════════════════════════════════════════════════════════
//  Step Mode → SDK Options Mapping
// ═══════════════════════════════════════════════════════════

/**
 * Map a pipeline step's mode to SDK query options.
 *
 * Modes (from pipeline.json):
 *   read      — Read-only exploration (research, plan-check, verify)
 *   write     — Write via Write/Edit tools, no Bash (plan)
 *   readwrite — Full access (execute)
 *
 * All modes use bypassPermissions (D029) for non-interactive execution.
 *
 * @param {string} mode - 'read', 'write', or 'readwrite'
 * @returns {Object} SDK query options fragment { tools, disallowedTools, hooks }
 */
function buildModeOptions(mode) {
  const sensitiveGuard = createSensitiveFileGuard();
  const secretGuard = createSecretGuard();
  const branchGuard = createProtectedBranchGuard();
  const bashGuard = createBashGuard(mode);

  // Build PreToolUse hooks array
  const preToolUseHooks = [
    { hooks: [sensitiveGuard] },         // Always active: sensitive file guard
    { hooks: [branchGuard] },            // Always active: protected branch guard
  ];

  if (bashGuard) {
    preToolUseHooks.push({ matcher: 'Bash', hooks: [bashGuard] });
  }

  const hooks = {
    PreToolUse: preToolUseHooks,
    PostToolUse: [{ hooks: [secretGuard] }],
  };

  switch (mode) {
    case 'read':
      return {
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch'],
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
        hooks,
      };

    case 'write':
      return {
        tools: ['Read', 'Grep', 'Glob', 'Write'],
        disallowedTools: ['Edit', 'Bash', 'NotebookEdit'],
        hooks,
      };

    case 'readwrite':
      return {
        // No tools restriction — all available
        disallowedTools: [],
        hooks,
      };

    default:
      // Unknown mode — default to read-only
      return {
        tools: ['Read', 'Grep', 'Glob'],
        disallowedTools: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
        hooks,
      };
  }
}

// ═══════════════════════════════════════════════════════════
//  System Prompt Loading
// ═══════════════════════════════════════════════════════════

/**
 * Load agent system prompt from the agents directory.
 * Falls back to a minimal prompt if the file doesn't exist.
 *
 * @param {string} actor - Agent role (e.g., 'researcher', 'planner', 'executor', 'reviewer')
 * @returns {string} System prompt content
 */
function loadAgentPrompt(actor) {
  // Map step actors to agent markdown files
  const actorMap = {
    researcher: 'researcher.md',
    planner: 'planner.md',
    executor: 'executor.md',
    reviewer: 'reviewer.md',
    pm: 'vela-pm.md',
    agent: null, // Generic — no specific prompt
    user: null,  // Human step — no agent prompt needed
  };

  const filename = actorMap[actor];
  if (!filename) return '';

  // Try project-local agents directory first, then scripts/agents
  const localPath = path.join(AGENTS_DIR, filename);
  const scriptsPath = path.join(CWD, 'scripts', 'agents', filename);

  let promptPath = null;
  if (fs.existsSync(localPath)) {
    promptPath = localPath;
  } else if (fs.existsSync(scriptsPath)) {
    promptPath = scriptsPath;
  }

  if (!promptPath) {
    return `You are a ${actor} agent. Follow the instructions in the prompt carefully.`;
  }

  try {
    return fs.readFileSync(promptPath, 'utf-8');
  } catch (_e) {
    return `You are a ${actor} agent. Follow the instructions in the prompt carefully.`;
  }
}

// ═══════════════════════════════════════════════════════════
//  Engine CLI Bridge
// ═══════════════════════════════════════════════════════════

/**
 * Execute a vela-engine.js command and return parsed JSON result.
 *
 * @param {string[]} engineArgs - Arguments for vela-engine.js
 * @returns {Object} Parsed JSON output from the engine
 */
function engine(engineArgs) {
  try {
    const result = execFileSync('node', [ENGINE_PATH, ...engineArgs], {
      cwd: CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      env: { ...process.env },
    });
    return JSON.parse(result.toString());
  } catch (err) {
    // Engine might output JSON even on non-zero exit
    const stdout = err.stdout ? err.stdout.toString() : '';
    if (stdout) {
      try { return JSON.parse(stdout); } catch (_e) {}
    }
    return { ok: false, error: err.message || 'Engine command failed' };
  }
}

// ═══════════════════════════════════════════════════════════
//  Step Runner
// ═══════════════════════════════════════════════════════════

/**
 * Model selection per actor/step role.
 * Maps step characteristics to appropriate models.
 */
const MODEL_MAP = {
  researcher: MODEL_VERSIONS.SONNET_NEW,   // Sonnet for research analysis
  planner: MODEL_VERSIONS.SONNET_NEW,      // Sonnet for planning
  executor: MODEL_VERSIONS.SONNET_NEW,     // Sonnet for implementation
  reviewer: MODEL_VERSIONS.SONNET_NEW,     // Sonnet for initial review
};

const BUDGET_MAP = {
  researcher: 0.30,
  planner: 0.50,
  executor: 1.00,
  reviewer: 0.50,
};

const TURNS_MAP = {
  researcher: 15,
  planner: 15,
  executor: 25,
  reviewer: 10,
};

/**
 * Build the user prompt for a specific pipeline step.
 *
 * @param {Object} stepDef - Step definition from pipeline.json
 * @param {Object} state - Current pipeline state
 * @param {string} artifactDir - Path to artifact directory
 * @returns {string} User prompt for the SDK agent
 */
function buildStepPrompt(stepDef, state, artifactDir) {
  const request = state.request;
  const stepId = stepDef.id;

  switch (stepId) {
    case 'research':
      return [
        `## 작업 요청\n${request}`,
        '',
        `## 지시사항`,
        `프로젝트를 분석하여 research.md를 작성하라.`,
        `- 프로젝트 구조, 기술 스택, 아키텍처를 파악한다`,
        `- 작업 요청과 관련된 코드를 집중 분석한다`,
        `- 경쟁가설 디버깅 절차를 적용한다`,
        `- 분석 결과를 research.md에 작성한다`,
        '',
        `## 출력`,
        `${artifactDir}/research.md 파일을 작성하라.`,
      ].join('\n');

    case 'plan':
      return [
        `## 작업 요청\n${request}`,
        '',
        `## 선행 분석`,
        `${artifactDir}/research.md를 먼저 읽어라.`,
        '',
        `## 지시사항`,
        `research.md를 기반으로 구체적 구현 계획(plan.md)을 작성하라.`,
        `plan.md에는 반드시 다음 섹션을 포함한다:`,
        `- ## Architecture — 레이어 구조, 의존성 방향, 모듈 분리 설계 (200자 이상)`,
        `- ## Class Specification — 인터페이스, 메서드 시그니처, 타입 (200자 이상)`,
        `- ## Test Strategy — 테스트 계획, 테스트 케이스 (200자 이상)`,
        '',
        `## 출력`,
        `${artifactDir}/plan.md 파일을 작성하라.`,
      ].join('\n');

    case 'execute':
      return [
        `## 작업 요청\n${request}`,
        '',
        `## 구현 계획`,
        `${artifactDir}/plan.md를 먼저 읽어라.`,
        '',
        `## 지시사항`,
        `plan.md의 Class Specification에 따라 코드를 구현하라.`,
        `TDD 순서(test → implement → refactor)를 따른다.`,
        `구현 완료 후 ${artifactDir}/task-summary.md를 작성하라.`,
        '',
        `## 출력`,
        `- 소스 코드 구현`,
        `- ${artifactDir}/task-summary.md`,
      ].join('\n');

    case 'verify':
      return [
        `## 작업 요청\n${request}`,
        '',
        `## 지시사항`,
        `구현된 코드를 검증하라.`,
        `- 테스트 실행 (npm test, pytest 등)`,
        `- 린트/타입 체크`,
        `- 결과를 ${artifactDir}/verification.md에 작성`,
        '',
        `## 출력`,
        `${artifactDir}/verification.md 파일을 작성하라.`,
      ].join('\n');

    default:
      return `## 작업 요청\n${request}\n\n현재 단계: ${stepDef.name}. 지시에 따라 작업하라.`;
  }
}

/**
 * Execute a single pipeline step using SDK query().
 *
 * @param {Object} stepDef - Step definition from pipeline.json
 * @param {Object} state - Current pipeline state
 * @returns {Promise<Object>} Step result { ok, stepId, result?, error?, cost? }
 */
async function runStep(stepDef, state) {
  const artifactDir = state._artifactDir;
  const mode = stepDef.mode || 'read';
  const workerRole = (stepDef.team && stepDef.team.worker_role) || stepDef.actor || 'agent';

  // Determine the actor for prompt loading
  const actor = workerRole === 'agent' ? stepDef.actor : workerRole;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Step: ${stepDef.name} (${stepDef.id})`);
  console.log(`  Mode: ${mode} | Actor: ${actor}`);
  console.log(`${'─'.repeat(60)}\n`);

  // Build SDK options from mode
  const modeOptions = buildModeOptions(mode);

  // Load system prompt
  const systemPrompt = loadAgentPrompt(actor);

  // Build user prompt
  const userPrompt = buildStepPrompt(stepDef, state, artifactDir);

  // Select model and budget
  const model = MODEL_MAP[actor] || MODEL_VERSIONS.SONNET_NEW;
  const maxBudgetUsd = BUDGET_MAP[actor] || 0.50;
  const maxTurns = TURNS_MAP[actor] || 15;

  // Track used tools for observability
  const usedTools = [];
  const deniedTools = [];

  // Add tool tracking PostToolUse hook
  const trackingHook = async (input) => {
    usedTools.push(input.tool_name);
    return { continue: true };
  };

  // Merge tracking hook with mode hooks
  const hooks = { ...modeOptions.hooks };
  if (hooks.PostToolUse) {
    hooks.PostToolUse = [...hooks.PostToolUse, { hooks: [trackingHook] }];
  } else {
    hooks.PostToolUse = [{ hooks: [trackingHook] }];
  }

  // Track denied tools via PreToolUse wrapper
  const originalPreToolUse = hooks.PreToolUse || [];
  const denyTracker = async (input) => {
    // This runs first to track, but doesn't decide — real guards decide
    return undefined;
  };
  // We track denials by wrapping existing hooks
  const wrappedPreToolUse = originalPreToolUse.map(hookEntry => {
    const originalHooks = hookEntry.hooks || [];
    return {
      ...hookEntry,
      hooks: originalHooks.map(hookFn => {
        return async (...args) => {
          const result = await hookFn(...args);
          if (result && result.hookSpecificOutput &&
              result.hookSpecificOutput.permissionDecision === 'deny') {
            deniedTools.push({
              tool: args[0]?.tool_name,
              reason: result.hookSpecificOutput.permissionDecisionReason
            });
          }
          return result;
        };
      }),
    };
  });
  hooks.PreToolUse = wrappedPreToolUse;

  // Execute SDK query
  const startMs = Date.now();

  const sdkResult = await runSdkAgent({
    prompt: userPrompt,
    model,
    cwd: CWD,
    systemPrompt,
    maxTurns,
    maxBudgetUsd,
    allowedTools: modeOptions.tools,
    disallowedTools: modeOptions.disallowedTools,
    hooks,
  });

  const durationMs = Date.now() - startMs;

  // Log result summary
  console.log(`\n  Result: ${sdkResult.ok ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`  Cost: $${(sdkResult.cost || 0).toFixed(4)}`);
  console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Tools used: [${[...new Set(usedTools)].join(', ')}]`);
  if (deniedTools.length > 0) {
    console.log(`  Tools denied: ${deniedTools.length} denial(s)`);
  }

  return {
    ok: sdkResult.ok,
    stepId: stepDef.id,
    result: sdkResult.result,
    error: sdkResult.error,
    cost: sdkResult.cost || 0,
    durationMs,
    toolsUsed: [...new Set(usedTools)],
    toolsDenied: deniedTools,
    numTurns: sdkResult.numTurns,
  };
}

// ═══════════════════════════════════════════════════════════
//  Exit Gate Checker
// ═══════════════════════════════════════════════════════════

/**
 * Check if a step's exit gate is met.
 * Delegates to vela-engine.js transition which internally checks gates.
 * Returns { passed, missing } for local pre-check.
 *
 * @param {Object} stepDef - Step definition from pipeline.json
 * @param {string} artifactDir - Path to artifact directory
 * @returns {Object} { passed: boolean, missing: string[] }
 */
function checkLocalGate(stepDef, artifactDir) {
  if (!stepDef.exit_gate || stepDef.exit_gate.length === 0) {
    return { passed: true, missing: [] };
  }

  const missing = [];
  for (const gate of stepDef.exit_gate) {
    switch (gate) {
      case 'research_md_exists':
        if (!fs.existsSync(path.join(artifactDir, 'research.md'))) missing.push(gate);
        break;
      case 'plan_md_exists':
        if (!fs.existsSync(path.join(artifactDir, 'plan.md'))) missing.push(gate);
        break;
      case 'plan_check_pass':
        if (!fs.existsSync(path.join(artifactDir, 'plan-check.md'))) missing.push(gate);
        break;
      case 'implementation_complete':
        if (!fs.existsSync(path.join(artifactDir, 'task-summary.md'))) missing.push(gate);
        break;
      case 'verification_md_exists':
        if (!fs.existsSync(path.join(artifactDir, 'verification.md')) &&
            !fs.existsSync(path.join(artifactDir, 'verify.md'))) {
          missing.push(gate);
        }
        break;
      // Gates handled by engine (approval, git, hmac) — skip local check
      default:
        break;
    }
  }

  return { passed: missing.length === 0, missing };
}

// ═══════════════════════════════════════════════════════════
//  Review Step — SDK Review with Retry
// ═══════════════════════════════════════════════════════════

/**
 * Run SDK review for a step and handle approve/reject loop.
 *
 * @param {Object} stepDef - Step definition requiring review
 * @param {Object} state - Current pipeline state
 * @param {number} maxRevisions - Maximum review iterations
 * @returns {Promise<Object>} Review result
 */
async function runReviewLoop(stepDef, state, maxRevisions) {
  const artifactDir = state._artifactDir;
  const { sdkReview } = require('../shared/sdk-reviewer.js');

  for (let attempt = 1; attempt <= maxRevisions; attempt++) {
    console.log(`\n  📝 Review attempt ${attempt}/${maxRevisions}...`);

    const reviewResult = await sdkReview({
      step: stepDef.id,
      artifactDir,
      cwd: CWD,
    });

    if (!reviewResult.ok) {
      console.log(`  ❌ Review error: ${reviewResult.error}`);
      if (attempt >= maxRevisions) {
        return { ok: false, error: 'review_failed', details: reviewResult.error, attempts: attempt };
      }
      continue;
    }

    console.log(`  📊 Review score: ${reviewResult.score}/25 (${reviewResult.verdict})`);

    if (reviewResult.verdict === 'approve') {
      // Write approval artifact for gate check
      const approvalPath = path.join(artifactDir, `approval-${stepDef.id}.json`);
      const approval = {
        decision: 'approve',
        score: reviewResult.score,
        stage: reviewResult.stage,
        created_at: new Date().toISOString(),
      };
      fs.writeFileSync(approvalPath, JSON.stringify(approval, null, 2));
      console.log(`  ✅ Approved (score: ${reviewResult.score}/25)`);

      return { ok: true, verdict: 'approve', score: reviewResult.score, attempts: attempt };
    }

    // Rejected — record and potentially retry the step
    console.log(`  ⚠️ Rejected (score: ${reviewResult.score}/25)`);
    engine(['record', 'reject', '--summary', `Review rejected: ${reviewResult.score}/25`]);

    if (attempt >= maxRevisions) {
      return { ok: false, verdict: 'reject', score: reviewResult.score, attempts: attempt };
    }

    // Re-run the execution step before next review
    console.log(`  🔄 Re-executing step after rejection...`);
    const rerunResult = await runStep(stepDef, state);
    if (!rerunResult.ok) {
      return { ok: false, error: 're-execution_failed', details: rerunResult.error, attempts: attempt };
    }
  }

  return { ok: false, error: 'max_revisions_reached', attempts: maxRevisions };
}

// ═══════════════════════════════════════════════════════════
//  Master Pipeline Loop
// ═══════════════════════════════════════════════════════════

/**
 * Run the full pipeline from init to completion.
 *
 * @param {string} request - User's task description
 * @param {string} scale - Pipeline scale (small/medium/large)
 * @param {string} type - Pipeline type (code/code-bug/code-refactor/docs)
 * @returns {Promise<void>}
 */
async function runPipeline(request, scale, type) {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Vela Pipeline Orchestrator');
  console.log(`  Request: ${request}`);
  console.log(`  Scale: ${scale} | Type: ${type}`);
  console.log('═══════════════════════════════════════════════════');

  // Step 1: Initialize pipeline via engine
  const initResult = engine([
    'init', request,
    '--scale', scale,
    '--type', type,
    '--auto'
  ]);

  if (!initResult.ok) {
    console.error(`❌ Init failed: ${initResult.error}`);
    if (initResult.hint) console.error(`   Hint: ${initResult.hint}`);
    process.exit(1);
  }

  console.log(`\n✅ Pipeline initialized: ${initResult.pipeline_type}`);
  console.log(`   Steps: ${initResult.steps.map(s => s.id).join(' → ')}`);
  console.log(`   Artifact dir: ${initResult.artifact_dir}\n`);

  // Load pipeline definition for step details
  const pipelineDef = loadPipelineDefinition();
  if (!pipelineDef) {
    console.error('❌ Pipeline definition not found.');
    process.exit(1);
  }

  const steps = resolveSteps(pipelineDef, initResult.pipeline_type);

  // Track total cost
  let totalCost = 0;
  const stepResults = [];

  // Step 2: Execute each step sequentially
  for (let i = 0; i < steps.length; i++) {
    const stepDef = steps[i];

    // Refresh state before each step
    const state = getActiveState();
    if (!state) {
      console.error('❌ Pipeline state lost during execution.');
      process.exit(1);
    }

    // Skip steps that are already completed
    if (state.completed_steps && state.completed_steps.includes(stepDef.id)) {
      console.log(`\n⏭️  Skipping completed step: ${stepDef.name}`);
      continue;
    }

    // Skip steps not matching current state
    if (state.current_step !== stepDef.id) {
      continue;
    }

    // Handle human/PM steps — auto-advance
    if (stepDef.actor === 'user' || stepDef.actor === 'pm') {
      console.log(`\n⏩ Auto-advancing PM/user step: ${stepDef.name}`);

      // For init step, already done above
      if (stepDef.id === 'init') {
        engine(['record', 'pass', '--summary', 'Init completed by orchestrator']);
        const transResult = engine(['transition']);
        if (!transResult.ok) {
          console.error(`❌ Transition failed after init: ${transResult.error}`);
          process.exit(1);
        }
        continue;
      }

      // Branch step — auto create
      if (stepDef.id === 'branch') {
        const branchResult = engine(['branch', '--mode', 'auto']);
        console.log(`   Branch: ${branchResult.branch || 'skipped'}`);
        engine(['record', 'pass', '--summary', `Branch: ${branchResult.branch || 'skipped'}`]);
        const transResult = engine(['transition']);
        if (!transResult.ok && !transResult.completed) {
          console.error(`❌ Transition failed after branch: ${transResult.error}`);
          // Non-fatal — gate might not require branch
        }
        continue;
      }

      // Checkpoint — auto-approve in auto mode
      if (stepDef.id === 'checkpoint') {
        engine(['record', 'pass', '--summary', 'Auto-approved checkpoint']);
        const transResult = engine(['transition']);
        if (!transResult.ok) {
          console.error(`❌ Transition failed at checkpoint: ${transResult.error}`);
          process.exit(1);
        }
        continue;
      }

      // Commit step
      if (stepDef.id === 'commit') {
        const commitResult = engine(['commit']);
        console.log(`   Commit: ${commitResult.hash || commitResult.action || 'done'}`);
        engine(['record', 'pass', '--summary', `Committed: ${commitResult.hash || 'no changes'}`]);
        const transResult = engine(['transition']);
        if (transResult.ok || transResult.completed) continue;
        // Non-fatal if gate fails
        continue;
      }

      // Finalize step
      if (stepDef.id === 'finalize') {
        // Generate report
        const reportPath = path.join(state._artifactDir, 'report.md');
        const reportContent = generateReport(state, stepResults);
        fs.writeFileSync(reportPath, reportContent);
        console.log(`   Report written: ${reportPath}`);
        engine(['record', 'pass', '--summary', 'Pipeline report generated']);
        const transResult = engine(['transition']);
        if (transResult.ok || transResult.completed) {
          console.log('\n✅ Pipeline completed successfully!');
        }
        continue;
      }

      // Generic PM step — record and advance
      engine(['record', 'pass', '--summary', `Auto-advanced: ${stepDef.name}`]);
      engine(['transition']);
      continue;
    }

    // Agent steps — run SDK query
    const stepResult = await runStep(stepDef, state);
    stepResults.push({ step: stepDef.id, ...stepResult });
    totalCost += stepResult.cost;

    if (!stepResult.ok) {
      console.error(`\n❌ Step "${stepDef.name}" failed: ${stepResult.error}`);
      engine(['record', 'fail', '--summary', `Failed: ${stepResult.error}`]);
      // Don't exit — try to continue or handle gracefully
      continue;
    }

    // Record success
    engine(['record', 'pass', '--summary', `Completed: ${stepDef.name}`]);

    // Check if step requires review
    if (stepDef.team && stepDef.team.reviewer_role) {
      const maxRev = stepDef.max_revisions || 3;
      const reviewResult = await runReviewLoop(stepDef, state, maxRev);
      if (reviewResult.cost) totalCost += reviewResult.cost;

      if (!reviewResult.ok) {
        console.error(`\n❌ Review failed for "${stepDef.name}": ${reviewResult.error || reviewResult.verdict}`);
        // Continue — the engine will block transition if gates aren't met
      }
    }

    // Check local exit gate
    const gateCheck = checkLocalGate(stepDef, state._artifactDir);
    if (!gateCheck.passed) {
      console.log(`\n⚠️  Exit gate not met for "${stepDef.name}": ${gateCheck.missing.join(', ')}`);
      // Try transition anyway — engine has more complete gate checking
    }

    // Advance to next step
    const transResult = engine(['transition']);
    if (transResult.completed) {
      console.log('\n✅ Pipeline completed successfully!');
      break;
    }
    if (!transResult.ok) {
      console.log(`\n⚠️  Transition blocked: ${transResult.error || transResult.message}`);
      if (transResult.missing) {
        console.log(`   Missing: ${transResult.missing.join(', ')}`);
      }
      // Don't exit — might be recoverable in next iteration
    }
  }

  // Final summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Pipeline Summary');
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  Steps completed: ${stepResults.filter(r => r.ok).length}/${stepResults.length}`);
  console.log('═══════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════
//  Report Generator
// ═══════════════════════════════════════════════════════════

/**
 * Generate a pipeline completion report.
 *
 * @param {Object} state - Final pipeline state
 * @param {Array} stepResults - Array of step results
 * @returns {string} Markdown report content
 */
function generateReport(state, stepResults) {
  const now = new Date().toISOString();
  const totalCost = stepResults.reduce((sum, r) => sum + (r.cost || 0), 0);

  let report = `# Pipeline Report\n\n`;
  report += `**Request:** ${state.request}\n`;
  report += `**Pipeline:** ${state.pipeline_type}\n`;
  report += `**Scale:** ${state.scale}\n`;
  report += `**Created:** ${state.created_at}\n`;
  report += `**Completed:** ${now}\n`;
  report += `**Total Cost:** $${totalCost.toFixed(4)}\n\n`;

  report += `## Step Results\n\n`;
  report += `| Step | Status | Cost | Duration | Tools Used |\n`;
  report += `|------|--------|------|----------|------------|\n`;

  for (const r of stepResults) {
    const status = r.ok ? '✅ Pass' : '❌ Fail';
    const cost = `$${(r.cost || 0).toFixed(4)}`;
    const duration = `${((r.durationMs || 0) / 1000).toFixed(1)}s`;
    const tools = (r.toolsUsed || []).join(', ') || '-';
    report += `| ${r.step} | ${status} | ${cost} | ${duration} | ${tools} |\n`;
  }

  if (state.git) {
    report += `\n## Git\n\n`;
    report += `- Branch: ${state.git.pipeline_branch || state.git.current_branch || '-'}\n`;
    report += `- Commit: ${state.git.commit_hash || '-'}\n`;
  }

  return report;
}

// ═══════════════════════════════════════════════════════════
//  Helpers (duplicated from engine for independence)
// ═══════════════════════════════════════════════════════════

function loadPipelineDefinition() {
  const pipelinePath = path.join(TEMPLATES_DIR, 'pipeline.json');
  if (!fs.existsSync(pipelinePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  } catch (_e) {
    return null;
  }
}

function resolveSteps(pipelineDef, pipelineType) {
  if (!pipelineDef) return [];
  const pipeline = pipelineDef.pipelines[pipelineType || 'standard'];
  if (!pipeline) return [];

  let steps = pipeline.steps;
  if (pipeline.inherits && pipeline.steps_only) {
    const parent = pipelineDef.pipelines[pipeline.inherits];
    if (parent) {
      steps = parent.steps.filter(s => pipeline.steps_only.includes(s.id));
      if (pipeline.overrides) {
        steps = steps.map(s => pipeline.overrides[s.id] ? { ...s, ...pipeline.overrides[s.id] } : s);
      }
    }
  }

  return steps;
}

/**
 * Get the active pipeline state (from engine CLI bridge).
 * Uses engine 'state' command for canonical state, reads full state from artifact_dir.
 */
function getActiveState() {
  const result = engine(['state']);
  if (!result.ok || !result.active) return null;
  if (!result.artifact_dir) return null;

  const statePath = path.join(result.artifact_dir, 'pipeline-state.json');
  if (!fs.existsSync(statePath)) return null;

  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state._path = statePath;
    state._artifactDir = result.artifact_dir;
    return state;
  } catch (_e) {
    return null;
  }
}

function getFlag(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// ═══════════════════════════════════════════════════════════
//  CLI Commands
// ═══════════════════════════════════════════════════════════

async function cmdRun() {
  const request = args[1];
  if (!request) {
    console.error('Usage: vela-pipeline run <request> --scale <small|medium|large> [--type <type>]');
    process.exit(1);
  }

  const scale = getFlag('--scale');
  if (!scale) {
    console.error('Error: --scale required (small, medium, or large)');
    process.exit(1);
  }

  const type = getFlag('--type') || 'code';

  await runPipeline(request, scale, type);
}

function cmdStatus() {
  const result = engine(['state']);
  output(result);
}

function cmdCancel() {
  const result = engine(['cancel']);
  output(result);
}

function showHelp() {
  console.log(`
Vela Pipeline Orchestrator — SDK-based Pipeline Execution

Usage:
  node vela-pipeline.js run <request> --scale <s|m|l> [--type <type>]
  node vela-pipeline.js status
  node vela-pipeline.js cancel
  node vela-pipeline.js --help

Commands:
  run       Run the full pipeline for a task
  status    Show current pipeline status
  cancel    Cancel the active pipeline

Options:
  --scale   Pipeline scale: small, medium, large (required for run)
  --type    Task type: code, code-bug, code-refactor, docs (default: code)
  --help    Show this help message

Examples:
  node vela-pipeline.js run "Add user authentication" --scale large
  node vela-pipeline.js run "Fix typo in README" --scale small --type docs
  node vela-pipeline.js status
  node vela-pipeline.js cancel
`);
}

// ─── Main Entry Point ───

async function main() {
  if (hasFlag('--help') || hasFlag('-h') || !command) {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case 'run':
      await cmdRun();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'cancel':
      cmdCancel();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

// ─── Module Exports (for testing) ───
module.exports = {
  createBashGuard,
  createSensitiveFileGuard,
  createSecretGuard,
  createProtectedBranchGuard,
  buildModeOptions,
  loadAgentPrompt,
  buildStepPrompt,
  checkLocalGate,
  runStep,
  runReviewLoop,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
