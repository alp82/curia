# ADR-0014: The overseer runs in its own container

**Status**: accepted (2026-08), built (2026-08). The build map is [#309](https://github.com/alp82/curia/issues/309), and [#315](https://github.com/alp82/curia/issues/315) cut both chat surfaces over to the container and deleted the in-daemon host.
**Provenance**: [The chat embeds the timeline attach (#267)](https://github.com/alp82/curia/issues/267), [The chat and the overseer become one thing, in a container (#301)](https://github.com/alp82/curia/issues/301)

## Context

The overseer is the command brain over Discord. Since [#267](https://github.com/alp82/curia/issues/267) it is also the brain behind the console chat. It runs in the daemon process, as one SDK `query()` per message.

It holds no shell. `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch` and `WebSearch` are all disallowed. Its only tools are the eight verb tools, and each one posts canonical text to the `/command` seam. The daemon executes every effect.

That tool surface is the whole containment boundary today. It has to be, because of where the overseer sits. The daemon container mounts the docker socket, the tailscaled socket, the host credential stores, `~/.config/gh`, the repo, and the whole workspace root. A shell in that container is root on the box.

The cost is the limit [#267](https://github.com/alp82/curia/issues/267) stated: the overseer cannot read a file or a diff. The operator asked for one thing with access to all repos. So the shell must come from somewhere else.

## Decision

- **The overseer leaves the daemon process and runs in its own container.** The container is the boundary, the way [ADR-0012](0012-one-container-per-worker.md) already makes it one for an agent. The move is what buys the shell. A shell is safe because the overseer moved, not risky because the shell arrived.
- **It reads a persistent checkout of every watched repo.** Each one is its own blobless clone in its own volume. `gh` alone does not answer the ask, because a file and a diff are what the chat could not read.
- **Every watched repo is fetched once at the start of each turn**, in parallel, before the model runs. A fetch before every file read is not a control, because a shell can skip it, and it pays a network round trip per read. One fetch per turn makes every read inside that turn consistent. It costs nothing while nobody asks. `git pull` stays available for the case where the overseer must be exact mid-turn.
- **The checkouts hold every ref**, `curia/<n>` branches and pull-request heads included. "What did this agent change" is the first thing an operator asks a chat that sees everything.
- **Its GitHub token is read-only.** This is the control that replaces the seam. A standing order cannot hold a shell, and a shell cannot mint a token. Agents write, and they write through pull requests.
- **It writes nothing outside its own volume.** Every effect still crosses `/command`. The daemon still does every tracker write.
- **The ✅/❌ confirm on `cancel` survives.** It carries more weight than before. The caller is still a model, and that model now reads issue text and repo files. Hostile text can reach the verbs for the first time.
- **It holds no `max_concurrent` slot.** That number counts ticket agents and paces the frontier. A permanent tenant would cut the fleet by one forever, and the settings screen would then state something untrue. The overseer is a service. It is budgeted as one more container.
- **It keeps one conversation per thread.** Discord opens a thread per top-level message, so there is no single conversation to merge into. `console` stays one thread beside them. One brain, one container, many conversations. [ADR-0016](0016-the-conversation-key.md) later replaced the single `console` key with `console-<n>`, so the browser holds many conversations too.
- **Sonnet 5 is the model.** Haiku answered a mapping from prose to eight verbs. Reading code and diffs is a harder job. Idle costs no tokens, because a turn spawns the model and nothing runs between messages.

## Consequences

- The container holds every owner's scoped GitHub token, where an agent holds one. That is a real widening. Read-only is what pays for it.
- The model credential originally froze for the container's life. [#648](https://github.com/alp82/curia/issues/648) moved it to a read-only provider-store mount. [#726](https://github.com/alp82/curia/issues/726) removed the environment fallback, so the overseer re-reads one tracked source per turn.
- The daemon keeps the conversation state. `store.overseerSession` is a reduction over the daemon journal, so the resume id travels to the overseer per turn and comes back. [ADR-0001](0001-github-is-the-only-durable-state-home.md) keeps its one state home.
- The timeline reads the overseer transcript off its config dir. So that directory must mount at the same path in both containers. `deploy/compose.yaml` already carries that same-path principle.
- Two questions stay open, and each earns its own grilling ticket on the build map. The first is the hosting shape: a second sidecar beside the dashboard, or an agent-shaped tmux pane. **Answered** by [ADR-0015](0015-the-overseer-is-a-service.md) on [#310](https://github.com/alp82/curia/issues/310), which took the service and added one container per thread as a third candidate before ruling it out. The second is the detail behind the per-thread conversation key. **Answered** by [ADR-0016](0016-the-conversation-key.md) on [#311](https://github.com/alp82/curia/issues/311), which keeps the Discord snowflake, replaces the single `console` key with `console-<n>`, and finds a transcript by key rather than by mtime.
- The build landed. `daemon/src/overseer.mjs` — the in-daemon host, and the tool-surface boundary its head comment described — is deleted whole. The boundary comment now sits at the head of `daemon/src/overseerclient.mjs`, which is the daemon's whole reach into the container, and it describes shipped code.
