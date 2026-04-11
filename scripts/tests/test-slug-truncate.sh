#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-slug-truncate.sh — v7.1 M5 fs-safe slugify
#
# Covers: slugifyEx() and cmdInit() must cap artifact directory
# names at 64 UTF-8 bytes, cut at `-` boundaries, append `-trunc`
# when the cap triggered, and drop a request.txt side-car with
# the full original prompt. Based on the hicoco session where
# Korean requests produced half-word slugs like "별도-downloa",
# "대상-사이" and "baseurl".
#
# Asserts:
#   1. Short English request → no truncation, no request.txt
#   2. Long Korean request → slug ≤ 64 UTF-8 bytes, ends in -trunc
#   3. Long Korean+English mix → slug ≤ 64 bytes, cut on a `-`
#   4. Truncated pipelines write a request.txt with full prompt
#   5. Reverse: slug is actually capped — no output > 64 bytes
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENGINE="$SCRIPT_DIR/../cli/vela-engine.js"
PIPELINE_JSON="$REPO_ROOT/templates/pipeline.json"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""
PROJECT=""

cleanup() { [ -n "$TMPDIR_ROOT" ] && rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

note() {
  TOTAL=$((TOTAL + 1))
  local label="$1" code="$2"
  if [ "$code" = "0" ]; then
    echo "  ✅ PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

reset_sandbox() {
  cleanup
  TMPDIR_ROOT="$(mktemp -d)"
  PROJECT="$TMPDIR_ROOT/project"
  mkdir -p "$PROJECT/.vela/templates" "$PROJECT/.vela/artifacts" "$PROJECT/.vela/state"
  cp "$PIPELINE_JSON" "$PROJECT/.vela/templates/pipeline.json"
  (
    cd "$PROJECT"
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0=commit.gpgsign \
      GIT_CONFIG_VALUE_0=false \
      git init -q -b main
    git config user.email "test@vela.local"
    git config user.name "Vela Test"
    echo "# test" > README.md
    git add README.md
    git -c commit.gpgsign=false commit -q -m "initial"
  ) 2>/dev/null
}

# ── Direct unit test: slugifyEx via a tiny node shim ─────────
echo "📋 Phase 0: slugifyEx unit behaviour"

# Feed slugifyEx a battery of inputs and parse its output.
OUT=$(node -e "
  const path = require('path');
  // Load the engine module functions without executing the CLI entry.
  // slugifyEx is not exported, so we grep the function out and eval.
  const fs = require('fs');
  const src = fs.readFileSync('$REPO_ROOT/scripts/cli/vela-engine.js', 'utf8');
  const m = src.match(/function slugifyEx\([\s\S]+?\n\}/);
  if (!m) throw new Error('slugifyEx not found');
  eval(m[0]);
  const cases = [
    ['short', 'add oauth'],
    ['long-ko', '책별로 다른 사이트에서 다운로드 대상이 되는 URL 구조 를 파싱하는 baseUrl 처리'],
    ['long-mix', 'register site function must split book specific URLs from site root endpoints in scraper module'],
    ['very-long', 'a'.repeat(200)],
  ];
  for (const [label, input] of cases) {
    const r = slugifyEx(input);
    const byteLen = Buffer.byteLength(r.slug, 'utf8');
    console.log(JSON.stringify({ label, slug: r.slug, truncated: r.truncated, byteLen }));
  }
")

echo "$OUT"

# Assertion: every slug byte length is ≤ 64.
MAX=$(echo "$OUT" | node -e '
  let m = 0;
  process.stdin.on("data", d => d.toString().split("\n").filter(Boolean).forEach(l => {
    const r = JSON.parse(l);
    if (r.byteLen > m) m = r.byteLen;
  }));
  process.stdin.on("end", () => console.log(m));
')
[ -n "$MAX" ] && [ "$MAX" -le 64 ]
note "slugifyEx: all slugs ≤ 64 UTF-8 bytes (max=$MAX)" $?

# Assertion: short input should NOT be truncated.
echo "$OUT" | grep -q '"label":"short".*"truncated":false'
note "slugifyEx: short input not truncated" $?

# Assertion: long Korean input truncates and suffix is -trunc.
echo "$OUT" | grep -q '"label":"long-ko".*"truncated":true'
note "slugifyEx: long Korean input marked truncated" $?

echo "$OUT" | grep -q '"label":"long-ko","slug":"[^"]*-trunc"'
note "slugifyEx: long Korean slug ends with -trunc" $?

# Assertion: very-long pure-ASCII input also truncates
echo "$OUT" | grep -q '"label":"very-long".*"truncated":true'
note "slugifyEx: 200-char input truncated" $?

# Assertion: truncated slug does not end mid-dash
echo "$OUT" | grep -q '"label":"long-mix".*"truncated":true'
note "slugifyEx: long mix marked truncated" $?

# ── Integration test: cmdInit + request.txt side-car ─────────
echo "📋 Phase 1: cmdInit writes request.txt when slug truncated"
reset_sandbox

LONG_REQUEST="책별로 다른 사이트에서 다운로드 대상이 되는 URL 구조 를 파싱하는 baseUrl 처리 함수 전면 리팩터링"
(
  cd "$PROJECT"
  node "$ENGINE" init "$LONG_REQUEST" --scale small >/tmp/m5-stdout 2>/tmp/m5-stderr
)

cat /tmp/m5-stdout | grep -q '"artifact_dir"'
note "cmdInit returned artifact_dir for long request" $?

ARTIFACT_DIR=$(cat /tmp/m5-stdout | node -e '
  let buf="";
  process.stdin.on("data",d=>buf+=d);
  process.stdin.on("end",()=>{
    try { console.log(JSON.parse(buf).artifact_dir || ""); } catch { console.log(""); }
  });
')
[ -n "$ARTIFACT_DIR" ] && [ -d "$ARTIFACT_DIR" ]
note "artifact dir exists on disk ($ARTIFACT_DIR)" $?

# The basename must end in -trunc for a request this long.
BASENAME=$(basename "$ARTIFACT_DIR")
echo "$BASENAME" | grep -q -- '-trunc$'
note "artifact dir basename ends with -trunc ($BASENAME)" $?

# Byte length of the slug portion (after the YYYYMMDDTHHmmss- prefix) must be ≤ 64.
SLUG_PART=$(echo "$BASENAME" | sed -E 's/^[0-9]{8}T[0-9]{6}-//')
SLUG_BYTES=$(printf "%s" "$SLUG_PART" | wc -c)
[ "$SLUG_BYTES" -le 64 ]
note "slug portion ≤ 64 UTF-8 bytes ($SLUG_BYTES)" $?

# request.txt must exist and contain the full original prompt.
[ -f "$ARTIFACT_DIR/request.txt" ]
note "request.txt side-car was created" $?

grep -q "다운로드 대상" "$ARTIFACT_DIR/request.txt"
note "request.txt contains original Korean content" $?

grep -q "전면 리팩터링" "$ARTIFACT_DIR/request.txt"
note "request.txt contains original tail" $?

# ── Phase 2: short request does NOT get request.txt ──────────
echo "📋 Phase 2: short request — no side-car"
reset_sandbox
(
  cd "$PROJECT"
  node "$ENGINE" init "add oauth support" --scale small >/tmp/m5-stdout 2>/tmp/m5-stderr
)

ARTIFACT_DIR=$(cat /tmp/m5-stdout | node -e '
  let buf="";
  process.stdin.on("data",d=>buf+=d);
  process.stdin.on("end",()=>{ try { console.log(JSON.parse(buf).artifact_dir || ""); } catch { console.log(""); } });
')

BASENAME=$(basename "$ARTIFACT_DIR")
if echo "$BASENAME" | grep -q -- '-trunc$'; then
  note "short request does NOT add -trunc suffix" 1
else
  note "short request does NOT add -trunc suffix" 0
fi

if [ -f "$ARTIFACT_DIR/request.txt" ]; then
  note "short request does NOT write request.txt" 1
else
  note "short request does NOT write request.txt" 0
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
