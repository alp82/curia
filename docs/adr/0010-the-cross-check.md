# ADR-0010: The cross-check

**Status**: accepted (2026-08)
**Provenance**: [Settle cross-check semantics (#150)](https://github.com/alp82/curia/issues/150), parked as out of scope on [the PoC map (#1)](https://github.com/alp82/curia/issues/1)

## Context

One model builds a ticket, and one human approves it. That human is the only reader of the diff. A model on the other provider can read the same diff and disagree with it. The PoC map parked this idea because the dispatch plumbing was not proven yet. The plumbing is proven now, so the semantics need a decision.

## Decision

- The cross-check is a third button on the review gate, beside approve and reject. The operator presses it. Nothing starts a cross-check by itself.
- The reviewer is a full worker. It gets its own tmux session, its own status line in the ticket thread, and the sandbox any worker gets. The operator can attach to it and watch it read.
- The reviewer reads the diff, the ticket, and a live checkout of the branch tip. It can grep the repo and run the tests, so it can prove a finding instead of guessing at it. It does not read the builder's transcript, and it does not read the thread.
- The reviewer runs on the other provider. `routing.yaml` states the pairing: an anthropic builder gets `gpt`, and an openai builder gets `opus`. A `review-model:<name>` label on the ticket beats the table.
- If every model on the other provider is cooling, the reviewer runs on the builder's own provider. The verdict states this at its top, because a same-provider reading is the weaker check.
- The verdict goes to the builder, never to the operator alone. The builder judges each finding, agrees or disagrees with it, and writes a summary with a recommendation.
- The builder sends that summary as a plain question, not as a gate. The operator says what to do. The builder then acts, and the review gate returns as a pure approve-or-reject about the final code.
- The operator arbitrates a disagreement, and the builder gets the first word on it. There is no third model, and there is no automatic tie-break. The reviewer never gets a reply and never reads the same diff twice.
- A finding beyond this ticket's scope becomes charting. The builder's recommendation names the new ticket, and that line rides in the charting field of the gate. No worker opens a fault ticket by itself, per [ADR-0006](0006-worker-containment-and-standing-orders.md).
- The verdict lands as a pull-request comment, per [ADR-0001](0001-github-is-the-only-durable-state-home.md). The daemon posts it when it arrives, and it posts the builder's judgement as a second comment under it. The daemon holds both texts already: it spawned the reviewer, and the builder's summary is the escalation prompt.
- The reviewer writes nothing. It makes no tracker write, no push, no merge, no gate, and no charting. It produces a verdict and it ends.

## Consequences

- The button is pressable on every gate round. [ADR-0008](0008-resolved-means-merged.md) counts no rejections, and the cross-check follows the same rule.
- A cross-check costs two worker slots against `max_concurrent`. The builder stays idle and holds its slot while the reviewer reads.
- The reviewer needs a session name of its own, because `curia-<n>` is the builder's identity on every surface.
- git refuses the same branch in two worktrees, so the reviewer checks out the branch tip in its own worktree at a detached HEAD.
- The review gate now has three outcomes, so `request_review` is no longer a two-way answer. [ADR-0005](0005-escalation-contract.md) gains a button, not a new escalation kind.
- The cross-check adds no authority. Every tracker write still passes the one gate the operator answers.
- A verdict the operator never asked for cannot exist, so the reviewer burns no quota on a diff the operator was happy with.
