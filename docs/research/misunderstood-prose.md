# Why prose in the main channel is misunderstood

Research for [wayfinder #518](https://github.com/alp82/curia/issues/518). The question: prose typed in `#curia` is not always understood correctly by the command routing and the overseer. This note names the failure patterns, each with its evidence.

Sources, all read on 2026-08-17:

- The router and the bridge at the current `main`: `daemon/src/commands.mjs`, `daemon/src/bridge.mjs`, `daemon/src/overseerprompt.mjs`.
- The local journal sample `daemon/data/events.jsonl`: 852 events, 2026-07-24 to 2026-08-01.
- The local overseer transcripts under `daemon/data/overseer/config/projects/`: 7 sessions from the 2026-08-01 rehearsal.
- The rehearsal live check `docs/live-checks/96-overseer-rehearsal.md` (commit `fec75db`).
- The prior cold read [discord-thread-surprises.md](discord-thread-surprises.md), which read all 131 threads on 2026-08-09.
- Closed issues on alp82/curia: #65, #120, #170, #177, #202, #236, #253, #255, #326.

**Limitation.** The live journal database `daemon/data/events.db` is on the production box and is not reachable from this machine. The local `events.jsonl` is an old sample that ends on 2026-08-01. The local overseer transcripts cover only the #96 rehearsal. Turns after 2026-08-01 come from the prior cold read and from issue text, not from raw records.

## How text is routed today

The bridge splits every message by place, not by content (`daemon/src/bridge.mjs:1808-1856`):

1. A top-level message in `#curia` always opens a thread and starts an overseer turn (`bridge.mjs:1811-1816`). No top-level text ever reaches the deterministic router.
2. A message in a thread with an open escalation answers that escalation (`bridge.mjs:1858-1883`).
3. A message in a thread bound to a live agent queues as an operator note (`bridge.mjs:1830-1853`). Two heuristics decorate the receipt: `COMMAND_SHAPED` adds a "commands run in #curia" hint (`bridge.mjs:156-196`), and `QUESTION_SHAPED` adds a direct status answer (`bridge.mjs:204-244`).
4. A message in any other thread revives that thread's overseer session (`bridge.mjs:1855`).

The deterministic router (`parseCommand`, `daemon/src/commands.mjs:189-266`) sees only three inputs: slash commands expanded by `expandCommand` (`bridge.mjs:379`, wired at `bridge.mjs:1668`), REST calls, and canonical text the overseer's verb tools compose (`ctx.interpreted`, `commands.mjs:302-316`).

So "misunderstood prose in the main channel" decomposes into three classes: the router refuses a line, the bridge sends words to the wrong handler, or the overseer model itself misreads.

## Class A: deterministic-router misparses

**A1. The overseer composed a repo form the router refused.** During the 2026-08-01 rehearsal the operator typed "please start the codeword ticket 90 on alperortac". The overseer called `start` with `repo: "alperortac"`, the seam composed `start alperortac#90`, and the router refused it: `parseCommand` accepted only a bare number or the full `owner/repo#n`. The journal holds the refused lines at 09:56:30 and 10:00:51, both `by: "overseer"`. Transcript `88b4ff22` shows the model recover by retrying a bare `start 90`. Fixed the same day: commit `fec75db` added the fuzzy `repo#n` form (`commands.mjs:109-113`).

**A2. The overseer composed `map <n> <prose>` without the then-required `--`, three times, and the operator gave up.** On 2026-08-06 the router refused the same overseer-composed line three times in four minutes. The refusal went to the operator, not back into the overseer session, so the loop had no self-correction. Evidence: [discord-thread-surprises.md](discord-thread-surprises.md) section 5, issue #255. Fixed twice over: commit `c7f9236` retired the `--` and routes an interpreted refusal back as the model's own tool result (`INTERPRETED_REFUSAL`, `commands.mjs:78-83` and `commands.mjs:315`).

**A3. The verb grammar is asymmetric, and the operator's typed forms fall into the gaps.** On 2026-07-28 08:15 the operator sent `cancel alp82/alperortac.com#70`. The router refused it: `cancel` takes only a bare number or a chat handle (`AGENT_RE`, `commands.mjs:219-224`), while `start` accepts the repo-qualified form (`commands.mjs:104-108`). The operator retried `cancel 70` in the same minute. Retired options show the same shape: `start 42 backend=codex` (journal 2026-07-24 23:49) and the `harness=` family, which the router now refuses with a named rule instead of the catalogue (`commands.mjs:91-92`, issue #177).

**A4. A stale client manifest turned a missing option into a fake argument.** On 2026-07-26 10:37 the journal holds `start null`, typed by the operator's phone: the client sent a `/start` with no ticket, and the expansion interpolated the absent option as the literal string "null". Fixed in `expandCommand`: a missing required option is now a named refusal, not a value (`bridge.mjs:369-384`, issue #65 found the stale-manifest cause).

## Class B: prose that fell to the wrong handler

**B1. There is no text command path in the main channel, so a typed verb costs a model turn and a thread.** During the rehearsal the slash picker was unusable from the synthetic keyboard, so `/status` landed as plain text three times. Each one opened a fresh thread named "status" and ran a full Haiku session that called the `status` tool (`bridge.mjs:1811-1816`; journal `overseer_session` events at 09:52, 09:54, 09:55; transcripts `8657f69a`, `f9b12876`, `d81d2fc3`, each one turn). The result was correct every time, but one fixed verb produced three threads and three sessions. The thread name is the message text, so the channel's thread list fills with command fragments and typos ("out sstart the cancel fodder ticket 91 on alperortac please" is a live thread name, [discord-thread-surprises.md](discord-thread-surprises.md) section 7).

**B2. A command typed at an agent thread queues as prose and does nothing.** `cancel 166`, typed in the ticket-166 thread, queued as an operator note. The agent was a dead shell, so nothing read it, and the operator waited an hour (issue #170). The journal in that issue shows five such notes, none of them prose. The mitigation is the `COMMAND_SHAPED` hint under the receipt (`bridge.mjs:156-196`), drawn wide on purpose. The words still queue instead of executing.

**B3. A question in an agent thread got a delivery receipt, not an answer.** The operator typed "whats taking so long" at curia-81 after 18 minutes and got "queued for `curia-81` — it reads this with its next tool result" (issue #236). The mitigation is `QUESTION_SHAPED` plus `statusAnswer`, composed from records with no model in the loop (`bridge.mjs:204-244`, `bridge.mjs:262-275`). The eager regex is deliberate: a false positive costs one extra line.

**B4. Words addressed to a dead agent used to die silently.** The receipt now says "NOT running, so nothing was queued: these words reached nobody" when the agent is gone (`bridge.mjs:268-272`, issues #170 and #208). The prior cold read found the hard case: a cross-check verdict queued as a note expired unread, with no line that said so ([discord-thread-surprises.md](discord-thread-surprises.md) section 2).

## Class C: overseer misunderstandings

**C1. The overseer paraphrases a refusal and invents a cause.** When the router refused `start alperortac#91` (A1), the overseer told the operator: "Ticket 91 does not exist on `alperortac`, or the repo name is not recognized." The router said neither. It said "could not parse". The operator had to contradict the model ("that ticket does exist - try the same start again") before the dispatch went through (transcript `0a4d7fc6`; the live check records the same nit). The A2 fix closes the loop for the re-compose, but a model paraphrase of any error can still assert a cause the error never gave.

**C2. The overseer misreads its own tool output.** In the rehearsal `tickets` reply, the agent-only tickets were #90 and #91. The overseer summarized "Two agent-only (#79, #80)" (transcript `88b4ff22`; live check, nits). The count was right and the ids were wrong. Nothing checks a summary against the tool text it summarizes.

**C3. The overseer narrates state it does not own, beside the daemon's own line.** The rehearsal dispatch answer ("Watching for readiness") posted after the daemon's readiness notify had already landed (live check, nits). The standing orders now ban the whole class: "Never announce a dispatch. The daemon posts its own line" (`daemon/src/overseerprompt.mjs:63`, issue #253).

**C4. The map vocabulary is carried by prompt prose, and every rule in it marks a past or predicted miss.** The standing orders spend nine lines on map resolution (`overseerprompt.mjs:49-57`): a map named in prose resolves to that map's header, never to repo-wide order (#120 wrote this rule after the item-9 decision); `start` works a map and `map` updates it; a map that does not exist yet takes no number. These are instructions to a model, not code. The A1 and A2 incidents show what happens when the model's composition drifts from the grammar. No local transcript shows a wrong-map dispatch, but the rule at `overseerprompt.mjs:51` exists because picking the repo's first takeable ticket when the operator named a map dispatches the wrong ticket.

**Adjacent, not main-channel:** agents also report ticket ids in shapes the daemon must normalize. The local journal holds 7 `result_ticket_mismatch` events, including a full issue URL as a ticket id (2026-07-28 12:43). Issue #202 covers the stray-thread consequence.

## The pattern behind the patterns

Two structural facts produce most of the incidents:

1. The overseer does not call the router's grammar. It calls typed tools, and a seam composes canonical text from the arguments (`ctx.interpreted`, `commands.mjs:302-316`). Every Class A overseer incident is the seam composing a line the parser refuses. The fixes so far widen the parser (A1), retire syntax (A2), and return refusals to the composer (A2). Each fix is reactive: the grammar and the prompt are maintained by hand to agree.
2. Place decides the handler, and the operator thinks in content. A verb typed in a thread is prose (B2). A question typed in a thread is a queued delivery (B3). A verb typed in the channel is a model conversation (B1). The heuristic regexes (`COMMAND_SHAPED`, `QUESTION_SHAPED`) patch the two worst mismatches with hints, not with routing.

## Recommendation

A grilling ticket on the overseer's command understanding should follow. The Class C incidents are model behavior, and no control catches them today: a paraphrased refusal (C1) and a wrong id in a summary (C2) both reach the operator as confident prose. The questions the grilling should ask:

1. When the router refuses an overseer-composed line, what may the overseer tell the operator? Is "report the refusal verbatim, then retry" a standing order, and what enforces it?
2. What keeps the verb-tool schemas, the seam composition, and `parseCommand` in agreement? Is there a test that composes every tool-argument shape and asserts the router parses it?
3. Should a fixed verb typed as top-level text ("status", "tickets") run through `parseCommand` before it becomes an overseer turn, and what does that do to the one-thread-per-conversation rule (#326)?
4. When the overseer summarizes tool output, what bounds the summary? Should the standing orders require ticket ids to be copied, never restated?
5. The map rules live only in prompt prose (`overseerprompt.mjs:49-57`). Which of them can move into the tools (for example, a `map_exists` distinction in the schema), so a model cannot pick the wrong shape?
6. What evidence does the production `events.db` hold after 2026-08-01? This note's transcript sample ends there, and the grilling should start by pulling newer misrouted turns from the box.
