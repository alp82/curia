# ADR-0009: The timeline surface sits beside the PTY

**Status**: accepted (2026-07)
**Provenance**: [A phone and a desktop cannot share one terminal geometry (#71)](https://github.com/alp82/curia/issues/71), [Can two devices drive one live agent at their own sizes? (#72)](https://github.com/alp82/curia/issues/72), [Prototype the dual-geometry attach (#73)](https://github.com/alp82/curia/issues/73), [Land the timeline surface as asserted config (#74)](https://github.com/alp82/curia/issues/74)

## Context

A phone and a desktop attached to one agent fight over the terminal geometry, and repeated resizes corrupt the scrollback. The limit is structural: one PTY carries one size, a full-screen TUI paints absolute positions, and no relay can render one live pane at two sizes. Every geometry trade makes one device give up its shape, and the operator refused each one. The research swept the whole multiplexer and relay family and closed it.

## Decision

- Curia gets a second attach surface, the timeline. It reads the agent's own transcript and writes with `tmux send-keys`. A timeline has no grid, so every device lays it out at its own width, and `send-keys` drives a session with zero attached clients.
- Both devices are full driving seats. Input from either lands in the same live turn, drafts mirror across devices, and neither device reflows the other.
- The timeline sits beside the terminal surface, not in place of it. The timeline is where you drive. The terminal stays for the two things a grid-less surface cannot do: watch the raw TUI and hand a terminal-only dialog.
- The surface ships as asserted config: a committed asset stamped with a digest of its source, its own port and Serve rule asserted on reconcile, and a boot-time refusal of a stale page.
- A transcript the daemon cannot parse fails loudly, on the page and in the journal. Silence must never read as a quiet agent.
- Open escalations render on the timeline from the daemon's own record (the escalation overlay), because a transcript is silent while a question blocks.
- The timeline is not a second authority. Its write path is the keystroke tier, and discrete decisions stay first-valid-wins on Discord, per [ADR-0005](0005-escalation-contract.md).

## Consequences

- Extended thinking never reaches the transcript, so the timeline cannot show it. The terminal can.
- Liveness is per message, not per token. A `stream-json` broker is the named graduation path if token-level liveness is ever worth replacing the PTY for.
- A native terminal dialog is invisible on the timeline and swallows injected keys, so the timeline shows a dialog banner and guards sends while a dialog holds the pane.
- The geometry flap on the terminal surface stays, accepted: two devices on the terminal at once stopped being a real scenario once the everyday surface stopped needing a grid.
- The surface landed under the attach hardening deferral. That deferral is closed: [ADR-0011](0011-tailscale-identity-in-front-of-every-attach-surface.md) gates the timeline on Tailscale identity, reads included.
