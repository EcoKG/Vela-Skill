#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-subagent-stop.sh — vela-subagent-stop.js 계약 테스트
#
# K004: stdin JSON → hook logic → stdout + exit code + filesystem side effects
#
# Test 1: 활성 파이프라인 + last_assistant_message → artifact 파일 생성
# Test 2: Reviewer 점수 14/25 → escalation.json 생성 (score=14)
# Test 3: Reviewer 점수 20/25 → escalation.json 미생성
# Test 4: 파이프라인 없음 → exit 0, artifact 미생성, escalation 미생성
# Test 5: delegation.json 존재 → SubagentStop 후 삭제됨
# Test 6: last_assistant_message 없음 → exit 0, artifact 미생성
# Test 7: 점수 패턴 없는 일반 메시지 → 에스컬레이션 미트리거
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../hooks/vela-subagent-stop.js"

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/artifacts"
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

create_config() {
  cat > "$PROJECT/.vela/config.json" <<'CFG'
{ "persona": "pm", "model": "sonnet" }
CFG
}

# Create an active pipeline-state.json
# Args: $1=status (default: active)
create_pipeline() {
  local status="${1:-active}"
  local date_dir
  date_dir="$(date +%Y-%m-%d)_001_test"
  ARTIFACT_DIR="$PROJECT/.vela/artifacts/$date_dir"
  mkdir -p "$ARTIFACT_DIR"

  cat > "$ARTIFACT_DIR/pipeline-state.json" <<EOF
{
  "status": "$status",
  "pipeline_type": "standard",
  "current_step": "execute",
  "current_step_index": 2,
  "completed_steps": ["init", "plan"],
  "total_steps": 5,
  "request": "test request"
}
EOF
}

run_hook() {
  local stdin_json="$1"
  echo "$stdin_json" | node "$HOOK" 2>/dev/null || true
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

assert_file_exists() {
  local label="$1"
  local filepath="$2"

  TOTAL=$((TOTAL + 1))
  if [ -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — file not found: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_not_exists() {
  local label="$1"
  local filepath="$2"

  TOTAL=$((TOTAL + 1))
  if [ ! -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — file should NOT exist: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_contains() {
  local label="$1"
  local needle="$2"
  local filepath="$3"

  TOTAL=$((TOTAL + 1))
  if [ -f "$filepath" ] && grep -q "$needle" "$filepath"; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — '$needle' not found in $filepath"
    FAIL=$((FAIL + 1))
  fi
}

# ── main ─────────────────────────────────────────────────────

trap teardown_sandbox EXIT

echo "⛵ SubagentStop Hook 계약 테스트"
echo "─────────────────────────────────────"

# ── Test 1: 활성 파이프라인 + last_assistant_message → artifact 생성 ──
echo ""
echo "📋 Test 1: 활성 파이프라인 + message → artifact 파일 생성"
setup_sandbox
create_config
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","last_assistant_message":"## Review Result\nLooks good.","agent_id":"test-agent","agent_type":"reviewer"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_file_exists "artifact file created" "$ARTIFACT_DIR/subagent-test-agent.md"
assert_file_contains "artifact has message content" "Review Result" "$ARTIFACT_DIR/subagent-test-agent.md"
assert_file_contains "artifact has agent_id metadata" "agent_id: test-agent" "$ARTIFACT_DIR/subagent-test-agent.md"
assert_contains "stdout has hookEventName" "SubagentStop" "$output"
teardown_sandbox

# ── Test 2: Reviewer 점수 14/25 → escalation.json 생성 ──
echo ""
echo "📋 Test 2: Reviewer score 14/25 → escalation.json 생성"
setup_sandbox
create_config
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","last_assistant_message":"## Review\n총점: 14/25\nNeeds improvement.","agent_id":"reviewer-1"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

ESCALATION_FILE="$PROJECT/.vela/state/escalation.json"
assert_eq "exit code is 0" "0" "$exit_code"
assert_file_exists "escalation.json created" "$ESCALATION_FILE"
assert_file_contains "escalation has score 14" '"score": 14' "$ESCALATION_FILE"
assert_file_contains "escalation has threshold" '"threshold": 15' "$ESCALATION_FILE"
assert_file_contains "escalation has reason" 'reviewer_score_below_threshold' "$ESCALATION_FILE"
teardown_sandbox

# ── Test 3: Reviewer 점수 20/25 → escalation.json 미생성 ──
echo ""
echo "📋 Test 3: Reviewer score 20/25 → escalation.json 미생성"
setup_sandbox
create_config
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","last_assistant_message":"## Review\n총점: 20/25\nGood work.","agent_id":"reviewer-2"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_file_not_exists "no escalation.json" "$PROJECT/.vela/state/escalation.json"
assert_file_exists "artifact still created" "$ARTIFACT_DIR/subagent-reviewer-2.md"
teardown_sandbox

# ── Test 4: 파이프라인 없음 → exit 0, 부작용 없음 ── (Negative)
echo ""
echo "📋 Test 4: 파이프라인 없음 → exit 0, artifact/escalation 미생성"
setup_sandbox
create_config
# No pipeline created

STDIN_JSON='{"cwd":"'"$PROJECT"'","last_assistant_message":"## Review\n총점: 10/25","agent_id":"reviewer-3"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_empty "stdout is empty (early exit)" "$output"
assert_file_not_exists "no escalation.json" "$PROJECT/.vela/state/escalation.json"
teardown_sandbox

# ── Test 5: delegation.json 존재 → SubagentStop 후 삭제 ──
echo ""
echo "📋 Test 5: delegation.json cleanup"
setup_sandbox
create_config
create_pipeline "active"

# Pre-create delegation.json
mkdir -p "$PROJECT/.vela/state"
cat > "$PROJECT/.vela/state/delegation.json" <<'DEL'
{ "agent_id": "worker-1", "task": "implement feature" }
DEL

STDIN_JSON='{"cwd":"'"$PROJECT"'","last_assistant_message":"Done.","agent_id":"worker-1"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_file_not_exists "delegation.json deleted" "$PROJECT/.vela/state/delegation.json"
assert_file_exists "artifact still created" "$ARTIFACT_DIR/subagent-worker-1.md"
teardown_sandbox

# ── Test 6: last_assistant_message 없음 → graceful skip ── (Negative)
echo ""
echo "📋 Test 6: no last_assistant_message → no artifact, no escalation"
setup_sandbox
create_config
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","agent_id":"scout-1"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
# Find any artifact file — there should be none
artifact_count=$(find "$ARTIFACT_DIR" -name 'subagent-*.md' 2>/dev/null | wc -l | tr -d ' ')
assert_eq "no artifact files created" "0" "$artifact_count"
assert_file_not_exists "no escalation.json" "$PROJECT/.vela/state/escalation.json"
assert_contains "stdout still has hookEventName" "SubagentStop" "$output"
teardown_sandbox

# ── Test 7: 점수 패턴 없는 일반 메시지 → 에스컬레이션 미트리거 ── (Negative)
echo ""
echo "📋 Test 7: message without score pattern → no escalation"
setup_sandbox
create_config
create_pipeline "active"

STDIN_JSON='{"cwd":"'"$PROJECT"'","last_assistant_message":"Implementation complete. All tests pass. No issues found.","agent_id":"worker-2"}'
output=$(run_hook "$STDIN_JSON")
exit_code=0
echo "$STDIN_JSON" | node "$HOOK" 2>/dev/null || exit_code=$?

assert_eq "exit code is 0" "0" "$exit_code"
assert_file_exists "artifact created (message present)" "$ARTIFACT_DIR/subagent-worker-2.md"
assert_file_not_exists "no escalation.json (no score pattern)" "$PROJECT/.vela/state/escalation.json"
teardown_sandbox

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
