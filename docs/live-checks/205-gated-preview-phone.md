# Live check: a gated preview reaches a phone (#205)

Ticket: [alp82/curia#205](https://github.com/alp82/curia/issues/205), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 on the
deployment box `coinmatica.net`, daemon at `765f859`, through Discord. The vehicle was
[Polish the live page](https://github.com/alp82/curia/issues/137) — a real ticket with a real page
(`docs/index.html`), dispatched by the operator with `start 137` at 09:21:59 UTC.

Every timestamp below is UTC, read from `journalctl -u curia` and `daemon/data/events.jsonl`.
Nothing was staged for the check: the dispatch was ordinary ticket work, and the preview facts fell
out of its journal.

## 1. The four legs of the dispatch

**Leg 1 — the agent binds a published port and calls `publish_preview`.** `agent_spawned` at
09:22:10 carries `ports: [9003, 9004, 9005]`. The agent served `docs/` on `0.0.0.0:9003` — the
first of its three — and called `publish_preview`. The journal holds **no port refusal**: the agent
never tried 4000, the number `docs/landing-page/build.md` named for bare dispatches until the
container note landed (`1a708d3`, pushed before this run).

**Leg 2 — the daemon stands the gate up, and the rule points at the gate.** Two journal lines, one
second after the PR opened:

```
[09:33:49.752Z] preview identity proxy on http://127.0.0.1:7700 → 127.0.0.1:9003
[09:33:49.791Z] preview for ticket 137: https://coinmatica.tail3b99f1.ts.net:8500/ -> proxy :7700 -> 127.0.0.1:9003
```

The Serve rule aims at `:7700` — the identity gate from
[#168](https://github.com/alp82/curia/issues/168) — and not at the container port. The gate is in
the path of every request.

**Leg 3 — the link opens on the phone.** The operator opened
`https://coinmatica.tail3b99f1.ts.net:8500/` on their phone, over the tailnet, under the allowed
login, and the page rendered. This leg is the operator's word: see section 3 for why the journal
cannot carry it.

**Leg 4 — the review gate is answered from the phone.** `esc-121` (review-gate, `curia-137`) opened
at 09:50:48 and was **answered via button at 09:51:11** — 23 seconds. The operator answered from
the phone. [#230](https://github.com/alp82/curia/pull/230) merged at 09:51:17 and the ticket
closed. Approve and reject both reach the phone because the gate is a Discord message with buttons;
this run pressed approve.

## 2. What else the run measured

- **The [#188](https://github.com/alp82/curia/issues/188) fix, live.** `side_channel_ready` at
  09:22:10.738 precedes `agent_spawned` at 09:22:10.753. The channel was up before the agent was.
- **No [#189](https://github.com/alp82/curia/issues/189)-class outage.** `agent_mcp_first` came
  4 seconds after spawn. The agent held its curia toolset for the whole run and used
  `notify`, `open_pull_request`, `publish_preview`, `request_review` and `report_result`.
- **A second `publish_preview` is safe.** The agent called it again at 09:50:33, after its second
  push. The same URL came back and no second rule appeared.
- **Teardown.** `preview for ticket 137 withdrawn (agent finished)` at 09:53:01. Measured on the
  box after the run: `tailscale serve status` shows no `:8500` rule — only the standing attach
  (`:8443`) and timeline (`:8444`) rules — and nothing listens on 7700 or 9003.
- **The whole loop in one lifecycle.** Claim 09:22:06 → spawn → PR → preview → choice escalation →
  gate → merge → `ticket_resolved` → `agent_done` → lease released 09:53:03. One agent, 31 minutes,
  no rescue.

## 3. What this run does not measure

- **HMR through the gate.** The landing page serves through `python3 -m http.server`, which opens
  no HMR socket. The WebSocket upgrade through the gate stays measured only in the lab —
  [#168](https://github.com/alp82/curia/issues/168) check 8. A dispatch on a repo with a real dev
  server is the live measurement, when one comes.
- **The client behind an allowed request.** The journal names no device and no login for a request
  the gate passes — it speaks only when it refuses. So "on the phone" in legs 3 and 4 is the
  operator's attestation, given when they reported the run done. The journal proves the gate was in
  the path; the operator proves what was on the other end of it.
