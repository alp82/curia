# curia daemon

The always-on daemon from map decision [#9](https://github.com/alp82/curia/issues/9): agent-facing MCP surface + Discord bridge module + durable escalation record ([#31](https://github.com/alp82/curia/issues/31)) + the dispatch loop ([#33](https://github.com/alp82/curia/issues/33)) + the client for the overseer container ([#92](https://github.com/alp82/curia/issues/92), which moved out of this process on [#315](https://github.com/alp82/curia/issues/315)). Agent-host-agnostic — agents connect over streamable-HTTP MCP regardless of how they were spawned (#29).

## Setup

This section is the operator's box. To set curia up on your own machine, read the
[root README](../README.md).

The daemon expects these on the box before the first boot:

- **Node 22+** with npm. The daemon is one Node process (`npm install`, then `npm start`).
- **Claude Code, logged in.** Agents share the host credential store at `~/.claude` (#53). They have no login of their own. If the host is logged out, every agent fails. The overseer container is the one exception: it mounts no `~/.claude` and runs each turn on the model credential in `.env.overseer` (#327).
- **`gh`, authenticated** for every watched repo. The daemon claims, comments, and closes tickets through it.
- **`tmux`** — the agent host. Under compose (#260) the server lives in the `tmux` service and the daemon is a client over `CURIA_TMUX_SOCKET`. Unset, the default socket serves a dev box.
- **`ttyd` on port 7681** for the browser terminal. The compose `ttyd` service runs it. The daemon health-checks the port and does not spawn ttyd.
- **Tailscale** with Serve available. Attach links and preview links publish through `tailscale serve`.
- **A Discord bot** in one guild, with the message-content intent, and its token in `.env.daemon`.

`.env.daemon` (never committed). One env file per container that holds secrets, and the pair reads as a pair: this one and `.env.overseer` (#313):

- `DISCORD_BOT_TOKEN` — CuriaBot token. Omit to run REST-only (escalations stay answerable via `POST /answer`).
- `DISCORD_ALLOWED_USERS` — comma-separated Discord user ids; the auth gate. The bridge refuses to start if empty.
- `CURIA_AGENT_GH_TOKEN_<OWNER>` — the FALLBACK GitHub token an agent gets as `GH_TOKEN` (#155). One key per resource owner, uppercased, hyphens folded to underscores: `alp82/curia` reads `CURIA_AGENT_GH_TOKEN_ALP82`. An agent mints its own token from the GitHub App since #389, and this key is what an owner the app is not installed on still gets. See [the agent's GitHub authority](#the-agents-github-authority-155-cut-over-by-389) below.
- `CURIA_GUILD_ID` (optional — defaults to the bot's first guild), `CURIA_CHANNEL` (default `curia`), `PORT` (default 4271).
- The overseer's own tokens are **not** in this file, and since #392 they are in no env file at all. The daemon mints them and writes one file per owner under `<workspace_root>/overseer/tokens/`. `.env.overseer` beside this file keeps the model credential, and the overseer service loads that file and never this one. See [the overseer's GitHub authority](#the-overseers-github-authority-313-cut-over-by-392) below.
- The overseer takes **no model variable here**. It runs in its own container since the cutover (#315), on `claude-sonnet-5` with no fallback, and the model is `OVERSEER_CONTAINER_MODEL` in `src/overseerturn.mjs`. `OVERSEER_MODEL` and `OVERSEER_FALLBACK_MODEL` died with the in-daemon host.

Config (validated on load; a bad shape refuses the boot): `../config/curia.yaml` (watch list, dispatch settings — `auto_dispatch` ships `false` — attach ports, preview range, agent skill set) and `../config/routing.yaml` (label-only model routing, fallback chains, harness command templates). Override the directory with `CURIA_CONFIG_DIR`.

Each of those two files takes an override beside it — `curia.local.yaml` and `routing.local.yaml`, both ignored by git (#292). The daemon reads the tracked file and lays the override over it: a mapping merges key by key, and a list or a scalar replaces whole. The box's own answers live there, so a save from the dashboard leaves the checkout clean. The daemon names the override and its top-level keys at boot.

## Run

```
npm install
npm start          # reads daemon/.env.daemon
npm test           # unit tests
```

One boot brings up everything: the HTTP surface, ttyd, the Discord bridge, the reconcile pass, and the client for the overseer container. The overseer model runs in its own compose service (`overseer`), and the daemon posts each operator message to it. To verify a boot, look for `ready: guild=<guild> channel=#curia` in the log, then send a top-level message in `#curia` — a thread opens and the overseer answers in it.

### The test suite

`npm test` must be green. No failure here is expected. No count in the summary is a baseline to read past.

**A cancelled test is not a skipped test.** A cancelled test is one whose suite died in its `before` hook. For a real-boot suite this means the daemon child never started, so the test proves nothing at all. Since #212 the boot wait watches the child as well as the port. A child that refuses to boot fails the wait in about one second. The message starts with `the real-boot fixture never got a daemon`, and the child's own stderr comes below it. See `test/fixtures/real-boot.mjs`.

**No suite reads `$HOME`.** `loadCuriaConfig` checks `skills.install` against `skills.root`, and that root defaults to `~/.claude/skills`. So a fixture config that says nothing about skills asks the host a question the test cannot control. Every fixture config now names a skills root that the test seeds. See `test/fixtures/skills.mjs`. The two tests that pin the default root swap in a home directory they own. The suite gives the same answer on the operator's box, in an agent container, and on a stranger's machine.

**One host binary stays optional.** The tmux describes in `tmux.test.mjs` need `tmux`, and each one states why it skipped. An agent container carries no tmux, so a green run there shows three skipped describes. Nothing needs a ttyd binary since #260 — `attach.test.mjs` pins the compose command instead.

## Surfaces

Two of these routes are the AGENT's, and since #159 they are gated: `/mcp` and `/agent_done` take a per-agent token in the `X-Curia-Agent-Token` header, minted at spawn and written into that agent's own connection settings. A third is the OVERSEER CONTAINER's, `/overseer/mcp`, gated the same way by a secret minted per turn (#314). Everything else is the operator's own and answers on loopback only. The docker bridge gateway listener serves those three container routes and nothing else.

- `POST /mcp?agent=<name>&ticket=<n>` — MCP tools `ask_human` (blocking), `notify`, `report_result`, `publish_preview` (#40, `path` since #68), `open_pull_request` and `request_review` (#54). Ticket binding rides the spawn URL (#11). `ask_human` and `notify` also take `images: [<path>]` (#34).
- `POST /overseer/mcp?turn=<id>` — the eight verb tools, for the model in the overseer container (#314). The daemon composes the canonical text from the validated arguments and posts it to the same `/command` seam, so the container reaches eight verbs and never the router. The secret in the header opens ONE live turn; it is minted per turn and forgotten when the turn ends.
- `GET /state` — open escalations + bridge status.
- `GET /overview` — the dashboard's whole read of the daemon (#262, per [#249](https://github.com/alp82/curia/issues/249)). It carries the live agents with their context meter and their last contact (#370), open escalations, the review gate with its pull request and its diff digest (#355), bridge health, one usage reading per provider with its stated reset, the last 100 journal events, and the two-level frontier under the instant reconcile computed it. Each section is nullable on its own. An unreadable fleet says so, and costs the page nothing else. The journal file itself never crosses. Its tail does.
- `GET /diff?esc=<id>|agent=<name>[&file=<i>]` — the diff digest and, on demand, one file's hunks (#355, building [#343](https://github.com/alp82/curia/issues/343)). A review gate answers from the digest counted when it opened, so it costs no read. An agent answers a fresh count of its worktree, committed and uncommitted work together. `file` is a place in that digest's own ranked list, never a path: the caller names a gate or an agent, and the daemon resolves the worktree itself. A worktree that is gone falls back to `gh pr diff` when the pull request is known. This is the one console read that is not the poll.
- `POST /escalate` — synthetic escalation (testing / non-MCP emitters); `?wait=1` blocks until answered.
- `POST /answer {id, answer, attachments?}` / `POST /cancel {id}` — same first-valid-wins gate as Discord.
- `POST /agent_done?agent=` — Stop-hook webhook (#29); closes the dispatch lifecycle (result recorded ⇒ clean close; result-less ⇒ abnormal exit, session kept for post-mortem).
- `POST /command {text}` — canonical command text, REST parity with the Discord slash verbs.
- `POST /reconcile` — on-demand reconcile (boot reconcile runs automatically).
- `GET /repos` — the repos the settings screen offers (#265). The dashboard holds no GitHub credential, so the daemon reads them with the login every dispatch uses: the 100 most recently pushed repos it can reach, cached 10 minutes. A failed read answers `repos: null` with the reason, never an empty list.
- `POST /restart {by?}` — the restart the settings screen orders (#265, per [#249](https://github.com/alp82/curia/issues/249)). The daemon journals `restart_requested`, answers, and then exits **75**. `restart: on-failure` in `deploy/compose.yaml` respawns it, and a clean exit deliberately does not. Agent panes live in the tmux container (#260), so they survive it.

## The verb catalogue (Discord slash commands, `POST /command`, or overseer prose)

The catalogue grew on #91. A repo argument is fuzzy everywhere it appears: any unambiguous part of a watched repo name resolves (`cur` works for `alp82/curia`); an ambiguous part refuses with the candidates.

- `tickets [repo]` — takeable tickets per watched repo (map lane with deferred-map skip and multi-map union, or flat `ready-for-agent` lane per watch-entry `mode`), plus the count of HITL-free tickets an agent can run alone. The slash/overseer name for the domain term "frontier".
- `next [repo]` — dispatch an agent on the first takeable HITL-free ticket.
- `start <n>` / `start [owner/]repo#<n>` (`model=x` optional — the harness follows the model, #177) — claim the GitHub issue, make the agent a private blobless clone under `workspace_root`, spawn the harness in a container from the tmux pane `curia-<n>` with a pre-seeded config dir (no first-run dialogs), watch for readiness. Anomalies (assigned/blocked/already-live) refuse with the way out — start never confirms (#89/#94).
- `map <n>` / `map [owner/]repo#<n>` (`model=x` optional, `<instruction>` optional) — dispatch a **charting agent** on a `wayfinder:map` issue (#160; the verb moved off `start` on #221). It edits the map and its child tickets, and that is all it does: it claims nothing, closes nothing and lands no branch, and curia refuses `open_pull_request` and `request_review` for it by name. The session `curia-<n>` is the lock, in place of the assignee a ticket agent takes. It ends on `report_result`, and curia posts that summary as a comment on the map. The instruction rides the spawn prompt rather than the note queue, so the agent reads it before its first tool call; with none, the agent's first act is an `ask_human` asking what should change. `wayfinder:map` routes like any other type label, through `defaults.map` in `routing.yaml`. An issue without that label refuses and names `start` as the verb that works a ticket; a closed map refuses and asks for a reopen. `start <n>` on a map number is **not** this verb — it dispatches the map's next takeable ticket. [ADR-0008](../docs/adr/0008-resolved-means-merged.md) records the deviation this ending stands on.
- `map [repo] [model=x] <prose>` — the same charting agent with **no map** (#241). The prose is mandatory here, because no map body states the effort instead. The repo token is optional while one repo is watched, and required past that — a number cannot name the repo when no map owns the number yet. The agent settles the destination with the operator, creates the `wayfinder:map` issue itself, and reports its number with `map_created`; curia checks the issue is an open map in that repo, then takes it as the session's map — the thread moves onto it, the summary lands there, and `map <n>` on it is refused while the session runs. `map_created` is a step, not the ending: this shape ends on `report_result` like the other one. The identity is a chat handle, below. On Discord, `/map` is the one slash command with no required option — a map number picks the first shape, an instruction alone picks the second, and neither refuses with both shapes named.
- `status` — live agents + tmux cross-check. Chat handles are listed beside ticket numbers.
- `resume <n>` (`model=x` optional) / `resume all` — fresh agent on a ticket, inheriting its surviving worktree and the model the dead agent last ran on, which the journal's `agent_spawned` states (#177). The harness follows that model, so a ticket that ran on gpt comes back on gpt. No spawn in the journal, or a model `routing.yaml` no longer carries, degrades to ordinary routing. `model=x` is the way out; `all` resumes every resumable ticket, each on its own inherited model, and takes no override. It also inherits the **exchange** (#374): every question a human already answered on that ticket rides the spawn prompt, so the operator is not asked twice. See _What an agent knows_ below.
- `cancel <n>` / `cancel all` — immediate teardown from a slash command or REST: kill session, remove worktree, unassign (re-frontier). The overseer's interpreted cancel instead posts a ✅/❌ button confirm (#94): instance-bound, no expiry clock, and it lapses the moment the agent exits. The confirm renders where the operator typed the command (#218). The button executes through the daemon, never through the model.
- `attach <n>` — `https://<tailnet-dns>:<serve_port>/?arg=curia-<n>` via the shared ttyd; `bin/curia-attach.sh` whitelists `^curia-[A-Za-z0-9._-]+$` (hard requirement — ttyd `-a` would otherwise hand out attach to any tmux session). ttyd also runs with `-O` (`--check-origin`): without it any web page open on any tailnet-connected device could hijack an agent's terminal cross-origin, since the victim's browser supplies the network position. What `-O` actually enforces (verified in ttyd's `src/protocol.c`) is `Origin == Host` — a same-origin *browser* control, not an allowlist: a mismatched `Origin` is refused at the WebSocket upgrade, but a DNS-rebinding page whose Host and Origin match each other passes. `-O` is kept, but it is no longer the control: see the identity check below.

**The chat handle (#241).** An agent that no issue answers for is named `chat-1`, `chat-2` — the lowest index free **on the box**, because a restarted daemon holds no agents map and tmux is the authority the dispatch locks already ask. The handle stands wherever a ticket number stands: the session `curia-chat-<i>`, the worktree, the thread, and the argument `attach`, `cancel` and `resume` take. `status` takes no argument and lists the handle beside the ticket numbers. A `resume` keeps the same handle, because the thread, the worktree and the journal epoch all answer to it — but a chat that already adopted a map refuses the resume and points at `map <that number> …`, which is the verb for a map that now exists. There is no lock on a handle, so several of these run at once, each in its own thread. Today the new-map dispatch is the only kind of agent that gets one.

- `review <n>` (`model=x` optional) — the cross-check (#164, [ADR-0010](../docs/adr/0010-the-cross-check.md)): spawn a reviewer on the OTHER provider, let it read the pushed diff, and capture its verdict. The pairing comes from `review:` in `routing.yaml` — an anthropic builder gets `gpt`, an openai builder gets `opus` — and a `review-model:<name>` label on the ticket beats it. With every model on the other provider cooling it runs on the builder's own and stamps the verdict "same provider — cross-provider was cooling". The reviewer is a full agent: its own tmux session `curia-review-<n>`, its own status line in the ticket thread, attachable through `attach <n>`, sandboxed like any agent. It writes nothing — curia refuses `open_pull_request`, `request_review`, `publish_preview` and `ask_human` for it by name — and its `report_result` summary lands as `data/verdicts/<n>.json`. This verb is the daemon-side entry point over `POST /command`; the operator's own surface is the third button below.

## The dashboard sidecar (#263, per [#249](https://github.com/alp82/curia/issues/249))

The console is a **separate process**, `bin/curia-dashboard.mjs`, in its own compose service. It stays up while the daemon restarts, which is the whole reason it is not a daemon surface: the restart becomes a marker on the page instead of a dead tab.

- **Ports.** Loopback `dashboard.port` (4273), published on `dashboard.serve_port` (8445). Both join the collision check and `previews.reserved`, so the daemon refuses to boot on a shape that would let one surface shadow another, and no preview can be allocated over the console.
- **Secret-free.** Its container mounts `daemon/src`, `daemon/bin`, `daemon/assets` and `config/`. It never mounts `daemon/.env` or `daemon/data/`, so it holds no Discord token, no GitHub token and no journal handle. `node_modules` is baked into the image for that reason.
- **The gate.** The sidecar is its own HTTP server, so it applies `identityRefusal` in-process exactly as the timeline does, on the same `identity.allow` list read with the same rule. It asserts its own Serve rule at boot and re-asserts it every minute. A listener that is not up, a page whose proto stamp it does not speak, or a tailnet name it cannot resolve **withdraws** the rule instead of publishing it.
- **The read.** One loopback `GET /overview`. A failed read never costs the snapshot: the page keeps the last reading, states its age and names the reason.
- **The one read that is not the poll (#355).** `GET /api/diff` proxies the daemon's own `/diff`. It is the diff digest and, per file, the hunks. The page names a review gate or an agent, and a file only by its place in the digest curia measured — no path, no repo, no branch and no command crosses this wire, the same seam every verb below sits on. A gate's numbers already ride `/overview`, so opening that card costs nothing; the hunks cost one git call each, once, when the operator opens a file.
- **The write (#265, #292).** `config/` is the sidecar's only read-write mount, and the settings screen is the only thing that writes it. It writes the OVERRIDE files — `curia.local.yaml` and `routing.local.yaml` — and never the tracked ones, because git tracks those and a save would leave the box's checkout dirty for the next fast-forward. `POST /api/settings` edits the override through the yaml **document** API, so every hand comment survives; keeps only what differs from the tracked file, and removes an override that comes to hold nothing; validates the candidate with `loadCuriaConfig`/`loadRoutingConfig`, the same functions that decide whether the daemon boots; and renames it over the real file only after every candidate passes. A refused save answers 409 with the loader's own message and leaves both files byte for byte as they were. `checkPaths: false` is the one rule turned off: four loader checks ask about paths this container does not mount, and no key the screen writes can reach them. `POST /api/restart` orders the daemon's own `POST /restart`.
- **The second gate on a write.** The identity header proves whose browser a request is, never which page told it to call — Serve stamps the operator's login on a `fetch` from any origin. So a POST must also carry an `Origin` this surface answers to, and any `Sec-Fetch-Site` other than `same-origin` is refused. The sidecar composes its own call to the daemon from a route it names in code and forwards no browser header, which is what keeps it on the daemon's side of that gate.
- **The poll.** `dashboard.poll_interval_s` (5) is a ceiling, not a clock. The sidecar re-reads only when a page asks and its snapshot is older than that, so many tabs cost one read and a hidden tab — which stops asking — costs none. One read costs no journal read at all (#289): what the overview says about the recent past is reduced in memory as events are written, so the price of a poll does not rise with the history.
- **The page.** `assets/dashboard.html`, carrying the `curia-dashboard` proto stamp #70's rule requires. The read screens landed on #264 and the settings on #265. The verbs land on #266, the chat on #267, and the diff digest on #355.
- **The chat, and the picker in front of it (#267, #333).** The console draws no chat of its own. It pipes `/chat`, `/events`, `/send`, `/draft` and `/key` straight to the daemon's timeline, headers unchanged in both directions, so the timeline applies the #151 check to the evidence the browser actually sent. What the console DOES draw is the Chat screen: the picker over the browser conversations of [ADR-0016](../docs/adr/0016-the-conversation-key.md). It reads `GET /api/console` on arrival rather than on the poll, because a row costs the daemon a transcript read and the other screens have no use for it. Each row carries the conversation's own context percent, which ADR-0016 makes the one signal that a conversation is getting long. `POST /api/console/new` mints one and `POST /api/console/delete` forgets one. Neither is a verb: the operator catalogue has no word for a browser conversation, so there is nothing for `/command` to carry.
- **The save banner.** Two phases, at the top of the settings screen. Save writes the file. The daemon goes on running the config it booted with, and the banner says so until the restart — which is the loud button in phase two — applies it.

### The identity check (#151, [ADR-0011](../docs/adr/0011-tailscale-identity-in-front-of-every-attach-surface.md))

Both attach surfaces refuse a caller Tailscale Serve did not stamp. Every request — read and write — must be a non-Funnel request, carry a `Host` this box answers to on that serve port, and carry a `Tailscale-User-Login` on the `identity.allow` list in `curia.yaml`. Measured on the box: Serve injects that login, **overwrites** it when a client forges it, and carries it on the **WebSocket upgrade**; Serve does **not** sanitize `Host`, which is why the name allowlist exists. Full transcript in [docs/live-checks/151-attach-surface-auth.md](../docs/live-checks/151-attach-surface-auth.md).

ttyd is a C process with nowhere to put a check, so the terminal's Serve rule points at a daemon-owned loopback proxy (`identity.proxy_port`, default 7682) which reaches ttyd. The timeline is the daemon's own server and applies the same predicate in-process. The check fails closed: an unresolved host set, a missing allowlist or a surface wired up without a check refuses everyone. Reconcile withdraws the terminal's rule when the proxy is down, rather than leaving it pointed at un-gated ttyd. `identity.allow` is required — the daemon refuses to boot without it.

Not covered, deliberately: loopback on this box (anything here reaches ttyd and the timeline directly and can set any header — already inside the trust boundary), and preview rules.

## The cross-check button and the verdict's way back (#165, [ADR-0010](../docs/adr/0010-the-cross-check.md))

The review gate carries a third button, `🔎 Cross-check`, beside approve and reject. It is pressable on every gate round. It is a button on the [ADR-0005](../docs/adr/0005-escalation-contract.md) contract, not a new escalation kind: the record is still a `review-gate`, and the press is an answer of the literal word `cross-check`. So `request_review` is no longer a two-way answer.

**The press does not end the gate call.** The builder stays inside `request_review`, idle, holding its claim, its worktree and its slot, while the reviewer reads — the cost ADR-0010 names is two slots against `max_concurrent`. It has to stay: an operator note rides a **tool result**, and an agent that has stopped makes no tool calls, so there would be nothing to wake. `/status` and the status line say `cross-checking` rather than `working`, and the Stop hook reads a parked builder as blocked, never as finished.

**The way back**, when the verdict lands, in this order:

1. curia posts the verdict as a **pull-request comment** ([ADR-0001](../docs/adr/0001-github-is-the-only-durable-state-home.md)). It goes on the pull request rather than the ticket, because it is a reading of a diff. This runs even when no builder is left to read it.
2. The verdict goes onto the builder's **note queue**, labelled `cross-check verdict` so it never reads as words the operator typed, and stamped with the builder's instance per #208.
3. The parked gate call returns, and the drain appends the note to that same tool result.

**The builder's duty** is in its standing orders and in that return text, from one source (`CROSS_CHECK_DUTY` in `lifecycle.mjs`): judge every finding, agree or disagree, write one summary with a recommendation, and send it with `ask_human` — a plain question, never a gate. Act only on the operator's answer, then return to the review gate as a pure approve-or-reject. A finding beyond this ticket's scope becomes a charting line in that gate, and the builder opens no fault ticket by itself ([ADR-0006](../docs/adr/0006-worker-containment-and-standing-orders.md)).

curia posts that question as the **second** pull-request comment, under the verdict. It holds both texts already — it spawned the reviewer, and the judgement is the escalation prompt — so no agent write bound widens. The first question after a verdict is the judgement; the artifact carries a `judged` mark, so a later question is an ordinary question and a fresh cross-check opens it again.

A cross-check that produces **no** verdict — the reviewer died, its respawn failed, it was cancelled — releases the builder back to the gate with that fact. Every one of those paths goes through `#releaseClaim`, `#reviewerDone` or `#teardownReviewer`, and each settles the wait: a builder parked forever on an agent that is already gone is the one failure a cross-check must never cause.

## Overseer conversations (#92/#93/#94/#95, cut over on #315)

Every `#curia` thread is one persistent conversation with the overseer, and the browser holds many of its own ([ADR-0016](../docs/adr/0016-the-conversation-key.md)). A top-level prose message opens a thread and a fresh conversation. A later message in any thread revives it with full memory. Slash commands stay deterministic and never touch the model.

The turn runs in the overseer container, not in this process. `overseerclient.mjs` is the daemon's whole reach into it, and the section below says how the turn crosses. The daemon keeps the conversation state. The key-to-session-id map is a reduction over the journal, so a daemon restart loses no conversation. The old in-daemon host, `overseer.mjs`, is deleted, and with it the Haiku-first model pick and its Sonnet retry.

The container is the containment ([ADR-0014](../docs/adr/0014-the-overseer-in-its-own-container.md)), and `overseerclient.mjs` carries that comment at its head. The model holds a reading shell and a read-only GitHub token in there, so a tool list is no longer the whole boundary. What still holds is the seam. The model's only curia tools are the eight verbs, served over the daemon's own MCP side channel, and each call composes canonical verb text in the daemon and posts it to `gate.command`. That is the same seam the slash verbs and REST use, journalled and routed the same way. `review` is not one of the eight, because the operator's surface for it is the gate button. The model never answers an escalation or a review gate, which is the never-list in its standing orders (#328).

An interpreted `cancel`/`cancel all` does not execute: the daemon posts a ✅/❌ button confirm (#94) — instance-bound, no expiry clock, lapsing the moment the agent exits, a newer confirm superseding an older one. The confirm renders where the operator typed the command, and in the command channel when the command carried no thread (#218): it is addressed to the operator, not to the ticket conversation. Each target's ticket thread gets a pointer to the buttons. Every other kind, the review gate included, keeps the ticket thread. The button executes through the daemon, never through the model. Outcomes that resolve between turns come back to the conversation as journalled notes on its next revival, so its memory stays honest.

Each turn posts exactly two messages (#95): one small-print progress line, edited in place as tool calls land, and one short answer. `messaging.mjs` holds the standard — the seven signal emoji, `<>`-wrapped links, "N more" clamps — and its lint runs in the tests. Ticket↔thread bindings (#93) route an agent's escalations into the thread that started it, rename the thread to a display-only `🎫 <ticket> · <type>` — the `wayfinder:` type replaces the old thread name — and release on terminal states plus a reconcile sweep. A release swaps `🎫` for `✅` and keeps the rest, so a finished ticket still reads as itself in the thread list.

The build was verified live by the full-loop rehearsal — `docs/live-checks/96-overseer-rehearsal.md` — including two daemon restarts mid-pass.

### The same turn, in the container (#314)

The overseer runs in its own container (ADR-0014), and the turn crosses that boundary in two hops. The daemon posts one message to the container on `POST /turn`, and the container streams events back as NDJSON: the session id it stated, the checkout verdict, then the answer. The model's verb tools reach the daemon the other way, over `/overseer/mcp`, so the daemon still composes every canonical text and posts it to `gate.command`. The confirm on `cancel`, the interpreted flag, the journal and the thread binding are all unchanged, because that seam is unchanged.

The transport for the verbs is MCP rather than a route that takes canonical text, and that is what keeps the seam narrow: a text route would hand the container the whole router, and a tool call hands it eight verbs with validated arguments. `overseerverbs.mjs` holds the one catalogue both transports publish.

What each side owns: the daemon keeps the conversation (`store.overseerSession`), the one-turn-at-a-time rule, the operator notes and every effect. The container keeps the model, the shell, the checkouts and its own two directories under `<workspace_root>/cfg/curia-overseer`. The container holds no conversation, so a deploy that recreates it loses none.

The model there is `claude-sonnet-5` and there is no fallback: Sonnet IS the model, where the in-daemon host tried Haiku first. A turn the container never answers is a failure the operator reads.

### The turn a restart killed (#388)

The routine deploy recreates the daemon and the overseer together, so both halves of a turn in flight die at once. ADR-0015 says that turn is sent again, never retyped, and `overseerreplay.mjs` is that pass.

The message lives in the journal: `overseer_turn_started` carries it and `overseer_turn_ended` closes it, so whatever is open at a boot is what the restart killed. The seam crossings ride the `command` event the daemon already writes, which now carries the conversation key — the in-memory tally dies with the process holding it. The pass reads that list once, before the listener binds, and waits for the container health check.

It sends the message again only for a turn that crossed the seam zero times. Three more things hold it: a message curia already sent again once, a conversation that has spoken since the boot, and a message over fifteen minutes old. Every held message leaves one line naming what that turn ran. A Discord conversation reads it in its thread. A browser conversation has no thread, so it reads it on its row in the Chat picker until it takes its next turn.

**Both surfaces route here since #315.** The cutover was one swap at two doors: the bridge's `overseerTurn` and the Chat screen's `driverFor`. The soak door `POST /overseer/turn` is gone with it, and real operator chat took its place.

## The per-agent status line (#108 item 8, #146)

Each agent gets one Discord message in its ticket thread that says what it is doing now: dispatched, working, waiting on an escalation, awaiting review, cross-checking, executing approved writes, or resolving. `statusline.mjs` builds it from the journal's own events through the reduction's append hook, so no transition needs a callback threaded through the dispatcher. The daemon composes every string. Agent text never lands here as it was written. A state change deletes the message and reposts it at the thread bottom (item 17). Everything else edits it in place.

The line carries LIVE state only (#253, [ADR-0013](../docs/adr/0013-one-voice-per-fact.md)). A terminal event deletes the line. It does not draw a last state onto it. The terminal events are the ending, an abnormal exit, a death, a cancel, and a watchdog failure. Each one already carries its own CuriaBot message, and a 🏁 beside that message narrated one event twice.

Since #146 the line also carries **meters** beside the state:

```
▶️ `curia-49` · working · **opus** · ctx 88% · **5h** 🟥 ▓▓▓┃███░░░░ 62% · **7d** 🟩 ▓▓▓▓░░░░┃░░ 41%
```

| Meter | Source |
| --- | --- |
| model and reasoning effort | the routing pick, and `models.<name>.reasoning_effort` |
| context percent | the agent's own transcript tail, over the model's context window |
| 5 h / 7 d usage bars | the codex transcript's `rate_limits`, or the anthropic rate-limit response headers |

Each meter has its own source and drops alone when that source is silent. A model with no window from any source shows no context figure at all. A guessed denominator would render as a confident wrong percentage, which is worse than a missing number.

The codex harness states all three numbers itself, on the `token_count` event it writes after every turn. The claude harness states the token counts and the model, so the window is looked up and the usage bars come from the account.

The context denominator takes the best source that has one (#178): the window the transcript states, then `max_input_tokens` from `GET /v1/models/<id>` for the model id the claude transcript names on every turn, then `models.<name>.context_window` in `config/routing.yaml`. Config comes last because it is the source that goes stale — #146 wrote 200000 there for a harness whose real window is 1000000, and nothing on the box could notice. The lookup is metadata, spends no quota, and is cached for a day per model id. The figure is never clamped: above 100% it renders at its real size with a ⚠️, because a request cannot exceed its own window and the excess is proof the denominator is wrong.

Getting the claude account numbers takes one small trick (#162). The OAuth usage endpoint answers only a credential from an interactive `claude /login`, which a server does not have, so the daemon reads the same two windows off the `anthropic-ratelimit-unified-*` headers that ride every accepted completion. It takes one minimal completion for those headers, at most once every ten minutes, using whatever credential the box already authenticates with. See ADR-0007 for the rules that bound the probe, and `usage.account_bars` in `config/curia.yaml` for the switch that stops it.

### Reading a usage bar

A usage bar carries two numbers, not one. `┃` marks how far the window's own clock has got. Every filled cell **left** of it is spending already earned. Every filled cell **right** of it renders solid `█` — that is overshoot, spending the window has not paid for yet.

The square is the same fact as a status light: 🟩 behind the clock, 🟨 on it, 🟥 ahead. It reads **pace**, not raw usage, because raw usage cannot tell 92% with the window nearly over from 40% in the first hour. The thresholds match the operator's own `statusline.sh`, so the terminal and Discord agree on what burning too fast means.

Both need a reset time. Without one there is no clock, so the bar falls back to a plain fill and the square is dropped. A window whose reset has already passed is dropped whole, because the percentage beside it describes a window that no longer exists.

### Fitting one line

Groups are separated by `U+2003 EM SPACE`, not two plain spaces — Discord collapses a run of ASCII spaces.

The line is composed against a budget counted in **rendered columns**, so markdown syntax costs nothing and an emoji costs two. Meters append in value order and the first that will not fit ends the run, so they drop from the tail. A full working line measures 86 columns and always survives whole. A `waiting` line carrying a long escalation title loses the bars first, which is the right thing to lose: an agent blocked on a question is burning no quota.

A meter tick refreshes the live lines once a minute and edits only when a number moved, so a quiet agent costs no Discord call.

## One event, one message (#253, [ADR-0013](../docs/adr/0013-one-voice-per-fact.md))

Three events used to speak twice or more. The cold read of 131 threads counted them in `docs/research/discord-thread-surprises.md`, sections 3 and 4. Each one collapses to one voice.

- **The ending is two messages, in this order.** First comes the agent's report, in the `curia-<n>` webhook voice. It says what the work came to. The daemon appends the pull-request link to it, because that report is the one place the link unfurls. Then comes one CuriaBot receipt, in small print. It merges the old resolved, done and finished lines into one sentence: what the tracker step did, then what the session teardown did. Every url in it is wrapped in `<>`, so the same GitHub embed never renders twice. The tracker sentence rides its own journal event (`ticket_resolved.summary` and its siblings). A restart between `report_result` and the Stop hook does not silence the ending.
- **The spawn is CuriaBot's line alone.** The composer-ready message announces the dispatch. The overseer never narrates a dispatch it triggered. The overseer owns the CHOICE, so it may say which ticket it picked and why. It says nothing about the agent's state.
- **A button answer is the card.** The bridge acknowledges the press silently and edits the card in place. No interaction reply follows it. The mark on the card carries what the reply used to add. That includes the dead ids a routed answer came through.

## Preview links (#40, implementing #8)

The agent runs its dev server on localhost and calls `publish_preview(dev_port, path?)`; the **daemon** allocates an HTTPS Serve port from `preview.port_from`–`port_to` (config, default 8500–8599) and asserts `tailscale serve --bg --https=<port> http://127.0.0.1:<dev-port>`, returning `https://<box>.<tailnet>.ts.net:<port><path>`. Many previews run in parallel — the 443/8443/10000 cap is Funnel-only.

`path` (#68) is the page to look at, and it rides the preview **record**, so the review gate and the `🔗 preview` notify both render it and it survives a re-ask. Without it the link opens the site root, which is how #65 sent three review gates to an untouched homepage. It is a display suffix on a rule that already proxies the whole dev server, so it grants no new reach — but it must not move the link off this box, so a path is resolved and anything that changes the origin is refused: `//evil.com/x`, `https://evil.com/x`, `\evil.com/x`, and `box.ts.net:8500/x`, which parses as a scheme. Re-publishing the same dev port with a new path **moves** the link rather than returning the old one, because correcting a wrong link is why the call is made twice.

The agent never picks the public port, because `tailscale serve` will publish **any** localhost port to the whole tailnet and the daemon's own API is a localhost port. The registry is where that is contained: curia's own surfaces (daemon port, ttyd port, attach Serve port) are refused outright — publishing the daemon port would put `/answer`, `/command` and `/escalate` on the tailnet unauthenticated — and the dev port must be a **live** listener, so a rule can never be pointed at a port something else may bind later. Config validation also refuses a preview range containing `attach.serve_port`, which the sweep would otherwise withdraw.

Lifecycle: the rule is withdrawn when the ticket ends — clean finish, result-less exit, or `/cancel` — and reconcile sweeps anything in range that no live `curia-<n>` session claims. That sweep is the only thing that can see a rule left by a **previous** daemon process, since `tailscale serve --bg` config lives in tailscaled, not here; an indeterminate `serve status` skips the sweep rather than reading as "no live tickets" and withdrawing previews under review.

Verified live: refusals for all three curia surfaces and for a dead port; an agent that started its own dev server, published it, and had the page load **on the phone** over the tailnet; a second concurrent preview taking the next port; both sweep branches (kept while its session lives, withdrawn once nothing claims it) with the attach rule untouched throughout. Previews still carry the tailnet-membership-only posture: #151 gated the attach and timeline surfaces, and did not reach previews. An agent's dev server is published to the whole tailnet with no identity check.

## The agent's GitHub authority (#155, cut over by #389)

**An agent mints its token now.** [ADR-0018](../docs/adr/0018-the-daemon-is-a-github-app.md) replaced every PAT with one GitHub App, and the agents are the first holder to move. What the daemon hands an agent is a per-agent `gh` config dir it rewrites, and the container environment carries `GH_CONFIG_DIR` — a path, never a secret. The rest of this section is what the PAT did, and it stays because the PAT is still the fallback: a box with no app, or an owner the app is not installed on, keeps every word of it. See [the minted token](#the-minted-token-389) below.

An agent used to reach GitHub through the host's `~/.config/gh/hosts.yml` login, which is the whole account: every repo, every scope. It then got a scoped fine-grained PAT as `GH_TOKEN`, which `gh` prefers over `hosts.yml` natively, so every wayfinder operation keeps working with no code that knows the token exists.

**One token per resource owner.** That is what a fine-grained PAT is: the creation form has a single resource-owner dropdown, and the watch list spans `alp82` and the `getalfredo` org. So the key carries the owner and the daemon picks by the ticket's own repo. An owner with no key keeps the inherited host login, and the daemon says so at boot with a `WARNING` naming the missing key.

The permissions are **Contents**, **Issues** and **Pull requests** read/write, plus **Commit statuses** read so `gh pr checks` answers. Nothing else. The rule is grant content, never execution or persistence: Secrets, Variables, Webhooks, Workflows, Environments and Actions-write each hand a compromised agent either a way to run code or a way to keep reach after it dies.

The daemon is deliberately **not** on this token. Its own `gh` keeps the host login, because it must reach every watched repo, and a repo added to `curia.yaml` but left off a token would break dispatch with no signal. A bare `GH_TOKEN` in `.env.daemon` would re-authenticate the daemon too, silently, by sitting in its environment.

The value is read at boot, so a quoted or padded token refuses the boot instead of reaching an agent as a 401 mid-resolve. Boot also asks GitHub once per watched repo, with the token that repo's agent would get, and warns when the token cannot reach it or expires within 14 days. An expired token does not degrade to the host login. It fails every `gh` call, so the warning is the whole defense.

That probe has one blind spot, measured rather than assumed: **a public repo left off the token's selection cannot be detected by any read.** Every fine-grained PAT reads public repositories, and the repo payload's `permissions` object describes the underlying user rather than the token grant — the `getalfredo` token reports `push: true` on `alp82/curia`, which it cannot possibly write. A private repo outside the selection does answer 404, and that is the case the probe catches. There is no harmless write, so no write probe runs at boot.

Note for org repos: an organization can cap fine-grained PAT lifetime, and `getalfredo` caps it at 366 days. So an org token cannot be permanent, and its expiry is a calendar item until the GitHub App lands. The full transcript is in [docs/live-checks/155-agent-github-token.md](../docs/live-checks/155-agent-github-token.md).

## The minted token (#389)

The shape this section predicted is the shape that shipped: a per-agent `gh` config dir the daemon rewrites, which `gh` re-reads on every call.

**No token in the container environment.** The env carries `GH_CONFIG_DIR=/cfg/gh` and nothing else about GitHub. The daemon writes `<workspace_root>/cfg/curia-<n>/gh/`, which is inside the config dir the container mounts, so an agent reads its own credential and no other's.

**One file, both tools, no shim.** `gh` reads `hosts.yml`, and git reaches GitHub through `credential.helper = !gh auth git-credential`, which is already set on every clone. The username git gets is `x-access-token`, the same one `GH_TOKEN` yields today.

**Two files, and both are load-bearing.** `config.yml` states `version: "1"` and `hosts.yml` carries a `users:` block. Without them `gh` runs its multi-account migration, which calls `GET /user` — a 403 under an installation token — and then refuses every command with `cowardly refusing to continue`. It also rewrites the file, which would take it out of the daemon's hands. With them `gh` makes no API call at all. Measured in [docs/live-checks/389-agent-minted-token.md](../docs/live-checks/389-agent-minted-token.md) and re-taken by `test/agentgh.test.mjs` on every run of the suite.

**The refresh rides the dispatch tick**, every 60 s, above the `auto_dispatch` gate — a token dies in an hour whether or not this box dispatches anything new. The minter serves its cached token until ten minutes before the hour, so the value turns over about every fifty minutes and GitHub sees one call per owner in that time. Reconcile refreshes as well, so an agent adopted by a restarted daemon does not run on a token that expired while the daemon was down.

**The file is the evidence.** An agent on the PAT has no credential file, and one on the app has the file its own spawn wrote. So the refresh needs no memory of which agent minted, and an adopted agent costs nothing to place.

**A reviewer gets the READ set.** A cross-check reviewer reads a detached checkout, writes nothing, and curia posts its verdict for it (ADR-0010). One key and two sets is what the app bought.

**The commits read as the bot.** An agent on the app commits as `curia-sh[bot]`, from the app's own slug and the bot user's id. An agent on the PAT keeps this box's git identity, because a PAT push by the operator with a bot author on it would say two different things about one commit.

**The teardown is the config dir's.** `removeCredentials` takes the directory, so every ending collects it — including the two that keep the workspace for a post-mortem, and the reconcile sweep that finds a config dir whose session is gone.

**A mint that fails falls back**, loudly, to `CURIA_AGENT_GH_TOKEN_<OWNER>`. A box with no app, an owner the app is not installed on, and a GitHub that could not be reached all read the same way. Refusing the dispatch would take a working boundary out ahead of its replacement, which is the one thing ADR-0018 says not to do.

## The overseer's GitHub authority (#313, cut over by #392)

The overseer container holds a shell. The read-only token is the control that replaces the `/command` seam, because a standing order cannot hold a shell and a shell cannot mint a token. See [ADR-0014](../docs/adr/0014-the-overseer-in-its-own-container.md).

The permissions are **Contents**, **Issues**, **Pull requests** and **Commit statuses** at read, plus **Metadata** read. Nothing at write, and nothing else at all. Agents write, and they write through pull requests. #313 bought that set as one fine-grained PAT per owner. #392 mints it instead, from the one app key, as `READ_PERMISSIONS` in `src/githubapp.mjs`. The set did not change.

**One file per resource owner**, named by the owner in lower case, at `<workspace_root>/overseer/tokens/<owner>`. The daemon writes it at mode 0600 through a rename, and the container mounts the tree read-only. That tree holds the tokens and nothing else.

**The daemon mints, and the container reads a file.** There is no endpoint the container can call: a shell that can mint is the capability ADR-0014 removed, and that is the whole boundary. The refresh rides the dispatch tick, every 60 s, above the `auto_dispatch` gate — an installation token lives one hour and this container answers the operator whether or not the box dispatches anything. Reconcile refreshes too, because that container was not restarted with the daemon.

**Both tools read the file at the moment they need it.** `gh` reads one `GH_TOKEN` and the container holds one token per owner, so something must pick. git picks by itself: one `credential.https://github.com/<owner>.helper` line per owner, whose helper prints the file, because git prefix-matches the owner path (measured). `gh` takes a shim that reads the owner off the command line or off the checkout directory name, then reads the same file. So a token the daemon rewrites takes effect on the next call, with nothing restarted.

**Nothing is held from the container's boot.** The watch list is re-read per turn, the routing is rewritten per turn (#361), and the token is a file. Watching a repo of a brand new owner is an ordinary save: no env file edited, and no service recreated. That was the last limit a turn could not re-read.

**An owner with no installation reads public repositories only.** It gets no token file, so it gets no credential rather than another owner's. The container names that owner in the chat, once per turn, through `unroutedNote` — the one sentence the boot log and the turn share. The daemon's boot names it too, beside the app installations it can see.

`CURIA_OVERSEER_GH_TOKEN_<OWNER>` is retired. A key still sitting in `daemon/.env.overseer` is a live PAT with no job, so boot names it and asks for two acts: delete the key, and revoke the token on GitHub. What is left in that file is the model credential, which is the one host secret ADR-0014 lets into that container. The daemon parses that file and never loads it into its own environment. A bare token in the daemon environment would re-authenticate the daemon's own `gh`, which is the trap #155 named.

The transcripts are [docs/live-checks/313-overseer-github-token.md](../docs/live-checks/313-overseer-github-token.md) for the routing and [docs/live-checks/392-overseer-minted-token.md](../docs/live-checks/392-overseer-minted-token.md) for the cutover.

## What an agent knows (#57)

`seedConfigDir` symlinks the configured skills into `<CLAUDE_CONFIG_DIR>/skills/`, so an agent resolves in the same idiom a hand session does instead of being told about skills in its prompt (#49). Config is `skills.root` + `skills.install` in `curia.yaml`; the default list is `wayfinder`, `grilling`, `domain-modeling`, `research`, `prototype`, `implement`, `tdd`, `code-review`, `diagnosing-bugs`. The charting-and-PM skills (`to-tickets`, `triage`, `to-spec`, `handoff`) are withheld — `to-tickets` is mass ticket creation in the hands of an agent that carries charting authority.

Two of the nine — `wayfinder` and `implement` — carry `disable-model-invocation: true`: on the **claude** harness they are not listed to the model and its Skill tool refuses them (`cannot be used with Skill tool`). Installing them is still required, because a prompt whose **first line** is `/wayfinder` does load the skill (verified live), while naming it in prose does not. That is a constraint the spawn prompt must satisfy (#54).

The **codex** harness spells the same line `$wayfinder` (#173). That frontmatter key is claude's and does not travel: codex lists every installed skill with its path, and it states its own trigger — naming a skill with `$SkillName` means "you must use that skill for that turn" and "read its `SKILL.md` completely before taking task actions". The rule reaches every codex model, by `base_instructions` for the gpt-5.6 family and by an appended `### How to use skills` block for the older ones (measured, `docs/live-checks/173-codex-skill-load.md`). So `writePrompt` takes the harness, and a fallback that crosses providers writes the prompt again for the harness it lands on.

Symlinks, not copies: an agent never writes a skill, so the version tracks the host with no snapshot to go stale — the opposite of the credential case (#53), where the agent *does* write and a symlink was replaced by a regular file. The links are rebuilt on every seed, so a reused config dir keeps no skill that has left the list. A name in `install` that has no `SKILL.md` under the root **refuses the boot**, naming the path: an agent that silently lacks a configured skill is the failure this replaced. Nothing else comes from the host — no `CLAUDE.md`, no allowlist, no MCP connectors, no saved permission mode (#23/#29).

The prompt also carries the **inherited exchange** (#374, decided at [#344](https://github.com/alp82/curia/issues/344)). It is every question a human has already answered on this ticket, question and answer both, written into the parameters under "What curia already did". A prior answer IS a parameter of this dispatch. Before it, `resume` gave a fresh agent the worktree and the model and none of the words. So the operator answered the same question twice, and paid the wait twice. It is a **push**, not a pull. No new tool, no query language, and no agent guessing what to search for. The store already holds the records, and a builder session is `curia-<n>` for the ticket's whole life. One key therefore reaches every dispatch the ticket has had. The operator settled seven rules on 2026-08-16:

1. It reaches every dispatch, not only the dead agent.
2. It carries the question and the answer, both verbatim.
3. A cancelled, lapsed or superseded record does not appear, because it holds no answer.
4. Every kind rides along, the review gate included. A gate rejection is the operator's own instruction.
5. The caps are 2000 characters per field and 16000 for the block. The newest survive, and one line names what was dropped.
6. The agent is told the words are recorded rather than fresh.
7. It runs on every dispatch. A first one has no records and gets no block, so `resume` needs no branch of its own.

An answer's images travel as a count. #34 hands the images themselves to the agent that asked, and a path into the daemon's own disk would be a dead link inside a container.

Dispatch also asserts the tracker prerequisite: a **map child** whose worktree carries no `docs/agents/issue-tracker.md` is refused before the claim is kept, because the wayfinder skill would follow its own instruction to fall back to the local-markdown tracker and write `.scratch/` files instead of resolving on GitHub. A plain `ready-for-agent` ticket invokes no such skill and still dispatches — the flat lane watches *any* plain repo (#10) — with a `tracker_doc_missing` journal line.

## State posture

`data/events.db` is the only durable artifact — the journal, a `node:sqlite` database whose rows are append-only; in-memory state is a pure reduction over it, rebuilt on boot. Open escalations survive daemon restarts with their Discord message ids intact (the rebooted process still honors clicks on messages posted before the restart — verified live). The pending-resolver map is ephemeral (#9); ticket→thread bindings live in the journal (#93); a restart loses only the in-process agent call (accepted re-dispatch posture, #11/#12). The reduction reads the journal whole exactly once, at boot, page by page. Every append after it passes the same reducer, so a surface that answers about the recent past reads the reduction and never the journal (#289). The dispatcher still reads every row for the epoch questions reconcile and the Stop hook ask.

The daemon owns the only write connection, and it runs WAL with `synchronous=full` (ADR-0017). `src/journal.mjs` holds the schema, the writer and the migration. Every other process opens the journal read-only.

Supersede (#29): a re-issued `ask_human` (same agent + same payload while an older escalation is open) closes the old record, strips its buttons in Discord, and routes late answers to the live successor.

### Reading the journal

The journal is a `node:sqlite` database ([ADR-0017](../docs/adr/0017-the-journal-is-a-queryable-store.md)), and the JSON lines have retired. The database IS the journal, because the name follows the record and not the medium ([#358](https://github.com/alp82/curia/issues/358)). Curia builds no reader. It writes no text file beside the journal, and it ships no command-line wrapper. The operator opens a read-only SQLite shell and types SQL. The decision is [What stays greppable (#320)](https://github.com/alp82/curia/issues/320), and the column names below are the requirement it put on the schema, [#321](https://github.com/alp82/curia/issues/321).

Open the shell:

```sh
docker compose -f /home/alp/curia/deploy/compose.yaml run --rm --no-deps daemon \
  sqlite3 -readonly -box /home/alp/curia/daemon/data/events.db
```

Two flags carry a reason. `--no-deps` is required, because a compose command that recreates the `tmux` service kills every live agent. `run` and not `exec`, because `run` still works while the daemon is down, and that is when a post-mortem happens.

The image carries `sqlite3` since [#409](https://github.com/alp82/curia/issues/409), because the ADR-0017 backup needs it and this shell is the operator's whole read surface. The agent image carries it too, because the daemon suite runs there. The host copy is not used. Ubuntu 20.04 packages SQLite 3.31, which cannot open a STRICT table. Debian 12 packages 3.40, which can.

Five queries answer most of what the old `grep` answered:

```sql
-- what happened to one ticket
select ts,type,ticket,agent from events where ticket=320 order by id;

-- the last thirty events
select ts,type,ticket,agent from events order by id desc limit 30;

-- one whole line, exactly as curia wrote it
select body from events where id=4711;

-- the census, by type
select type,count(*) from events group by type order by 2 desc;

-- how one agent ended
select ts,type,body from events where agent='curia-320' order by id desc limit 10;
```

`tail -f` has no equivalent in SQL, so the live watch is a poll:

```sh
watch -n2 'docker compose -f /home/alp/curia/deploy/compose.yaml exec -T daemon \
  sqlite3 -readonly -box /home/alp/curia/daemon/data/events.db \
  "select ts,type,ticket,agent from events order by id desc limit 30"'
```

`exec` here, and not `run`. A dead daemon produces nothing to watch.

Two facts make this work.

- **A read-only reader opens a hot WAL.** Measured for #320: a writer killed mid-write left a `-wal` and a `-shm` behind, and a read-only connection then read every committed row back. It fails only when the data directory is not writable and no `-shm` file exists. Curia's data directory is writable, so a crash does not lock the operator out.
- **The columns carry today's spelling, and `body` carries the line as written.** [#184](https://github.com/alp82/curia/issues/184) renamed the worker to the agent, and older lines still spell it `"worker"`. The schema normalizes on the way in, so `where agent='curia-170'` finds those lines too.

### The migration to the database

[The migration (#323)](https://github.com/alp82/curia/issues/323) rules how the journal file becomes `data/events.db`, and [#407](https://github.com/alp82/curia/issues/407) shipped it in `src/journal.mjs`.

**The daemon converts at first boot.** It finds `events.db` absent, reads the journal file whole, and inserts every line in one transaction. It builds `events.db.migrating`, checks that the row count matches the line count, and renames the file into place. It accepts exactly what the old boot pass accepted: a blank line is skipped, and anything else that is not one JSON object stops the boot. The measured cost is 298 ms for the 4,282 events the box held on 2026-08-13 ([#321](https://github.com/alp82/curia/issues/321), `prototypes/journal-schema/results.json`).

A conversion that fails needs no hand. The daemon crash-loops, the self-deploy health check fails, and the box resets to the previous ref. That daemon still finds a whole journal file.

**The journal file stays where it is.** The migration does not rename it and does not delete it. `git reset --hard` never touches it, because `daemon/data/` is git-ignored. So the automatic rollback finds the exact path the previous daemon looks for, and a rename would hand that daemon an empty reduction. The daemon never writes the file again. [#427](https://github.com/alp82/curia/issues/427) deletes it once the journal is checked on the box.

**Take the migration deploy at zero live agents, with auto-dispatch off.** No agent is then mid-turn while the write path changes under it, and the window below carries only the daemon's own boot lines.

#### The rollback

Two rollbacks, and they differ.

**The automatic one.** The self-deploy health check fails inside about 190 seconds and resets the checkout. Nothing to do by hand. The old daemon reads the journal file and comes up. `events.db` stays on disk and nothing reads it. The loss is what the new daemon journaled inside that window, which went to the database alone. The box wrote about 404 events per day on 2026-08-13, so that window holds under one ordinary event.

**The deliberate one**, hours or days later. Regenerate the file first. `body` holds the line curia wrote, byte for byte, so one query reproduces the file exactly. The #321 prototype checked that at 4,282 lines and at 60,000.

1. Stop the daemon. A live writer makes the regenerated file stale as it is written.

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml stop daemon
   ```

2. Regenerate the journal file from the database. `-T` keeps the redirect on bytes rather than on a terminal.

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml run --rm -T --no-deps daemon \
     sqlite3 -readonly -noheader -list /home/alp/curia/daemon/data/events.db \
     'select body from events order by id' > /home/alp/curia/daemon/data/events.jsonl
   ```

3. Move the database aside. Take `events.db`, `events.db-wal`, `events.db-shm`, and an `events.db.migrating` if a failed conversion left one.

4. Deploy the previous ref.

A roll-forward after this converts again, from a file that by then also holds the old daemon's own appends.

### The backup

**Decided and not built.** [The store's backup and the Node pin (#357)](https://github.com/alp82/curia/issues/357) rules it, and [ADR-0017](../docs/adr/0017-the-journal-is-a-queryable-store.md) records it. The journal is curia's own local brain, and this dump is what bounds the loss.

The daemon takes the backup itself. It spawns `sqlite3 events.db .dump` on a second read-only connection, gzips the portable SQL text, and writes `data/backups/events-<UTC stamp>.sql.gz`.

- **Daily, and it survives a restart.** The daemon checks at boot and every hour. It dumps when the newest dump is 24 hours old or older. A plain 24-hour timer would not survive a deploy, because a deploy restarts the daemon and rearms the timer.
- **Fourteen kept.** The newest fourteen stay, and the daemon deletes the rest. One dump is about 250 KB at the volume the box wrote on 2026-08-13, so the whole set is about 3.5 MB.
- **On the box only.** The dump bounds a corrupt journal and a bad Node upgrade. It does not survive the loss of the box. An off-box copy is a separate effort.
- **The channel is the alarm.** A failed dump reaches it. A newest dump over 48 hours old reaches it too, so silence never stands in for a timer that failed to arm. A success journals one event and says nothing, so an ordinary day carries no noise. The dashboard shows none of this, because its container does not mount `daemon/data`.

#### The restore

A restore is rare and destructive, and a human picks which dump. So there is no verb and no button.

1. Stop the daemon. A live daemon keeps writing the database you are about to replace.

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml stop daemon
   ```

2. Move the live database aside. Take `events.db`, `events.db-wal` and `events.db-shm`.

3. Rebuild the journal from the dump. Name the dump you picked in place of `<dump>`.

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml run --rm -T --no-deps daemon \
     bash -c 'zcat /home/alp/curia/daemon/data/backups/<dump>.sql.gz | sqlite3 /home/alp/curia/daemon/data/events.db'
   ```

4. Start the daemon.

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml start daemon
   ```

The daemon sets `journal_mode` and `synchronous` when it opens the journal, so the restored file takes WAL at that boot. It also finds `events.db` present, so the migration does not run again. The loss is every event curia journaled after that dump.

### The Node pin

[The store's backup and the Node pin (#357)](https://github.com/alp82/curia/issues/357) rules it. [The daemon image takes Node 24 and sqlite3 (#409)](https://github.com/alp82/curia/issues/409) applied the first value. The journal sits on `node:sqlite`, which Node marks Stability 1.2, and a patch update can change the API, the defaults and the bundled SQLite engine.

**The pin is Node 24.19.0.** It is the version the [schema prototype](https://github.com/alp82/curia/blob/main/prototypes/journal-schema/) and the [guarantees research](../docs/research/node-sqlite-guarantees.md) both ran on.

One Node patch version runs every curia image. It is committed in two places, and it carries no default anywhere.

- `deploy/compose.yaml` passes `NODE_VERSION` to the daemon, the dashboard and the overseer from the `x-node-version` anchor. It is an anchor and not an interpolated variable, because the pin is committed and the `.env` file beside it is not.
- `config/curia.yaml` holds `sandbox.node_version` for the agent image, beside the other pins. It rides the image content address, so a bump names a tag the box does not have and the daemon rebuilds.
- The four Dockerfiles take `ARG NODE_VERSION` with no default. A build that forgets the arg then fails. This is the rule the agent Dockerfile already states for every other version it carries.
- Every image names its distro too, as `node:${NODE_VERSION}-bookworm-slim`. A new Debian then arrives by a commit and never by a rebuild.
- `daemon/package.json` states `engines.node`. It is a warning and not a wall, because a daemon that refuses to install is worse than the stack trace it prevents.
- `image.test.mjs` holds the two rules that silence would break: the two committed places name one version, and no Dockerfile carries a default.

The agent image belongs in that set. It ran `FROM node:lts-slim` and served Node 24.19.0 while the daemon ran 22.17.1. The daemon suite runs in the agent image, so the suite that must prove an upgrade ran on a Node nobody pinned.

#### Upgrading Node

Curia bumps Node only for a reason. A Node security release that touches what curia runs, or a `node:sqlite` fix curia needs. Curia does not bump on a calendar, because a scheduled bump is a floating pin with extra steps.

Three gates, in this order.

1. Move both pins in one commit. Then run the daemon suite under the new Node, and read it green.

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml build daemon
   docker compose -f /home/alp/curia/deploy/compose.yaml run --rm --no-deps daemon \
     bash -c 'npm install --no-fund --no-audit && npm test'
   ```

2. Read the box's live journal under the new image. The suite builds a fresh database, so it cannot catch an engine that refuses the file the box already holds.

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml run --rm --no-deps daemon \
     sqlite3 -readonly -box /home/alp/curia/daemon/data/events.db \
     'pragma integrity_check' \
     'select ts,type,ticket from events order by id desc limit 1'
   ```

3. Deploy. The self-deploy health check is the last gate, and it resets the box on a daemon that fails to come up.

The daemon journals `process.version` and `process.versions.sqlite` at boot, so the journal states which engine wrote its rows. A bad upgrade that reaches the box anyway is a restore, and the recipe is above.

## Blocking for hours (#34)

The daemon holds a blocked `ask_human` indefinitely — Node's `requestTimeout` covers only request *receipt*, so nothing server-side expires the held response. The client is what needed handling: **Claude Code aborts an MCP tool call after 300s of server silence** (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`), which killed every real agent five minutes in — twenty-five minutes before the #11 re-nudge could ever fire.

The fix is a daemon-side keepalive on the MCP stream (`MCP_KEEPALIVE_MS`, default 60 s): progress notifications when the client offered a `progressToken` (Claude Code does), logging notifications otherwise. It is client-agnostic on purpose — every harness curia has evaluated speaks MCP, and none of them should need a bespoke env var to make blocking work.

Verified live in two runs, because one run cannot show both halves (see the credential note below, which is why the 38-minute run ended as it did): an agent held **38 min** with its MCP socket still established and the 30-minute re-nudge firing on schedule, and a second held **435 s** — past the same 300 s mark — then released with an unguessable token that it echoed back verbatim, proving the answer reaches the agent intact after a long hold. The tokenless branch is covered by test only: the daemon keeps sending, but no real client that omits `progressToken` has been observed honouring it.

**A block used to be bounded by the agent's credentials rather than by the daemon — fixed in #53.** `seedConfigDir` used to *copy* the host's `.credentials.json` into each agent at spawn, so an agent held a credential **snapshot**, and the 38-minute run above outlived its own: the answer arrived, the blocked call returned, and the agent then died on its next model turn with `OAuth session expired and could not be refreshed`. The cause was not the length of the block but the copy — Claude Code refreshes by writing a temp file and renaming it over the store, so the host's first refresh rotated the token server-side and the agent's frozen copy became dead paper.

Agents now **share the host's credential store** instead of snapshotting it: `agentEnv` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the host's `~/.claude` while `CLAUDE_CONFIG_DIR` keeps everything else per-agent, so an agent sits on the host's exact credentials path — one file, one refresh lineage, the same atomic rename, and a ~2 s mtime poll on both sides that picks up whichever process refreshed last. That is precisely what a second host session does, which is why several host sessions coexist for days. Either side may refresh, so an idle host no longer strands an agent and vice versa. An agent's config dir now holds **no credential of its own**, so the `removeCredentials` call and the reconcile sweep are pre-#53 leftover collectors rather than a live deletion owner; the planned auth-health watchdog (#21, #28) is retired as mis-framed — there is nothing left to watch.

The cost, accepted deliberately: an agent can now reach the host's real credential file, so it has a host session's blast radius there (a `/logout` would log the human out) rather than only its own copy's.

## Attachments, both directions (#34, #430)

Amends the #11 payload contract:

- **Outbound** (agent → human): `images: [<path>]` on `ask_human` / `notify`. An agent may publish only from inside its own worktree and the daemon's data dir — resolved through `realpath`, so a symlink planted in the worktree cannot exfiltrate arbitrary files through the daemon's Discord token. A type off the allowlist, an oversized file and anything past the fourth are refused with a reason handed back to the agent; the message still goes.
  - **Text attaches too (#430).** The allowlist is five image types (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) and five text types (`.patch`, `.diff`, `.md`, `.txt`, `.log`), and `ALLOWED_EXTENSIONS` feeds both the check and the tool hint, so the agent reads the list the daemon enforces. A diff is the one artifact a review gate cannot fit in prose, and Discord previews a text file inline (#414). The two classes take **two caps**: 8 MB for an image, **1 MB for text**, because a text attachment is there to be read in the thread and 1 MB is already about 20000 lines. `MAX_FILES` is 4 for the whole call, images and text together. Nothing else about the gate moved: containment, the guest-path map and the refusal wording are the same code on the same path. Inbound did **not** widen — a text file the operator sends still arrives as a path line, because the agent has the file and a shell, and inlining it would spend context on a file it may never open. The module is `src/attachments.mjs`, renamed from `src/images.mjs`, because a module that carries patches should not be called images. The MCP field keeps the name `images` until the typed payloads (#418, #420) rewrite both schemas.
  - **Both path forms work (#429).** The roots above are HOST paths, and every agent runs in a container that calls its worktree `/workspace`. So `outboundFiles` hands `resolveOutboundFiles` a `guestRoot` — `{ guest: '/workspace', host: <wtPath> }` — and an absolute guest path is rewritten to its host path before containment runs. This translates, it does not widen: the check still runs on the real host path, so `/workspace/../etc/passwd` and a symlink out are refused as before. Only the worktree is mapped, never the `/cfg` mount, which holds the agent token. A caller with no known worktree (`/escalate`, `/answer`) gets no mapping and keeps speaking host paths. Refusals now say which fault it was — no such file, or outside your workspace — and name the forms that work. Before #429 an absolute container path matched no root, the file was dropped, and the refusal read "not a readable path", which sent the agent hunting for a permission problem it did not have.
- **Inbound** (human → agent): Discord attachments are downloaded under `data/attachments/<esc-id>/` (names sanitized to a leaf — `..` used to be able to walk out) and returned as real MCP `image` content blocks, so the picture lands in the agent's context. Verified live through the bridge's own download path — a screenshot attached to a thread reply, described in detail by an agent whose transcript shows exactly three tool calls and no `Read`, against a tool result carrying one `image` block. Anything unreadable, oversized (>5 MB) or not an image degrades to a visible `[attachment: <path>]` line rather than vanishing.

Attachment paths are part of the durable record, so a replayed answer keeps its images. Outbound is verified live end to end — a real agent's `notify` image rendered inline in the thread, while the same agent's attempt to publish `/etc/hostname` came back `refused — not a readable path inside this agent's workspace` with the message still delivered.

First-valid-wins (#11/#31) is verified live across two devices: Approve on the phone and Reject on the PC, one `esc_answer` in the journal, and the loser told `⚠️ not open — answered (answer was reject)` in an ephemeral reply rather than left guessing.

Dispatch state follows the same posture (#33): the agents map is a disposable in-memory cache. Reconcile (boot + on demand) re-derives it from GitHub claims, `tmux ls` and the journal — epoch-scoped (journal events only count against a ticket's latest dispatch), orphan sessions swept and dead claims released only on positive gh evidence, open button confirms lapsed on boot (agent instances do not match across a restart). Provider/model cooling is in-memory only and expires at the provider's stated reset (or a journalled 1 h fallback).

Deferred: voice-memo STT (text parity is the PoC floor, #31 scope note); the gpt/codex harness (a config addition to `routing.yaml` once its follow-up ticket lands).
