# Live check: the overseer full-loop rehearsal (#96)

Ticket: [alp82/curia#96](https://github.com/alp82/curia/issues/96), on the overseer build map
[#90](https://github.com/alp82/curia/issues/90). An agent session drove both sides: the daemon on
this box, and the operator's Discord account through a browser under accessibility control. The
fixtures were a disposable test map ([alperortac.com#89](https://github.com/alp82/alperortac.com/issues/89))
with two child tickets: a codeword ticket that forces an escalation and a review gate
([#90](https://github.com/alp82/alperortac.com/issues/90)), and a cancel-fodder ticket that blocks
on a question ([#91](https://github.com/alp82/alperortac.com/issues/91)).

## What ran

One unbroken pass, 09:45–10:13 UTC, with two daemon restarts inside it:

1. **Boot.** `npm start` brought up the daemon, ttyd, and the bridge (`ready: guild=AI Stack channel=#curia`).
   539 unit tests pass.
2. **Prose turn.** A top-level message in `#curia` opened a fresh thread. Haiku interpreted the prose
   into `tickets alperortac`. The turn posted one edited status message (`-# ⚙️ …` small print) and
   one short answer. Both fixture tickets showed on the frontier.
3. **Prose dispatch.** "please start the codeword ticket 90 on alperortac" in that thread resumed the
   same session (`resume=<session>` in the log), ran `start`, claimed
   alp82/alperortac.com#90, spawned `curia-90` on sonnet (the `model:sonnet` label routed), renamed
   the thread to `🎫 90 · …`, and journalled `thread_bound`. The worker asked for the codeword and
   the question rendered in the bound thread.
4. **Restart one, mid-escalation.** The daemon was killed and restarted while esc-49 was open. The
   reboot recovered the escalation and re-adopted the live worker. A thread reply answered the
   recovered record. The worker's in-flight `ask_human` had died with the old process: it surfaced
   as a failed MCP task, and the worker re-asked (esc-50, the accepted posture). The re-ask was
   answered and the worker went to PR + review gate in under a minute.
5. **Restart two, mid-gate.** The daemon was restarted again while the review gate esc-51 was open
   (this restart carried the parser fix below). The gate survived the reboot. The worker re-called
   `request_review`, and esc-54 superseded esc-51 — the old message lost its buttons, the new gate
   went live.
6. **Button confirm.** "cancel the worker on ticket 91" from the channel opened a ✅/❌ confirm in the
   ticket's bound thread, instance-bound, stating the no-expiry/lapse rule. ❌ declined: the worker
   lived, the buttons stripped, the message edited in place. A re-issued cancel confirmed with ✅:
   the daemon (never the model) killed the session, removed the worktree, unassigned the ticket,
   orphaned the worker's open question, released the thread binding with the `🎫` rename stripped,
   and journalled a synthetic `overseer_note` for the asking thread's revival memory.
7. **Review gate to resolution.** ✅ Approve on esc-54, after a human-side diff read. The worker
   merged PR alperortac.com#92, wrote the resolution comment, closed the ticket, appended the map
   pointer to the test map, reported the result, and stopped. The journal shows
   `ticket_resolved … comment=present close=present map=present land=merged`, then `lease_released`
   (worktree removed) and `thread_released (finished)`.

## What broke

- **`start <fuzzyrepo>#<n>` did not parse.** The overseer's `start` tool invites a fuzzy `repo`
  field, and `canonicalFor` composes `start alperortac#91` from it — but `parseCommand` accepted
  only `<n>` or the full `owner/repo#<n>`. Haiku emitted the fuzzy form on both live dispatches;
  the first survived only because the model retried with a bare `start 90`. Fixed in place: the
  parser now takes the unslashed form and the router resolves it through the same `#matchRepo`
  the `tickets`/`next` verbs use. Five new tests; 539 pass.

## Nits (recorded, not fixed)

- The Haiku answer to `tickets` misattributed the agent-only count ("Two agent-only (#79, #80)" —
  the two agent-only tickets were #90/#91). Model quality, not mechanics.
- When the router refused `start alperortac#91`, Haiku paraphrased the refusal as "Ticket 91 does
  not exist", asserting a cause the router never gave. The parser fix removes the trigger, but a
  model paraphrase of a refusal can still invent reasons.
- The dispatch answer ("Watching for readiness") posts after the readiness notify already arrived —
  the model composed its answer before the notify landed. Cosmetic ordering.
- `result_ticket_mismatch` warned on `alp82/alperortac.com#90` vs bound `90` — the worker reported
  the repo-qualified id, the binding stores the bare number. The daemon correctly acted on the
  binding, but the warning is noise for a semantically equal id.
- The worker parked its blocking `ask_human` in a background MCP task and tried to stop; the Stop
  hook spent a nudge on a worker that was legitimately blocked, and the worker had to reason its
  way back to waiting. Harmless here, but the nudge budget is finite.

## Rehearsal limits

- **Slash interactions.** A synthetic Wayland keyboard cannot engage Discord's command picker, so
  `/status` landed as prose three times (each time handled correctly as an overseer turn). The
  slash-interaction ack path was not exercised live; button interactions cover the
  `interactionCreate` gate, and REST covers verb parity. The registered guild commands were
  verified to include the grown catalogue (`tickets`, `next`, `resume`).
- `next` was not run live: the fixture repo carries a real open map whose prototype tickets `next`
  would have dispatched. Unit tests cover it.
- `attach` links were rendered in replies but no browser attached to a worker during this run.

## Fixture teardown

Test map #89 and both children closed. `docs/curia-rehearsal-2.md` stays on the fixture repo's
`main` until the fixture map's teardown note is acted on; it is inert.
