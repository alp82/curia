# The threads, read cold: every routing and ownership surprise

Research for [wayfinder #245](https://github.com/alp82/curia/issues/245), on [map #244](https://github.com/alp82/curia/issues/244). The destination line this grounds: no message is ignored, bot identities are stable, and no fact is said twice in one thread.

Sources, all read cold on 2026-08-09:

- Every thread in #curia: 131 threads, 1,723 messages, plus 205 top-level channel messages, fetched raw over the Discord REST API.
- The live journal on the box: `daemon/data/events.jsonl`, 2,667 events (2026-07-24 to 2026-08-09).
- The daemon source at `ac31087`, to attribute each message shape to its composer.

## The cast of voices

Every message in a thread comes from one of six composers. The census below is the ground truth for the identity sections.

| Voice as Discord shows it | Composer | Code path | Count |
|---|---|---|---|
| `CuriaBot` (bot) | Bridge and daemon: escalation cards, receipts, status lines, link lines, ending lines | `bridge.mjs` `#sendChunked`, fed by `dispatch.mjs` `notify()` | ~900 |
| `CuriaBot` (bot, system) | Discord itself: one system line per thread rename | rename via `threadname.mjs` gate | 179 |
| `CuriaBot` (interaction reply) | Bridge: the echo after a button press or slash command | `bridge.mjs:1234` `i.reply(...)` | 128 + 9 |
| `curia` (webhook) | The overseer: a Haiku session composes the prose | `overseer.mjs` reply, posted by `bridge.mjs` `#sendAs('curia', ...)` | 65 |
| `curia-<n> · <ticket title>` (webhook) | The agent: `notify` and `report_result` prose | `index.mjs:986` and notify handler, via `#sendAs` | 83 |
| `alp82` (human) | The operator | - | 100 |

Two structural facts follow from the census. First, the operator wrote 100 of 1,723 thread messages, so the bot side speaks about 16 lines for every human line. Second, 77 of 131 threads carry two or more bot voices, and 38 threads carry four or more. A reader who wants to know "who said that" must know this table, and nothing in the thread teaches it.

## 1. Notes with no word back

A human line in a ticket thread becomes a queued note. The bridge posts a small-print receipt: "queued for `curia-<n>` - it reads this with its next tool result" (`bridge.mjs:187`, `queuedNoteReply`). That receipt is the last thing the system promises. Nothing requires the agent to say what it did with the note.

Evidence:

- **#108, "also check if 118 is a duplicate or contains separate work."** The note drained 17 minutes later (journal `agent_notes_drained` 09:31). The agent did the work: item 1 of its review-gate charting block says "Close #118 ... as a DUPLICATE of #108." But no message ever answers the note as a note. The outcome hides inside a 25-line gate message under a different heading, two hours later. The operator remembered it as ignored, which is the correct reading of the thread surface.
- **#81, "whats taking so long".** Drained 16 minutes later. The agent did answer, but inside a longer status notify ("Time went into the Convex series..."). The answer exists because the agent chose to give one.
- **#169, "whats taking so long?".** Drained in 51 seconds. The thread shows no reply that names it.

Composer: the receipt is the bridge, the outcome (when one exists) is agent prose. Frequency: 12 visible note receipts across the dump. Journal: 9 `agent_note`, 6 `worker_note`, 5 `overseer_note`. The gap is not that notes get lost in delivery. The gap is that the contract ends at "it reads this", and reading is invisible.

## 2. Messages that die with nobody to read them

The queued-note path has a harder failure: a note queued at an agent that is gone. #208 made notes survive the instance they were queued at. What still dies:

- **The #223 cross-check verdict expired unread.** Journal, 2026-08-05 10:18:39: the four-finding `fail` verdict from `curia-review-223` was queued as a note (`after: esc-126`). Nine seconds later: `agent_notes_expired`, `live_instance: null`, `count: 1`. A whole reviewer session's output - VERDICT: fail, four findings, one of them a real race - reached no agent, and the thread shows no line that says so.
- **The #173 verdict almost died the same way.** The thread carries "📭 the verdict on #173 has nowhere to go" (journal `verdict_undelivered`). That one at least says it out loud.

Composer: `dispatch.mjs` verdict return path plus the note queue in `index.mjs`. Frequency: 1 silent expiry, 1 announced dead end, out of 2 cross-checks that completed. The sample is tiny and the loss rate in it is total.

## 3. One event, many voices

The ending of #107 is the clean exhibit. Between 23:58:10 and 23:58:28, four messages from three identities narrate one fact (the ticket is done):

1. `curia-107 · Prototype: ...` (webhook): "✅ reports **resolved**: ..." - agent prose, `index.mjs:986`.
2. `CuriaBot`: "✅ alp82/aistack#107 resolved - ticket closed; map #76 already had the pointer; code merged (link)" - `dispatch.mjs:2827`.
3. `CuriaBot`: "🏁 `curia-107` · done" - the status line, `statusline.mjs:291`.
4. `CuriaBot`: "✅ `curia-107` finished with a recorded result - session closed; ... worktree removed" - `dispatch.mjs:3149`.

Then a fifth system line lands as the thread renames to ✅. The spawn edge has the same shape in miniature: the overseer says "Agent is running on ticket 108..." as `curia`, and four seconds later the daemon says "✅ `curia-108` is at the composer on **opus**" as `CuriaBot`. Same event, two voices, two wordings.

Two smaller identity wobbles compound it:

- The reviewer posts as `curia-review-173` in one thread and as `curia-review-173 · <ticket title>` in another message of the same thread. One agent, two names.
- When the Manage Webhooks grant is missing, every webhook voice silently collapses into `CuriaBot` (`bridge.mjs` `#sendAs` fallback). #143 made the degradation announce itself, but the collapse itself is still a mode where every identity rule above changes.

Frequency: all 54 recorded results narrate the ending in 3 to 4 messages (93 done lines, 72 resolved lines, 52 finished lines, 83 agent reports across the dump). Every one of the 95 dispatches has the spawn duo.

## 4. One fact, said twice

Distinct from the many-voices problem: the same fact posted as two messages, by design.

- **Every button answer is echoed twice.** The bridge edits the escalation card to "✅ **answered** by @... via button: ..." (`bridge.mjs:1074`) and also posts an interaction reply "✅ **esc-156** answered: ..." (`bridge.mjs:1234`). 128 interaction replies stand beside 153 journal `esc_answer` events. Worse, the two land far apart in the scroll when the card is old, so the reply reads as news about something the card already shows.
- **The ending trio repeats the pull-request link three times**, and each bare link unfurls the same GitHub embed again. In #108 the identical PR-body embed renders three times in four consecutive messages.
- **The human answer can appear twice.** In #241 the operator pressed `reject` on esc-158 and posted the reasoning as a thread reply. The reply was queued as a note, the button echo landed six minutes later, and the operator re-posted the same paragraph so it would attach to the rejection. The journal holds the identical note text twice (10:18 and 10:24). The affordance caused this: a *review* gate treats a thread reply as the rejection text, an *approve-reject* question does not, and nothing in the card says which rule is in force.
- **Preview and state lines repeat verbatim.** "🔗 `curia-107` updated the preview (dev server on :9006)" five times in one thread. "✅ `curia-170` is at the composer" six times, "⚰️ `curia-170` cancelled" seven times, during one afternoon of respawn loops. "⚠️ `curia-81`: opening the pull request FAILED - (same git stderr)" three times.

Composer: bridge for the echoes, dispatch for the ending and failure lines. Frequency: the answer echo is 100% of button answers, the ending repetition is 100% of results, the verbatim repeats ride every retry loop.

## 5. Refusals

Four distinct refusal shapes, three composers:

- **Overseer scope refusal.** "I cannot add repos. That is a daemon configuration task outside my scope." (`projects` thread). Composed by Haiku, correct on the boundary, and the wording is whatever the model produced that day. This is the class the operator remembers as "the agent refuses work the wayfinder skill covers": the refusing voice is the overseer, not a dispatched agent, but on screen both are bot voices in a curia thread.
- **Router parse refusal, caused by the overseer itself.** On 2026-08-06 the operator asked, in prose, for a new map ticket. The overseer composed `map 147 new ticket to make the map commands ticket param optional...` - without the `--` the router demands - and the router refused with "❌ could not parse". The operator rephrased twice, the overseer composed the same broken shape twice more, three refusals in four minutes, and the operator gave up and typed bare `map 147`. One day earlier the same overseer composed the same verb correctly with `--`, twice. The seam text is model-composed and nondeterministic, and the refusal loop has no self-correction: the router's error message goes to the operator, not back into the overseer's context.
- **Daemon fault refusal.** "🚫 `curia-170` reached its composer with **no curia tools** twice - refusing to dispatch #170 again on this fault." (`dispatch.mjs`). Correct and well-worded, but it arrives after two full spawn-ack cycles that each said "✅ is at the composer" first, so the thread reads success-success-refusal.
- **Agent capability refusal.** "I cannot mark Discord threads - only you can" (#223), and the #223 container-wall report ("no tmux binary and no codex credential... the map stops one step short"). These are honest bounds statements. They surprise only because they arrive as plain prose with no standing place, so each agent invents its own wording.

Frequency: 3 parse refusals (one incident), 3 🚫 lines, a handful of prose refusals. Small counts, large memory footprint: refusals are the lines the operator quotes weeks later.

## 6. Truncated and mangled messages

- **The identity itself truncates.** Discord caps a webhook username at 80 characters. Nine agents in the dump speak under a name that ends in "…": `curia-208 · A note queued at a dead agent outlives the instance it was…`. The mangling lands on the speaker label, the one surface #108 item 15 moved meaning into.
- **Raw stderr in the thread.** The PR-failure line pastes `e.message` verbatim (`dispatch.mjs:2093`): two lines of `git -C /home/alp/... fatal: cannot change to ...`, three times in #81. The daemon speaks its own internals in a surface built for prose.
- **Old-shape nudges re-posted whole questions.** 43 "⏰/⚠️ still waiting on **[esc-N]**" messages re-quote the question's first line, 15 times for one question in `ticket-66`, 7 in `ticket-86`. The journal holds 243 `esc_nudge` events. The current code refreshes the card in place, so this class is mostly historical, but the old posts still shape what the threads look like when read cold.
- **Command receipts and hints are sub-text small-print** (`-# ...`), and two receipts can stack in one message ("-# ⏳ `curia-241` is waiting on esc-158 ... -# queued for `curia-241` ..."), which reads as one mangled line on a phone.

## 7. The thread is not one thing per ticket

The binding says thread-per-ticket, the history says otherwise. Seven tickets own more than one thread: #147 has four, #173 four, #209 three, #166 three, #112, #170 and #138 two each. The causes stack: threads created from channel commands keep the command text as their name ("start 169 - it might be already done not sure", "out sstart the cancel fodder ticket 91 on alperortac please"), re-dispatch from another thread moves the binding and leaves the old thread with a pointer line ("moved to <link> - dispatched from there, so it reports there now"), and on 2026-08-05 three "🎫 173" threads appeared within 600 ms of one another.

The name is also a state surface, and it lags or lies. #81's thread renamed to 🔎 (review glyph) four minutes *after* the done line, and the archived thread reads as "in review" forever. `threadname.mjs` documents the race (the stuck-🎫/stuck-🔎 bug) and the hidden 2-renames-per-10-minutes budget that makes every name late by design. The 179 rename system lines are themselves a said-twice problem: each one repeats a state change the status line already announced.

## What holds up well, for contrast

The escalation card itself is predictable: one card, edited in place, answer recorded on it, buttons under it. The chunking rule (`messaging.mjs`, #119) means no message clips mid-thought. The queued-note receipt always appears. The surprises above sit almost entirely in the space *between* composers - bridge, daemon, overseer, agent each speak correctly by their own rule, and no rule owns the thread as a whole.

## Fix classes this note grounds

1. A queued note owes a visible outcome: an acknowledgment when drained, an announcement when it expires (the #223 verdict must be impossible to lose silently).
2. One event, one message: collapse the ending trio and the spawn duo, and stop echoing answers the card already shows.
3. Speaker names must fit: no "…" in an identity.
4. The overseer seam needs a closed loop: a parse refusal returns to the composer that wrote the text, or the router accepts the instruction shape the overseer keeps producing.
5. Failure lines dedupe across retries and translate stderr.
6. Thread identity: one live thread per ticket, and a final name that matches the ending.
