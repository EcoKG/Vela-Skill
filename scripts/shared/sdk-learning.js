/**
 * Vela SDK Learning
 * Haiku-based pipeline learning extraction module.
 * Collects all review artifacts from a pipeline run, extracts patterns/learnings
 * via SDK agent, writes learning.md artifact, and accumulates learnings to
 * .vela/learnings/learnings.json for future pipeline runs.
 * Calls runSdkAgent() — never imports SDK directly.
 *
 * Exports: sdkLearning({ artifactDir, cwd, pipelineSlug })
 *
 * Design decisions:
 * - settingSources: [] passed through runSdkAgent (D014 — hook isolation)
 * - System prompt inlines learning extraction instructions as literal strings
 *   because SDK agents cannot read project files
 * - artifactDir assumed to exist (engine creates it)
 * - Persistent learnings stored in .vela/learnings/learnings.json (max 50 entries, FIFO)
 * - Persistent storage failure never crashes the function (try/catch safety)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { runSdkAgent } = require("./sdk-runner");
const { MODEL_VERSIONS } = require("./constants");
const worktreeManager = require("./worktree-manager");

// ─── Haiku model ───
const HAIKU_MODEL = MODEL_VERSIONS.HAIKU;

// ─── Max persistent learning entries (FIFO trim) ───
const MAX_LEARNING_ENTRIES = 50;

// ─── Structured output schema ───
const LEARNING_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["strength", "weakness", "recurring_issue", "improvement"],
          },
          description: { type: "string" },
          frequency: {
            type: "string",
            enum: ["first_time", "recurring", "persistent"],
          },
          step: { type: "string" },
        },
        required: ["category", "description", "frequency", "step"],
      },
    },
    scores_summary: {
      type: "object",
      properties: {
        research: { type: "number" },
        plan: { type: "number" },
        execute: { type: "number" },
        diff_summary: { type: "number" },
      },
    },
    key_learnings: {
      type: "array",
      items: { type: "string" },
    },
    recommendations: {
      type: "array",
      items: { type: "string" },
    },
    learning_text: { type: "string" },
  },
  required: ["patterns", "scores_summary", "key_learnings", "learning_text"],
};

// ─── Inlined learning extraction system prompt ───
// SDK agents run with settingSources: [] and cannot read project files.
// The entire context must be in the system prompt.
const LEARNING_SYSTEM_PROMPT = `# Pipeline Learning Extraction Agent

이 지시는 **절대적**이다. 예외 없이 따라야 한다.

## 역할
파이프라인 실행 결과에서 패턴과 학습 사항을 추출한다.
모든 리뷰 산출물(review-research.md, review-plan.md, review-execute.md, diff-summary.md)과
승인 JSON(approval-*.json)을 분석하여 구조화된 학습 데이터를 생성한다.

## 분석 항목

### 1. 패턴 추출 (patterns)
리뷰 전체에서 반복되는 패턴을 식별한다:
- **strength**: 잘 수행된 영역 — 유지해야 할 좋은 관행
- **weakness**: 개선이 필요한 영역 — 반복적으로 점수가 낮은 차원
- **recurring_issue**: 여러 단계에서 반복되는 동일한 문제
- **improvement**: 이전 실행 대비 개선된 영역

각 패턴에 대해:
- \`category\`: 위 4가지 중 하나
- \`description\`: 구체적인 설명 (한국어)
- \`frequency\`: first_time(처음 발견), recurring(2회 이상 반복), persistent(계속 존재)
- \`step\`: 해당 패턴이 발견된 단계 (research, plan, execute, diff_summary, 또는 cross-step)

### 2. 점수 요약 (scores_summary)
각 리뷰 단계의 총점을 추출한다:
- \`research\`: research 리뷰 점수 (X/25)
- \`plan\`: plan 리뷰 점수 (X/25)
- \`execute\`: execute 리뷰 점수 (X/25)
- \`diff_summary\`: diff-summary 리뷰 점수 (X/25)
점수를 찾을 수 없으면 해당 필드를 0으로 설정한다.

### 3. 핵심 학습 사항 (key_learnings)
이번 파이프라인 실행에서 얻은 가장 중요한 학습 사항 3-5개를 한국어로 작성한다.
각 항목은 한 문장으로 간결하게 작성한다.

### 4. 권고 사항 (recommendations)
다음 파이프라인 실행을 위한 구체적이고 실행 가능한 권고 사항을 작성한다.
"더 잘 하라"같은 추상적 권고가 아닌, 구체적인 행동 지침을 제시한다.

### 5. 학습 텍스트 (learning_text)
전체 분석 결과를 마크다운 형식의 학습 보고서로 작성한다.
이 텍스트는 learning.md 파일로 저장된다.

## 출력 형식
반드시 구조화된 JSON으로 출력한다.

## 절대 위반 금지
1. 리뷰 산출물에 없는 내용을 추측하지 않는다
2. 점수가 없는 단계는 0으로 표시한다
3. learning.md만 작성한다. 소스 코드나 다른 산출물을 수정하지 않는다
`;

/**
 * Collect review artifacts from the artifact directory.
 * Reads review-*.md, approval-*.json, and diff-summary.md files.
 * Returns concatenated text for the prompt.
 *
 * @param {string} artifactDir - Directory containing pipeline artifacts
 * @returns {string} Concatenated artifact content
 */
function collectArtifacts(artifactDir) {
  const sections = [];

  // Review markdown files
  const reviewFiles = [
    "review-research.md",
    "review-plan.md",
    "review-execute.md",
    "diff-summary.md",
  ];

  for (const filename of reviewFiles) {
    const filePath = path.join(artifactDir, filename);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      sections.push(`## ${filename}\n\n${content}`);
    } catch {
      // File may not exist — skip silently
    }
  }

  // Approval JSON files
  const approvalFiles = [
    "approval-research.json",
    "approval-plan.json",
    "approval-execute.json",
    "approval-diff-summary.json",
  ];

  for (const filename of approvalFiles) {
    const filePath = path.join(artifactDir, filename);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      sections.push(`## ${filename}\n\n\`\`\`json\n${content}\n\`\`\``);
    } catch {
      // File may not exist — skip silently
    }
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Write learning.md artifact to the artifact directory.
 *
 * @param {string} artifactDir - Directory to write artifact to
 * @param {string} content - Learning report content
 */
function writeArtifact(artifactDir, content) {
  const filePath = path.join(artifactDir, "learning.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Append a learning entry to persistent .vela/learnings/learnings.json.
 * Creates the file and directory if missing.
 * Keeps max 50 entries (FIFO trim — oldest entries removed first).
 * Wraps in try/catch — persistent storage failure never crashes the function.
 *
 * @param {string} cwd - Project root directory
 * @param {Object} entry - Learning entry to append
 */
function appendToLearnings(cwd, entry) {
  try {
    const learningsDir = path.join(cwd, ".vela", "learnings");
    const learningsPath = path.join(learningsDir, "learnings.json");

    // Read existing learnings or start fresh
    let learnings = [];
    try {
      const existing = fs.readFileSync(learningsPath, "utf8");
      learnings = JSON.parse(existing);
      if (!Array.isArray(learnings)) learnings = [];
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    // Append new entry
    learnings.push(entry);

    // FIFO trim — keep only the most recent entries
    if (learnings.length > MAX_LEARNING_ENTRIES) {
      learnings = learnings.slice(learnings.length - MAX_LEARNING_ENTRIES);
    }

    // Write back
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.writeFileSync(learningsPath, JSON.stringify(learnings, null, 2), "utf8");
  } catch (err) {
    // Persistent storage failure never crashes the function
    process.stderr.write(
      `[sdk-learning] persistent learnings write failed: ${err.message}\n`,
    );
  }
}

/**
 * Run Haiku learning extraction for a completed pipeline run.
 *
 * Collects review artifacts, extracts patterns and learnings via SDK agent,
 * writes learning.md artifact, and accumulates structured learnings to
 * .vela/learnings/learnings.json.
 *
 * @param {Object} opts
 * @param {string} opts.artifactDir - Directory containing pipeline artifacts
 * @param {string} opts.cwd - Project root working directory
 * @param {string} [opts.pipelineSlug] - Pipeline identifier for worktree isolation.
 *   When provided, a git worktree is created before the extraction and the agent
 *   runs inside the isolated worktree. The worktree is cleaned up in a finally
 *   block regardless of success or failure. If worktree creation fails, extraction
 *   falls back to the original cwd with a stderr warning.
 * @returns {Promise<Object>} Result:
 *   Success: { ok: true, patterns, scoresSummary, keyLearnings, cost, model, durationMs }
 *   Failure: { ok: false, error: string, details?, cost?, durationMs? }
 */
async function sdkLearning(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts))
    return { ok: false, error: "invalid_input" };
  const { artifactDir, cwd, pipelineSlug } = opts;

  // ─── Worktree isolation ───
  let worktreeInfo = null;
  let agentCwd = cwd;
  if (pipelineSlug) {
    try {
      worktreeInfo = worktreeManager.create({
        cwd,
        pipelineSlug,
        role: "learning",
      });
      agentCwd = worktreeInfo.path;
    } catch (err) {
      process.stderr.write(
        `[sdk-learning] worktree creation failed, running without isolation: ${err.message}\n`,
      );
    }
  }

  try {
    // ─── Collect artifacts ───
    const artifactContent = collectArtifacts(artifactDir);

    if (!artifactContent || artifactContent.trim().length === 0) {
      return {
        ok: false,
        error: "no_artifacts",
        details: "No review artifacts found in artifact directory",
      };
    }

    // ─── Build user prompt ───
    const prompt = [
      "파이프라인 실행이 완료되었다. 아래 리뷰 산출물을 분석하여 학습 사항을 추출하라.",
      "",
      "# 리뷰 산출물",
      "",
      artifactContent,
      "",
      "## 지시사항",
      "",
      "1. 위 산출물을 모두 분석하라.",
      "2. 각 리뷰 단계의 점수를 scores_summary에 기록하라.",
      "3. 반복되는 패턴(강점, 약점, 반복 이슈, 개선점)을 patterns에 추출하라.",
      "4. 핵심 학습 사항 3-5개를 key_learnings에 작성하라.",
      "5. 다음 실행을 위한 구체적 권고 사항을 recommendations에 작성하라.",
      "6. learning_text에 전체 학습 보고서를 마크다운으로 작성하라.",
    ].join("\n");

    // ─── Call Haiku via SDK ───
    const agentResult = await runSdkAgent({
      prompt,
      model: HAIKU_MODEL,
      cwd: agentCwd,
      systemPrompt: LEARNING_SYSTEM_PROMPT,
      outputFormat: { type: "json", schema: LEARNING_OUTPUT_SCHEMA },
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

    // ─── Extract result: structuredOutput priority → result text fallback ───
    const resultText = agentResult.result || "";
    const structuredOutput = agentResult.structuredOutput || null;

    let patterns = [];
    let scoresSummary = { research: 0, plan: 0, execute: 0, diff_summary: 0 };
    let keyLearnings = [];
    let recommendations = [];
    let learningText = "";

    if (structuredOutput) {
      patterns = structuredOutput.patterns || [];
      scoresSummary = structuredOutput.scores_summary || scoresSummary;
      keyLearnings = structuredOutput.key_learnings || [];
      recommendations = structuredOutput.recommendations || [];
      learningText = structuredOutput.learning_text || resultText;
    } else {
      // Fallback: use raw result text as learning text
      learningText = resultText;
    }

    // ─── Write learning.md artifact ───
    writeArtifact(artifactDir, learningText);

    // ─── Append to persistent .vela/learnings/learnings.json ───
    appendToLearnings(cwd, {
      timestamp: new Date().toISOString(),
      pipelineSlug: pipelineSlug || null,
      patterns,
      scoresSummary,
      keyLearnings,
      recommendations,
      model: agentResult.model || HAIKU_MODEL,
      cost: agentResult.cost || 0,
    });

    return {
      ok: true,
      patterns,
      scoresSummary,
      keyLearnings,
      cost: agentResult.cost || 0,
      model: agentResult.model || HAIKU_MODEL,
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
          `[sdk-learning] worktree cleanup failed: ${err.message}\n`,
        );
      }
    }
  }
}

module.exports = { sdkLearning };
