# ADR-0012: One container per agent, started by its own tmux pane

**Status**: accepted (2026-08), claude harness first and off by default
**Provenance**: [Decide the agent sandbox boundary and mechanism (#148)](https://github.com/alp82/curia/issues/148), [Build the agent container image (#154)](https://github.com/alp82/curia/issues/154), [Mint the scoped GitHub PAT and inject GH_TOKEN (#155)](https://github.com/alp82/curia/issues/155), [Containerize dispatch: docker run replaces the bare pane (#156)](https://github.com/alp82/curia/issues/156)

## Context

[ADR-0003](0003-tmux-ttyd-tailscale-worker-host.md) put agents in bare tmux panes on trusted infrastructure. A bare pane inherits the box: the host HOME with `~/.ssh`, `~/.claude`, `~/.codex` and `~/.config/gh`, the daemon's own checkout and secrets, every sibling agent's worktree, and the tmux socket. [#141](https://github.com/alp82/curia/issues/141) is what that costs in practice — an agent's own test suite ran `tmux kill-server` against the live socket and killed every other agent on the box.

The threat model is the confused-deputy agent: hostile instructions in repo content, in issue text, or in dependency output, plus plain misjudgment. Hostile humans on the tailnet are a different problem, answered by [ADR-0011](0011-tailscale-identity-in-front-of-every-attach-surface.md).

## Decision

- **One Docker container per agent, run by the tmux pane.** The pane's command is `docker run -it --rm --name curia-<n>`. Every surface above the pane keeps working through the TTY with no change: `capture-pane` reads the TUI, `send-keys` drives it, the ttyd attach shows it, and the readiness watchdog reads the same composer marker.
- **Two host directories are mounted, and nothing else.** The agent's own clone at `/workspace`, its config dir at `/cfg`, plus two shared cache volumes. The container denies the host HOME, the daemon's secrets and state, sibling workspaces, and the tmux socket.
- **The network stays open.** `gh` and web reach are what wayfinder runs on, so containment comes from the small readable set, not from egress rules.
- **The workspace is a private blobless clone**, not a worktree of a shared base. A worktree's `.git` is a file pointing into the base clone, so a container could only use one by mounting every other agent's history as well.
- **The daemon reaches its agents, and they reach it back.** The MCP side channel and the Stop hook use the docker host gateway, so the daemon binds a second listener on the bridge address. Loopback would be the container itself.
- **Three loopback ports per agent**, published `127.0.0.1:<p>:<p>`, the same number inside and out.
- **Credentials.** GitHub reach is the scoped token of [ADR-0006](0006-worker-containment-and-standing-orders.md)'s amendment. The model credential is copied into the container environment through an env file, never a command line.
- **Per-harness switch, shipped off.** The claude harness goes first, the codex harness follows after the soak, and the bare path is deleted only when both hold.

## Consequences

- **The model credential is frozen for the agent's life.** [ADR-0007](0007-shared-credential-store.md) shares the host store precisely so nothing goes stale, and the container cannot: the store lives in the host HOME. On the deployment box the value is the `claude setup-token` credential, which does not rotate, so the exposure is a copy rather than an expiry. A box authenticating with a rotating login gives its agents a token that can die mid-ticket.
- **Docker is rootful, so the daemon user is root-equivalent on the box** ([#181](https://github.com/alp82/curia/issues/181)). Rootless Docker does not fit: it maps the container uid to a subordinate host uid, and the agent could then not write the clone the daemon prepared for it.
- **The daemon's loopback surface is reachable from every container on the default bridge.** That is not new reach for an agent — a bare pane always had the loopback port — but it is the boundary's one deliberate hole. [#159](https://github.com/alp82/curia/issues/159) narrowed it to the two agent routes, each gated by a per-agent token: a container reaches `/mcp` and `/agent_done` as itself, and reaches `/command`, `/answer`, `/cancel`, `/escalate`, `/reconcile` and `/state` not at all.
- **Skills are copied into a sandboxed config dir, not symlinked.** A link into the host skills root resolves to nothing inside the container, and an agent silently without its skills is the failure [#57](https://github.com/alp82/curia/issues/57) exists to end.
- **A container can outlive its pane.** An ordinary `kill-session` takes it down, because the `docker run` client forwards the signal. A client killed outright does not, so every ordered teardown removes the container and reconcile sweeps what nothing ordered.
- **The image is a content address** ([#154](https://github.com/alp82/curia/issues/154)), so the first dispatch after a pin bump or a Dockerfile edit builds it and waits about four minutes.
