# curia daemon

The always-on daemon from map decision [#9](https://github.com/alp82/curia/issues/9): agent-facing MCP surface + Discord bridge module + durable escalation record ([#31](https://github.com/alp82/curia/issues/31)) + the dispatch loop ([#33](https://github.com/alp82/curia/issues/33)) + the client for the overseer container ([#92](https://github.com/alp82/curia/issues/92), which moved out of this process on [#315](https://github.com/alp82/curia/issues/315)). Agent-host-agnostic — agents connect over streamable-HTTP MCP regardless of how they were spawned (#29).

## Setup

This section is the operator's box. To set curia up on your own machine, read the
[root README](../README.md).

The daemon expects these on the box before the first boot:

- **Node 22+** with npm. The daemon is one Node process (`npm install`, then `npm start`).
- **An Anthropic credential in Curia's provider store.** The daemon can start without one. Run `reauth anthropic` before you start model work.
- **`gh`, authenticated** for every watched repo. The daemon claims, comments, and closes tickets through it.
- **`tmux`** — the agent host. Under compose (#260) the server lives in the `tmux` service and the daemon is a client over `CURIA_TMUX_SOCKET`. Unset, the default socket serves a dev box.
- **`ttyd` on port 7681** for the browser terminal. The compose `ttyd` service runs it. The daemon health-checks the port and does not spawn ttyd.
- **Tailscale** with Serve available. Attach links and preview links publish through `tailscale serve`.
- **A Discord bot** in one guild, with the message-content intent, and its token in `.env.daemon`.

`.env.daemon` holds the daemon's own secrets and is never committed:

- `DISCORD_BOT_TOKEN` — CuriaBot token. Omit to run REST-only (escalations stay answerable via `POST /answer`).
- `DISCORD_ALLOWED_USERS` — comma-separated Discord user ids; the auth gate. The bridge refuses to start if empty. It is also the watcher list: every id on it is silently added as a member of each thread the daemon opens, so new tickets appear in the operator's thread list without a ping.
- `CURIA_GH_APP_ID` and `CURIA_GH_APP_KEY_FILE` are the GitHub App every holder mints from ([ADR-0018](../docs/adr/0018-the-daemon-is-a-github-app.md)). The key is a FILE beside this one, at mode 0600. Half an app refuses the boot, and no app at all is legal on a box that dispatches nothing. The operator's own steps are [docs/github-app.md](../docs/github-app.md).
- `CURIA_AGENT_GH_TOKEN_<OWNER>` is **retired** ([#466](https://github.com/alp82/curia/issues/466)). An agent mints its own token now, so a key still here is a live read-write PAT with no job, and boot names it: delete the line, then revoke the token on GitHub. See [the agent's GitHub authority](#the-agents-github-authority-155-cut-over-by-389-retired-by-466) below.
- `CURIA_GUILD_ID` (optional — defaults to the bot's first guild), `CURIA_CHANNEL` (default `curia`), `PORT` (default 4271).
- The overseer's own tokens are **not** in this file. The daemon writes GitHub tokens under `<workspace_root>/overseer/tokens/` and the model credential under `<workspace_root>/credentials/`.
- The overseer takes **no model variable here**. It runs in its own container since the cutover (#315), on `claude-sonnet-5` with no fallback, and the model is `OVERSEER_CONTAINER_MODEL` in `src/overseerturn.mjs`. `OVERSEER_MODEL` and `OVERSEER_FALLBACK_MODEL` died with the in-daemon host.

Config (validated on load; a bad shape refuses the boot): `../config/curia.yaml` (watch list, dispatch settings — `auto_dispatch` ships `false` — attach ports, preview range, agent skill set) and `../config/routing.yaml` (label-only model routing, fallback chains, harness command templates). Override the directory with `CURIA_CONFIG_DIR`.

Each of those two files takes an override beside it — `curia.local.yaml` and `routing.local.yaml`, both ignored by git (#292). The daemon reads the tracked file and lays the override over it: a mapping merges key by key, and a list or a scalar replaces whole. The daemon names the override and its top-level keys at boot.

The operator configuration is `../config/config.yaml` (#866), and it wins over both layers of `curia.yaml` for the keys it sets: `max_concurrent`, `auto_dispatch`, `poll_interval_s`, `prototype_variations`, `messages_per_send`, `live_pane_cap`, and `watch`. It is the file the dashboard saves and the operator edits by hand, and git ignores it. `daemon/src/config.mjs` reads it through `cli/src/config.mjs`, the one contract module the lifecycle interface, the daemon, and the dashboard share, so the compose file mounts `cli/src` beside `daemon/src`. An invalid file refuses the boot with the contract's own diagnostic — the path, the line, the key, and the rule — and `POST /reload` declines it the same way while the running daemon keeps what it loaded. A missing file is the ordinary case of a source checkout: every key keeps its shipped answer. The operator's view is [docs/operator/configuration.md](../docs/operator/configuration.md).

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

**CI runs both suites on every pull request.** The `.github/workflows/ci.yml` workflow runs `npm test --prefix cli` and then `npm test --prefix daemon` on `ubuntu-latest`, on the Node that `config/curia.yaml` pins, on every pull request and on every push to `main`. The runner has no `tailscale`, so a test that reaches a host binary instead of an injected runner fails there before it can fail a publication, the way the 0.7.0 bundle job did. `test/ciworkflow.test.mjs` pins the trigger, the order, and the action pins.

**One host binary stays optional.** The tmux describes in `tmux.test.mjs` need `tmux`, and each one states why it skipped. An agent container carries no tmux, so a green run there shows three skipped describes. Nothing needs a ttyd binary since #260 — `attach.test.mjs` pins the compose command instead.

## Surfaces

Two of these routes are the AGENT's, and since #159 they are gated: `/mcp` and `/agent_done` take a per-agent token in the `X-Curia-Agent-Token` header, minted at spawn and written into that agent's own connection settings. A third is the OVERSEER CONTAINER's, `/overseer/mcp`, gated the same way by a secret minted per turn (#314). Everything else is the operator's own and answers on loopback only. The docker bridge gateway listener serves those three container routes and nothing else.

- `POST /mcp?agent=<name>&ticket=<n>` — MCP tools `ask_human` (blocking), `notify`, `report_result`, `publish_preview` (#40, `path` since #68), `open_pull_request` and `request_review` (#54). Ticket binding rides the spawn URL (#11). `ask_human` and `notify` also take `images: [<path>]` (#34).
- `POST /overseer/mcp?turn=<id>` — the eight verb tools, for the model in the overseer container (#314). The daemon composes the canonical text from the validated arguments and posts it to the same `/command` seam, so the container reaches eight verbs and never the router. The secret in the header opens ONE live turn; it is minted per turn and forgotten when the turn ends.
- `GET /ping` — the reachability probe (#188): the mark, the port, and this process's release version (#884), which the lifecycle interface reads after a switch to prove the service that answers is the target release. Before every gate; it reads and journals nothing.
- `GET /state` — open escalations + bridge status.
- `GET /overview`: The dashboard's whole daemon read (#262, per [#249](https://github.com/alp82/curia/issues/249)). It includes agents, escalations, review data, health, usage, journal events, frontier facts, settings, and deploy data. Its map snapshot covers every open map. Each map includes history, agents, frontier facts, blockers, fog, counts, and its latest event stamp. Journal events and each poll invalidate the map snapshot before its next indexed refresh. Each section is nullable, and only the journal tail and deploy error excerpt cross.
- `GET /diff?esc=<id>|agent=<name>[&file=<i>]` — the diff digest and, on demand, one file's hunks (#355, building [#343](https://github.com/alp82/curia/issues/343)). A review gate answers from the digest counted when it opened, so it costs no read. An agent answers a fresh count of its worktree, committed and uncommitted work together. `file` is a place in that digest's own ranked list, never a path: the caller names a gate or an agent, and the daemon resolves the worktree itself. A worktree that is gone falls back to `gh pr diff` when the pull request is known. This is the one console read that is not the poll.
- `POST /escalate` — synthetic escalation (testing / non-MCP emitters); `?wait=1` blocks until answered.
- `POST /answer {id, answer, attachments?}` / `POST /cancel {id}` — same first-valid-wins gate as Discord.
- `POST /agent_done?agent=` — Stop-hook webhook (#29); closes the dispatch lifecycle (result recorded ⇒ clean close; result-less ⇒ abnormal exit, session kept for post-mortem).
- `POST /command {text}` — canonical command text, REST parity with the Discord slash verbs.
- `POST /reconcile` — on-demand reconcile (boot reconcile runs automatically).
- `GET /setup` and `POST /setup` — integration setup (#874). The read verifies every card fresh through `src/setup.mjs` and answers the record beside the four cards and the Test run's gate; the write keeps the selected card and the closed list of safe fields in `state/setup.json`, and refuses any other key by name. Never a secret in either direction. The operator's page is [Integration setup](../docs/operator/integration-setup.md).
- `GET /setup/full-loop`, `POST /setup/full-loop {repo?}`, and `POST /setup/full-loop/retry` — the Test run, one Full loop as the installation acceptance (#882, #891, `src/fullloop.mjs`). The read is the run as the journal tells it: the last `full_loop_started` row and the rows after it, judged into the eight legs of the Full loop per ticket (frontier discovery, dispatch, escalation and answer, pull request, review, merge, ticket resolution, map update) and a ninth, the map closed, plus the map, the two tickets and which is in flight, the linked artifacts, the elapsed time, and on a failure the leg, the cause, and the action. The press takes this read's gate and refuses a closed one, creates the run's own wayfinder map in the covered repository (`src/testrunmap.mjs`: "Test run <date>", two child tickets that add one line to the README and remove it again, the second blocked by the first through GitHub's native dependency, both marked `rehearsal` and typed `wayfinder:test-run`, the routing row that names the cheapest model at the lowest effort; each write journalled as it lands so a retry resumes the same map), then finds each ticket through the dispatcher's own frontier read and dispatches it through the dispatcher's own `start`; every later leg is one row the daemon already writes while the agent works, counted only after the run's spawn, only for the ticket's session, and only in order. The map closes on Curia's own map lifecycle: the empty-map verdict the overseer asks once both tickets are closed, and the `map_fog_closed` row after the operator's answer. The retry reruns the failed leg on the same map and ticket. Nothing is stored but the journal rows, so `curia doctor` keeps reading the gate. The read also carries `waiting`, the last open `esc_open` addressed to the ticket in flight or to the map (its kind, prompt, options, the pull request for a review gate, when it opened, the leg that runs, and `message`, the escalation as the bridge composed it through `src/escalationembed.mjs`, so the page draws the Discord message the operator has to answer), and `sessions`, the agent's session while the dispatcher holds it and the overseer's while it is in a turn, each with the app's `/terminal/?arg=<session>` link (#891); the page answers the question through `POST /answer`, the route the Discord bridge uses. The operator's page is [The Test run](../docs/operator/integration-setup.md#the-test-run).
- `GET /identity`, `GET /setup/tailscale?login=<login>`, and `POST /setup/tailscale/operator {login}` — the Tailscale card (#877, `src/tailscalesetup.mjs`; the machine-name field dropped after #891). The identity read answers the logins every published surface admits now and whether the first-operator window is open (an installation root with no operator recorded); the sidecar asks it at boot, on every poll, and after the confirmation. The panel read takes the login Serve stamped on the request that asked, which the sidecar passes and the browser never chooses, and answers the node, the record, the Serve route, and the private address. The confirmation records that login and the node's own machine name (read from the node, never typed) in `state/tailscale.json`, fills the live allowlist in place, and answers the panel read beside the freshly verified card. Under a root the recorded operator is the whole allowlist and `identity.allow` in `curia.yaml` admits nobody; the source deployment keeps `curia.yaml`'s list. The verifier reads `tailscale status --json` and `tailscale serve status --json` on an injectable `exec`, creates the app's own Serve route when it is missing and records it, and probes the app on loopback as the recorded login over `node:http` on an injectable `probe` (never `fetch`, which drops the `Host` header the identity check reads), timed. Curia never installs or reconfigures Tailscale.
- `GET /settings` and `POST /settings` — the settings screen through the service (#880, closing the open fact #867 left). Under an installation root the app mounts nothing, so its sidecar reads the two files here and lands a save here: the same `readSettings` and `saveSettings` of `src/settings.mjs` the sidecar runs on its own mount in the source deployment, on the root's `config/config.yaml` (through the operator configuration contract and `writeOperatorConfig`) and `state/routing.local.yaml`. A save the contract or a loader refuses answers 400 with the refusal's own sentence and moves nothing; the apply stays `POST /reload`, which the sidecar orders next.
- `GET /update` — the app's update panel (#883, `src/updatecheck.mjs`). Under an installation root: the installed version (from `state/installation.json`), the recommended stable release and the withdrawn list from the last daily check of the signed stable-release index, whether an update is available, both release-notes links, a withdrawal warning, and when the check ran, succeeded, and is due again. The daemon runs the check at startup when the last successful one is older than 24 hours and then once a day, verifies the index with the key of the active version's package (`versions/<active>/cli/stable-index.pub`, mounted read-only), and records only the result in `state/update-check.json`. The read starts nothing; a failed check keeps the last verified index beside the failure. Without a root the read says the deploy updates this process. `CURIA_STABLE_INDEX_URL` points the check at a mirror or a test server.
- `GET /setup/openai` and `POST /setup/openai/login` — the OpenAI half of the model-provider card (#878, `src/openaisetup.mjs`). The read is the panel's own: the credential by presence, its safe identity facts (the opaque account id, the plan, the expiry), the live sign-in with the link and the one-time code `ReauthFlow` scraped, the ending the last login left, and routing readiness. The write starts the dispatcher's own `codex login --device-auth` session (`startReauth`, the same one `reauth openai` runs) and answers the read at once; the page polls the read until the flow shows. The verifier reads the credential off `cfg.paths.codexAuth` on every call, completes one minimal streamed request on the Codex backend (`POST https://chatgpt.com/backend-api/codex/responses`, as the codex CLI sends one with a subscription credential, on an injectable `fetch`), timed, and applies the routing preset in `src/modelrouting.mjs` when routing is not ready: rows on a model that cannot run move to the provider's model, models switch on and off by credential presence, and the override lands in `state/routing.local.yaml` under a root (the service's own state boundary) or `routing.local.yaml` beside the tracked file, applied in place through the reload route's own apply. No answer, log line, or refusal carries the token; there is no API-key route.
- `GET /setup/anthropic` and `POST /setup/anthropic/login` — the Anthropic half of the model-provider card (#879, `src/anthropicsetup.mjs`), the OpenAI half's shape. The read is the panel's own: the credential by presence, its safe facts (the adoption instant and the expiry estimated from it, never an identity, because a `setup-token` credential states none), the live sign-in with the authorize link `ReauthFlow` scraped (typed lane: the operator pastes the code on the card, and the token never enters the flow state), the ending the last login left, and routing readiness. The write starts the dispatcher's own `claude setup-token` session (`startReauth`, the same one `reauth anthropic` runs) and answers the read at once. `POST /setup/anthropic/code {code}` (#891) hands the code the browser showed to `ReauthFlow.deliver`, which types it into the login pane over the flow's own raw tmux write (the dispatcher's `sendText` keeps refusing every `curia-auth-` session, so the stall ladder never reaches a login prompt), answers `{ delivered, said }` beside the read, 400 on a refusal, and keeps the code out of every answer, log line, and journal event; a code the CLI refuses is read off the pane (`OAuth error: …`), journalled as `reauth_code_refused`, said on the row as `login.refusal`, and answered with an Enter so the login prints a fresh link. The verifier reads the credential off `cfg.paths.anthropicStore` on every call, refuses a record outside the secret boundary or past its documented year, completes one minimal Messages request (`POST https://api.anthropic.com/v1/messages`, the usage probe's own shape on `usage.probe_model`, bearer token plus `anthropic-beta: oauth-2025-04-20`, on an injectable `fetch`), timed, and applies the same routing preset in `src/modelrouting.mjs` for `anthropic` (rows that cannot run move to `fable`, the anthropic models switch on, and with both credentials on disk every model of both providers is on and no row moves). No answer, log line, or refusal carries the token; there is no API-key route.
- `GET /setup/discord`, `POST /setup/discord/token {token, user_id}`, and `POST /setup/discord/channel {guild_id, channel}` — the Discord card (#876, `src/discordsetup.mjs`). The read is the panel's own: the token by presence, the bot, the servers it is in, the invite link, and the facts in `state/discord.json`. The token submission lands the token in `secrets/discord-bot-token` through `writeSecret` and the operator ID in `state/discord.json`, and answers the same read. The channel choice lands the server and the channel name, starts the bridge and waits for its login when none runs (#891, `src/bridgestart.mjs`: the bridge starts on a token on disk and an allowed operator, at boot, on this connect, and on any Discord read that finds the token and no bridge, with the boot's retry ladder), and answers the freshly verified card, whose `detail.bridge` reads `starting` while the login is in flight. No answer, log line, or refusal carries the token; a paste that is not a token is refused by shape.
- `GET /repos` — the repos the settings screen offers (#265). The dashboard holds no GitHub credential, so the daemon reads them with the login every dispatch uses: the 100 most recently pushed repos it can reach, cached 10 minutes. A failed read answers `repos: null` with the reason, never an empty list.
- `POST /restart {by?}` — the restart the settings screen orders (#265, per [#249](https://github.com/alp82/curia/issues/249)). The daemon journals `restart_requested`, answers, says goodbye, and then exits **75**. `restart: on-failure` in `deploy/compose.yaml` respawns it, and a clean exit deliberately does not. Agent panes live in the tmux container (#260), so they survive it.

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

- `review <n>` (`model=x` optional) starts the cross-check (#164). The reviewer uses the other provider and reads the pushed diff. The ticket status shows the cross-check through the builder. The reviewer keeps its own `curia-review-<n>` session and sandbox. Curia refuses every reviewer write. The verdict lands in `data/verdicts/<n>.json`.

## The dashboard sidecar (#263, per [#249](https://github.com/alp82/curia/issues/249))

The console is a **separate process**, `bin/curia-dashboard.mjs`, in its own compose service. It stays up while the daemon restarts, which is the whole reason it is not a daemon surface: the restart becomes a marker on the page instead of a dead tab.

- **Ports.** Loopback `dashboard.port` (4273), published on `dashboard.serve_port` (8445). Both join the collision check and `previews.reserved`, so the daemon refuses to boot on a shape that would let one surface shadow another, and no preview can be allocated over the console.
- **Secret-free.** Its container mounts `daemon/src`, `daemon/bin`, `daemon/assets` and `config/`. It never mounts `daemon/.env` or `daemon/data/`, so it holds no Discord token, no GitHub token and no journal handle. `node_modules` is baked into the image for that reason.
- **The gate.** The sidecar is its own HTTP server, so it applies `identityRefusal` in-process exactly as the timeline does, on the same `identity.allow` list read with the same rule. It asserts its own Serve rule at boot and re-asserts it every minute. A listener that is not up, a page whose proto stamp it does not speak, or a tailnet name it cannot resolve **withdraws** the rule instead of publishing it.
- **The probe (#884).** `GET /ping` answers `{ curia: 'curia-dashboard', version }` before the gate, on loopback where no Serve identity exists. It reads nothing and asks the daemon nothing. The lifecycle interface reads it after a switch to prove the app came back on the target release, beside the daemon's own `/ping`, which carries the same field.
- **The read.** One loopback `GET /overview`. A failed read never costs the snapshot: the page keeps the last reading, states its age and names the reason.
- **The one read that is not the poll (#355).** `GET /api/diff` proxies the review-gate branch of the daemon's own `/diff`. It fetches hunks for the stored diff digest. The page names a review gate and a file only by its place in the digest curia measured — no path, no repo, no branch and no command crosses this wire. A gate's numbers already ride `/overview`, so opening that card costs nothing; the hunks cost one git call each, once, when the operator opens a file.
- **The write (#265, #292, #866, #880).** In the source deployment `config/` is the sidecar's only read-write mount, and the settings screen is the only thing that writes it. Under an installation root the sidecar mounts nothing, so `settingsSource: 'daemon'` in `bin/curia-dashboard.mjs` sends the same read and the same save to the daemon's `GET` and `POST /settings`, which run the same two halves on the root's files; the handler, the watch-removal guard, and the reload that follows are one flow either way. The screen writes `config.yaml` and `routing.local.yaml`, and never a tracked file, because git tracks those and a save would leave the box's checkout dirty for the next fast-forward. The operator half of `POST /api/settings` goes through the operator configuration contract in `cli/src/config.mjs`: the file's keys plus the keys the save names, judged by the contract and then by `loadCuriaConfig` as the layer the daemon will read, and landed by one atomic rename with mode `0600`. The routing half edits `routing.local.yaml` through the yaml **document** API, so every hand comment survives; keeps only what differs from the tracked file, and removes an override that comes to hold nothing; validates the candidate with `loadRoutingConfig`; and renames it over the real file only after both halves pass. A refused save answers 409 with the loader's or the contract's own message and leaves every file byte for byte as it was. `checkPaths: false` is the one rule turned off: four loader checks ask about paths this container does not mount, and no key the screen writes can reach them. `POST /api/restart` orders the daemon's own `POST /restart`.
- **The second gate on a write.** The identity header proves whose browser a request is, never which page told it to call — Serve stamps the operator's login on a `fetch` from any origin. So a POST must also carry an `Origin` this surface answers to, and any `Sec-Fetch-Site` other than `same-origin` is refused. The sidecar composes its own call to the daemon from a route it names in code and forwards no browser header, which is what keeps it on the daemon's side of that gate.
- **The poll.** `dashboard.poll_interval_s` (5) is a ceiling, not a clock. The sidecar re-reads only when a page asks and its snapshot is older than that, so many tabs cost one read and a hidden tab — which stops asking — costs none. One read costs no journal read at all (#289): what the overview says about the recent past is reduced in memory as events are written, so the price of a poll does not rise with the history.
- **The page.** `assets/dashboard.html`, carrying the `curia-dashboard` proto stamp #70's rule requires. The read screens landed on #264 and the settings on #265. The verbs land on #266, the chat on #267, and the diff digest on #355.
- **Integration setup (#874).** The `#setup` screen is the frame the #853 prototype settled: a rail of four fixed-height cards, GitHub, Discord, Tailscale, and AI logins, selectable in any order, with the selected card's configuration beside it and the Test run as one dependent action under the rail. It reads `GET /api/setup` on arrival and on **Try again**, which the sidecar relays from the daemon's `GET /setup` with a 60 s ceiling; a daemon that cannot be asked answers null cards with the reason. `POST /api/setup` is composed here from the card list and `PROGRESS_FIELDS` in `src/setup.mjs`, so a key outside that list never crosses to the daemon. The per-card content slot is `SETUP_CONTENT[key].content(card, progress, p)` on the page and `verifiers[key]` on the daemon (#875 to #879); The Full-loop gate (#880) is `src/fullloopgate.mjs`, a function of the four cards and nothing stored: ready only when GitHub, Discord, Tailscale, and at least one model provider verified on this read and each connected card handed the fact the loop needs (a covered repository, a server and channel, a private address, a ready routing), answering `full_loop.facts` for the loop's run (#882): the repository and the discovered ticket, the server, channel, confirmation, and bridge state, the address and the admitted operator, the leading provider (the remembered one when it verified, else the first connected) with its request and routing rows. The page enables **Start Test run** on that word alone and names the facts under the rail. The press (#882) is `POST /api/setup/full-loop`, composed here out of at most a repository and a ticket number, and the panel then draws the run the service reads off its journal through `GET /api/setup/full-loop`, polled every 5 s while it runs: one row per leg, the linked GitHub and Discord artifacts, the elapsed time, and on a failure the leg, the cause, the action, and **Try again** (`POST /api/setup/full-loop/retry`). The GitHub card (#875) is `src/githubsetup.mjs`: it starts the same manifest flow as the Settings section with `screen: "setup"` on `POST /api/github-app/start`, so GitHub's redirect through `/api/github-app/complete` lands on `#setup`, and its verifier re-reads the App's installations, mints one write token per installation, reads what each covers, checks that at least one watched repository is covered, and reads that repository's open tickets, all on an injectable `fetch`. The verified facts ride the card as `card.detail`: the watched owners with this read's installation state, the covered and the watched repositories, and `available`, every repository the installations cover, which the page offers with a checkbox each (#891). `POST /api/setup/github/watch { repos }` is composed here out of `owner/name` strings and lands the ticked list as the watch list through the same settings save and reload as the Settings screen; under a root the watch list comes from `config/config.yaml` alone, never from the shipped `curia.yaml`. The Discord card (#876) is `src/discordsetup.mjs`: the page's `setupDiscord` draws the guide and the one token form before the token exists, then the bot and the invite link, a wait that re-reads `GET /api/setup/discord` on the page's `poll_interval_s` until the bot is in a server (#891), and only then the servers and the channel name; `POST /api/setup/discord/token` and `POST /api/setup/discord/channel` are composed here out of the fields they name, and the token is checked for shape before it crosses so a refusal never echoes it. The verifier reads the token off its file on every call and proves, over Discord's REST API on an injectable `fetch`, the operator's membership, the top-level text channel (found, never created: **Connect channel** creates it), the bot's permissions in it, that the registered commands match the bridge's own `SLASH_MANIFEST` by name and description (read, never registered: **Connect channel** registers once and `POST /api/setup/discord/commands`, **Register commands**, registers again, #891), and a confirmation message of curia's own, found before it is posted so a read never repeats it. A 429 from Discord on any call keeps the card's last answer and reports the wait. The Tailscale card (#877) is `src/tailscalesetup.mjs`: the page's `setupTailscale` draws the identity Serve stamped on the request that opened the app (`GET /api/setup/tailscale`, which the sidecar composes with that login) and the node with its name, the tailnet's fact since `curia install` named it (#891), and the one press, `POST /api/setup/tailscale/operator {}`, carries no field and is composed here with the request's own login, so a browser can agree to the identity it arrived with and never name another. The sidecar's allowlist comes from the daemon's `GET /identity` under a root (`identitySource: 'daemon'`, read at boot, on every poll, and after the confirmation) and from `curia.yaml` in the source deployment; while the daemon says no operator is confirmed, the first tailnet identity is admitted to what the Setup page itself asks for and nothing else: the page and its favicon, `/api/overview` for the status banner, `/api/setup*`, and the two GitHub App manifest routes (#891). A failed identity read at boot is retried every 2 s for up to a minute until the daemon answers once, so the window opens as soon as the daemon is up rather than on the next Serve assert. The model-provider card is `setupModel`, one row per provider so the second lands beside the first; its OpenAI row (#878) is `setupOpenAI`: one press, `POST /api/setup/openai/login`, composed here with no field at all (nothing about that login is the browser's to name, and there is no key to paste), then `GET /api/setup/openai` polled every 3 s while the login is starting or waiting, drawing the link, the code, and the terminal fallback with the Credentials screen's own `credFlow`; when the login is gone the frame verifies fresh, which is what turns the card.
- **The chat, and the picker in front of it (#267, #333, a page of Curia app by #711).** The Curia app page draws the room itself: the active-branch transcript over server-sent events, the escalation cards, the native dialog card, and the shared composer, at `#chat/<session>`. The sidecar pipes `/events`, `/send`, `/draft`, `/key`, `/take-back` and `/dialog-answer` straight to the daemon's timeline listener, headers unchanged in both directions, so the timeline applies the #151 check to the evidence the browser actually sent. The timeline's own Serve rule retired with #711, and reconcile keeps withdrawing it; `/chat?session=` is a door that lands on the route. The picker has a Tickets section and an Overseer section over the conversations of [ADR-0016](../docs/adr/0016-the-conversation-key.md). An ended agent stays in the Tickets section and its room refuses new input with one sentence. A parked overseer conversation shows no parked state and returns on its next message. It reads `GET /api/console` on arrival rather than on the poll, because a row costs the daemon a transcript read and the other screens have no use for it. Each row carries the conversation's own context percent, which ADR-0016 makes the one signal that a conversation is getting long. `POST /api/console/new` mints one and `POST /api/console/delete` forgets one. Neither is a verb: the operator catalogue has no word for a browser conversation, so there is nothing for `/command` to carry.
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

Each ticket gets one Discord status message. The status line carries dispatch, image build, composer, work, waits, review, and resolution. `statusline.mjs` builds the status from journal events. A state change moves the message to the thread bottom. Other changes edit the message in place.

Successful completion settles the status line into the receipt (#690). The last edit keeps final meters, Chat, and ticket links. Abnormal exits, deaths, cancellations, and watchdog failures retire the status line.

Since #146 the line also carries **meters** beside the state:

```
🧭 `reads call sites` · **opus** · ctx 88% · **5h** 🟥 ▓▓▓┃███░░░░ 62% · **7d** 🟩 ▓▓▓▓░░░░┃░░ 41%
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

- **The ending uses a report and the status line.** The `curia` report leads with the typed headline. The status line then settles into the receipt. The receipt keeps the final meters and durable links.
- **The status line carries the spawn.** Dispatch, image build, composer arrival, and working phases edit one message. No separate composer message posts.
- **A button answer is the card.** The bridge acknowledges the press silently and edits the card in place. No interaction reply follows it. The mark on the card carries what the reply used to add. That includes the dead ids a routed answer came through.

## Preview links (#40, implementing #8)

The agent runs its dev server on localhost and calls `publish_preview(dev_port, path?)`; the **daemon** allocates an HTTPS Serve port from `preview.port_from`–`port_to` (config, default 8500–8599) and asserts `tailscale serve --bg --https=<port> http://127.0.0.1:<dev-port>`, returning `https://<box>.<tailnet>.ts.net:<port><path>`. Many previews run in parallel — the 443/8443/10000 cap is Funnel-only.

`path` (#68) is the page to look at, and it rides the preview **record**, so the review gate and the `🔗 preview` notify both render it and it survives a re-ask. Without it the link opens the site root, which is how #65 sent three review gates to an untouched homepage. It is a display suffix on a rule that already proxies the whole dev server, so it grants no new reach — but it must not move the link off this box, so a path is resolved and anything that changes the origin is refused: `//evil.com/x`, `https://evil.com/x`, `\evil.com/x`, and `box.ts.net:8500/x`, which parses as a scheme. Re-publishing the same dev port with a new path **moves** the link rather than returning the old one, because correcting a wrong link is why the call is made twice.

The agent never picks the public port, because `tailscale serve` will publish **any** localhost port to the whole tailnet and the daemon's own API is a localhost port. The registry is where that is contained: curia's own surfaces (daemon port, ttyd port, attach Serve port) are refused outright — publishing the daemon port would put `/answer`, `/command` and `/escalate` on the tailnet unauthenticated — and the dev port must be a **live** listener, so a rule can never be pointed at a port something else may bind later. Config validation also refuses a preview range containing `attach.serve_port`, which the sweep would otherwise withdraw.

Lifecycle: the rule is withdrawn when the ticket ends — clean finish, result-less exit, or `/cancel` — and reconcile sweeps anything in range that no live `curia-<n>` session claims. That sweep is the only thing that can see a rule left by a **previous** daemon process, since `tailscale serve --bg` config lives in tailscaled, not here; an indeterminate `serve status` skips the sweep rather than reading as "no live tickets" and withdrawing previews under review.

Verified live: refusals for all three curia surfaces and for a dead port; an agent that started its own dev server, published it, and had the page load **on the phone** over the tailnet; a second concurrent preview taking the next port; both sweep branches (kept while its session lives, withdrawn once nothing claims it) with the attach rule untouched throughout. Previews still carry the tailnet-membership-only posture: #151 gated the attach and timeline surfaces, and did not reach previews. An agent's dev server is published to the whole tailnet with no identity check.

## The agent's GitHub authority (#155, cut over by #389, retired by #466)

**An agent mints its token, and there is no PAT behind it.** [ADR-0018](../docs/adr/0018-the-daemon-is-a-github-app.md) replaced every hand-made PAT with one GitHub App. #389 moved the agents and KEPT `CURIA_AGENT_GH_TOKEN_<OWNER>` as the fallback, because no PAT comes out ahead of its replacement. The box then ran its dispatches on the minted path, and [#466](https://github.com/alp82/curia/issues/466) took the key out. What the daemon hands an agent is a per-agent `gh` config dir it rewrites. The container environment carries `GH_CONFIG_DIR`, which is a path and never a secret. See [the minted token](#the-minted-token-389) below.

**A GitHub App is now required to dispatch an agent.** That is what the retirement bought and what it costs. A mint that fails refuses the dispatch and releases the claim, because nothing stands behind it: an agent with no GitHub credential cannot read the ticket it was dispatched for, let alone commit, push or merge. The three causes read the same way, and the refusal names them: no app on this box, an app not installed on that owner, and a GitHub that did not answer.

**A key left in `daemon/.env.daemon` is a live PAT with no job.** Boot names each one and asks for two acts: delete the line, and revoke the token on GitHub. That is the same pair #392 asks for on the overseer's own retired key.

What the PAT did is in [docs/live-checks/155-agent-github-token.md](../docs/live-checks/155-agent-github-token.md), which stands as the record of the boundary this replaced. One measurement from it still decides code here: **a public repo left off a token cannot be detected by any read.** Every fine-grained PAT reads public repositories, and so does an installation token. That was measured again on #466, where an agent's own minted token read `octocat/Hello-World`. So the credential watch stopped probing repos with a token and asks the installation what it covers instead ([the credential watch](#the-credential-watch-380)).

## The minted token (#389)

The shape this section predicted is the shape that shipped: a per-agent `gh` config dir the daemon rewrites, which `gh` re-reads on every call.

**No token in the container environment.** The env carries `GH_CONFIG_DIR=/cfg/gh` and nothing else about GitHub. The daemon writes `<workspace_root>/cfg/curia-<n>/gh/`, which is inside the config dir the container mounts, so an agent reads its own credential and no other's.

**One file, both tools, no shim.** `gh` reads `hosts.yml`, and git reaches GitHub through `credential.helper = !gh auth git-credential`, which is already set on every clone. The username git gets is `x-access-token`, the same one `GH_TOKEN` yields today.

**Two files, and both are load-bearing.** `config.yml` states `version: "1"` and `hosts.yml` carries a `users:` block. Without them `gh` runs its multi-account migration, which calls `GET /user` — a 403 under an installation token — and then refuses every command with `cowardly refusing to continue`. It also rewrites the file, which would take it out of the daemon's hands. With them `gh` makes no API call at all. Measured in [docs/live-checks/389-agent-minted-token.md](../docs/live-checks/389-agent-minted-token.md) and re-taken by `test/agentgh.test.mjs` on every run of the suite.

**The refresh rides the dispatch tick**, every 60 s, above the `auto_dispatch` gate — a token dies in an hour whether or not this box dispatches anything new. The minter serves its cached token until ten minutes before the hour, so the value turns over about every fifty minutes and GitHub sees one call per owner in that time. Reconcile refreshes as well, so an agent adopted by a restarted daemon does not run on a token that expired while the daemon was down.

**The file is the evidence.** An agent that spawned holds the file its own spawn wrote, so the refresh asks the disk rather than its own memory. That is what makes an adopted agent free: a restarted daemon rebuilds its records with every spawn-time fact missing, and it arms exactly what is already armed.

**A reviewer gets the READ set.** A cross-check reviewer reads a detached checkout, writes nothing, and curia posts its verdict for it (ADR-0010). One key and two sets is what the app bought.

**The commits read as the bot.** An agent commits as `curia-sh[bot]`, from the app's own slug and the bot user's id. A GitHub that cannot state that identity does NOT refuse the dispatch: the agent keeps the box identity its clone was given, and the log says so. That is two network reads standing behind a name, and a name is not the credential.

**The teardown is the config dir's.** `removeCredentials` takes the directory, so every ending collects it — including the two that keep the workspace for a post-mortem, and the reconcile sweep that finds a config dir whose session is gone.

**A mint that fails REFUSES the dispatch** (#466), and the refusal names which of the three causes it was: no app on this box, an app not installed on that owner, or a GitHub that did not answer. It used to fall back to `CURIA_AGENT_GH_TOKEN_<OWNER>`, and that key retired once this path was proved on the box. Nothing stands behind it now, so an agent that started anyway would hold no credential at all: it could not read its own ticket, and it would burn a whole session to fail at its first `gh` call. The refusal unclaims the ticket, exactly as the side-channel assert does, so it costs nothing.

## The daemon's own GitHub authority (#390)

The daemon reaches GitHub as a `gh` child process, and every one of those children used to run with no token — so it inherited `~/.config/gh` and did its work as the operator. [ADR-0018](../docs/adr/0018-the-daemon-is-a-github-app.md) calls that the last of four hand-made secrets, and the one that makes the review gate impossible: GitHub refuses a self-approval, so a pull request authored by the operator can never be approved by the operator.

**The repo picks the owner.** Nearly every call the daemon makes names a repo, and a repo names an owner. `daemongh.mjs` mints that owner's write token and puts it in the environment of the one child that needs it. So the frontier reads, the claims, the comments, the closes, the clones, the pull requests and the branch pushes all run as `curia-sh[bot]`.

**`GH_TOKEN`, not a config dir.** An agent gets a `gh` config dir because a container mounts a directory and cannot be handed a live value (#389). The daemon spawns its own children, so it has no such boundary — and `gh` reads `GH_TOKEN` before it reads any config file. The value never enters the daemon's own environment, which is what keeps the deploy sibling and a dev session on the host login.

One thing to watch on a new box: `~/.config/gh` must already be MIGRATED. A `hosts.yml` in the pre-multi-account shape makes `gh` run a migration that calls `GET /user`, which an installation token answers 403 (#389 measured that inside a container). Any interactive `gh` command by the operator migrates the file once and for good, so a box whose login is in use is already past it.

**Three calls keep the host login.** Two are the settings screen's repo picker: `viewerLogin()` and `gh api user/repos`. Neither names a repo, both ask an account-wide question about a person, and an installation token answers neither. The third is the gate approval (#391), which names a repo and keeps the operator's login anyway — see the section below. `test/daemongh.test.mjs` reads `github.mjs` and refuses any other unrouted call, because a call that forgets its repo runs as the operator again and nothing else would say so.

**The claim assigns a person.** A claim is an issue assignee and GitHub does not let an App be one. So the daemon calls as the bot and assigns `dispatch.claim_login` from `config/curia.yaml`. The key is required, with no default, and the boot refuses a config without it: every other source for that name is a guess, and a guess claims tickets in a stranger's name.

**A mint that fails falls back**, loudly, to the host login. A box with no app, an owner the app is not installed on, and a GitHub that could not be reached all read the same way — the same rule the agents got at #389, applied to their daemon.

**What the host login still holds on the daemon**: dev sessions, the deploy sibling, and the gate approval. An app cannot approve for a human, and an app-minted approval on an app-authored pull request is a self-approval again.

## The gate approval, and branch protection (#391)

The ✅ press submits a real GitHub approval. `approvePullRequest` in `github.mjs` runs `gh pr review --approve` on the pull request the gate showed, deliberately unrouted, so it carries the operator's own `~/.config/gh`. That is the reason the host login did not retreat whole at #390: the approval is a person's judgement, an app cannot post one for them, and the pull request is the bot's own since #390.

**Branch protection is what makes the press binding, and it is OPTIONAL.** One required review on `main`, administrators exempt, turned on by hand — [docs/github-app.md](../docs/github-app.md) step 7 carries the command. Curia requires no setting in a watched repo and nothing here reads the rule, so a repo without it loses the enforcement and keeps everything else. It turns on with this code and not before: turned on earlier it blocks every curia pull request behind an approval nobody posts. **This box protects no repo** (#479): the operator ruled the rule out, so the press binds the agent's standing orders and GitHub enforces nothing. The approval is posted either way, and [the live check](../docs/live-checks/391-gate-approval.md) carries the reading.

**The submission decides what is journalled.** `#submitGateApproval` runs before the `review_answered` line is written, and a failure makes that line `approved: false` with `outcome: 'approval-failed'` and the press kept beside it. So a press whose approval never reached GitHub does not read as approved to the Stop hook, to `/status`, or to the next dispatch's inherited exchange (#374). The agent is told not to merge and not to resolve, and told that no commit of its own fixes it — the fault is on GitHub, and the next act is a question to the operator. The status line corrects itself the same way: `esc_answer` draws "executing approved writes" off the button, and the failed approval lands right behind it.

**Three skips are not failures.** A ticket that produced no code has no pull request and no merge either. A pull request already merged cannot take an approval, which is the #369 replay landing on work approved once already. And a SELF-APPROVAL is a box with no app for this owner: #390's fallback opened the pull request on the host login, so the press and the pull request carry one account and GitHub refuses the review. That box keeps exactly the gate it had before #391, because ADR-0018 says no credential comes out ahead of its replacement — the operator hears it once per ticket, and the cure is an installation. Everything else — including a pull request curia cannot name — is a failure, because an indeterminate approval leaves a merge waiting on a review nobody can see.

**The pull request is re-read at the press.** The gate opens with one read and a human takes hours to answer, so the state that decides is the state at the press.

**Nothing is submitted on ❌**, and nothing on the 🔎 cross-check press either. The third button answers neither way.

## The overseer's GitHub authority (#313, cut over by #392)

The overseer container holds a shell. The read-only token is the control that replaces the `/command` seam, because a standing order cannot hold a shell and a shell cannot mint a token. See [ADR-0014](../docs/adr/0014-the-overseer-in-its-own-container.md).

The permissions are **Contents**, **Issues**, **Pull requests** and **Commit statuses** at read, plus **Metadata** read. Nothing at write, and nothing else at all. Agents write, and they write through pull requests. #313 bought that set as one fine-grained PAT per owner. #392 mints it instead, from the one app key, as `READ_PERMISSIONS` in `src/githubapp.mjs`. The set did not change.

**One file per resource owner**, named by the owner in lower case, at `<workspace_root>/overseer/tokens/<owner>`. The daemon writes it at mode 0600 through a rename, and the container mounts the tree read-only. That tree holds the tokens and nothing else.

**The daemon mints, and the container reads a file.** There is no endpoint the container can call: a shell that can mint is the capability ADR-0014 removed, and that is the whole boundary. The refresh rides the dispatch tick, every 60 s, above the `auto_dispatch` gate — an installation token lives one hour and this container answers the operator whether or not the box dispatches anything. Reconcile refreshes too, because that container was not restarted with the daemon.

**Both tools read the file at the moment they need it.** `gh` reads one `GH_TOKEN` and the container holds one token per owner, so something must pick. git picks by itself: one `credential.https://github.com/<owner>.helper` line per owner, whose helper prints the file, because git prefix-matches the owner path (measured). `gh` takes a shim that reads the owner off the command line or off the checkout directory name, then reads the same file. So a token the daemon rewrites takes effect on the next call, with nothing restarted.

**Nothing is held from the container's boot.** The watch list is re-read per turn, the routing is rewritten per turn (#361), and the token is a file. Watching a repo of a brand new owner is an ordinary save: no env file edited, and no service recreated. That was the last limit a turn could not re-read.

**An owner with no installation reads public repositories only.** It gets no token file, so it gets no credential rather than another owner's. The container names that owner in the chat, once per turn, through `unroutedNote` — the one sentence the boot log and the turn share. The daemon's boot names it too, beside the app installations it can see.

`daemon/.env.overseer` is retired. Delete any `CURIA_OVERSEER_GH_TOKEN_<OWNER>` key, revoke that token, and delete any `CLAUDE_CODE_OAUTH_TOKEN` key. Then remove the file. The daemon parses an existing copy only to warn about legacy keys.

The transcripts are [docs/live-checks/313-overseer-github-token.md](../docs/live-checks/313-overseer-github-token.md) for the routing and [docs/live-checks/392-overseer-minted-token.md](../docs/live-checks/392-overseer-minted-token.md) for the cutover.

## The credential watch (#380, re-based by #466)

The daemon measures the credential the WATCH LIST stands on, every six hours, and states what it finds in `#curia` once and on the dashboard's Needs-you list until it clears. `tokenwatch.mjs` holds the rules.

**It reads one fact now: does the app installation cover this watched repo?** It used to read two facts per repo: whether a PAT reached it, and how many days were left on that PAT. Both died with the PATs. An installation token lives one hour, the daemon refreshes it, and GitHub states no expiry header for one at all, so there is no expiry any operator can act on.

**It asks the installation, never the repo.** A token read of the repo cannot answer this: an installation token reads every public repository on GitHub, so `GET /repos/<owner>/<name>` says 200 for a repo the app was never granted. `GET /installation/repositories` states the grant itself, for private and public alike, and it costs one call per owner.

**A GitHub that did not answer says nothing in either direction.** The reading is `unmeasured`, and it neither warns nor clears a warning that already stands.

## Where the service data lives (#867)

`loadCuriaConfig` attaches `cfg.paths`, and that is the only way a module learns where a credential store, a token tree, or the overseer's mirrors are. `src/paths.mjs` builds it. Under an installation root (`CURIA_ROOT`) every path comes from the lifecycle interface's own `cli/src/layout.mjs`: the journal and its neighbours in `state/`, the worktrees and config dirs in `work/` (which becomes `dispatch.workspace_root`, whatever the file says), the containers' `HOME` at `cache/home`, the overseer's mirrors at `cache/overseer-repos`, and its tokens at `run/overseer-tokens`. Without a root the paths are the source deployment's, off the workspace root, exactly as before.

**The four long-lived credentials are files in `secrets/`, read through `cli/src/secrets.mjs`.** `secrets/discord-bot-token`, `secrets/github-app.json` (`{ id, pem }`), `secrets/anthropic.json` (the store `AnthropicCredentialStore` owns), and `secrets/codex-auth.json` (the store `CodexCredentialBroker` refreshes). The Discord facts beside the token, `allowed_users`, `guild_id`, and `channel`, are `state/discord.json`, read through `src/discordsettings.mjs`. The allowed Tailscale operator, the machine name, and Curia's Serve routes are `state/tailscale.json`, read through `src/tailscalesetup.mjs`. Under a root the daemon loads no env file, and a credential key found in its environment refuses the boot by name. `GET /overview` carries `secrets`, each file by presence and never by value.

**The overseer's model credential is a copy in its config dir**, the same `.credentials.json` a claude agent gets, written when a pane is prepared and healed on the tick beside every live agent's copy. It used to be the store behind a read-only mount of `credentials/`. A container that holds a shell gets no mount of `secrets/`, so `runOneTurn` and the pane read the copy, and the seed leaves it in place (`seedConfigDir` with `sweep: false`).

The Compose shape of an installed Curia is `deploy/bundle/compose.yaml`, inspected against `SERVICE_MOUNTS` by `test/bundlecompose.test.mjs`. The operator's page is [Secrets, mounts, and what survives](../docs/operator/secrets.md).

## The release images and the bundle (#869)

Each of the four service Dockerfiles under `deploy/` ends in a `release` stage, and `deploy/agent/Dockerfile` is one stage of that name, so `.github/workflows/release.yml` builds five images once per release with the pins `deploy/bundle/pins.mjs` reads from `config/curia.yaml`, pushes each to `ghcr.io/alp82/curia-<service>` (the agent image as `curia-agent`), attests the digest, and renders `deploy/bundle/compose.yaml` against the four service digests with `deploy/bundle/render.mjs`. The rendered bundle, its checksum, `curia-images-<version>.json`, the release manifest `curia-manifest-<version>.json` (#870, `cli/src/manifest.mjs`, written from the checksum, the digests, and the commit), and the bootstrap `curia-install.sh` (#872, `deploy/bootstrap/`, rendered with the version stamped in) land on the draft GitHub release that Release Please created; the workflow then publishes the release and `@curia-sh/cli` last (#871). `workflow_dispatch` rehearses the same path on any branch under a commit tag and publishes nothing.

## Publication and the stable-release index (#871)

One workflow file, `release.yml`, runs Release Please and the whole publication, because npm's trusted publisher and `gh attestation verify --signer-workflow` both name the workflow file. `release-please-config.json` sets `draft`, so the release exists before its assets do, and an `extra-files` entry bumps `cli/package.json` with `daemon/package.json`. `deploy/release/publish.mjs` is the gate at each step (`image`, `assets`, `release`, `package`, `verify`, `key`): an identity that exists with the same bytes is kept, one that exists with different bytes refuses. `test/releasepublish.test.mjs` proves every decision through fake probes, and `test/releaseworkflow.test.mjs` reads both workflows as text and pins the order, the permissions, and the environment.

Selection is `cli/src/stable.mjs`: the signed `release/stable.json` on `main`, promoted and withdrawn by `deploy/release/index.mjs` under `.github/workflows/stable-index.yml`, verified on the host against the Ed25519 public key the package ships as `cli/stable-index.pub`. `deploy/release/keygen.mjs` makes the key once. The operator's page is [Releases, the stable-release index, and version selection](../docs/operator/releases.md).

Discovery on an installed host is `src/updatecheck.mjs` (#883): `UpdateCheck` reads the same index through `fetchStableIndex` with the key under `versions/<active>/cli/`, at startup when the last successful check is older than a day and then daily, and keeps one record, `state/update-check.json`, that `GET /update` composes the panel's answer from. It never downloads a release, and it never notifies. `test/updatecheck.test.mjs` proves the schedule with a fake clock and timer, the record, the older-index refusal, and every panel state; `test/rootboot.test.mjs` proves the real boot checks a local index and writes the record under the root. The operator's page is [Update discovery, staging, and the switch](../docs/operator/update.md).

The release stage carries the checkout at `/opt/curia`: `daemon/src`, `daemon/bin`, `daemon/assets`, the pinned `node_modules`, `cli/src` (the daemon imports the operator configuration and the layout from there), `config/curia.yaml` and `routing.yaml`, and in the daemon image `skills/` and `deploy/agent/`. Named paths, never a tree: `daemon/` as a whole would carry the box's env file and journal. `.dockerignore` at the repository root keeps those out of every build context too. The files are root-owned and read-only to the uid that runs the container, and nothing in the stage names a uid or a host path: the bundle sets `user`, `HOME`, and every mount at run time. Under `CURIA_ROOT` the loader also takes `sandbox.agent_uid` from the process's own uid rather than the file, because the file's `1000` is the source box's fact.

The source deployment keeps building the `box` stage (`target: box` in `deploy/compose.yaml`), which is the image it always had. The Node and Claude Code pins reach a release build through `deploy/bundle/pins.mjs`, which reads `sandbox.node_version` and `sandbox.claude_version` from `config/curia.yaml`; `test/releaseimages.test.mjs` keeps them equal to the anchors in `deploy/compose.yaml`, inspects every release stage as text, and, with `CURIA_BUILD_IMAGES=1` and Docker present, builds the tmux image and runs it as uid 4242. The operator's page is [Release images and the Compose bundle](../docs/operator/bundle.md).

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

**A minor release's migration is additive** (#885, implementing #854). On an installed host the previous release stays under `versions/` as the rollback release, and `curia rollback` starts it on the same journal. So a minor release may add a column with a default, an index, a table, or a trigger, and never renames, drops, retypes, or constrains a column, never rewrites `body`, and never sets a `user_version` this code refuses (the schema pins none). The insert names its columns and the schema is `create ... if not exists`, which is what makes the older daemon's write path work on the newer file. `test/journalforward.test.mjs` opens a journal migrated that way and proves the append and the rebuild read. The same rule covers every record under `state/`: an optional key may be added, a format number never raised. The operator's view is [Migrations and the rollback release](../docs/operator/rollback.md#migrations-and-the-rollback-release). Anything that cannot follow the rule is a major release.

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

A conversion that fails needs no hand. The daemon crash-loops, the self-deploy health check fails, and the box resets to the previous ref. That daemon finds the journal file the conversion read, whole, because a conversion never touches it.

**The journal file is gone.** The migration left it where it was, unrenamed and unwritten, so the automatic rollback found the exact path the previous daemon looked for. [#427](https://github.com/alp82/curia/issues/427) deleted it from the box, after the row count was checked against the line count. Nothing lands on a file any more, and step 2 of the deliberate rollback below is the only way one comes back.

**Take the migration deploy at zero live agents, with auto-dispatch off.** No agent is then mid-turn while the write path changes under it, and the window below carries only the daemon's own boot lines.

#### The rollback

Two rollbacks, and they differ.

**The automatic one.** The self-deploy health check fails inside about 190 seconds and resets the checkout. Nothing to do by hand. The ref it resets to also reads `events.db`, so the daemon comes up on the same journal and the rollback costs no events.

A reset that lands on a ref older than [#407](https://github.com/alp82/curia/issues/407) is the one case that needs a hand. That daemon looks for the journal file, and the file is gone, so it comes up on an empty reduction. Stop it, run step 2 below to regenerate the file, and start it again.

**The deliberate one**, back to a daemon older than [#407](https://github.com/alp82/curia/issues/407). Regenerate the file first. `body` holds the line curia wrote, byte for byte, so one query reproduces the file exactly. The #321 prototype checked that at 4,282 lines and at 60,000.

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

[The store's backup and the Node pin (#357)](https://github.com/alp82/curia/issues/357) rules it, [ADR-0017](../docs/adr/0017-the-journal-is-a-queryable-store.md) records it, and [#436](https://github.com/alp82/curia/issues/436) shipped it in `src/backup.mjs`. The journal is curia's own local brain, and this dump is what bounds the loss.

The daemon takes the backup itself. It spawns `sqlite3 -readonly events.db .dump` on a second read-only connection, gzips the portable SQL text, and writes `data/backups/events-<UTC stamp>.sql.gz`. The stamp is UTC seconds with the colons folded to hyphens, so the names sort in write order as plain text.

- **Daily, and it survives a restart.** The daemon checks at boot and every hour. It dumps when the newest dump is 24 hours old or older. A plain 24-hour timer would not survive a deploy, because a deploy restarts the daemon and rearms the timer.
- **Fourteen kept.** The newest fourteen stay, and the daemon deletes the rest. One dump is about 250 KB at the volume the box wrote on 2026-08-13, so the whole set is about 3.5 MB.
- **On the box only.** The dump bounds a corrupt journal and a bad Node upgrade. It does not survive the loss of the box. An off-box copy is a separate effort.
- **The channel is the alarm.** A failed dump reaches it. A dump that lands after the newest one passed 48 hours reaches it too, and it states the age it repaired, so silence never stands in for a check that stopped running. A success journals one event and says nothing, so an ordinary day carries no noise. The dashboard shows none of this, because its container does not mount `daemon/data`.
- **One line per fact.** A failure line carries the reason and the age of the newest dump together. The alarm stands in the journal as `journal_backup_failed` and a landed dump clears it, so a deploy repeats nothing. A dump that keeps failing says one line when it starts failing, and one more when the newest dump crosses 48 hours.
- **A half dump is no dump.** The daemon writes `<name>.sql.gz.part` and renames it into place. A dump killed halfway leaves nothing the retention can count. A shell that exits 0 with no SQL behind it is a failure, because an empty file in the set would push a real dump out.
- **The boot line.** The daemon journals `journal_opened` with `process.version` and `process.versions.sqlite` each time it opens the journal, so the record states which engine wrote its rows. Read it with `select ts,body from events where type='journal_opened' order by id desc limit 5`.

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

### The aistack sync

[Publish recurring box usage to aistack (#695)](https://github.com/alp82/curia/issues/695) rules it, and `src/aistack.mjs` holds it. The box is an aistack machine: once a day, the daemon publishes the rolling 30-day token usage of every harness it can see, so the agents' spend joins the operator's measured layer on aistack.to.

- **The credential is the switch.** The daemon syncs only when `<workspace_root>/home/.config/aistack/credentials.json` exists. That file holds a bearer token, it lives under curia's own HOME, and no checkout ever carries it. An unregistered box runs nothing and says nothing.
- **The roots are built per run.** Every agent gets its own config directory under `<workspace_root>/cfg/<session>`, and teardown deletes it. So each run enumerates `cfg/*`, passes every directory holding `projects/` as the comma-separated `CLAUDE_CONFIG_DIR` list, and passes the newest directory holding `sessions/` as `CODEX_HOME`. `CODEX_HOME` names one directory only, so codex rollouts spread over several config directories cannot be aggregated in one run.
- **It rides the dispatch tick.** Curia keeps one clock ([#345](https://github.com/alp82/curia/issues/345)). A publish files no ticket, so it runs beside the liveness sweep in the dispatcher's tick rather than behind a second timer. `aistack.interval_hours` bounds how often that tick spends a process, and the stack's own auto-sync frequency bounds how often a run publishes.
- **The command is pinned.** `aistack.cli_version` in `config/curia.yaml` names the version. The stock aistack hook runs `@latest`, which changes behavior on a box nobody touched.
- **A success says nothing.** Each run journals `aistack_sync` with the root counts and the published link. Only a failure reaches Discord, only when it is news, and it names the two commands that repair it. The alarm stands as `aistack_sync_failed` and a landed sync clears it, so a deploy repeats nothing.

What a sync can never show is bounded twice, and both bounds are the measured layer's: a torn-down config directory takes its transcripts with it, and the measured layer stores windows rather than increments.

#### Registering the box

Registration is a one-time operator ceremony, because the approval needs a signed-in browser. [Register the Curia box with aistack from Settings (#706)](https://github.com/alp82/curia/issues/706) took the ssh out of it, and `src/aistackreg.mjs` holds that half: **Settings → aistack** presses **Register this box**, the daemon spawns the same `login` below and shows the code and the approval link it prints, and the operator approves on whatever screen they are already holding. **Grant standing permission** is step 3 as a press. Who approves does not change — nothing on the box can do it, and the token the approval returns is written to a file under curia's own HOME that no response body ever carries.

The commands below are the same ceremony at a terminal, and the Settings section prints them too.

1. Start the device-code login. The command prints a code and a URL, then polls for three minutes.

   ```sh
   HOME=/home/alp/curia-work/home npx -y @use-aistack/cli@0.7.2 login
   ```

2. Open the URL on any machine, name the machine, pick the stack, and approve. The CLI writes the token to `<HOME>/.config/aistack/credentials.json`.

3. Grant the standing auto-sync permission on the stack. This path prompts for nothing, so it runs on a box with no terminal.

   ```sh
   HOME=/home/alp/curia-work/home npx -y @use-aistack/cli@0.7.2 sync --auto on
   ```

The daemon picks the credential up on its next tick, whichever way the ceremony ran. To revoke the machine, use `aistack.to/settings/machines` and delete the credentials file — Settings refuses a second registration while the credential is there, because a rival login would only mint a code beside a token that already works. Each run appends one line to `<HOME>/.config/aistack/sync.log`, which is the first place to read when the alarm fires.

### The Node pin

[The store's backup and the Node pin (#357)](https://github.com/alp82/curia/issues/357) rules it. [The daemon image takes Node 24 and sqlite3 (#409)](https://github.com/alp82/curia/issues/409) applied the first value. The journal sits on `node:sqlite`, which Node marks Stability 1.2, and a patch update can change the API, the defaults and the bundled SQLite engine.

**The pin is Node 24.19.0.** It is the version the [schema prototype](https://github.com/alp82/curia/blob/main/prototypes/journal-schema/) and the [guarantees research](../docs/research/node-sqlite-guarantees.md) both ran on.

One Node patch version runs every curia image. It is committed in two places, and it carries no default anywhere.

- `deploy/compose.yaml` passes `NODE_VERSION` to the daemon, the dashboard and the overseer from the `x-node-version` anchor. It is an anchor and not an interpolated variable, because the pin is committed and the `.env` file beside it is not.
- `config/curia.yaml` holds `sandbox.node_version` for the agent image, beside the other pins. It rides the image content address, so a bump names a tag the box does not have and the daemon rebuilds.
- The four Dockerfiles take `ARG NODE_VERSION` with no default. A build that forgets the arg then fails. This is the rule the agent Dockerfile already states for every other version it carries. A release build reads the value from `config/curia.yaml` through `deploy/bundle/pins.mjs`, so the two committed places stay two and the workflow adds no third.
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

### The goodbye (#458, deciding [#426](https://github.com/alp82/curia/issues/426))

A block ends when a human answers, or when the daemon dies. Before it dies, the daemon now ends every blocked call with a tool **error**. Three deaths say it: `POST /restart`, a SIGTERM from a deploy, and a fatal crash. A SIGKILL says nothing, and [#457](https://github.com/alp82/curia/issues/457) holds that case.

An error is the point. [#341](https://github.com/alp82/curia/issues/341)'s retry ladder needs a failure to retry, and a text result would read as an answer. That is the exact fault [#56](https://github.com/alp82/curia/issues/56) recorded from a live agent. A codex client has no transport-drop watchdog, so this error is the only thing that gives that agent its turn back inside a day (`docs/research/tool-channel-mid-session-codex.md`). The claude lane gains too: its two minutes become about one second, and `CODEX_TOOL_TIMEOUT_S` does not move.

Both wait registries wake: the escalation resolvers in `index.mjs`, and the cross-check park in `dispatch.mjs`. The escalation record stays **open**, because the question is still the operator's to answer. The agent asks again, and [#369](https://github.com/alp82/curia/issues/369) hands back an answer that landed in between. One `daemon_goodbye` event carries the reason and the count of calls woken, so the journal says what a restart cost. The exit waits about a quarter of a second for those errors to leave the socket, and only when a call was blocked at all. The words live in `daemon/src/goodbye.mjs`.

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
