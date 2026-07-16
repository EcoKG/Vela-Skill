# Test Coverage Analysis & Improvement Proposals

_Analysis date: 2026-07-16 · Scope: Vela v8.0 plugin (`scripts/`, `bin/`, `tests/`)_

## 1. How testing works here today

Vela has **no unit-test framework and no coverage instrumentation** (no jest/vitest/nyc/c8;
`package.json` has no `scripts` block, no `npm test`). The entire suite is **black-box shell
tests** that spawn the CLI as a subprocess and assert on JSON stdout + on-disk state.

| Metric | Count |
|---|---|
| Source JS files (`scripts/` + `bin/`) | 31 |
| Source JS lines | ~9,270 |
| Shell test files wired into CI (`scripts/tests/`) | 26 |
| Shell test files **not** wired into CI (`tests/`) | 3 |

The CI (`.github/workflows/test.yml`) is otherwise strong: node `--check` syntax, shellcheck,
plugin-manifest validation, a meta-guard that every test is wired in, and per-step logs with a
sticky PR comment. The gaps below are about **what the tests exercise**, not CI plumbing.

## 2. Coverage map (by engine subcommand & module)

Coverage was derived by mapping each `vela-engine <cmd>` dispatch target and each standalone CLI
to the test files that invoke it.

**Well covered** — `state`, `record`, `transition`, `advance`, `init`, `commit`, `locate`, the
gate hook (`vela-gate.js`, 8 tests), stop hook, `change-surface.js`, `worktree-manager.js`.

**Untested or barely tested:**

| Area | Source | LOC | Test coverage |
|---|---|---|---|
| **`clean-exec` (destructive git cleanup)** | `commands/clean.js` | 329 | **none** |
| `clean-scan` | `commands/clean.js` | (same) | **none** |
| `history` | `commands/history.js` | 70 | **none** |
| **`vela-report.js`** (HTML dashboard) | `cli/vela-report.js` | 287 | **none** |
| **`vela-friction.js`** (gate-events aggregation) | `cli/vela-friction.js` | 167 | **none** |
| `vela-cost.js` | `cli/vela-cost.js` | 103 | none direct |
| `project-env.js` (language/framework detect) | `shared/project-env.js` | 360 | indirect only |
| `git-utils.js` | `core/git-utils.js` | 154 | indirect only |
| `global-require.js` | `shared/global-require.js` | 71 | none |
| `branch` (happy path) | `commands/branch.js` | 154 | non-git guard only |

## 3. Prioritized gaps & proposals

### P0 — `clean-exec` is destructive and has zero tests
`commands/clean.js` (`clean-exec`) runs `git clean -fdX` (**permanently deletes every
git-ignored file on disk**), `fs.rmSync(dir, {recursive, force})` on artifact directories, and
`fs.unlinkSync` on cache DB files. Every one of these is wrapped in `catch (e) {}` that swallows
errors silently, and **none of it is tested.** A regression in category selection, the
completed/cancelled + 7-day age filter, or the protected-path logic could nuke user data with no
signal.

_Proposal:_ a `test-clean.sh` fixture repo that seeds ignored files, artifact dirs of varying
age/status, and cache DBs, then asserts:
- `clean-scan` reports without deleting (dry-run invariant).
- `clean-exec` with a category selection deletes **only** that category.
- Age/status filter: active or <7-day-old artifacts survive; old completed/cancelled ones go.
- Protected paths (`config.json`, `state/`, live artifacts) are never touched.
- Silent `catch` blocks don't mask a failure the caller should see.

### P0 — 3 real test files are silently excluded from CI
`tests/test-change-surface-multilang.sh`, `tests/test-config-migration.sh`, and
`tests/test-manifest-upgrade.sh` live in `tests/`, but the CI meta-guard only scans
`scripts/tests/test-*.sh`, so their absence is invisible.

- `test-change-surface-multilang.sh` **passes 6/6 against current code** (verified) — it covers
  Java/JSP-EL, Python imports, XML, and universal-extractor languages (Rust/Elixir/Haskell) that
  no wired test touches. It is losing real, working coverage for free.
- `test-config-migration.sh` and `test-manifest-upgrade.sh` target `scripts/install.js`, which
  **was removed in v8.0**. They are dead and misleading.

_Proposal:_ move `test-change-surface-multilang.sh` into `scripts/tests/` and wire it into the
workflow; **delete** the two `install.js` tests (or port their intent to the v8.0 `init-project`
path). Then **widen the CI meta-guard** to also scan `tests/` so an orphaned test can never again
sit un-run.

### P1 — Reporting/aggregation CLIs (`vela-report`, `vela-friction`, `vela-cost`) untested
~560 lines that parse `trace.jsonl` / `gate-events.jsonl` and render dashboards. These parse
untrusted-ish, possibly-truncated JSONL. A crash on a malformed line degrades the
telemetry/observability story silently.

_Proposal:_ feed each a fixture `gate-events.jsonl` / `trace.jsonl` (well-formed, empty,
and one with a corrupt trailing line) and assert: correct aggregation counts, non-empty HTML
for `vela-report`, and graceful handling (no throw, sane exit) on malformed input.

### P1 — `project-env.js` framework detection (360 LOC) only tested indirectly
Its output enriches every agent prompt, so a wrong detection quietly degrades results across the
pipeline. It's pure `fs`/`path`, so it's the easiest high-value module to unit test.

_Proposal:_ fixture project roots (node, python/pyproject, go, monorepo, empty repo) → assert the
detected language/framework/test-runner/linter/package-manager, plus the "never throws" contract
on a malformed `package.json`.

### P2 — `history` and `branch` happy path
`history` is read-only (low risk) but trivial to cover. `branch` is only tested through its
non-git guard, never its actual create/checkout/`--mode` behavior.

_Proposal:_ small additions to an existing engine test — assert `history` lists newest-first with
trimmed requests, and that `branch --mode auto|prompt|none` produces the right branch/no-op.

### P2 — Add coverage instrumentation to make gaps measurable
Everything above was found by hand-mapping subcommands to tests. Without a coverage number,
regressions in breadth are invisible.

_Proposal:_ wrap the JS-invoking tests with `c8` (works with subprocess-spawned node, no test
runner required) and print a line/branch summary in CI as a **non-blocking** step — a measurement,
not a gate, mirroring the existing `locate-bench` pattern.

## 4. Recommended order of work
1. **P0 orphan tests** — move+wire `change-surface-multilang`, delete the dead `install.js` tests,
   widen the meta-guard. (Small, prevents silent coverage loss immediately.)
2. **P0 `clean-exec`** — the only destructive, wholly-untested command.
3. **P1 `project-env.js`** unit tests (pure, high leverage) + reporting-CLI malformed-input tests.
4. **P2** `history`/`branch` assertions and non-blocking `c8` coverage reporting.
