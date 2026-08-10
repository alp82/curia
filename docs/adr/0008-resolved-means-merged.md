# ADR-0008: Resolved means merged

**Status**: accepted (2026-07)
**Provenance**: [The PR gap (#48)](https://github.com/alp82/curia/issues/48), [Build the merge-gated resolution lifecycle (#54)](https://github.com/alp82/curia/issues/54), [Map dispatch (#160)](https://github.com/alp82/curia/issues/160), [Map updates get their own verb (#221)](https://github.com/alp82/curia/issues/221), [A prototype ticket wants a second branch (#287)](https://github.com/alp82/curia/issues/287)

## Context

The full-loop rehearsal closed a ticket and wrote its map pointer while the code sat in an unmerged pull request. Nothing watched that pull request. A rejection would have made the map lie, because Decisions-so-far said the question was answered and nothing walked it back.

## Decision

- A dispatched ticket is resolved only when a human approved the work and the code is in the default branch. The ticket stays open and claimed through the whole review.
- The agent stays alive through the review and performs the whole ending itself: `open_pull_request` (opens once, updates the same pull request each round), `request_review`, then on approval the agent merges, resolves per protocol, and calls `report_result`.
- A rejection is a loop, not an ending. The human's words come back as feedback, the agent commits again on the same branch, and it asks again. There is no rejection counter. `/cancel` is the give-up rule.
- The ending is one structure in code, rendered twice: as prose in the spawn prompt and as the checklist the Stop hook blocks with. The Stop hook refuses a stop that leaves ending steps open, up to the stop budget, then lets go and reports the ticket unfinished.
- The containment boundary of [ADR-0006](0006-worker-containment-and-standing-orders.md) is redrawn on purpose: the agent writes to the remote only the one merge a human has just approved. The click carries the authority.
- Awaiting review holds an agent slot. Backpressure is correct when the human review is the bottleneck, so the concurrency cap is a resource number, not a review-latency number.
- CI does not change the answer. Where CI exists it is evidence on the pull request, never a second authority.

## Deviations

**The map dispatch (#160, deciding #149; the verb moved by #221; narrowed by [#286](https://github.com/alp82/curia/issues/286)).** `map <n>` on a map's own issue spawns a charting agent. Its output is the map: issue bodies and child issues, inside an ordinary agent's write bounds. A charting agent never closes the map, and it never resolves a ticket it did not create. A session that produced no files ends on two steps: edit the map, then `report_result`. Curia posts that summary as a comment on the map.

What replaces the gate for the map itself is the operator, per [#149](https://github.com/alp82/curia/issues/149): the dispatch is a deliberate act carrying their own instruction, and the map routes to the strongest claude-harness model. The dispatch's kind is journalled at the spawn, so a restarted daemon still knows which ending it is holding an agent to — reading a charting agent as a ticket one would close the map, which takes a whole effort off every frontier.

**The research tickets a charting session creates ([#286](https://github.com/alp82/curia/issues/286)).** Version 1.2 of the vendored wayfinder skill ends charting by firing a `/research` subagent per research ticket it just created. The operator took that shape whole, so a charting session now produces files as well as issues. The old reasoning said there is no branch to stage it in and nothing for a pull request to carry. That is false whenever it does. This ADR applies to those tickets in full.

- The charting agent takes the **ordinary ending** for them: commit, `open_pull_request`, `request_review`, merge, then close those tickets and write their map lines. Resolved still means merged, for a research ticket exactly as for any other.
- The close comes **after** the merge, never before. A research ticket closed on unmerged findings is the [#48](https://github.com/alp82/curia/issues/48) failure this ADR exists to stop.
- Every subagent works in the charting agent's own worktree, on `curia/<map>`. There is no `research/<name>` branch and no merge. This drops the one piece of the skill's shape curia does not take, and it costs nothing: that branch exists to keep unreviewed findings off main, and a pull request on `curia/<map>` already does exactly that.
- A subagent **writes files and never runs git**. The charting agent commits the findings itself, once. N agents in one worktree would otherwise race on one index, which is the failure the branches were bought to avoid.
- A subagent writes only its own `docs/research/<name>.md`. The charting agent writes every row of `docs/research/README.md` itself. One index edited by N writers is N conflicts.
- Parallel researchers can reach findings that disagree, because each reads its own ticket alone and sees no other. Separate branches never caused that and one branch does not cure it. The charting agent reads the findings together before it opens the pull request, and it states any contradiction it found in the gate summary. The operator decides what happens to it.
- The charting agent **claims** each research ticket before its subagent starts, and releases the claim if the subagent fails. Without the claim a concurrent `start` dispatches the same ticket.
- A research ticket the session did not burn down stays on the frontier and dispatches as its own agent. This covers one charted earlier, and one whose subagent failed.
- The gate holds the map lock and an agent slot for its whole length. Charting is no longer a fast act, which the operator accepted as the price.

The daemon refusals move with the rule: `open_pull_request` and `request_review` stop refusing a charting agent. **Not built yet.** The whole lifecycle change rides one build ticket, and until it merges the daemon still refuses both calls.

**The verb and the claim ([#221](https://github.com/alp82/curia/issues/221)).** #160 put charting on `start`, which gave one word two meanings: `start <n>` worked a ticket and `start <map>` charted. The operator ruled the overload confusing after using it. `start` now has one meaning everywhere — work the thing — and on a map number it dispatches that map's next takeable ticket. Charting has its own verb.

No dispatch claims a map. #160 assigned the map to serialize the body edits, and a claim's whole meaning is "off a frontier" — a map is never on one, so the assignee said nothing true and made the issue read as worked. The lock that replaces it was already there: a charting agent on map #147 runs in session `curia-147`, and `map 147` is refused while that session lives. The check asks `tmux has-session` rather than daemon memory, so it survives a restart and catches a session reconcile has not adopted yet. It is per box, and there is one box.

**The prototype's throwaway branch ([#287](https://github.com/alp82/curia/issues/287)).** Version 1.2 of the vendored `prototype` skill captures the prototype as a primary source. It says to commit it to a throwaway branch out of main, to leave a context pointer on the implementation issue, to put the verdict in the issue or a commit, and to let the main branch keep only the validated decision. Three of those four clauses already hold here, and curia claims no exception to them.

- The throwaway branch is `curia/<n>`. A ticket branch is cut from main and the merge deletes it, so it is throwaway in the skill's own sense.
- The context pointer is the resolution comment plus the map's Decisions-so-far line.
- The verdict lives on the issue, which is one of the two homes the skill names.

One clause cannot hold. **Main keeps the prototype, under `prototypes/`.** This ADR makes the merge the only durable home curia has, so a prototype is on main or it dies with its branch. A primary source nobody can find is not a primary source. The directory name is what marks the code throwaway, which is the job the skill's own "clearly marked as such" rule gives it.

curia grows no second branch for this ticket type. `pushBranch` pushes `curia/<n>` and nothing else, `request_review` composes its links from the daemon's own records, and the cross-check reviewer reads that one branch tip. A second branch would reach no gate and no reviewer. The agent's shell holds a push token, so nothing but words would hold such a branch — that makes it a way around the one-pull-request rule rather than an exception to it.

The demo stays one self-contained HTML file. The agent serves it with a static server on a preview port, and `publish_preview` carries it to the operator, whose phone has no double-click. The file stays double-clickable off main afterwards.

curia adds no index for the directory. The skill names the issue and the commit as the homes for an answer, and names no README. The map's Decisions-so-far is already that index, and each prototype names its ticket in a header.

The skill file itself is not edited. `skills/prototype/SKILL.md` stays byte-identical to v1.2.3, per `skills/UPSTREAM.md`. curia moves its own words to the skill instead: the domain term is **Prototype** rather than Spike, and `spikes/` is renamed `prototypes/`.

The #54 sketch made the gate a bare `ask_human(approve-reject)`. It shipped as its own tool and escalation kind, `request_review`, for three reasons the plain form cannot meet: the daemon composes every link from its own records so an agent cannot forge them, the daemon can tell the gate apart from any other block, and the approval becomes a durable journal fact only the daemon can stage. The gate requires a concrete `charting` field, per [ADR-0006](0006-worker-containment-and-standing-orders.md).

## Consequences

- Reconcile keeps a claim with an open pull request from `curia/<n>`. Awaiting review is not a dead claim.
- A re-dispatch continues `origin/curia/<n>` where it exists, so commits under review are never discarded.
- Merge ends the workspace lease. Every uncertain case keeps the worktree, loudly.
- An agent that skips the gate is reported (`resolved_unreviewed`), not repaired into silence. Daemon-authored comments carry a machine marker so they never satisfy the resolution-comment check.
- Landing survives in the daemon as a repair only, and it says plainly when nobody looked.
