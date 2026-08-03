# ADR-0007: Workers share the host credential store

**Status**: accepted (2026-07), extended (2026-08)
**Provenance**: [Share the host credential file with workers instead of copying it (#53)](https://github.com/alp82/curia/issues/53), [Status line shows model, effort, context %, and the usage bars (#146)](https://github.com/alp82/curia/issues/146)

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
