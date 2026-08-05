# ADR-0008: Resolved means merged

**Status**: accepted (2026-07)
**Provenance**: [The PR gap (#48)](https://github.com/alp82/curia/issues/48), [Build the merge-gated resolution lifecycle (#54)](https://github.com/alp82/curia/issues/54), [Map dispatch (#160)](https://github.com/alp82/curia/issues/160), [Map updates get their own verb (#221)](https://github.com/alp82/curia/issues/221)

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

**The map dispatch (#160, deciding #149; the verb moved by #221).** `map <n>` on a map's own issue spawns a charting agent, and this ADR does not apply to it. A charting agent's output is the map itself — issue bodies and child issues, inside an ordinary agent's write bounds — so there is no branch to stage it in, nothing for a pull request to carry, and nothing for a review gate to show. It therefore never merges, never resolves, and never closes the map. It ends on two steps: edit the map, then `report_result`. Curia posts that summary as a comment on the map.

What replaces the gate is the operator, per [#149](https://github.com/alp82/curia/issues/149): the dispatch is a deliberate act carrying their own instruction, and the map routes to the strongest claude-harness model. Two things hold the exception in place rather than leaving it to the prompt. The daemon refuses `open_pull_request` and `request_review` on a charting agent, so an agent that has misread its own kind is not one call away from pushing a branch. And the dispatch's kind is journalled at the spawn, so a restarted daemon still knows which of the two endings it is holding an agent to — reading a charting agent as a ticket one would close the map, which takes a whole effort off every frontier.

**The verb and the claim ([#221](https://github.com/alp82/curia/issues/221)).** #160 put charting on `start`, which gave one word two meanings: `start <n>` worked a ticket and `start <map>` charted. The operator ruled the overload confusing after using it. `start` now has one meaning everywhere — work the thing — and on a map number it dispatches that map's next takeable ticket. Charting has its own verb.

No dispatch claims a map. #160 assigned the map to serialize the body edits, and a claim's whole meaning is "off a frontier" — a map is never on one, so the assignee said nothing true and made the issue read as worked. The lock that replaces it was already there: a charting agent on map #147 runs in session `curia-147`, and `map 147` is refused while that session lives. The check asks `tmux has-session` rather than daemon memory, so it survives a restart and catches a session reconcile has not adopted yet. It is per box, and there is one box.

The #54 sketch made the gate a bare `ask_human(approve-reject)`. It shipped as its own tool and escalation kind, `request_review`, for three reasons the plain form cannot meet: the daemon composes every link from its own records so an agent cannot forge them, the daemon can tell the gate apart from any other block, and the approval becomes a durable journal fact only the daemon can stage. The gate requires a concrete `charting` field, per [ADR-0006](0006-worker-containment-and-standing-orders.md).

## Consequences

- Reconcile keeps a claim with an open pull request from `curia/<n>`. Awaiting review is not a dead claim.
- A re-dispatch continues `origin/curia/<n>` where it exists, so commits under review are never discarded.
- Merge ends the workspace lease. Every uncertain case keeps the worktree, loudly.
- An agent that skips the gate is reported (`resolved_unreviewed`), not repaired into silence. Daemon-authored comments carry a machine marker so they never satisfy the resolution-comment check.
- Landing survives in the daemon as a repair only, and it says plainly when nobody looked.
