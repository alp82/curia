# ADR-0005: The escalation contract

**Status**: accepted (2026-07)
**Provenance**: [Define the escalation contract (#11)](https://github.com/alp82/curia/issues/11), [Build the Discord bridge + durable escalation record (#31)](https://github.com/alp82/curia/issues/31), [Escalation live-checks (#34)](https://github.com/alp82/curia/issues/34), [A blocked agent must not read as a crashed one (#47)](https://github.com/alp82/curia/issues/47), [A cancelled question ends nothing, and the agent asks it again (#200)](https://github.com/alp82/curia/issues/200), [A cancel confirm lands in the ticket thread, not where the operator typed it (#218)](https://github.com/alp82/curia/issues/218), [The nudge dies; the render-retry stands alone (#261)](https://github.com/alp82/curia/issues/261)

## Context

Agents need human answers from any device, with waits measured in hours, and the record of an open question must survive daemon restarts and bridge failures.

## Decision

- The agent's surface is MCP tools served by the daemon: `ask_human` (blocking, kinds free-text, choice, approve-reject, preview-review) and `notify` (fire-and-forget). The agent never touches Discord.
- `ask_human` blocks indefinitely. No timer cancels it. A parked agent is nearly free.
- A question has no cancel of its own (#200). A record closes early only because its agent ended, and it settles as aborted into a transport nobody reads. Ending an agent is `cancel <n>`, and that word has one place: the command channel.
- One Discord thread per ticket carries the ticket's escalations, notifies, and answers. Buttons capture closed shapes, thread replies capture open ones. Images ride the contract in both directions.
- A record renders where the person it is addressed to stands (#218). An agent escalation is addressed to the ticket conversation and renders in the ticket thread. A confirm is addressed to the operator, about a command typed one second ago, so it renders in the thread the command was typed in. A command typed in no thread puts its confirm in the command channel. The ticket thread gets a pointer to the buttons.
- The first valid answer wins and closes the escalation atomically. Any device may answer. A later answer gets a clear refusal.
- The escalation is a durable record in the journal. It survives restarts and bridge post-failures. A record the bridge failed to render retries at 1, 5 and 15 minutes after it opened, then stops (#261). Nothing re-posts an open escalation on a timer: the status line's own minute tick keeps the waiting line current, and the record stays open and answerable by REST whether or not Discord ever shows it.
- A re-asked question supersedes the old record, and late answers route along the chain to the live call.
- A keepalive on the MCP stream defeats the client's 300-second silence abort, so a block can outlast any human pause.
- An open escalation is a liveness signal. A Stop hook fired while this agent has an open escalation means blocked, not crashed. Nothing terminal happens: no preview withdrawal, no failure mark, no session kill.

## Consequences

- The bridge renders and captures, and it never interprets. All routing keys on the escalation id, not on who or where.
- A box reboot loses the in-flight turn. The ticket re-frontiers, per [ADR-0001](0001-github-is-the-only-durable-state-home.md).
- An agent that dies without a Stop leaves its question asking until reconcile or `cancel <n>` cleans it up. Cancel also closes the orphaned question, and it renames the thread to ⚰️.
- The review gate of [ADR-0008](0008-resolved-means-merged.md) is one more escalation kind and inherits all of this behavior. It is an agent escalation, so it stays in the ticket thread. The confirm is the one kind that moves.
