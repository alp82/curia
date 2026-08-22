# ADR-0015: The overseer is a service, not an agent-shaped pane

**Status**: accepted (2026-08). Built. The service and its image are [#327](https://github.com/alp82/curia/issues/327), and the replay below is [#388](https://github.com/alp82/curia/issues/388) — the last decision here that nothing had built. Amended by [ADR-0024](0024-the-overseer-chat-is-a-pane.md) (2026-08): the service stands, and the no-pane rule retires — each live conversation runs as a pane that execs into the service.
**Provenance**: [The chat and the overseer become one thing, in a container (#301)](https://github.com/alp82/curia/issues/301), [The hosting shape: a service, a pane, or one container per thread (#310)](https://github.com/alp82/curia/issues/310)

## Context

[ADR-0014](0014-the-overseer-in-its-own-container.md) moved the overseer out of the daemon process and into a container. It left the hosting shape open and named it a grilling ticket.

The obvious shape is wrong, which is why this record exists. [ADR-0003](0003-tmux-ttyd-tailscale-worker-host.md) makes tmux the host for what runs on this box. [ADR-0012](0012-one-container-per-worker.md) makes each agent a container that its own tmux pane starts. Every other long-lived model here is a pane. So a reader meets the overseer as a compose service and asks what it broke the pattern for.

The overseer is not shaped like an agent.

An agent takes one ticket. It works one job to one ending, and it holds one conversation. A pane fits that. The pane is a screen, curia types into it, and curia reads it back.

The overseer answers every Discord thread and the console chat. Those are many conversations, and they are live at the same time. `store.overseerSession` already keys one resume id per thread. One screen cannot hold them.

The overseer also has no screen to hold. A turn is a call. The model starts, answers, and ends. Nothing runs between messages, which is what lets ADR-0014 say that idle costs no tokens.

## Decision

- **The overseer is a persistent compose service**, beside the dashboard. One long-lived container, and many conversations pass through it. There is no spawn path and no pane.
- **Compose owns its liveness**, with `restart: unless-stopped`. Reconcile asserts nothing and spawns nothing. It health-checks the overseer and reports it on the overview, the way it already treats `ttyd`.
- **It holds no `max_concurrent` slot**, as ADR-0014 states. It is budgeted as one more container.
- **Turns are not capped.** One turn at a time per conversation stays the only limit. Different threads answer at the same time inside the one container.
- **Its config dir is `<workspace_root>/cfg/curia-overseer`**, mounted at that same path inside the container. The name was the session name the timeline served when this was written. [ADR-0016](0016-the-conversation-key.md) then gave the browser many conversations, so the timeline serves `curia-console-<n>` and this one directory holds every conversation's transcript. The directory name is a name now, and nothing reads it as a session. It sits beside the agent config dirs, so the daemon's `data/` stays out of a second container. The Chat screen reads the transcript from that directory, so the path must be identical on both sides.
- **A deploy recreates it.** The routine deploy becomes `docker compose up -d --build --no-deps daemon dashboard overseer`. The rule at the head of `deploy/compose.yaml` guards `tmux`, because recreating `tmux` kills every live agent. Recreating the overseer kills none.
- **A turn killed by a restart is replayed, never retyped.** The daemon keeps the message and sends it again once the overseer answers. It replays only a turn that crossed `/command` zero times, which is the test the fallback retry already uses. A turn that ran a verb is not replayed. The thread gets one line naming what that turn did, and the operator decides from there.

  Built on [#388](https://github.com/alp82/curia/issues/388), which settled the four things this line left open. The message lives in the journal, as one event when a turn starts and one when it ends, so the boot reads whatever is open between them. The crossings are counted off the `command` event the seam already writes, which now carries the conversation key — the in-memory tally dies with the process that held it, and a second event stating the same fact would break [ADR-0013](0013-one-voice-per-fact.md). The boot pass sends the message once the container answers its health check. Three more things hold it beside a crossing: a message the operator has already sent again, a message over fifteen minutes old, and a replay a second restart killed. Every held message gets the same line. A browser conversation has no thread to put that line in, so it reads it on its row in the Chat picker, until it takes its next turn.

## Considered options

**An agent-shaped tmux pane** that runs `docker run`. The appeal was uniformity: one attach story and one reconcile story for everything that runs a model. It fails on the conversation count. A pane is one screen, and one screen is one conversation, so this shape reaches many conversations two ways only. It can run a headless program in the pane, and then the pane is decoration that chains the overseer to the `tmux` service nobody may recreate while agents live. Or it can give each conversation its own pane, which is the next option with more parts. The attach it promised is already had: the Chat screen reads the transcript file, never a screen.

**One container per thread**, spawned per conversation. It buys one thing. A subverted conversation cannot read another conversation's transcript. That is thin, because the token is read-only in every shape and the verbs reach `/command` in every shape. It costs the checkouts of [#312](https://github.com/alp82/curia/issues/312). A shared checkout volume turns the one fetch per turn into a race between containers. A private clone per thread makes every new Discord thread pay for a clone. Discord opens a thread per top-level message, so threads are frequent and cheap today, and this shape makes them expensive.

## Consequences

- **The overseer has no terminal attach.** There is no pane, so ttyd shows nothing for it. The Chat screen is its surface and it reads the transcript. This costs nothing that a screen was ever wanted for.
- **The container is not the conversation.** Conversation state is the resume id in the daemon journal, so a container restart loses no conversation. Only the per-thread shape would have welded the two together.
- **Nothing expires a conversation.** A Discord thread starts empty, because every top-level message opens a new one. The console chat was one key forever, and it only grew. [ADR-0016](0016-the-conversation-key.md) on [#311](https://github.com/alp82/curia/issues/311) answered that: no timer expires a conversation, and the browser gets many of them instead, keyed `console-<n>`. A new one is the reset.
- **A conversation thread must stay single-use.** Work dispatched from a conversation takes over that thread and is renamed on purpose. It does not open a second thread beside it. Charting a map through the overseer opened two, which the operator reported at this ticket's review gate. [#326](https://github.com/alp82/curia/issues/326) fixed it. The lazy thread lookup read a chat handle as a pseudo-ticket and ignored the binding. [ADR-0016](0016-the-conversation-key.md) decides the conversation key that fix agrees with.
- **A deploy drops in-flight turns on both containers**, because the deploy command now restarts the daemon and the overseer together. The replay rule above is what pays for that. It is also why the pending message is journalled rather than held in memory.
- **Nothing on the map built the container itself.** [#312](https://github.com/alp82/curia/issues/312) builds the checkouts, [#313](https://github.com/alp82/curia/issues/313) mints the token, [#314](https://github.com/alp82/curia/issues/314) carries the turn, and [#315](https://github.com/alp82/curia/issues/315) removes the in-daemon host. The image and the compose service earn their own ticket, and it blocks the turn and the cutover.
