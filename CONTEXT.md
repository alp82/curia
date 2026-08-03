# Curia

Curia is a personal orchestration daemon. It watches GitHub trackers, dispatches AI agent workers on tickets, and keeps a human in the loop from any device. This file gives a fresh session or a dispatched worker the vocabulary and the layout of the system.

## Language

### The loop

**Full loop**:
The one end-to-end pass through the system: frontier, dispatch, escalation and answer, review, merge, resolution, map update.
_Avoid_: golden thread (banned by the operator).

**Inner loop**:
The worker-side slice of the full loop: notify, a blocking question, the answer, resume, commit, result.

**Rehearsal**:
A scripted live run of the full loop on real repos. It proves every leg in one unbroken pass.

### Tickets and maps

**Ticket**:
A GitHub issue in a watched repo. The unit of dispatch.
_Avoid_: task.

**Map**:
A GitHub issue labeled `wayfinder:map`. It indexes decisions and points to the child tickets that hold their detail.

**Map child**:
A ticket whose parent issue is a map.

**Fog**:
The map section "Not yet specified": work that is coming but not yet sharp enough to state as a ticket.

**Charting**:
The map changes a worker proposes at the review gate: new tickets, graduated fog, blocking edges, scope rulings.

**Frontier**:
The takeable tickets of a watched repo, in map order.

**Takeable**:
Open, not a pull request, no open blockers, no assignee.

**Lane**:
The rule that computes a repo's frontier. The map lane takes the children of open maps. The flat lane takes open `ready-for-agent` issues. A repo whose maps are all closed or deferred gets an empty frontier, never the flat fallback.

**Claim**:
The assignee on a ticket. A claim removes the ticket from every frontier. The daemon claims before it spawns.

**Watched repo**:
A repo on the watch list in `config/curia.yaml`. Curia dispatches only against watched repos.

**Tracker doc**:
`docs/agents/issue-tracker.md` in a watched repo. It tells agents how that tracker expresses maps, blocking, and resolution. A map child does not dispatch without it.

**Resolve protocol**:
The worker's three tracker writes: a resolution comment, the close, one map pointer.

**Map pointer**:
One line in the map's "Decisions so far": the ticket title as a link, plus a one-line gist.

**Resolved**:
Merged. A ticket counts as resolved only when a human approved the work and the code is in the default branch.

### Dispatch and routing

**Dispatch**:
The ordered act: claim, prepare, spawn. A failure before the spawn releases the claim.

**Routing rule**:
The label-based model choice. A `model:<x>` label wins, else the `wayfinder:<type>` default table. No intelligence sits in the dispatch path.

**Backend**:
The agent CLI a worker runs under: claude or codex.
_Avoid_: worker lane.

**Cooling**:
A temporary hold on a model or provider after a usage-limit signal, until the stated reset.

**Exhaustion**:
The state where every candidate model is cooling. The frontier stays the queue, and a wake timer fires at the earliest reset.

**Overseer**:
The command brain of curia. The standing design is one brain with three skins (Discord, text, voice). The shipped daemon uses a deterministic router instead.

**The five verbs**:
`frontier`, `start`, `status`, `cancel`, `attach`. The whole command surface, identical over Discord and REST.

### Workers

**Worker**:
One agent CLI process, spawned per ticket, that works the ticket to its ending.
_Avoid_: agent (that names the CLI product, not the process curia spawns).

**Session**:
The tmux session `curia-<n>`. The session name is the worker's identity everywhere.

**Worker host**:
The layer that hosts worker sessions and their attach: bare tmux, one shared ttyd, Tailscale Serve.
_Avoid_: substrate (banned by the operator).

**Worktree**:
The worker's per-ticket git worktree, on branch `curia/<n>`, cut from a shared base clone.

**Base clone**:
The one daemon-owned clone per watched repo. Its push URL is disabled.

**Config dir**:
The worker's private agent config home. It holds the prompt, the skills, and the harness. It holds no credentials.

**Skills**:
The skill set curia symlinks into every worker's config dir, so a worker resolves in the same idiom as a hand session.

**Standing orders**:
The spawn prompt: parameters and bounds, not procedure. Procedure lives in the installed skills.

**Bounds**:
The hard limits in the standing orders. Read anything. Write only inside the worktree, the ticket, and the map subtree. No browser. Never answer for the human. A failed call is not an answer, and silence is not an answer.

**Harness**:
The per-backend files curia writes so a worker reaches the side channel and the Stop hook.

**Side channel**:
The daemon's structured channel to a worker: the MCP tools and the Stop hook. Curia never parses the terminal to learn worker state.

**Spawn binding**:
The rule that a worker's repo and ticket come from the spawn record, never from the worker's own account.

**Exit marker**:
The nonce line the spawn wrapper echoes into the pane when the backend command ends, with its status. It is what tells a dead spawn apart from a slow one.

### Human in the loop

**Escalation**:
The durable record of one question from a worker to a human. It survives daemon restarts.

**ask_human**:
The blocking tool a worker calls to ask a question. Kinds: free-text, choice, approve-reject, preview-review. The call blocks until an answer arrives, hours included.

**Review gate**:
The one approval before a merge, and its own escalation kind. Only the daemon opens it, and it composes every link from its own records.

**Cross-check**:
The operator's third choice at the review gate. Curia spawns a reviewer on the other provider, and the verdict returns to the builder.

**Reviewer**:
The worker a cross-check spawns. It reads the diff, the ticket, and a checkout it can run. It writes nothing and it ends with its verdict.
_Avoid_: checker.

**Verdict**:
The reviewer's findings on one diff. It reaches the builder, and it lands as a pull-request comment.

**First-valid-wins**:
The answer rule. The first valid answer closes the escalation atomically. Any device may answer. Later answers get a refusal.

**Supersede**:
A re-asked question closes the older record and routes late answers to the live one.

**Nudge**:
The half-hour re-post of an open escalation into its thread.

**Bridge**:
The Discord module. It renders and captures. It never interprets.

**Thread-per-ticket**:
One Discord thread per ticket. It carries the ticket's escalations, notifies, and answers. The binding outlives the worker: it releases only when the ticket itself closes, so a resumed worker lands back in the same thread.

**Notify**:
A fire-and-forget line of worker prose into the ticket thread.
_Avoid_: status line (that names the daemon's own line, below).

### The ending

**Ending**:
The ordered close-out of a ticket: commit, pull request, preview, review gate, merge, resolve, result. One structure drives both the prompt and the Stop hook checklist.

**Stop hook**:
The enforcement hook that fires at the end of every worker turn. It refuses a stop that leaves ending steps open, up to the stop budget, then lets go and reports the ticket unfinished.

**Stop budget**:
How many times the Stop hook may refuse one worker's stop (`stop_nudge_budget`).

**Landing**:
The daemon's push of `curia/<n>` and the open or update of the one pull request per ticket. Workers never push.

**Workspace lease**:
The hold on a worktree and branch until the pull request is positively merged. Every uncertain case keeps the workspace.

**Repair**:
The daemon's completion of resolve-protocol steps the worker missed, recorded as repairs.

### Surfaces

**Attach**:
Joining a live worker from a device. One verb, two handles: the timeline link and the terminal link.

**Terminal surface**:
The shared ttyd page over Tailscale Serve. The raw TUI, honest for one device at a time.

**Timeline**:
The grid-free attach surface. It reads the worker's transcript and writes with tmux send-keys. The timeline is where you drive. The terminal is where you go to see the TUI itself.

**Transcript**:
The agent CLI's own append-only run log. It carries no geometry, so any device lays it out at its own width.

**Preview**:
A tailnet HTTPS link to a worker's running dev server. The daemon allocates the public port and composes the link.

**Serve rule**:
One `tailscale serve` handler. It lives in tailscaled and outlives the daemon, so reconcile sweeps stale rules.

**Identity check**:
The rule both attach surfaces admit a caller by: not a Funnel request, a Host this box serves, and a `Tailscale-User-Login` on the allowlist. Tailscale Serve stamps that login and overwrites a forged one, so a tailnet client cannot fake it. It fails closed.

**Identity proxy**:
The daemon's loopback proxy that carries the identity check for ttyd, which has nowhere to put one. The terminal's Serve rule points at the proxy, never at ttyd. The timeline applies the same check in-process.

**Escalation overlay**:
Open escalations shown on the timeline from the daemon's record, because a transcript is silent while a question blocks.

**Dialog guard**:
The timeline's refusal to send text while a native terminal dialog holds the pane.

**Status line**:
One Discord message per worker, written by the daemon, that says what the worker is doing now. A state change reposts it at the thread bottom. Everything else edits it in place.

**Meter**:
A number the status line carries beside the state: the model, its reasoning effort, the context percent, and the account usage bars. Each meter has its own source and drops alone when that source is silent.

**Account bars**:
The 5-hour and 7-day usage windows. They are an account fact, not a worker fact, so every worker on a provider shows the same reading.

**Pace**:
Usage measured against the time already gone from its window. A bar shows the window's clock as `┃` and renders spending past it as overshoot. The square before the bar states the same fact at a glance: 🟩 behind the clock, 🟨 on it, 🟥 ahead.
_Avoid_: usage (that is the raw percent, which says nothing about speed).

**Context percent**:
How full a worker's context window is. The numerator is the last request's input tokens from the transcript. The denominator is the window the codex transcript states, or `models.<name>.context_window` for the claude lane.

### State and evidence

**Journal**:
`daemon/data/events.jsonl`. Append-only, and the daemon's only durable artifact. In-memory state is a reduction over it.

**State home**:
The one durable place a fact lives. GitHub holds ticket truth. The journal holds curia's events. Everything in memory is a disposable cache.

**Reconcile**:
The pass, at boot and on demand, that re-derives live state from GitHub, tmux, and the journal, and asserts the surfaces.

**Epoch**:
A ticket's latest dispatch. Journal reads count only events from the latest epoch.

**Orphan**:
A live `curia-` session that every watched repo positively disowns. Reconcile sweeps it, unless it holds a result or unpushed work.

**Dead claim**:
A claim with no live session and no close behind it. Reconcile releases it, unless an open pull request marks the ticket awaiting review.

**Evidence rule**:
A failed read is not evidence. Only a positive "absent" narrows a set. Anything else is indeterminate and fails the pass.

**Live check**:
A first-person report of what a worker experienced during a live run, committed under `docs/live-checks/`.

**Spike**:
Throwaway prototype code that answers one named question, under `spikes/`, with its report under `docs/research/`.

## Components

One box runs everything. Phones and PCs are pure clients on the tailnet.

- **Daemon** (`daemon/`): one Node process, no build step. It owns dispatch, escalations, routing, previews, the attach surfaces, and reconcile.
- **Bridge**: the Discord module inside the daemon. Thread-per-ticket rendering, buttons, image passthrough both directions.
- **Router**: the deterministic command router inside the daemon. It parses the five verbs from Discord slash commands or REST.
- **Workers**: one agent CLI process per ticket, in tmux sessions named `curia-<n>`.
- **Surfaces**: the shared ttyd terminal and the timeline, both published with Tailscale Serve. Previews take their own port range.
- **Config** (`config/`): `curia.yaml` (watch list, dispatch, attach, skills) and `routing.yaml` (models, defaults, fallbacks).

## State homes

- **GitHub**: ticket state, labels, claims, sub-issue parentage, map bodies, branches, pull requests. The source of truth.
- **Journal** (`daemon/data/events.jsonl`): every durable curia event.
- **tmux**: the live worker sessions.
- **tailscaled**: the Serve rules for attach, timeline, and previews.
- **Workspace root** (`~/curia-work`): base clones, worktrees, worker config dirs.
- **Host credential stores** (`~/.claude`, `~/.codex`): shared with workers. Workers hold no copy.

Everything else is a cache that reconcile can rebuild.

## Docs

- `docs/adr/`: one file per standing decision, indexed at `docs/adr/README.md`.
- `docs/research/`: research notes, one per investigation, indexed at `docs/research/README.md`.
- `docs/live-checks/`: first-person worker evidence.
- `docs/agents/`: tracker, triage, and domain-doc conventions for agents.
- `docs/full-loop.md`: the rehearsal record of the PoC map. History, not a live procedure.

The tracker holds history. The docs hold what still constrains work.
