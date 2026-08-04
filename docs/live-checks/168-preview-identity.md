# Live check: the identity check in front of preview rules (#168)

Ticket: [alp82/curia#168](https://github.com/alp82/curia/issues/168), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.tail3b99f1.ts.net` on 2026-08-05, against real Tailscale Serve and a real dev server.

Every check published one temporary Serve rule on `:8446` and withdrew it. That port sits outside
the live preview range (`8500`–`8599`), so the running daemon's sweep never saw it, and outside the
two live rules (`:8443` terminal, `:8444` timeline), which were untouched. The daemon was not
restarted and its own code was not modified — the check ran the new modules from `/tmp`.

## 1. What was open

[ADR-0011](../adr/0011-tailscale-identity-in-front-of-every-attach-surface.md) gated the terminal
and the timeline and named this surface as the one still open. A preview rule was
`tailscale serve --bg --https=<8500-8599> http://127.0.0.1:<dev-port>`, so an agent's dev server
published to the whole tailnet with tailnet membership as the only control. That is the posture
[#151](https://github.com/alp82/curia/issues/151) had just ended on the other two.

## 2. The shape, and why it is this one

The operator settled the root question first: **a preview is his alone**, never shown to a client or
a collaborator. Everything else followed.

- **One allowlist.** `identity.allow` serves all three surfaces. A second list nobody populates
  differently is two names for one thing.
- **No router.** A single shared proxy would have had to pick a preview out of the `Host` header,
  which Serve passes through verbatim ([#151](151-attach-surface-auth.md) fact 4). With one list,
  reaching one preview through another's rule is not an escalation, so there was nothing to buy by
  routing on client input.
- **One proxy per live preview**, which is `IdentityProxy` used exactly as attach uses it. The bill
  is six idle listeners at `agents.max_concurrent`.
- **A derived port.** `identity.preview_proxy_from` pairs index-for-index with the preview range, so
  the preview on 8501 always proxies through 7701 and `ss -ltn` on the box reads straight.

```
before:  tailnet ──Serve(:8501)──────────────────────> dev server(:9000)
after:   tailnet ──Serve(:8501)──> proxy(:7701) ─────> dev server(:9000)
```

Moving the rule's target from the dev port to a daemon-owned proxy port is a hardening in its own
right. Serve config outlives the daemon, so an orphan rule used to aim at a docker-published port
something else could still be binding. It now aims at a loopback listener that dies with the daemon.

## 3. The checks

Serve rule on `:8446` in front of a real dev server that answers both a page and a WebSocket
upgrade. The dev server bound an ephemeral port, printed in each run.

| # | Request | Result |
|---|---|---|
| 0 | publish while `:7746` is already taken | **refused**, and `tailscale serve status` shows no rule — `the preview identity proxy could not bind 127.0.0.1:7746 — refusing to publish an un-gated dev server to the tailnet` |
| 1 | read back the rule that was written | `http://127.0.0.1:7746` — the gate, never the dev server on `:41337` |
| 2 | me, through Serve, on this box's own name | `200` — `the page under review (#168) /curia-check` |
| 3 | my login removed from a **non-empty** allowlist | `403 "alportac@gmail.com" is not on the identity allowlist` |
| 3b | my login added back, no restart | `200` — the proxy holds a live reference to the set |
| 4 | `-H "Tailscale-User-Login: mallory@example.com"` | `200` — Serve overwrote the forgery, so it bought nothing |
| 5 | `-H "Host: evil.example.com"` | `403 Host "evil.example.com" is not a name this box serves` |
| 6 | `-H "Host: <box>:8501"` — a neighbouring preview's name | `403` — the host set is this preview's own port, not the range |
| 7 | straight at `127.0.0.1:7746`, bypassing Serve | `403 no tailscale-user-login header — the request did not arrive through Tailscale Serve` |
| 8 | stamped WebSocket upgrade, through Serve | `HTTP/1.1 101 Switching Protocols` — HMR still works |
| 9 | the same upgrade, unstamped, at the proxy | `HTTP/1.1 403 Forbidden` |
| 10 | the gate stopped, then a reconcile sweep | the rule is withdrawn |
| 10b | the link, after that sweep | `curl exit 7` — nothing answers on `:8446` |

13 of 13 passed. `tailscale serve status` after cleanup showed only the two live rules.

**0 is the property that matters.** The gate goes up before the rule is written. A rule written
first and gated second is an un-gated dev server on the tailnet for as long as the gap lasts, and
forever if the second step fails.

**8 is the one that could not be reasoned about.** A preview is a real page, and a real dev server
opens an HMR socket. The upgrade carries the Serve stamp ([#151](151-attach-surface-auth.md) fact 3)
and the proxy passes it, so the page a human is shown still live-reloads.

**10 has no counterpart on the attach surfaces.** `/attach` re-checks its proxy on every request,
because a human asks curia for a terminal link each time. Nobody asks for a preview link twice — it
is handed over once and opened later — so the sweep is the only path that can see a gate die under a
live preview.

## 4. Two faults the check found in itself

Both were in the check, not in the code, and both would have read as passes.

- **An allowlist of one.** Removing the only login left the list *empty*, which trips a different
  leg of the predicate (`the identity allowlist is empty`) than the one under test. A decoy login
  now stays on the list. Two refusals are not one fact.
- **curl negotiated HTTP/2.** Without `--http1.1`, no HTTP/1.1 upgrade is ever sent, Serve answers
  the plain page, and `200` looks like a healthy WebSocket. The first run recorded `HTTP/2 200` for
  check 8 and it was worth nothing.

## 5. A wording fix this surfaced

Check 3 read `"alportac@gmail.com" is not on the **attach** identity allowlist` on a *preview*. One
message now serves three surfaces, so it names none of them: it reads `is not on the identity
allowlist`. The tables in [the #151 live check](151-attach-surface-auth.md) quote the old string and
are left as written — they are the record of what that run printed.

## 6. What this does NOT close

- **No agent has published a gated preview.** Every part is measured, but by this check standing the
  registry up directly rather than by a dispatch calling `publish_preview`. The remaining half is
  the third leg of the ticket's own "done when" — the review gate opening on a phone — which needs a
  real dispatch on a ticket that has a page. Graduated rather than faked.
- **Loopback on this box**, unchanged from [ADR-0011](../adr/0011-tailscale-identity-in-front-of-every-attach-surface.md).
  Anything running here reaches the dev server's own port directly. Agents share the host credential
  store and, on the bare path, the tmux socket. Recorded, not chased.
- **The temporary rule was on `:8446`, not inside the preview range.** A rule inside `8500`–`8599`
  would have been withdrawn by the live daemon's own sweep mid-check. The Serve stamp is a property
  of a rule and not of its port number, and check 6 exercises a preview-range port name directly.
