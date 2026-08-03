# ADR-0011: Tailscale identity gates every attach surface

**Status**: accepted (2026-08)
**Provenance**: [Pick the substrate (#30)](https://github.com/alp82/curia/issues/30), [Land the timeline surface (#74)](https://github.com/alp82/curia/issues/74), [Harden the attach and timeline surfaces (#151)](https://github.com/alp82/curia/issues/151)

## Context

[ADR-0003](0003-tmux-ttyd-tailscale-worker-host.md) booked an identity-enforcing layer in front of
ttyd as a standing pre-production requirement. [ADR-0009](0009-timeline-beside-the-pty.md) landed a
second writable surface under the same deferral. Until now the only control on either was tailnet
membership.

That control was thinner than it looked. Session names are public issue numbers, so the URL of a
running worker is guessable. ttyd's `-O` compares `Origin` to `Host`, which is a browser control: a
non-browser client on the tailnet sets both headers itself and drives a `bypassPermissions` worker.
The timeline gated writes the same way and gated reads on nothing at all.

Tailscale Serve settles it, and the facts were measured on the deployment box rather than reasoned
about ([the live check](../live-checks/151-attach-surface-auth.md)). Serve stamps
`Tailscale-User-Login` on every request it proxies, **overwrites** the header when a client forges
it, and carries it on the **WebSocket upgrade** — the path that actually drives a worker. Serve does
**not** sanitize `Host`: a forged one passes through verbatim, which is the residual hole `-O`
leaves.

## Decision

- Every request to an attach surface must satisfy three things: it is not a Funnel request, its
  `Host` is a name this box answers to on that serve port, and its `Tailscale-User-Login` is on the
  configured allowlist. One predicate, one module, both surfaces.
- The check is **fail-closed**. Each leg must be positively satisfied. A surface that cannot yet
  resolve its own names, or was wired up with no check at all, refuses every caller. This inverts
  the classification rule the reconcile reads follow: there an open question must not take a surface
  down, here an open question must not let a caller in.
- ttyd is a C process with nowhere to put a check, so a daemon-owned loopback proxy carries it:
  Serve publishes the proxy, and the proxy reaches ttyd. The timeline is the daemon's own server and
  applies the same predicate in-process.
- **Reads are gated, not only writes.** The transcript is the sensitive thing on the timeline.
- The serve rule is asserted only over a surface that is positively whole. A proxy that is down
  disqualifies the terminal surface exactly as an unverified ttyd does, and the persisted rule is
  withdrawn rather than left pointing at un-gated ttyd.
- `identity.allow` is **required config**. The daemon refuses to boot without it, because both
  possible defaults are wrong: an invented allowlist admits a login nobody chose, and an empty one
  locks the operator out in silence.
- ttyd keeps `-O`, the loopback bind and the `^curia-` wrapper whitelist. The check is added in
  front; nothing is removed.

## Consequences

- Attach needs no password and no login page. The operator's devices are already on the tailnet
  under the allowed login, and Serve stamps every request. A caller who is not on the list gets a
  403 instead of a terminal.
- Identity is per user, not per device. A lost device that is still authorized under the allowed
  login still attaches. Revoking the node in the Tailscale admin console is the control there.
- **Loopback on this box is not covered and is not meant to be.** Anything running here reaches
  ttyd and the timeline directly and can set any header. The box is already inside the trust
  boundary: workers share the host credential store ([ADR-0007](0007-shared-credential-store.md))
  and the tmux socket ([ADR-0003](0003-tmux-ttyd-tailscale-worker-host.md)).
- Preview rules are **not** covered. A worker's dev server still publishes to the whole tailnet
  with no identity check. That is the next surface to take this treatment.
- Any future surface published through Serve inherits this decision. Adding one without the check
  reopens what this closed.
- A change in what Serve stamps would refuse every caller rather than admit them. That is the right
  direction to fail, and the 403 names the missing header.
