#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-engine-record.sh — vela-engine.js record 명령어 검증
#
# Covers (legacy validation-plan V3-3 — doc removed in v7.3-M5):
#   1.  pass 기록 → ok:true, verdict:"pass", revision 증가
#   2.  reject 기록 → ok:true, revision 증가
#   3.  fail 4회 → circuit-open.json 아직 없음 (임계값 미달)
#   4.  fail 5회 → circuit-open.json 생성 (서킷 브레이커 발동)
#   5.  fail 5회 후 pass → circuit-open.json 삭제 + failKey 리셋
#   6.  reject 5회 → 서킷 브레이커 발동 (reject도 동일 카운터)
#   7.  fail + reject 혼합 5회 → 서킷 브레이커 발동
#   8.  transition 후 다음 단계에서 fail 1회 → circuit 안 열림
#   9.  auto 모드: reject 2회 연속 → auto=false (auto-mode 카운터 분리)
#   10. revision 카운팅 — 동일 단계 여러 번 record → revisions[step] 누적
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""

# ── Helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/artifacts"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/templates"

  # Minimal pipeline with scales map and three steps (needed for transition test)
  cat > "$PROJECT/.vela/templates/pipeline.json" <<'PIPEEOF'
{
  "scales": {
    "small":  "standard",
    "medium": "standard",
    "large":  "standard"
  },
  "pipelines": {
    "standard": {
      "steps": [
        { "id": "research", "name": "Research", "mode": "read",  "exit_gate": [] },
        { "id": "plan",     "name": "Plan",     "mode": "read",  "exit_gate": [] },
        { "id": "execute",  "name": "Execute",  "mode": "write", "exit_gate": [] }
      ]
    }
  }
}
PIPEEOF
  # No git repo needed — record/circuit-breaker logic is git-independent
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

run_engine() {
  (cd "$PROJECT" && node "$ENGINE" "$@" 2>/dev/null) || true
}

cancel_and_reset() {
  run_engine cancel > /dev/null 2>&1 || true
  rm -rf "$PROJECT/.vela/artifacts"/*
  rm -f "$PROJECT/.vela/state/circuit-open.json"
}

# Read a field from the active pipeline-state.json
read_state_field() {
  local field="$1"
  node -e "
    const fs = require('fs');
    const path = require('path');
    const dir = '$PROJECT/.vela/artifacts';
    if (!fs.existsSync(dir)) { process.exit(0); }
    const dirs = fs.readdirSync(dir).filter(d => /^\d{8}T\d{6}-/.test(d)).sort().reverse();
    for (const d of dirs) {
      const sp = path.join(dir, d, 'pipeline-state.json');
      if (!fs.existsSync(sp)) continue;
      const s = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      if (s.status !== 'cancelled' && s.status !== 'completed') {
        const v = s['$field'];
        if (v === undefined) { console.log('__UNDEFINED__'); }
        else { console.log(JSON.stringify(v)); }
        break;
      }
    }
  " 2>/dev/null
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
    echo "  ❌ FAIL: $label — '$needle' not found in: '$haystack'"
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

# ── Setup ────────────────────────────────────────────────────

trap teardown_sandbox EXIT
setup_sandbox

CIRCUIT_FILE="$PROJECT/.vela/state/circuit-open.json"

echo "⛵ vela-engine.js record 테스트"
echo "═══════════════════════════════════════"

# ─────────────────────────────────────────────────────────────
# Test 1: pass 기록 → ok:true, verdict:"pass", revision 증가
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 1: record pass → ok:true, revision 증가"

run_engine init "test record pass" --force > /dev/null
result=$(run_engine record pass --summary "first pass")
assert_contains "record pass → ok:true" '"ok": true' "$result"
assert_contains "record pass → verdict:pass" '"verdict": "pass"' "$result"
assert_contains "record pass → revision:1" '"revision": 1' "$result"
cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 2: reject 기록 → ok:true, revision 증가
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 2: record reject → ok:true, revision 증가"

run_engine init "test record reject" --force > /dev/null
result=$(run_engine record reject --summary "needs fix")
assert_contains "record reject → ok:true" '"ok": true' "$result"
assert_contains "record reject → verdict:reject" '"verdict": "reject"' "$result"
assert_contains "record reject → revision:1" '"revision": 1' "$result"
cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 3: fail 4회 → circuit-open.json 아직 없음 (임계값 미달)
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 3: fail 4회 → circuit-open.json 없음 (임계값=5 미달)"

run_engine init "test circuit 4 fails" --force > /dev/null
for i in 1 2 3 4; do
  run_engine record fail --summary "fail $i" > /dev/null
done
assert_file_absent "circuit-open.json absent after 4 fails" "$CIRCUIT_FILE"
cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 4: fail 5회 → circuit-open.json 생성
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 4: fail 5회 → circuit-open.json 생성 (서킷 브레이커 발동)"

run_engine init "test circuit 5 fails" --force > /dev/null
for i in 1 2 3 4 5; do
  run_engine record fail --summary "fail $i" > /dev/null
done
assert_file_exists "circuit-open.json created after 5 fails" "$CIRCUIT_FILE"

# circuit-open.json 내용 검증
circuit_step=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$CIRCUIT_FILE', 'utf8'));
  console.log(s.step);
" 2>/dev/null)
assert_eq "circuit-open.json step field" "research" "$circuit_step"

cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 5: fail 5회 후 pass → circuit-open.json 삭제
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 5: fail 5회 후 pass → circuit-open.json 삭제 + failKey 리셋"

run_engine init "test circuit reset" --force > /dev/null
for i in 1 2 3 4 5; do
  run_engine record fail --summary "fail $i" > /dev/null
done
assert_file_exists "circuit-open.json present before pass" "$CIRCUIT_FILE"

run_engine record pass --summary "fixed" > /dev/null
assert_file_absent "circuit-open.json deleted after pass" "$CIRCUIT_FILE"

# _step_failures_research 리셋 확인
fail_key=$(read_state_field "_step_failures_research")
assert_eq "failKey reset to 0 after pass" "0" "$fail_key"

cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 6: reject 5회 → 서킷 브레이커 발동
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 6: reject 5회 → circuit-open.json 생성 (reject도 fail과 동일)"

run_engine init "test circuit 5 rejects" --force > /dev/null
for i in 1 2 3 4 5; do
  run_engine record reject --summary "reject $i" > /dev/null
done
assert_file_exists "circuit-open.json created after 5 rejects" "$CIRCUIT_FILE"
cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 7: fail + reject 혼합 5회 → 서킷 브레이커 발동
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 7: fail + reject 혼합 5회 → circuit-open.json 생성"

run_engine init "test circuit mixed" --force > /dev/null
run_engine record fail   --summary "fail 1"   > /dev/null
run_engine record reject --summary "reject 2" > /dev/null
run_engine record fail   --summary "fail 3"   > /dev/null
run_engine record reject --summary "reject 4" > /dev/null
run_engine record fail   --summary "fail 5"   > /dev/null
assert_file_exists "circuit-open.json created after mixed 5" "$CIRCUIT_FILE"
cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 8: transition 후 다음 단계에서 fail 카운터 별도
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 8: transition 후 다음 단계 fail 1회 → circuit 안 열림"

run_engine init "test circuit after transition" --force > /dev/null
# transition to plan step
run_engine transition > /dev/null
# Now on "plan" step — fail 4 times (below threshold)
for i in 1 2 3 4; do
  run_engine record fail --summary "plan fail $i" > /dev/null
done
assert_file_absent "circuit-open.json absent after 4 fails on plan" "$CIRCUIT_FILE"

# Also: _step_failures_research should be gone (cleaned by transition)
research_key=$(read_state_field "_step_failures_research")
assert_eq "research failKey deleted by transition" "__UNDEFINED__" "$research_key"

cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 9: auto 모드 카운터와 서킷 브레이커 카운터 분리
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 9: auto 카운터(2회)와 서킷 브레이커(5회) 독립 동작"

run_engine init "test two counters" --auto --force > /dev/null

# 2 consecutive rejects → auto disabled
run_engine record reject --summary "reject 1" > /dev/null
run_engine record reject --summary "reject 2" > /dev/null

auto_val=$(read_state_field "auto")
assert_eq "auto=false after 2 rejects" "false" "$auto_val"
assert_file_absent "circuit-open.json NOT open after only 2 rejects" "$CIRCUIT_FILE"

# 3 more rejects (total 5) → circuit breaker triggers
run_engine record reject --summary "reject 3" > /dev/null
run_engine record reject --summary "reject 4" > /dev/null
run_engine record reject --summary "reject 5" > /dev/null
assert_file_exists "circuit-open.json created after 5 rejects" "$CIRCUIT_FILE"

cancel_and_reset

# ─────────────────────────────────────────────────────────────
# Test 10: revision 카운팅 누적
# ─────────────────────────────────────────────────────────────
echo ""
echo "📋 Test 10: 동일 단계 반복 record → revisions[step] 누적"

run_engine init "test revisions" --force > /dev/null
run_engine record fail --summary "attempt 1" > /dev/null
run_engine record fail --summary "attempt 2" > /dev/null
result=$(run_engine record pass --summary "attempt 3")
assert_contains "third record shows revision:3" '"revision": 3' "$result"

cancel_and_reset

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ SOME TESTS FAILED"
  exit 1
fi
echo "✅ 전체 PASS"
