# ADR-0007: Workers share the host credential store

**Status**: accepted (2026-07), extended (2026-08), corrected (2026-08)
**Provenance**: [Share the host credential file with workers instead of copying it (#53)](https://github.com/alp82/curia/issues/53), [Status line shows model, effort, context %, and the usage bars (#146)](https://github.com/alp82/curia/issues/146), [The account usage bars have no source on the deployment box (#162)](https://github.com/alp82/curia/issues/162)

## Context

The daemon used to copy the host's credential file into each worker's config dir at spawn. The host session refreshes tokens in place, and the refresh rotates the refresh token server-side. Every worker then carried a dead snapshot, and a long human-in-the-loop block killed the worker on its next model turn. That failure is fatal under merge-gated resolution, where a worker waits hours on a review.

## Decision

Workers share the host credential store instead of holding a copy. A worker's config dir contains no credential file at all. The worker's environment keeps `CLAUDE_CONFIG_DIR` per-worker and points the secure-storage location at the host's `~/.claude`, so every worker rides the host's one refresh lineage.

The isolation of everything else is untouched: prompt, skills, settings, and harness stay per-worker. Only auth is shared, which is the one thing that should be.

## Consequences

- A worker survives any host-side refresh. Verified live: a worker blocked in `ask_human` across a forced token rotation resumed and completed model turns.
- The parked worker-auth watchdog is retired as mis-framed. There is nothing to watch once nothing is snapshotted.
- The refresh writes temp-then-rename, verified empirically. A symlinked credential file would have been silently replaced by a regular file, so the environment-level share is the durable form.
- The concurrent-refresh race stays parity with N host sessions on one machine. Argued, not exercised.

## Extension: the daemon reads the store, and never writes it (#146)

The status line's account usage bars have no per-worker source. The claude transcript states no rate limit anywhere, so the only source is the account usage endpoint the CLI itself polls, and reaching it needs the shared token.

The daemon may read that token. Three rules bound the read, and they apply to any future daemon-side use of the store:

1. **Read only.** The daemon never writes `.credentials.json` and never refreshes the token. A refresh rotates the refresh token server-side, and every live session on the box holds the old one. That is the exact failure ADR-0007 exists to prevent, pointed the other way.
2. **A refusal is terminal.** A 401 or 403 stops the daemon fetching until the credential file's mtime changes. The CLI owns the refresh lineage, so the daemon waits for it.
3. **The endpoint budget is shared.** The attempt stamp beside the usage cache is a cooperative lock. The operator's own status-line script writes the same two files under the same rules, so the two throttle each other and each one's fetch keeps the other fresh.

`usage.account_bars: false` in `config/curia.yaml` stops the daemon reaching the endpoint at all. The bars then show whatever reading is already cached on disk, and age.

Only the account bars need this. The model, the reasoning effort and the context percent come from the daemon's own records and the worker's own transcript.

## Correction: the credential store is not a usage source on a headless box (#162)

The extension above was built and verified against a workstation, where an interactive `claude /login` keeps `~/.claude/.credentials.json` current. The deployment box has no such file. It authenticates through `CLAUDE_CODE_OAUTH_TOKEN`, the `claude setup-token` credential [#100](https://github.com/alp82/curia/issues/100) chose, so the account bars never rendered there. That was a wrong reference machine, not a wrong idea.

**The cause is a scope, not a missing file.** `GET /api/oauth/usage` answers only a credential that carries `user:profile`. Measured against the live API: the setup token gets `403 OAuth token does not meet scope requirement any_of(user:profile, user:office)` on the sibling profile endpoint, and the usage endpoint refuses it exactly as it refuses a request carrying no credential at all. The same token authenticates `/v1/messages` without complaint, so the token is sound and the endpoint is out of reach. The CLI carries the matching guard: it polls that endpoint only when the stored scopes hold both `user:inference` and `user:profile`. That is why no worker config dir on the box has ever cached a reading.

**The source moves to the response headers.** Every accepted completion states the same two windows, as `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`. Measured side by side against the endpoint: identical percentages, identical reset instants. Every credential shape gets them, so one path serves a workstation, the deployment box, and a stranger's own VPS alike.

So the daemon takes one minimal completion for its headers, on the cheapest model, asking for one token. It uses whatever credential the box already authenticates with, in the CLI's own precedence order: `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then the stored credential. The three rules above still bind, with one amendment and one addition:

1. **Read only**, unchanged. A refusal is still terminal, but it is now keyed on a digest of the credential rather than the credential file's mtime. An environment variable has no mtime, and the value is the thing that actually changed.
2. **New: the headers are the reading, whatever the status code.** A window spent to its limit states itself on the rejection that proves it, and that is the moment the bars matter most.
3. **New: the probe spends account quota to measure account quota.** That is only honest at this size. One probe costs about two dozen tokens, at most one attempt per ten minutes and in practice one per thirty, against a worker turn that spends thousands. `usage.account_bars: false` stops it completely.
4. **The shared lock is unchanged**, and the cache file keeps the endpoint's own schema. A reading either fetcher takes serves both, so the operator's `statusline.sh` needs no change to benefit from a reading the daemon took.

### What this rules out

**Seeding the box's cache file from a workstation.** Curia must run on a server alone, and a stranger must be able to run it on their own VPS. A source that needs a second machine is not a source.

**Switching the box to a `claude /login` lineage.** It brings back the expiring access token that [#100](https://github.com/alp82/curia/issues/100) chose the setup token to avoid, and rule 1 forbids the daemon refreshing it.
