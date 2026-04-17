#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-auto-mode.sh — Auto 모드 핵심 로직 검증
#
# 1. init --auto → state에 auto:true, auto_reject_count:0
# 2. init without --auto → auto 필드 없음
# 3. record reject 2회 연속 → auto:false 자동 중단
# 4. record pass → auto_reject_count 리셋
# 5. checkpoint exit gate: auto + plan-check.md 존재 → 자동 통과
# 6. checkpoint exit gate: auto + plan-check.md 부재 → 차단
# 7. record pass 후 record reject 1회 → auto 유지 (연속 아님)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/artifacts"
  mkdir -p "$PROJECT/.vela/templates"

  # pipeline.json — standard pipeline with checkpoint step.
  # scales map routes every autoDetectScale() output to "standard" so the
  # test doesn't care about request word count.
  cat > "$PROJECT/.vela/templates/pipeline.json" <<'PIPE'
{
  "scales": {
    "small": "standard",
    "medium": "standard",
    "large": "standard"
  },
  "pipelines": {
    "standard": {
      "steps": [
        { "id": "init", "name": "Init", "mode": "read", "exit_gate": ["artifact_dir_created"] },
        { "id": "plan", "name": "Plan", "mode": "read", "exit_gate": ["plan_md_exists"] },
        { "id": "checkpoint", "name": "Checkpoint", "mode": "read", "exit_gate": ["plan_check_pass", "user_approved"] },
        { "id": "execute", "name": "Execute", "mode": "write", "exit_gate": [] },
        { "id": "finalize", "name": "Finalize", "mode": "read", "exit_gate": [] }
      ]
    }
  }
}
PIPE

  # init git repo with .gitignore so engine doesn't fail on dirty tree
  cat > "$PROJECT/.gitignore" <<'GI'
.vela/cache/
.vela/state/
.vela/artifacts/
.vela/tracker-signals.json
.vela/write-log.jsonl
*.vela-tmp
GI
  # Disable commit signing — inherited global commit.gpgsign=true with a
  # broken signing hook would silently fail `git commit`, leaving the test
  # repo dirty and the engine's init step blocking on "Working tree dirty".
  (cd "$PROJECT" \
    && git init -q \
    && git config user.email "test@vela.local" \
    && git config user.name "Vela Auto Test" \
    && git config commit.gpgsign false \
    && git add -A \
    && git commit -q -m "init")
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

run_engine() {
  # Run engine from project dir
  (cd "$PROJECT" && node "$ENGINE" "$@" 2>/dev/null) || true
}

cancel_active() {
  (cd "$PROJECT" && node "$ENGINE" cancel 2>/dev/null) || true
  # Clean artifacts to prevent interference between tests
  rm -rf "$PROJECT/.vela/artifacts"/*
}

# Read a field from the active pipeline-state.json (filters for active status)
read_state_field() {
  local field="$1"
  local state_file
  # Find the active pipeline state (not cancelled/completed)
  state_file=$(node -e "
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
        console.log(sp);
        break;
      }
    }
  " 2>/dev/null)
  if [ -z "$state_file" ]; then
    echo "__NOT_FOUND__"
    return
  fi
  node -e "
    const s = JSON.parse(require('fs').readFileSync('$state_file','utf-8'));
    const v = s['$field'];
    if (v === undefined) { console.log('__UNDEFINED__'); }
    else { console.log(JSON.stringify(v)); }
  "
}

# Get the artifact dir of the active pipeline
get_artifact_dir() {
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
        console.log(path.join(dir, d));
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
    echo "  ❌ FAIL: $label — '$needle' not found in output"
    FAIL=$((FAIL + 1))
  fi
}

# ── main ─────────────────────────────────────────────────────

trap teardown_sandbox EXIT
setup_sandbox

echo "⛵ Auto Mode 테스트"
echo "─────────────────────────────────────"

# ── Test 1: init --auto → auto:true, auto_reject_count:0 ──
echo ""
echo "📋 Test 1: init --auto → state에 auto:true 기록"
run_engine init "test auto mode" --auto --force > /dev/null
auto_val=$(read_state_field "auto")
reject_count=$(read_state_field "auto_reject_count")
assert_eq "auto field is true" "true" "$auto_val"
assert_eq "auto_reject_count is 0" "0" "$reject_count"
cancel_active > /dev/null

# ── Test 2: init without --auto → auto 필드 없음 ──
echo ""
echo "📋 Test 2: init without --auto → auto 필드 없음"
run_engine init "test no auto" --force > /dev/null
auto_val=$(read_state_field "auto")
reject_count=$(read_state_field "auto_reject_count")
assert_eq "auto field undefined" "__UNDEFINED__" "$auto_val"
assert_eq "auto_reject_count undefined" "__UNDEFINED__" "$reject_count"
cancel_active > /dev/null

# ── Test 3: record reject 2회 연속 → auto:false ──
echo ""
echo "📋 Test 3: record reject 2회 연속 → auto:false"
run_engine init "test reject counter" --auto --force > /dev/null
run_engine record reject --summary "first reject" > /dev/null
auto_after_1=$(read_state_field "auto")
assert_eq "auto still true after 1 reject" "true" "$auto_after_1"

run_engine record reject --summary "second reject" > /dev/null
auto_after_2=$(read_state_field "auto")
reject_count_after_2=$(read_state_field "auto_reject_count")
assert_eq "auto false after 2 rejects" "false" "$auto_after_2"
assert_eq "auto_reject_count is 2" "2" "$reject_count_after_2"
cancel_active > /dev/null

# ── Test 4: record pass → auto_reject_count 리셋 ──
echo ""
echo "📋 Test 4: record pass → auto_reject_count 리셋"
run_engine init "test pass reset" --auto --force > /dev/null
run_engine record reject --summary "one reject" > /dev/null
reject_count_1=$(read_state_field "auto_reject_count")
assert_eq "reject count is 1" "1" "$reject_count_1"

run_engine record pass --summary "now pass" > /dev/null
reject_count_reset=$(read_state_field "auto_reject_count")
assert_eq "reject count reset to 0" "0" "$reject_count_reset"
auto_still_on=$(read_state_field "auto")
assert_eq "auto still true" "true" "$auto_still_on"
cancel_active > /dev/null

# ── Tests 5+6 REMOVED (v7.3-M3 pipeline collapse) ──
# Pre-M3 versions exercised the `checkpoint` step's `plan_check_pass`
# and `user_approved` exit gates. Both the step and the gates were
# deleted when the pipeline collapsed from 13→6 stages — plan now
# includes a Self-Check section that replaces plan-check, and there
# is no separate user-approval gate (approval-{step}.json files cover
# that role now). The checkpoint-specific auto-mode behaviour has
# no v8.0 equivalent to test against.

# ── Test 7: pass → reject 1회 → auto 유지 (연속 2회 아님) ──
echo ""
echo "📋 Test 7: pass 후 reject 1회 → auto 유지"
run_engine init "test non-consecutive" --auto --force > /dev/null
run_engine record reject --summary "reject 1" > /dev/null
run_engine record pass --summary "pass resets" > /dev/null
run_engine record reject --summary "reject after pass" > /dev/null
auto_val=$(read_state_field "auto")
reject_count=$(read_state_field "auto_reject_count")
assert_eq "auto still true (non-consecutive)" "true" "$auto_val"
assert_eq "reject count is 1 (reset by pass)" "1" "$reject_count"
cancel_active > /dev/null

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
