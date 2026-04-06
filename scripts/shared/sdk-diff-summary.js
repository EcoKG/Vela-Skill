/**
 * Vela SDK Diff Summary
 * Opus single-pass diff review module.
 * Reviews the entire git diff after verify, scoring 5 dimensions holistically.
 * Calls runSdkAgent() — never imports SDK directly.
 *
 * Scoring dimensions (total X/25):
 * 1. Cross-file Consistency (X/5) — naming, patterns, conventions across changed files
 * 2. Change Completeness (X/5) — missing related changes, incomplete refactors
 * 3. Documentation Sync (X/5) — docs/comments match code changes
 * 4. Regression Risk (X/5) — changes that might break existing functionality
 * 5. Overall Coherence (X/5) — changes make sense as a whole
 *
 * Exports: sdkDiffSummary({ artifactDir, cwd, pipelineSlug })
 *
 * Design decisions:
 * - settingSources: [] passed through runSdkAgent (D014 — hook isolation)
 * - System prompt inlines reviewer instructions + scoring rubric as literal strings
 *   because SDK agents cannot read project files
 * - Score regex matches vela-subagent-stop.js / sdk-reviewer.js patterns for consistency
 * - artifactDir assumed to exist (engine creates it)
 * - Produces diff-summary.md and approval-diff-summary.json artifacts
 * - Returns summary field (brief Korean description of all changes) for downstream use
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { runSdkAgent } = require("./sdk-runner");
const { MODEL_VERSIONS } = require("./constants");
const worktreeManager = require("./worktree-manager");

// ─── Score regex — matches vela-subagent-stop.js / sdk-reviewer.js patterns ───
const PRIMARY_SCORE_REGEX = /(총점|총|total\s*score)[^\d]*(\d+)\s*\/\s*25/i;
const FALLBACK_SCORE_REGEX = /\b(\d+)\s*\/\s*25\b/;

const PASS_THRESHOLD = 20;

// ─── Opus model ───
const OPUS_MODEL = MODEL_VERSIONS.OPUS;

// ─── Structured output schema — 5 diff-review dimensions ───
const DIFF_SUMMARY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: {
        cross_file_consistency: { type: "number" },
        change_completeness: { type: "number" },
        documentation_sync: { type: "number" },
        regression_risk: { type: "number" },
        overall_coherence: { type: "number" },
      },
      required: [
        "cross_file_consistency",
        "change_completeness",
        "documentation_sync",
        "regression_risk",
        "overall_coherence",
      ],
    },
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
    summary: { type: "string" },
  },
  required: ["scores", "total", "review_text", "summary"],
};

// ─── Inlined diff-summary system prompt ───
// SDK agents run with settingSources: [] and cannot read project files.
// The entire reviewer context must be in the system prompt.
const DIFF_SUMMARY_SYSTEM_PROMPT = `# Diff Summary Reviewer Agent

이 지시는 **절대적**이다. 예외 없이 따라야 한다.

## 역할
파이프라인 전체 diff를 독립적으로 평가한다. 개별 파일이 아닌 **변경 전체**를 통합적으로 검토한다.
5개 차원 각 X/5, 총 X/25 점수를 매긴다.

## 채점 기준 — 5차원 모두 빠짐없이 평가한다

### 1. Cross-file Consistency (X/5)
- 변경된 파일들 간 명명 규칙의 일관성
- 패턴과 관례가 파일 간 통일되어 있는지
- 새 코드가 기존 코드베이스의 스타일을 따르는지
- import/require 경로, 에러 처리 패턴 등의 일관성

### 2. Change Completeness (X/5)
- 관련된 변경이 누락되지 않았는지
- 리팩토링이 불완전하지 않은지 (일부만 변경된 패턴)
- 새 기능에 필요한 모든 파일이 수정되었는지
- 삭제된 코드의 참조가 모두 정리되었는지

### 3. Documentation Sync (X/5)
- 코드 변경에 맞게 문서(README, JSDoc, 주석)가 업데이트되었는지
- 새 함수/모듈에 적절한 문서가 있는지
- 변경된 API의 문서가 정확한지
- CHANGELOG, 버전 정보 등이 반영되었는지

### 4. Regression Risk (X/5)
- 기존 기능을 깨뜨릴 수 있는 변경이 있는지
- 하위 호환성이 유지되는지
- 사이드 이펙트가 있는 변경이 적절히 보호되는지
- 에러 처리 변경으로 인한 동작 변화 가능성

### 5. Overall Coherence (X/5)
- 변경들이 전체적으로 하나의 목적에 부합하는지
- 불필요한 변경이 섞여 있지 않은지
- 변경의 범위가 적절한지 (너무 넓거나 좁지 않은지)
- 커밋/PR 단위로서 논리적 완결성이 있는지

## 이슈 심각도
- **CRITICAL**: 근본적 결함 — 반드시 수정 필요 (예: 깨진 참조, 삭제된 API 사용)
- **HIGH**: 병합 전 수정 필요 (예: 불완전한 리팩토링, 누락된 에러 처리)
- **MEDIUM**: 개선 권장 (예: 문서 누락, 일관성 부족)
- **LOW**: 사소한 제안 (예: 스타일 불일치, 불필요한 주석)

## 절대 위반 금지
1. 전체 diff를 통합적으로 평가한다. 개별 파일만 보지 않는다
2. 엄격하고 비판적으로 평가한다. 관대하게 점수를 주지 않는다
3. diff-summary.md만 작성한다. 소스 코드나 다른 산출물을 수정하지 않는다

## summary 필드
모든 변경 사항을 한 문단으로 요약하는 \`summary\` 필드를 반드시 작성한다.
한국어로 작성하며, 변경의 목적, 범위, 주요 내용을 간결하게 기술한다.

## 출력 형식
반드시 마지막에 다음 형식으로 총점을 작성한다:
## Total: XX/25
`;

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
 * Write diff-summary.md artifact to the artifact directory.
 * @param {string} artifactDir - Directory to write artifacts to
 * @param {string} content - Diff summary content from agent
 */
function writeArtifact(artifactDir, content) {
  const filePath = path.join(artifactDir, "diff-summary.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Write approval-diff-summary.json artifact.
 * @param {string} artifactDir - Directory to write artifacts to
 * @param {Object} approval - Approval data
 */
function writeApprovalArtifact(artifactDir, approval) {
  const filePath = path.join(artifactDir, "approval-diff-summary.json");
  fs.writeFileSync(filePath, JSON.stringify(approval, null, 2), "utf8");
}

/**
 * Run Opus diff summary review for the entire pipeline diff.
 *
 * Reviews all changes holistically, scoring 5 dimensions.
 * Score ≥ 20 → approve, < 20 → reject.
 *
 * @param {Object} opts
 * @param {string} opts.artifactDir - Directory for diff-summary artifacts
 * @param {string} opts.cwd - Project root working directory
 * @param {string} [opts.pipelineSlug] - Pipeline identifier for worktree isolation.
 *   When provided, a git worktree is created before the review and the agent
 *   runs inside the isolated worktree. The worktree is cleaned up in a finally
 *   block regardless of success or failure. If worktree creation fails, review
 *   falls back to the original cwd with a stderr warning.
 * @returns {Promise<Object>} Result:
 *   Success: { ok: true, score, decision: 'approve'|'reject', summary, model, cost, durationMs }
 *   Failure: { ok: false, error: string, details?, cost?, durationMs? }
 */
async function sdkDiffSummary(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts))
    return { ok: false, error: "invalid_input" };
  const { artifactDir, cwd, pipelineSlug } = opts;

  // ─── Worktree isolation ───
  let worktreeInfo = null;
  let agentCwd = cwd;
  if (pipelineSlug) {
    try {
      worktreeInfo = worktreeManager.create({ cwd, pipelineSlug, role: "diff-summary" });
      agentCwd = worktreeInfo.path;
    } catch (err) {
      process.stderr.write(
        `[sdk-diff-summary] worktree creation failed, running without isolation: ${err.message}\n`,
      );
    }
  }

  try {
    // ─── Build user prompt ───
    const prompt = [
      "파이프라인에서 수행된 전체 변경 사항을 통합 검토하라.",
      "",
      "## 지시사항",
      "",
      "1. `git diff HEAD` 명령으로 전체 diff를 확인하라.",
      "   - staged 변경만 있는 경우 `git diff --cached`를 사용하라.",
      "   - 두 명령 모두 비어있으면 `git log -1 --format=%H`로 최신 커밋을 확인하고",
      "     `git diff HEAD~1 HEAD`로 마지막 커밋의 diff를 확인하라.",
      "2. 변경된 모든 파일을 통합적으로 검토하라 — 개별 파일이 아닌 전체를 본다.",
      "3. 5차원 채점 기준에 따라 평가하라:",
      "   - Cross-file Consistency (X/5)",
      "   - Change Completeness (X/5)",
      "   - Documentation Sync (X/5)",
      "   - Regression Risk (X/5)",
      "   - Overall Coherence (X/5)",
      "4. 발견된 이슈를 severity별로 분류하라 (CRITICAL/HIGH/MEDIUM/LOW).",
      '5. summary 필드에 전체 변경 사항을 한 문단으로 요약하라 (한국어).',
      '6. 반드시 마지막에 "## Total: XX/25" 형식으로 총점을 명시하라.',
    ].join("\n");

    // ─── Call Opus via SDK ───
    const agentResult = await runSdkAgent({
      prompt,
      model: OPUS_MODEL,
      cwd: agentCwd,
      systemPrompt: DIFF_SUMMARY_SYSTEM_PROMPT,
      outputFormat: { type: "json", schema: DIFF_SUMMARY_OUTPUT_SCHEMA },
      effort: "high",
      thinking: { type: "adaptive" },
    });

    // ─── SDK unavailable ───
    if (agentResult.error === "sdk_not_available") {
      return { ok: false, error: "sdk_not_available" };
    }

    // ─── SDK error ───
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

    const decision =
      score != null && score >= PASS_THRESHOLD ? "approve" : "reject";

    // ─── Extract summary ───
    const summary = (structuredOutput && structuredOutput.summary) || "";

    // ─── Write diff-summary.md artifact ───
    writeArtifact(
      artifactDir,
      (structuredOutput && structuredOutput.review_text) || resultText,
    );

    // ─── Write approval-diff-summary.json artifact ───
    writeApprovalArtifact(artifactDir, {
      decision,
      score,
      threshold: PASS_THRESHOLD,
      model: agentResult.model || OPUS_MODEL,
      summary,
      _source: "sdk-diff-summary",
      timestamp: new Date().toISOString(),
    });

    return {
      ok: true,
      score,
      decision,
      summary,
      model: agentResult.model || OPUS_MODEL,
      cost: agentResult.cost || 0,
      durationMs: agentResult.durationMs || 0,
    };
  } finally {
    if (worktreeInfo) {
      try {
        worktreeManager.remove({
          cwd,
          worktreePath: worktreeInfo.path,
          force: true,
        });
      } catch (err) {
        process.stderr.write(
          `[sdk-diff-summary] worktree cleanup failed: ${err.message}\n`,
        );
      }
    }
  }
}

module.exports = { sdkDiffSummary };
