# Architecture decision records

One file per standing decision. A decision earns an ADR when it still constrains future work. Deviations live inside the ADR they deviate from. History stays on the tracker: each ADR cites its source tickets, so the tracker is pure archive, never required reading.

## State and awareness

- [ADR-0001](0001-github-is-the-only-durable-state-home.md): GitHub is the only durable state home. The daemon holds no board, and the journal is its one artifact.

## Daemon and worker host

- [ADR-0002](0002-thin-custom-daemon.md): A thin custom daemon owns the unique logic and drives commodity parts. No adopted platform.
- [ADR-0003](0003-tmux-ttyd-tailscale-worker-host.md): Workers live in bare tmux, attach is one shared ttyd behind Tailscale Serve, workspaces are per-ticket worktrees.

## Dispatch and routing

- [ADR-0004](0004-label-only-routing.md): Model routing reads labels only. Quota awareness is reactive cooling, and exhaustion makes the frontier the queue.

## Workers

- [ADR-0006](0006-worker-containment-and-standing-orders.md): The worker resolves in the tracker's idiom, bounded by standing orders. The daemon verifies, repairs, and lands.
- [ADR-0007](0007-shared-credential-store.md): Workers share the host credential store. Nothing is snapshotted, so nothing goes stale. The daemon reads that store for the account usage bars, and never writes it.

## Human in the loop

- [ADR-0005](0005-escalation-contract.md): Escalations are blocking MCP calls, rendered on Discord, first-valid-wins, durable in the journal.

## Resolution

- [ADR-0008](0008-resolved-means-merged.md): Resolved means merged. The worker stays alive through the review, and the Stop hook enforces the ending.
- [ADR-0010](0010-the-cross-check.md): The cross-check is a button on the review gate. A reviewer on the other provider returns a verdict, and the builder answers it before the operator decides.

## Attach surfaces

- [ADR-0009](0009-timeline-beside-the-pty.md): The grid-free timeline is the everyday driving surface. The PTY stays for the raw TUI and native dialogs.
- [ADR-0011](0011-tailscale-identity-in-front-of-every-attach-surface.md): Tailscale identity gates every attach surface, reads included. Tailnet membership is no longer the control.
