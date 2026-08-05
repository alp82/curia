# Live check: the preview link opens the app, not Vite's block page (#239)

Ticket: [alp82/curia#239](https://github.com/alp82/curia/issues/239), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 in a dev session
on the operator's workstation, against Vite 8.2.0 on Node 24.15.0. No tailnet leg was needed: the
block page reproduces with any non-localhost Host header, which the ticket predicted.

The fault: the identity proxy forwards the client's Host verbatim, and Vite's `server.allowedHosts`
refuses any Host that is not its own. So the operator opened the curia-81 preview and got
`Blocked request. This host ("coinmatica.tail3b99f1.ts.net") is not allowed.` The fix rewrites Host
to the dev server's own name after the identity check passes, and `publish` now probes the page
with that same Host before any rule is written.

## 1. The block page, reproduced stock

A bare Vite app (`npm create`-shaped, no config) on `:9123`. Vite 8 binds `[::1]` only — the fact
`localhostTarget` already records.

| Request | Answer |
|---|---|
| `Host: coinmatica.tail3b99f1.ts.net:8500` | **403**, the block page, verbatim as the operator saw it |
| `Host: localhost:9123` | 200, the app |
| `Host: 127.0.0.1:9123` | 200, the app |

So the rewrite target satisfies Vite in both address families, with no `allowedHosts` config in any
repo.

## 2. The HMR websocket: the guard is a token, not Origin

The one reason the naive rewrite might not be the answer (ticket point 2). First probes said the
rewrite kills HMR: every upgrade that carried an Origin header got 400, even a same-origin
localhost one. That reading was wrong. Vite's `shouldHandle` (read in the shipped bundle) never
compares Origin against a list. When Origin is present it requires a valid `?token=` in the WS URL.
The token rides the served `/@vite/client`, which an attacker's page cannot read.

Measured against the real server:

| Upgrade request | Answer |
|---|---|
| rewritten Host, tailnet Origin, **real token** | **101** — the browser case through the gate |
| rewritten Host, evil Origin, no token | 400 |
| rewritten Host, evil Origin, wrong token | 400 |

So the rewrite costs no cross-site-WebSocket defense, and Origin is deliberately forwarded
untouched.

## 3. End to end through curia's own module

The real `IdentityProxy` (`rewriteHost: true`) in front of the real Vite, requests shaped exactly
as Serve delivers them (tailnet Host, `Tailscale-User-Login` stamp):

- Page through the gate: **HTTP 200**, the app — where the old code handed back the block page.
- WS token through the gate: found in `/@vite/client`.
- HMR upgrade with the tailnet Origin and the real token: **101 Switching Protocols**.
- Unstamped caller: **403** — the identity check judges the ORIGINAL Host, before the rewrite.

## 4. The publish probe

`probePreviewPage` against the same servers:

- Real Vite, rewritten Host: `{ok: true, status: 200}`.
- Dead port: `{ok: false, error: "ECONNREFUSED"}` — publish refuses and names the cause.
- Accept-then-destroy listener (the docker-proxy shape from #157): refused with the socket error,
  and the container message names the `0.0.0.0` bind.

## Verdict

All three ticket points are settled and the closures hold against the real framework. The suite is
green at 1227 tests, 0 cancelled. Not closed and said so: no preview has gone through the rewritten
gate on the box — the daemon there runs the old code until the next restart, and the first real
`publish_preview` after it is the live check of the Serve leg.
