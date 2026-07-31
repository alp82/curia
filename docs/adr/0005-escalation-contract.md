# ADR-0005: The escalation contract

**Status**: accepted (2026-07)
**Provenance**: [Define the escalation contract (#11)](https://github.com/alp82/curia/issues/11), [Build the Discord bridge + durable escalation record (#31)](https://github.com/alp82/curia/issues/31), [Escalation live-checks (#34)](https://github.com/alp82/curia/issues/34), [A blocked worker must not read as a crashed one (#47)](https://github.com/alp82/curia/issues/47)

## Context

Workers need human answers from any device, with waits measured in hours, and the record of an open question must survive daemon restarts and bridge failures.

## Decision

- The worker's surface is MCP tools served by the daemon: `ask_human` (blocking, kinds free-text, choice, approve-reject, preview-review) and `notify` (fire-and-forget). The worker never touches Discord.
- `ask_human` blocks indefinitely. No timer cancels it. A human cancel returns a distinct aborted result. A parked worker is nearly free.
- One Discord thread per ticket carries the ticket's escalations, notifies, and answers. Buttons capture closed shapes, thread replies capture open ones. Images ride the contract in both directions.
- The first valid answer wins and closes the escalation atomically. Any device may answer. A later answer gets a clear refusal.
- The escalation is a durable record in the journal. It survives restarts and bridge post-failures. The half-hour nudge re-posts an open escalation and re-renders any the bridge failed to post.
- A re-asked question supersedes the old record, and late answers route along the chain to the live call.
- A keepalive on the MCP stream defeats the client's 300-second silence abort, so a block can outlast any human pause.
- An open escalation is a liveness signal. A Stop hook fired while this worker has an open escalation means blocked, not crashed. Nothing terminal happens: no preview withdrawal, no failure mark, no session kill.

## Consequences

- The bridge renders and captures, and it never interprets. All routing keys on the escalation id, not on who or where.
- A box reboot loses the in-flight turn. The ticket re-frontiers, per [ADR-0001](0001-github-is-the-only-durable-state-home.md).
- A worker that dies without a Stop leaves its question asking until reconcile or `/cancel` cleans it up. Cancel also closes the orphaned question.
- The review gate of [ADR-0008](0008-resolved-means-merged.md) is one more escalation kind and inherits all of this behavior.
