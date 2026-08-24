# Architecture decision records

One file per standing decision. A decision earns an ADR when it still constrains future work. Deviations live inside the ADR they deviate from. History stays on the tracker: each ADR cites its source tickets, so the tracker is pure archive, never required reading.

## State and awareness

- [ADR-0001](0001-github-is-the-only-durable-state-home.md): GitHub is the only durable state home. The daemon holds no board, and the journal is its one artifact.
- [ADR-0017](0017-the-journal-is-a-queryable-store.md): That artifact is a `node:sqlite` store, and the JSON lines retire. A row keeps the written line verbatim, and the daemon is the only writer. Decided, not built.

## Daemon and agent host

- [ADR-0002](0002-thin-custom-daemon.md): A thin custom daemon owns the unique logic and drives commodity parts. No adopted platform.
- [ADR-0003](0003-tmux-ttyd-tailscale-worker-host.md): Agents live in bare tmux, attach is one shared ttyd behind Tailscale Serve, workspaces are per-ticket worktrees.
- [ADR-0012](0012-one-container-per-worker.md): Each agent runs in its own Docker container, started by its own tmux pane, holding its own clone and nothing else of the box.
- [ADR-0014](0014-the-overseer-in-its-own-container.md): The overseer leaves the daemon process for its own container. It reads a checkout of every watched repo, and a read-only token replaces the tool surface as its boundary. Decided, not built.
- [ADR-0015](0015-the-overseer-is-a-service.md): That container is a persistent compose service, not an agent-shaped pane and not one container per conversation. Compose owns its liveness, and a turn a restart kills is replayed rather than retyped. Amended by ADR-0024: the no-pane rule retires. Built.
- [ADR-0024](0024-the-overseer-chat-is-a-pane.md): The overseer chat is a pane, parked when idle. Both chat kinds share the pane runtime and the ADR-0021 take back, live panes get a settings cap of 3, a deploy is a forced park, and rehydration returns a pane on the next message. Decided, not built.
- [ADR-0016](0016-the-conversation-key.md): A conversation is keyed on a Discord thread snowflake or on `console-<n>`, the daemon owns that key, and the container holds no conversation state. A transcript is found by key, never by mtime. Decided, not built.

## Dispatch and routing

- [ADR-0004](0004-label-only-routing.md): Model routing reads labels only. Quota awareness is cooling on two triggers, a landed cap and a hot reading, and exhaustion makes the frontier the queue.
- [ADR-0022](0022-the-overseers-command-understanding.md): The overseer quotes a refusal and copies ids verbatim, a roundtrip test guards the seam, a typed verb runs before a model turn, and the map tool splits in two. Decided, not built.
- [ADR-0023](0023-the-skill-dispatch-from-prose.md): A skill asked for in prose starts the ticket that carries it, and a `skill` verb runs the ask no ticket carries. No confirm press, because the review gate holds every tracker write, and its card groups the proposed tickets by waves. Decided, not built.

## Agents

- [ADR-0006](0006-worker-containment-and-standing-orders.md): The agent resolves in the tracker's idiom, bounded by standing orders. The daemon verifies, repairs, and lands.
- [ADR-0007](0007-shared-credential-store.md): Agents share the host credential store. Nothing is snapshotted, so nothing goes stale. The daemon reads that store for the account usage bars, and never writes it.

## Credentials

- [ADR-0018](0018-the-daemon-is-a-github-app.md): One GitHub App replaces every PAT. The daemon holds the private key and mints installation tokens — read-write for agents, read-only for the overseer. The gate approval is the operator's own, and the claim assigns a real user. Decided; the minting core is built and each holder cuts over on its own ticket.
- [ADR-0027](0027-the-daemon-owns-model-credentials.md): The daemon owns every model credential and agents hold leases it refreshes. It refreshes inside the last quarter of the token's own life, writes the host store before the agents, and gets a dead credential back through a browser login in a tmux session no sweep may walk. Subscription only, and the device code never reaches Discord. Built for codex; the claude lane and the overseer follow.

## Human in the loop

- [ADR-0005](0005-escalation-contract.md): Escalations are blocking MCP calls, rendered on Discord, first-valid-wins, durable in the journal. Agent prose is lint-gated: three rejections, then a flagged send, and on codex the Stop hook is what makes a rejection unmissable. Decided, not built.
- [ADR-0013](0013-one-voice-per-fact.md): CuriaBot states mechanics, the agent voice states meaning, and no fact is said twice. Notes queue or interrupt, and a pending cross-check gates the ending.
- [ADR-0019](0019-typed-payloads-and-the-lint-grades.md): Agent prose ships as typed fields, not one string. One vocabulary of seven names, a mandatory floor per surface, two lint grades and a geometry check on the visual. Decided, not built.
- [ADR-0020](0020-the-thread-story.md): The thread is the alert surface, and it tells a fixed floor of a story: a title line, one status line for every mechanic from dispatch to receipt, an agent opening, and a typed closing line. Decided, not built.
- [ADR-0021](0021-the-take-back-is-the-harness-rewind.md): The take back is the harness rewind on user turns, and a correction everywhere a rewind cannot land. The world keeps what ran, and the receipt keeps the text. Decided, not built.
- [ADR-0021](0021-the-thread-formatting-and-the-one-voice.md): Every thread message posts as one bot named curia, in first person for work and small print for mechanics. The status line holds the link buttons and settles with its meters. The working phase is an icon plus a code-mark label. Decided, not built.
- [ADR-0025](0025-the-cards-under-the-one-voice.md): The choice buttons carry a letter and a handle, every card names the file path, and the option bands stand. The ticket gate groups its charting by waves, the verdict leads with the finding, the marks are small print, and one contract binds the chat card. Decided, not built.
- [ADR-0026](0026-the-composite-send.md): One agent send returns an ordered array, and each entry renders as its own Discord message with its own format and files. At most one deciding message, posted last, and at most four messages per send. Composition replaces relaxation. Decided, not built.

## Resolution

- [ADR-0008](0008-resolved-means-merged.md): Resolved means merged. The agent stays alive through the review, and the Stop hook enforces the ending.
- [ADR-0010](0010-the-cross-check.md): The cross-check is a button on the review gate. A reviewer on the other provider returns a verdict, and the builder answers it before the operator decides.
- [ADR-0028](0028-local-only-work-is-salvaged-before-a-clone-dies.md): Local-only work is salvaged before a clone dies. Uncommitted changes and unpushed commits are two named predicates, the salvage is a branch on GitHub rather than a patch on the box, and cancel says so. Decided, not built.

## Attach surfaces

- [ADR-0009](0009-timeline-beside-the-pty.md): The grid-free timeline is the everyday driving surface. The PTY stays for the raw TUI and native dialogs.
- [ADR-0011](0011-tailscale-identity-in-front-of-every-attach-surface.md): Tailscale identity gates every attach surface, reads included. Tailnet membership is no longer the control.
