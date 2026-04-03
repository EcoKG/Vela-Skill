#!/bin/bash
# ⛵ Vela SDK Fixes Verification — 8건 전수 검증
# Usage: bash tests/test-sdk-fixes.sh
set -uo pipefail

PASS=0
FAIL=0
TOTAL=8

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

cd "$(dirname "$0")/.."
echo "⛵ Vela SDK Fixes Verification (${TOTAL} tests)"
echo "================================================"
echo ""

# ─── R001: loadSdk() tier-2 fallback ───
echo "R001: loadSdk() tier-2 fallback"
SDK_RUNNER_T2=$(grep -c 'fall through to tier 2' scripts/shared/sdk-runner.js || true)
SDK_CUSTOM_T2=$(grep -c 'fall through to tier 2' scripts/shared/sdk-custom-tools.js || true)
if [ "${SDK_RUNNER_T2}" -ge 1 ] 2>/dev/null && [ "${SDK_CUSTOM_T2}" -ge 1 ] 2>/dev/null; then
  pass "sdk-runner.js (${SDK_RUNNER_T2}) + sdk-custom-tools.js (${SDK_CUSTOM_T2}) 모두 tier-2 경로 존재"
else
  fail "tier-2 fallback 누락 — runner:${SDK_RUNNER_T2}, custom:${SDK_CUSTOM_T2}"
fi
echo ""

# ─── R002: vela-pipeline.js --force 전달 ───
echo "R002: vela-pipeline.js --force 전달"
FORCE_LINE=$(grep -c 'hasFlag.*force.*engineArgs\|engineArgs.*push.*force' scripts/cli/vela-pipeline.js || true)
if [ "${FORCE_LINE}" -ge 1 ] 2>/dev/null; then
  pass "--force가 engineArgs에 전달됨"
else
  fail "--force 전달 코드 없음"
fi
echo ""

# ─── R003: MODEL_VERSIONS alias ───
echo "R003: MODEL_VERSIONS alias (날짜 고정 아닌 haiku/sonnet/opus)"
MODELS=$(node -e "const {MODEL_VERSIONS}=require('./scripts/shared/constants'); console.log(JSON.stringify(MODEL_VERSIONS))")
if echo "$MODELS" | grep -q '"HAIKU":"haiku"' && \
   echo "$MODELS" | grep -q '"SONNET":"sonnet"' && \
   echo "$MODELS" | grep -q '"OPUS":"opus"' && \
   ! echo "$MODELS" | grep -q '\-[0-9]\{8\}'; then
  pass "MODEL_VERSIONS = ${MODELS}"
else
  fail "MODEL_VERSIONS 이상 — ${MODELS}"
fi
echo ""

# ─── R004: maxBudgetUsd 제거 ───
echo "R004: maxBudgetUsd 완전 제거"
BUDGET_REFS=$(grep -rl 'maxBudgetUsd\|MAX_BUDGET_USD\|BUDGET_MAP\|OPUS_BUDGET' \
  scripts/shared/sdk-runner.js \
  scripts/shared/sdk-analyzer.js \
  scripts/shared/sdk-reviewer.js \
  scripts/shared/sdk-researcher.js \
  scripts/shared/sdk-plan-checker.js \
  scripts/shared/sdk-executor.js \
  scripts/cli/vela-pipeline.js 2>/dev/null | wc -l || true)
if [ "${BUDGET_REFS}" -eq 0 ] 2>/dev/null; then
  pass "maxBudgetUsd/MAX_BUDGET_USD/BUDGET_MAP/OPUS_BUDGET 참조 0건"
else
  fail "예산 참조 잔존 파일 ${BUDGET_REFS}개"
  grep -rn 'maxBudgetUsd\|MAX_BUDGET_USD\|BUDGET_MAP\|OPUS_BUDGET' \
    scripts/shared/sdk-*.js scripts/cli/vela-pipeline.js 2>/dev/null | head -5
fi
echo ""

# ─── R005: MODEL_MAP opus 포함 ───
echo "R005: vela-analyze MODEL_MAP opus 포함"
OPUS_IN_FILE=$(grep -c "opus.*MODEL_VERSIONS.OPUS" scripts/cli/vela-analyze.js || true)
OPUS_RUNTIME=$(node -e "
  const m = require('./scripts/cli/vela-analyze');
  // MODULE_MAP is internal — check via analyze.js source
  process.exit(0);
" 2>/dev/null && echo "ok" || echo "fail")
if [ "${OPUS_IN_FILE}" -ge 1 ] 2>/dev/null; then
  pass "MODEL_MAP에 opus 존재 (소스 ${OPUS_IN_FILE}건)"
else
  fail "MODEL_MAP opus 누락 — file:${OPUS_IN_FILE}"
fi
echo ""

# ─── R006: in 연산자 검증 ───
echo "R006: MODEL_MAP 검증이 in 연산자 사용"
IN_OP=$(grep -c 'in MODEL_MAP' scripts/cli/vela-analyze.js || true)
BANG_OP=$(grep -c '!MODEL_MAP\[' scripts/cli/vela-analyze.js || true)
if [ "${IN_OP}" -ge 2 ] 2>/dev/null && [ "${BANG_OP}" -eq 0 ] 2>/dev/null; then
  pass "in 연산자 ${IN_OP}건, falsy 검증 ${BANG_OP}건"
else
  fail "in:${IN_OP}, !MODEL_MAP[:${BANG_OP}"
fi
echo ""

# ─── R007: CLI 레퍼런스/서브스킬 opus ───
echo "R007: CLI 레퍼런스 + 서브스킬 opus 포함"
CLI_REF_OPUS=$(grep -c 'haiku|sonnet|opus' references/cli-reference.md || true)
SKILL_OPUS=$(grep -c 'Opus' skills/analyze/SKILL.md || true)
MAIN_SKILL_OPUS=$(grep -c 'Opus' SKILL.md || true)
if [ "${CLI_REF_OPUS}" -ge 1 ] 2>/dev/null && [ "${SKILL_OPUS}" -ge 1 ] 2>/dev/null && [ "${MAIN_SKILL_OPUS}" -ge 1 ] 2>/dev/null; then
  pass "cli-reference(${CLI_REF_OPUS}) + subskill(${SKILL_OPUS}) + SKILL.md(${MAIN_SKILL_OPUS})"
else
  fail "opus 누락 — ref:${CLI_REF_OPUS}, subskill:${SKILL_OPUS}, main:${MAIN_SKILL_OPUS}"
fi
echo ""

# ─── R008: sdkAnalyze() perspectives destructuring ───
echo "R008: sdkAnalyze() perspectives destructuring 정상"
DESTR=$(grep -c 'const.*perspectives.*=.*opts' scripts/shared/sdk-analyzer.js || true)
RUNTIME_OK=$(timeout 5 node -e "
  const {sdkAnalyze}=require('./scripts/shared/sdk-analyzer');
  sdkAnalyze({perspectives:[],cwd:'.'}).then(r=>{
    console.log(r.ok ? 'ok' : 'fail');
  });
" 2>/dev/null || echo "timeout")
if [ "${DESTR}" -ge 1 ] 2>/dev/null && [ "${RUNTIME_OK}" = "ok" ]; then
  pass "destructuring 존재 + 런타임 정상 (${RUNTIME_OK})"
else
  fail "destructuring:${DESTR}, runtime:${RUNTIME_OK}"
fi
echo ""

# ─── Summary ───
echo "================================================"
echo "⛵ Results: ${PASS}/${TOTAL} PASS, ${FAIL} FAIL"
echo "================================================"

if [ "$FAIL" -eq 0 ]; then
  echo "✅ All tests passed!"
  exit 0
else
  echo "❌ ${FAIL} test(s) failed."
  exit 1
fi
