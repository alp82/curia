# ADR-0002: A thin custom daemon, not an adopted platform

**Status**: accepted (2026-07)
**Provenance**: [Decide dispatcher build posture (#17)](https://github.com/alp82/curia/issues/17)

## Context

The daemon body could be hermes-agent adopted wholesale, or a thin custom core that drives commodity parts. The call waited on live evaluations of the borrowed parts (the OpenACP bridge and the substrate candidates).

## Decision

Thin-custom wins. One Node process, no build step, owns only the unique logic: the frontier loop, routing, escalation orchestration, the durable escalation record, previews, and reconcile. Commodity parts fill every other slot.

The Discord bridge is a small discord.js module inside the daemon, not a vendored OpenACP. It holds no state. It renders and captures, and it never interprets. The module boundary stays clean so the bridge could split into its own process later.

Rejections, recorded:

- The hermes kanban as the brain. It would reintroduce the two-writer drift that [ADR-0001](0001-github-is-the-only-durable-state-home.md) rules out.
- Vendored OpenACP. Its remaining value was Discord rendering, and the price was its agent-owning process model, a dead pseudonymous upstream, a license mess, and a broken install. The vendored source stays as a design reference only.

## Consequences

- One process is one deploy unit. The daemon, the bridge, the router, and the MCP surface ship together.
- Every borrowed part is swappable, because curia owns the seams.
- The worker and attach substrate was deliberately not settled here. [ADR-0003](0003-tmux-ttyd-tailscale-substrate.md) holds that pick.
