# ADR-0003: The agent host is bare tmux, one shared ttyd, Tailscale Serve

**Status**: accepted (2026-07)
**Provenance**: [Pick the substrate (#30)](https://github.com/alp82/curia/issues/30), [Spike: browser-terminal phone attach (#32)](https://github.com/alp82/curia/issues/32)

The tracker archive calls the agent host "the substrate". The docs avoid that term.

## Context

The agent-host candidates were Orca, Paseo, herdr, and a composed stack of standard tools. The phone-attach spike put the composed stack through a six-item pass bar on a real phone over Tailscale: stable URL attach, TUI input with slash commands, keyboard-mic dictation, concurrent clients, restart survival, and responsiveness. All six passed.

## Decision

- Agents run in bare tmux, one session per ticket, named `curia-<n>`. The session name is the agent's identity everywhere.
- One shared ttyd page serves terminal attach, with URL-arg session picking. One Tailscale Serve port publishes it. A touch key-bar covers the keys phone keyboards lack.
- Workspaces are per-ticket git worktrees on branch `curia/<n>`, cut from one daemon-owned base clone per repo.
- Voice input is phone keyboard dictation into the browser terminal. Discord voice-memo STT stays a stretch goal, not a gate.
- herdr and Paseo are dropped. Orca stays benched. Every distinctive capability they offered is either covered by a standing decision or broken by curia's own requirements. Resume-with-history loses to the re-dispatch posture of [ADR-0001](0001-github-is-the-only-durable-state-home.md).

## Consequences

- The Serve rule lives in tailscaled and outlives the daemon. Reconcile asserts it and sweeps stale rules.
- Auth was tailnet membership only. That standing pre-production requirement is now met: [ADR-0011](0011-tailscale-identity-in-front-of-every-attach-surface.md) puts a Tailscale identity check in front of ttyd, and `-O` alone is no longer the control.
- Lifecycle signals never come from the agent host. They ride curia's own side channels: the MCP tools and the Stop hook.
- One tmux window has one size. That limit later produced the timeline surface, [ADR-0009](0009-timeline-beside-the-pty.md).
- "Bare tmux" and "worktree" are both narrowed by [ADR-0012](0012-one-container-per-worker.md): the pane now runs one container per agent, and a sandboxed agent's workspace is a private clone rather than a worktree of a shared base. The pane, the session name, the ttyd attach and the Serve rule are unchanged, which is why the container goes inside the pane rather than beside it.
