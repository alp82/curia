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

**Decision ticket**:
The vendored wayfinder skill's word for a map child whose resolution is a decision, not a slice of a build to execute. curia keeps it (#286). It is a subset of **Ticket**, never a synonym: a flat-lane ticket decides nothing, and a map whose Notes carry execution ships build tickets. Use it where the map plans.

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
The agent of a map dispatch. It edits the map and its tickets, and it never closes the map. On a new-map dispatch it creates the map first.
It also burns down the research tickets it just created, one `/research` subagent each. For those tickets it takes the ordinary ending: one pull request on `curia/<map>`, the review gate, the merge, then the close. It resolves nothing else, and it closes nothing before the merge.

**Burn-down**:
What a charting session does with the research tickets it just created. One `/research` subagent per ticket, claimed before its subagent starts and released if that subagent fails. Every subagent works in the charting agent's own worktree, writes one note under `docs/research/`, and never runs git. The charting agent commits once, writes the index rows itself, and reads the findings together before the gate.

**Charting write bound**:
`docs/research/` and nothing else on disk. The charting worktree is writable, narrowed to that one directory. Curia refuses a pull request from a charting agent whose branch touches any other file.

**Instruction**:
The operator's sentence on a map dispatch, in their own words. It rides the `map` verb last, and reaches the charting agent as the first thing it reads. It needs no separator: the arguments come first, and the sentence runs from the first plain word to the end of the line. On an existing map it is optional: with none, the agent asks what should change. On a new map it is mandatory, because nothing else says what to chart. No other verb takes one.

**Frontier**:
The takeable tickets of a watched repo, in map order.

**Two-level frontier**:
The frontier plus the tickets each of its members directly unblocks. One level, never a chain. It is what the dashboard draws as a tree, and it comes from the blocking edges the agent-only count already reads.

**Frontier snapshot**:
The two-level frontier as reconcile last computed it, under the instant it did. Reconcile computes it, because that pass already holds the GitHub credentials and the dashboard holds none. The stamp is what makes a served frontier honest: the page states the age of the reading.

**Takeable**:
Open, not a pull request, no open blockers, no assignee.

**Lane**:
The rule that computes a repo's frontier. The map lane takes the children of open maps. The flat lane takes open `ready-for-agent` issues. A repo whose maps are all closed or deferred gets an empty frontier, never the flat fallback.

**Claim**:
The assignee on a ticket. A claim removes the ticket from every frontier. The daemon claims before it spawns. No dispatch ever claims a map: a map is never on a frontier, so a claim on one says nothing true.

**Map lock**:
What stops a second charting agent from editing one map body: the session name. A charting agent on map #147 is `curia-147`, and `map 147` is refused while that session lives. The check asks tmux, so it survives a daemon restart. It is per box, and there is one box.
A charting session that researched holds this lock, and an agent slot, through its whole review. Charting is no longer a fast act. The operator accepted that price ([ADR-0008](docs/adr/0008-resolved-means-merged.md)).

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

**Auto-dispatch**:
The `dispatch.auto_dispatch` flag. The dispatch tick runs either way, because the liveness sweep rides it. While the flag is true, that same tick also starts takeable tickets, the map lane first, up to `max_concurrent`. It ships false, so the operator's press is the only door from a ticket to an agent.
A takeable ticket whose worktree still stands is resumed, and never started: `start` recreates the worktree from origin and takes every uncommitted file with it. The path is the evidence, as it is for `resume` and `resume all`. The thread says curia resumed rather than started, and the journal records an `auto_resume`. See [#376](https://github.com/alp82/curia/issues/376).
It is also the only door a clock could use. curia refuses scheduled tickets for that reason: a schedule that files one is auto-dispatch with a calendar in front of it. The demand behind the idea is a watch, not a clock. A watch states one event at its own instant, where the operator reads it. See [#345](https://github.com/alp82/curia/issues/345).
_Avoid_: scheduler, cron.

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
A temporary hold on a model or provider after a usage-limit signal, until the stated reset. It survives a restart: the daemon journals every landed cap with its reset instant, and it seeds the hold back from the journal as it starts, before it takes a command. A hold whose reset passed while the daemon was down binds nothing. Only time ends a cooling. No command clears one by hand, so a wrong hold stands until its reset, which is the stated instant or one hour for a guess.

**Stated reset**:
The instant a cooling ends. Two surfaces state it, and curia reads both: the anthropic pane text carries an epoch beside the reached-text, and the codex transcript carries `resets_at` beside the rate-limit window that is spent. A cap is account-level, so any live agent on that provider states it for the harness. With neither surface stating one, cooling holds for one hour.

**Exhaustion**:
The state where every candidate model is cooling. The frontier stays the queue, and a wake timer fires at the earliest reset. Exhaustion that stops a LIVE agent also arms a limit resume.

**Limit resume**:
The dispatch curia owes a ticket its own cooling stopped. Exhaustion kills the agent and releases the claim, and the worktree stands, so the resume is `resume` and never `start`: `start` recreates the worktree from origin and takes every uncommitted file with it. It is not gated on `auto_dispatch`, because that setting decides whether curia takes NEW work off the frontier and this puts back work the operator already ordered. A reviewer gets none, because the builder has already been told the reviewer ended. One arm buys one attempt, and a resume that walks back into the cap arms again from the fresh reset. The arm is journalled, so a daemon restart inside the window does not lose it. The thread carries the promise with the exhaustion and the outcome at the reset, and it says so when the resume cannot be made.

**Overseer**:
The command brain of curia. The standing design is one brain with three skins (Discord, text, voice). The shipped daemon uses a deterministic router instead.

**Overseer service**:
The container that hosts the overseer. One long-lived service beside the dashboard. It is never a pane and never one container per conversation, because the overseer is not shaped like an agent: it holds many conversations at once and it has no screen. It runs its own image, built from `deploy/overseer/Dockerfile`, which carries git, gh and a reading shell and no build toolchain — so the overseer reads every watched repo and runs no test suite. It is the one service off the host network: a shell in it reaches the daemon at `host.docker.internal` and no other surface on the box, and the daemon reaches it on one published loopback port. Compose owns its liveness, and the daemon only health-checks it. It serves two routes and no third: the health check, and one operator message. See [ADR-0015](docs/adr/0015-the-overseer-is-a-service.md), [#327](https://github.com/alp82/curia/issues/327) and [#314](https://github.com/alp82/curia/issues/314).

**Standing orders**:
The text the overseer model reads before every turn, plus the tool list that agrees with it. One function writes both, in `daemon/src/overseerprompt.mjs`, and a flag picks the posture: a shell for the overseer service, and the no-shell text the retired in-daemon host sent, kept as the pinned record. The shell posture states where the overseer checkouts are, that the checkout pass fetched them once before this turn, and that the overseer token cannot write. It is composed per turn, because the checkout path holds the workspace root and the watch list changes. It STATES the posture and enforces none of it, because a standing order cannot hold a shell. What enforces the posture is four controls: the read-only overseer token, the container, the ✅/❌ confirm on `cancel`, and the tool list. The rest are manners, and a shell undoes each in one command. The text never marks that difference itself, because a line naming an unenforced rule is a line hostile text can quote back. See [ADR-0014](docs/adr/0014-the-overseer-in-its-own-container.md) and [#328](https://github.com/alp82/curia/issues/328).
_Avoid_: system prompt (that names one of the two things this word covers, and the tool list is the other half).

**Conversation**:
One thread's exchange with the overseer. The daemon holds its state, so a conversation outlives the container that answers it. Every top-level Discord message opens a thread and starts a new conversation. The browser holds many of its own, and a new one is how the operator resets. Nothing expires a conversation on a timer. See [ADR-0016](docs/adr/0016-the-conversation-key.md).
_Avoid_: session (that names the tmux session, which is an agent's identity).

**Conversation key**:
The identity of one conversation. It keys the resume id, the notes waiting for the next turn, and the one-turn-at-a-time lock. It has two shapes that cannot collide: a Discord thread snowflake, which is all digits, and `console-<n>` for a browser conversation, which starts with a letter. A browser number is never reused, because a reused one would wake a deleted conversation's memory. The daemon owns the key, and the container never learns what one means. See [ADR-0016](docs/adr/0016-the-conversation-key.md).
_Avoid_: thread id (that names the Discord object, and only one shape of key is one).

**Single-use conversation thread**:
The rule that a conversation thread carries one thing. Work dispatched from a conversation takes over that same thread, renamed on purpose, rather than opening a second thread beside it. One exception stands: an issuing thread that already carries another ticket sends the work elsewhere, and breadcrumbs link both ends. The thread stays bound to the name the dispatch ran under for the whole session, so every line the agent says lands in it. curia charts a new map under a chat handle. The map number takes that thread through the journal when the session ends. See [#326](https://github.com/alp82/curia/issues/326).

**Turn**:
One operator message, answered. It is the unit the overseer works in, and nothing of the overseer runs between turns. One turn at a time per conversation, and no cap across conversations.
_Avoid_: using it for the model's own steps inside one message (`maxTurns` counts those).

**Turn request**:
How a message becomes a turn once the brain is in a container. The daemon posts one message to the overseer service on its published loopback port, and the container streams events back: the session id, the checkout verdict, then the answer. The container holds no conversation, because the resume id travels out with the message and the session id travels back. The model's verb tools reach the other way, over the same MCP side channel every agent container uses, so the daemon composes the canonical text itself and posts it to `/command`. Every effect crosses that one seam, and the ✅/❌ confirm on `cancel` survives the move. See [#314](https://github.com/alp82/curia/issues/314).
_Avoid_: turn (that is the operator's message, whoever answers it).

**Killed turn**:
A turn a restart ended before it answered. The routine deploy recreates the daemon and the overseer together, so both halves of a turn in flight die at once. The daemon journals the message when a turn starts and journals the end when it ends, so whatever is still open at a boot is what the restart killed.
_Avoid_: failed turn (that one ran and the model did not answer, and nothing is sent again for it).

**Replay**:
Sending a killed turn's message again, instead of asking the operator to type it twice. The test is the seam count: a turn that crossed `/command` zero times is sent again, and a turn that ran a verb is not — sending that one again would run the verb twice. curia sends one message again once, never twice, and it holds the replay if the conversation has already spoken, if the message is over fifteen minutes old, or if the container did not come back. Every turn it does not send again gets one line naming what that turn ran, and the operator decides. A Discord conversation reads that line in its thread. A browser conversation has no thread, so it reads it on its row in the Chat picker until it takes its next turn. See [ADR-0015](docs/adr/0015-the-overseer-is-a-service.md) and [#388](https://github.com/alp82/curia/issues/388).
_Avoid_: retry (that names the fallback the in-daemon host ran on a second model, and it is gone).

**Turn secret**:
What opens the daemon's verb tools to one turn of the overseer container. The daemon mints it per turn, hands it over inside the turn request, and forgets it when the turn ends. It is not an agent token: an agent's is a file, because a restarted daemon adopts the agents its predecessor spawned, and a turn survives no restart at all. See [#314](https://github.com/alp82/curia/issues/314).
_Avoid_: agent token (that one is per agent, on disk, and it opens a different route).

**Overseer checkout**:
The overseer's own blobless clone of one watched repo, at `<workspace_root>/overseer/repos/<owner>__<repo>`. It is a mirror of origin and holds nothing of its own: no git identity, no local commit, no branch to commit onto. It carries every ref — every branch, so `curia/<n>` is there while an agent works, plus every pull-request head, which is what stays readable after a merge deletes the branch. See [ADR-0014](docs/adr/0014-the-overseer-in-its-own-container.md) and the [live checks](docs/live-checks/312-overseer-checkouts.md).
_Avoid_: private clone (that is an agent's, per ticket, and it is a place to commit).

**Checkout pass**:
What the overseer container runs at the start of every turn, before the model: clone every watched repo that is missing, delete the clone of one nobody watches, and fetch the rest in parallel. The per-owner git routing is rewritten just before it, off the same watch list, so a repo the pass has never seen is fetched with the right token rather than with none. It is the whole reason every read inside one turn is consistent. The daemon asserts nothing about this tree. A repo whose fetch fails does not refuse the turn — the pass returns a verdict per repo, and the turn tells the model which checkout is stale and how old it is.

**Overseer token**:
The read-only GitHub token the overseer container holds, one fine-grained PAT per resource owner. It is the control that replaces the seam: the container has a shell, and a shell cannot mint a token. It lives in `daemon/.env.overseer` as `CURIA_OVERSEER_GH_TOKEN_<OWNER>`, a second env file the overseer service loads whole and the daemon only reads. Each tool picks its owner differently, so the container installs two halves: git takes one `credential.https://github.com/<owner>.helper` line per owner, and `gh` takes a shim, because it reads a single `GH_TOKEN`. The git half is written at container start and again at the start of every turn, off the watch list of that turn, so a repo added under a new owner is routed at the next message and needs no restart. The token itself cannot arrive that way: compose hands an env file to a container at CREATE, so an owner this container never held needs `.env.overseer` edited and the service recreated. That limit dies with the installation token, which is a file the daemon rewrites. See [ADR-0014](docs/adr/0014-the-overseer-in-its-own-container.md) and the [live checks](docs/live-checks/313-overseer-github-token.md).
_Avoid_: agent token (that one is per resource owner too, but it is read-write and it reaches an agent as `GH_TOKEN`).
[ADR-0018](docs/adr/0018-the-daemon-is-a-github-app.md) retires this PAT: the same read set becomes an installation token the daemon mints, and `.env.overseer` keeps only the model credential.

**GitHub App**:
Curia's one GitHub identity. The operator creates one app and installs it on each watched owner. The daemon holds its private key at `daemon/.curia-app.pem`, names it with `CURIA_GH_APP_ID` and `CURIA_GH_APP_KEY_FILE` in `daemon/.env.daemon`, and mints every GitHub token from it. The bot is `curia-sh[bot]`, and the app id is 4610603. Decided at [ADR-0018](docs/adr/0018-the-daemon-is-a-github-app.md). The operator's own steps are [docs/github-app.md](docs/github-app.md). Partly built: the minting core ships, and each holder cuts over on its own ticket.
_Avoid_: OAuth app.

**Installation token**:
What the daemon mints from the app key, one per resource owner and per role. Two roles: read-write for agents, read-only for the overseer. A minted token scopes down from what the installation grants, which is what lets one key hold both. It lives one hour, so a holder reads a file the daemon rewrites and never an environment variable frozen at spawn.
_Avoid_: app token (that name is the JWT the daemon signs, and a JWT mints installation tokens rather than reaching a repo).

**Credential watch**:
What tells the operator a GitHub token is dying, in time to mint a new one. The daemon probes every watched repo with the token that repo is read with, once at boot, once at every watch reload, and every six hours after that. It measures two facts and says both where the operator reads. The first is reach: a token that answers 404, 403 or 401 on a watched repo. The second is expiry, on a ladder of 14 days, 7, 3, 1 and expired. Each step is said once, in `#curia`, and it also stands on the dashboard Needs-you list until the reading clears. A step already said is never repeated, so a deploy is silent, and a line that did not reach Discord is re-said at the next pass and at bridge start. The expiry is keyed on the token and the reach on the token and the repo together, because one token covers every repo of an owner. It files no ticket and dispatches nothing, which is what keeps [#345](https://github.com/alp82/curia/issues/345)'s refusal of a scheduler intact. Lives in `daemon/src/tokenwatch.mjs`. See [#380](https://github.com/alp82/curia/issues/380).
_Avoid_: token alarm, expiry cron.
The expiry half is a PAT-only fact and it dies holder by holder as [ADR-0018](docs/adr/0018-the-daemon-is-a-github-app.md) cuts over: an installation token lives one hour and the daemon refreshes it, so its expiry is nothing the operator can act on and curia must never warn about one. The reach half survives for every holder and for the installation itself.

**The verbs**:
`tickets`, `next`, `status`, `start`, `map`, `cancel`, `resume`, `attach`, `review`. The whole command surface, identical over Discord and REST. Each verb has one meaning. `start` works a thing, and `map` updates a map.
_Avoid_: the five verbs (the pre-#81 count, wrong since `next`, `resume` and `review` joined).

**Resume**:
A fresh agent on a ticket whose agent is gone. It inherits the surviving worktree, the model of the last spawn, which the journal states, and the inherited exchange (#374). It never inherits the conversation. A live agent refuses it: `cancel <n>` is the way to end one.

**Cancel**:
The one act that ends a running agent. It kills the session, removes the worktree and releases the GitHub claim. It closes every open question of that agent, and the ticket goes back to the frontier. The word has one place: `cancel <n>` in the command channel. No button on a question ends anything.

### Agents

**Agent**:
One harness process, spawned per ticket, that works the ticket to its ending. It may spawn subagents of its own, which curia neither sees nor counts.
_Avoid_: worker (the old name, swept in #184).

**Session**:
The tmux session `curia-<n>`. The session name is the agent's identity everywhere.

**Chat handle**:
The name of an agent no issue answers for: `chat-1`, `chat-2`, the lowest free index at dispatch. It stands where a ticket number stands — the session `curia-chat-1`, the worktree, the thread, and the argument `attach`, `cancel` and `resume` take. Today one kind of agent uses it: the new-map dispatch. It names agents only. A browser conversation is keyed `console-<n>`, so the two never collide.

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
The MCP servers an agent can reach: curia's own, and nothing else. Two settings keys in the config dir hold that line. One stops the fetch of the operator's account-level claude.ai connectors, which follow the shared credential rather than the config dir. The other admits curia's server alone. The line is closed by decision as well as by settings: a read-only MCP history server was proposed and refused (#344). History that ever reaches an agent arrives as tools on curia's own server, or it does not ship.

**Skills**:
The skill set curia symlinks into every agent's config dir, so an agent resolves in the same idiom as a hand session.

**Standing orders**:
The bounds, the tools and the ending: what holds for every turn of a ticket, not procedure. Procedure lives in the installed skills. They ride the CLI's global-memory file in the agent's config dir, because both harnesses load that file as instructions and a user message goes stale (#340).

**Spawn prompt**:
The parameters of one dispatch: the ticket, the map, the worktree, the ports, the inherited exchange, and the line that invokes the skill. It states no bound and no procedure, and it points at the standing orders.

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

**Image pin**:
A container named `curia-agent-pin`, created against the live agent image and never started. The box's nightly docker cleanup deletes every image no container references, and no label protects one, so the reference is what keeps the image alive overnight. The daemon checks the pin on every dispatch. A new tag moves the pin and then removes every superseded tag of the same repository. See [#337](https://github.com/alp82/curia/issues/337) and [#350](https://github.com/alp82/curia/issues/350).

**Cache volume**:
A Docker volume shared by every agent for what is too heavy to bake into the image: the npm cache and the Playwright browsers. Cross-agent poisoning is an accepted risk.

**Side channel**:
The daemon's structured channel to an agent: the MCP tools and the Stop hook. Curia never parses the terminal to learn agent state.

**Last contact**:
How long ago an agent last reached curia on the side channel. Every tool call moves it, and it lives in memory, because a call is traffic and the journal holds evidence. The daemon journals the FIRST call per agent and no other ([#194](https://github.com/alp82/curia/issues/194)).

It is a reading of the live daemon process. No contact is two different facts, and every surface states which one it is. An agent this process spawned has said nothing at all. An agent it adopted after a restart has said nothing yet, and that silence belongs to the restart. Curia decides between neither: a working agent and a deaf one are both silent, so the operator reads the row and judges the silence ([#341](https://github.com/alp82/curia/issues/341), [#370](https://github.com/alp82/curia/issues/370)).

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

**Round**:
The unit of a HITL exchange, and what an agent asks in one `ask_human` call (#285). It holds every question whose answer does not depend on another question still open. The agent numbers them and gives each a recommended answer, and the `recommended` flag puts a ✅ All as recommended button on the card. One question is a round of one. A question the operator leaves unanswered returns in the next round, and it is never taken as recommended. [ADR-0019](docs/adr/0019-typed-payloads-and-the-lint-grades.md) retires that flag: a typed round carries `questions[]`, and curia renders the button when every question carries a recommendation.
_Avoid_: batch.

**Typed payload**:
The named fields an agent fills instead of one prose string (#413). One vocabulary serves every surface: `headline`, `question`, `option`, `consequence`, `example`, `visual`, `detail`. Each surface takes a subset and sets its own mandatory floor. The agent writes the parts and the bridge lays them out. See [ADR-0019](docs/adr/0019-typed-payloads-and-the-lint-grades.md).
_Avoid_: structured payload, card schema.

**Lint grade**:
Which rules of `voice.md` a typed field is held to. Grade A is inline decision text: a hard character cap, one line, no markdown structure and no link. Grade B is block prose: a cap, at most 25 words per sentence, and no heading, table or blockquote. The `visual` field takes neither, because it is not prose. curia checks its width, its height and its fence.
_Avoid_: strict lint, soft lint.

**Visual**:
The optional code-block table or ASCII diagram on a card. At most 42 columns by 20 lines, which is the phone limit from #414. That sits under `CODE_BLOCK_LIMIT`, so a typed visual passes the block cap the lint already ships (#432). curia writes the fence, never the agent. A visual earns its space by removing prose (#415).
_Avoid_: diagram, figure.

**Lint gate**:
The voice check on agent prose that reaches a human, and the rejection that enforces it (#416, #438). The daemon lints against `daemon/assets/voice.md` and refuses the call with the lint message. The agent rewrites its own text and calls again. The daemon never rewrites it. Three rejections is the cap, and the daemon counts them, because an agent miscounts its own. See [ADR-0005](docs/adr/0005-escalation-contract.md).
_Avoid_: voice gate, prose check.

**Flagged send**:
What the lint gate does at the cap (#416). curia takes the fourth text as it stands, sends it, and shows the operator which rule it broke. The tool result says the text went out flagged and tells the agent not to call again. A flagged send is a delivered question, so it is never a failure to report.
_Avoid_: fallback, degraded send.

**Stop-hook catch**:
The lever that makes a rejection unmissable on codex (#438). On codex 0.146.0 a tool call sits inside the `exec` script, so a rejection is only a return value and it never throws. An agent that threw the value away believes its question went out and moves to end its turn. The Stop hook fires there, refuses the stop with `{decision:"block", reason}`, and hands back the lint message. At the second stop block curia sends the flagged text itself, so an agent that never calls again still delivers its question. The tool description and the memory-file line reach the model earlier, and both are prose that can be ignored. This one is the guarantee.
_Avoid_: hook fallback.

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
A re-asked question closes the older record and routes late answers to the live one. The key is the agent and the kind, never the wording (#336). A re-send that explains itself in its own words is the same call, so it closes the original at birth. A confirm keys on the target instance instead. It reaches OPEN records only, so a question that is already answered is handled by the recorded answer (#369).

**Recorded answer**:
An answer a human gave to a question no live call could receive. `settle` finds no resolver, so the daemon parks question and answer on the agent's note queue (#139). A question re-asked word for word takes that answer back at once, while the note is still unread, and no second card opens (#369). The note leaves with the answer, so one fact is said once. The tool result names the record, the person and the moment, so the agent knows the answer is a recorded one. At the review gate the same rule needs the diff digest to match, or a fresh gate opens.
_Avoid_: replay, cached answer.

**Inherited exchange**:
Every question a human has answered on a ticket, written into the next dispatch's spawn prompt (#374). A prior answer is a parameter of this dispatch, so it lands in the prompt's parameters and never in the standing orders. The key is the session, which is `curia-<n>` for the ticket's whole life, so the push reaches every dispatch the ticket has had. It carries the question and the answer whole, and every kind, the review gate included. A cancelled, lapsed or superseded record holds no answer and does not appear. The block is capped, the newest survive, and the prompt says the words are recorded rather than fresh. It cures the re-ask a `resume` caused. The recorded answer cures the re-ask inside one dispatch, and the two never meet.
_Avoid_: history, prior context.

**Stale question**:
An escalation still open when its own agent reports a result (#336). The result closes it, because nothing can read an answer to it any more. Reconcile runs the same rule over the journal, and it runs the ending a Stop hook deferred to such a record. Silence closes nothing: only the agent's own result or its next call does.

**Render retry**:
The escalation's own second try at a Discord render that failed (#261). It runs at 1 minute, 5 minutes and 15 minutes after the record opened, then never again. The offsets count from `esc_open`, not from the failure, so a restart re-arms only the tries still ahead. After the last one the record stays open and REST-answerable, and the dashboard shows it either way.
_Avoid_: nudge (the half-hour re-post of an open escalation, deleted whole by #261).

**Bridge**:
The Discord module. It renders and captures. It never interprets.

**Thread-per-ticket**:
One Discord thread per ticket. It carries the ticket's escalations, notifies, and answers. The binding outlives the agent: it releases only when the ticket itself closes, so a resumed agent lands back in the same thread. Every path that resolves a thread goes back to the ticket's last thread first, and one ticket resolves one thread at a time, so a re-dispatch adds no second thread (#257). The name carries the state at a glance: 🎫 bound, ⏳ waiting on the operator, 🔎 holding a review gate, ✅ finished, ⚰️ cancelled.

**Held clear**:
The wait before a thread name goes back to 🎫 (#277). Discord answers every rename with a system line, and no flag suppresses it. Putting ⏳ or 🔎 on the name is worth that line, because the reader is away. Taking it off is not, because the reader just answered. So a clear waits two minutes, and any newer state cancels it. A ticket that asks another question inside the window spends no rename at all. The wait dies with the daemon.

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
Text the operator sends to one agent while no escalation is open. It belongs to the instance it was sent to and dies with it. It has two delivery modes, and the operator picks. A note typed in Discord is keyed on the thread it was typed in. A note sent from the console names the agent, because a browser has no thread. Both keyings reach one queue.
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
The ending of a map dispatch. It forks on one fact: did the session write a file? A session that wrote none ends on two steps. It edits the map, then it reports the result. A session whose research subagents wrote findings takes the ordinary ending for them: commit, pull request, review gate, merge, then close those research tickets. The Stop hook holds a session whose findings sit uncommitted under `docs/research/`, because an uncommitted file dies with the workspace. Curia posts the summary on the map either way. That comment states whether the findings reached the default branch. No unassign, and the map itself never closes.

**New-map ending**:
The charting ending with one step in front: create the map, adopt it with `map_created`, then report the result. The Stop hook holds the agent to the adoption, because it is the one fact the daemon cannot read for itself. Its research tickets land the same way a map dispatch's do.

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
The harness's own append-only run log. It carries no geometry, so any device lays it out at its own width. The harness names the file after the session id, and a resume keeps that id, so one run is one file for its whole life.

**Finding a transcript**:
Two ways. What the config dir holds decides which one is right. An agent gets a config dir of its own, so the newest file in it by mtime is that agent's run. A conversation shares one config dir with every other conversation, so only the session id its key is bound to names its file. A key with no session id has no transcript. The honest answer there is nothing, and it is never the newest file. See [ADR-0016](docs/adr/0016-the-conversation-key.md) and the [live checks](docs/live-checks/332-transcript-by-key.md).

**Driven session**:
A timeline session that is no tmux pane. It names its own config dir, the session id of the conversation it serves, and it takes a message as a turn rather than as keystrokes. The console chat is the first one. A driven session has no dialog guard and takes no key, because neither has a pane to reach.

**Console chat**:
The timeline attach of one browser conversation, served under the console's own address. The console draws no chat of its own and frames none: there is one chat surface, and it is the timeline.
_Avoid_: Chat screen (that is the picker in front of the chats, not a chat).

**Conversation picker**:
The Chat screen of the dashboard. It lists the browser conversations, opens one, and starts a new one. Each row carries the conversation's own context percent, which is the one signal that a conversation is getting long. It lives on the dashboard and not in the chat page, because an agent opens that same page and a conversation switcher there would put console words on the agent surface. It reads `GET /api/console` on arrival, never on the poll. See [#333](https://github.com/alp82/curia/issues/333).

**Browser conversation**:
An overseer conversation the console chat speaks to, keyed `console-<n>` rather than on a Discord thread. The browser holds many, and the Chat screen serves one as the session `curia-console-<n>`. One brain answers both surfaces. The answer is never posted, because the transcript already carries it to the page. Its verbs run with no origin thread, so a confirm goes where a REST press sends it. See [ADR-0016](docs/adr/0016-the-conversation-key.md).
_Avoid_: browser thread (there is no Discord thread behind it, and there is more than one).

**Spent number**:
A browser conversation number that is used up. The daemon journals every key it mints, and it never mints one twice, so a delete spends that number for good. This is the one rule that separates a conversation number from a **Chat handle**: an agent is torn down whole and its index comes back, and a conversation is memory, so a reused number would wake the deleted conversation's own transcript. A delete forgets the key and leaves the file on disk. See [#333](https://github.com/alp82/curia/issues/333).

**Preview**:
A tailnet HTTPS link to an agent's running dev server. The daemon allocates the public port and composes the link.

**Serve rule**:
One `tailscale serve` handler. It lives in tailscaled and outlives the daemon, so reconcile sweeps stale rules.

**Identity check**:
The rule every surface curia publishes through Serve admits a caller by: not a Funnel request, a Host this box serves, and a `Tailscale-User-Login` on the allowlist. Tailscale Serve stamps that login and overwrites a forged one, so a tailnet client cannot fake it. It fails closed. One allowlist covers the terminal, the timeline, previews and the dashboard alike. The sidecar reads that allowlist with the daemon's own rule, so the two processes admit the same people.

**Identity proxy**:
The daemon's loopback proxy that carries the identity check for a surface with nowhere to put one. The terminal's Serve rule points at the proxy, never at ttyd. A preview rule points at one of its own, never at the dev server, and its port is derived from the preview's Serve port. The timeline applies the same check in-process.

**Escalation overlay**:
Open escalations shown on the timeline from the daemon's record, because a transcript is silent while a question blocks.

**Dialog guard**:
The timeline's refusal to send text while a native terminal dialog holds the pane.

**Overview**:
The daemon's one loopback read of itself, `GET /overview`. It joins every section the dashboard draws. These are the live agents with their context meters and their last contact, the open escalations, the review gate, bridge health, the usage windows, the standing credential warnings, the journal tail, the frontier snapshot, and the six reloadable settings the daemon is running with the instant it read them. The sidecar polls it, and holds no secret, no GitHub token and no journal handle. Each section is nullable on its own, so an unreadable one costs the page nothing else.

**Dashboard**:
The browser console for the box, on loopback `4273` and Serve `8445`. It draws the overview behind the same identity check every other surface uses.

**Read screen**:
A dashboard screen whose facts all come from the overview: home, agents, frontier, feed. The settings screen is the one that reads its own files. Two rules hold across all four. Color marks attention and nothing else, so a state, a ticket type and a repo are told in words. Null is not empty, so an unreadable fleet never renders as an idle box and an uncomputed frontier never renders as an empty one.

**Answer surface**:
The Needs-you list on the home screen. It is the one place a question or the review gate is answered from the console. The agents table states what an agent waits on and answers none of it, so no operator has to remember which of two surfaces they are looking at.

**Diff digest**:
What curia measured about a change: the file total, the added total, the deleted total, and a per-file list of path, added lines, deleted lines, status letter and hunk count. It is a measurement and never prose, so it never becomes a second account of the work beside the agent's own gate summary. The review gate counts it ONCE, in the agent's own worktree, at the instant the gate opens, and stores it on the escalation record and on the `review_requested` event. Discord gets one line from it. The console draws the whole list from the stored copy, so no poll re-counts anything and the digest survives the agent dying. A live agent row counts its own on demand, committed and uncommitted work together. Null is not empty: a worktree that is gone makes the digest null with its reason, and the card says curia could not count this diff. See [#355](https://github.com/alp82/curia/issues/355).
_Avoid_: diff (the digest is the numbers, not the patch).

**Rank rule**:
The order the digest lists files in: source first, then tests, then docs, and generated or lock files last, largest first inside each class. It decides which file opens expanded and nothing else. Every changed file is on the card with its own numbers, so the rank hides nothing. The card states the rule in these words, because a rank the operator cannot read is a rank they cannot check.

**Hunks**:
The patch text of one file, fetched on demand and never on the poll. The browser names a review gate or an agent, and a file only by its place in the digest curia measured. The daemon resolves the worktree itself. A worktree that is gone falls back to the pull request's own diff and says so. A long file stops at a cap, states how many lines it did not show, and puts the GitHub link beside it.

**Operator verb**:
An act the console carries: start, answer, the review gate, note, cancel, teleport. Each one is a POST to the sidecar, which composes the daemon call from the fields the page sends. A browser never hands over a command line. Start, cancel and teleport go through the command seam the slash verbs use, so a press from the console journals the same event a typed command does.

**Routed model**:
The model a takeable ticket gets if it starts now. Reconcile computes it with the daemon's own precedence rule and joins it onto each frontier item, so the console names the account a press spends before spending it. It states what routing decides, not what a spawn does: cooling is read at the spawn, and the feed reports the chain it walked.

**Who pressed**:
The operator's Tailscale login, taken from the header the sidecar's identity check already reads and passed to the daemon as the `by` of every verb. Before the console, every REST verb journalled the word `rest`. The feed now names a person rather than a transport.

**Sidecar**:
The process that serves the dashboard. It runs beside the daemon and never inside it, so it stays up while the daemon restarts. It holds no secret: its container mounts the code and the config directory, and neither the journal nor the `.env.daemon`.

**Settings screen**:
The one dashboard screen that writes. Four sections, Routing first, then Projects, Dispatch and Maintenance. It reads `curia.yaml` and `routing.yaml` off disk, never from the poll snapshot, and posts back only what the operator changed.

**Settings save**:
The write itself. The sidecar edits the override file through the yaml document API, so every hand comment survives. It validates the candidate as a layer over the tracked file, with the daemon's own loaders, and renames it into place only after every candidate passes. A refused save answers the loader's own message and leaves every file as it was. It refuses one thing of its own: the removal of a watched repo while an agent runs on it, named. That repo would drop out of reconcile, and nothing would cover the agent's claim.

**Base config**:
`config/curia.yaml` and `config/routing.yaml`. Git tracks both. They carry the shipped answer to every key. A ticket that adds a key adds it here, so the box gets that key with the code that needs it.

**Override config**:
`config/curia.local.yaml` and `config/routing.local.yaml`, beside the base files. Git ignores both. They hold what this box answers differently, and nothing else. The settings screen writes only these. The merge rule is two sentences. A mapping merges key by key. A list or a scalar replaces whole. A value that comes back to the base answer is dropped from the override rather than repeated, and an override file that holds nothing is removed.

**A clean checkout**:
What `git status` on the box says on an ordinary day, and the reason the override exists. A save leaves the checkout clean, so a dirty tree means one thing: somebody hand-edited a tracked file there. The `deploy` verb refuses a dirty tree and names the files, because a fast-forward would refuse it later and the rollback would discard it.

**Save banner**:
The settings screen's banner, at the top. It carries one button, Save, and states what the daemon did with the save. Applied is one sentence and no button. Declined names the key that needs a restart and carries the restart. A daemon that is not answering carries no button, because a restart is not the mitigation for a process that is already down.

**Live reload**:
`POST /reload` on the daemon. It re-reads both config files with the daemon's own loaders and applies the six settings the settings screen writes: `dispatch.auto_dispatch`, `dispatch.max_concurrent`, `dispatch.poll_interval_s`, `watch`, `routing.defaults.<type>` and `routing.models.<name>.active`. That set is closed. What a browser cannot write, a browser cannot apply. A reload is total or it is nothing: a file the loaders refuse applies nothing and answers their message, and a file that moved any other key applies nothing and names that key. The save starts it — the sidecar asks after a write that landed — and the daemon journals what moved. A daemon that is down misses nothing, because boot reads the file.

**Restart**:
`POST /restart` on the daemon. It journals the order, answers, and exits 75. The supervisor respawns it, because a nonzero exit is what `restart: on-failure` acts on. Agent panes live in the tmux container, so they survive it. The sidecar orders the restart and never takes it. It is a rare act about a hand edit since the live reload: it lives in the Maintenance section, and it is what applies every key outside the closed set. It restarts THE DAEMON AND NOTHING ELSE: the sidecar, the tmux server, ttyd and the overseer service each keep running. So a setting one of those reads at its own boot is not reached by this button, and the operator who hand-edited one takes a deploy instead. The overseer needs neither, because it re-reads its config every turn. The sidecar's own ports and `identity.allow` are the set that needs the deploy.

**Maintenance section**:
The fourth section of the settings screen, reading last. One line says whether the daemon runs the files, read from the six values `GET /overview` reports and the instant it read them. One restart button sits beside it, red only while the daemon and the files disagree. The Settings nav item carries a marker for the same disagreement, so a stale daemon is visible without opening the section.

**Model switch**:
`active: false` on a model in `routing.yaml`, behind the settings screen's "n of m models active". The entry keeps its provider, harness, id and comments, and leaves the dispatch vocabulary: no `defaults` row and no `review` row may name it, a fallback chain steps over it, and a `model:<x>` label naming it is refused. An absent key means on.

**Restarting marker**:
What the dashboard shows while the daemon does not answer. The page keeps the last snapshot, states its age, and names the reason. A page that blanks is worst exactly when the box is worst.

**Poll interval**:
`dashboard.poll_interval_s`, the age at which the sidecar re-reads the overview. It is a ceiling, not a clock: the sidecar reads only when a page asks and the snapshot is older than this. A browser asks while its tab is visible and stops when it is hidden. So a forgotten tab costs nothing, and many open tabs still cost one read. One read costs no journal read at all: what the overview says about the recent past is reduced in memory as events are written, so the price of a poll does not rise with the history.

**Status line**:
One Discord message per agent, written by the daemon, that says what the agent is doing now. A state change reposts it at the thread bottom. Everything else edits it in place.

**Meter**:
A number the status line carries beside the state: the model name, its reasoning effort, the context percent, and the account usage bars. Each meter has its own source and drops alone when that source is silent. Meters drop from the tail when the line runs out of columns. The model is the exception: the escalation title is cut to keep it.

**Account bars**:
The 5-hour and 7-day usage windows. They are an account fact, not an agent fact, so every agent on a provider shows the same reading. The provider follows from the agent's harness, never from the routing label: a label is a spawn-time fact and a harness has on-disk evidence. A window whose reset has passed rolls over — the bar shows the fresh window at 0%, and that reading counts as stale at once, so the next probe measures it. Every window also carries the instant it rolls. The status line has no room for a clock time and shows the pace instead. The overview carries the instant, and the dashboard prints it.

**Pace**:
Usage measured against the time already gone from its window. A bar shows the window's clock as `┃` and renders spending past it as overshoot. The square before the bar states the same fact at a glance: 🟩 behind the clock, 🟨 on it, 🟥 ahead.
_Avoid_: usage (that is the raw percent, which says nothing about speed).

**Context percent**:
How full an agent's context window is. The numerator is the last request's input tokens from the transcript. The denominator comes from the best source that has one: the window the codex transcript states, then `max_input_tokens` from `GET /v1/models/<id>` for the model id the claude transcript names, then `models.<name>.context_window`. It is never clamped — a figure above 100% says the denominator is wrong, not that the agent is full.

### State and evidence

**Journal**:
Curia's durable record of its own events, append-only and in time order. It is the daemon's only durable artifact, and the reduction is derived from it. It is a `node:sqlite` database at `daemon/data/events.db`. To journal an event is to write one row of that record.
_Avoid_: store, event store, log (#358).

The name follows the record and not the medium, so the database IS the journal. One table holds all 96 event types. A row keeps the written line verbatim in `body`, so the journal is a superset of the file it replaced. The daemon holds the only write connection, and every other process reads it read-only. It runs WAL with `synchronous=full`. `daemon/src/journal.mjs` holds the schema, the writer and the migration. See [ADR-0017](docs/adr/0017-the-journal-is-a-queryable-store.md), built on [the journal map (#316)](https://github.com/alp82/curia/issues/316) and shipped at [#407](https://github.com/alp82/curia/issues/407).

**Journal backup**:
A gzipped `.dump` of the journal, under `daemon/data/backups/`. Decided and not built: the daemon writes one a day and keeps fourteen ([#357](https://github.com/alp82/curia/issues/357)). It is portable SQL text, so it restores into any SQLite. It stays on the box, so it bounds a corrupt journal and a bad Node upgrade. It does not survive the loss of the box. A restore is a hand recipe in [the daemon README](daemon/README.md#the-restore), and curia ships no verb for it. The fourteen are a backup count. They are not journal retention, which stays undecided.
_Avoid_: snapshot, archive.

**Journal file**:
`daemon/data/events.jsonl`, the medium the journal used before the `node:sqlite` database. It never rotated, so it only grew. A historical term since the migration. Name it only where the migration is discussed, and never as a synonym for the journal. The migration leaves it on disk, unwritten, as the floor a rollback lands on ([#323](https://github.com/alp82/curia/issues/323)). [#427](https://github.com/alp82/curia/issues/427) deletes it once the journal is checked on the box.

**Reduction**:
The daemon's in-memory state, rebuilt from the journal at boot and kept current by every append after it. Run every journal event in order through one function, and what you hold at the end is the reduction. That function is the reducer, and it runs on every event alike, at boot and on every append. The boot act is a **rebuild**, never a replay. Replay names sending a killed turn's message again.

It holds the open escalations, the agent notes, the ticket-to-thread bindings and the console conversations. It also holds the event tail, the outcomes, the pull requests and the armed limit resumes. It is a disposable cache and never a state home. A surface that answers about the recent past reads it, and never the journal.

It is not a subset of the journal. Three of its fields keep rows verbatim: the event tail, the outcomes, and the last event per agent. Everything else is computed, so one escalation record folds the opened, superseded, answered and closed rows into a single object no row holds.
_Avoid_: store, state, projection (#358).

Curia writes one name for one thing, so "store" names nothing in this domain. It survives as an ordinary English word only, as in the shared credential store of [ADR-0007](docs/adr/0007-shared-credential-store.md). The class `Reduction` in `daemon/src/reduction.mjs` holds the reduction, the class `Journal` in `daemon/src/journal.mjs` holds the record, and `Reduction#journal` is how the daemon journals an event. The old names were `EscalationStore` in `daemon/src/store.mjs` and `logEvent`, and [#407](https://github.com/alp82/curia/issues/407) renamed both.

The rebuild survived the move to `node:sqlite`, and it reads the journal instead of the file. Three fields could be queries. Every other field folds many rows into an object no row holds, and the reducer runs on every append anyway, so a query at boot would state each rule twice. The rebuild reads `select id, body from events where id > ? order by id limit 1000`, page by page. It orders by `id` and never by the stamp, because stamps tie. It reads `body`, which is verbatim, so it is the last reader that runs the [#184](https://github.com/alp82/curia/issues/184) translation. `EscalationStore._replay` is now `Reduction#rebuild`. The boot stays proportional to the whole history: about 44 ms today and about 2.4 seconds at 250,000 events, and the medium moves neither number. See [The boot replay (#322)](https://github.com/alp82/curia/issues/322) and [the prototype](prototypes/boot-replay/README.md).

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

**Prototype**:
Throwaway code that answers one named question, under `prototypes/`. The `prototype` skill writes it, and curia uses that skill's word for it. It rides the ticket's own `curia/<n>` branch, and the merge lands it on main. A header names its ticket, and the ticket's resolution comment holds the verdict. See [ADR-0008](docs/adr/0008-resolved-means-merged.md).

## Components

One box runs everything. Phones and PCs are pure clients on the tailnet.

- **Daemon** (`daemon/`): one Node process, no build step. It owns dispatch, escalations, routing, previews, the attach surfaces, and reconcile.
- **Bridge**: the Discord module inside the daemon. Thread-per-ticket rendering, buttons, attachment passthrough both directions.
- **Router**: the deterministic command router inside the daemon. It parses the five verbs from Discord slash commands or REST.
- **Agents**: one harness process per ticket, in tmux sessions named `curia-<n>`. A cross-check adds a reviewer beside one, in `curia-review-<n>`.
- **Sidecar** (`daemon/bin/curia-dashboard.mjs`): the dashboard's own Node process, in its own container. It imports the daemon's identity check, config rules and Serve helper, and reads the daemon over loopback.
- **Surfaces**: the shared ttyd terminal, the timeline and the dashboard, all published with Tailscale Serve. Previews take their own port range.
- **Config** (`config/`): two layers. `curia.yaml` (watch list, dispatch, attach, dashboard, skills) and `routing.yaml` (models, defaults, fallbacks, the cross-check pairing) are the base, hand-edited and tracked in git. `curia.local.yaml` and `routing.local.yaml` beside them hold this box's own answers, and git ignores them. The daemon reads a base file and the override over it: a mapping merges key by key, a list or a scalar replaces whole. The settings screen writes only the override, which is what keeps the box's checkout clean. Every file is written in the form the yaml document API prints back unchanged, so an edit rewrites the lines it changed and no others. A trailing comment takes one space before the `#`, and a comment block belongs above its key rather than after it.

## State homes

- **GitHub**: ticket state, labels, claims, sub-issue parentage, map bodies, branches, pull requests. The source of truth.
- **Journal** (`daemon/data/events.db`): every durable curia event, in a `node:sqlite` database ([ADR-0017](docs/adr/0017-the-journal-is-a-queryable-store.md)). The daemon converted at its first boot on [#407](https://github.com/alp82/curia/issues/407), and it left `daemon/data/events.jsonl` on disk for the rollback ([#323](https://github.com/alp82/curia/issues/323)). Decided and not built: a daily gzipped `.dump` under `daemon/data/backups/` bounds what the journal itself can lose, and fourteen are kept ([#357](https://github.com/alp82/curia/issues/357)). That copy is a backup and never a second state home.
- **Verdicts** (`daemon/data/verdicts/`): one captured cross-check verdict per ticket, held for the return path.
- **tmux**: the live agent sessions.
- **tailscaled**: the Serve rules for attach, timeline, the dashboard, and previews.
- **Workspace root** (`~/curia-work`): private clones, review checkouts, agent config dirs, and the overseer's checkouts under `overseer/repos/`. Those last are a cache of origin and nothing else, so deleting one costs a re-clone and no work.
- **Host credential stores** (`~/.claude`, `~/.codex`): the daemon's own. No container reaches them — a dispatched agent gets the model credential copied into its container environment, and the overseer container reads its own from `daemon/.env.overseer`.
- **docker**: the live agent containers and the two shared cache volumes.

Everything else is a cache that reconcile can rebuild.

## Docs

- `docs/adr/`: one file per standing decision, indexed at `docs/adr/README.md`.
- `docs/research/`: research notes, one per investigation, indexed at `docs/research/README.md`.
- `docs/live-checks/`: first-person agent evidence.
- `docs/agents/`: tracker, triage, and domain-doc conventions for agents.
- `docs/full-loop.md`: the rehearsal record of the PoC map. History, not a live procedure.
- `docs/github-app.md`: the operator's own checklist for the GitHub App. Nothing on it can be done by an agent.

The tracker holds history. The docs hold what still constrains work.
