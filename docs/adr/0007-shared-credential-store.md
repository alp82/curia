# ADR-0007: Workers share the host credential store

**Status**: accepted (2026-07)
**Provenance**: [Share the host credential file with workers instead of copying it (#53)](https://github.com/alp82/curia/issues/53)

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
