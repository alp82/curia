# Landing page positioning

**Settled**: 2026-08-01, in [Pin the pitch: reader, promise, defensible claims](https://github.com/alp82/curia/issues/110),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).
Every answer below came from the operator over Discord escalations.

This file is the brief the page is written against. Copy, layout and proof tickets defer to it.
If a later ticket contradicts something here, change this file in that ticket — do not let the page
and the brief drift apart.

## The reader

**A builder who already runs coding agents most days, across several repos, and keeps hitting the
moment where the work stops because they are not at their desk.**

They run Claude Code or Codex. They do not need coding agents explained, and a page that explains
them is a page written for somebody else. They self-host by preference: their box, their
subscription, their keys.

Ruled out, on purpose:

- The curious reader who runs one agent now and then. Selling parallel agents first would cost the
  page its edge, and a page that hedges between the two is the boring one.
- The homelab reader who wants to own infrastructure and treats agents as secondary.
- Any portfolio audience. This page sells software the reader installs, not the operator's rig.

## The one promise

**Many repos, one queue, driven from a phone.**

The first screen makes this promise and no other. The reader's tickets sit across every repo they
watch; curia reads what is takeable in dependency order, runs the work, and brings every moment
that needs a human to whatever device they are holding.

The three claims below support that promise. They are not co-headlines. Presence ("curia removes
the desk"), rigor ("a worker cannot finish by talking") and the dogfood run were each considered as
the headline and each demoted: presence and rigor to supporting claims, the dogfood run to proof.

## The three supporting claims

### 1. Your tracker is the queue

GitHub issues hold every ticket, claim and dependency edge. Curia reads what is takeable across
every watched repo, in dependency order, and picks the model for each ticket by label rule. No
second app. No board to keep in sync.

Rests on:

- [ADR-0001](../adr/0001-github-is-the-only-durable-state-home.md) — GitHub is the only durable
  state home; the daemon owns no authoritative state and re-derives everything after a crash.
- [ADR-0004](../adr/0004-label-only-routing.md) — label-only routing. No model sits in the dispatch
  path.
- `daemon/src/dispatch.mjs` — the frontier reads every watched repo, map lane before flat lane,
  dropping blocked and claimed tickets.
- `config/curia.yaml` — three repos watched today. `config/routing.yaml` — two backends, Claude Code
  and Codex, under one contract.

### 2. Any device is a full seat

Five verbs over Discord. One thread per ticket. Questions arrive with buttons, results arrive as
per-ticket HTTPS preview links, and a live worker can be attached from a phone or a desktop at the
same time. Four or more tickets have run at once on one small box, at about 0.5 GB per worker
measured.

Rests on:

- [The overseer rehearsal](../live-checks/96-overseer-rehearsal.md) — one unbroken pass driven from
  Discord: prose dispatch, a worker question answered in the thread, a button confirm, and the
  review gate approved.
- The operator's memory benchmark on `coinmatica.net`: four genuinely overlapping sessions, 733 MB
  peak total, ~0.5 GB per worker as the planning number, headroom for 40–50 concurrent workers on
  the 30 GB box before CPU or rate limits bind.
- The operator's own runs: four or more curia workers alive at once on real tickets.
- [ADR-0003](../adr/0003-tmux-ttyd-tailscale-worker-host.md),
  [ADR-0005](../adr/0005-escalation-contract.md).

### 3. A worker cannot finish by talking

Nothing lands without the reader's approval. Every ticket ends the same way: commit, pull request,
live preview, review gate, merge. A rejection comes back as their own words and turns into new
commits on the same pull request. A stop hook refuses a worker that tries to quit early.

Rests on:

- [ADR-0008](../adr/0008-resolved-means-merged.md) — resolved means merged; the ending is one
  structure, rendered as both the worker's orders and the stop hook's checklist.
- [The merge-gated ending](../live-checks/54-merge-gate.md) — written from inside the ending by the
  worker living through it, rejection loop included.
- The second live check, where the stop hook caught a planted protocol skip — recorded in the same
  file, from [Live check 2 (#62)](https://github.com/alp82/curia/issues/62), commit `d3b118a`.

This is the claim that keeps the page out of the agent-swarm genre. No page selling autonomy makes
it.

## Held back as proof, not claims

Settled in [Decide what proof of curia working goes on the page](https://github.com/alp82/curia/issues/114).
The proof brief is [`proof.md`](proof.md); what follows is what became of each item.

- **This page was charted, decided and written by curia itself** — workers dispatched from a Discord
  thread, grilling the operator, opening pull requests, and merging on approval. **On the page**, as
  a line pointing at the merged pull requests, each stamped by the daemon with its session and model.
- **The rehearsal survived two daemon restarts inside one pass** — one while a worker's question was
  open, one while the review gate was open. Both recovered. **Not on the page.** It stays where it is
  above, backing claim 2.
- **A question held open for almost eight hours resumed cleanly.** Recorded in
  [`docs/live-checks/56-gateway-crash.md`](../live-checks/56-gateway-crash.md), not `README.md` as
  this brief previously said. **Not on the page**, and not because it is untrue: the same file
  records a `request_review` that dropped after about 4 hours 22 minutes in the same run, and the
  journal no longer reaches 27 July, so neither figure can be re-verified. The pull-request trail
  carries endurance instead.

The page shows, besides those: **four frames of one real ticket** on a repo other than this one,
captured by the operator on a phone, in a strip after the three claims; and **a dated stats line** a
worker regenerates from GitHub and the journal. `proof.md` holds the detail.

## What the page is honest about

Three things a reader finds out sooner or later, so the page says them first:

- Curia is eleven days old. First commit 2026-07-21.
- One person runs it. There are no other users.
- Setup is manual today: Node, tmux, Tailscale, a Discord bot, an agent CLI, a GitHub repo. It gets
  simpler, and the page does not promise packaging it has not shipped.

**Where it sits: straight after the three claims, before the guide.** The reader learns why they
would want curia, then what it costs. Putting it on the first screen spends the opening on an
apology; putting it only in the guide reads evasive to the sceptical reader this page is for.

## What the page never sounds like

### Banned words

supercharge · unleash · effortless · seamless · revolutionary · game-changing · 10x · blazing-fast ·
enterprise-grade · production-ready · vibe coding · swarm · agent army · agent workforce ·
"while you sleep".

Two with reasons worth keeping:

- **"AI-powered"** — the reader already runs agents. The phrase is aimed at someone else.
- **"autonomous"**, in every form. Curia is the opposite of autonomous by design: the human approval
  is the point, and claim 3 says so.

### Banned moves

- **No "just" or "simply" in the guide.** Setup is not simple today. Pretending otherwise is what
  makes a reader stop trusting everything else on the page.
- **No fake proof.** No logo wall, no testimonials, no "trusted by", no star count, no "join
  thousands of developers". Nobody but the operator runs curia yet.
- **No first-claims.** [The landscape scan](../research/landscape-scan.md) lists OpenHands, Orca and
  two working Discord-to-Claude-Code bridges. The page never says first, only, or the only one.
  What it may claim is the combination — routing dispatcher, two-way Discord approval, multi-device
  attach, self-hosted — which nothing else ships whole.
- **No internal vocabulary as sales words.** Full loop, wayfinder, frontier, escalation, charting.
  Precise for us, opaque to a first-time reader. Golden thread and substrate stay dead per
  `CONTEXT.md`.

### The two failure modes

From the map, in the operator's words. The page is checked against both before it ships:

1. **Generic and over-promising** — reading like every other AI-agent landing page, obviously
   machine-written. The banned list, the no-first-claims rule and the honesty block exist for this.
2. **Honest but boring** — nobody understands why they would want it. The throughput promise and
   the concrete numbers exist for this.

Polish and shipping speed are the lesser risks.
