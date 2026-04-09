/**
 * Vela SDK Analyzer
 * 5-perspective parallel code analysis engine using SDK agents.
 * Runs security, bugs, performance, code-quality, architecture analysis
 * concurrently via Promise.allSettled() and returns normalized JSON findings.
 *
 * Perspectives:
 * - Security: auth vulnerabilities, injection, credential exposure, data leaks
 * - Bugs: logic errors, race conditions, null refs, error handling gaps
 * - Performance: N+1 queries, memory leaks, algorithmic complexity, I/O bottlenecks
 * - Code-quality: naming, duplication, coupling, readability, dead code
 * - Architecture: layer separation, dependency direction, abstraction, module boundaries
 *
 * Each perspective agent outputs JSON with structured findings.
 * extractFindings() handles free-form responses with embedded JSON blocks.
 *
 * Exports: sdkAnalyze({ perspectives, cwd, model })
 *
 * Design decisions:
 * - settingSources: [] passed through runSdkAgent (D014 — hook isolation)
 * - All perspective prompts inlined as constants because SDK agents cannot read project files
 * - Promise.allSettled() — partial failures still produce results with available perspectives
 * - SDK unavailable returns { ok: false, error: 'sdk_not_available' } — never throws
 * - [PERSPECTIVE:xxx] markers enable test mock differentiation (K012)
 */

"use strict";

const { runSdkAgent } = require("./sdk-runner");
const { MODEL_VERSIONS } = require("./constants");

// ─── Model Constants ───
const HAIKU_MODEL = MODEL_VERSIONS.HAIKU;
const SONNET_MODEL = MODEL_VERSIONS.SONNET;
// ─── Structured output schema (K011 pattern — module-local) ───
const ANALYZER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          severity: {
            type: "string",
            enum: ["critical", "high", "moderate", "low", "info"],
          },
          file: { type: "string" },
          line: { type: "number" },
          description: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
  required: ["findings"],
};

// ─── Finding schema reference (inlined in each prompt) ───
const FINDING_SCHEMA = `{
  "findings": [
    {
      "name": "Finding short title",
      "severity": "critical|high|moderate|low|info",
      "file": "path/to/file.js",
      "line": 42,
      "description": "What the issue is and why it matters",
      "suggestion": "How to fix it"
    }
  ]
}`;

// ─── Severity levels reference (inlined in each prompt) ───
const SEVERITY_LEVELS = `Severity levels:
- critical: Exploitable vulnerability, data loss, or system crash in production
- high: Significant bug or security gap that will cause issues under normal use
- moderate: Code smell or risk that should be addressed but is not immediately dangerous
- low: Minor improvement opportunity, style issue, or edge case
- info: Observation or recommendation with no immediate risk`;

// ─── Perspective Configurations ───
// Each entry: key, label (Korean), systemPrompt with [PERSPECTIVE:xxx] marker (K012)

const PERSPECTIVES = {
  security: {
    key: "security",
    label: "보안 분석",
    systemPrompt: `[PERSPECTIVE:security]

# 보안 분석 에이전트

당신은 코드 보안 전문 분석 에이전트입니다.
코드베이스를 탐색하여 보안 취약점을 찾고 구조화된 JSON으로 보고합니다.

## 분석 대상
- 인증/인가 취약점 (미들웨어 바이패스, 권한 상승, 세션 관리)
- 입력 검증 부재 (SQL injection, XSS, CSRF, path traversal, command injection)
- 비밀키/자격증명 하드코딩 또는 로그 노출
- 불안전한 암호화 (평문 저장, 약한 해시, HTTP 사용)
- 데이터 노출 (에러 메시지 정보 유출, 과도한 로깅)
- 의존성 보안 (알려진 CVE 패턴)

## 출력 형식

반드시 아래 JSON 형식으로 출력하라. 마크다운 코드 블록(\`\`\`json)으로 감싸라.

\`\`\`json
${FINDING_SCHEMA}
\`\`\`

${SEVERITY_LEVELS}

## 출력 예시

\`\`\`json
{
  "findings": [
    {
      "name": "SQL Injection in user query",
      "severity": "critical",
      "file": "src/db/users.js",
      "line": 23,
      "description": "User input is directly interpolated into SQL query without parameterization",
      "suggestion": "Use parameterized queries: db.query('SELECT * FROM users WHERE id = ?', [userId])"
    }
  ]
}
\`\`\`

발견 사항이 없으면 빈 배열을 반환하라: \`{"findings": []}\`
`,
  },

  bugs: {
    key: "bugs",
    label: "버그 분석",
    systemPrompt: `[PERSPECTIVE:bugs]

# 버그 분석 에이전트

당신은 코드 버그 탐지 전문 분석 에이전트입니다.
코드베이스를 탐색하여 잠재적 버그와 논리 오류를 찾고 구조화된 JSON으로 보고합니다.

## 분석 대상
- 논리 오류 (off-by-one, 잘못된 조건문, 누락된 분기)
- Null/undefined 참조 (옵셔널 체이닝 누락, 타입 가드 부재)
- 레이스 컨디션 (비동기 순서 의존, 공유 상태 변경)
- 에러 처리 갭 (catch 누락, 에러 삼킴, 미처리 Promise rejection)
- 리소스 누수 (파일 핸들, 커넥션, 이벤트 리스너 미정리)
- 엣지 케이스 미처리 (빈 배열, 빈 문자열, 경계값)
- 타입 불일치 (암묵적 형변환, 잘못된 비교)

## 출력 형식

반드시 아래 JSON 형식으로 출력하라. 마크다운 코드 블록(\`\`\`json)으로 감싸라.

\`\`\`json
${FINDING_SCHEMA}
\`\`\`

${SEVERITY_LEVELS}

## 출력 예시

\`\`\`json
{
  "findings": [
    {
      "name": "Unhandled Promise rejection in API call",
      "severity": "high",
      "file": "src/api/client.js",
      "line": 45,
      "description": "fetch() call lacks .catch() handler — unhandled rejection will crash the process in Node 18+",
      "suggestion": "Add try/catch around the await or chain .catch() to handle network failures"
    }
  ]
}
\`\`\`

발견 사항이 없으면 빈 배열을 반환하라: \`{"findings": []}\`
`,
  },

  performance: {
    key: "performance",
    label: "성능 분석",
    systemPrompt: `[PERSPECTIVE:performance]

# 성능 분석 에이전트

당신은 코드 성능 최적화 전문 분석 에이전트입니다.
코드베이스를 탐색하여 성능 병목과 비효율을 찾고 구조화된 JSON으로 보고합니다.

## 분석 대상
- 알고리즘 복잡도 (O(n²) 이상의 불필요한 루프, 비효율적 탐색)
- N+1 쿼리 패턴 (루프 내 DB/API 호출)
- 메모리 누수 (전역 캐시 무한 증가, 클로저 참조 유지)
- I/O 병목 (동기 파일 I/O, 직렬 네트워크 호출)
- 번들 크기 (불필요한 의존성, tree-shaking 불가 import)
- 캐싱 부재 (반복 계산, 중복 요청)
- 렌더링 성능 (불필요한 리렌더, 레이아웃 스래싱)

## 출력 형식

반드시 아래 JSON 형식으로 출력하라. 마크다운 코드 블록(\`\`\`json)으로 감싸라.

\`\`\`json
${FINDING_SCHEMA}
\`\`\`

${SEVERITY_LEVELS}

## 출력 예시

\`\`\`json
{
  "findings": [
    {
      "name": "Synchronous file read in request handler",
      "severity": "high",
      "file": "src/handlers/config.js",
      "line": 12,
      "description": "fs.readFileSync() blocks the event loop on every request — will cause latency spikes under load",
      "suggestion": "Use fs.promises.readFile() or cache the config at startup"
    }
  ]
}
\`\`\`

발견 사항이 없으면 빈 배열을 반환하라: \`{"findings": []}\`
`,
  },

  "code-quality": {
    key: "code-quality",
    label: "코드 품질 분석",
    systemPrompt: `[PERSPECTIVE:code-quality]

# 코드 품질 분석 에이전트

당신은 코드 품질 전문 분석 에이전트입니다.
코드베이스를 탐색하여 품질 이슈와 유지보수성 문제를 찾고 구조화된 JSON으로 보고합니다.

## 분석 대상
- 코드 중복 (DRY 위반, 복사-붙여넣기 패턴)
- 네이밍 (불명확한 변수/함수명, 일관성 없는 컨벤션)
- 함수 복잡도 (과도한 분기, 깊은 중첩, 긴 함수)
- 결합도/응집도 (god object, 순환 의존, 불필요한 결합)
- 데드 코드 (미사용 함수, 도달 불가 분기, 주석 처리된 코드)
- 에러 메시지 품질 (디버깅에 불충분한 에러 정보)
- 테스트 가능성 (하드코딩된 의존성, 전역 상태 변경)

## 출력 형식

반드시 아래 JSON 형식으로 출력하라. 마크다운 코드 블록(\`\`\`json)으로 감싸라.

\`\`\`json
${FINDING_SCHEMA}
\`\`\`

${SEVERITY_LEVELS}

## 출력 예시

\`\`\`json
{
  "findings": [
    {
      "name": "Duplicated validation logic",
      "severity": "moderate",
      "file": "src/routes/auth.js",
      "line": 34,
      "description": "Email validation regex is duplicated in 3 files — changes must be synchronized manually",
      "suggestion": "Extract to a shared validator module: utils/validators.js"
    }
  ]
}
\`\`\`

발견 사항이 없으면 빈 배열을 반환하라: \`{"findings": []}\`
`,
  },

  architecture: {
    key: "architecture",
    label: "아키텍처 분석",
    systemPrompt: `[PERSPECTIVE:architecture]

# 아키텍처 분석 에이전트

당신은 소프트웨어 아키텍처 전문 분석 에이전트입니다.
코드베이스를 탐색하여 아키텍처 이슈와 구조적 문제를 찾고 구조화된 JSON으로 보고합니다.

## 분석 대상
- 레이어 분리 (도메인/애플리케이션/인프라/인터페이스 경계 침범)
- 의존성 방향 (안쪽으로만 흘러야 함 — 역방향 의존성)
- 순환 참조 (모듈 간 상호 의존)
- 추상화 수준 (혼재된 추상화, 불충분한 인터페이스)
- 모듈 경계 (불명확한 책임, 과도한 public API)
- 확장성 (하드코딩된 설정, 확장 포인트 부재)
- 기술 부채 (TODO/FIXME/HACK 표시, 임시 코드)

## 출력 형식

반드시 아래 JSON 형식으로 출력하라. 마크다운 코드 블록(\`\`\`json)으로 감싸라.

\`\`\`json
${FINDING_SCHEMA}
\`\`\`

${SEVERITY_LEVELS}

## 출력 예시

\`\`\`json
{
  "findings": [
    {
      "name": "Domain layer depends on infrastructure",
      "severity": "high",
      "file": "src/domain/user.js",
      "line": 3,
      "description": "Domain model imports database client directly — violates dependency inversion principle",
      "suggestion": "Inject the repository interface instead of importing the concrete DB client"
    }
  ]
}
\`\`\`

발견 사항이 없으면 빈 배열을 반환하라: \`{"findings": []}\`
`,
  },
};

// ─── Valid perspective keys for validation ───
const VALID_PERSPECTIVE_KEYS = Object.keys(PERSPECTIVES);

// ─── Inject exclusion directive into all perspective system prompts ───
// Prevents SDK agents from exploring .vela/ pipeline internals as if they
// were project source code. Injected after the [PERSPECTIVE:xxx] marker line.
const EXCLUSION_DIRECTIVE = `
## 탐색 제외 디렉토리
코드베이스 탐색 시 다음 디렉토리는 건너뛴다 — 프로젝트 소스 코드가 아님:
- \`.vela/\` (Vela 파이프라인 내부 상태 및 아티팩트)
- \`node_modules/\`
- \`.git/\`
- \`dist/\`, \`build/\`, \`out/\`

`;

for (const key of VALID_PERSPECTIVE_KEYS) {
  // Insert after the first line ([PERSPECTIVE:xxx]\n)
  const prompt = PERSPECTIVES[key].systemPrompt;
  const firstNewline = prompt.indexOf("\n");
  if (firstNewline !== -1) {
    PERSPECTIVES[key].systemPrompt =
      prompt.slice(0, firstNewline + 1) +
      EXCLUSION_DIRECTIVE +
      prompt.slice(firstNewline + 1);
  }
}

/**
 * Extract structured findings from free-form SDK agent response text.
 *
 * Tries three extraction strategies in order:
 * 1. Regex match for ```json code blocks containing "findings" array
 * 2. Bare JSON object with "findings" key
 * 3. Fallback to { findings: [], summary: rawText }
 *
 * @param {string} responseText - Raw text from SDK agent response
 * @returns {{ findings: Array<Object>, summary?: string }}
 */
function extractFindings(responseText) {
  if (!responseText || typeof responseText !== "string") {
    return { findings: [], summary: "" };
  }

  // Strategy 1: Extract from ```json code block
  const jsonBlockRegex = /```json\s*\n?([\s\S]*?)```/g;
  let match;
  while ((match = jsonBlockRegex.exec(responseText)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && Array.isArray(parsed.findings)) {
        return { findings: normalizeFindingsArray(parsed.findings) };
      }
    } catch {
      // Try next match
    }
  }

  // Strategy 2: Bare JSON object with "findings" key
  const bareJsonRegex = /\{\s*"findings"\s*:\s*\[[\s\S]*?\]\s*\}/g;
  while ((match = bareJsonRegex.exec(responseText)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && Array.isArray(parsed.findings)) {
        return { findings: normalizeFindingsArray(parsed.findings) };
      }
    } catch {
      // Try next match
    }
  }

  // Strategy 3: Fallback — no structured findings extracted
  return { findings: [], summary: responseText };
}

/**
 * Normalize findings array entries to ensure consistent shape.
 * @param {Array} findings - Raw findings array
 * @returns {Array<Object>} Normalized findings
 */
function normalizeFindingsArray(findings) {
  const validSeverities = ["critical", "high", "moderate", "low", "info"];

  return findings.map((f) => ({
    name: String(f.name || "Unnamed finding"),
    severity: validSeverities.includes(f.severity) ? f.severity : "info",
    file: String(f.file || ""),
    line: typeof f.line === "number" ? f.line : null,
    description: String(f.description || ""),
    suggestion: String(f.suggestion || ""),
  }));
}

/**
 * Run parallel SDK code analysis across selected perspectives.
 *
 * Launches selected perspective agents concurrently via Promise.allSettled(),
 * extracts structured JSON findings from each, and normalizes into a unified result.
 *
 * @param {Object} opts
 * @param {string[]} opts.perspectives - Perspective keys to run (e.g. ['security', 'bugs'])
 * @param {string} opts.cwd - Project root working directory
 * @param {string} [opts.model] - Model to use (default: haiku). Accepts aliases: haiku, sonnet, opus
 *
 * settingSources: [] — passed through runSdkAgent to prevent hook loading in SDK agents
 *
 * @returns {Promise<Object>} Normalized result:
 *   { ok, perspectives: [{ perspective, ok, findings, summary?, cost, durationMs, error? }],
 *     totalCost, totalDurationMs, model }
 *   ok is true when at least one perspective succeeded, or perspectives array is empty.
 *   SDK unavailable: { ok: false, error: 'sdk_not_available' }
 */
async function sdkAnalyze(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts))
    return { ok: false, error: "invalid_input" };
  const { perspectives, cwd, model } = opts;
  // ─── Input validation ───
  if (!Array.isArray(perspectives)) {
    return { ok: false, error: "perspectives must be an array" };
  }

  if (perspectives.length === 0) {
    return {
      ok: true,
      perspectives: [],
      totalCost: 0,
      totalDurationMs: 0,
      model: model || HAIKU_MODEL,
    };
  }

  // Filter to valid perspective keys, warn on unknown ones
  const validPerspectives = [];
  const unknownKeys = [];
  for (const key of perspectives) {
    if (PERSPECTIVES[key]) {
      validPerspectives.push(key);
    } else {
      unknownKeys.push(key);
    }
  }

  if (unknownKeys.length > 0) {
    process.stderr.write(
      `[sdk-analyzer] Warning: unknown perspective keys skipped: ${unknownKeys.join(", ")}\n`,
    );
  }

  if (validPerspectives.length === 0) {
    return {
      ok: true,
      perspectives: [],
      totalCost: 0,
      totalDurationMs: 0,
      model: model || HAIKU_MODEL,
    };
  }

  const selectedModel = model || HAIKU_MODEL;
  const overallStart = Date.now();

  // ─── Launch perspectives in parallel ───
  const agentPromises = validPerspectives.map((key) => {
    const perspective = PERSPECTIVES[key];
    const userPrompt = `프로젝트 코드를 ${perspective.label} 관점에서 분석하라.\n\n코드베이스를 탐색하여 이슈를 찾고, 반드시 지정된 JSON 형식으로 결과를 출력하라.`;

    return runSdkAgent({
      prompt: userPrompt,
      model: selectedModel,
      cwd,
      systemPrompt: perspective.systemPrompt,
      effort: "medium",
      outputFormat: { type: "json", schema: ANALYZER_OUTPUT_SCHEMA },
      // settingSources: [] is set inside runSdkAgent (D014 — hook isolation)
    });
  });

  const settled = await Promise.allSettled(agentPromises);

  // ─── Collect results per perspective ───
  let hasAnyOk = false;
  let sdkUnavailableCount = 0;
  const perspectiveResults = validPerspectives.map((key, idx) => {
    const outcome = settled[idx];

    // Promise rejected (unexpected)
    if (outcome.status === "rejected") {
      return {
        perspective: key,
        ok: false,
        findings: [],
        error: outcome.reason?.message || String(outcome.reason),
        cost: 0,
        durationMs: 0,
      };
    }

    const agentResult = outcome.value;

    // SDK not available
    if (!agentResult.ok && agentResult.error === "sdk_not_available") {
      sdkUnavailableCount++;
      return {
        perspective: key,
        ok: false,
        findings: [],
        error: "sdk_not_available",
        cost: 0,
        durationMs: 0,
      };
    }

    // Agent returned error
    if (!agentResult.ok) {
      return {
        perspective: key,
        ok: false,
        findings: [],
        error: agentResult.error,
        summary: agentResult.details || undefined,
        cost: agentResult.cost || 0,
        durationMs: agentResult.durationMs || 0,
      };
    }

    // Agent succeeded — extract findings: structuredOutput first → extractFindings fallback
    hasAnyOk = true;
    let extracted;
    if (
      agentResult.structuredOutput &&
      Array.isArray(agentResult.structuredOutput.findings)
    ) {
      extracted = {
        findings: normalizeFindingsArray(agentResult.structuredOutput.findings),
      };
    } else {
      extracted = extractFindings(agentResult.result || "");
    }

    return {
      perspective: key,
      ok: true,
      findings: extracted.findings,
      summary: extracted.summary || undefined,
      cost: agentResult.cost || 0,
      durationMs: agentResult.durationMs || 0,
    };
  });

  // ─── Compute totals ───
  const totalCost = perspectiveResults.reduce((sum, p) => sum + p.cost, 0);
  const totalDurationMs = Date.now() - overallStart;

  // If ALL perspectives failed due to SDK unavailable, return top-level error
  if (sdkUnavailableCount === validPerspectives.length) {
    return {
      ok: false,
      error: "sdk_not_available",
      perspectives: perspectiveResults,
      totalCost,
      totalDurationMs,
      model: selectedModel,
    };
  }

  return {
    ok: hasAnyOk || perspectiveResults.length === 0,
    perspectives: perspectiveResults,
    totalCost,
    totalDurationMs,
    model: selectedModel,
  };
}

module.exports = { sdkAnalyze };
