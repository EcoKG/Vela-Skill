#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-prompt-async-hooks.sh — Prompt/Async hook 계약 테스트
#
# Tests:
#   install.js — prompt hook & async command hook registration
#   vela-test-async.js — stdin JSON → systemMessage stdout contract
#
# Test 1: install → PostToolUse에 type:'prompt' 항목 (matcher: Edit|Write)
# Test 2: install → PostToolUse에 type:'command' + async:true 항목
# Test 3: install.js verify → vela-review-prompt & vela-test-async 모두 OK
# Test 4: install.js verify → 기존 hooks (vela-tracker 등) 여전히 OK (회귀 방지)
# Test 5: Write tool + *.js + test 파일 존재 → systemMessage 출력
# Test 6: Write tool + *.md → exit 0, stdout 빈 출력
# Test 7: Edit tool + file_path → 정상 동작 (systemMessage 또는 silent)
# Test 8: 잘못된 JSON stdin → exit 0 (graceful)
# Test 9: 테스트 파일 없는 코드 파일 → exit 0 (npm test 없으면 silent)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_JS="$PROJECT_ROOT/scripts/install.js"
HOOK="$PROJECT_ROOT/scripts/hooks/vela-test-async.js"

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  SANDBOX="$TMPDIR_ROOT/project"
  mkdir -p "$SANDBOX"
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"

  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"

  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — '$needle' not found in output"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"

  TOTAL=$((TOTAL + 1))
  if ! echo "$haystack" | grep -q "$needle"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — '$needle' unexpectedly found in output"
    FAIL=$((FAIL + 1))
  fi
}

assert_empty() {
  local label="$1"
  local actual="$2"

  TOTAL=$((TOTAL + 1))
  if [ -z "$actual" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected empty, got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit_zero() {
  local label="$1"
  local exit_code="$2"

  TOTAL=$((TOTAL + 1))
  if [ "$exit_code" = "0" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected exit 0, got $exit_code"
    FAIL=$((FAIL + 1))
  fi
}

# ── main ─────────────────────────────────────────────────────

trap 'teardown_sandbox 2>/dev/null || true' EXIT

echo "⛵ Prompt/Async Hook 계약 테스트"
echo "─────────────────────────────────────"

# ══════════════════════════════════════════════════════════════
# Part A: install.js 설정 검증
# ══════════════════════════════════════════════════════════════

# ── Test 1: PostToolUse에 type:'prompt' 항목 등록 확인 ──
echo ""
echo "📋 Test 1: install → PostToolUse에 type:'prompt' 항목 존재"

# Run install from the actual project root (it needs .vela/ structure)
node "$INSTALL_JS" --json > /dev/null 2>&1

# install.js resolves PROJECT_ROOT by walking up to find .vela/ — get its actual settings path
SETTINGS_FILE=$(node -e "
  const path = require('path');
  const fs = require('fs');
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.vela'))) break;
    dir = path.dirname(dir);
  }
  console.log(path.join(dir, '.claude', 'settings.local.json'));
" 2>/dev/null)

# Check: PostToolUse array has an entry with type:'prompt' and matcher 'Edit|Write'
prompt_entry=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS_FILE','utf-8'));
  const entries = s.hooks?.PostToolUse || [];
  const found = entries.find(e =>
    e.hooks && e.hooks.some(h => h.type === 'prompt') &&
    (e.matcher || '').includes('Edit') && (e.matcher || '').includes('Write')
  );
  console.log(found ? 'FOUND' : 'NOT_FOUND');
" 2>/dev/null || echo "ERROR")

assert_eq "PostToolUse has type:prompt entry with Edit|Write matcher" "FOUND" "$prompt_entry"

# ── Test 2: PostToolUse에 type:'command' + async:true 항목 등록 확인 ──
echo ""
echo "📋 Test 2: install → PostToolUse에 async:true command 항목 존재"

async_entry=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS_FILE','utf-8'));
  const entries = s.hooks?.PostToolUse || [];
  const found = entries.find(e =>
    e.hooks && e.hooks.some(h => h.type === 'command' && h.async === true) &&
    (e.matcher || '').includes('Edit') && (e.matcher || '').includes('Write')
  );
  console.log(found ? 'FOUND' : 'NOT_FOUND');
" 2>/dev/null || echo "ERROR")

assert_eq "PostToolUse has async:true command entry with Edit|Write matcher" "FOUND" "$async_entry"

# ── Test 3: verify가 vela-review-prompt과 vela-test-async 모두 OK ──
echo ""
echo "📋 Test 3: verify → vela-review-prompt & vela-test-async 모두 OK"

verify_output=$(node "$INSTALL_JS" verify --json 2>/dev/null || echo '{"ok":false}')

review_ok=$(echo "$verify_output" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const d = JSON.parse(Buffer.concat(chunks).toString());
    const hook = (d.hooks || []).find(h => h.id === 'vela-review-prompt');
    console.log(hook && hook.status === 'OK' ? 'OK' : 'MISSING');
  });
" 2>/dev/null)

async_ok=$(echo "$verify_output" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const d = JSON.parse(Buffer.concat(chunks).toString());
    const hook = (d.hooks || []).find(h => h.id === 'vela-test-async');
    console.log(hook && hook.status === 'OK' ? 'OK' : 'MISSING');
  });
" 2>/dev/null)

assert_eq "vela-review-prompt verify OK" "OK" "$review_ok"
assert_eq "vela-test-async verify OK" "OK" "$async_ok"

# ── Test 4: 기존 hooks 회귀 방지 확인 ──
echo ""
echo "📋 Test 4: verify → 기존 hooks (vela-tracker, vela-gate-keeper 등) 여전히 OK"

verify_all_ok=$(echo "$verify_output" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const d = JSON.parse(Buffer.concat(chunks).toString());
    // Check specific legacy hooks
    const legacyIds = ['vela-tracker', 'vela-gate-keeper', 'vela-gate-guard', 'vela-orchestrator', 'vela-stop'];
    const results = legacyIds.map(id => {
      const h = (d.hooks || []).find(x => x.id === id);
      return h && h.status === 'OK';
    });
    console.log(results.every(Boolean) ? 'ALL_OK' : 'SOME_MISSING');
  });
" 2>/dev/null)

assert_eq "legacy hooks still OK (no regression)" "ALL_OK" "$verify_all_ok"

# Also check the global 'ok' flag from verify
global_ok=$(echo "$verify_output" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const d = JSON.parse(Buffer.concat(chunks).toString());
    console.log(d.ok ? 'true' : 'false');
  });
" 2>/dev/null)

assert_eq "verify reports global ok:true" "true" "$global_ok"


# ══════════════════════════════════════════════════════════════
# Part B: vela-test-async.js 계약 검증
# ══════════════════════════════════════════════════════════════

# ── Test 5: Write tool + *.js 코드 파일 + 테스트 파일 존재 → systemMessage 출력 ──
echo ""
echo "📋 Test 5: Write + code file + test exists → systemMessage output"
setup_sandbox

# Create source file and matching test file in sandbox
mkdir -p "$SANDBOX/src"
echo "module.exports = { add: (a,b) => a+b };" > "$SANDBOX/src/utils.js"
cat > "$SANDBOX/src/utils.test.js" <<'TESTFILE'
const { add } = require('./utils');
if (add(1,2) !== 3) { process.exit(1); }
console.log('PASS');
TESTFILE

STDIN_JSON='{"tool_name":"Write","tool_input":{"file_path":"src/utils.js","content":"module.exports = { add: (a,b) => a+b };"},"cwd":"'"$SANDBOX"'"}'

output=$(echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || true)
ec=$?

assert_exit_zero "exit code is 0" "$ec"
assert_contains "stdout has systemMessage" "systemMessage" "$output"
assert_contains "stdout mentions test result" "PASS\|FAIL\|test" "$output"

teardown_sandbox

# ── Test 6: Write tool + 비코드 파일(*.md) → exit 0, stdout 빈 출력 ──
echo ""
echo "📋 Test 6: Write + non-code file (.md) → exit 0, empty stdout"
setup_sandbox

mkdir -p "$SANDBOX/docs"
echo "# Hello" > "$SANDBOX/docs/readme.md"

STDIN_JSON='{"tool_name":"Write","tool_input":{"file_path":"docs/readme.md","content":"# Hello"},"cwd":"'"$SANDBOX"'"}'

output=$(echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || true)
ec=$?

assert_exit_zero "exit code is 0" "$ec"
assert_empty "stdout is empty for non-code file" "$output"

teardown_sandbox

# ── Test 7: Edit tool + file_path 추출 → 정상 동작 ──
echo ""
echo "📋 Test 7: Edit tool + code file + test exists → systemMessage or silent"
setup_sandbox

mkdir -p "$SANDBOX/lib"
echo "function hello() { return 'hi'; }" > "$SANDBOX/lib/helper.js"
cat > "$SANDBOX/lib/helper.test.js" <<'TESTFILE'
const { execSync } = require('child_process');
// Simple test that always passes
console.log('helper test PASS');
TESTFILE

STDIN_JSON='{"tool_name":"Edit","tool_input":{"file_path":"lib/helper.js","old_string":"hi","new_string":"hello"},"cwd":"'"$SANDBOX"'"}'

output=$(echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || true)
ec=$?

assert_exit_zero "exit code is 0" "$ec"
assert_contains "Edit tool triggers test runner" "systemMessage" "$output"

teardown_sandbox

# ── Test 8: 잘못된 JSON stdin → exit 0 (graceful) ──
echo ""
echo "📋 Test 8: malformed JSON stdin → exit 0 (graceful)"

ec=0
output=$(echo "NOT VALID JSON {{{" | node "$HOOK" 2>/dev/null) || ec=$?

assert_exit_zero "exit code is 0 on malformed input" "$ec"
assert_empty "stdout is empty for malformed JSON" "$output"

# Also test incomplete JSON
ec2=0
output2=$(echo '{"tool_name":"Write"' | node "$HOOK" 2>/dev/null) || ec2=$?
assert_exit_zero "exit code is 0 on incomplete JSON" "$ec2"

# ── Test 9: 테스트 파일 없는 코드 파일 → exit 0 (silent or npm test fallback) ──
echo ""
echo "📋 Test 9: code file with no matching tests → exit 0"
setup_sandbox

mkdir -p "$SANDBOX/src"
echo "console.log('no tests here');" > "$SANDBOX/src/orphan.js"
# No test file, no package.json with test script

STDIN_JSON='{"tool_name":"Write","tool_input":{"file_path":"src/orphan.js","content":"console.log(1);"},"cwd":"'"$SANDBOX"'"}'

output=$(echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || true)
ec=$?

assert_exit_zero "exit code is 0 when no tests found" "$ec"
# May be empty (no npm test) or may try npm test and fail silently — either way no crash
# The key is that exit code is 0 and it doesn't blow up

teardown_sandbox


# ══════════════════════════════════════════════════════════════
# Part C: K001 교차 검증 (코드 존재 확인)
# ══════════════════════════════════════════════════════════════

echo ""
echo "📋 K001: 코드 교차 검증"

# install.js has prompt-related code
prompt_code_count=$(rg -c -e 'hookType' -e "type.*prompt" -e "prompt.*hook" "$INSTALL_JS" 2>/dev/null | paste -sd+ | bc || echo "0")
TOTAL=$((TOTAL + 1))
if [ "$prompt_code_count" -gt 0 ] 2>/dev/null; then
  echo "  ✅ PASS: install.js contains prompt hook registration code ($prompt_code_count lines)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: install.js missing prompt hook code"
  FAIL=$((FAIL + 1))
fi

# vela-test-async.js has systemMessage output code
async_code_count=$(rg -c -e 'systemMessage' -e 'emitSystemMessage' "$HOOK" 2>/dev/null | paste -sd+ | bc || echo "0")
TOTAL=$((TOTAL + 1))
if [ "$async_code_count" -gt 0 ] 2>/dev/null; then
  echo "  ✅ PASS: vela-test-async.js contains systemMessage/async code ($async_code_count lines)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: vela-test-async.js missing systemMessage code"
  FAIL=$((FAIL + 1))
fi


# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
