#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-gate-vk07.sh — VK-07 Read 허용 / Write 차단 검증
#
# PM이 delegation.json 없이:
#   Read  → exit 0  (허용)
#   Glob  → exit 0  (허용)
#   Grep  → exit 0  (허용)
#   Write → exit 2  (차단, VK-07)
#   Edit  → exit 2  (차단, VK-07)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE_KEEPER="$SCRIPT_DIR/../hooks/vela-gate.js"  # v7.3-M4c: keeper + guard merged

PASS=0
FAIL=0
TOTAL=0

# ── helpers ──────────────────────────────────────────────────

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/templates"

  # config.json — sandbox enabled
  cat > "$PROJECT/.vela/config.json" <<'EOF'
{
  "sandbox": { "enabled": true },
  "project_name": "test-vk07"
}
EOF

  # pipeline-state.json — active standard pipeline (flat structure)
  local ARTIFACT_DIR="$PROJECT/.vela/artifacts/20260101T000000-test-vk07"
  mkdir -p "$ARTIFACT_DIR"
  cat > "$ARTIFACT_DIR/pipeline-state.json" <<'EOF'
{
  "status": "active",
  "pipeline_type": "standard",
  "current_step": "plan"
}
EOF

  # pipeline.json — minimal definition so getCurrentMode works
  cat > "$PROJECT/.vela/templates/pipeline.json" <<'EOF'
{
  "pipelines": {
    "standard": {
      "steps": [
        { "id": "plan", "mode": "read" }
      ]
    }
  }
}
EOF

  # delegation.json이 없는 것이 핵심 — 생성하지 않는다

  # 테스트 대상 소스 파일
  echo "console.log('hello');" > "$PROJECT/index.js"
}

teardown_sandbox() {
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}

run_gate() {
  local tool_name="$1"
  local tool_input="$2"
  local json
  json=$(cat <<ENDJSON
{
  "tool_name": "$tool_name",
  "tool_input": $tool_input,
  "session_id": "test-session",
  "cwd": "$PROJECT"
}
ENDJSON
  )
  echo "$json" | node "$GATE_KEEPER" 2>/dev/null
  return ${PIPESTATUS[1]}
}

assert_exit() {
  local label="$1"
  local expected="$2"
  local tool_name="$3"
  local tool_input="$4"

  TOTAL=$((TOTAL + 1))
  local actual=0
  run_gate "$tool_name" "$tool_input" || actual=$?

  if [ "$actual" -eq "$expected" ]; then
    echo "  ✅ PASS: $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected exit $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

# ── main ─────────────────────────────────────────────────────

trap teardown_sandbox EXIT
setup_sandbox

echo "⛵ VK-07 Read 허용 / Write 차단 테스트"
echo "─────────────────────────────────────"

# 1. Read → exit 0
assert_exit "Read index.js → 허용 (exit 0)" 0 \
  "Read" '{"file_path":"index.js"}'

# 2. Glob → exit 0
assert_exit "Glob *.js → 허용 (exit 0)" 0 \
  "Glob" '{"pattern":"*.js"}'

# 3. Grep → exit 0
assert_exit "Grep console → 허용 (exit 0)" 0 \
  "Grep" '{"pattern":"console"}'

# 4. Write → exit 2
assert_exit "Write index.js → 차단 (exit 2)" 2 \
  "Write" '{"file_path":"index.js","content":"modified"}'

# 5. Edit → exit 2
assert_exit "Edit index.js → 차단 (exit 2)" 2 \
  "Edit" '{"file_path":"index.js","new_string":"modified"}'

echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
