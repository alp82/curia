# Research notes

One note per investigation. Each line gives the topic and the outcome. The outcome states what happened to the investigated candidate or question: **adopted** into the shipped design, **rejected** as a candidate, **superseded** by a later note or decision, or **informational** background. The ADRs at [`../adr/README.md`](../adr/README.md) hold the standing decisions these outcomes point to.

| Note | Topic | Outcome |
|---|---|---|
| [acp.md](acp.md) | ACP as curia's worker-facing agent shim seam | Superseded — refined by [acp-roundtrip-verification.md](acp-roundtrip-verification.md), and the seam went unused |
| [acp-roundtrip-verification.md](acp-roundtrip-verification.md) | Live ACP escalation, permission, image, and steering round-trip | Rejected — the MCP contract (ADR-0005) shipped instead of an ACP lane |
| [cline.md](cline.md) | Cline CLI as a native-ACP worker lane candidate | Superseded — source read only; [cline-worker-lane.md](cline-worker-lane.md) ran it |
| [cline-worker-lane.md](cline-worker-lane.md) | Cline hands-on worker lane via the OpenACP seam | Rejected — no ACP lane in the ADR-0003 tmux host |
| [codex-lane-gaps.md](codex-lane-gaps.md) | Where the codex lane trails the claude lane | Informational - grounds the fix tickets that graduate from [#152](https://github.com/alp82/curia/issues/152) |
| [discord-thread-surprises.md](discord-thread-surprises.md) | Cold read of every #curia thread: routing and ownership surprises, by composer and code path | Informational — grounds the thread-fix tickets on [#244](https://github.com/alp82/curia/issues/244) |
| [dual-geometry-attach.md](dual-geometry-attach.md) | Per-device geometry on one live worker | Adopted — grounds ADR-0009's grid-free timeline surface |
| [headless-worker-auth.md](headless-worker-auth.md) | Claude Code worker auth on a headless server: subscription OAuth token vs API key | Informational — grounds the worker-auth choice for the Hetzner box |
| [herdr.md](herdr.md) | herdr as a tmux-for-agents worker host | Rejected — ADR-0003 picks bare tmux over herdr |
| [herdr-handson.md](herdr-handson.md) | herdr booted against the Orca rubric | Superseded — refines [herdr.md](herdr.md); herdr dropped by ADR-0003 |
| [hermes-agent.md](hermes-agent.md) | Hermes Agent as an adoptable dispatcher platform | Rejected — ADR-0002 keeps the daemon thin, ADR-0001 forbids a second tracker |
| [hermes-agent-handson.md](hermes-agent-handson.md) | Booting the Hermes dispatcher, kanban, and Discord bridge | Superseded — refines [hermes-agent.md](hermes-agent.md); the adoption branch was dropped |
| [landscape-scan.md](landscape-scan.md) | Sweep of daemons, bridges, orchestrators, and muxes | Informational — found no replacement candidates |
| [matt-pocock-skills.md](matt-pocock-skills.md) | The Pocock skill set as worker procedure grammar | Adopted — ADR-0006 vendors the set at `skills/` and installs it into worker configs |
| [multica.md](multica.md) | Multica as an orchestrator and tracker candidate | Rejected — its Postgres is the tracker, which ADR-0001 forbids |
| [node-sqlite-guarantees.md](node-sqlite-guarantees.md) | Durability, operation, maturity, and write cost for `node:sqlite` on Node 24 | Informational - grounds the journal store decisions on [The journal becomes a queryable store](https://github.com/alp82/curia/issues/316) |
| [openacp.md](openacp.md) | OpenACP as a Discord bridge and agent daemon | Rejected — ADR-0002 keeps it as a design reference only |
| [openacp-handson.md](openacp-handson.md) | Building and booting the OpenACP fork bridge | Superseded — refines [openacp.md](openacp.md); vendoring was rejected |
| [orca.md](orca.md) | Orca as a multi-device attach worker host | Rejected — benched; ADR-0003 picks tmux + ttyd + Tailscale |
| [orca-headless-verification.md](orca-headless-verification.md) | Empirical check of Orca's four headless claims | Superseded — verifies [orca.md](orca.md); Orca stayed benched |
| [overseer-session-hosting.md](overseer-session-hosting.md) | Hosting, revival, and tool exposure for the overseer session | Informational — grounds the [#83](https://github.com/alp82/curia/issues/83) prototype |
| [pane-keystroke-codex.md](pane-keystroke-codex.md) | Whether a keystroke reaches a codex agent blocked inside a tool call | Informational — the pane reaches a parked agent in about 3 s, which opens the boot sweep on [#457](https://github.com/alp82/curia/issues/457) |
| [paperclip.md](paperclip.md) | Paperclip as an ACP-per-turn orchestrator candidate | Rejected — design reference; it did not reopen the worker-host call |
| [paseo.md](paseo.md) | Paseo daemon as an always-on host and dispatcher | Rejected — ADR-0003 drops Paseo (AGPL, bus factor of one) |
| [paseo-handson.md](paseo-handson.md) | Paseo re-run against the Orca rubric | Superseded — refines [paseo.md](paseo.md); Paseo dropped by ADR-0003 |
| [phone-attach.md](phone-attach.md) | tmux + ttyd + Tailscale browser terminal for phone attach | Adopted — this is ADR-0003's shipped worker host stack |
| [pi.md](pi.md) | pi as a minimal embeddable worker runtime | Rejected — worker only; Claude Code in tmux shipped instead |
| [pi-handson.md](pi-handson.md) | pi driven live via SDK, RPC, and pi-acp | Superseded — refines [pi.md](pi.md); the pi lane never shipped |
| [tool-channel-mid-session.md](tool-channel-mid-session.md) | What a harness does when the daemon dies under it | Adopted — the channel survives a restart, so [#341](https://github.com/alp82/curia/issues/341) put the waits into the retry rule |
| [tool-channel-mid-session-codex.md](tool-channel-mid-session-codex.md) | The codex half of the same question | Adopted — a codex agent is told nothing, so [#426](https://github.com/alp82/curia/issues/426) made the daemon say goodbye before it dies |
| [worker-two-channels.md](worker-two-channels.md) | Side-channel driving plus human PTY attach | Adopted — the daemon never parses scrollback; underpins ADR-0005 |
