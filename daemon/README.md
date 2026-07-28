# curia daemon

The always-on daemon from map decision [#9](https://github.com/alp82/curia/issues/9): worker-facing MCP surface + Discord bridge module + durable escalation record ([#31](https://github.com/alp82/curia/issues/31)) + the dispatch loop ([#33](https://github.com/alp82/curia/issues/33)). Substrate-agnostic — workers connect over streamable-HTTP MCP regardless of how they were spawned (#29).

## Run

```
npm install
npm start          # reads daemon/.env
npm test           # unit tests (frontier / routing / commands)
```

`.env` (never committed):

- `DISCORD_BOT_TOKEN` — CuriaBot token. Omit to run REST-only (escalations stay answerable via `POST /answer`).
- `DISCORD_ALLOWED_USERS` — comma-separated Discord user ids; the auth gate. The bridge refuses to start if empty.
- `CURIA_GUILD_ID` (optional — defaults to the bot's first guild), `CURIA_CHANNEL` (default `curia`), `PORT` (default 4271), `NUDGE_MS` (default 30 min).

Config (validated on load; a bad shape refuses the boot): `../config/curia.yaml` (watch list, dispatch settings — `auto_dispatch` ships `false` — attach ports, preview range, worker skill set) and `../config/routing.yaml` (label-only model routing, fallback chains, backend command templates). Override the directory with `CURIA_CONFIG_DIR`.

## Surfaces

- `POST /mcp?worker=<name>&ticket=<n>` — MCP tools `ask_human` (blocking), `notify`, `report_result`, `publish_preview` (#40, `path` since #68), `open_pull_request` and `request_review` (#54). Ticket binding rides the spawn URL (#11). `ask_human` and `notify` also take `images: [<path>]` (#34).
- `GET /state` — open escalations + bridge status.
- `POST /escalate` — synthetic escalation (testing / non-MCP emitters); `?wait=1` blocks until answered.
- `POST /answer {id, answer, attachments?}` / `POST /cancel {id}` — same first-valid-wins gate as Discord.
- `POST /worker_done?worker=` — Stop-hook webhook (#29); closes the dispatch lifecycle (result recorded ⇒ clean close; result-less ⇒ abnormal exit, session kept for post-mortem).
- `POST /command {text}` — canonical command text, REST parity with the Discord slash verbs.
- `POST /reconcile` — on-demand reconcile (boot reconcile runs automatically).

## The five verbs (Discord slash commands or `POST /command`)

- `frontier [owner/repo]` — takeable tickets per watched repo (map lane with deferred-map skip and multi-map union, or flat `ready-for-agent` lane per watch-entry `mode`).
- `start <n>` / `start owner/repo#<n>` (`model=x backend=y` optional) — claim the GitHub issue, carve a worktree off the daemon-owned base clone under `workspace_root`, spawn a Claude Code worker in tmux `curia-<n>` with a pre-seeded `CLAUDE_CONFIG_DIR` (no first-run dialogs), watch for readiness. Anomalies (assigned/blocked/already-live) ask for an approve-reject confirm first.
- `status` — live workers + tmux cross-check.
- `cancel <n>` — confirm-then-teardown: kill session, remove worktree, unassign (re-frontier).
- `attach <n>` — `https://<tailnet-dns>:<serve_port>/?arg=curia-<n>` via the shared ttyd; `bin/curia-attach.sh` whitelists `^curia-[A-Za-z0-9._-]+$` (hard requirement — ttyd `-a` would otherwise hand out attach to any tmux session). ttyd also runs with `-O` (`--check-origin`): without it any web page open on any tailnet-connected device could hijack a worker's terminal cross-origin, since the victim's browser supplies the network position. What `-O` actually enforces (verified in ttyd's `src/protocol.c`) is `Origin == Host` — a same-origin *browser* control, not an allowlist: a mismatched `Origin` is refused at the WebSocket upgrade, but a DNS-rebinding page whose Host and Origin match each other passes. Auth in front of ttyd (basic-auth / identity header) remains deferred.

## Preview links (#40, implementing #8)

The worker runs its dev server on localhost and calls `publish_preview(dev_port, path?)`; the **daemon** allocates an HTTPS Serve port from `preview.port_from`–`port_to` (config, default 8500–8599) and asserts `tailscale serve --bg --https=<port> http://127.0.0.1:<dev-port>`, returning `https://<box>.<tailnet>.ts.net:<port><path>`. Many previews run in parallel — the 443/8443/10000 cap is Funnel-only.

`path` (#68) is the page to look at, and it rides the preview **record**, so the review gate and the `🔗 preview` notify both render it and it survives a re-ask. Without it the link opens the site root, which is how #65 sent three review gates to an untouched homepage. It is a display suffix on a rule that already proxies the whole dev server, so it grants no new reach — but it must not move the link off this box, so a path is resolved and anything that changes the origin is refused: `//evil.com/x`, `https://evil.com/x`, `\evil.com/x`, and `box.ts.net:8500/x`, which parses as a scheme. Re-publishing the same dev port with a new path **moves** the link rather than returning the old one, because correcting a wrong link is why the call is made twice.

The worker never picks the public port, because `tailscale serve` will publish **any** localhost port to the whole tailnet and the daemon's own API is a localhost port. The registry is where that is contained: curia's own surfaces (daemon port, ttyd port, attach Serve port) are refused outright — publishing the daemon port would put `/answer`, `/command` and `/escalate` on the tailnet unauthenticated — and the dev port must be a **live** listener, so a rule can never be pointed at a port something else may bind later. Config validation also refuses a preview range containing `attach.serve_port`, which the sweep would otherwise withdraw.

Lifecycle: the rule is withdrawn when the ticket ends — clean finish, result-less exit, or `/cancel` — and reconcile sweeps anything in range that no live `curia-<n>` session claims. That sweep is the only thing that can see a rule left by a **previous** daemon process, since `tailscale serve --bg` config lives in tailscaled, not here; an indeterminate `serve status` skips the sweep rather than reading as "no live tickets" and withdrawing previews under review.

Verified live: refusals for all three curia surfaces and for a dead port; a worker that started its own dev server, published it, and had the page load **on the phone** over the tailnet; a second concurrent preview taking the next port; both sweep branches (kept while its session lives, withdrawn once nothing claims it) with the attach rule untouched throughout. Previews inherit attach's tailnet-membership-only posture — the hardening deferral in the map's Out of scope covers both.

## What a worker knows (#57)

`seedConfigDir` symlinks the configured skills into `<CLAUDE_CONFIG_DIR>/skills/`, so a worker resolves in the same idiom a hand session does instead of being told about skills in its prompt (#49). Config is `skills.root` + `skills.install` in `curia.yaml`; the default list is `wayfinder`, `grilling`, `domain-modeling`, `research`, `prototype`, `implement`, `tdd`, `code-review`, `diagnosing-bugs`. The charting-and-PM skills (`to-tickets`, `triage`, `to-spec`, `handoff`) are withheld — `to-tickets` is mass ticket creation in the hands of a worker that carries charting authority.

Two of the nine — `wayfinder` and `implement` — carry `disable-model-invocation: true`: they are not listed to the model and its Skill tool refuses them (`cannot be used with Skill tool`). Installing them is still required, because a prompt whose **first line** is `/wayfinder` does load the skill (verified live), while naming it in prose does not. That is a constraint the spawn prompt must satisfy (#54).

Symlinks, not copies: a worker never writes a skill, so the version tracks the host with no snapshot to go stale — the opposite of the credential case (#53), where the worker *does* write and a symlink was replaced by a regular file. The links are rebuilt on every seed, so a reused config dir keeps no skill that has left the list. A name in `install` that has no `SKILL.md` under the root **refuses the boot**, naming the path: a worker that silently lacks a configured skill is the failure this replaced. Nothing else comes from the host — no `CLAUDE.md`, no allowlist, no MCP connectors, no saved permission mode (#23/#29).

Dispatch also asserts the tracker prerequisite: a **map child** whose worktree carries no `docs/agents/issue-tracker.md` is refused before the claim is kept, because the wayfinder skill would follow its own instruction to fall back to the local-markdown tracker and write `.scratch/` files instead of resolving on GitHub. A plain `ready-for-agent` ticket invokes no such skill and still dispatches — the flat lane watches *any* plain repo (#10) — with a `tracker_doc_missing` journal line.

## State posture

`data/events.jsonl` is the only durable artifact — an append-only journal; in-memory state is a pure reduction over it, rebuilt on boot. Open escalations survive daemon restarts with their Discord message ids intact (the rebooted process still honors clicks on messages posted before the restart — verified live). The pending-resolver map and ticket→thread cache are ephemeral (#9); a restart loses only the in-process worker call (accepted re-dispatch posture, #11/#12).

Supersede (#29): a re-issued `ask_human` (same worker + same payload while an older escalation is open) closes the old record, strips its buttons in Discord, and routes late answers to the live successor.

## Blocking for hours (#34)

The daemon holds a blocked `ask_human` indefinitely — Node's `requestTimeout` covers only request *receipt*, so nothing server-side expires the held response. The client is what needed handling: **Claude Code aborts an MCP tool call after 300s of server silence** (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`), which killed every real worker five minutes in — twenty-five minutes before the #11 re-nudge could ever fire.

The fix is a daemon-side keepalive on the MCP stream (`MCP_KEEPALIVE_MS`, default 60 s): progress notifications when the client offered a `progressToken` (Claude Code does), logging notifications otherwise. It is client-agnostic on purpose — every worker lane curia has evaluated speaks MCP, and none of them should need a bespoke env var to make blocking work.

Verified live in two runs, because one run cannot show both halves (see the credential note below, which is why the 38-minute run ended as it did): a worker held **38 min** with its MCP socket still established and the 30-minute re-nudge firing on schedule, and a second held **435 s** — past the same 300 s mark — then released with an unguessable token that it echoed back verbatim, proving the answer reaches the worker intact after a long hold. The tokenless branch is covered by test only: the daemon keeps sending, but no real client that omits `progressToken` has been observed honouring it.

**A block used to be bounded by the worker's credentials rather than by the daemon — fixed in #53.** `seedConfigDir` used to *copy* the host's `.credentials.json` into each worker at spawn, so a worker held a credential **snapshot**, and the 38-minute run above outlived its own: the answer arrived, the blocked call returned, and the worker then died on its next model turn with `OAuth session expired and could not be refreshed`. The cause was not the length of the block but the copy — Claude Code refreshes by writing a temp file and renaming it over the store, so the host's first refresh rotated the token server-side and the worker's frozen copy became dead paper.

Workers now **share the host's credential store** instead of snapshotting it: `workerEnv` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the host's `~/.claude` while `CLAUDE_CONFIG_DIR` keeps everything else per-worker, so a worker sits on the host's exact credentials path — one file, one refresh lineage, the same atomic rename, and a ~2 s mtime poll on both sides that picks up whichever process refreshed last. That is precisely what a second host session does, which is why several host sessions coexist for days. Either side may refresh, so an idle host no longer strands a worker and vice versa. A worker's config dir now holds **no credential of its own**, so the `removeCredentials` call and the reconcile sweep are pre-#53 leftover collectors rather than a live deletion owner; the planned auth-health watchdog (#21, #28) is retired as mis-framed — there is nothing left to watch.

The cost, accepted deliberately: a worker can now reach the host's real credential file, so it has a host session's blast radius there (a `/logout` would log the human out) rather than only its own copy's.

## Images, both directions (#34)

Amends the #11 payload contract:

- **Outbound** (worker → human): `images: [<path>]` on `ask_human` / `notify`. A worker may publish only from inside its own worktree and the daemon's data dir — resolved through `realpath`, so a symlink planted in the worktree cannot exfiltrate arbitrary files through the daemon's Discord token. Non-images, oversized files (>8 MB) and anything past the fourth are refused with a reason handed back to the worker; the message still goes.
- **Inbound** (human → worker): Discord attachments are downloaded under `data/attachments/<esc-id>/` (names sanitized to a leaf — `..` used to be able to walk out) and returned as real MCP `image` content blocks, so the picture lands in the worker's context. Verified live through the bridge's own download path — a screenshot attached to a thread reply, described in detail by a worker whose transcript shows exactly three tool calls and no `Read`, against a tool result carrying one `image` block. Anything unreadable, oversized (>5 MB) or not an image degrades to a visible `[attachment: <path>]` line rather than vanishing.

Attachment paths are part of the durable record, so a replayed answer keeps its images. Outbound is verified live end to end — a real worker's `notify` image rendered inline in the thread, while the same worker's attempt to publish `/etc/hostname` came back `refused — not a readable path inside this worker's workspace` with the message still delivered.

First-valid-wins (#11/#31) is verified live across two devices: Approve on the phone and Reject on the PC, one `esc_answer` in the journal, and the loser told `⚠️ not open — answered (answer was reject)` in an ephemeral reply rather than left guessing.

Dispatch state follows the same posture (#33): the workers map is a disposable in-memory cache. Reconcile (boot + on demand) re-derives it from GitHub claims, `tmux ls` and the journal — epoch-scoped (journal events only count against a ticket's latest dispatch), orphan sessions swept and dead claims released only on positive gh evidence, open overseer confirms voided on boot (the resolver died with the old process). Provider/model cooling is in-memory only and expires at the provider's stated reset (or a journalled 1 h fallback).

Deferred: voice-memo STT (text parity is the PoC floor, #31 scope note); the overseer NL agent session — canonical text currently routes to the deterministic in-daemon command router (stated #18 deviation); the gpt/codex backend lane (a config addition to `routing.yaml` once its follow-up ticket lands).
