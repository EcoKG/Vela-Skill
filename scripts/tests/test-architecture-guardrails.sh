#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# test-architecture-guardrails.sh — v7.1 M4 forbidden-import E2E
#
# Covers: verifier Phase 4B must be able to detect a plan-declared
# forbidden import in actual diff. Since we can't run the real
# verifier Agent in a test, we:
#   1. assert verifier.md documents Phase 4B with grep procedure
#   2. simulate the grep that Phase 4B should run, on a sandbox
#      project with a known violation, and prove that a plain
#      bash script using the documented approach can find it
#   3. same simulation on a clean project proves no false positive
#
# Asserts:
#   A. verifier.md has Phase 4B section
#   B. verifier.md Phase 4B references plan.md Forbidden imports
#   C. verifier.md Phase 4B references `git diff --name-only`
#   D. verifier.md Phase 4B cites T083634 DIP motivation
#   E. Grep on violation project finds the forbidden import
#   F. Grep on clean project finds no import
# ──────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERIFIER_MD="$REPO_ROOT/scripts/agents/vela-verifier.md"

PASS=0
FAIL=0
TOTAL=0

TMPDIR_ROOT=""

cleanup() { [ -n "$TMPDIR_ROOT" ] && rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

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

# ── Phase A: verifier.md documents Phase 4B ─────────────────
echo "📋 Phase A: vela-verifier.md Phase 4B section"

grep -q 'Phase 4B\|Forbidden import enforcement' "$VERIFIER_MD"
note "verifier.md has Phase 4B / forbidden-import section" $?

grep -q 'Forbidden imports' "$VERIFIER_MD"
note "verifier.md references plan.md Forbidden imports section" $?

grep -q 'git diff --name-only' "$VERIFIER_MD"
note "verifier.md procedure uses git diff --name-only" $?

grep -q 'T083634' "$VERIFIER_MD"
note "verifier.md cites T083634 DIP motivation" $?

grep -q 'Architecture Guardrails' "$VERIFIER_MD"
note "verifier.md Phase 4B references Architecture Guardrails" $?

# ── Phase B: simulate the grep on a violating project ───────
echo "📋 Phase B: simulated Phase 4B grep catches violation"

TMPDIR_ROOT="$(mktemp -d)"
VIOL="$TMPDIR_ROOT/violation"
mkdir -p "$VIOL/interface/server" "$VIOL/infrastructure/repo" "$VIOL/.vela/artifacts/20260411T000000-t"
cat > "$VIOL/infrastructure/repo/user-repo.ts" <<'EOF'
export class UserRepoPg {
  async findByEmail(e: string) { return null; }
}
EOF

# The violation: interface/server/main.ts imports infrastructure/repo/* directly.
cat > "$VIOL/interface/server/main.ts" <<'EOF'
// DIP violation — this file should depend on an application port,
// not on infrastructure/repo directly. plan.md forbids this.
import { UserRepoPg } from '../../infrastructure/repo/user-repo';

export function boot() {
  const repo = new UserRepoPg();
  return repo;
}
EOF

# plan.md with Forbidden imports entry
cat > "$VIOL/.vela/artifacts/20260411T000000-t/plan.md" <<'EOF'
# Plan

## Architecture
some arch notes.

## Architecture Guardrails

**Allowed imports**:
- application → domain

**Forbidden imports**:
- interface/server → infrastructure/repo
- domain → infrastructure

**Injection points**:
- server boot injects UserRepoPort

## Class Specification
...

## Test Strategy
- unit
- edge one
- edge two
EOF

# The procedure documented in verifier.md Phase 4B:
#   1. parse Forbidden imports bullet for left → right
#   2. git diff (or, here, scan tree) for files whose path matches left
#   3. grep those files for import containing right
#
# We don't need the real git diff — we scan the project tree. Phase 4B
# says "use git diff --name-only" because in production the verifier is
# running against a pipeline where baseline_sha is known; here the diff
# equals the whole tree. The procedure is identical.
LEFT_PREFIX="interface/server"
RIGHT_SUBSTR="infrastructure/repo"
FOUND_VIOLATION=0
while IFS= read -r file; do
  # Skip empty, skip .vela/ internals
  [ -z "$file" ] && continue
  case "$file" in
    */.vela/*|*.vela/*) continue ;;
  esac
  # Only look at files whose path matches the forbidden LEFT prefix
  case "$file" in
    *"$LEFT_PREFIX"/*)
      if grep -q "import.*$RIGHT_SUBSTR" "$file"; then
        FOUND_VIOLATION=$((FOUND_VIOLATION + 1))
      fi
      ;;
  esac
done < <(find "$VIOL" -type f -name '*.ts')

[ "$FOUND_VIOLATION" -ge 1 ]
note "Phase 4B grep found $FOUND_VIOLATION violation(s) on the guilty project" $?

# ── Phase C: clean project — no false positive ───────────────
echo "📋 Phase C: simulated Phase 4B grep on compliant project"

CLEAN="$TMPDIR_ROOT/clean"
mkdir -p "$CLEAN/interface/server" "$CLEAN/application/ports" "$CLEAN/infrastructure/repo"

cat > "$CLEAN/application/ports/user-repo.ts" <<'EOF'
export interface UserRepoPort {
  findByEmail(e: string): Promise<unknown>;
}
EOF

cat > "$CLEAN/infrastructure/repo/user-repo.ts" <<'EOF'
import { UserRepoPort } from '../../application/ports/user-repo';
export class UserRepoPg implements UserRepoPort {
  async findByEmail(e: string) { return null; }
}
EOF

cat > "$CLEAN/interface/server/main.ts" <<'EOF'
// Clean: depends only on application port, not on infrastructure.
import { UserRepoPort } from '../../application/ports/user-repo';

export function boot(repo: UserRepoPort) {
  return repo;
}
EOF

FOUND_CLEAN=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    *"$LEFT_PREFIX"/*)
      if grep -q "import.*$RIGHT_SUBSTR" "$file"; then
        FOUND_CLEAN=$((FOUND_CLEAN + 1))
      fi
      ;;
  esac
done < <(find "$CLEAN" -type f -name '*.ts')

[ "$FOUND_CLEAN" -eq 0 ]
note "Phase 4B grep found 0 violations on clean project (got $FOUND_CLEAN)" $?

# ── Phase D: application → domain import is NOT flagged ──────
echo "📋 Phase D: Allowed imports do not trigger the filter"

cat > "$CLEAN/application/user-service.ts" <<'EOF'
// This import is Allowed per guardrails (application → domain).
// Phase 4B must not match it.
import { UserEntity } from '../domain/user';
EOF
mkdir -p "$CLEAN/domain"
echo "export class UserEntity {}" > "$CLEAN/domain/user.ts"

# With LEFT=interface/server, RIGHT=infrastructure/repo, we should still
# find 0 violations — the new file is in application/, not interface/.
FOUND_CLEAN2=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    *"$LEFT_PREFIX"/*)
      if grep -q "import.*$RIGHT_SUBSTR" "$file"; then
        FOUND_CLEAN2=$((FOUND_CLEAN2 + 1))
      fi
      ;;
  esac
done < <(find "$CLEAN" -type f -name '*.ts')

[ "$FOUND_CLEAN2" -eq 0 ]
note "Allowed application→domain import is not flagged" $?

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "📊 Summary: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
