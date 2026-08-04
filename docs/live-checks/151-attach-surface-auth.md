# Live check: the identity layer in front of attach and timeline (#151)

Ticket: [alp82/curia#151](https://github.com/alp82/curia/issues/151), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.tail3b99f1.ts.net` on 2026-08-03, against real Tailscale Serve and the real ttyd.

Every check published one temporary Serve rule on `:8446` and withdrew it. The two live rules
(`:8443` terminal, `:8444` timeline) were untouched, and the daemon was not restarted.

## 1. What was open

`tailscale serve --https=<port>` publishes to the whole tailnet. Nothing else gated either
surface, so the control was tailnet membership alone.

- Session names are public GitHub issue numbers, so `wss://<box>:8443/ws?arg=curia-151` is
  guessable.
- ttyd's `-O` compares `Origin` to `Host`. It is a browser control. A non-browser client sets
  both headers itself.
- The timeline gated writes on the same rule and gated reads on nothing.

So any tailnet client could drive a `bypassPermissions` worker and read every transcript.

## 2. What Tailscale Serve gives you

Measured first, because the whole design turns on it. A header-echo server on `127.0.0.1:4599`,
published on `:8446`.

| # | Request through Serve | Backend saw |
|---|---|---|
| 1 | plain `GET` | `tailscale-user-login: alportac@gmail.com`, plus `-user-name`, `-user-profile-pic` |
| 2 | `-H "Tailscale-User-Login: evil@example.com"` | `tailscale-user-login: alportac@gmail.com` — **Serve overwrote the forgery** |
| 3 | `-H "Host: evil.example.com"` | `host: evil.example.com` — **Serve passed the forgery through** |
| 4 | WebSocket upgrade | `tailscale-user-login: alportac@gmail.com` — the header rides the upgrade |
| 5 | straight at `127.0.0.1:4599`, forged header | `tailscale-user-login: evil@example.com` — a local process sets what it likes |

Facts 1, 2 and 4 make the login an identity: a tailnet client cannot forge it, and it reaches the
drive path. Fact 3 says `Host` is client-controlled input, which is the residual hole `-O` leaves.
Fact 5 fixes the boundary: loopback on this box is not covered, and is not meant to be.

## 3. Where the check went

```
tailnet ──Serve(:8443)──> identity proxy(:7682) ──> ttyd(:7681)
tailnet ──Serve(:8444)──> timeline(:4272), check applied in-process
```

ttyd is a C process with nowhere to put a check, so the rule points at the proxy. The timeline is
the daemon's own server, so it carries the same predicate directly. Every request must satisfy
three things: not a Funnel request, a `Host` this box answers to, and a `Tailscale-User-Login` on
the configured allowlist. ttyd keeps `-O`, the loopback bind and the `^curia-` wrapper whitelist.

## 4. The checks

Serve rule on `:8446`, pointed first at the identity proxy in front of the **real ttyd on 7681**,
then at a timeline surface on `:7691`.

```
# allowed Host names on :8446:
#   coinmatica.tail3b99f1.ts.net:8446, coinmatica:8446,
#   100.98.118.33:8446, [fd7a:115c:a1e0::d436:7624]:8446
```

### The terminal surface

| # | Request | Result |
|---|---|---|
| A | me, through Serve, on this box's own name | `HTTP 200` — ttyd answers |
| B | me, forging `Tailscale-User-Login: mallory@example.com` | `HTTP 200` — Serve overwrote it, so the forgery bought nothing |
| C | `-H "Host: evil.example.com"` | `403 Host "evil.example.com" is not a name this box serves` |
| D | straight at the proxy, no Serve, no identity | `403 no tailscale-user-login header — the request did not arrive through Tailscale Serve` |
| E | WebSocket upgrade, stamped, `?arg=curia-livecheck` | `HTTP/1.1 101 Switching Protocols` — the drive path still works |
| F | the same upgrade at **`?arg=curia-151`, a live worker**, `Origin == Host`, unstamped | `HTTP/1.1 403 Forbidden` |
| G | me, through Serve, with my login off the allowlist | `403 "alportac@gmail.com" is not on the attach identity allowlist` |

**F is the hole closed.** That exact request — `Origin` equal to `Host`, aimed at a running
worker — is the one ttyd's `-O` admits today. It is now refused before it reaches ttyd.
**E** is the counterpart: the same path, stamped, still reaches the terminal.

### The timeline surface

| # | Request | Result |
|---|---|---|
| H | me, through Serve | `HTTP 200` — the page loads |
| I | the transcript stream, unstamped | `403 no tailscale-user-login header …` |
| J | a write (`POST /send`, `echo pwned` at `curia-151`), unstamped | `403 no tailscale-user-login header …` |
| K | me, through Serve, with my login off the allowlist | `403 "alportac@gmail.com" is not on the attach identity allowlist` |

Check **I** is new behavior, not a restatement: reads used to be ungated. A transcript is the
sensitive thing on this surface, so a caller who may not drive the worker may not read it either.

## 5. Callers from outside the tailnet

Refused by the network layer, below any of the above. Recorded rather than tested from a third
host, because each fact is checkable on the box:

```
$ tailscale serve status
https://coinmatica.tail3b99f1.ts.net:8443 (tailnet only)
https://coinmatica.tail3b99f1.ts.net:8444 (tailnet only)

$ tailscale funnel status          # no funnel on either port

$ ss -ltn
LISTEN  127.0.0.1:7681         # ttyd — loopback only
LISTEN  127.0.0.1:4272         # timeline — loopback only
LISTEN  100.98.118.33:8443     # tailnet address only, never 0.0.0.0
LISTEN  100.98.118.33:8444
```

Serve says "tailnet only", no Funnel rule exists, the backends bind loopback, and the published
ports bind the tailnet addresses alone. A caller off the tailnet has no route to any of them.

## 6. What this does NOT close

- **Loopback on this box** (fact 5). Anything running here reaches `127.0.0.1:7681` and
  `127.0.0.1:4272` directly and can set any header. That is already inside the trust boundary:
  workers share the host credential store ([ADR-0007](../adr/0007-shared-credential-store.md)) and
  the tmux socket ([ADR-0003](../adr/0003-tmux-ttyd-tailscale-worker-host.md)). Recorded, not chased.
- **Preview rules** (`8500`–`8599`). A worker's dev server still publishes to the whole tailnet
  with no identity check. Out of this ticket's scope, which named the attach and timeline surfaces.
  **Closed since, by [#168](https://github.com/alp82/curia/issues/168)** — see
  [the preview live check](168-preview-identity.md). One note there corrects a string quoted in the
  tables above: the allowlist refusal read "not on the **attach** identity allowlist" and now reads
  "not on the identity allowlist", because one message serves three surfaces.
- **A stolen device that is still on the tailnet under the allowed login.** Identity is per user,
  not per device. Revoking the node in the Tailscale admin console is the control there.

## 7. Deploying it

The change is inert until the daemon restarts. `config/curia.yaml` now carries an `identity:`
section, and the daemon **refuses to boot without it** — there is no safe default for an
allowlist. After the restart, confirm both surfaces on a phone, then re-run checks D and I
(they need no Serve rule, only `curl` on the box) to see the refusals live.
