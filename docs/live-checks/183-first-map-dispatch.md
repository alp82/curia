# Live check: the first map dispatch

Ticket: [#183](https://github.com/alp82/curia/issues/183). Checks the build
[#160](https://github.com/alp82/curia/issues/160) shipped and never ran.

Named after the check ticket, not after #160, because every other file here is
named after the ticket that produced it (see `185-first-containerized-dispatch.md`,
which checks #156 and #157). The #183 body asks for `docs/live-checks/160`. That
text predates the graduation that made #183 a ticket of its own.

Run on the box, `coinmatica.net`, 2026-08-04 23:29 UTC and 2026-08-05 07:03 UTC.
Daemon at `a26537d`, started 2026-08-04 21:47 UTC. `718f0a9` is an ancestor of
it, so #160 was live. No deploy and no restart were taken for this check.

## The fixture

A disposable map, [#209](https://github.com/alp82/curia/issues/209), with one
open child, [#210](https://github.com/alp82/curia/issues/210). Same pattern as
[#59](https://github.com/alp82/curia/issues/59), the fixture the merge gate was
checked against. A charting agent may create, edit and close a map's children,
and no gate reads what it does, so the first run of that authority went at
something with no blast radius. Nothing here touched map #147.

## Preflight

Read before the run, so a failure would name itself:

- `map: fable` is in the box's `config/routing.yaml`.
- `/start` is registered guild-side with four options: `ticket`, `model`,
  `harness`, `instruction`. Read from `GET /applications/<id>/guilds/<id>/commands`.
  Registration is per guild (`Routes.applicationGuildCommands`), so it is
  immediate server-side.
- The agent image `curia-agent:2.1.220-0.146.0-fc78bbbf` is on the box, so no
  run paid a cold build.
- The box parser takes the repo-qualified form. Run against the box's own module:
  `start curia#209 -- graduate the fog` gives
  `{verb, repoArg: "curia", ticket: "209", instruction: "graduate the fog"}`.

## Run 1: the instruction path

`/start` with `ticket: curia#209` and an instruction. The operator reports the
`instruction` option appeared in the picker with no client reload, so #65's
stale-manifest failure did not repeat.

```
23:29:45 command          start curia#209 -- graduate the fog line about the fixture's
                          second surface into a new child ticket, and wire it blocked
                          by the fixture's first surface ticket
23:29:48 dispatch_claimed ticket=209 kind=charting
23:29:51 agent_spawned    model=fable kind=charting instruction=present sandbox=docker
23:29:54 agent_mcp_first  model=fable since_spawn_ms=3437
23:29:57 reset_unparseable scope=model applied_cooldown_h=1
23:29:57 model_cooling    model=fable reset_at=2026-08-05T00:29:57Z reset_source=floor
23:29:58 agent_spawned    model=opus retry_after_limit=true
23:30:02 agent_mcp_first  model=opus since_spawn_ms=3179
23:30:05 agent_ready      model=opus
23:31:18 result           status=resolved
23:31:20 charting_finished map=209 commented=true released=true
```

**1. The instruction arrives.** The slash option carried the sentence through
`expandCommand` as a trailing `-- <sentence>`, and the agent acted on it in its
first turn. It read the map, read #210, created the new ticket and wired the
edge, with no other input.

**2. The routing row fires.** fable, cooled 6 s later, respawned on opus. The
burnt spawn is the expected cost of `map: fable` while the account holds no
fable credits. `reset_source: floor` is the honest reading: the credits dialog
states no reset instant anywhere, so the hour floor applies. This is the case
[#175](https://github.com/alp82/curia/issues/175) left standing on purpose.

The burnt spawn reached its MCP handshake at 3437 ms, before the cooling. So
[#194](https://github.com/alp82/curia/issues/194)'s mute detector never saw a
cap-hit spawn as a mute one.

**3. The ending holds.** curia posted the summary as a comment on the map and
removed the assignee. The map is **open**. The comment is curia's own text: it
quotes the operator's instruction, lists what changed, and closes with "A map
dispatch: this session edited the map and its tickets. It opened no pull request
and closed nothing. Model `opus`." That footer names the model that ran, not the
routing label and not the model that burnt.

What landed on the tracker, checked against a snapshot taken before the run:

- [#213](https://github.com/alp82/curia/issues/213) created, `wayfinder:task`, a
  sub-issue of #209.
- #213 blocked by #210 through GitHub native dependencies. `blocked_by: 1`.
- One line removed from **Not yet specified**, replaced by an HTML comment
  saying where the patch went. Destination, Notes, Decisions so far and Out of
  scope untouched.

Spawn to `report_result`: 80 s.

## Run 2: no instruction

`/start` with `ticket: curia#209` and the `instruction` box empty.

**5. No instruction.** The agent's first act was an `ask_human`, `kind: free-text`:

> Map dispatch on LIVE CHECK (#183) … No instruction rode this dispatch, so I
> will not guess.
>
> What should change on this map?
> …
> If this is only a smoke test of the map dispatch path, say so. I will then
> make one small, harmless edit to the fixture body and end on `report_result`.

The answer reached the agent and it made the change. The map is still open, still
unassigned, and now carries two curia comments.

Run 2 spawned **straight onto opus with no fable spawn at all**, because fable
was still cooling from run 1 (reset 00:29:57Z, dispatch 23:53:55Z). So two map
dispatches inside one hour pay one burnt spawn between them, not one each.

## Fault: a respawn erases the dispatch kind

**The largest thing this check found. Fixed by
[#219](https://github.com/alp82/curia/issues/219): the respawn now states the
kind, the instruction and the rest of the dispatch-time facts again.**

#160 built two belts against a charting agent being read as a ticket agent,
because that misreading closes the map. One is the pair of refusals on
`open_pull_request` and `request_review`. The other is journalling the kind at
the spawn, so a restarted daemon still knows which ending it holds. The respawn
defeats the second one, and the refusals read the same flag.

The three spawn lines this check produced, in full:

```
23:29:51  {"model":"fable","kind":"charting","instruction":"present"}
23:29:58  {"model":"opus", "kind":null,      "instruction":ABSENT, "retry_after_limit":true}
23:53:55  {"model":"opus", "kind":"charting","instruction":null}
```

`ABSENT` means the key is not written at all. The respawn writer
(`dispatch.mjs:1533`) sends `repo`, `ticket`, `agent`, `model`, `harness` and
whatever `journalData` holds. It does not send `kind`, and it does not send
`instruction`.

`#epochCharting` reduces over every `agent_spawned` for the ticket and keeps the
last. Run against the live journal after run 1:

```
epochCharting(209) = {"charting":false,"instruction":null}
```

The in-memory record wins while the daemon lives, which is why nothing broke
here. It bites after a restart, when reconcile has only the journal. Then
`charting: false` reaches all of:

- `dispatch.mjs:1718` — the `open_pull_request` refusal
- `dispatch.mjs:1770` — the `request_review` refusal
- `dispatch.mjs:1885` — the state the ending list is picked from
- `dispatch.mjs:2887` — the result path, ticket ending against charting ending

`dispatch.mjs:2049` states the consequence in its own words: "`charting: false`
on a real map agent sends it to the ticket ending, which would try to close the
map."

This is not a rare path. While the account holds no fable credits, `map: fable`
burns a spawn on **every** map dispatch, so every map dispatch spends the rest of
its life with a journal that describes it as a ticket dispatch. Run 2 shows the
contrast: it never respawned, so its kind survived and the same reduction now
reads `charting: true`.

Graduated as [#219](https://github.com/alp82/curia/issues/219).

## Point 4: the refusals were not exercised

Neither run called `open_pull_request` or `request_review`. The #183 body says
not to manufacture one, so none was manufactured. The refusals are unexercised
against a live agent.

They are also not the reassurance they look like. Both read
`#epochCharting(...).charting`, the flag the fault above erases, so on the one
path where a charting agent most needs them — a restarted daemon that has
forgotten what it spawned — both refusals are off. Exercising them on a live
agent is worth less than closing #219.

## Traps for the next session

- **A `cancel <n>` confirm renders in the ticket thread, not where you typed it.**
  Hit twice during this check. The buttons were never seen and never pressed;
  the agent finished on its own and the confirm lapsed. Charted as
  [#218](https://github.com/alp82/curia/issues/218), with the journal lines.
- **An unanswered escalation nudges every 30 minutes with no ceiling.** esc-101
  was opened 23:54 and answered 07:25. It nudged 15 times through the night.
  `stop_nudge_budget: 3` bounds the Stop hook, not this.
- **The two `agent_spawned` lines for one dispatch do not carry the same fields.**
  Anything reading spawn-time facts out of the journal must decide which line it
  wants. #187 wants the last (the model that runs). #160 wants the first (the
  kind it was dispatched as). Reducing to "the last line wins" is wrong for at
  least one reader. **[#219](https://github.com/alp82/curia/issues/219) settled
  this at the writer instead**: a respawn states the dispatch-time facts again,
  so both lines carry them and the last line is right for every reader.
- **Back-to-back map dispatches inside the hour skip the burnt spawn**, because
  fable is still cooling. A check that expects to see fable → opus must leave an
  hour, or read `model_cooling` first.
