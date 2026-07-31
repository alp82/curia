# ADR-0008: Resolved means merged

**Status**: accepted (2026-07)
**Provenance**: [The PR gap (#48)](https://github.com/alp82/curia/issues/48), [Build the merge-gated resolution lifecycle (#54)](https://github.com/alp82/curia/issues/54)

## Context

The full-loop rehearsal closed a ticket and wrote its map pointer while the code sat in an unmerged pull request. Nothing watched that pull request. A rejection would have made the map lie, because Decisions-so-far said the question was answered and nothing walked it back.

## Decision

- A dispatched ticket is resolved only when a human approved the work and the code is in the default branch. The ticket stays open and claimed through the whole review.
- The worker stays alive through the review and performs the whole ending itself: `open_pull_request` (opens once, updates the same pull request each round), `request_review`, then on approval the worker merges, resolves per protocol, and calls `report_result`.
- A rejection is a loop, not an ending. The human's words come back as feedback, the worker commits again on the same branch, and it asks again. There is no rejection counter. `/cancel` is the give-up rule.
- The ending is one structure in code, rendered twice: as prose in the spawn prompt and as the checklist the Stop hook blocks with. The Stop hook refuses a stop that leaves ending steps open, up to the stop budget, then lets go and reports the ticket unfinished.
- The containment boundary of [ADR-0006](0006-worker-containment-and-standing-orders.md) is redrawn on purpose: the worker writes to the remote only the one merge a human has just approved. The click carries the authority.
- Awaiting review holds a worker slot. Backpressure is correct when the human review is the bottleneck, so the concurrency cap is a resource number, not a review-latency number.
- CI does not change the answer. Where CI exists it is evidence on the pull request, never a second authority.

## Deviations

The #54 sketch made the gate a bare `ask_human(approve-reject)`. It shipped as its own tool and escalation kind, `request_review`, for three reasons the plain form cannot meet: the daemon composes every link from its own records so a worker cannot forge them, the daemon can tell the gate apart from any other block, and the approval becomes a durable journal fact only the daemon can stage. The gate requires a concrete `charting` field, per [ADR-0006](0006-worker-containment-and-standing-orders.md).

## Consequences

- Reconcile keeps a claim with an open pull request from `curia/<n>`. Awaiting review is not a dead claim.
- A re-dispatch continues `origin/curia/<n>` where it exists, so commits under review are never discarded.
- Merge ends the workspace lease. Every uncertain case keeps the worktree, loudly.
- A worker that skips the gate is reported (`resolved_unreviewed`), not repaired into silence. Daemon-authored comments carry a machine marker so they never satisfy the resolution-comment check.
- Landing survives in the daemon as a repair only, and it says plainly when nobody looked.
