# Curia

Curia is a personal orchestration daemon. It watches GitHub trackers, dispatches AI agents on tickets, and keeps a human in the loop from any device. This file gives a fresh session or a dispatched agent the vocabulary and the layout of the system.

## Language

### The loop

**Full loop**:
The one end-to-end pass through the system: frontier, dispatch, escalation and answer, review, merge, resolution, map update.
_Avoid_: golden thread (banned by the operator).

**Inner loop**:
The agent-side slice of the full loop: notify, a blocking question, the answer, resume, commit, result.

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
The map changes: new tickets, graduated fog, blocking edges, scope rulings. They land two ways. A ticket agent proposes them at the review gate and writes them after the approval. A charting agent writes them as its whole job.

**Map dispatch**:
`map <n>` on a map's own issue. The daemon spawns a charting agent instead of a ticket agent. It claims nothing. `start` on a map number is not this: it dispatches the map's next takeable ticket.

**New-map dispatch**:
`map [repo] <prose>` with no issue. The daemon spawns a charting agent that has no map. The agent settles the destination with the operator, then creates the `wayfinder:map` issue itself. The prose is mandatory here: it is the loose idea the charting starts from. The first word is the repo only when it names a watched repo, and it is the first word of the prose otherwise.

**Adoption**:
The act that gives a new-map dispatch its map. The agent calls `map_created` with the number. curia checks the issue is an open map in that repo, then takes it as the session's map: the thread moves onto it, `map <n>` on it is refused, and the charting summary lands there.

**Charting agent**:
The agent of a map dispatch. It edits the map and its tickets, and it never closes the map, opens a pull request, or passes a review gate. On a new-map dispatch it creates the map first.

**Instruction**:
The operator's sentence on a map dispatch, in their own words. It rides the `map` verb last, and reaches the charting agent as the first thing it reads. It needs no separator: the arguments come first, and the sentence runs from the first plain word to the end of the line. On an existing map it is optional: with none, the agent asks what should change. On a new map it is mandatory, because nothing else says what to chart. No other verb takes one.

**Frontier**:
The takeable tickets of a watched repo, in map order.

**Takeable**:
Open, not a pull request, no open blockers, no assignee.

**Lane**:
The rule that computes a repo's frontier. The map lane takes the children of open maps. The flat lane takes open `ready-for-agent` issues. A repo whose maps are all closed or deferred gets an empty frontier, never the flat fallback.

**Claim**:
The assignee on a ticket. A claim removes the ticket from every frontier. The daemon claims before it spawns. No dispatch ever claims a map: a map is never on a frontier, so a claim on one says nothing true.

**Map lock**:
What stops a second charting agent from editing one map body: the session name. A charting agent on map #147 is `curia-147`, and `map 147` is refused while that session lives. The check asks tmux, so it survives a daemon restart. It is per box, and there is one box.

**Watched repo**:
A repo on the watch list in `config/curia.yaml`. Curia dispatches only against watched repos.

**Tracker doc**:
`docs/agents/issue-tracker.md` in a watched repo. It tells agents how that tracker expresses maps, blocking, and resolution. A map child does not dispatch without it.

**Resolve protocol**:
The agent's three tracker writes: a resolution comment, the close, one map pointer.

**Map pointer**:
One line in the map's "Decisions so far": the ticket title as a link, plus a one-line gist.

**Resolved**:
Merged. A ticket counts as resolved only when a human approved the work and the code is in the default branch.

### Dispatch and routing

**Dispatch**:
The ordered act: claim, prepare, spawn. A failure before the spawn releases the claim.

**Routing rule**:
The label-based model choice. A `model:<x>` label wins, else the `wayfinder:<type>` default table. No intelligence sits in the dispatch path. `wayfinder:map` is a row in that table like any other type.

**Routing label**:
A key under `models:` in `routing.yaml`. It is the dispatch vocabulary that `model:<x>` and `/start <ticket> <label>` speak. It is not a model: the label `gpt` names the model `gpt-5.6-sol`.

**Model name**:
What curia tells a human is running. Best evidence first: the model the transcript states, then `models.<label>.id`, then the routing label. The status line and the composer-ready message say this. Cooling, fallback and the `status` list keep the routing label, because they speak about dispatch.

**Harness**:
The program an agent runs under: claude or codex. It is a function of the model: `models.<x>.harness` states one value, and no command overrides it. A pin that disagreed with the model built `codex --model opus`, which is not a model.
_Avoid_: backend, lane.

**Cooling**:
A temporary hold on a model or provider after a usage-limit signal, until the stated reset.

**Stated reset**:
The instant a cooling ends. Two surfaces state it, and curia reads both: the anthropic pane text carries an epoch beside the reached-text, and the codex transcript carries `resets_at` beside the rate-limit window that is spent. A cap is account-level, so any live agent on that provider states it for the harness. With neither surface stating one, cooling holds for one hour.

**Exhaustion**:
The state where every candidate model is cooling. The frontier stays the queue, and a wake timer fires at the earliest reset.

**Overseer**:
The command brain of curia. The standing design is one brain with three skins (Discord, text, voice). The shipped daemon uses a deterministic router instead.

**The verbs**:
`tickets`, `next`, `status`, `start`, `map`, `cancel`, `resume`, `attach`, `review`. The whole command surface, identical over Discord and REST. Each verb has one meaning. `start` works a thing, and `map` updates a map.
_Avoid_: the five verbs (the pre-#81 count, wrong since `next`, `resume` and `review` joined).

**Resume**:
A fresh agent on a ticket whose agent is gone. It inherits the surviving worktree and the model of the last spawn, which the journal states. It never inherits the conversation. A live agent refuses it: `cancel <n>` is the way to end one.

**Cancel**:
The one act that ends a running agent. It kills the session, removes the worktree and releases the GitHub claim. It closes every open question of that agent, and the ticket goes back to the frontier. The word has one place: `cancel <n>` in the command channel. No button on a question ends anything.

### Agents

**Agent**:
One harness process, spawned per ticket, that works the ticket to its ending. It may spawn subagents of its own, which curia neither sees nor counts.
_Avoid_: worker (the old name, swept in #184).

**Session**:
The tmux session `curia-<n>`. The session name is the agent's identity everywhere.

**Chat handle**:
The name of an agent no issue answers for: `chat-1`, `chat-2`, the lowest free index at dispatch. It stands where a ticket number stands — the session `curia-chat-1`, the worktree, the thread, and the argument `attach`, `cancel` and `resume` take. Today one kind of agent uses it: the new-map dispatch.

**Agent host**:
The layer that hosts agent sessions and their attach: tmux, one shared ttyd, Tailscale Serve. Each pane runs one `docker run`, never the harness directly.
_Avoid_: substrate (banned by the operator).

**Private clone**:
The agent's own blobless clone, per ticket, on branch `curia/<n>`. The one workspace shape (#195).
_Retired_: **worktree** (a per-ticket worktree cut from a shared **base clone**) was the bare path's shape. A container cannot use one, whose `.git` points into a base clone it never sees, so #195 deleted both with the bare path and the box was cleaned by hand.

**Published port**:
One of the three loopback ports an agent's container publishes, the same number inside and out. The prompt names them, an agent binds its dev server to `0.0.0.0` on one of them, and that preview's identity proxy points at it. They are the whole bound on `publish_preview` for a sandboxed agent.

**Config dir**:
The agent's private config home for its harness. It holds the prompt, the skills, the harness settings, and on the claude path nothing else. It holds no credentials.

**Tool namespace**:
The MCP servers an agent can reach: curia's own, and nothing else. Two settings keys in the config dir hold that line. One stops the fetch of the operator's account-level claude.ai connectors, which follow the shared credential rather than the config dir. The other admits curia's server alone.

**Skills**:
The skill set curia symlinks into every agent's config dir, so an agent resolves in the same idiom as a hand session.

**Standing orders**:
The spawn prompt: parameters and bounds, not procedure. Procedure lives in the installed skills.

**Bounds**:
The hard limits in the standing orders. Read anything. Write only inside the worktree, the ticket, and the map subtree. No browser. Never answer for the human. A failed call is not an answer, and silence is not an answer.

**Harness settings**:
What curia writes so the harness itself starts quietly and bounded: no onboarding, the worktree pre-trusted, the permission mode, and the tool namespace. They live in the config dir.

**Connection settings**:
What curia writes so an agent reaches the side channel and the Stop hook: the MCP server URL, the agent token, and the Stop-hook command. Where they land is the harness's business — the claude path puts them in the worktree, the codex path in the config dir.

**Sandbox**:
The boundary around an agent: one Docker container per agent, holding its own clone and cfg dir and nothing else of the box. It denies host HOME, the daemon's secrets and state, sibling worktrees, and the tmux socket. The network stays open. The pane runs the container, so every attach surface is unchanged.

**Sandbox switch**:
`harnesses.<name>.sandbox` in `routing.yaml`: `docker` or `none`. Per harness. The claude harness is on and soaking, the codex harness follows.

**Agent image**:
The one image every agent container runs. It carries both harnesses at pinned versions and nothing per-ticket. Its tag is a content address over the Dockerfile and the pins, so a bump names an image the box does not have and the daemon rebuilds.

**Cache volume**:
A Docker volume shared by every agent for what is too heavy to bake into the image: the npm cache and the Playwright browsers. Cross-agent poisoning is an accepted risk.

**Side channel**:
The daemon's structured channel to an agent: the MCP tools and the Stop hook. Curia never parses the terminal to learn agent state.

**Spawn binding**:
The rule that an agent's repo and ticket come from the spawn record, never from the agent's own account.

**Exit marker**:
The nonce line the spawn wrapper echoes into the pane when the harness command ends, with its status. It is what tells a dead spawn apart from a slow one.

### The cross-check

**Cross-check**:
A second reading of a builder's diff by a model on the other provider. The operator asks for it. Nothing starts one by itself. See [ADR-0010](docs/adr/0010-the-cross-check.md).

**Builder**:
The agent that works a ticket, in the cross-check's vocabulary. It holds the ticket's claim and it stays alive while the reviewer reads.

**Reviewer**:
The agent of a cross-check. It reads the diff, the ticket and a checkout, runs the tests, and ends with the verdict. It writes nothing: no tracker write, no push, no merge, no gate, no preview and no question. Its session is `curia-review-<n>`, and it is attachable and sandboxed as any agent.

**Pairing table**:
The `review:` section of `routing.yaml`, keyed by the builder's provider. An anthropic builder gets `gpt`, an openai builder gets `opus`. A `review-model:<name>` label on the ticket beats it.

**Review checkout**:
The reviewer's own checkout, at `repos/<owner>__<repo>/review/<n>`. It is a detached HEAD at the pushed tip of `curia/<n>`, because git refuses the same branch in two worktrees. It carries no branch, so there is nothing in it to commit onto.

**Verdict**:
The reviewer's one output: the text of its `report_result` summary. The daemon captures it as `data/verdicts/<n>.json` and holds it for the return path. A verdict read on the builder's own provider carries the stamp "same provider — cross-provider was cooling" at its top, written by curia.

### Human in the loop

**Escalation**:
The durable record of one question from an agent to a human. It survives daemon restarts.

**ask_human**:
The blocking tool an agent calls to ask a question. Kinds: free-text, choice, approve-reject, preview-review. The call blocks until an answer arrives, hours included.

**Review gate**:
The one approval before a merge, and its own escalation kind. Only the daemon opens it, and it composes every link from its own records.

**Cross-check**:
The operator's third choice at the review gate. Curia spawns a reviewer on the other provider, and the verdict returns to the builder. The press answers neither way: nothing merges and nothing is rejected.

**Reviewer**:
The agent a cross-check spawns. It reads the diff, the ticket, and a checkout it can run. It writes nothing and it ends with its verdict.
_Avoid_: checker.

**Verdict**:
The reviewer's findings on one diff. It reaches the builder on its note queue, and it lands as a pull-request comment.

**Judgement**:
The builder's reading of a verdict. It agrees or disagrees with each finding and recommends what to do. It reaches the operator as a plain question, and it lands as the second pull-request comment.

**Parked**:
A builder idle inside its own `request_review` or `report_result` call while a cross-check reads. It holds its claim, its worktree and its slot, and it wakes when the verdict lands.

**Start notice**:
The message curia queues at the builder the moment a reviewer spawns. It names the reviewer and holds the ending: no resolve, no merge and no `report_result` until the verdict lands. A cross-check pressed at the gate sends none, because the builder is already parked.

**First-valid-wins**:
The answer rule. The first valid answer closes the escalation atomically. Any device may answer. Later answers get a refusal.

**Supersede**:
A re-asked question closes the older record and routes late answers to the live one.

**Nudge**:
The half-hour re-post of an open escalation into its thread.

**Bridge**:
The Discord module. It renders and captures. It never interprets.

**Thread-per-ticket**:
One Discord thread per ticket. It carries the ticket's escalations, notifies, and answers. The binding outlives the agent: it releases only when the ticket itself closes, so a resumed agent lands back in the same thread. Every path that resolves a thread goes back to the ticket's last thread first, and one ticket resolves one thread at a time, so a re-dispatch adds no second thread (#257). The name carries the state at a glance: 🎫 bound, ✅ finished, ⚰️ cancelled.

**Settling a thread name**:
Putting the terminal glyph on a thread whose ticket has ended (#257). A rename rides a budget of 2 per thread per 10 minutes, so a ✅ can wait, and the gate that holds it dies with the daemon. Two passes catch what is dropped. A release settles the ticket's last thread even when the binding is already gone. Every bridge start settles each active thread curia once labeled that is bound to nothing and still wears a live glyph.

**Voice ownership**:
The rule that divides the thread's speakers. CuriaBot states mechanics, the agent voice states meaning, and no fact is said twice in one thread. See [ADR-0013](docs/adr/0013-one-voice-per-fact.md).

**Failure line**:
The daemon's own message about a failure it hit. It is one sentence of prose, and the thread hears it once (#256). The raw error stays in the journal and in the reply the failing agent reads. A retry loop inside the repeat window adds nothing to the thread. A loop that outlasts the window says the line again with a count.
_Avoid_: error message (that names the raw text, which never reaches the thread).

**Speaker name**:
The webhook username an agent speaks under: its session name, and nothing else. Discord caps the username at 80 characters, so a name that carries more can truncate, and a truncated identity is a mangled one (#254). The label says who speaks. The thread says which ticket.

**Notify**:
A fire-and-forget line of agent prose into the ticket thread.
_Avoid_: status line (that names the daemon's own line, below).

**Operator note**:
Text the operator types in an agent's thread while no escalation is open. It belongs to the instance it was typed at and dies with it. It has two delivery modes, and the operator picks.
_Avoid_: message, comment.

**Queued**:
The default delivery mode. The note rides the agent's next tool result, and nothing owes a reply. The receipt carries the "Ask now" button, and no drain receipt follows.

**Ask now**:
The other delivery mode, and the button under the receipt that picks it. The current tool call gets a grace of a few seconds, then the note goes into the pane as a user turn. The agent's own reply is the outcome. [ADR-0013](docs/adr/0013-one-voice-per-fact.md) names the mechanics an interrupt, and so do the code and the journal.
_Avoid_: interrupt on the operator's surfaces (it reads as an ending, and no button ends an agent).

**Verdict carrier**:
The whole verdict, posted into the thread when no agent is left to read it. It names the reviewer, its model, its findings and the pull request that holds the full text. A verdict is never mourned in one line.

### The ending

**Ending**:
The ordered close-out of a ticket: commit, pull request, preview, review gate, merge, resolve, result. One structure drives both the prompt and the Stop hook checklist.

**Ending receipt**:
The one CuriaBot message that ends a ticket thread. In small print, it merges what the tracker step did with what the session teardown did. It carries no bare link. The agent's own report is the message before it, and that report is where the pull request unfurls. See [ADR-0013](docs/adr/0013-one-voice-per-fact.md).

**Charting ending**:
The ending of a map dispatch: edit the map, then report the result. Curia posts the summary on the map. No unassign, no pull request, no review gate, no close.

**New-map ending**:
The charting ending with one step in front: create the map, adopt it with `map_created`, then report the result. The Stop hook holds the agent to the adoption, because it is the one fact the daemon cannot read for itself.

**Stop hook**:
The enforcement hook that fires at the end of every agent turn. It refuses a stop that leaves ending steps open, up to the stop budget, then lets go and reports the ticket unfinished.

**Stop budget**:
How many times the Stop hook may refuse one agent's stop (`stop_nudge_budget`).

**Landing**:
The daemon's push of `curia/<n>` and the open or update of the one pull request per ticket. Agents never push.

**Workspace lease**:
The hold on a worktree and branch until the pull request is positively merged. Every uncertain case keeps the workspace.

**Repair**:
The daemon's completion of resolve-protocol steps the agent missed, recorded as repairs.

### Surfaces

**Attach**:
Joining a live agent from a device. One verb, two handles: the timeline link and the terminal link.

**Terminal surface**:
The shared ttyd page over Tailscale Serve. The raw TUI, honest for one device at a time.

**Timeline**:
The grid-free attach surface. It reads the agent's transcript and writes with tmux send-keys. The timeline is where you drive. The terminal is where you go to see the TUI itself.

**Transcript**:
The harness's own append-only run log. It carries no geometry, so any device lays it out at its own width.

**Preview**:
A tailnet HTTPS link to an agent's running dev server. The daemon allocates the public port and composes the link.

**Serve rule**:
One `tailscale serve` handler. It lives in tailscaled and outlives the daemon, so reconcile sweeps stale rules.

**Identity check**:
The rule every surface curia publishes through Serve admits a caller by: not a Funnel request, a Host this box serves, and a `Tailscale-User-Login` on the allowlist. Tailscale Serve stamps that login and overwrites a forged one, so a tailnet client cannot fake it. It fails closed. One allowlist covers the terminal, the timeline and previews alike.

**Identity proxy**:
The daemon's loopback proxy that carries the identity check for a surface with nowhere to put one. The terminal's Serve rule points at the proxy, never at ttyd. A preview rule points at one of its own, never at the dev server, and its port is derived from the preview's Serve port. The timeline applies the same check in-process.

**Escalation overlay**:
Open escalations shown on the timeline from the daemon's record, because a transcript is silent while a question blocks.

**Dialog guard**:
The timeline's refusal to send text while a native terminal dialog holds the pane.

**Status line**:
One Discord message per agent, written by the daemon, that says what the agent is doing now. A state change reposts it at the thread bottom. Everything else edits it in place.

**Meter**:
A number the status line carries beside the state: the model name, its reasoning effort, the context percent, and the account usage bars. Each meter has its own source and drops alone when that source is silent. Meters drop from the tail when the line runs out of columns. The model is the exception: the escalation title is cut to keep it.

**Account bars**:
The 5-hour and 7-day usage windows. They are an account fact, not an agent fact, so every agent on a provider shows the same reading. The provider follows from the agent's harness, never from the routing label: a label is a spawn-time fact and a harness has on-disk evidence. A window whose reset has passed rolls over — the bar shows the fresh window at 0%, and that reading counts as stale at once, so the next probe measures it.

**Pace**:
Usage measured against the time already gone from its window. A bar shows the window's clock as `┃` and renders spending past it as overshoot. The square before the bar states the same fact at a glance: 🟩 behind the clock, 🟨 on it, 🟥 ahead.
_Avoid_: usage (that is the raw percent, which says nothing about speed).

**Context percent**:
How full an agent's context window is. The numerator is the last request's input tokens from the transcript. The denominator comes from the best source that has one: the window the codex transcript states, then `max_input_tokens` from `GET /v1/models/<id>` for the model id the claude transcript names, then `models.<name>.context_window`. It is never clamped — a figure above 100% says the denominator is wrong, not that the agent is full.

### State and evidence

**Journal**:
`daemon/data/events.jsonl`. Append-only, and the daemon's only durable artifact. In-memory state is a reduction over it.

**State home**:
The one durable place a fact lives. GitHub holds ticket truth. The journal holds curia's events. Everything in memory is a disposable cache.

**Reconcile**:
The pass, at boot and on demand, that re-derives live state from GitHub, tmux, and the journal, and asserts the surfaces. An agent it re-adopts gets its spawn-time facts back from the journal: the routing label it runs on, and the harness under it.

**Epoch**:
A ticket's latest dispatch. Journal reads count only events from the latest epoch.

**Spawn line**:
An `agent_spawned` event. It describes the agent whole, as it runs from that moment. One dispatch writes more than one of them, because a respawn down the fallback chain writes another. A respawn states every dispatch-time fact again, so the last line wins for every reader.

**Orphan**:
A live `curia-` session that every watched repo positively disowns. Reconcile sweeps it, unless it holds a result or unpushed work.

**Dead claim**:
A claim with no live session and no close behind it. Reconcile releases it, unless an open pull request marks the ticket awaiting review.

**Evidence rule**:
A failed read is not evidence. Only a positive "absent" narrows a set. Anything else is indeterminate and fails the pass.

**Live check**:
A first-person report of what an agent experienced during a live run, committed under `docs/live-checks/`.

**Spike**:
Throwaway prototype code that answers one named question, under `spikes/`, with its report under `docs/research/`.

## Components

One box runs everything. Phones and PCs are pure clients on the tailnet.

- **Daemon** (`daemon/`): one Node process, no build step. It owns dispatch, escalations, routing, previews, the attach surfaces, and reconcile.
- **Bridge**: the Discord module inside the daemon. Thread-per-ticket rendering, buttons, image passthrough both directions.
- **Router**: the deterministic command router inside the daemon. It parses the five verbs from Discord slash commands or REST.
- **Agents**: one harness process per ticket, in tmux sessions named `curia-<n>`. A cross-check adds a reviewer beside one, in `curia-review-<n>`.
- **Surfaces**: the shared ttyd terminal and the timeline, both published with Tailscale Serve. Previews take their own port range.
- **Config** (`config/`): `curia.yaml` (watch list, dispatch, attach, skills) and `routing.yaml` (models, defaults, fallbacks, the cross-check pairing).

## State homes

- **GitHub**: ticket state, labels, claims, sub-issue parentage, map bodies, branches, pull requests. The source of truth.
- **Journal** (`daemon/data/events.jsonl`): every durable curia event.
- **Verdicts** (`daemon/data/verdicts/`): one captured cross-check verdict per ticket, held for the return path.
- **tmux**: the live agent sessions.
- **tailscaled**: the Serve rules for attach, timeline, and previews.
- **Workspace root** (`~/curia-work`): private clones, review checkouts, agent config dirs.
- **Host credential stores** (`~/.claude`, `~/.codex`): the overseer's, which runs on the host and holds no copy. A dispatched agent is in a container and cannot reach them, so it gets the model credential copied into its container environment.
- **docker**: the live agent containers and the two shared cache volumes.

Everything else is a cache that reconcile can rebuild.

## Docs

- `docs/adr/`: one file per standing decision, indexed at `docs/adr/README.md`.
- `docs/research/`: research notes, one per investigation, indexed at `docs/research/README.md`.
- `docs/live-checks/`: first-person agent evidence.
- `docs/agents/`: tracker, triage, and domain-doc conventions for agents.
- `docs/full-loop.md`: the rehearsal record of the PoC map. History, not a live procedure.

The tracker holds history. The docs hold what still constrains work.
