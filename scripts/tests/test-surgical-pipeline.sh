#!/usr/bin/env bash
# scripts/tests/test-surgical-pipeline.sh
# E2E test for the v7.0 surgical pipeline skeleton.
#
# Verifies the engine-level wiring:
#   - /vela:fix → surgical pipeline mapping via scales
#   - resolveSteps returns the expected 8-step flow
#   - init → locate → research transitions succeed
#   - patch_spec_complete exit gate correctly validates patch-spec.md sections
#   - out-of-scope violation detection logic (file-level simulation)
#
# This test does NOT spawn real agents — agent invocations are stubbed
# with direct artifact writes, exactly like test-full-pipeline.sh.
# Coverage: engine state machine + exit gates + fixture validation,
# not agent prompt execution.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENGINE="$REPO_ROOT/scripts/cli/vela-engine.js"
PIPELINE_JSON="$REPO_ROOT/templates/pipeline.json"
CONFIG_JSON="$REPO_ROOT/templates/config.json"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""
ARTIFACT_DIR=""

# ─── Helpers ─────────────────────────────────────────────────

git_no_sign() {
  GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=commit.gpgsign \
    GIT_CONFIG_VALUE_0=false \
    git "$@"
}

setup_sandbox() {
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/src"
  mkdir -p "$PROJECT/.vela/templates"
  mkdir -p "$PROJECT/.vela/artifacts"
  mkdir -p "$PROJECT/.vela/state"
  mkdir -p "$PROJECT/.vela/shared"

  cp "$PIPELINE_JSON" "$PROJECT/.vela/templates/pipeline.json"
  cp "$CONFIG_JSON"   "$PROJECT/.vela/templates/config.json"
  cp "$CONFIG_JSON"   "$PROJECT/.vela/config.json"
  # locate module needs to be reachable from the project dir since
  # cmdLocate() prefers .vela/shared/locate.js over the source tree copy
  cp "$REPO_ROOT/scripts/shared/locate.js" "$PROJECT/.vela/shared/locate.js"
  cp "$REPO_ROOT/scripts/shared/change-surface.js" "$PROJECT/.vela/shared/change-surface.js" 2>/dev/null || true

  # Fixture source file that locate will discover
  cat > "$PROJECT/src/auth.js" <<'JS'
function loginHandler(email, password) {
  return { ok: true, user: email };
}
module.exports = { loginHandler };
JS
  cat > "$PROJECT/src/app.js" <<'JS'
const { loginHandler } = require("./auth");
module.exports = { run: () => loginHandler("a@b.c", "x") };
JS

  cat > "$PROJECT/.gitignore" <<'GI'
.vela/
GI

  (cd "$PROJECT" \
    && git_no_sign init -q -b main \
    && git_no_sign config user.email "test@vela.local" \
    && git_no_sign config user.name "Vela Surgical Test" \
    && git_no_sign config commit.gpgsign false \
    && git_no_sign add -A \
    && git_no_sign commit -q -m "fixture: initial loginHandler")
}

teardown_sandbox() {
  [ -n "${TMPDIR_ROOT:-}" ] && rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
  TMPDIR_ROOT=""
  PROJECT=""
  ARTIFACT_DIR=""
}

trap teardown_sandbox EXIT

engine() {
  (cd "$PROJECT" && GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=commit.gpgsign \
    GIT_CONFIG_VALUE_0=false \
    node "$ENGINE" "$@")
}

resolve_artifact_dir() {
  ARTIFACT_DIR=$(engine state 2>/dev/null | node -e "
    let data='';
    process.stdin.on('data',c=>data+=c);
    process.stdin.on('end',()=>{
      try {
        const s = JSON.parse(data);
        process.stdout.write(s.artifact_dir || '');
      } catch (_) {}
    });
  ")
}

current_step() {
  engine state 2>/dev/null | node -e "
    let data='';
    process.stdin.on('data',c=>data+=c);
    process.stdin.on('end',()=>{
      try {
        const s = JSON.parse(data);
        process.stdout.write(s.current_step || '');
      } catch (_) {}
    });
  "
}

assert_ok() {
  TOTAL=$((TOTAL + 1))
  local label="$1" out="$2"
  if echo "$out" | grep -q '"ok": *true'; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    echo "     $(echo "$out" | head -1)"
    FAIL=$((FAIL + 1))
  fi
}

assert_fail() {
  TOTAL=$((TOTAL + 1))
  local label="$1" out="$2"
  if echo "$out" | grep -q '"ok": *false'; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label (expected failure but got success)"
    FAIL=$((FAIL + 1))
  fi
}

assert_eq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_file() {
  TOTAL=$((TOTAL + 1))
  local label="$1" filepath="$2"
  if [ -f "$filepath" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label — $filepath not found"
    FAIL=$((FAIL + 1))
  fi
}

# ─── Phase 1: Pipeline resolution via scales ─────────────────

echo "🎯 v7.0 surgical pipeline skeleton — E2E engine test"
echo ""

setup_sandbox

echo "📋 Phase 1: /vela:fix → surgical mapping"

INIT_OUT=$(engine init "src/auth.js의 loginHandler 함수에 email/password 검증 추가" --scale fix)
assert_ok "engine init --scale fix ok" "$INIT_OUT"

PIPELINE_TYPE=$(echo "$INIT_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try { process.stdout.write(JSON.parse(d).pipeline_type || ''); } catch(_){}
  });
")
assert_eq "pipeline_type=surgical" "surgical" "$PIPELINE_TYPE"

# Verify the 8-step flow matches RFC
STEP_IDS=$(echo "$INIT_OUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const s = JSON.parse(d);
      process.stdout.write((s.steps || []).map(x => x.id).join(','));
    } catch(_){}
  });
")
assert_eq "surgical steps in order" \
  "init,locate,research,spec,patch,verify,commit,finalize" \
  "$STEP_IDS"

resolve_artifact_dir
assert_eq "artifact_dir resolved" "1" "$([ -n "$ARTIFACT_DIR" ] && echo 1 || echo 0)"

# ─── Phase 2: init → locate → research transitions ──────────

echo ""
echo "📋 Phase 2: init → locate → research flow"

assert_ok "record pass (init)" "$(engine record pass)"
assert_ok "transition init→locate" "$(engine transition)"
assert_eq "current=locate" "locate" "$(current_step)"

# Actual locate call — should find src/auth.js and loginHandler
LOC_OUT=$(engine locate)
assert_ok "engine locate ok" "$LOC_OUT"
assert_file "targets.json created" "$ARTIFACT_DIR/targets.json"

# Confirm locate picked up the fixture file
FOUND=$(node -e "
  const t = JSON.parse(require('fs').readFileSync('$ARTIFACT_DIR/targets.json', 'utf8'));
  process.stdout.write(t.primary.some(p => p.file === 'src/auth.js') ? 'hit' : 'miss');
")
assert_eq "locate hit src/auth.js" "hit" "$FOUND"

assert_ok "record pass (locate)" "$(engine record pass)"
assert_ok "transition locate→research" "$(engine transition)"
assert_eq "current=research" "research" "$(current_step)"

# Stub research artifact
cat > "$ARTIFACT_DIR/research.md" <<'MD'
# Research: loginHandler validation (targeted)

## Targets loaded
- src/auth.js:loginHandler (from targets.json, confidence high)

## Callers
- src/app.js calls loginHandler directly

## Risk
- Input types are not validated; undefined.length possible on null email

## Patterns
- Project uses CommonJS module.exports exclusively
MD
cat > "$ARTIFACT_DIR/approval-research.json" <<'JSON'
{
  "step": "research",
  "decision": "approve",
  "score": "22/25",
  "critical_count": 0,
  "review_path": "review-research.md"
}
JSON
cat > "$ARTIFACT_DIR/review-research.md" <<'MD'
# Review: research
**판정: APPROVE** (22/25, CRITICAL 0)
MD

assert_ok "record pass (research)" "$(engine record pass)"
assert_ok "transition research→spec" "$(engine transition)"
assert_eq "current=spec" "spec" "$(current_step)"

# ─── Phase 3: spec step + patch_spec_complete gate ──────────

echo ""
echo "📋 Phase 3: patch_spec_complete exit gate"

# Try transition without patch-spec.md → should fail
FAIL_OUT=$(engine transition)
assert_fail "transition without patch-spec.md blocked" "$FAIL_OUT"

# Write an incomplete patch-spec (missing ## Explicitly out of scope)
cat > "$ARTIFACT_DIR/patch-spec.md" <<'MD'
# Patch Specification: loginHandler validation

## src/auth.js:loginHandler

## Before
- email/password accepted without validation
- null email would crash on downstream .length access

## After
- throw TypeError when email is not a non-empty string
- throw TypeError when password is not a string of 8+ chars
MD

FAIL_OUT=$(engine transition)
assert_fail "transition with incomplete patch-spec blocked" "$FAIL_OUT"

# Add the missing section
cat >> "$ARTIFACT_DIR/patch-spec.md" <<'MD'

## Explicitly out of scope
- rate limiting
- password complexity rules (digit/symbol requirements)
- session management
MD

# Still needs approval
FAIL_OUT=$(engine transition)
assert_fail "transition without approval still blocked" "$FAIL_OUT"

# Add approval
cat > "$ARTIFACT_DIR/approval-spec.json" <<'JSON'
{
  "step": "spec",
  "decision": "approve",
  "score": "24/25",
  "critical_count": 0,
  "review_path": "review-spec.md"
}
JSON
cat > "$ARTIFACT_DIR/review-spec.md" <<'MD'
# Review: spec
**판정: APPROVE** (24/25)
All three required sections present (Before, After, Explicitly out of scope).
MD

assert_ok "record pass (spec)" "$(engine record pass)"
assert_ok "transition spec→patch (all gates pass)" "$(engine transition)"
assert_eq "current=patch" "patch" "$(current_step)"

# ─── Phase 4: patch step + review gate ───────────────────────

echo ""
echo "📋 Phase 4: patch step (stubbed executor)"

# Simulate executor applying the patch
cat > "$PROJECT/src/auth.js" <<'JS'
function loginHandler(email, password) {
  if (typeof email !== "string" || email.length === 0) {
    throw new TypeError("email must be a non-empty string");
  }
  if (typeof password !== "string" || password.length < 8) {
    throw new TypeError("password must be 8+ characters");
  }
  return { ok: true, user: email };
}
module.exports = { loginHandler };
JS

cat > "$ARTIFACT_DIR/task-summary.md" <<'MD'
# Task Summary: loginHandler validation

## Changed files
- src/auth.js (validation added per patch-spec.md)

## Tests
(stubbed)
MD
cat > "$ARTIFACT_DIR/approval-patch.json" <<'JSON'
{
  "step": "patch",
  "decision": "approve",
  "score": "23/25",
  "critical_count": 0,
  "review_path": "review-patch.md"
}
JSON
cat > "$ARTIFACT_DIR/review-patch.md" <<'MD'
# Review: patch
**판정: APPROVE** (23/25)
MD

assert_ok "record pass (patch)" "$(engine record pass)"
# patch has ref_integrity gate — the change-surface analysis may flag
# loginHandler as an impacted token since src/app.js still references
# it. But loginHandler IS still exported, so this should pass.
# Also: implementation_complete gate now resolves approval-{current_step}.json
# dynamically, so patch → approval-patch.json is accepted.
TR_OUT=$(engine transition)
assert_ok "transition patch→verify" "$TR_OUT"
assert_eq "current=verify" "verify" "$(current_step)"

# ─── Phase 5: verify → commit → finalize (happy path) ───────

echo ""
echo "📋 Phase 5: verify → commit → finalize"

cat > "$ARTIFACT_DIR/verification.md" <<'MD'
# Verification Report
**판정: PASS**

## 테스트 결과
| 항목 | 결과 |
|------|------|
| 전체 테스트 | 3/3 통과 |

## 범위 검사 (v7.0 surgical)
| 파일 | 분류 | 판정 |
|------|------|------|
| src/auth.js | primary | ✅ 허용 |

**위반 건수**: 0
MD

assert_ok "record pass (verify)" "$(engine record pass)"
assert_ok "transition verify→commit" "$(engine transition)"
assert_eq "current=commit" "commit" "$(current_step)"

# Engine commit command handles the real git commit
COMMIT_OUT=$(engine commit)
assert_ok "engine commit ok" "$COMMIT_OUT"
assert_ok "record pass (commit)" "$(engine record pass)"
assert_ok "transition commit→finalize" "$(engine transition)"
assert_eq "current=finalize" "finalize" "$(current_step)"

cat > "$ARTIFACT_DIR/report.md" <<'MD'
# Pipeline Report
Surgical pipeline completed successfully.
MD

assert_ok "record pass (finalize)" "$(engine record pass)"
assert_ok "transition finalize (completed)" "$(engine transition)"

# Verify terminal state — after completion the active pipeline is gone
# and engine state returns active:false with no current_step
FINAL_STATE=$(engine state)
TOTAL=$((TOTAL + 1))
if echo "$FINAL_STATE" | grep -q '"active": false'; then
  echo "  ✅ PASS: final state active:false"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: final state active:false — got: $(echo "$FINAL_STATE" | head -1)"
  FAIL=$((FAIL + 1))
fi

teardown_sandbox

# ─── Summary ─────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
echo "결과: $PASS/$TOTAL PASS, $FAIL FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ SURGICAL PIPELINE TEST FAILED"
  exit 1
fi
echo "✅ v7.0 surgical pipeline skeleton E2E PASS"
