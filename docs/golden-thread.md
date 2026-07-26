# Golden-thread rehearsal script

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
| Demo ticket | `alp82/alperortac.com#48` — *Author subpage: Curia*, child of map #42 |
| Backup ticket | `getalfredo/landing-page#88` — *Prototype: Day one two-column split*, child of map #81 |

**Why #48 is the demo ticket.** It forces every leg rather than hoping for it: its body says
*"Content from Alper (source of truth) … Do not invent copy"*, so the worker **must** call
`ask_human` — the escalation leg cannot be skipped by a worker that decides it knows enough. It is
visual work with a dev server (`bun --bun vite dev --port 3015`), so the preview leg is natural. It
is a map child, so the map-update leg fires. And `bun` lives at `/usr/bin/bun`, unlike `node`, which
on this box comes from an fnm multishell path that is only as durable as the shell that started the
daemon.

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
6. **Pre-warm the base clone.** First dispatch for a repo does a full `gh repo clone`, and the worker
   then runs `bun install` before it can serve anything. Cold, that is minutes of dead air in the
   middle of the demo. Warm it:
   `gh repo clone alp82/alperortac.com /home/alp/curia-work/repos/alp82__alperortac.com/base`
   (the daemon fetches an existing clone instead of re-cloning), then `bun install` inside it once so
   the package cache is hot.
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

**Phone, #curia:** `/start` with ticket `alp82/alperortac.com#48`.

Dictate the ticket argument with the keyboard mic rather than typing it (the voice leg, #30 — voice
is phone keyboard dictation, not a separate grammar; whatever the mic produces is ordinary command
text). If the dictation garbles the slug, that *is* the result to record — retype and note it.

Expect, in order:
- an immediate reply naming the model the routing rule picked (**fable**) and the session `curia-48`;
- the GitHub issue assigned to `alp82` (the claim, taken **before** the spawn);
- a worktree at `/home/alp/curia-work/repos/alp82__alperortac.com/wt/48` on branch `curia/48`;
- a `worker_ready` within ~45s.

### 3 — Attach from the PC to the live session

**Phone:** `/attach 48` → a `https://alppc.tail3b99f1.ts.net:8443/?arg=curia-48` link.

**PC:** open that same URL in a browser. Both devices are now on **one** tmux session — this is the
same-live-session leg. Type a character on the PC and watch it appear in the phone's view (and vice
versa) to prove it is one PTY and not two views.

Leave the PC attached for the rest of the run; it is the window into what the worker is doing.

### 4 — Escalation, answered from the phone

The worker reaches the copy question it cannot answer alone and calls `ask_human`.

Expect a thread named for ticket 48 in #curia, with the question rendered by kind (free-text → reply
in thread; choice → numbered options; approve-reject → buttons; preview-review → buttons + link;
review-gate → buttons + the links curia composed).

**Phone:** answer in the thread — **dictate this one** if the `/start` dictation was typed. The
worker is blocked in the tool call while this sits there; the daemon keeps the MCP stream alive so
the 300s client abort never fires.

Expect the worker to resume in the attached terminal within seconds of the answer landing.

Optional, if the moment is right: attach a screenshot to the thread reply. It arrives in the
worker's context as a real image block, not a file path.

### 5 — Preview, opened from the phone

The worker starts `bun --bun vite dev --port 3015` in its worktree and calls `publish_preview(3015)`.

Expect a `🔗 preview` message in the thread carrying
`https://alppc.tail3b99f1.ts.net:85xx/` — the daemon allocated the public port, not the worker.

**Phone:** open the link. The subpage renders over the tailnet. This is the leg that makes the work
reviewable from the phone rather than merely reported on.

If the worker gets absorbed in building and never publishes, nudge it in the thread — *"start the
dev server and publish a preview"* — rather than counting the leg failed; the tool description tells
it how, and a nudge through the escalation surface is itself part of the thread.

### 6 — The pull request, and the review gate

Since [#54](https://github.com/alp82/curia/issues/54) the worker does not resolve anything until a
human has approved it, and `resolved` means **merged**.

The worker commits, calls `open_pull_request` (curia pushes `curia/48` and opens the PR — the worker
never pushes), then calls `request_review`.

Expect in the thread: a **[esc-n] curia-48 asks for review** message carrying the worker's summary,
the **concrete charting it proposes for the map**, and the links curia composed itself — ticket, pull
request with its live state, preview.

**Phone:** reply in the thread with one change to make. That reply is a **rejection**, and the
worker gets your words back verbatim. Expect it to commit again, call `open_pull_request` again
(the **same** PR is updated, never a second one), and re-ask.

**Phone:** now press **✅ Approve**. Only the button approves; any reply is feedback.

### 7 — Merge, resolve, and the map

Expect the worker to merge its own PR (`gh pr merge … --squash --delete-branch` — the one write to
the remote it owns, and only what was just approved), then run the resolve step of the skill it is
running: resolution comment → close → one line appended to map #42's `## Decisions so far` → the
charting it got approved. Then `report_result` once.

Expect, in the thread:
- `🏁 curia-48 reports resolved: …`;
- the outcome line from the daemon's verify-and-repair pass: ticket closed, map #42 updated,
  **code merged**;
- `🏁 curia-48 finished … <PR> is merged — worktree removed, remote curia/48 deleted`.

Expect on GitHub: PR merged into `main`; issue #48 closed with a resolution comment; map #42
carrying a new Decisions-so-far pointer; the `curia/48` branch gone.

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
