# The aistack machine: registration and one real sync from the curia box

Date: 2026-08-23. Ticket: [The aistack-machine prototype: register the curia box and sync its tokens](https://github.com/alp82/curia/issues/554).
Research ground truth: [docs/research/aistack-machine-sync.md](../../docs/research/aistack-machine-sync.md) (#637).
CLI: `@use-aistack/cli` 0.7.2, pinned for every run below. Server: `https://aistack.to`.

**Verdict. The box can register and sync, and it did.** One headless device-code login registered the box as machine `curia.sh`. One `sync --auto` scanned this agent's real transcripts and published 30 days of token usage to the operator's stack. The log line on the box: `2026-08-23T13:23:46.501Z ok - published https://aistack.to/stacks/alper-ortac-unw0sl`. The research (#637) held at every step. The replacement rule fired live, and the operator then changed aistack so machine snapshots on one stack combine instead of replace. That supersedes the own-stack rule: the box stays on the operator's stack.

## Where the run happened

The prototype ran inside a curia agent container on the box. The container mounts two paths from the box disk: the worktree at `/workspace` and this agent's own config dir at `/cfg` (`CLAUDE_CONFIG_DIR=/cfg`). The box's full `cfg/*` tree is not mounted, so the sync scanned one agent's transcripts: this session's own. That is real harness data in the real layout. The whole-box scan is the daemon's job in the build, because only the daemon sees every `cfg/<session>` dir.

## 1. The registration

The one-time act is the device-code login, and it works headless:

1. The box ran `npx -y @use-aistack/cli@0.7.2 login`. The CLI printed `CODE T72NNC` and `OPEN https://aistack.to/cli/auth?code=T72NNC`, then polled.
2. The operator opened the URL on their own machine, set the machine name to `curia.sh`, picked the stack, and approved.
3. The CLI printed `Authenticated` and `Token saved`, inside its 3-minute poll window.

So the answer to the ticket's registration question is: **both**. A one-time act (the approval, which binds machine name and stack) and a credential (a 64-character bearer the server returns once).

The machine row is visible and revocable at `aistack.to/settings/machines`. The operator revokes this prototype's machine after the review, because the plaintext dies with this container.

### Where the credential lives

The CLI wrote `$HOME/.config/aistack/credentials.json`:

```json
{ "servers": { "https://aistack.to": { "token": "<64 chars>", "userId": "..." } } }
```

The CLI reads the token from this file only. It takes no env var for it, so the `.env.daemon` pattern does not apply directly. The build-time home is the same posture in file form: `<workspace_root>/home/.config/aistack/credentials.json`, under curia's durable HOME, on box disk only, never committed. The registration act itself stays a one-time operator ceremony, because the approval needs a signed-in browser.

## 2. The reading

The rolling window aistack expects can be computed from the harness data under curia's config dirs, and the CLI computes it itself once `CLAUDE_CONFIG_DIR` points at them. Cross-check: [local-scan.mjs](local-scan.mjs) reimplements the CLI's claude scan rule (30 calendar days UTC, dedup by `message.id`, keep the record with the largest cumulative usage) against `/cfg/projects`:

| Moment | Responses | Tokens (input + output + cache write + cache read) |
|---|---|---|
| Before the sync | 37 | 4,006,463 |
| Right after the sync | 40 | 4,426,345 |

All on `claude-fable-5`, from one agent session, window from 2026-07-25. The two figures differ because the measured session is this one: the transcript grows while the prototype works on it. What travels is the aggregate only. Raw transcripts, prompts and paths stay on the box (research §3).

### Double-count, tested live — and the rule it changed

The operator chose to sync the box into their own stack, which turned the prototype into a live test of the identity rule from research §4. The prediction fired exactly: no double-count, but replacement. The box's 4-million-token reading replaced the operator's own Claude Code numbers on the shared stack, and the operator saw it happen: "there was a problem that it overrode the stats of my working machine."

The operator then fixed the problem in aistack itself: machine snapshots on one stack now combine instead of replace, and the page shows both values together. Two consequences for the build:

- **The own-stack rule from #637 is superseded.** The box token stays bound to the operator's stack and lands beside their machines.
- The measured layer's identity model changed after commit `46b8028`, the pin every #637 citation stands on. The build reads the current aistack source before it leans on any §4 claim.

## 3. The push

The interactive `sync` refuses a box shell (no TTY). The working path, executed by hand:

1. `npx -y @use-aistack/cli@0.7.2 sync --auto on` — grants the auto-sync permission on the stack, writes the local opt-in to `$HOME/.config/aistack/settings.json`, and installs a `SessionStart` hook into `$HOME/.claude/settings.json`. On the box that hook is inert: no curia agent reads that file.
2. `npx -y @use-aistack/cli@0.7.2 sync --auto` — silent, exit 0. It read the stack's permission, scanned `/cfg/projects`, and published.

Evidence on the box after the run:

```
$HOME/.config/aistack/sync.log:
2026-08-23T13:23:46.501Z ok - published https://aistack.to/stacks/alper-ortac-unw0sl

$HOME/.config/aistack/settings.json (autoSyncState):
lastResult: "ok - published at 2026-08-23T13:23:46.501Z", consecutiveFailures: 0
```

What aistack shows after it: first the box's reading as the stack's current Claude Code snapshot, in place of the operator's own. After the operator's aistack fix, the page shows both machines combined. Their words on the ticket thread are the record: "now it shows both values combined. looks like it worked!"

## 4. The seam for later

The recurring sync needs three things on the box (research §6): a linked token, the standing opt-in, and a timer. The timer is the open question, and #345 answers it.

The no-clock rule (#345) refuses a clock that files tickets, because such a clock is auto-dispatch with a calendar in front of it. It does not refuse recurring work inside the daemon: the image prune, the liveness sweep, the Serve assert and the render retry all run there today, and none is a ticket. A sync publishes a reading and files nothing, so it belongs in that family.

**The right runner is the daemon.** A daemon-side interval invokes `npx @use-aistack/cli@<pinned> sync --auto` with:

- `HOME=<workspace_root>/home`, so the credential and the opt-in live in curia's durable home (`home/.config/aistack/`), not in a container.
- `CLAUDE_CONFIG_DIR` built at invocation time: enumerate `<workspace_root>/cfg/*` and join with commas. The CLI takes the list (research, The curia side).
- A pinned CLI version. The stock hook command runs `@latest`, which changes behavior silently.

The run self-throttles to the stack's `frequencyHours`, so the daemon interval only has to be at most that fine. The alternatives lose: the CLI's own `SessionStart` hook lands in files no curia agent reads, a GitHub Action cannot see the box's disk, and a host cron would be a second clock beside the daemon for no gain.

The operator asked that auto-sync cover all harnesses. The stack permission is already harness-agnostic: one `autoSync` flag per stack, and each `sync --auto` run publishes one payload per harness it detects at scan time. So the build's job is detection coverage, not more flags: point `CLAUDE_CONFIG_DIR` at every cfg dir, and set `CODEX_HOME` to the one codex root the CLI accepts (its one-root limit stands, research Risks).

Two bounds on what a recurring sync can ever show (research, Risks):

- Teardown deletes each agent's config dir, so a sync sees only the sessions still on disk. The measured layer stores windows, not increments, so a frequent sync narrows the gap and cannot close it.
- `CODEX_HOME` takes one directory, so codex rollouts spread over many cfg dirs cannot be aggregated in one scan.

## What the build still needs (from the operator)

The operator asked for a proper integration flow in the dashboard UI: the registration ceremony (login, approval link, stack choice) surfaced as a settings-screen flow instead of a shell ritual. That is build work for the handoff (#533), in the family of the GitHub App setup row (#619).
