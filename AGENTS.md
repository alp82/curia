# Curia

## Voice

Write all prose in the Developer style defined in `.claude/output-styles/developer.md`. This covers chat, docs, PR text, and commit messages. Set `"outputStyle": "Developer"` in your own Claude Code settings, or read the file and follow it.

Curia ships the same rules to the agents it spawns, and they do not come from this file. `daemon/assets/voice.md` is the copy every agent config dir gets as its memory file, and `daemon/src/overseerprompt.mjs` holds the overseer's copy inline. Change all three together.

## Agent skills

### Issue tracker

Issues and specs are tracked as GitHub issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Daemon tests

Run `npm test` in `daemon/`. The suite must be green. Never read a failure or a cancelled test as pre-existing. A cancelled test is a suite that died before it started, and it proves nothing. See [the daemon README](daemon/README.md#the-test-suite).
