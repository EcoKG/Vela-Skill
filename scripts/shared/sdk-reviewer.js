/**
 * Vela SDK Reviewer
 * Opus single-pass review module.
 * Calls runSdkAgent() for each review — never imports SDK directly.
 *
 * Single stage (Opus): Score ≥ 20 → approve, < 20 → reject.
 * No escalation — every review is a single Opus call with high effort.
 *
 * Scoring dimensions (step-aware):
 * - execute: Security & Data Safety / Robustness & Resource Safety /
 *            Readability & Maintainability / Test Quality / Completeness & Contract
 * - plan:    Architecture & Design / API & Interface / Dependency & Integration /
 *            Specification & Contract / Risk & Mitigation
 * - research: Source Coverage / Analysis Depth / Risk Identification /
 *             Technology Assessment / Actionable Findings (unchanged)
 *
 * Exports: sdkReview({ step, artifactDir, cwd, pipelineSlug? })
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
const { MODEL_VERSIONS, VELA_EXCLUSION_DIRECTIVE } = require("./constants");
const worktreeManager = require("./worktree-manager");

// ─── Score regex — matches vela-subagent-stop.js patterns ───
const PRIMARY_SCORE_REGEX = /(총점|총|total\s*score)[^\d]*(\d+)\s*\/\s*25/i;
const FALLBACK_SCORE_REGEX = /\b(\d+)\s*\/\s*25\b/;

const PASS_THRESHOLD = 20;

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
        api_interface: { type: "number" },
        dependency_integration: { type: "number" },
        specification_contract: { type: "number" },
        risk_mitigation: { type: "number" },
      },
      required: [
        "architecture_design",
        "api_interface",
        "dependency_integration",
        "specification_contract",
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
        security_data_safety: { type: "number" },
        robustness_resource_safety: { type: "number" },
        readability_maintainability: { type: "number" },
        test_quality: { type: "number" },
        completeness_contract: { type: "number" },
      },
      required: [
        "security_data_safety",
        "robustness_resource_safety",
        "readability_maintainability",
        "test_quality",
        "completeness_contract",
      ],
    },
    ..._COMMON_SCHEMA_FIELDS,
  },
  required: ["scores", "total", "review_text"],
};

// ─── Opus model ───
const OPUS_MODEL = MODEL_VERSIONS.OPUS;

// ─── Inlined reviewer system prompts — step-aware ───
// SDK agents run with settingSources: [] and cannot read project files.
// The entire reviewer context must be in the system prompt.

// Shared sections reused across all three prompts
const _PROMPT_HEADER = `# Reviewer Agent
${VELA_EXCLUSION_DIRECTIVE}
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
### 1. Architecture & Design (X/5)
- 컴포넌트/모듈 분리 설계의 적절성
- 인터페이스 경계와 의존성 방향
- 확장성과 유지보수성 고려
- 레이어 분리와 응집도/결합도 균형

### 2. API & Interface (X/5)
- API 시그니처, 파라미터, 반환 타입 명세의 명확성
- 인터페이스 계약의 일관성과 완전성
- 버전 호환성 및 하위 호환 전략
- 소비자 관점의 사용성

### 3. Dependency & Integration (X/5)
- 기존 코드베이스와의 호환성
- 외부/내부 의존성 리스크 분석
- 통합 지점의 명확한 정의
- 마이그레이션 경로 및 전환 전략

### 4. Specification & Contract (X/5)
- 기능 명세의 완전성과 모호성 없음
- 엣지 케이스와 경계 조건 정의
- 입출력 계약의 명시적 정의
- 누락된 중요 추상화 여부

### 5. Risk & Mitigation (X/5)
- 식별된 리스크에 대한 대응 전략
- 롤백/폴백 계획의 존재 여부
- 단계별 검증 포인트 설정
- 기술 부채와 장기 유지보수 리스크
` +
  _PROMPT_FOOTER;

const EXECUTE_REVIEW_PROMPT =
  _PROMPT_HEADER +
  `
## 평가 범위
- **새 코드**: 이번 단계에서 새로 작성된 파일
- **수정 코드**: 기존 파일에서 변경된 부분
- **레거시 구분**: 기존 코드의 문제는 감점하지 않되, 새 코드가 레거시 패턴을 확산시키면 감점

### 1. Security & Data Safety (X/5)
- 입력 검증 및 살균 (injection, XSS, path traversal)
- 인증/인가 경계의 올바른 적용
- 민감 데이터 노출 방지 (로그, 에러 메시지, 환경변수)
- 의존성의 알려진 취약점 여부
- 암호화/해시 적절성 (필요 시)

### 2. Robustness & Resource Safety (X/5)
- 에러 처리 전략의 일관성과 완전성
- 리소스 정리 (파일 핸들, 커넥션, 타이머, 이벤트 리스너)
- 타임아웃/재시도/서킷 브레이커 적용
- null/undefined 방어 및 타입 안전성
- 동시성/경쟁 조건 방어

### 3. Readability & Maintainability (X/5)
- 명명 규칙의 일관성과 의미 전달력
- 함수/모듈 크기와 단일 책임 원칙
- 코드 중복 최소화 (DRY)
- 주석의 적절성 (왜를 설명, 무엇을 반복하지 않음)
- 코드 구조의 논리적 흐름

### 4. Test Quality (X/5)
- 테스트 케이스의 실질적 검증 가치 (존재만이 아닌)
- 정상/실패/경계 시나리오 커버리지
- 테스트 격리 및 결정론적 실행
- 테스트 가독성과 의도 전달
- 모킹/스터빙의 적절한 범위

### 5. Completeness & Contract (X/5)
- 명세 대비 구현의 완전성
- 인터페이스 계약 준수 (입출력 타입, 반환값)
- 누락된 중요 기능이나 엣지 케이스
- 문서화 (JSDoc, README, 변경 이력)
- 하위 호환성 유지
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
 * Build the review prompt for a given step.
 * @param {string} step - Pipeline step name
 * @returns {string}
 */
function buildReviewPrompt(step) {
  let prompt = `다음 파이프라인 단계의 산출물을 리뷰하라: "${step}"\n\n`;
  prompt += `이 단계의 artifacts 디렉토리에 있는 모든 산출물을 읽고 5차원 채점 기준에 따라 평가하라.\n`;

  // Step-specific guidance
  if (step === "research") {
    prompt += `research.md 등 조사 산출물을 중심으로 평가하라. 자료원의 폭, 분석 깊이, 리스크 식별에 집중하라.\n`;
  } else if (step === "plan") {
    prompt += `plan.md 등 설계 문서를 중심으로 평가하라. 아키텍처 설계, API 인터페이스, 의존성 통합에 집중하라.\n`;
  } else {
    prompt += `소스 코드와 테스트를 중심으로 평가하라. 보안, 견고성, 가독성, 테스트 품질, 완전성에 집중하라.\n`;
  }

  prompt += `반드시 마지막에 "## Total: XX/25" 형식으로 총점을 명시하라.\n`;

  return prompt;
}

/**
 * Run a single review stage via SDK agent.
 * @param {Object} opts
 * @param {string} opts.model - Model identifier
 * @param {string} opts.step - Pipeline step name
 * @param {string} opts.cwd - Working directory
 * @param {string} [opts.effort] - Agent effort level
 * @param {Object} [opts.thinking] - Thinking configuration
 * @returns {Promise<Object>} { ok, result, score, cost, model, durationMs } or { ok: false, error }
 */
async function runReviewStage(opts) {
  const prompt = buildReviewPrompt(opts.step);

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
 * Run single-pass Opus SDK review for a pipeline step.
 *
 * Opus review: score ≥ 20 → approve, < 20 → reject.
 * No escalation stages — every review is a direct Opus call.
 *
 * @param {Object} opts
 * @param {string} opts.step - Pipeline step name (e.g. 'research', 'plan', 'execute')
 * @param {string} opts.artifactDir - Directory for review artifacts
 * @param {string} opts.cwd - Project root working directory
 * @param {string} [opts.pipelineSlug] - Pipeline identifier for worktree isolation.
 *   When provided, a git worktree is created before the review and the review
 *   runs inside the isolated worktree. The worktree is cleaned up in a finally
 *   block regardless of success or failure. If worktree creation fails, review
 *   falls back to the original cwd with a stderr warning.
 * @returns {Promise<Object>} Result:
 *   Success: { ok: true, score, decision: 'approve'|'reject', stage: 'opus', model, cost, durationMs }
 *   Failure: { ok: false, error: string, details?, cost?, durationMs? }
 */
async function sdkReview(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts))
    return { ok: false, error: "invalid_input" };
  const { step, artifactDir, cwd, pipelineSlug } = opts;

  // ─── Worktree isolation ───
  let worktreeInfo = null;
  let agentCwd = cwd;
  if (pipelineSlug) {
    try {
      worktreeInfo = worktreeManager.create({ cwd, pipelineSlug, role: 'reviewer' });
      agentCwd = worktreeInfo.path;
    } catch (err) {
      process.stderr.write(`[sdk-reviewer] worktree creation failed, running without isolation: ${err.message}\n`);
    }
  }

  try {
    // ─── Single Opus review ───
    const result = await runReviewStage({
      model: OPUS_MODEL,
      step,
      cwd: agentCwd,
      effort: "high",
      thinking: { type: "adaptive" },
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        details: result.details,
        cost: result.cost,
        durationMs: result.durationMs,
      };
    }

    const score = result.score;
    const decision = score != null && score >= PASS_THRESHOLD ? "approve" : "reject";

    // Write review artifact
    writeReviewArtifact(
      artifactDir,
      step,
      result.structuredOutput?.review_text || result.result,
    );

    // Write approval artifact
    writeApprovalArtifact(artifactDir, step, {
      decision,
      score,
      threshold: PASS_THRESHOLD,
      stage: "opus",
      model: result.model,
      _source: "sdk-reviewer",
      timestamp: new Date().toISOString(),
    });

    return {
      ok: true,
      score,
      decision,
      stage: "opus",
      model: result.model,
      cost: result.cost,
      durationMs: result.durationMs,
    };
  } finally {
    if (worktreeInfo) {
      try {
        worktreeManager.remove({ cwd, worktreePath: worktreeInfo.path, force: true });
      } catch (err) {
        process.stderr.write(`[sdk-reviewer] worktree cleanup failed: ${err.message}\n`);
      }
    }
  }
}

module.exports = { sdkReview };
