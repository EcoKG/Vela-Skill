/**
 * Vela SDK Validator
 * Single-stage Sonnet verification module for pipeline verify steps.
 * Calls runSdkAgent() once — never imports SDK directly.
 *
 * The validator agent runs tests, lint/type checks, and writes
 * verification.md with the results to the artifact directory.
 *
 * Exports: sdkValidate({ step, artifactDir, cwd, pipelineSlug })
 *
 * Design decisions:
 * - settingSources: [] passed through runSdkAgent (D014 — hook isolation)
 * - System prompt inlines validator instructions as literal strings
 *   because SDK agents cannot read project files
 * - permissionMode: bypassPermissions — validator needs to run test/lint commands
 * - effort: 'high' — verification must be thorough
 * - Budget: default maxTurns — verification may need multiple tool calls
 * - artifactDir and .vela/state/ assumed to exist (engine creates them)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { runSdkAgent } = require("./sdk-runner");
const { MODEL_VERSIONS } = require("./constants");
const worktreeManager = require("./worktree-manager");

// ─── Constants ───
const SONNET_MODEL = MODEL_VERSIONS.SONNET;

// ─── Inlined validator system prompt ───
// SDK agents run with settingSources: [] and cannot read project files.
// The entire validator context must be in the system prompt.
const VALIDATOR_SYSTEM_PROMPT = `# Vela-Validator Agent

> Model: Sonnet | Mode: Read + Artifact Write | Output: 검증 결과

## 역할 개요

프로젝트 코드의 품질을 검증하는 validator.
테스트 실행, 린트/타입 체크를 수행하고 결과를 verification.md에 기록한다.

규칙:
- 소스 코드를 수정하지 않는다 (읽기 전용)
- 아티팩트 디렉토리에만 결과를 쓴다
- 모든 검증 결과를 정량적으로 기록한다

---

## 검증 절차

### 1. 프로젝트 분석
프로젝트 구조를 파악한다:
- package.json, Makefile, Cargo.toml 등 빌드 설정 확인
- 사용 가능한 테스트 러너, 린터, 타입 체커 식별

### 2. 테스트 실행
프로젝트의 테스트 러너를 파악하여 실행:
- Node: \`npm test\` / \`npx jest\` / \`npx vitest\`
- Java: \`mvn test\` / \`gradle test\`
- Python: \`pytest\`
- Go: \`go test ./...\`
- 테스트 프레임워크가 없으면 그 사실을 기록한다

### 3. 린트/타입 체크
프로젝트의 린터/타입 체커를 실행:
- ESLint: \`npx eslint .\`
- TypeScript: \`npx tsc --noEmit\`
- Prettier: \`npx prettier --check .\`
- 린터가 없으면 그 사실을 기록한다

### 4. 결과 기록
verification.md에 다음을 포함:
- 테스트 실행 결과 (통과/실패/스킵)
- 린트 결과 (에러/경고 수)
- 타입 체크 결과
- 전체 검증 verdict (PASS/FAIL)
- 실패 시 구체적 원인과 실패 항목 상세

---

## verification.md 작성

검증 완료 후 아티팩트 디렉토리에 verification.md를 반드시 작성한다.
다음 형식을 따른다:

# Verification Report

## Summary
- **Verdict:** PASS/FAIL
- **Timestamp:** (ISO 8601)

## Test Results
- Total: N
- Passed: N
- Failed: N
- Skipped: N

## Lint Results
- Errors: N
- Warnings: N

## Type Check
- Status: PASS/FAIL/N/A
- Errors: N

## Details
(상세 결과 및 실패 항목)

---

## 중요
- 소스 코드를 절대 수정하지 않는다
- 검증 결과를 있는 그대로 기록한다 — 결과를 미화하지 않는다
- verification.md를 반드시 작성한다
`;

/**
 * Write verification.md artifact to the artifact directory.
 * @param {string} artifactDir - Directory to write artifacts to
 * @param {string} content - Verification content from agent
 */
function writeVerificationArtifact(artifactDir, content) {
  const filePath = path.join(artifactDir, "verification.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Run SDK validator for a pipeline verify step.
 *
 * Single-stage Sonnet verification:
 * 1. Agent analyzes project structure
 * 2. Runs tests, lint, type checks
 * 3. Writes verification.md with results
 *
 * @param {Object} opts
 * @param {string} opts.step - Pipeline step name (e.g. 'verify')
 * @param {string} opts.artifactDir - Directory for verification artifacts
 * @param {string} opts.cwd - Project root working directory
 * @param {string} [opts.pipelineSlug] - Pipeline identifier for worktree isolation.
 *   When provided, a git worktree is created before SDK execution and the agent
 *   runs inside the isolated worktree. The worktree is cleaned up in a finally
 *   block regardless of success or failure. If worktree creation fails, execution
 *   falls back to the original cwd with a stderr warning.
 * @returns {Promise<Object>} Result:
 *   Success: { ok: true, step, artifact: 'verification.md', cost, model, numTurns, durationMs }
 *   SDK unavailable: { ok: false, error: 'sdk_not_available' }
 *   Failure: { ok: false, error, details, cost?, numTurns?, durationMs? }
 */
async function sdkValidate(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts))
    return { ok: false, error: "invalid_input" };
  const { step, artifactDir, cwd, pipelineSlug } = opts;

  // ─── Worktree isolation ───
  let worktreeInfo = null;
  let agentCwd = cwd;
  if (pipelineSlug) {
    try {
      worktreeInfo = worktreeManager.create({ cwd, pipelineSlug, role: 'validator' });
      agentCwd = worktreeInfo.path;
    } catch (err) {
      process.stderr.write(`[sdk-validator] worktree creation failed, running without isolation: ${err.message}\n`);
    }
  }

  // ─── Build user prompt ───
  const prompt = [
    `파이프라인 단계 "${step}"의 코드 검증을 수행하라.`,
    "",
    "## 지시사항",
    "",
    "1. 프로젝트 구조를 파악하라 (package.json, 빌드 설정 등)",
    "2. 테스트를 실행하라:",
    "   - 프로젝트의 테스트 러너를 찾아 실행 (npm test, pytest 등)",
    "   - 테스트 결과를 정확히 기록 (통과/실패/스킵 수)",
    "3. 린트/타입 체크를 실행하라:",
    "   - ESLint, TypeScript, Prettier 등 사용 가능한 도구 실행",
    "   - 에러/경고 수를 기록",
    "4. 소스 코드를 수정하지 마라 — 검증만 수행한다.",
    `5. 완료 후 ${artifactDir}/verification.md를 작성하라.`,
    "",
    "## 중요",
    "- 소스 코드를 절대 수정하지 않는다.",
    "- 모든 검증 결과를 정량적으로 기록한다.",
    "- verification.md에 전체 verdict (PASS/FAIL)를 명시한다.",
  ].join("\n");

  // ─── Call Sonnet via SDK ───
  try {
    const agentResult = await runSdkAgent({
      prompt,
      model: SONNET_MODEL,
      cwd: agentCwd,
      systemPrompt: VALIDATOR_SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      effort: "high",
    });

    // ─── SDK unavailable — return without writing artifacts ───
    if (agentResult.error === "sdk_not_available") {
      return { ok: false, error: "sdk_not_available" };
    }

    // ─── SDK error — return error details ───
    if (!agentResult.ok) {
      return {
        ok: false,
        error: agentResult.error,
        details: agentResult.details,
        cost: agentResult.cost || 0,
        numTurns: agentResult.numTurns,
        durationMs: agentResult.durationMs || 0,
      };
    }

    // ─── Success — write verification.md if agent didn't already ───
    const verificationPath = path.join(artifactDir, "verification.md");
    if (!fs.existsSync(verificationPath)) {
      // Agent should have written it, but as a safety net,
      // write the result text as the verification report
      const fallbackContent = [
        "# Verification Report",
        "",
        "## Summary",
        `- **Step:** ${step}`,
        `- **Verdict:** UNKNOWN (agent did not write verification.md)`,
        `- **Model:** ${agentResult.model || SONNET_MODEL}`,
        `- **Cost:** $${(agentResult.cost || 0).toFixed(4)}`,
        `- **Turns:** ${agentResult.numTurns || "N/A"}`,
        `- **Duration:** ${agentResult.durationMs || 0}ms`,
        `- **Timestamp:** ${new Date().toISOString()}`,
        "",
        "---",
        "",
        agentResult.result || "(no result text)",
      ].join("\n");

      writeVerificationArtifact(artifactDir, fallbackContent);
    }

    return {
      ok: true,
      step,
      artifact: "verification.md",
      cost: agentResult.cost || 0,
      model: agentResult.model || SONNET_MODEL,
      numTurns: agentResult.numTurns,
      durationMs: agentResult.durationMs || 0,
    };
  } finally {
    if (worktreeInfo) {
      try {
        worktreeManager.remove({ cwd, worktreePath: worktreeInfo.path, force: true });
      } catch (err) {
        process.stderr.write(`[sdk-validator] worktree cleanup failed: ${err.message}\n`);
      }
    }
  }
}

module.exports = { sdkValidate };
