# ADR-0005: The escalation contract

**Status**: accepted (2026-07)
**Provenance**: [Define the escalation contract (#11)](https://github.com/alp82/curia/issues/11), [Build the Discord bridge + durable escalation record (#31)](https://github.com/alp82/curia/issues/31), [Escalation live-checks (#34)](https://github.com/alp82/curia/issues/34), [A blocked agent must not read as a crashed one (#47)](https://github.com/alp82/curia/issues/47), [A cancelled question ends nothing, and the agent asks it again (#200)](https://github.com/alp82/curia/issues/200), [A cancel confirm lands in the ticket thread, not where the operator typed it (#218)](https://github.com/alp82/curia/issues/218), [The nudge dies; the render-retry stands alone (#261)](https://github.com/alp82/curia/issues/261), [The escalation contract meets round-by-round grilling (#285)](https://github.com/alp82/curia/issues/285)

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

- **Amended by [#285](https://github.com/alp82/curia/issues/285)**: the unit of a HITL exchange is the **round**, not the question. Version 1.2 of the vendored `grilling` skill maps a design tree and asks the whole frontier in one numbered round. That contradicted the old rule of one question per call, and the round wins. The reason is the cost. A question costs a wait, not a token. Twelve questions at one call each is twelve looks at a phone across a day. In rounds of four it is three looks. The skill's own dependency rule keeps this honest: a question whose answer hangs on another open question belongs to the next round, never this one. One question is a round of one, so the rule reads the same on every ticket type and not only on `wayfinder:grilling`.

  A round needs no fifth kind. It is a `free-text` call whose prompt carries the numbered questions, each with the agent's recommended answer. The agent maps the one reply back to its own numbers, and the numbering exists for exactly that. The daemon parses nothing, so the bridge still renders and captures and never interprets. `ask_human` grows one optional field instead. `recommended` puts a single **✅ All as recommended** button on the card. A press captures the fixed word `all-as-recommended`, and the agent then applies the recommendations it wrote itself. No ❌ stands beside it, because the opposite of that tap is not one word. It is the operator's reply, and the reply path is already open on every `free-text` record.

  A question the operator does not answer is **not** taken as recommended. It returns in the next round. Only the ✅ button takes the recommendations, and only for the questions on the card it sits on. This is "never answer for the human" said in the one place a round could break it quietly. Silence taking the recommendation was considered and refused. It moves the small decisions out of the operator's sight, and a wrong answer to a small question is the one nobody checks. A round has no size limit: the frontier is the frontier.

## Consequences

- The bridge renders and captures, and it never interprets. All routing keys on the escalation id, not on who or where.
- A box reboot loses the in-flight turn. The ticket re-frontiers, per [ADR-0001](0001-github-is-the-only-durable-state-home.md).
- An agent that dies without a Stop leaves its question asking until reconcile or `cancel <n>` cleans it up. Cancel also closes the orphaned question, and it renames the thread to ⚰️.
- A round is one escalation record, so it holds one answer, one timestamp and one supersession key (#285). The `recommended` flag stays out of the payload hash, because the hash keys on the question and the flag is not the question. An agent that re-asks the same round with the flag flipped supersedes its own record, which is what a re-ask must do.
- A round with no size limit can outrun one Discord message (#285). The existing paragraph-aware split (#119) carries it, and the buttons ride the last chunk, so the ✅ sits below every question it answers. The cost is real: a long round is a scroll before it is answerable, and the agent trades against that itself.
- The review gate of [ADR-0008](0008-resolved-means-merged.md) is one more escalation kind and inherits all of this behavior. It is an agent escalation, so it stays in the ticket thread. The confirm is the one kind that moves.
