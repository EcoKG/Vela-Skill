#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-verifier-smoke.sh — v7.1 M3 verifier Phase 3 smoke test
#
# Covers: the prompt + template files that together define
# verifier Phase 3 (smoke test). Since we can't actually run a
# Claude Code Agent in a test, we assert on three things:
#
#   1. vela-verifier.md contains the Phase 0/3/4.5/5 sections
#      and the "PARTIAL PASS 금지" rule
#   2. templates/guidelines/{live-processes.json,
#      smoke-test.sh.example} exist and parse
#   3. install.js FILE_MANIFEST registers both new templates
#      (so that `upgrade` deploys them to .vela/templates/)
#   4. The example smoke-test.sh.example shell syntax is valid
#      (`bash -n`), and its `set -e` / exit-code contract is
#      preserved so users who copy it get a correct template
#   5. The M3 fallback logic — "no smoke-test defined" → PASS
#      with WARNING, not PARTIAL PASS — is documented in the
#      verifier prompt
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERIFIER_MD="$REPO_ROOT/scripts/agents/vela-verifier.md"
INSTALL_JS="$REPO_ROOT/scripts/install.js"
LIVE_JSON="$REPO_ROOT/templates/guidelines/live-processes.json"
SMOKE_EXAMPLE="$REPO_ROOT/templates/guidelines/smoke-test.sh.example"

PASS=0
FAIL=0
TOTAL=0

note() {
  TOTAL=$((TOTAL + 1))
  if [ "$2" = "0" ]; then
    echo "  ✅ PASS: $1"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $1"
    FAIL=$((FAIL + 1))
  fi
}

# ── Phase 1: verifier.md structural assertions ───────────────
echo "📋 Phase 1: vela-verifier.md contains v7.1 Phase sections"

grep -q '^### Phase 0' "$VERIFIER_MD"
note "Phase 0 — Long-running process recovery section" $?

grep -q 'live-processes.json' "$VERIFIER_MD"
note "Phase 0 references live-processes.json" $?

grep -q 'stale dev server' "$VERIFIER_MD"
note "Phase 0 explains the stale-dev-server motivation" $?

grep -q '^### Phase 1' "$VERIFIER_MD"
note "Phase 1 — Static checks section" $?

grep -q '^### Phase 2' "$VERIFIER_MD"
note "Phase 2 — Unit tests section" $?

grep -q '^### Phase 3' "$VERIFIER_MD"
note "Phase 3 — Smoke test section" $?

grep -q '\.vela/guidelines/smoke-test\.sh' "$VERIFIER_MD"
note "Phase 3 references .vela/guidelines/smoke-test.sh" $?

grep -q 'test:smoke' "$VERIFIER_MD"
note "Phase 3 references package.json scripts.test:smoke" $?

grep -q 'WARNING: no smoke test defined' "$VERIFIER_MD"
note "Phase 3 documents the no-smoke-test warning path" $?

grep -q '^### Phase 4' "$VERIFIER_MD"
note "Phase 4 — Reference integrity section" $?

grep -q '^### Phase 4.5' "$VERIFIER_MD"
note "Phase 4.5 — Out-of-scope violation section" $?

grep -q '^### Phase 5' "$VERIFIER_MD"
note "Phase 5 — verification.md writing section" $?

# PARTIAL PASS must be explicitly banned
grep -q 'PARTIAL PASS' "$VERIFIER_MD" || { note "verifier.md mentions PARTIAL PASS at all" 1; true; }
if grep -q '"PARTIAL PASS" 라는.*회색 지대\|PARTIAL PASS.*금지' "$VERIFIER_MD"; then
  note "verifier.md explicitly bans PARTIAL PASS" 0
else
  note "verifier.md explicitly bans PARTIAL PASS" 1
fi

# Bash fallback rule
grep -q 'Bash 차단 시 대응' "$VERIFIER_MD"
note "verifier.md has Bash 차단 시 대응 section" $?

grep -q 'fallback: true' "$VERIFIER_MD"
note "verifier.md fallback: true field documented" $?

# ── Phase 2: template files exist and parse ──────────────────
echo "📋 Phase 2: template files exist and are valid"

[ -f "$LIVE_JSON" ]
note "templates/guidelines/live-processes.json exists" $?

node -e "JSON.parse(require('fs').readFileSync('$LIVE_JSON','utf8'))" 2>/dev/null
note "live-processes.json parses as JSON" $?

node -e "
  const j = JSON.parse(require('fs').readFileSync('$LIVE_JSON','utf8'));
  if (!j.processes || !Array.isArray(j.processes)) throw new Error('no processes[]');
  if (j.processes.length < 1) throw new Error('empty processes[]');
  const p = j.processes[0];
  for (const k of ['name','port','restartCommand','readyPath','readyTimeoutMs']) {
    if (!(k in p)) throw new Error('missing key: '+k);
  }
" 2>/dev/null
note "live-processes.json schema includes all required keys" $?

[ -f "$SMOKE_EXAMPLE" ]
note "templates/guidelines/smoke-test.sh.example exists" $?

bash -n "$SMOKE_EXAMPLE" 2>/dev/null
note "smoke-test.sh.example is valid bash syntax" $?

grep -q 'set -euo pipefail' "$SMOKE_EXAMPLE"
note "smoke-test.sh.example uses set -euo pipefail" $?

grep -q 'exit 1' "$SMOKE_EXAMPLE"
note "smoke-test.sh.example has at least one exit 1 branch" $?

# ── Phase 3: install.js FILE_MANIFEST wiring ─────────────────
echo "📋 Phase 3: install.js FILE_MANIFEST entries"

grep -q 'templates/guidelines/live-processes.json' "$INSTALL_JS"
note "FILE_MANIFEST includes live-processes.json" $?

grep -q 'templates/guidelines/smoke-test.sh.example' "$INSTALL_JS"
note "FILE_MANIFEST includes smoke-test.sh.example" $?

# ── Phase 4: deploy smoke test ───────────────────────────────
echo "📋 Phase 4: smoke template deploys via install.js"

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

FAKE_HOME="$TMPDIR_ROOT/home"; mkdir -p "$FAKE_HOME/.claude"
PROJECT="$TMPDIR_ROOT/project"; mkdir -p "$PROJECT/.vela"
(
  cd "$PROJECT"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false \
    git init -q -b main
  git config user.email t@v.local
  git config user.name t
  echo "# x" > README.md
  git add README.md
  git -c commit.gpgsign=false commit -q -m i
)

(
  cd "$PROJECT"
  HOME="$FAKE_HOME" node "$INSTALL_JS" upgrade >/dev/null 2>&1 || true
)

[ -f "$PROJECT/.vela/templates/guidelines/live-processes.json" ]
note "upgrade deployed live-processes.json to .vela/templates/guidelines/" $?

[ -f "$PROJECT/.vela/templates/guidelines/smoke-test.sh.example" ]
note "upgrade deployed smoke-test.sh.example to .vela/templates/guidelines/" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
