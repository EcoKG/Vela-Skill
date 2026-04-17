# Vela Managed Agents Entry (v7.2 M15 — Experimental)

Anthropic Claude Managed Agents (GA: 2026-04) lets you trigger Claude Code
sessions from outside your machine — CI pipelines, webhooks, cron. This
doc shows how to invoke a Vela pipeline from a Managed Agent.

**Status**: experimental. Public Managed Agents SDK signatures may shift.
The wrapper at `scripts/managed/vela-managed-entry.js` is intentionally
thin so it can track upstream changes with minimal diff.

## Architecture

```
  GitHub Actions                 Anthropic Managed Agent
  (or webhook, cron)   ────▶     (Claude Code, sandboxed)
                                         │
                                         ▼
                              scripts/managed/vela-managed-entry.js
                                         │
                                         ▼
                              vela-engine init "{request}"
                                         │
                                         ▼
                               Standard Vela pipeline
                              (research → plan → execute → verify → commit)
                                         │
                                         ▼
                                    gh pr create
```

## Minimal GitHub Actions example

```yaml
# .github/workflows/vela-agent.yml
name: vela-agent
on:
  workflow_dispatch:
    inputs:
      request:
        description: "Task for Vela"
        required: true
      scale:
        description: "small|medium|large|fix|ralph|hotfix"
        default: "medium"

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Trigger Vela via Managed Agents
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN:      ${{ secrets.GITHUB_TOKEN }}
        run: |
          curl -s https://api.anthropic.com/v1/managed-agents/runs \
            -H "x-api-key: $ANTHROPIC_API_KEY" \
            -H "anthropic-version: managed-agents-2026-04-01" \
            -H "content-type: application/json" \
            -d @- <<EOF
          {
            "agent_id": "claude-code",
            "entry": "node scripts/managed/vela-managed-entry.js",
            "env": {
              "VELA_REQUEST": "${{ inputs.request }}",
              "VELA_SCALE":   "${{ inputs.scale }}"
            },
            "repo": "${{ github.repository }}",
            "ref":  "${{ github.sha }}"
          }
          EOF
```

## Entry script contract

`scripts/managed/vela-managed-entry.js` reads two env vars:

| Env              | Required | Purpose                                      |
|------------------|----------|----------------------------------------------|
| `VELA_REQUEST`   | yes      | Natural-language task for the pipeline       |
| `VELA_SCALE`     | no       | small/medium/large/fix/ralph/hotfix (medium) |
| `VELA_AUTO_PR`   | no       | if `"1"`, open PR after commit (default off) |

It shells out to `vela-engine init "<VELA_REQUEST>" --scale <VELA_SCALE>`
then hands control back to Claude Code — the rest of the pipeline is
orchestrated the same way a local session would run it.

## Safety notes

- **Never point a Managed Agent run at a branch without review gates.**
  The pipeline's existing `review-gate` still applies — reviewer APPROVE
  is required before `execute` advances.
- Circuit breaker (5 consecutive step failures) still fires in managed
  runs. CI should not retry the same failing request blindly.
- `VELA_AUTO_PR=1` is the only way to open a PR without interactive
  approval. Leave it off by default; use workflow_dispatch inputs if
  you want it opt-in per-run.
