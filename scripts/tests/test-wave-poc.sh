#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-wave-poc.sh — vela-wave.js PoC 계약 테스트
#
# Tests the plan.md parser, dependency graph builder,
# topological sort (Kahn's algorithm), and CLI output.
#
# Test 1: Module loads without syntax error (node -c)
# Test 2: parsePlanMd extracts tasks from sample Task Distribution
# Test 3: Independent tasks (no deps) → single Wave 1
# Test 4: Linear chain A→B→C → 3 waves
# Test 5: Diamond dependency → 3 waves
# Test 6: Cycle detection throws error
# Test 7: CLI --json flag produces valid JSON
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/cli/vela-wave.js"
TMP_DIR=""

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

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

setup_tmp() {
  TMP_DIR="$(mktemp -d)"
}

cleanup() {
  rm -rf "$TMP_DIR" 2>/dev/null || true
}

# ── main ─────────────────────────────────────────────────────

echo "🌊 Wave Parallelization PoC 계약 테스트"
echo "─────────────────────────────────────"

setup_tmp
trap cleanup EXIT

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: parsePlanMd extracts tasks from sample Task Distribution ──
echo ""
echo "📋 Test 2: parsePlanMd extracts tasks from sample Task Distribution"

cat > "$TMP_DIR/plan-basic.md" <<'PLAN'
# Project Plan

## Architecture
Some architecture content here.

## Task Distribution
- 분석 태스크: 코드 분석 및 리포트 생성
- 구현 태스크: 핵심 기능 구현 (depends: [분석 태스크])
- 테스트 태스크: 유닛/통합 테스트 작성 (after: [구현 태스크])

## Test Strategy
Test content here.
PLAN

result=$(node -e "
  const { parsePlanMd } = require('$MODULE');
  const fs = require('fs');
  const content = fs.readFileSync('$TMP_DIR/plan-basic.md', 'utf8');
  const tasks = parsePlanMd(content);
  const checks = [
    tasks.length === 3,
    tasks[0].name === '분석 태스크',
    tasks[0].depends.length === 0,
    tasks[1].name === '구현 태스크',
    tasks[1].depends.length === 1 && tasks[1].depends[0] === '분석 태스크',
    tasks[2].name === '테스트 태스크',
    tasks[2].depends.length === 1 && tasks[2].depends[0] === '구현 태스크'
  ];
  console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(tasks));
")
assert_eq "3 tasks extracted with correct names and deps" "PASS" "$result"

# ── Test 3: Independent tasks (no deps) → single Wave 1 ──
echo ""
echo "📋 Test 3: Independent tasks (no deps) → single Wave 1"

cat > "$TMP_DIR/plan-independent.md" <<'PLAN'
## Task Distribution
- TaskA: do something
- TaskB: do another thing
- TaskC: do third thing
PLAN

result=$(node -e "
  const { parsePlanMd, buildDependencyGraph, topologicalSort } = require('$MODULE');
  const fs = require('fs');
  const content = fs.readFileSync('$TMP_DIR/plan-independent.md', 'utf8');
  const tasks = parsePlanMd(content);
  const graph = buildDependencyGraph(tasks);
  const waves = topologicalSort(graph);
  const checks = [
    waves.length === 1,
    waves[0].length === 3,
    waves[0].includes('TaskA'),
    waves[0].includes('TaskB'),
    waves[0].includes('TaskC')
  ];
  console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:waves=' + JSON.stringify(waves));
")
assert_eq "all 3 tasks in Wave 1" "PASS" "$result"

# ── Test 4: Linear chain A→B→C → 3 waves ──
echo ""
echo "📋 Test 4: Linear chain A→B→C → 3 waves"

cat > "$TMP_DIR/plan-linear.md" <<'PLAN'
## Task Distribution
- TaskA: first task
- TaskB: second task (depends: [TaskA])
- TaskC: third task (requires: [TaskB])
PLAN

result=$(node -e "
  const { parsePlanMd, buildDependencyGraph, topologicalSort } = require('$MODULE');
  const fs = require('fs');
  const content = fs.readFileSync('$TMP_DIR/plan-linear.md', 'utf8');
  const tasks = parsePlanMd(content);
  const graph = buildDependencyGraph(tasks);
  const waves = topologicalSort(graph);
  const checks = [
    waves.length === 3,
    waves[0].length === 1 && waves[0][0] === 'TaskA',
    waves[1].length === 1 && waves[1][0] === 'TaskB',
    waves[2].length === 1 && waves[2][0] === 'TaskC'
  ];
  console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:waves=' + JSON.stringify(waves));
")
assert_eq "3 sequential waves" "PASS" "$result"

# ── Test 5: Diamond dependency (A→B, A→C, B→D, C→D) → 3 waves ──
echo ""
echo "📋 Test 5: Diamond dependency → 3 waves"

cat > "$TMP_DIR/plan-diamond.md" <<'PLAN'
## Task Distribution
- TaskA: root task
- TaskB: branch one (depends: [TaskA])
- TaskC: branch two (after: [TaskA])
- TaskD: merge point (depends: [TaskB, TaskC])
PLAN

result=$(node -e "
  const { parsePlanMd, buildDependencyGraph, topologicalSort } = require('$MODULE');
  const fs = require('fs');
  const content = fs.readFileSync('$TMP_DIR/plan-diamond.md', 'utf8');
  const tasks = parsePlanMd(content);
  const graph = buildDependencyGraph(tasks);
  const waves = topologicalSort(graph);
  const checks = [
    waves.length === 3,
    waves[0].length === 1 && waves[0][0] === 'TaskA',
    waves[1].length === 2 && waves[1].includes('TaskB') && waves[1].includes('TaskC'),
    waves[2].length === 1 && waves[2][0] === 'TaskD'
  ];
  console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:waves=' + JSON.stringify(waves));
")
assert_eq "diamond: A → [B,C] → D" "PASS" "$result"

# ── Test 6: Cycle detection throws error ──
echo ""
echo "📋 Test 6: Cycle detection throws error"

cat > "$TMP_DIR/plan-cycle.md" <<'PLAN'
## Task Distribution
- TaskA: first (depends: [TaskC])
- TaskB: second (depends: [TaskA])
- TaskC: third (depends: [TaskB])
PLAN

result=$(node -e "
  const { parsePlanMd, buildDependencyGraph, topologicalSort } = require('$MODULE');
  const fs = require('fs');
  const content = fs.readFileSync('$TMP_DIR/plan-cycle.md', 'utf8');
  const tasks = parsePlanMd(content);
  const graph = buildDependencyGraph(tasks);
  try {
    topologicalSort(graph);
    console.log('FAIL:no_error_thrown');
  } catch (e) {
    const checks = [
      e.message.includes('Cycle detected'),
      e.message.includes('TaskA') || e.message.includes('TaskB') || e.message.includes('TaskC')
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + e.message);
  }
")
assert_eq "cycle throws with message" "PASS" "$result"

# ── Test 7: CLI --json flag produces valid JSON ──
echo ""
echo "📋 Test 7: CLI --json flag produces valid JSON"

cat > "$TMP_DIR/plan-cli.md" <<'PLAN'
## Task Distribution
- Alpha: first task
- Beta: second task (depends: [Alpha])
- Gamma: parallel to Beta (depends: [Alpha])
PLAN

result=$(node "$MODULE" "$TMP_DIR/plan-cli.md" --json 2>/dev/null)
exit_code=$?
assert_eq "CLI exits 0" "0" "$exit_code"

# Validate JSON structure
json_check=$(node -e "
  try {
    const data = JSON.parse(process.argv[1]);
    const checks = [
      data.totalTasks === 3,
      data.totalWaves === 2,
      Array.isArray(data.waves),
      data.waves[0].wave === 1,
      data.waves[0].tasks.length === 1,
      data.waves[1].wave === 2,
      data.waves[1].tasks.length === 2
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify(data));
  } catch(e) {
    console.log('FAIL:invalid_json:' + e.message);
  }
" "$result")
assert_eq "valid JSON with correct structure" "PASS" "$json_check"

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
