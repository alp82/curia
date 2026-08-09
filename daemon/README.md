# curia daemon

The always-on daemon from map decision [#9](https://github.com/alp82/curia/issues/9): agent-facing MCP surface + Discord bridge module + durable escalation record ([#31](https://github.com/alp82/curia/issues/31)) + the dispatch loop ([#33](https://github.com/alp82/curia/issues/33)) + the overseer session host ([#92](https://github.com/alp82/curia/issues/92)). Agent-host-agnostic — agents connect over streamable-HTTP MCP regardless of how they were spawned (#29).

## Setup

This section is the operator's box. To set curia up on your own machine, read the
[root README](../README.md).

The daemon expects these on the box before the first boot:

- **Node 22+** with npm. The daemon is one Node process (`npm install`, then `npm start`).
- **Claude Code, logged in.** Agents and the overseer share the host credential store at `~/.claude` (#53/#92). They have no login of their own. If the host is logged out, every agent and every overseer turn fails.
- **`gh`, authenticated** for every watched repo. The daemon claims, comments, and closes tickets through it.
- **`tmux`** — the agent host. Under compose (#260) the server lives in the `tmux` service and the daemon is a client over `CURIA_TMUX_SOCKET`. Unset, the default socket serves a dev box.
- **`ttyd` on port 7681** for the browser terminal. The compose `ttyd` service runs it. The daemon health-checks the port and does not spawn ttyd.
- **Tailscale** with Serve available. Attach links and preview links publish through `tailscale serve`.
- **A Discord bot** in one guild, with the message-content intent, and its token in `.env`.

`.env` (never committed):

- `DISCORD_BOT_TOKEN` — CuriaBot token. Omit to run REST-only (escalations stay answerable via `POST /answer`).
- `DISCORD_ALLOWED_USERS` — comma-separated Discord user ids; the auth gate. The bridge refuses to start if empty.
- `CURIA_AGENT_GH_TOKEN_<OWNER>` — the scoped GitHub token an agent gets as `GH_TOKEN` (#155). One key per resource owner, uppercased, hyphens folded to underscores: `alp82/curia` reads `CURIA_AGENT_GH_TOKEN_ALP82`. See [the agent's GitHub authority](#the-agents-github-authority-155) below.
- `CURIA_GUILD_ID` (optional — defaults to the bot's first guild), `CURIA_CHANNEL` (default `curia`), `PORT` (default 4271), `NUDGE_MS` (default 30 min).
- `OVERSEER_MODEL` (default `claude-haiku-4-5`) and `OVERSEER_FALLBACK_MODEL` (default `claude-sonnet-5`) — the overseer session models (#92).

Config (validated on load; a bad shape refuses the boot): `../config/curia.yaml` (watch list, dispatch settings — `auto_dispatch` ships `false` — attach ports, preview range, agent skill set) and `../config/routing.yaml` (label-only model routing, fallback chains, harness command templates). Override the directory with `CURIA_CONFIG_DIR`.

## Run

```
npm install
npm start          # reads daemon/.env
npm test           # unit tests
```

One boot brings up everything: the HTTP surface, ttyd, the Discord bridge, the reconcile pass, and the overseer host. There is no second process. To verify a boot, look for `ready: guild=<guild> channel=#curia` in the log, then send a top-level message in `#curia` — a thread opens and the overseer answers in it.

### The test suite

`npm test` must be green. No failure here is expected. No count in the summary is a baseline to read past.

**A cancelled test is not a skipped test.** A cancelled test is one whose suite died in its `before` hook. For a real-boot suite this means the daemon child never started, so the test proves nothing at all. Since #212 the boot wait watches the child as well as the port. A child that refuses to boot fails the wait in about one second. The message starts with `the real-boot fixture never got a daemon`, and the child's own stderr comes below it. See `test/fixtures/real-boot.mjs`.

**No suite reads `$HOME`.** `loadCuriaConfig` checks `skills.install` against `skills.root`, and that root defaults to `~/.claude/skills`. So a fixture config that says nothing about skills asks the host a question the test cannot control. Every fixture config now names a skills root that the test seeds. See `test/fixtures/skills.mjs`. The two tests that pin the default root swap in a home directory they own. The suite gives the same answer on the operator's box, in an agent container, and on a stranger's machine.

**One host binary stays optional.** The tmux describes in `tmux.test.mjs` need `tmux`, and each one states why it skipped. An agent container carries no tmux, so a green run there shows three skipped describes. Nothing needs a ttyd binary since #260 — `attach.test.mjs` pins the compose command instead.

## Surfaces

Two of these routes are the AGENT's, and since #159 they are gated: `/mcp` and `/agent_done` take a per-agent token in the `X-Curia-Agent-Token` header, minted at spawn and written into that agent's own connection settings. Everything else is the operator's own and answers on loopback only. An agent container reaches the daemon on the docker bridge gateway, and that listener serves the two agent routes and nothing else.

- `POST /mcp?agent=<name>&ticket=<n>` — MCP tools `ask_human` (blocking), `notify`, `report_result`, `publish_preview` (#40, `path` since #68), `open_pull_request` and `request_review` (#54). Ticket binding rides the spawn URL (#11). `ask_human` and `notify` also take `images: [<path>]` (#34).
- `GET /state` — open escalations + bridge status.
- `POST /escalate` — synthetic escalation (testing / non-MCP emitters); `?wait=1` blocks until answered.
- `POST /answer {id, answer, attachments?}` / `POST /cancel {id}` — same first-valid-wins gate as Discord.
- `POST /agent_done?agent=` — Stop-hook webhook (#29); closes the dispatch lifecycle (result recorded ⇒ clean close; result-less ⇒ abnormal exit, session kept for post-mortem).
- `POST /command {text}` — canonical command text, REST parity with the Discord slash verbs.
- `POST /reconcile` — on-demand reconcile (boot reconcile runs automatically).

## The verb catalogue (Discord slash commands, `POST /command`, or overseer prose)

The catalogue grew on #91. A repo argument is fuzzy everywhere it appears: any unambiguous part of a watched repo name resolves (`cur` works for `alp82/curia`); an ambiguous part refuses with the candidates.

- `tickets [repo]` — takeable tickets per watched repo (map lane with deferred-map skip and multi-map union, or flat `ready-for-agent` lane per watch-entry `mode`), plus the count of HITL-free tickets an agent can run alone. The slash/overseer name for the domain term "frontier".
- `next [repo]` — dispatch an agent on the first takeable HITL-free ticket.
- `start <n>` / `start [owner/]repo#<n>` (`model=x` optional — the harness follows the model, #177) — claim the GitHub issue, make the agent a private blobless clone under `workspace_root`, spawn the harness in a container from the tmux pane `curia-<n>` with a pre-seeded config dir (no first-run dialogs), watch for readiness. Anomalies (assigned/blocked/already-live) refuse with the way out — start never confirms (#89/#94).
- `map <n>` / `map [owner/]repo#<n>` (`model=x` optional, `-- <instruction>` optional) — dispatch a **charting agent** on a `wayfinder:map` issue (#160; the verb moved off `start` on #221). It edits the map and its child tickets, and that is all it does: it claims nothing, closes nothing and lands no branch, and curia refuses `open_pull_request` and `request_review` for it by name. The session `curia-<n>` is the lock, in place of the assignee a ticket agent takes. It ends on `report_result`, and curia posts that summary as a comment on the map. The instruction rides the spawn prompt rather than the note queue, so the agent reads it before its first tool call; with none, the agent's first act is an `ask_human` asking what should change. `wayfinder:map` routes like any other type label, through `defaults.map` in `routing.yaml`. An issue without that label refuses and names `start` as the verb that works a ticket; a closed map refuses and asks for a reopen. `start <n>` on a map number is **not** this verb — it dispatches the map's next takeable ticket. [ADR-0008](../docs/adr/0008-resolved-means-merged.md) records the deviation this ending stands on.
- `map [repo] [model=x] -- <prose>` — the same charting agent with **no map** (#241). The prose is mandatory here, because no map body states the effort instead. The repo token is optional while one repo is watched, and required past that — a number cannot name the repo when no map owns the number yet. The agent settles the destination with the operator, creates the `wayfinder:map` issue itself, and reports its number with `map_created`; curia checks the issue is an open map in that repo, then takes it as the session's map — the thread moves onto it, the summary lands there, and `map <n>` on it is refused while the session runs. `map_created` is a step, not the ending: this shape ends on `report_result` like the other one. The identity is a chat handle, below. On Discord, `/map` is the one slash command with no required option — a map number picks the first shape, an instruction alone picks the second, and neither refuses with both shapes named.
- `status` — live agents + tmux cross-check. Chat handles are listed beside ticket numbers.
- `resume <n>` (`model=x` optional) / `resume all` — fresh agent on a ticket, inheriting its surviving worktree and the model the dead agent last ran on, which the journal's `agent_spawned` states (#177). The harness follows that model, so a ticket that ran on gpt comes back on gpt. No spawn in the journal, or a model `routing.yaml` no longer carries, degrades to ordinary routing. `model=x` is the way out; `all` resumes every resumable ticket, each on its own inherited model, and takes no override.
- `cancel <n>` / `cancel all` — immediate teardown from a slash command or REST: kill session, remove worktree, unassign (re-frontier). The overseer's interpreted cancel instead posts a ✅/❌ button confirm (#94): instance-bound, no expiry clock, and it lapses the moment the agent exits. The confirm renders where the operator typed the command (#218). The button executes through the daemon, never through the model.
- `attach <n>` — `https://<tailnet-dns>:<serve_port>/?arg=curia-<n>` via the shared ttyd; `bin/curia-attach.sh` whitelists `^curia-[A-Za-z0-9._-]+$` (hard requirement — ttyd `-a` would otherwise hand out attach to any tmux session). ttyd also runs with `-O` (`--check-origin`): without it any web page open on any tailnet-connected device could hijack an agent's terminal cross-origin, since the victim's browser supplies the network position. What `-O` actually enforces (verified in ttyd's `src/protocol.c`) is `Origin == Host` — a same-origin *browser* control, not an allowlist: a mismatched `Origin` is refused at the WebSocket upgrade, but a DNS-rebinding page whose Host and Origin match each other passes. `-O` is kept, but it is no longer the control: see the identity check below.

**The chat handle (#241).** An agent that no issue answers for is named `chat-1`, `chat-2` — the lowest index free **on the box**, because a restarted daemon holds no agents map and tmux is the authority the dispatch locks already ask. The handle stands wherever a ticket number stands: the session `curia-chat-<i>`, the worktree, the thread, and the argument `attach`, `cancel` and `resume` take. `status` takes no argument and lists the handle beside the ticket numbers. A `resume` keeps the same handle, because the thread, the worktree and the journal epoch all answer to it — but a chat that already adopted a map refuses the resume and points at `map <that number> -- …`, which is the verb for a map that now exists. There is no lock on a handle, so several of these run at once, each in its own thread. Today the new-map dispatch is the only kind of agent that gets one.

- `review <n>` (`model=x` optional) — the cross-check (#164, [ADR-0010](../docs/adr/0010-the-cross-check.md)): spawn a reviewer on the OTHER provider, let it read the pushed diff, and capture its verdict. The pairing comes from `review:` in `routing.yaml` — an anthropic builder gets `gpt`, an openai builder gets `opus` — and a `review-model:<name>` label on the ticket beats it. With every model on the other provider cooling it runs on the builder's own and stamps the verdict "same provider — cross-provider was cooling". The reviewer is a full agent: its own tmux session `curia-review-<n>`, its own status line in the ticket thread, attachable through `attach <n>`, sandboxed like any agent. It writes nothing — curia refuses `open_pull_request`, `request_review`, `publish_preview` and `ask_human` for it by name — and its `report_result` summary lands as `data/verdicts/<n>.json`. This verb is the daemon-side entry point over `POST /command`; the operator's own surface is the third button below.

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

## Overseer sessions (#92/#93/#94/#95)

Every `#curia` thread is a persistent overseer session. A top-level prose message opens a thread and a fresh session. A later message in any thread revives its session with full memory. Slash commands stay deterministic and never touch the model.

The host (`overseer.mjs`) runs one Agent SDK `query()` per operator message, `OVERSEER_MODEL` first with one no-side-effect retry on `OVERSEER_FALLBACK_MODEL` (a failed turn that already made a tool call goes to the operator instead — a replay could double a dispatch). The thread→session map is a reduction over the journal, so a daemon restart loses no conversation. The session home lives under `data/overseer/` and holds no checkout.

Containment is the tool surface: the session's only tools are the eight verbs as in-process MCP tools (`review` is not one: the operator's surface for it is the gate button), and each tool posts canonical verb text through `gate.command` — the same seam the slash verbs and REST use, journalled and routed identically. The session has no shell, no files, and no process handles. It never answers an escalation or a review gate (the never-list in its system prompt).

An interpreted `cancel`/`cancel all` does not execute: the daemon posts a ✅/❌ button confirm (#94) — instance-bound, no expiry clock, lapsing the moment the agent exits, a newer confirm superseding an older one. The confirm renders where the operator typed the command, and in the command channel when the command carried no thread (#218): it is addressed to the operator, not to the ticket conversation. Each target's ticket thread gets a pointer to the buttons. Every other kind, the review gate included, keeps the ticket thread. The button executes through the daemon, never through the model. Outcomes that resolve between turns come back to the session as journalled notes on its next revival, so its memory stays honest.

Each turn posts exactly two messages (#95): one small-print progress line, edited in place as tool calls land, and one short answer. `messaging.mjs` holds the standard — the seven signal emoji, `<>`-wrapped links, "N more" clamps — and its lint runs in the tests. Ticket↔thread bindings (#93) route an agent's escalations into the thread that started it, rename the thread to a display-only `🎫 <ticket> · <type>` — the `wayfinder:` type replaces the old thread name — and release on terminal states plus a reconcile sweep. A release swaps `🎫` for `✅` and keeps the rest, so a finished ticket still reads as itself in the thread list.

The build was verified live by the full-loop rehearsal — `docs/live-checks/96-overseer-rehearsal.md` — including two daemon restarts mid-pass.

## The per-agent status line (#108 item 8, #146)

Each agent gets one Discord message in its ticket thread that says what it is doing now: dispatched, working, waiting on an escalation, awaiting review, executing approved writes, done, or gone. `statusline.mjs` builds it from the journal's own events through the store's append hook, so no transition needs a callback threaded through the dispatcher. The daemon composes every string. Agent text never lands here as it was written. A state change deletes the message and reposts it at the thread bottom (item 17). Everything else edits it in place.

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

## Preview links (#40, implementing #8)

The agent runs its dev server on localhost and calls `publish_preview(dev_port, path?)`; the **daemon** allocates an HTTPS Serve port from `preview.port_from`–`port_to` (config, default 8500–8599) and asserts `tailscale serve --bg --https=<port> http://127.0.0.1:<dev-port>`, returning `https://<box>.<tailnet>.ts.net:<port><path>`. Many previews run in parallel — the 443/8443/10000 cap is Funnel-only.

`path` (#68) is the page to look at, and it rides the preview **record**, so the review gate and the `🔗 preview` notify both render it and it survives a re-ask. Without it the link opens the site root, which is how #65 sent three review gates to an untouched homepage. It is a display suffix on a rule that already proxies the whole dev server, so it grants no new reach — but it must not move the link off this box, so a path is resolved and anything that changes the origin is refused: `//evil.com/x`, `https://evil.com/x`, `\evil.com/x`, and `box.ts.net:8500/x`, which parses as a scheme. Re-publishing the same dev port with a new path **moves** the link rather than returning the old one, because correcting a wrong link is why the call is made twice.

The agent never picks the public port, because `tailscale serve` will publish **any** localhost port to the whole tailnet and the daemon's own API is a localhost port. The registry is where that is contained: curia's own surfaces (daemon port, ttyd port, attach Serve port) are refused outright — publishing the daemon port would put `/answer`, `/command` and `/escalate` on the tailnet unauthenticated — and the dev port must be a **live** listener, so a rule can never be pointed at a port something else may bind later. Config validation also refuses a preview range containing `attach.serve_port`, which the sweep would otherwise withdraw.

Lifecycle: the rule is withdrawn when the ticket ends — clean finish, result-less exit, or `/cancel` — and reconcile sweeps anything in range that no live `curia-<n>` session claims. That sweep is the only thing that can see a rule left by a **previous** daemon process, since `tailscale serve --bg` config lives in tailscaled, not here; an indeterminate `serve status` skips the sweep rather than reading as "no live tickets" and withdrawing previews under review.

Verified live: refusals for all three curia surfaces and for a dead port; an agent that started its own dev server, published it, and had the page load **on the phone** over the tailnet; a second concurrent preview taking the next port; both sweep branches (kept while its session lives, withdrawn once nothing claims it) with the attach rule untouched throughout. Previews still carry the tailnet-membership-only posture: #151 gated the attach and timeline surfaces, and did not reach previews. An agent's dev server is published to the whole tailnet with no identity check.

## The agent's GitHub authority (#155)

An agent used to reach GitHub through the host's `~/.config/gh/hosts.yml` login, which is the whole account: every repo, every scope. It now gets a scoped fine-grained PAT as `GH_TOKEN`, which `gh` prefers over `hosts.yml` natively, so every wayfinder operation keeps working with no code that knows the token exists.

**One token per resource owner.** That is what a fine-grained PAT is: the creation form has a single resource-owner dropdown, and the watch list spans `alp82` and the `getalfredo` org. So the key carries the owner and the daemon picks by the ticket's own repo. An owner with no key keeps the inherited host login, and the daemon says so at boot with a `WARNING` naming the missing key.

The permissions are **Contents**, **Issues** and **Pull requests** read/write, plus **Commit statuses** read so `gh pr checks` answers. Nothing else. The rule is grant content, never execution or persistence: Secrets, Variables, Webhooks, Workflows, Environments and Actions-write each hand a compromised agent either a way to run code or a way to keep reach after it dies.

The daemon is deliberately **not** on this token. Its own `gh` keeps the host login, because it must reach every watched repo, and a repo added to `curia.yaml` but left off a token would break dispatch with no signal. A bare `GH_TOKEN` in `.env` would re-authenticate the daemon too, silently, by sitting in its environment.

The value is read at boot, so a quoted or padded token refuses the boot instead of reaching an agent as a 401 mid-resolve. Boot also asks GitHub once per watched repo, with the token that repo's agent would get, and warns when the token cannot reach it or expires within 14 days. An expired token does not degrade to the host login. It fails every `gh` call, so the warning is the whole defense.

That probe has one blind spot, measured rather than assumed: **a public repo left off the token's selection cannot be detected by any read.** Every fine-grained PAT reads public repositories, and the repo payload's `permissions` object describes the underlying user rather than the token grant — the `getalfredo` token reports `push: true` on `alp82/curia`, which it cannot possibly write. A private repo outside the selection does answer 404, and that is the case the probe catches. There is no harmless write, so no write probe runs at boot.

Note for org repos: an organization can cap fine-grained PAT lifetime, and `getalfredo` caps it at 366 days. So an org token cannot be permanent, and its expiry is a calendar item until the GitHub App lands. The full transcript is in [docs/live-checks/155-agent-github-token.md](../docs/live-checks/155-agent-github-token.md).

A GitHub App with one-hour installation tokens is the later, cleaner form, and it stays in the map's fog. It is not a drop-in: an installation token dies after an hour and `GH_TOKEN` is fixed at pane spawn, so the daemon would have to refresh into a per-agent `gh` config dir that `gh` re-reads on each call.

## What an agent knows (#57)

`seedConfigDir` symlinks the configured skills into `<CLAUDE_CONFIG_DIR>/skills/`, so an agent resolves in the same idiom a hand session does instead of being told about skills in its prompt (#49). Config is `skills.root` + `skills.install` in `curia.yaml`; the default list is `wayfinder`, `grilling`, `domain-modeling`, `research`, `prototype`, `implement`, `tdd`, `code-review`, `diagnosing-bugs`. The charting-and-PM skills (`to-tickets`, `triage`, `to-spec`, `handoff`) are withheld — `to-tickets` is mass ticket creation in the hands of an agent that carries charting authority.

Two of the nine — `wayfinder` and `implement` — carry `disable-model-invocation: true`: on the **claude** harness they are not listed to the model and its Skill tool refuses them (`cannot be used with Skill tool`). Installing them is still required, because a prompt whose **first line** is `/wayfinder` does load the skill (verified live), while naming it in prose does not. That is a constraint the spawn prompt must satisfy (#54).

The **codex** harness spells the same line `$wayfinder` (#173). That frontmatter key is claude's and does not travel: codex lists every installed skill with its path, and it states its own trigger — naming a skill with `$SkillName` means "you must use that skill for that turn" and "read its `SKILL.md` completely before taking task actions". The rule reaches every codex model, by `base_instructions` for the gpt-5.6 family and by an appended `### How to use skills` block for the older ones (measured, `docs/live-checks/173-codex-skill-load.md`). So `writePrompt` takes the harness, and a fallback that crosses providers writes the prompt again for the harness it lands on.

Symlinks, not copies: an agent never writes a skill, so the version tracks the host with no snapshot to go stale — the opposite of the credential case (#53), where the agent *does* write and a symlink was replaced by a regular file. The links are rebuilt on every seed, so a reused config dir keeps no skill that has left the list. A name in `install` that has no `SKILL.md` under the root **refuses the boot**, naming the path: an agent that silently lacks a configured skill is the failure this replaced. Nothing else comes from the host — no `CLAUDE.md`, no allowlist, no MCP connectors, no saved permission mode (#23/#29).

Dispatch also asserts the tracker prerequisite: a **map child** whose worktree carries no `docs/agents/issue-tracker.md` is refused before the claim is kept, because the wayfinder skill would follow its own instruction to fall back to the local-markdown tracker and write `.scratch/` files instead of resolving on GitHub. A plain `ready-for-agent` ticket invokes no such skill and still dispatches — the flat lane watches *any* plain repo (#10) — with a `tracker_doc_missing` journal line.

## State posture

`data/events.jsonl` is the only durable artifact — an append-only journal; in-memory state is a pure reduction over it, rebuilt on boot. Open escalations survive daemon restarts with their Discord message ids intact (the rebooted process still honors clicks on messages posted before the restart — verified live). The pending-resolver map is ephemeral (#9); ticket→thread bindings live in the journal (#93); a restart loses only the in-process agent call (accepted re-dispatch posture, #11/#12).

Supersede (#29): a re-issued `ask_human` (same agent + same payload while an older escalation is open) closes the old record, strips its buttons in Discord, and routes late answers to the live successor.

## Blocking for hours (#34)

The daemon holds a blocked `ask_human` indefinitely — Node's `requestTimeout` covers only request *receipt*, so nothing server-side expires the held response. The client is what needed handling: **Claude Code aborts an MCP tool call after 300s of server silence** (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`), which killed every real agent five minutes in — twenty-five minutes before the #11 re-nudge could ever fire.

The fix is a daemon-side keepalive on the MCP stream (`MCP_KEEPALIVE_MS`, default 60 s): progress notifications when the client offered a `progressToken` (Claude Code does), logging notifications otherwise. It is client-agnostic on purpose — every harness curia has evaluated speaks MCP, and none of them should need a bespoke env var to make blocking work.

Verified live in two runs, because one run cannot show both halves (see the credential note below, which is why the 38-minute run ended as it did): an agent held **38 min** with its MCP socket still established and the 30-minute re-nudge firing on schedule, and a second held **435 s** — past the same 300 s mark — then released with an unguessable token that it echoed back verbatim, proving the answer reaches the agent intact after a long hold. The tokenless branch is covered by test only: the daemon keeps sending, but no real client that omits `progressToken` has been observed honouring it.

**A block used to be bounded by the agent's credentials rather than by the daemon — fixed in #53.** `seedConfigDir` used to *copy* the host's `.credentials.json` into each agent at spawn, so an agent held a credential **snapshot**, and the 38-minute run above outlived its own: the answer arrived, the blocked call returned, and the agent then died on its next model turn with `OAuth session expired and could not be refreshed`. The cause was not the length of the block but the copy — Claude Code refreshes by writing a temp file and renaming it over the store, so the host's first refresh rotated the token server-side and the agent's frozen copy became dead paper.

Agents now **share the host's credential store** instead of snapshotting it: `agentEnv` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the host's `~/.claude` while `CLAUDE_CONFIG_DIR` keeps everything else per-agent, so an agent sits on the host's exact credentials path — one file, one refresh lineage, the same atomic rename, and a ~2 s mtime poll on both sides that picks up whichever process refreshed last. That is precisely what a second host session does, which is why several host sessions coexist for days. Either side may refresh, so an idle host no longer strands an agent and vice versa. An agent's config dir now holds **no credential of its own**, so the `removeCredentials` call and the reconcile sweep are pre-#53 leftover collectors rather than a live deletion owner; the planned auth-health watchdog (#21, #28) is retired as mis-framed — there is nothing left to watch.

The cost, accepted deliberately: an agent can now reach the host's real credential file, so it has a host session's blast radius there (a `/logout` would log the human out) rather than only its own copy's.

## Images, both directions (#34)

Amends the #11 payload contract:

- **Outbound** (agent → human): `images: [<path>]` on `ask_human` / `notify`. An agent may publish only from inside its own worktree and the daemon's data dir — resolved through `realpath`, so a symlink planted in the worktree cannot exfiltrate arbitrary files through the daemon's Discord token. Non-images, oversized files (>8 MB) and anything past the fourth are refused with a reason handed back to the agent; the message still goes.
- **Inbound** (human → agent): Discord attachments are downloaded under `data/attachments/<esc-id>/` (names sanitized to a leaf — `..` used to be able to walk out) and returned as real MCP `image` content blocks, so the picture lands in the agent's context. Verified live through the bridge's own download path — a screenshot attached to a thread reply, described in detail by an agent whose transcript shows exactly three tool calls and no `Read`, against a tool result carrying one `image` block. Anything unreadable, oversized (>5 MB) or not an image degrades to a visible `[attachment: <path>]` line rather than vanishing.

Attachment paths are part of the durable record, so a replayed answer keeps its images. Outbound is verified live end to end — a real agent's `notify` image rendered inline in the thread, while the same agent's attempt to publish `/etc/hostname` came back `refused — not a readable path inside this agent's workspace` with the message still delivered.

First-valid-wins (#11/#31) is verified live across two devices: Approve on the phone and Reject on the PC, one `esc_answer` in the journal, and the loser told `⚠️ not open — answered (answer was reject)` in an ephemeral reply rather than left guessing.

Dispatch state follows the same posture (#33): the agents map is a disposable in-memory cache. Reconcile (boot + on demand) re-derives it from GitHub claims, `tmux ls` and the journal — epoch-scoped (journal events only count against a ticket's latest dispatch), orphan sessions swept and dead claims released only on positive gh evidence, open button confirms lapsed on boot (agent instances do not match across a restart). Provider/model cooling is in-memory only and expires at the provider's stated reset (or a journalled 1 h fallback).

Deferred: voice-memo STT (text parity is the PoC floor, #31 scope note); the gpt/codex harness (a config addition to `routing.yaml` once its follow-up ticket lands).
