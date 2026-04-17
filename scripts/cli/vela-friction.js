#!/usr/bin/env node
/**
 * ⛵ Vela Friction Report — gate-events.jsonl 집계 전담 CLI
 *
 * 훅(vela-gate, vela-stop 등)이 차단/질문/경고할 때마다
 * .vela/state/gate-events.jsonl 에 한 줄 JSON을 남긴다. 이 CLI는 그 로그를
 * 집계해 "어떤 VK/VG 코드가 자주 터지는가, 어느 단계에서 터지는가, 현재
 * 정책이 과한 마찰을 일으키는가"를 한 화면에 보여준다.
 *
 * v7.3-M1b에서 scripts/cli/vela-analyze.js의 friction 로직만 분리한 모듈.
 * 원본 vela-analyze.js는 deps/PDF 기능과 함께 제거되었고, friction 리포트는
 * /vela:analyze 스킬과 독립적으로 운영되어 의존성이 가볍다.
 *
 * Usage:
 *   node vela-friction.js [--limit N] [--json]
 *
 * Options:
 *   --limit N    최근 N개 이벤트만 집계 (default: 500)
 *   --json       기계 판독 JSON 출력 (default: 한글 요약 텍스트)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const limitIdx = args.indexOf("--limit");
const limit =
  limitIdx !== -1 && /^\d+$/.test(args[limitIdx + 1] || "")
    ? parseInt(args[limitIdx + 1], 10)
    : 500;

function runFrictionReport({ cwd, limit, asJson }) {
  const p = path.join(cwd, ".vela", "state", "gate-events.jsonl");
  if (!fs.existsSync(p)) {
    const msg =
      "No gate events recorded yet (.vela/state/gate-events.jsonl missing).";
    if (asJson) {
      console.log(JSON.stringify({ ok: true, events: 0, note: msg }, null, 2));
    } else {
      console.log(msg);
    }
    return 0;
  }

  const raw = fs.readFileSync(p, "utf8");
  const all = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Tail the most recent `limit` events — old logs are preserved on
  // disk but would skew current friction measurements.
  const events = all.slice(-limit);
  const byCode = new Map();
  const byStepCode = new Map();
  const byDecision = new Map();
  for (const e of events) {
    const code = e.code || "UNKNOWN";
    const step = e.step || "(none)";
    const decision = e.decision || "deny";
    byCode.set(code, (byCode.get(code) || 0) + 1);
    byDecision.set(decision, (byDecision.get(decision) || 0) + 1);
    const key = `${step}|${code}`;
    byStepCode.set(key, (byStepCode.get(key) || 0) + 1);
  }

  const topCodes = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const topStepCode = [...byStepCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => {
      const [step, code] = key.split("|");
      return { step, code, count };
    });

  // Surface a tiny set of actionable suggestions based on patterns.
  // Hard-coded heuristics — extending this table is cheap and data-driven.
  const suggestions = [];
  const vk08 = byCode.get("VK-08") || 0;
  const vk10 = byCode.get("VK-10") || 0;
  const m11 = byCode.get("M11") || 0;
  if (vk08 >= 10) {
    suggestions.push(
      `VK-08 (체인 연산자) ${vk08}회 — .vela/config.json의 gate_policy.chain_operator를 "ask"로 설정 고려`,
    );
  }
  if (vk10 >= 5) {
    suggestions.push(
      `VK-10 (write 모드 WebFetch) ${vk10}회 — gate_policy.web_in_write를 "ask"로 설정하거나 research 단계에서 조회하도록 PM 재조정`,
    );
  }
  if (m11 >= 5) {
    suggestions.push(
      `M11 (researcher scope) ${m11}회 — locate 단계의 targets.json이 실제 범위보다 좁음. gate_policy.researcher_scope="warn"으로 완화 고려`,
    );
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          events: events.length,
          total: all.length,
          byCode: Object.fromEntries(topCodes),
          byDecision: Object.fromEntries(byDecision),
          topStepCode,
          suggestions,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`⛵ Vela Gate Friction Report`);
  console.log(`─────────────────────────────`);
  console.log(
    `총 이벤트: ${events.length} (전체 ${all.length}개 중 최근 ${limit} 분석)`,
  );
  console.log(``);
  console.log(`결정 분포:`);
  for (const [decision, count] of byDecision.entries()) {
    console.log(`  ${decision.padEnd(8)} ${count}`);
  }
  console.log(``);
  console.log(`상위 코드:`);
  for (const [code, count] of topCodes) {
    console.log(`  ${code.padEnd(8)} ${count}`);
  }
  console.log(``);
  console.log(`상위 (step × code):`);
  for (const { step, code, count } of topStepCode) {
    console.log(`  ${step.padEnd(14)} ${code.padEnd(8)} ${count}`);
  }
  console.log(``);
  if (suggestions.length === 0) {
    console.log(`제안: 현재 friction 수준이 낮음 — 정책 조정 불필요.`);
  } else {
    console.log(`제안:`);
    for (const s of suggestions) {
      console.log(`  - ${s}`);
    }
  }
  return 0;
}

if (require.main === module) {
  const code = runFrictionReport({ cwd: process.cwd(), limit, asJson });
  process.exit(code);
}

module.exports = { runFrictionReport };
