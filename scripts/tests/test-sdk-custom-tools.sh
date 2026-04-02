#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-sdk-custom-tools.sh — sdk-custom-tools.js 계약 테스트
#
# Tests run with a mock SDK module (no real API calls).
# Mock SDK placed in scripts/shared/node_modules/ (temporary)
# so dynamic import() resolves it from sdk-custom-tools.js's location.
#
# Test 1: Module loads without syntax error (node -c)
# Test 2: createVelaToolServer returns object with type 'sdk'
# Test 3: vela_pipeline_status reads pipeline-state.json correctly
# Test 4: vela_read_artifact reads file, rejects path traversal
# Test 5: vela_record_note appends to notes.md
# Test 6: SDK unavailable returns graceful error
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODULE="$PROJECT_ROOT/scripts/shared/sdk-custom-tools.js"
MODULE_DIR="$PROJECT_ROOT/scripts/shared"
MOCK_NM="$MODULE_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
ARTIFACT_DIR=""

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

# Install mock SDK that exports createSdkMcpServer and tool
# (plus query for compatibility) in sdk-custom-tools.js's node_modules
setup_mock_sdk() {
  ARTIFACT_DIR="$(mktemp -d)"
  mkdir -p "$MOCK_NM"

  cat > "$MOCK_NM/package.json" <<'MPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.2.0-mock", "main": "index.js", "exports": { ".": "./index.js" } }
MPKG

  # Mock index.js — createSdkMcpServer collects tools and returns config,
  # tool() creates tool descriptors that can be invoked in tests
  cat > "$MOCK_NM/index.js" <<'MOCK'
'use strict';

function createSdkMcpServer(opts) {
  const toolMap = {};
  if (opts.tools) {
    opts.tools.forEach(t => { toolMap[t.name] = t; });
  }
  return {
    type: 'sdk',
    name: opts.name,
    instance: {
      _tools: toolMap,
      // Helper to invoke a tool by name (for testing)
      async callTool(name, input) {
        const t = toolMap[name];
        if (!t) throw new Error('Tool not found: ' + name);
        return t.handler(input || {});
      }
    }
  };
}

function tool(name, description, inputSchema, handler, options) {
  return { name, description, inputSchema, handler, annotations: options?.annotations, _meta: undefined };
}

function query() { throw new Error('query not implemented in custom-tools mock'); }

module.exports = { createSdkMcpServer, tool, query };
MOCK
}

teardown_mock_sdk() {
  rm -rf "$MODULE_DIR/node_modules" 2>/dev/null || true
  rm -rf "$ARTIFACT_DIR" 2>/dev/null || true
}

# Run node with cache clearing from project root
run_with_mock() {
  local js_code="$1"
  ARTIFACT_DIR="$ARTIFACT_DIR" node -e "
    // Clear cached modules to pick up mock on each test
    Object.keys(require.cache).forEach(k => {
      if (k.includes('sdk-custom-tools') || k.includes('claude-agent-sdk')) delete require.cache[k];
    });
    $js_code
  " 2>/dev/null
}

# ── main ─────────────────────────────────────────────────────

echo "🔧 SDK Custom Tools 계약 테스트"
echo "─────────────────────────────────────"

# ── Test 1: Module loads without syntax error ──
echo ""
echo "📋 Test 1: Module loads without syntax error"
exit_code=0
node -c "$MODULE" 2>/dev/null || exit_code=$?
assert_eq "node -c passes" "0" "$exit_code"

# ── Test 2: createVelaToolServer returns object with type 'sdk' ──
echo ""
echo "📋 Test 2: createVelaToolServer returns object with type 'sdk'"
setup_mock_sdk
trap teardown_mock_sdk EXIT

result=$(run_with_mock "
  const { createVelaToolServer } = require('$MODULE');
  createVelaToolServer(process.env.ARTIFACT_DIR).then(r => {
    const checks = [
      r.type === 'sdk',
      r.name === 'vela-tools',
      r.instance != null,
      typeof r.instance._tools === 'object',
      'vela_pipeline_status' in r.instance._tools,
      'vela_read_artifact' in r.instance._tools,
      'vela_record_note' in r.instance._tools
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + JSON.stringify({type:r.type,name:r.name,tools:Object.keys(r.instance?._tools||{})}));
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "server type=sdk, name=vela-tools, 3 tools" "PASS" "$result"

# ── Test 3: vela_pipeline_status reads pipeline-state.json correctly ──
echo ""
echo "📋 Test 3: vela_pipeline_status reads pipeline-state.json correctly"

# Write test pipeline state
cat > "$ARTIFACT_DIR/pipeline-state.json" <<'STATE'
{
  "status": "running",
  "current_step": "code_review",
  "completed_steps": ["analyze", "plan"],
  "cost": 0.025
}
STATE

result=$(run_with_mock "
  const { createVelaToolServer } = require('$MODULE');
  createVelaToolServer(process.env.ARTIFACT_DIR).then(async (server) => {
    const r = await server.instance.callTool('vela_pipeline_status', {});
    const text = r.content[0].text;
    const data = JSON.parse(text);
    const checks = [
      data.status === 'running',
      data.current_step === 'code_review',
      Array.isArray(data.completed_steps) && data.completed_steps.length === 2,
      data.cost === 0.025
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + text);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "pipeline status read" "PASS" "$result"

# Test 3b: pipeline-state.json missing returns error
result=$(run_with_mock "
  const { createVelaToolServer } = require('$MODULE');
  const tmpDir = require('os').tmpdir() + '/vela-test-empty-' + Date.now();
  require('fs').mkdirSync(tmpDir, { recursive: true });
  createVelaToolServer(tmpDir).then(async (server) => {
    const r = await server.instance.callTool('vela_pipeline_status', {});
    const text = r.content[0].text;
    const data = JSON.parse(text);
    require('fs').rmSync(tmpDir, { recursive: true });
    console.log(data.error ? 'PASS' : 'FAIL:' + text);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "pipeline status missing file → error" "PASS" "$result"

# ── Test 4: vela_read_artifact reads file, rejects path traversal ──
echo ""
echo "📋 Test 4: vela_read_artifact reads file, rejects path traversal"

# Write test artifact
echo "test artifact content" > "$ARTIFACT_DIR/report.txt"

# 4a: read valid artifact
result=$(run_with_mock "
  const { createVelaToolServer } = require('$MODULE');
  createVelaToolServer(process.env.ARTIFACT_DIR).then(async (server) => {
    const r = await server.instance.callTool('vela_read_artifact', { filename: 'report.txt' });
    const text = r.content[0].text;
    console.log(text.trim() === 'test artifact content' ? 'PASS' : 'FAIL:' + text);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "read artifact success" "PASS" "$result"

# 4b: reject path traversal
result=$(run_with_mock "
  const { createVelaToolServer } = require('$MODULE');
  createVelaToolServer(process.env.ARTIFACT_DIR).then(async (server) => {
    const r = await server.instance.callTool('vela_read_artifact', { filename: '../../etc/passwd' });
    const text = r.content[0].text;
    const data = JSON.parse(text);
    const checks = [
      data.error != null,
      r.isError === true
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + text);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "path traversal blocked" "PASS" "$result"

# ── Test 5: vela_record_note appends to notes.md ──
echo ""
echo "📋 Test 5: vela_record_note appends to notes.md"

result=$(run_with_mock "
  const fs = require('fs');
  const path = require('path');
  const { createVelaToolServer } = require('$MODULE');
  createVelaToolServer(process.env.ARTIFACT_DIR).then(async (server) => {
    // Append two notes
    await server.instance.callTool('vela_record_note', { note: 'First observation' });
    await server.instance.callTool('vela_record_note', { note: 'Second observation' });

    // Read notes.md and verify
    const content = fs.readFileSync(path.join(process.env.ARTIFACT_DIR, 'notes.md'), 'utf8');
    const checks = [
      content.includes('First observation'),
      content.includes('Second observation'),
      // Should have ISO timestamps
      /\[\d{4}-\d{2}-\d{2}T/.test(content)
    ];
    console.log(checks.every(Boolean) ? 'PASS' : 'FAIL:' + content);
  }).catch(e => console.log('ERROR:' + e.message));
")
assert_eq "notes appended with timestamps" "PASS" "$result"

# ── Test 6: SDK unavailable returns graceful error ──
echo ""
echo "📋 Test 6: SDK unavailable returns graceful error"

# Replace mock with a broken one
teardown_mock_sdk
ARTIFACT_DIR="$(mktemp -d)"
mkdir -p "$MOCK_NM"
cat > "$MOCK_NM/package.json" <<'BPKG'
{ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.0.0-broken", "main": "index.js", "exports": { ".": "./index.js" } }
BPKG
cat > "$MOCK_NM/index.js" <<'BROKEN'
'use strict';
// Broken mock: no createSdkMcpServer or tool exports
module.exports = {};
BROKEN

result=$(node -e "
  Object.keys(require.cache).forEach(k => {
    if (k.includes('sdk-custom-tools') || k.includes('claude-agent-sdk')) delete require.cache[k];
  });
  const { createVelaToolServer } = require('$MODULE');
  createVelaToolServer('/tmp/test-dir').then(r => {
    console.log(JSON.stringify(r));
  }).catch(e => {
    console.log(JSON.stringify({ crashed: true, error: e.message }));
  });
" 2>/dev/null)
assert_contains "ok is false" '"ok":false' "$result"
assert_contains "error is sdk_not_available" '"error":"sdk_not_available"' "$result"

# ── Results ──
echo ""
echo "─────────────────────────────────────"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✅ 전체 PASS"
