/**
 * Vela SDK Sprint Planner
 * Sonnet single-pass project analysis and sprint decomposition module.
 * Analyzes a project, decomposes user request into structured slices,
 * and persists the result via sprint-manager.createSprint().
 *
 * Exports: sprintPlan({ request, cwd })
 *
 * Design decisions:
 * - settingSources: [] passed through runSdkAgent (D014 — hook isolation)
 * - System prompt inlines all decomposition rules as literal strings
 *   because SDK agents cannot read project files
 * - Dual extraction: structuredOutput primary, regex/JSON fallback (K032)
 * - Post-processing normalizes slice IDs to slice-NN format
 * - Uses Sonnet model — analysis task, not judgment (D056)
 * - Follows K011/K060/K062 CJS module skeleton pattern
 */

'use strict';

const { runSdkAgent } = require('./sdk-runner');
const { MODEL_VERSIONS } = require('./constants');
const { createSprint } = require('./sprint-manager');

// ─── Constants ───
const SONNET_MODEL = MODEL_VERSIONS.SONNET;

// ─── Structured output schema (K011 — module-local) ───
const SPRINT_PLANNER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Sprint title — concise summary of the work',
    },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Slice identifier in slice-NN format (e.g. slice-01)',
          },
          title: {
            type: 'string',
            description: 'Short descriptive title for the slice',
          },
          description: {
            type: 'string',
            description: 'What this slice accomplishes — specific and actionable',
          },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of slices this depends on (empty if independent)',
          },
        },
        required: ['id', 'title', 'description', 'depends_on'],
      },
      description: 'Ordered list of slices (1-5), risk-ordered, DAG-valid',
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of decomposition rationale',
    },
  },
  required: ['title', 'slices', 'reasoning'],
};

// ─── Self-contained system prompt ───
// SDK agents run with settingSources: [] and cannot read project files.
// The entire sprint planning context must be in the system prompt.
const SYSTEM_PROMPT = `# Sprint Planner Agent

당신은 프로젝트 분석 및 작업 분해 에이전트입니다.
사용자의 요청을 분석하고, 프로젝트 상태를 파악한 뒤,
구조화된 Sprint 슬라이스로 분해합니다.

## 작업 절차

1. **프로젝트 분석** — Read, Glob, Grep, Bash 도구를 사용하여:
   - 프로젝트 구조 파악 (디렉토리 레이아웃, 주요 파일)
   - 기존 코드 패턴 및 컨벤션 이해
   - 기술 스택 확인 (언어, 프레임워크, 빌드 도구)
   - 관련 기존 코드 식별

2. **요청 맥락화** — 사용자 요청을 프로젝트 현재 상태와 연결:
   - 요청이 기존 코드에 어떤 영향을 미치는지 분석
   - 필요한 변경 범위 파악
   - 의존성과 위험 요소 식별

3. **슬라이스 분해** — 요청을 실행 가능한 단위로 분해:
   - 각 슬라이스는 독립적으로 데모 가능한 증분(demoable increment)
   - 위험도 순서로 정렬 (가장 위험한 것을 먼저)
   - 의존성 DAG 구성 (순환 참조 금지)

## 슬라이스 설계 원칙

- **1-5개 슬라이스** — 너무 잘게 쪼개지 않는다
- **위험 순서** — 불확실성이 큰 슬라이스를 앞에 배치
- **DAG 유효성** — 순환 의존성 금지. depends_on은 반드시 자신보다 앞에 정의된 슬라이스만 참조
- **각 슬라이스는 독립 실행 가능** — 의존 슬라이스 완료 후 단독 실행
- **구체적 설명** — description은 "무엇을 한다"가 명확해야 한다
- **ID 형식** — slice-01, slice-02, ... (slice-NN 형식)

## 출력 형식

반드시 다음 JSON 구조로 응답:

{
  "title": "Sprint 제목 — 작업 전체를 요약하는 간결한 제목",
  "slices": [
    {
      "id": "slice-01",
      "title": "첫 번째 슬라이스 제목",
      "description": "이 슬라이스가 달성하는 구체적 내용",
      "depends_on": []
    },
    {
      "id": "slice-02",
      "title": "두 번째 슬라이스 제목",
      "description": "이 슬라이스가 달성하는 구체적 내용",
      "depends_on": ["slice-01"]
    }
  ],
  "reasoning": "이 분해의 근거 — 왜 이 순서인지, 위험 요소는 무엇인지"
}

## 절대 위반 금지

1. 코드를 수정하지 않는다 — 분석과 계획만 수행
2. 5개를 초과하는 슬라이스를 생성하지 않는다
3. 순환 의존성을 만들지 않는다
4. slice-NN 형식 외의 ID를 사용하지 않는다
`;

/**
 * Normalize slice ID to slice-NN format.
 * Handles: "slice-1" → "slice-01", "1" → "slice-01", "s01" → "slice-01", etc.
 * @param {string} id - Raw slice ID from agent
 * @param {number} index - 0-based position in array (fallback)
 * @returns {string} Normalized ID in slice-NN format
 */
function normalizeSliceId(id, index) {
  if (!id || typeof id !== 'string') {
    return `slice-${String(index + 1).padStart(2, '0')}`;
  }

  // Already in correct format: slice-01, slice-02
  const exactMatch = id.match(/^slice-(\d+)$/);
  if (exactMatch) {
    return `slice-${String(parseInt(exactMatch[1], 10)).padStart(2, '0')}`;
  }

  // Extract numeric part from various formats
  const numMatch = id.match(/(\d+)/);
  if (numMatch) {
    return `slice-${String(parseInt(numMatch[1], 10)).padStart(2, '0')}`;
  }

  // Fallback: use position
  return `slice-${String(index + 1).padStart(2, '0')}`;
}

/**
 * Check for dependency cycles using Kahn's algorithm.
 * @param {Array<{ id: string, depends_on: string[] }>} slices
 * @returns {boolean} true if no cycles detected
 */
function validateNoCycles(slices) {
  const ids = slices.map((s) => s.id);
  const idSet = new Set(ids);
  const inDegree = new Map();
  const adjacency = new Map();

  for (const id of ids) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const slice of slices) {
    for (const dep of slice.depends_on) {
      if (!idSet.has(dep)) continue; // skip invalid refs — let validation catch those
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

  return processed === ids.length;
}

/**
 * Extract sprint plan from agent result using dual extraction (K032).
 * Primary: structuredOutput → Fallback: regex/JSON parse from text.
 *
 * @param {Object} agentResult - Result from runSdkAgent
 * @returns {{ title: string, slices: Array, reasoning: string }|null}
 */
function extractPlan(agentResult) {
  // ─── Primary: structuredOutput (typed path) ───
  const so = agentResult.structuredOutput;
  if (so && Array.isArray(so.slices) && so.slices.length > 0) {
    return {
      title: so.title || '',
      slices: so.slices,
      reasoning: so.reasoning || '',
    };
  }

  // ─── Fallback: regex/JSON parse from result text ───
  const text = agentResult.result || '';
  if (!text) return null;

  // Try ```json code block first
  const codeBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (Array.isArray(parsed.slices) && parsed.slices.length > 0) {
        return {
          title: parsed.title || '',
          slices: parsed.slices,
          reasoning: parsed.reasoning || '',
        };
      }
    } catch {
      // parse failed — try next strategy
    }
  }

  // Try bare JSON object
  const jsonMatch = text.match(/\{[\s\S]*"slices"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.slices) && parsed.slices.length > 0) {
        return {
          title: parsed.title || '',
          slices: parsed.slices,
          reasoning: parsed.reasoning || '',
        };
      }
    } catch {
      // parse failed
    }
  }

  return null;
}

/**
 * Plan a sprint by analyzing a project and decomposing a user request
 * into structured slices. Persists the result via sprint-manager.createSprint().
 *
 * Follows K011/K060/K062 CJS module skeleton:
 * - runSdkAgent delegation
 * - settingSources: [] for hook isolation (D014)
 * - Dual extraction (K032): structuredOutput → regex/JSON fallback
 * - Normalized return object { ok, error, cost, numTurns, durationMs, ... }
 *
 * @param {Object} opts
 * @param {string} opts.request - User request to decompose
 * @param {string} opts.cwd - Project root working directory
 * @returns {Promise<Object>} Result:
 *   Success: { ok: true, sprintId, title, slices, reasoning, cost, numTurns, durationMs }
 *   Failure: { ok: false, error: string, cost?: number, durationMs?: number }
 *
 *   Error codes:
 *   - invalid_input: empty or non-string request
 *   - sdk_not_available: SDK could not be loaded
 *   - no_slices_extracted: agent responded but extraction failed
 *   - sprint_creation_failed: createSprint() threw
 */
async function sprintPlan(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    return { ok: false, error: 'invalid_input' };
  }

  const { request, cwd } = opts;

  // ─── Validate request ───
  if (!request || typeof request !== 'string' || request.trim().length === 0) {
    return { ok: false, error: 'invalid_input' };
  }

  // ─── Detect project mode ───
  let projectMode = 'exploratory'; // safe default
  try {
    const { detectProjectMode } = require('../cli/vela-pipeline');
    projectMode = detectProjectMode(cwd || process.cwd());
  } catch {
    // detectProjectMode unavailable — use default
  }

  // ─── Build user prompt ───
  const prompt = [
    `## 요청`,
    ``,
    request.trim(),
    ``,
    `## 프로젝트 모드`,
    ``,
    `현재 프로젝트 모드: **${projectMode}**`,
    projectMode === 'bootstrap'
      ? '- 빈 프로젝트입니다. 처음부터 구조를 설계해야 합니다.'
      : '- 기존 코드가 있는 프로젝트입니다. 현재 구조를 파악한 뒤 변경을 계획하세요.',
    ``,
    `## 지시사항`,
    ``,
    `1. 프로젝트를 분석하라 (Read, Glob, Grep, Bash 도구 사용)`,
    `2. 요청을 이해하고 프로젝트 맥락에서 분해하라`,
    `3. 1-5개의 슬라이스로 구성된 Sprint 계획을 JSON으로 출력하라`,
    `4. 각 슬라이스는 독립적으로 데모 가능한 증분이어야 한다`,
    `5. 위험도 순서로 정렬하라 (불확실성이 큰 것을 먼저)`,
  ].join('\n');

  // ─── Call Sonnet via SDK ───
  const agentResult = await runSdkAgent({
    prompt,
    model: SONNET_MODEL,
    cwd: cwd || process.cwd(),
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    maxTurns: 20,
    outputFormat: { type: 'json', schema: SPRINT_PLANNER_OUTPUT_SCHEMA },
    // settingSources: [] is the default in runSdkAgent (D014)
  });

  // ─── SDK unavailable ───
  if (agentResult.error === 'sdk_not_available') {
    return { ok: false, error: 'sdk_not_available' };
  }

  // ─── SDK error ───
  if (!agentResult.ok) {
    return {
      ok: false,
      error: agentResult.error || 'sdk_error',
      details: agentResult.details,
      cost: agentResult.cost || 0,
      durationMs: agentResult.durationMs || 0,
    };
  }

  // ─── Dual extraction (K032) ───
  const plan = extractPlan(agentResult);

  if (!plan || !plan.slices || plan.slices.length === 0) {
    return {
      ok: false,
      error: 'no_slices_extracted',
      cost: agentResult.cost || 0,
      numTurns: agentResult.numTurns || 0,
      durationMs: agentResult.durationMs || 0,
    };
  }

  // ─── Post-process: normalize IDs, validate DAG, strip extras ───
  const normalizedSlices = plan.slices.map((s, i) => {
    const normalizedId = normalizeSliceId(s.id, i);
    return {
      id: normalizedId,
      title: s.title || normalizedId,
      description: s.description || '',
      depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
    };
  });

  // Remap depends_on references to normalized IDs
  const idMapping = new Map();
  plan.slices.forEach((s, i) => {
    idMapping.set(s.id, normalizedSlices[i].id);
  });

  for (const slice of normalizedSlices) {
    slice.depends_on = slice.depends_on
      .map((dep) => idMapping.get(dep) || dep)
      .filter((dep) => normalizedSlices.some((s) => s.id === dep));
  }

  // ─── Validate no cycles ───
  if (!validateNoCycles(normalizedSlices)) {
    // Strip all deps to make it valid rather than failing
    for (const slice of normalizedSlices) {
      slice.depends_on = [];
    }
  }

  // ─── Persist via createSprint ───
  const title = plan.title || request.trim().slice(0, 60);

  let sprintResult;
  try {
    sprintResult = createSprint({
      title,
      request: request.trim(),
      slices: normalizedSlices,
    });
  } catch (err) {
    return {
      ok: false,
      error: 'sprint_creation_failed',
      details: err.message,
      cost: agentResult.cost || 0,
      numTurns: agentResult.numTurns || 0,
      durationMs: agentResult.durationMs || 0,
    };
  }

  return {
    ok: true,
    sprintId: sprintResult.id,
    title,
    slices: normalizedSlices,
    reasoning: plan.reasoning || '',
    cost: agentResult.cost || 0,
    numTurns: agentResult.numTurns || 0,
    durationMs: agentResult.durationMs || 0,
  };
}

module.exports = { sprintPlan };
