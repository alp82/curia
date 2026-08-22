# ADR-0024: The overseer chat is a pane, parked when idle

**Status**: accepted (2026-08)
**Provenance**: [The overseer in a terminal: the decision (#571)](https://github.com/alp82/curia/issues/571), on [map #511](https://github.com/alp82/curia/issues/511). Inputs: the terminal facts (#569), the pane spike (#570), the boundary study (#593), [ADR-0023](0023-the-overseer-take-back-rides-the-session-chain.md).

## Context

ADR-0023 kept two chat handlings beneath the driver seam of #267: an agent chat is a live pane driven by keystrokes, and an overseer chat is a turn keyed by a session id chain. It deferred the pane direction to this decision.

The evidence arrived. The pane spike (#570) held one overseer conversation in a live claude pane, and the chat page read and wrote it exactly as an agent pane, with no new code. The take back ran as the pane rewind of ADR-0021, mid-turn too. The facts (#569) price one pane at 154 to 170 MiB idle, so fifty always-live panes need 7.5 to 8.3 GiB and break the capacity budget. The boundary study (#593) classified the process split as an artifact, not an essential difference between the roles.

## Decision

### Both chats are panes

The overseer chat moves from the session chain to a live pane. The chat surface keeps one runtime beneath the driver seam, and the pane path serves both chat kinds. The two roles stay separate, as #593 rules: an agent and an overseer conversation own different work, authority, identity, and lifetime. Each can own a pane, and neither becomes the pane.

### The take back is the pane rewind

The take back on an overseer chat becomes the pane rewind of ADR-0021, and the journal append of ADR-0023 retires. The policy of ADR-0023 stands unchanged: the floor is the first message, only the operator's words go back, the press acts at once, the world keeps what ran, and the receipt lives in the chat. Curia enforces the floor itself, because claude offers landings below it. Curia returns queued notes to its queue from its own journal. The rewind writes nothing to the transcript, so the receipt carries the landing point for the window before the next turn, and the chat tailer follows the active branch by parentUuid for both chat kinds.

### The pane is a cache, the conversation is durable

A conversation stays the durable thing: its key, resume id, notes, and transcript live in the journal and on disk (ADR-0016). A live pane is a cache in front of it. An idle conversation parks: the process stops, and the identity stays. The next operator message rehydrates the pane from the journaled session id, in about 2.2 seconds before model time.

Live panes get their own cap, separate from `max_concurrent`, because the two budgets measure different promises. The cap defaults to 3 and is a settings entry. At the cap, curia parks the least recently used pane. Parked conversations stay unlimited: ADR-0016 holds.

### The pane execs into the overseer service

The overseer service of ADR-0015 stands: one compose service, one shared container, read-only mirrors, no Docker socket, no host network. What retires is its no-pane rule. Each live conversation runs as a tmux pane whose process execs into that container, so containment (ADR-0014) and the one shared container hold.

Deploy survival yields. A routine deploy recreates the overseer service and kills every pane inside it, and that is a forced park: each conversation returns by lazy rehydration on its next message. A turn in flight at deploy time falls to the replay rules of ADR-0015.

### Retention holds the ADR-0016 promise

Claude deletes session data after 30 days by default, which would break the no-age-limit promise. The promise holds: the pane seed sets a large `cleanupPeriodDays` value. The exact mechanism sharpens at the build handoff.

### The verbs stay on HTTP MCP, with durable identity

The daemon verbs keep the narrow HTTP MCP boundary and the eight-verb overseer catalog. The per-turn token retires: each conversation pane gets one durable random token, on the pattern the agent token proves. The daemon validates the token on every call and loads routing from the journal, and it never trusts pane-supplied destination text.

## Considered options

**Always-live panes.** Rejected: fifty conversations need 7.5 to 8.3 GiB before other services, against an 8 GiB budget and the no-limit promise of ADR-0016.

**Keep the session chain.** Rejected: two chat handlings forever, two take-back mechanics, and a turn-abort route still to design for the overseer container. The pane spike proved the split buys nothing on the surface.

**Panes in the tmux container.** Rejected for hosting: the panes would survive deploys, but that container holds the Docker socket, host networking, and the full workspace. The overseer model would gain powers ADR-0014 exists to deny it.

**One container per conversation.** Rejected for hosting: it restores the per-conversation lifecycle and checkout costs ADR-0015 rejected, and the unlimited conversation count becomes an unlimited container fleet.

## Consequences

- The take-back mechanism of ADR-0023 retires. Its policy stands and this record carries it.
- The no-pane rule of ADR-0015 retires. The service, its containment, and its one-container shape stand.
- The map outputs specs, so the pane build lands with the handoff (#533): parking and rehydration, the live-pane cap setting, the durable token, the per-message checkout report, a turn-completion signal for the adapters, the bracketed-paste note batch, the `customApiKeyResponses` seed key, and the retention value.
- The branch-aware tailer and the receipt landing point serve both chat kinds, as the spike proved.
- The agent cap `max_concurrent` defaults to 10, an operator ruling taken with this decision.
