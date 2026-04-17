#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-review-gate.sh — review-gate 동작 단위 테스트 (v7.3-M4d)
#
# v7.3-M4d (2026-04-17): vela-review-gate.js → vela-stop.js 통합.
# 테스트는 hook_event_name="Stop"으로 vela-stop.js를 호출하여
# 내부 evaluateReviewGate() 경로를 검증한다.
#
# Covers (legacy validation-plan V2-4 — doc removed in v7.3-M5):
#   V2-4-1:  활성 파이프라인 없을 때 통과
#   V2-4-2:  현재 단계가 DEFAULT_STEPS 외 → 통과
#   V2-4-3:  APPROVE + gate 없음 → 차단 (1/3) + 상태 파일 생성
#   V2-4-4:  APPROVE + count=1 → 차단 (2/3)
#   V2-4-5:  APPROVE + count=3 (rounds 충족) → 통과
#   V2-4-6:  REJECT → 개입 없음 (PM 위임)
#   V2-4-7:  review_gate.enabled=false → 통과
#   V2-4-8:  validation_rounds=1, count=1 충족 → 통과
#   V2-4-9:  커스텀 steps에 현재 단계 없음 → 통과
#   V2-4-10: transition 후 review-gate-{step}.json 삭제됨
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../hooks/vela-stop.js"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""
ARTIFACT_DIR=""

# ── Helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/templates"

  # Default config with review_gate enabled, 3 rounds
  cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "review_gate": {
    "enabled": true,
    "validation_rounds": 3,
    "steps": ["research", "execute", "plan"]
  }
}
EOF

  # Create active pipeline artifact
  local TIMESTAMP="20260101T000000"
  ARTIFACT_DIR="$PROJECT/.vela/artifacts/${TIMESTAMP}-test-review-gate"
  mkdir -p "$ARTIFACT_DIR"
  cat > "$ARTIFACT_DIR/pipeline-state.json" <<'STATEOF'
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "research",
  "current_step_index": 1,
  "revisions": {},
  "completed_steps": ["init"]
}
STATEOF

  # Minimal pipeline template (needed for V2-4-10 transition test)
  cat > "$PROJECT/.vela/templates/pipeline.json" <<'PIPEEOF'
{
  "pipelines": {
    "standard": {
      "steps": [
        { "id": "research", "name": "Research", "mode": "read", "exit_gate": [] },
        { "id": "plan",     "name": "Plan",     "mode": "read", "exit_gate": [] },
        { "id": "execute",  "name": "Execute",  "mode": "write","exit_gate": [] }
      ]
    }
  }
}
PIPEEOF
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

# Run the hook, capture stdout; always exits 0 (fail-open)
run_hook() {
  echo "{\"hook_event_name\":\"Stop\",\"cwd\":\"$PROJECT\"}" | node "$HOOK" 2>/dev/null || true
}

# Set current_step in pipeline-state.json
set_step() {
  local step="$1"
  node -e "
    const fs = require('fs');
    const p = '$ARTIFACT_DIR/pipeline-state.json';
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    s.current_step = '$step';
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  "
}

# Write .vela/state/review-gate-{step}.json with given count
set_gate_count() {
  local step="$1"
  local count="$2"
  cat > "$PROJECT/.vela/state/review-gate-${step}.json" <<EOF
{
  "step": "$step",
  "count": $count,
  "rounds": 3,
  "lastReviewAt": "2026-01-01T00:00:00.000Z"
}
EOF
}

# Write review-{step}.md with given verdict
write_review() {
  local step="$1"
  local verdict="$2"   # APPROVE or REJECT
  cat > "$ARTIFACT_DIR/review-${step}.md" <<EOF
# Review: ${step}

판정: ${verdict}

세부 내용.
EOF
}

assert_no_block() {
  local label="$1"
  local actual_output="$2"

  TOTAL=$((TOTAL + 1))
  if echo "$actual_output" | grep -q '"decision"'; then
    echo "  ❌ FAIL: $label — unexpected output: $actual_output"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  fi
}

assert_block() {
  local label="$1"
  local actual_output="$2"

  TOTAL=$((TOTAL + 1))
  if echo "$actual_output" | grep -q '"decision".*"block"'; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected block decision, got: '$actual_output'"
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
    echo "  ❌ FAIL: $label — '$needle' not found in: '$haystack'"
    FAIL=$((FAIL + 1))
  fi
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

assert_file_absent() {
  local label="$1"
  local filepath="$2"

  TOTAL=$((TOTAL + 1))
  if [ ! -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — file should not exist: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

# ── Tests ────────────────────────────────────────────────────

echo "⛵ review-gate 테스트 (via vela-stop.js unified hook, v7.3-M4d)"
echo "═══════════════════════════════════════"

# ─────────────────────────────────────────────────────────────
# V2-4-1: 활성 파이프라인 없을 때 통과
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-1: 활성 파이프라인 없을 때 통과"

TMPDIR_ROOT="$(mktemp -d)"
PROJECT="$TMPDIR_ROOT/empty"
mkdir -p "$PROJECT"
output=$(run_hook)
assert_no_block "No active pipeline → no block" "$output"
rm -rf "$TMPDIR_ROOT"
TMPDIR_ROOT=""

# ─────────────────────────────────────────────────────────────
# V2-4-2: 현재 단계가 DEFAULT_STEPS 외 → 통과
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-2: 현재 단계 'plan-check' (DEFAULT_STEPS 외) → 통과"

setup_sandbox
set_step "plan-check"
write_review "plan-check" "APPROVE"
output=$(run_hook)
assert_no_block "Step not in configured steps → no block" "$output"
teardown_sandbox

# ─────────────────────────────────────────────────────────────
# V2-4-3: APPROVE + gate 상태 없음 → 차단 (1/3)
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-3: APPROVE + 첫 번째 라운드 → 차단 (1/3)"

setup_sandbox
write_review "research" "APPROVE"

output=$(run_hook)
assert_block "First APPROVE → block 1/3" "$output"
assert_contains "Block reason shows 1/3" "1/3" "$output"

gate_file="$PROJECT/.vela/state/review-gate-research.json"
assert_file_exists "Gate state file created" "$gate_file"

gate_count=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$gate_file', 'utf8'));
  console.log(s.count);
" 2>/dev/null)
assert_eq "Gate state count=1" "1" "$gate_count"

teardown_sandbox

# ─────────────────────────────────────────────────────────────
# V2-4-4: APPROVE + count=1 → 차단 (2/3)
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-4: APPROVE + count=1 → 차단 (2/3)"

setup_sandbox
write_review "research" "APPROVE"
set_gate_count "research" 1

output=$(run_hook)
assert_block "Second APPROVE → block 2/3" "$output"
assert_contains "Block reason shows 2/3" "2/3" "$output"

gate_count=$(node -e "
  const s = JSON.parse(require('fs').readFileSync(
    '$PROJECT/.vela/state/review-gate-research.json', 'utf8'));
  console.log(s.count);
" 2>/dev/null)
assert_eq "Gate state count=2" "2" "$gate_count"

teardown_sandbox

# ─────────────────────────────────────────────────────────────
# V2-4-5: APPROVE + count=3 (rounds 충족) → 통과
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-5: APPROVE + count=3 (rounds=3 충족) → 통과"

setup_sandbox
write_review "research" "APPROVE"
set_gate_count "research" 3

output=$(run_hook)
assert_no_block "All rounds complete → no block" "$output"

teardown_sandbox

# ─────────────────────────────────────────────────────────────
# V2-4-6: REJECT → 개입 없음 (PM 위임)
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-6: REJECT → 훅 개입 없음"

setup_sandbox
write_review "research" "REJECT"

output=$(run_hook)
assert_no_block "REJECT → no block (PM handles failure)" "$output"
assert_file_absent "No gate state written on REJECT" \
  "$PROJECT/.vela/state/review-gate-research.json"

teardown_sandbox

# ─────────────────────────────────────────────────────────────
# V2-4-7: review_gate.enabled=false → 통과
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-7: review_gate.enabled=false → 통과"

setup_sandbox
cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "review_gate": {
    "enabled": false
  }
}
EOF
write_review "research" "APPROVE"

output=$(run_hook)
assert_no_block "Disabled via config → no block" "$output"

teardown_sandbox

# ─────────────────────────────────────────────────────────────
# V2-4-8: validation_rounds=1, count=1 충족 → 통과
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-8: validation_rounds=1, count=1 충족 → 통과"

setup_sandbox
cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "review_gate": {
    "enabled": true,
    "validation_rounds": 1,
    "steps": ["research", "execute", "plan"]
  }
}
EOF
write_review "research" "APPROVE"
# Gate state with count=1, which satisfies rounds=1
cat > "$PROJECT/.vela/state/review-gate-research.json" <<'EOF'
{
  "step": "research",
  "count": 1,
  "rounds": 1,
  "lastReviewAt": "2026-01-01T00:00:00.000Z"
}
EOF

output=$(run_hook)
assert_no_block "Custom rounds=1, count=1 → no block" "$output"

teardown_sandbox

# ─────────────────────────────────────────────────────────────
# V2-4-9: 커스텀 steps에 현재 단계 없음 → 통과
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-9: 커스텀 steps=[verify], current=research → 통과"

setup_sandbox
cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "review_gate": {
    "enabled": true,
    "validation_rounds": 3,
    "steps": ["verify"]
  }
}
EOF
write_review "research" "APPROVE"

output=$(run_hook)
assert_no_block "Step not in custom steps → no block" "$output"

teardown_sandbox

# ─────────────────────────────────────────────────────────────
# V2-4-10: transition 후 review-gate-{step}.json 삭제됨
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 V2-4-10: transition 후 review-gate-research.json 삭제됨"

setup_sandbox
set_gate_count "research" 2

gate_file="$PROJECT/.vela/state/review-gate-research.json"
assert_file_exists "Gate state exists before transition" "$gate_file"

# Run transition from project dir (no exit_gate requirements in this template)
(cd "$PROJECT" && node "$ENGINE" transition > /dev/null 2>&1) || true

assert_file_absent "Gate state deleted after transition" "$gate_file"

teardown_sandbox

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ SOME TESTS FAILED"
  exit 1
fi
echo "✅ 전체 PASS"
