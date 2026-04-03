#!/usr/bin/env node
/**
 * poc-sdk-orchestrator.js — SDK 오케스트레이터 핵심 위험 PoC
 *
 * 6가지 핵심 메커니즘을 E2E로 검증:
 *   Test 1: PreToolUse hooks 콜백 deny → Write 차단
 *   Test 2: disallowedTools → Write/Edit 차단
 *   Test 3: tools + permissionMode:acceptEdits → 허용 도구만 사용
 *   Test 4: settingSources:[] + cwd → 파일 접근
 *   Test 5: OAuth 인증 상속
 *   Test 6: PostToolUse hooks 콜백 → 데이터 수신
 *
 * 실행: node scripts/tests/poc-sdk-orchestrator.js
 * 요구: claude CLI 인증 완료 (@anthropic-ai/claude-agent-sdk 설치)
 */

"use strict";

const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DENY_FILE = path.join(PROJECT_ROOT, "test-deny.txt");

// ── Helpers ──────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const results = [];

function report(testNum, name, passed, detail) {
  const status = passed ? "PASS" : "FAIL";
  const icon = passed ? "✅" : "❌";
  if (passed) passCount++;
  else failCount++;
  results.push({ testNum, name, passed, detail });
  console.log(`${icon} Test ${testNum}: ${name} — ${status}`);
  if (detail) console.log(`   ${detail}`);
}

async function loadSdk() {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return sdk;
  } catch (_) {
    // fall through to global fallback
  }
  try {
    const { globalImport } = require("../shared/global-require");
    const sdk = await globalImport("@anthropic-ai/claude-agent-sdk");
    return sdk;
  } catch (err) {
    console.error("SDK 로드 실패:", err.message);
    process.exit(1);
  }
}

/**
 * Consume an SDK query generator, collecting messages.
 * Returns { result, messages, toolEvents }.
 */
async function consumeQuery(gen) {
  const messages = [];
  const toolEvents = [];
  let result = null;

  for await (const msg of gen) {
    messages.push(msg);

    if (msg.type === "result") {
      result = msg;
    }
  }

  return { result, messages, toolEvents };
}

// ── Tests ────────────────────────────────────────────────────

async function test1_preToolUseDeny(sdk) {
  console.log("\n── Test 1: PreToolUse hooks 콜백 deny 검증 ──");

  // Clean up any prior leftover
  if (fs.existsSync(DENY_FILE)) fs.unlinkSync(DENY_FILE);

  let hookCalled = false;
  let blockedToolName = null;

  try {
    const gen = sdk.query({
      prompt:
        'Create a file called test-deny.txt with content "hello". Use the Write tool to create it.',
      options: {
        cwd: PROJECT_ROOT,
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        hooks: {
          PreToolUse: [
            {
              matcher: "Write",
              hooks: [
                async (input, _toolUseID, _opts) => {
                  hookCalled = true;
                  blockedToolName = input.tool_name;
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason:
                        "PoC test: Write blocked by PreToolUse hook",
                    },
                  };
                },
              ],
            },
          ],
        },
      },
    });

    await consumeQuery(gen);
  } catch (err) {
    // Query may throw if all tool uses are denied — that's expected
  }

  const fileCreated = fs.existsSync(DENY_FILE);

  // Cleanup
  if (fileCreated) fs.unlinkSync(DENY_FILE);

  const passed = hookCalled && blockedToolName === "Write" && !fileCreated;
  report(
    1,
    "PreToolUse hooks deny → Write 차단",
    passed,
    `hookCalled=${hookCalled}, blockedTool=${blockedToolName}, fileCreated=${fileCreated}`,
  );
}

async function test2_disallowedTools(sdk) {
  console.log("\n── Test 2: disallowedTools 검증 ──");

  let usedTools = [];

  try {
    const gen = sdk.query({
      prompt:
        "List the files in the current directory. Use only the Glob tool. Do NOT use Write or Edit.",
      options: {
        cwd: PROJECT_ROOT,
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        disallowedTools: ["Write", "Edit"],
        hooks: {
          PostToolUse: [
            {
              hooks: [
                async (input, _toolUseID, _opts) => {
                  usedTools.push(input.tool_name);
                  return { continue: true };
                },
              ],
            },
          ],
        },
      },
    });

    const { result } = await consumeQuery(gen);

    const usedForbidden = usedTools.some((t) => t === "Write" || t === "Edit");
    const querySucceeded = result && result.subtype === "success";

    report(
      2,
      "disallowedTools → Write/Edit 미사용",
      querySucceeded && !usedForbidden,
      `result=${result?.subtype}, tools=[${usedTools.join(",")}], forbidden=${usedForbidden}`,
    );
  } catch (err) {
    report(
      2,
      "disallowedTools → Write/Edit 미사용",
      false,
      `error: ${err.message}`,
    );
  }
}

async function test3_toolsAndPermissionMode(sdk) {
  console.log("\n── Test 3: tools + permissionMode 검증 ──");

  let usedTools = [];

  try {
    const gen = sdk.query({
      prompt:
        'Use the Read tool to read the file "package.json" and tell me the project name. You must use the Read tool.',
      options: {
        cwd: PROJECT_ROOT,
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 5,
        tools: ["Read", "Grep", "Glob"],
        hooks: {
          PostToolUse: [
            {
              hooks: [
                async (input, _toolUseID, _opts) => {
                  usedTools.push(input.tool_name);
                  return { continue: true };
                },
              ],
            },
          ],
        },
      },
    });

    const { result } = await consumeQuery(gen);

    const onlyAllowed = usedTools.every((t) =>
      ["Read", "Grep", "Glob"].includes(t),
    );
    const querySucceeded = result && result.subtype === "success";
    // Verify Write/Bash were never used (they're not in tools list)
    const noForbidden = !usedTools.some((t) =>
      ["Write", "Edit", "Bash"].includes(t),
    );

    report(
      3,
      "tools 제한 → 허용 도구만 사용",
      querySucceeded && onlyAllowed && noForbidden,
      `result=${result?.subtype}, tools=[${usedTools.join(",")}], onlyAllowed=${onlyAllowed}`,
    );
  } catch (err) {
    report(3, "tools 제한 → 허용 도구만 사용", false, `error: ${err.message}`);
  }
}

async function test4_settingSourcesAndCwd(sdk) {
  console.log("\n── Test 4: settingSources + cwd 검증 ──");

  try {
    const gen = sdk.query({
      prompt:
        'Read the file package.json and tell me the "version" field value. Reply with just the version number.',
      options: {
        cwd: PROJECT_ROOT,
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        tools: ["Read"],
      },
    });

    const { result } = await consumeQuery(gen);

    // Read the actual version for comparison
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
    );
    const actualVersion = pkg.version;
    const resultText = result?.result || "";
    const containsVersion = resultText.includes(actualVersion);

    report(
      4,
      "settingSources:[] + cwd → 파일 정상 읽기",
      result?.subtype === "success" && containsVersion,
      `result=${result?.subtype}, version=${actualVersion}, inResult=${containsVersion}`,
    );
  } catch (err) {
    report(
      4,
      "settingSources:[] + cwd → 파일 정상 읽기",
      false,
      `error: ${err.message}`,
    );
  }
}

async function test5_oauthAuth(sdk) {
  console.log("\n── Test 5: OAuth 인증 검증 ──");

  // The goal: verify that SDK query() works with OAuth (no explicit API key).
  // We detect whether ANTHROPIC_API_KEY is set.
  // If it IS set, we note that API key is being used (test still valid but not pure OAuth).
  // If it's NOT set, a successful query proves OAuth works.

  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const authMode = hasApiKey ? "API_KEY" : "OAuth";

  try {
    const gen = sdk.query({
      prompt: 'Reply with exactly: "auth_ok"',
      options: {
        cwd: PROJECT_ROOT,
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        tools: [],
      },
    });

    const { result } = await consumeQuery(gen);

    const querySucceeded = result && result.subtype === "success";

    report(
      5,
      `인증 동작 확인 (mode=${authMode})`,
      querySucceeded,
      `result=${result?.subtype}, authMode=${authMode}, cost=$${result?.total_cost_usd?.toFixed(4) || "N/A"}`,
    );
  } catch (err) {
    report(
      5,
      `인증 동작 확인 (mode=${authMode})`,
      false,
      `error: ${err.message}`,
    );
  }
}

async function test6_postToolUseHook(sdk) {
  console.log("\n── Test 6: PostToolUse hooks 콜백 검증 ──");

  let postToolUseCalled = false;
  let capturedToolName = null;
  let capturedHasResponse = false;

  try {
    const gen = sdk.query({
      prompt:
        'Use the Glob tool to list all .json files in the current directory. Pattern: "*.json"',
      options: {
        cwd: PROJECT_ROOT,
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        hooks: {
          PostToolUse: [
            {
              hooks: [
                async (input, _toolUseID, _opts) => {
                  postToolUseCalled = true;
                  capturedToolName = input.tool_name;
                  capturedHasResponse = input.tool_response != null;
                  return { continue: true };
                },
              ],
            },
          ],
        },
      },
    });

    await consumeQuery(gen);

    report(
      6,
      "PostToolUse hooks 콜백 → 데이터 수신",
      postToolUseCalled && capturedToolName != null && capturedHasResponse,
      `called=${postToolUseCalled}, tool=${capturedToolName}, hasResponse=${capturedHasResponse}`,
    );
  } catch (err) {
    report(
      6,
      "PostToolUse hooks 콜백 → 데이터 수신",
      false,
      `error: ${err.message}`,
    );
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  SDK Orchestrator PoC — 핵심 위험 퇴치 검증");
  console.log("  SDK version: @anthropic-ai/claude-agent-sdk");
  console.log(`  Project root: ${PROJECT_ROOT}`);
  console.log("═══════════════════════════════════════════════════");

  const sdk = await loadSdk();
  console.log(
    `SDK loaded successfully. query() available: ${typeof sdk.query === "function"}`,
  );

  // Run tests sequentially — each spawns a real Claude Code process
  await test1_preToolUseDeny(sdk);
  await test2_disallowedTools(sdk);
  await test3_toolsAndPermissionMode(sdk);
  await test4_settingSourcesAndCwd(sdk);
  await test5_oauthAuth(sdk);
  await test6_postToolUseHook(sdk);

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  Results: ${passCount}/${passCount + failCount} PASS`);
  console.log("═══════════════════════════════════════════════════");

  if (failCount > 0) {
    console.log("\nFailed tests:");
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  ❌ Test ${r.testNum}: ${r.name}`);
        if (r.detail) console.log(`     ${r.detail}`);
      });
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
