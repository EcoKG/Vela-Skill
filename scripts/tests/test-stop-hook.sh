#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-stop-hook.sh — vela-stop.js 계약 테스트
#
# K004: stdin JSON → hook logic → stdout + exit code 검증
#
# Test 1: stop_hook_active=true → exit 0, stdout 비어있음
# Test 2: auto=true + 미완료 파이프라인 → decision:block
# Test 3: auto=false + 활성 파이프라인 → systemMessage
# Test 4: auto=true + 완료된 파이프라인 → exit 0, decision 없음
# Test 5: 파이프라인 없음 → exit 0, stdout 비어있음
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../hooks/vela-stop.js"

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/artifacts"

  # Minimal config.json required by readConfig()
  cat > "$PROJECT/.vela/config.json" <<'CFG'
{ "persona": "pm", "model": "sonnet" }
CFG
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

# Create an active pipeline-state.json
# Args: $1=status, $2=auto(true/false/omit), $3=current_step, $4=total_steps
create_pipeline() {
  local status="${1:-active}"
  local auto_val="$2"
  local step="${3:-plan}"
  local total="${4:-5}"
  local date_dir
  date_dir="$(date +%Y-%m-%d)_001_test"
  local artifact_dir="$PROJECT/.vela/artifacts/$date_dir"
  mkdir -p "$artifact_dir"

  local auto_field=""
  if [ "$auto_val" = "true" ]; then
    auto_field='"auto": true,'
  elif [ "$auto_val" = "false" ]; then
    auto_field='"auto": false,'
  fi
  # else: omit auto field entirely

  cat > "$artifact_dir/pipeline-state.json" <<EOF
{
  "status": "$status",
  $auto_field
  "pipeline_type": "standard",
  "current_step": "$step",
  "current_step_index": 1,
  "completed_steps": ["init"],
  "total_steps": $total,
  "request": "test request"
}
EOF
}

# Clean artifacts between tests
clean_artifacts() {
  rm -rf "$PROJECT/.vela/artifacts"/*
}

run_hook() {
  local stdin_json="$1"
  echo "$stdin_json" | node "$HOOK" 2>/dev/null || true
}

run_hook_exit() {
  local stdin_json="$1"
  echo "$stdin_json" | node "$HOOK" 2>/dev/null
  echo $?
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
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ❌ FAIL: $label — '$needle' should NOT be in output"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
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

# ── main ─────────────────────────────────────────────────────

trap teardown_sandbox EXIT

echo "⛵ Stop Hook 계약 테스트"
echo "─────────────────────────────────────"

# ── Test 1: stop_hook_active=true → exit 0, stdout 비어있음 ──
echo ""
echo "📋 Test 1: stop_hook_active=true → 즉시 통과 (무한루프 방지)"
setup_sandbox
create_pipeline "active" "true" "plan" 5
output=$(run_hook '{"cwd":"'"$PROJECT"'","stop_hook_active":true}')
exit_code=0
echo '{"cwd":"'"$PROJECT"'","stop_hook_active":true}' | node "$HOOK" 2>/dev/null || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty" "$output"
teardown_sandbox

# ── Test 2: auto=true + 미완료 파이프라인 → decision:block ──
echo ""
echo "📋 Test 2: auto=true + 미완료 파이프라인 → decision:block"
setup_sandbox
create_pipeline "active" "true" "plan" 5
output=$(run_hook '{"cwd":"'"$PROJECT"'"}')
exit_code=0
echo '{"cwd":"'"$PROJECT"'"}' | node "$HOOK" 2>/dev/null || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
assert_contains "stdout has decision:block" '"decision":"block"' "$output"
assert_contains "reason mentions current step" 'plan' "$output"
assert_contains "reason mentions transition" 'transition' "$output"
teardown_sandbox

# ── Test 3: auto=false + 활성 파이프라인 → systemMessage ──
echo ""
echo "📋 Test 3: auto=false + 활성 파이프라인 → systemMessage 경고"
setup_sandbox
create_pipeline "active" "false" "execute" 5
output=$(run_hook '{"cwd":"'"$PROJECT"'"}')
exit_code=0
echo '{"cwd":"'"$PROJECT"'"}' | node "$HOOK" 2>/dev/null || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
assert_contains "stdout has systemMessage" '"systemMessage"' "$output"
assert_not_contains "no decision field" '"decision"' "$output"
teardown_sandbox

# ── Test 4: auto=true + 완료된 파이프라인 → exit 0, decision 없음 ──
echo ""
echo "📋 Test 4: auto=true + 완료된 파이프라인 → 통과"
setup_sandbox
create_pipeline "completed" "true" "finalize" 5
output=$(run_hook '{"cwd":"'"$PROJECT"'"}')
exit_code=0
echo '{"cwd":"'"$PROJECT"'"}' | node "$HOOK" 2>/dev/null || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (completed pipeline ignored)" "$output"
teardown_sandbox

# ── Test 5: 파이프라인 없음 → exit 0, stdout 비어있음 ──
echo ""
echo "📋 Test 5: 파이프라인 없음 → 통과"
setup_sandbox
# No pipeline created — just config.json exists
output=$(run_hook '{"cwd":"'"$PROJECT"'"}')
exit_code=0
echo '{"cwd":"'"$PROJECT"'"}' | node "$HOOK" 2>/dev/null || exit_code=$?
assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (no pipeline)" "$output"
teardown_sandbox

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
