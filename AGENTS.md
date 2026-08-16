# Curia

## Voice

Write all prose in the Literal style defined in `.claude/output-styles/literal.md`. This covers chat, docs, PR text, and commit messages. Claude Code loads the style automatically through `outputStyle` in `.claude/settings.json`. All other harnesses: read the file and follow it.

## Agent skills

### Issue tracker

Issues and specs are tracked as GitHub issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Daemon tests

Run `npm test` in `daemon/`. The suite must be green. Never read a failure or a cancelled test as pre-existing. A cancelled test is a suite that died before it started, and it proves nothing. See [the daemon README](daemon/README.md#the-test-suite).
