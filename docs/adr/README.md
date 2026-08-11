# Architecture decision records

One file per standing decision. A decision earns an ADR when it still constrains future work. Deviations live inside the ADR they deviate from. History stays on the tracker: each ADR cites its source tickets, so the tracker is pure archive, never required reading.

## State and awareness

- [ADR-0001](0001-github-is-the-only-durable-state-home.md): GitHub is the only durable state home. The daemon holds no board, and the journal is its one artifact.

## Daemon and agent host

- [ADR-0002](0002-thin-custom-daemon.md): A thin custom daemon owns the unique logic and drives commodity parts. No adopted platform.
- [ADR-0003](0003-tmux-ttyd-tailscale-worker-host.md): Agents live in bare tmux, attach is one shared ttyd behind Tailscale Serve, workspaces are per-ticket worktrees.
- [ADR-0012](0012-one-container-per-worker.md): Each agent runs in its own Docker container, started by its own tmux pane, holding its own clone and nothing else of the box.
- [ADR-0014](0014-the-overseer-in-its-own-container.md): The overseer leaves the daemon process for its own container. It reads a checkout of every watched repo, and a read-only token replaces the tool surface as its boundary. Decided, not built.
- [ADR-0015](0015-the-overseer-is-a-service.md): That container is a persistent compose service, not an agent-shaped pane and not one container per conversation. Compose owns its liveness, and a turn a restart kills is replayed rather than retyped. Decided, not built.

## Dispatch and routing

- [ADR-0004](0004-label-only-routing.md): Model routing reads labels only. Quota awareness is reactive cooling, and exhaustion makes the frontier the queue.

## Agents

- [ADR-0006](0006-worker-containment-and-standing-orders.md): The agent resolves in the tracker's idiom, bounded by standing orders. The daemon verifies, repairs, and lands.
- [ADR-0007](0007-shared-credential-store.md): Agents share the host credential store. Nothing is snapshotted, so nothing goes stale. The daemon reads that store for the account usage bars, and never writes it.

## Human in the loop

- [ADR-0005](0005-escalation-contract.md): Escalations are blocking MCP calls, rendered on Discord, first-valid-wins, durable in the journal.
- [ADR-0013](0013-one-voice-per-fact.md): CuriaBot states mechanics, the agent voice states meaning, and no fact is said twice. Notes queue or interrupt, and a pending cross-check gates the ending.

## Resolution

- [ADR-0008](0008-resolved-means-merged.md): Resolved means merged. The agent stays alive through the review, and the Stop hook enforces the ending.
- [ADR-0010](0010-the-cross-check.md): The cross-check is a button on the review gate. A reviewer on the other provider returns a verdict, and the builder answers it before the operator decides.

## Attach surfaces

- [ADR-0009](0009-timeline-beside-the-pty.md): The grid-free timeline is the everyday driving surface. The PTY stays for the raw TUI and native dialogs.
- [ADR-0011](0011-tailscale-identity-in-front-of-every-attach-surface.md): Tailscale identity gates every attach surface, reads included. Tailnet membership is no longer the control.
