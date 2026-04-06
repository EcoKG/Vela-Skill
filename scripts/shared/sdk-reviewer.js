/**
 * Vela SDK Reviewer
 * 3-stage Haiku→Sonnet→Opus review module.
 * Calls runSdkAgent() for each stage — never imports SDK directly.
 *
 * Stage 1 (Haiku): Fast, cheap initial review. Score ≥ 20 → pass, < 15 → Stage 3 (Opus).
 * Borderline (15-19): Escalate to Stage 2 (Sonnet) for deeper analysis.
 * Stage 2 (Sonnet): Deep review. Score ≥ 20 → pass, < 20 → Stage 3 (Opus).
 * Stage 3 (Opus):  Final escalation. Score ≥ 20 → approve + escalated:true, < 20 → reject + escalated:true.
 *
 * Exports: sdkReview({ step, artifactDir, cwd, scale? })
 *
 * Design decisions:
 * - settingSources: [] passed through runSdkAgent (D014 — hook isolation)
 * - System prompt inlines reviewer instructions + scoring rubric as literal strings
 *   because SDK agents cannot read project files
 * - Score regex matches vela-subagent-stop.js patterns for consistency
 * - artifactDir and .vela/state/ assumed to exist (engine creates them)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { runSdkAgent } = require("./sdk-runner");
const { MODEL_VERSIONS } = require("./constants");

// ─── Score regex — matches vela-subagent-stop.js patterns ───
const PRIMARY_SCORE_REGEX = /(총점|총|total\s*score)[^\d]*(\d+)\s*\/\s*25/i;
const FALLBACK_SCORE_REGEX = /\b(\d+)\s*\/\s*25\b/;

const PASS_THRESHOLD = 20;
const FAIL_THRESHOLD = 15;

// ─── Structured output schemas — step-aware (K011 pattern — module-local) ───

// Common issue + review_text portion shared by all schemas
const _COMMON_SCHEMA_FIELDS = {
  total: { type: "number" },
  issues: {
    type: "array",
    items: {
      type: "object",
      properties: {
        severity: {
          type: "string",
          enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
        },
        description: { type: "string" },
      },
      required: ["severity", "description"],
    },
  },
  review_text: { type: "string" },
};

const RESEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: {
        source_coverage: { type: "number" },
        analysis_depth: { type: "number" },
        risk_identification: { type: "number" },
        technology_assessment: { type: "number" },
        actionable_findings: { type: "number" },
      },
      required: [
        "source_coverage",
        "analysis_depth",
        "risk_identification",
        "technology_assessment",
        "actionable_findings",
      ],
    },
    ..._COMMON_SCHEMA_FIELDS,
  },
  required: ["scores", "total", "review_text"],
};

const PLAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: {
        architecture_design: { type: "number" },
        specification_completeness: { type: "number" },
        test_strategy: { type: "number" },
        implementation_feasibility: { type: "number" },
        risk_mitigation: { type: "number" },
      },
      required: [
        "architecture_design",
        "specification_completeness",
        "test_strategy",
        "implementation_feasibility",
        "risk_mitigation",
      ],
    },
    ..._COMMON_SCHEMA_FIELDS,
  },
  required: ["scores", "total", "review_text"],
};

const EXECUTE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: {
        layer_separation: { type: "number" },
        ddd_patterns: { type: "number" },
        solid_principles: { type: "number" },
        test_strategy: { type: "number" },
        specification_completeness: { type: "number" },
      },
      required: [
        "layer_separation",
        "ddd_patterns",
        "solid_principles",
        "test_strategy",
        "specification_completeness",
      ],
    },
    ..._COMMON_SCHEMA_FIELDS,
  },
  required: ["scores", "total", "review_text"],
};

// ─── Stage 3: Opus escalation model + budget ───
const OPUS_MODEL = MODEL_VERSIONS.OPUS;

// ─── Inlined reviewer system prompts — step-aware ───
// SDK agents run with settingSources: [] and cannot read project files.
// The entire reviewer context must be in the system prompt.

// Shared sections reused across all three prompts
const _PROMPT_HEADER = `# Reviewer Agent

이 지시는 **절대적**이다. 예외 없이 따라야 한다.

## 역할
산출물을 독립적으로 평가한다. Worker의 추론 과정은 알 수 없다 — 산출물만 평가한다.
5개 차원 각 X/5, 총 X/25 점수를 매긴다.

## 채점 기준 — 5차원 모두 빠짐없이 평가한다
`;

const _PROMPT_FOOTER = `
## 이슈 심각도
- **CRITICAL**: 근본적 설계 결함 — 반드시 수정 필요
- **HIGH**: 구현 전 수정 필요
- **MEDIUM**: 개선 권장
- **LOW**: 사소한 제안

## 절대 위반 금지
1. 산출물만 평가한다. 프로세스를 평가하지 않는다
2. 엄격하고 비판적으로 평가한다. 관대하게 점수를 주지 않는다
3. review-{step}.md만 작성한다. 소스 코드나 다른 산출물을 수정하지 않는다

## 출력 형식
반드시 마지막에 다음 형식으로 총점을 작성한다:
## Total: XX/25
`;

const RESEARCH_REVIEW_PROMPT =
  _PROMPT_HEADER +
  `
### 1. Source Coverage (X/5)
- 1차/2차 자료원의 폭과 깊이
- 공식 문서, 논문, 실무 사례 등 근거 자료의 다양성
- 출처 명시 여부 및 신뢰도

### 2. Analysis Depth (X/5)
- 표면적 요약이 아닌 심층 분석 여부
- 장단점 비교, 트레이드오프 분석
- 기술적 맥락에서의 해석 품질

### 3. Risk Identification (X/5)
- 기술적·운영적 리스크 식별 범위
- 리스크 심각도 평가의 적절성
- 완화 전략 제안 여부

### 4. Technology Assessment (X/5)
- 기술 선택지 비교 분석의 체계성
- 성숙도, 커뮤니티, 유지보수성 평가
- 프로젝트 맥락에 맞는 적합성 판단

### 5. Actionable Findings (X/5)
- 발견 사항의 실행 가능성
- 구체적 권장 사항 제시 여부
- 후속 단계(plan/execute)에 활용 가능한 형태인지
` +
  _PROMPT_FOOTER;

const PLAN_REVIEW_PROMPT =
  _PROMPT_HEADER +
  `
### 1. Architecture Design (X/5)
- 컴포넌트/모듈 분리 설계의 적절성
- 인터페이스 경계와 의존성 방향
- 확장성과 유지보수성 고려

### 2. Specification Completeness (X/5)
- 필요한 인터페이스/계약 정의의 완전성
- API 시그니처, 파라미터, 반환 타입 명세
- 누락된 중요 추상화나 엣지 케이스

### 3. Test Strategy (X/5)
- 테스트 계획의 포괄성 (unit/integration/e2e)
- 테스트 시나리오의 실질적 검증 가치
- 엣지 케이스와 실패 경로 커버리지

### 4. Implementation Feasibility (X/5)
- 설계의 기술적 실현 가능성
- 기존 코드베이스와의 호환성
- 기술 부채 및 의존성 리스크

### 5. Risk Mitigation (X/5)
- 식별된 리스크에 대한 대응 전략
- 롤백/폴백 계획의 존재 여부
- 단계별 검증 포인트 설정
` +
  _PROMPT_FOOTER;

const EXECUTE_REVIEW_PROMPT =
  _PROMPT_HEADER +
  `
### 1. Layer Separation (X/5)
- Clean Architecture 레이어 분리
- 의존성 방향 (안쪽으로만)
- 도메인 레이어의 외부 의존성 없음

### 2. DDD Patterns (X/5)
- Aggregate Root 식별
- Entity/Value Object 구분
- Repository 인터페이스 위치 (도메인 레이어)
- 도메인 로직이 도메인 레이어에 있는지

### 3. SOLID Principles (X/5)
- SRP: 클래스당 하나의 변경 이유
- OCP: 확장 가능, 수정 불필요
- ISP: 적절한 크기의 인터페이스
- DIP: 추상에 의존, 구체에 의존하지 않음

### 4. Test Strategy (X/5)
- 테스트 케이스의 의미 (존재만이 아닌 실질적 검증)
- unit/integration/e2e 커버리지
- 엣지 케이스

### 5. Specification Completeness (X/5)
- 필요한 클래스/인터페이스 정의 완전성
- 메서드 시그니처 + 파라미터 + 반환 타입
- 누락된 중요 추상화
` +
  _PROMPT_FOOTER;

// ─── Step-aware getters ───

/**
 * Get the appropriate reviewer system prompt for a pipeline step.
 * Unknown steps fall back to EXECUTE (preserves existing behavior).
 * @param {string} step - Pipeline step name (research, plan, execute, etc.)
 * @returns {string}
 */
function getReviewerSystemPrompt(step) {
  const PROMPTS = {
    research: RESEARCH_REVIEW_PROMPT,
    plan: PLAN_REVIEW_PROMPT,
    execute: EXECUTE_REVIEW_PROMPT,
  };
  return PROMPTS[step] || EXECUTE_REVIEW_PROMPT;
}

/**
 * Get the appropriate output schema for a pipeline step.
 * Unknown steps fall back to EXECUTE_OUTPUT_SCHEMA (preserves existing behavior).
 * @param {string} step - Pipeline step name (research, plan, execute, etc.)
 * @returns {Object}
 */
function getOutputSchema(step) {
  const SCHEMAS = {
    research: RESEARCH_OUTPUT_SCHEMA,
    plan: PLAN_OUTPUT_SCHEMA,
    execute: EXECUTE_OUTPUT_SCHEMA,
  };
  return SCHEMAS[step] || EXECUTE_OUTPUT_SCHEMA;
}

/**
 * Parse a review score from agent output text.
 * Returns the numeric score or null if not found.
 * @param {string} text - Agent result text
 * @returns {number|null}
 */
function parseScore(text) {
  if (!text || typeof text !== "string") return null;

  const primaryMatch = text.match(PRIMARY_SCORE_REGEX);
  if (primaryMatch) return parseInt(primaryMatch[2], 10);

  const fallbackMatch = text.match(FALLBACK_SCORE_REGEX);
  if (fallbackMatch) return parseInt(fallbackMatch[1], 10);

  return null;
}

/**
 * Write review markdown artifact.
 * @param {string} artifactDir - Directory to write artifacts to
 * @param {string} step - Pipeline step name
 * @param {string} content - Review content from agent
 */
function writeReviewArtifact(artifactDir, step, content) {
  const filePath = path.join(artifactDir, `review-${step}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Write approval JSON artifact.
 * @param {string} artifactDir - Directory to write artifacts to
 * @param {string} step - Pipeline step name
 * @param {Object} approval - Approval data
 */
function writeApprovalArtifact(artifactDir, step, approval) {
  const filePath = path.join(artifactDir, `approval-${step}.json`);
  fs.writeFileSync(filePath, JSON.stringify(approval, null, 2), "utf8");
}

/**
 * Write escalation.json to .vela/state/.
 * @param {string} cwd - Project root directory
 * @param {number} score - Review score that triggered escalation
 * @param {Object} [extra] - Additional fields (e.g. auto_escalated)
 */
function writeEscalation(cwd, score, extra) {
  try {
    const stateDir = path.join(cwd, ".vela", "state");
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const escalationPath = path.join(stateDir, "escalation.json");
    fs.writeFileSync(
      escalationPath,
      JSON.stringify(
        {
          reason: "reviewer_score_below_threshold",
          score,
          threshold: FAIL_THRESHOLD,
          timestamp: new Date().toISOString(),
          ...(extra || {}),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (e) {
    // Escalation is supplementary — never crash the review result
  }
}

/**
 * Build the review prompt for a given step.
 * @param {string} step - Pipeline step name
 * @param {string|null} priorReview - Prior stage review text (for Stage 2)
 * @returns {string}
 */
function buildReviewPrompt(step, priorReview) {
  let prompt = `다음 파이프라인 단계의 산출물을 리뷰하라: "${step}"\n\n`;
  prompt += `이 단계의 artifacts 디렉토리에 있는 모든 산출물을 읽고 5차원 채점 기준에 따라 평가하라.\n`;

  // Step-specific guidance
  if (step === "research") {
    prompt += `research.md 등 조사 산출물을 중심으로 평가하라. 자료원의 폭, 분석 깊이, 리스크 식별에 집중하라.\n`;
  } else if (step === "plan") {
    prompt += `plan.md 등 설계 문서를 중심으로 평가하라. 아키텍처 설계, 명세 완전성, 구현 가능성에 집중하라.\n`;
  } else {
    prompt += `소스 코드와 테스트를 중심으로 평가하라. 레이어 분리, 설계 패턴, SOLID 원칙 준수에 집중하라.\n`;
  }

  prompt += `반드시 마지막에 "## Total: XX/25" 형식으로 총점을 명시하라.\n`;

  if (priorReview) {
    prompt += `\n--- 이전 Haiku 리뷰 (참고용) ---\n${priorReview}\n--- 이전 리뷰 끝 ---\n`;
    prompt += `\n이전 리뷰를 참고하되, 독립적으로 재평가하라. 점수는 네 판단에 따라 달라질 수 있다.\n`;
  }

  return prompt;
}

/**
 * Run a single review stage via SDK agent.
 * @param {Object} opts
 * @param {string} opts.model - Model identifier
 * @param {string} opts.step - Pipeline step name
 * @param {string} opts.cwd - Working directory
 * @param {string|null} opts.priorReview - Prior review text (Stage 2 only)
 * @returns {Promise<Object>} { ok, result, score, cost, model, durationMs } or { ok: false, error }
 */
async function runReviewStage(opts) {
  const prompt = buildReviewPrompt(opts.step, opts.priorReview);

  const agentOpts = {
    prompt,
    model: opts.model,
    cwd: opts.cwd,
    systemPrompt: getReviewerSystemPrompt(opts.step),
    outputFormat: { type: "json", schema: getOutputSchema(opts.step) },
    // settingSources: [] is set by runSdkAgent internally (D014)
  };

  if (opts.effort != null) agentOpts.effort = opts.effort;
  if (opts.thinking != null) agentOpts.thinking = opts.thinking;

  const agentResult = await runSdkAgent(agentOpts);

  if (!agentResult.ok) {
    return {
      ok: false,
      error: agentResult.error,
      details: agentResult.details,
      cost: agentResult.cost || 0,
      durationMs: agentResult.durationMs || 0,
    };
  }

  // ─── Dual extraction: structuredOutput.total first → parseScore() fallback ───
  const resultText = agentResult.result || "";
  const structuredOutput = agentResult.structuredOutput || null;
  const score =
    structuredOutput != null && structuredOutput.total != null
      ? structuredOutput.total
      : parseScore(resultText);

  return {
    ok: true,
    result: resultText,
    structuredOutput,
    score,
    cost: agentResult.cost || 0,
    model: agentResult.model || opts.model,
    durationMs: agentResult.durationMs || 0,
  };
}

/**
 * Run Stage 3 Opus escalation.
 * Called when prior stages scored below PASS_THRESHOLD.
 *
 * @param {Object} opts
 * @param {string} opts.step - Pipeline step name
 * @param {string} opts.cwd - Working directory
 * @param {string} opts.priorReview - Best available prior review text
 * @param {string} [opts.scale] - Optional scale hint ('small'|'medium'|'large') for turn limit
 * @returns {Promise<Object>} Same shape as runReviewStage
 */
async function runOpusEscalation({ step, cwd, priorReview, scale }) {
  return runReviewStage({
    model: OPUS_MODEL,
    step,
    cwd,
    priorReview,
    effort: "high",
    thinking: { type: "adaptive" },
  });
}

/**
 * Run 3-stage SDK review for a pipeline step.
 *
 * Stage 1: Haiku fast review
 *   - score ≥ 20 → approve
 *   - score < 15 → Stage 3 (Opus escalation)
 *   - 15-19 (borderline) → Stage 2
 *
 * Stage 2: Sonnet deep review
 *   - score ≥ 20 → approve
 *   - score < 20 → Stage 3 (Opus escalation)
 *
 * Stage 3: Opus escalation (auto)
 *   - score ≥ 20 → approve + escalated:true
 *   - score < 20 → reject + escalated:true
 *
 * @param {Object} opts
 * @param {string} opts.step - Pipeline step name (e.g. 'design', 'implement')
 * @param {string} opts.artifactDir - Directory for review artifacts
 * @param {string} opts.cwd - Project root working directory
 * @param {string} [opts.scale] - Optional scale hint ('small'|'medium'|'large') propagated to turn limits
 * @returns {Promise<Object>} Result:
 *   Success: { ok: true, score, decision: 'approve'|'reject', stage, model, cost, durationMs, escalated? }
 *   Failure: { ok: false, error: string }
 */
async function sdkReview(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts))
    return { ok: false, error: "invalid_input" };
  const { step, artifactDir, cwd, scale } = opts;
  const HAIKU_MODEL = MODEL_VERSIONS.HAIKU;
  const SONNET_MODEL = MODEL_VERSIONS.SONNET;

  let totalCost = 0;
  let totalDurationMs = 0;

  // ─── Stage 1: Haiku fast review ───
  const stage1 = await runReviewStage({
    model: HAIKU_MODEL,
    step,
    cwd,
    priorReview: null,
    effort: "medium",
  });

  if (!stage1.ok) {
    return { ok: false, error: stage1.error, details: stage1.details };
  }

  totalCost += stage1.cost;
  totalDurationMs += stage1.durationMs;
  const haikuScore = stage1.score;
  const haikuResult = stage1.result;

  // Score could not be parsed — treat as borderline to get Sonnet opinion
  if (haikuScore == null) {
    // Fall through to Stage 2 for a definitive answer
  } else if (haikuScore >= PASS_THRESHOLD) {
    // Clear pass — write artifacts, return
    writeReviewArtifact(
      artifactDir,
      step,
      stage1.structuredOutput?.review_text || haikuResult,
    );
    writeApprovalArtifact(artifactDir, step, {
      decision: "approve",
      score: haikuScore,
      threshold: PASS_THRESHOLD,
      stage: "haiku",
      model: stage1.model,
      _source: "sdk-reviewer",
      timestamp: new Date().toISOString(),
    });

    return {
      ok: true,
      score: haikuScore,
      decision: "approve",
      stage: "haiku",
      model: stage1.model,
      cost: totalCost,
      durationMs: totalDurationMs,
    };
  } else if (haikuScore < FAIL_THRESHOLD) {
    // ─── Stage 3: Opus escalation from clear Haiku fail ───
    const opusResult = await runOpusEscalation({
      step,
      cwd,
      priorReview: haikuResult,
      scale,
    });
    totalCost += opusResult.cost || 0;
    totalDurationMs += opusResult.durationMs || 0;

    if (
      opusResult.ok &&
      opusResult.score != null &&
      opusResult.score >= PASS_THRESHOLD
    ) {
      // Opus rescued it
      writeReviewArtifact(
        artifactDir,
        step,
        opusResult.structuredOutput?.review_text || opusResult.result,
      );
      writeApprovalArtifact(artifactDir, step, {
        decision: "approve",
        score: opusResult.score,
        threshold: PASS_THRESHOLD,
        stage: "opus",
        model: opusResult.model,
        escalated: true,
        escalation_model: "opus",
        _source: "sdk-reviewer",
        timestamp: new Date().toISOString(),
      });

      return {
        ok: true,
        score: opusResult.score,
        decision: "approve",
        stage: "opus",
        model: opusResult.model,
        cost: totalCost,
        durationMs: totalDurationMs,
        escalated: true,
      };
    }

    // Opus also failed (or errored) — reject with escalated flag
    const opusScore =
      opusResult.ok && opusResult.score != null ? opusResult.score : haikuScore;
    const opusReviewText =
      opusResult.ok && opusResult.structuredOutput?.review_text
        ? opusResult.structuredOutput.review_text
        : opusResult.ok && opusResult.result
          ? opusResult.result
          : haikuResult;

    writeReviewArtifact(artifactDir, step, opusReviewText);
    writeApprovalArtifact(artifactDir, step, {
      decision: "reject",
      score: opusScore,
      threshold: PASS_THRESHOLD,
      stage: "opus",
      model: opusResult.ok ? opusResult.model : OPUS_MODEL,
      escalated: true,
      escalation_model: "opus",
      _source: "sdk-reviewer",
      timestamp: new Date().toISOString(),
    });
    writeEscalation(cwd, opusScore, { auto_escalated: true });

    return {
      ok: true,
      score: opusScore,
      decision: "reject",
      stage: "opus",
      model: opusResult.ok ? opusResult.model : OPUS_MODEL,
      cost: totalCost,
      durationMs: totalDurationMs,
      escalated: true,
    };
  }

  // ─── Stage 2: Sonnet deep review (borderline 15-19 or unparseable score) ───
  const stage2 = await runReviewStage({
    model: SONNET_MODEL,
    step,
    cwd,
    priorReview: haikuResult,
    effort: "high",
  });

  if (!stage2.ok) {
    // Stage 2 failed — still have Stage 1 result, report partial
    // Write Haiku artifacts as the best available review
    writeReviewArtifact(
      artifactDir,
      step,
      stage1.structuredOutput?.review_text || haikuResult,
    );
    return {
      ok: false,
      error: stage2.error,
      details: `Stage 2 (Sonnet) failed: ${stage2.details || stage2.error}. Haiku score was ${haikuScore}.`,
      cost: totalCost + (stage2.cost || 0),
      durationMs: totalDurationMs + (stage2.durationMs || 0),
    };
  }

  totalCost += stage2.cost;
  totalDurationMs += stage2.durationMs;
  const sonnetScore = stage2.score;
  const sonnetResult = stage2.result;

  // Use Sonnet's score as the definitive assessment
  const finalScore = sonnetScore != null ? sonnetScore : haikuScore;

  if (finalScore != null && finalScore >= PASS_THRESHOLD) {
    // Sonnet approved — no escalation needed
    writeReviewArtifact(
      artifactDir,
      step,
      stage2.structuredOutput?.review_text || sonnetResult,
    );
    writeApprovalArtifact(artifactDir, step, {
      decision: "approve",
      score: finalScore,
      threshold: PASS_THRESHOLD,
      stage: "sonnet",
      model: stage2.model,
      _source: "sdk-reviewer",
      timestamp: new Date().toISOString(),
    });

    return {
      ok: true,
      score: finalScore,
      decision: "approve",
      stage: "sonnet",
      model: stage2.model,
      cost: totalCost,
      durationMs: totalDurationMs,
    };
  }

  // ─── Stage 3: Opus escalation from Sonnet fail ───
  const opusResult = await runOpusEscalation({
    step,
    cwd,
    priorReview: sonnetResult,
    scale,
  });
  totalCost += opusResult.cost || 0;
  totalDurationMs += opusResult.durationMs || 0;

  if (
    opusResult.ok &&
    opusResult.score != null &&
    opusResult.score >= PASS_THRESHOLD
  ) {
    // Opus rescued it after Sonnet failed
    writeReviewArtifact(
      artifactDir,
      step,
      opusResult.structuredOutput?.review_text || opusResult.result,
    );
    writeApprovalArtifact(artifactDir, step, {
      decision: "approve",
      score: opusResult.score,
      threshold: PASS_THRESHOLD,
      stage: "opus",
      model: opusResult.model,
      escalated: true,
      escalation_model: "opus",
      _source: "sdk-reviewer",
      timestamp: new Date().toISOString(),
    });

    return {
      ok: true,
      score: opusResult.score,
      decision: "approve",
      stage: "opus",
      model: opusResult.model,
      cost: totalCost,
      durationMs: totalDurationMs,
      escalated: true,
    };
  }

  // Opus also failed — final reject with escalated flag
  const opusScore =
    opusResult.ok && opusResult.score != null ? opusResult.score : finalScore;
  const opusReviewText =
    opusResult.ok && opusResult.structuredOutput?.review_text
      ? opusResult.structuredOutput.review_text
      : opusResult.ok && opusResult.result
        ? opusResult.result
        : sonnetResult;

  writeReviewArtifact(artifactDir, step, opusReviewText);
  writeApprovalArtifact(artifactDir, step, {
    decision: "reject",
    score: opusScore,
    threshold: PASS_THRESHOLD,
    stage: "opus",
    model: opusResult.ok ? opusResult.model : OPUS_MODEL,
    escalated: true,
    escalation_model: "opus",
    _source: "sdk-reviewer",
    timestamp: new Date().toISOString(),
  });
  writeEscalation(cwd, opusScore, { auto_escalated: true });

  return {
    ok: true,
    score: opusScore,
    decision: "reject",
    stage: "opus",
    model: opusResult.ok ? opusResult.model : OPUS_MODEL,
    cost: totalCost,
    durationMs: totalDurationMs,
    escalated: true,
  };
}

module.exports = { sdkReview };
