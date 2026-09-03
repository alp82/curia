# Full-loop rehearsal script

> **Status**: rehearsal record of the PoC map. The run is complete. This file is history, not a live procedure.
>
> The **Test run** on the Setup screen is the acceptance form of this loop: it creates its own two-ticket map and drives each ticket through the same eight legs, then closes the map. See [Run the Test run](operator/guide/04-run-the-test-run.md).

The scripted end-to-end demo for map [#1](https://github.com/alp82/curia/issues/1), ticket
[#35](https://github.com/alp82/curia/issues/35). One pass proves the destination: phone → Discord →
frontier → dispatch → escalate → answer → review → merge → resolve → map → preview → attach, with one
command spoken rather than typed.

HITL: Alp drives. Nothing here is automated — the point is that a human on a phone can run the whole
thread.

## Cast

| Thing | Where |
|---|---|
| Box | `alppc` (`100.89.145.33`), tailnet `tail3b99f1.ts.net` — **not** Hetzner; deployment is parked |
| Daemon | `npm start` in `daemon/`, `http://127.0.0.1:4271` |
| Discord | guild **AI Stack**, channel **#curia**, thread-per-ticket |
| Attach | `https://alppc.tail3b99f1.ts.net:8443/?arg=curia-<n>` (shared ttyd) |
| Preview | `https://alppc.tail3b99f1.ts.net:85xx/` (allocated per preview, 8500–8599) |
| Demo ticket | `alp82/alperortac.com#67` — *TEST: the run scoreboard at /curia-check*, child of test map #66 |
| Backup ticket | a second child of test map #66 — create one, do not spend a real ticket |

**Why #67 is the demo ticket.** #35's two tickets are both closed, and this run deliberately spends
**no real work**: map #66 and ticket #67 are disposable fixtures created for the rehearsal, on a real
project repo so the merge leg is real. #67 still forces every leg rather than hoping for it:

- **The escalation cannot be skipped.** The page's leg names are Alp's and are *not in the repo*, so
  a worker that decides it knows enough has nothing to decide from. The shape question (chip
  right-aligned vs its own column) is a second thing only Alp can answer.
- **The preview is forced, not natural.** The worker has no browser (#49 forbids it one), so the page
  can only be judged on Alp's screen through a published Serve link.
- **The rejection is expected.** The ticket says so in its own body, so the loop is exercised on a
  ticket carrying a **live dev server and a published preview** — the gap #54's markdown-file
  rejection left open.
- **The charting is real.** #67 is a child of map #66, whose *Not yet specified* holds two fog
  patches — where the scoreboard's state comes from, and the teardown that deletes the route. The
  worker must graduate at least one into a concrete ticket, and that proposal is what Alp judges on
  the phone at the gate.

**A finding the ticket choice surfaced.** `getalfredo/landing-page#105` looked like the better visual
demo and is undispatchable: it requires driving chrome over a devtools socket, which the standing
orders forbid outright (*you have no browser and must not build one*). Any measure-it-in-the-browser
ticket is refused by construction today.

**Clean-up after the run.** Close map #66 and delete the `/curia-check` route. Both are fixtures.

Routing: `wayfinder:prototype` → **fable** (no `model:` override on the ticket), backend `claude`.

## Preflight (PC, before Alp picks up the phone)

Each line must pass. A failure here is a setup problem, not a demo result.

1. **Phone on the tailnet.** `tailscale status | grep pixel` — must not say `offline`. This is the
   one precondition that is usually wrong: the phone drops off the tailnet when idle. Open the
   Tailscale app on the phone and confirm it is connected.
2. **ttyd up.** `pgrep -af ttyd` → one process on `-p 7681` with `-O` and `-a`.
3. **Attach Serve rule up.** `tailscale serve status` → `:8443` proxying `127.0.0.1:7681`.
4. **Daemon up and bridged.** `npm start` in `daemon/`; the log must show
   `bridge ready: guild=AI Stack channel=#curia`. Without that line the phone has no surface.
5. **Frontier answers.**
   `curl -s -X POST localhost:4271/command -H 'Content-Type: application/json' -d '{"text":"frontier"}'`
   → both demo repos with takeable items.
6. **Pre-warm the package cache.** Every dispatch makes its own blobless clone (#195), and the agent
   then installs before it can serve anything. Cold, that is minutes of dead air in the middle of the
   demo. The clone itself cannot be warmed — it is per ticket and `--filter=blob:none` already makes
   it seconds — so warm what is slow: run the repo's install once on the box, into the shared npm
   volume the agent containers mount. Each clone gets its own empty `node_modules`, so what this
   warms is the **package cache**, not the agent's tree.
7. **Expect the dev port to move.** Alp's own dev servers usually hold `:3015` (alperortac.com) and
   `:3055` (landing-page) in his working trees, so the worker's Vite will bind the next free port
   instead. That is fine and is exactly why `publish_preview` takes the port the worker *actually*
   bound rather than a per-repo configured one (#40).
8. **~~Answer promptly during the run.~~** No longer a constraint since #53: a worker shares the
   host's credential store (`CLAUDE_SECURESTORAGE_CONFIG_DIR`) instead of holding a snapshot taken at
   spawn, so a block that outlives a token refresh resumes on the refreshed token rather than dying
   on its next model turn with `OAuth session expired` (#34). An hour is now fine.

## The script

### 1 — Frontier, from the phone

**Phone, #curia:** `/frontier`

Expect one block per watched repo: `getalfredo/landing-page` (map lane) and `alp82/alperortac.com`
(map lane) each listing takeable tickets, `alp82/curia` (flat lane). This is the awareness leg:
dependency-ordered frontiers across two projects, read out of GitHub, on a phone.

Blocked and claimed tickets must be **absent** — that is the map lane doing its job, not a filtered
list.

### 2 — Dispatch, spoken

**Phone, #curia:** `/start` with ticket `alp82/alperortac.com#67`.

Dictate the ticket argument with the keyboard mic rather than typing it (the voice leg, #30 — voice
is phone keyboard dictation, not a separate grammar; whatever the mic produces is ordinary command
text). If the dictation garbles the slug, that *is* the result to record — retype and note it.

Expect, in order:
- an immediate reply naming the model the routing rule picked (**fable**) and the session `curia-67`;
- the GitHub issue assigned to `alp82` (the claim, taken **before** the spawn);
- a worktree at `/home/alp/curia-work/repos/alp82__alperortac.com/wt/67` on branch `curia/67`;
- a `worker_ready` within ~45s.

### 3 — Attach from the PC to the live session

**Phone:** `/attach alp82/alperortac.com#67` → a `https://alppc.tail3b99f1.ts.net:8443/?arg=curia-67` link.

**PC:** open that same URL in a browser. Both devices are now on **one** tmux session — this is the
same-live-session leg. Type a character on the PC and watch it appear in the phone's view (and vice
versa) to prove it is one PTY and not two views.

Leave the PC attached for the rest of the run; it is the window into what the worker is doing.

### 4 — Escalation, answered from the phone

The worker reaches the question it cannot answer alone — the leg names are not in the repo, and the
shape is a two-way choice it is forbidden to make — and calls `ask_human`.

Expect a thread named for ticket 67 in #curia, with the question rendered by kind (free-text → reply
in thread; choice → numbered options; approve-reject → buttons; preview-review → buttons + link;
review-gate → buttons + the links curia composed).

**Phone:** answer in the thread — **dictate this one** if the `/start` dictation was typed. The
worker is blocked in the tool call while this sits there; the daemon keeps the MCP stream alive so
the 300s client abort never fires.

Expect the worker to resume in the attached terminal within seconds of the answer landing.

Optional, if the moment is right: attach a screenshot to the thread reply. It arrives in the
worker's context as a real image block, not a file path.

### 5 — Preview, opened from the phone

The worker starts `bun --bun vite dev` in its worktree and calls
`publish_preview(<the port it actually bound>, <the path of the page it changed>)`. Alp's own dev
server holds `:3015`, so Vite will move to the next free port — which is the whole reason the tool
takes the bound port (#40). The path is the other half (#68): without it every composed link opens
the site root, which is how the last re-run sent three review gates to an untouched homepage.

Expect a `🔗 preview` message in the thread carrying
`https://alppc.tail3b99f1.ts.net:85xx/<path>` — the daemon allocated the public port, not the worker,
and it composed the link from its own record rather than from anything the worker wrote.

**Phone:** open the link. The subpage renders over the tailnet. This is the leg that makes the work
reviewable from the phone rather than merely reported on.

If the worker gets absorbed in building and never publishes, nudge it in the thread — *"start the
dev server and publish a preview"* — rather than counting the leg failed; the tool description tells
it how, and a nudge through the escalation surface is itself part of the thread.

### 6 — The pull request, and the review gate

Since [#54](https://github.com/alp82/curia/issues/54) the worker does not resolve anything until a
human has approved it, and `resolved` means **merged**.

The worker commits, calls `open_pull_request` (curia pushes `curia/67` and opens the PR — the worker
never pushes), then calls `request_review`.

Expect in the thread: a **[esc-n] curia-67 asks for review** message carrying the worker's summary,
the **concrete charting it proposes for the map**, and the links curia composed itself — ticket, pull
request with its live state, preview.

**Phone:** reply in the thread with one change to make. That reply is a **rejection**, and the
worker gets your words back verbatim. Expect it to commit again, call `open_pull_request` again
(the **same** PR is updated, never a second one), and re-ask.

**Phone:** now press **✅ Approve**. Only the button approves; any reply is feedback.

### 7 — Merge, resolve, and the map

Expect the worker to merge its own PR (`gh pr merge … --squash --delete-branch` — the one write to
the remote it owns, and only what was just approved), then run the resolve step of the skill it is
running: resolution comment → close → one line appended to map #66's `## Decisions so far` → the
charting it got approved. Then `report_result` once.

Expect, in the thread:
- `🏁 curia-67 reports resolved: …`;
- the outcome line from the daemon's verify-and-repair pass: ticket closed, map #66 updated,
  **code merged**;
- `🏁 curia-67 finished … <PR> is merged — worktree removed, remote curia/67 deleted`.

Expect on GitHub: PR merged into `main`; issue #67 closed with a resolution comment; map #66
carrying a new Decisions-so-far pointer; the `curia/67` branch gone.

Expect on the box: the preview Serve rule withdrawn (`tailscale serve status` no longer lists the
8500-range port), the tmux session gone, the worktree gone, the attach rule on 8443 untouched.

**If the worker tries to stop with a step outstanding**, curia's Stop hook refuses the stop and lists
what is missing — up to `stop_nudge_budget` times (3), after which it lets go and says the ticket is
unfinished. Seeing one of those refusals in the pane is a pass, not a fault.

### 8 — Close the loop

**Phone:** `/status` → `💤 no live workers`. While the gate was open it read **awaiting-review**.

## Pass bar

The thread passes when all eight hold in one unbroken run:

1. Frontier reported across **both** demo repos from the phone.
2. `/start` dispatched, and the **routing rule** picked the model — not Alp.
3. The worker escalated to Discord and the answer resumed it.
4. One **rejection** at the review gate looped back into new commits on the **same** pull request,
   and the approval came from the phone.
5. The ticket resolved: closed, with a resolution comment, over **merged** code.
6. The parent map gained its Decisions-so-far pointer.
7. A preview link opened **on the phone**.
8. The PC attached to the **same** live tmux session the phone dispatched.

Plus: at least one command or answer spoken rather than typed.

A leg that fails is a finding, not a stop — record what happened and keep going; the run is worth
more than a clean sheet.

## Repairs the rehearsal forced before it could run

Both surfaced only by pointing the preview leg at a **real project** dev server; #40's live check used
a worker-started server that happened to bind IPv4 and was reached by IP, so neither could appear.

1. **`publish_preview` refused a dev server that was running.** Vite v8 binds `[::1]` and not
   `127.0.0.1`; the registry probed IPv4 only and pointed the Serve rule at IPv4 only. Fixed in
   `preview.mjs` — `localhostTarget` probes both families and the rule points at whichever answers.
   The IPv6 case goes out as `localhost` rather than `[::1]`, because tailscale stores a bracketed
   literal as `http://::1:<port>` and the proxy then 500s. Containment is unchanged: refusals are by
   port, not by address.
2. **The page came back "Blocked request".** Tailscale Serve preserves the original Host header and
   Vite's host check rejects `alppc.tail3b99f1.ts.net`. There is no `--allowedHosts` CLI flag in Vite
   8, so it is a per-repo opt-in: `server.allowedHosts: ['.ts.net']`, now committed to both demo
   repos. **Any watched repo serving previews needs this line.**

Verified live afterwards, through the real registry against a real Vite server: probe → `localhost`,
rule published on `:8500`, `GET https://alppc.tail3b99f1.ts.net:8500/` → **200** with the real page,
clean withdrawal.

## Known limits going in

These are already-recorded decisions, not surprises to discover mid-run:

- **Runs on `alppc`, not Hetzner.** Deployment is parked on the map. The thread proves the
  architecture; the box is a later move.
- **Claude-only routing.** `research` → opus rather than gpt is a stated #33 deviation;
  [#39](https://github.com/alp82/curia/issues/39) restores the gpt lane. The routing *rule* is what
  this demo exercises, and it is real either way.
- **The overseer is a deterministic router,** not an NL agent session (#18 deviation) — the five
  verbs are the surface.
- **Attach auth is tailnet membership only.** Out of scope for the PoC by explicit ruling.
- **Discord voice-memo STT is not built.** Dictation is phone-keyboard, per #30.
