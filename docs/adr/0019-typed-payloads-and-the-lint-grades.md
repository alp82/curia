# ADR-0019: Typed payloads and the lint grades

**Status**: accepted (2026-08)
**Provenance**: [Typed HITL payloads (#413)](https://github.com/alp82/curia/issues/413), [What Discord renders well (#414)](https://github.com/alp82/curia/issues/414), [The card (#415)](https://github.com/alp82/curia/issues/415), [Reject-on-lint live check (#416)](https://github.com/alp82/curia/issues/416), [ADR: typed payloads and the lint contract (#417)](https://github.com/alp82/curia/issues/417), [The select menu, built and judged (#431)](https://github.com/alp82/curia/issues/431), [The chunker breaks a code fence (#432)](https://github.com/alp82/curia/issues/432), [Reject-on-lint on the codex harness (#438)](https://github.com/alp82/curia/issues/438), [Typed notify (#420)](https://github.com/alp82/curia/issues/420), [Typed verdict carriage (#421)](https://github.com/alp82/curia/issues/421), [The flip (#422)](https://github.com/alp82/curia/issues/422)

> **Amended by [ADR-0026](0026-the-composite-send.md) (#640).** The `visual` FIELD below retires, and `picture`, `table` and `diagram` replace it. `images` is renamed `attachments`. The never-stacked small-print rule gains one named exception, the question background. The prose cap of a composite send is 1600, and a question background is Grade B at 600. Everything else on this page stands.

> **Amended on August 29, 2026.** A wayfinder `report_result` also requires `map_updates[]` entries of `{ text }` and `new_frontier[]` entries of `{ ticket, title }`. Empty arrays are explicit readings. Curia closes the report with both sections, so Discord receives the tracker state that the agent's local final prose used to carry alone.

## Context

Agent prose reaches the operator on five surfaces: `ask_human`, the review gate, `report_result`, `notify` and the cross-check verdict. Every one of them takes a free string today.

A free string has two faults. It carries no floor, so a card can drop the cost of an option and still send. It also carries no names, so the daemon cannot lint a part it cannot point at. The requirement behind map [#413](https://github.com/alp82/curia/issues/413) is one sentence: agent prose that reaches a human must be plain, simple and concise, and it must lose no information.

[ADR-0005](0005-escalation-contract.md) already holds the mechanism that enforces the words. This ADR holds the shape that mechanism reads, and the two grades it reads at.

## Decision

### One vocabulary, seven names

Every surface takes a subset of one vocabulary. One name means one thing on every surface.

| Name | What it carries | Grade |
|---|---|---|
| `headline` | the whole decision in one line | A |
| `question` | one question of a round | A |
| `option` | one choice, by its label | A |
| `consequence` | what one option costs | A |
| `example` | one concrete case for an option | B |
| `visual` | a code-block table or an ASCII diagram | geometry |
| `detail` | short facts, rendered as a spoiler | A |

Three fields ride beside them and carry no prose: `images` (the existing paths), `timeline` (a flag, and curia composes the link), and `preview_url`.

[#415](https://github.com/alp82/curia/issues/415) picked this shape as card 4 and proved the floor. The headline, the options and one consequence per option are mandatory. The example and the visual are agent judgment, because a field required on every option produces filler. A card that needs neither is still card 4.

### The shape per surface

Every `ask_human` kind takes `headline` (required), and `detail`, `visual`, `timeline` and `images` (optional).

| Surface | Also required | Also optional |
|---|---|---|
| `ask_human` free-text | `questions[]` of `{ text }` | `questions[].recommendation` |
| `ask_human` choice | `options[]` of `{ label, consequence }` | `options[].example`, `options[].recommended` |
| `ask_human` approve-reject | none | `options[]`, exactly two |
| `ask_human` preview-review | `preview_url` | `options[]`, exactly two |
| `request_review` | `headline`, `summary`, `charting` | `detail`, `visual` |
| `report_result` | `ticket`, `status`, `headline`, `summary`; for wayfinder, `map_updates`, `new_frontier` | `detail`, `visual`, `details` |
| `notify` | `message` | `kind`, `detail`, `visual`, `images` |
| verdict | `headline`, `summary`, `findings[]` of `{ text, severity }` | `detail`, `visual`, `findings[].out_of_scope` |

Five rules read this table.

1. **A round is typed.** `questions[]` replaces the numbered questions an agent writes inside one prose prompt (#285). curia derives the **✅ All as recommended** button from the array: the button renders when every question carries a `recommendation`, and it renders on no other round. The `recommended` boolean retires. An agent could set that flag on a round where one question had no recommendation, and the button then lied about it. A derived button cannot lie.
2. **approve-reject and preview-review keep curia's button words.** When the agent gives two options, curia takes the two consequences and keeps its own labels. The order is fixed: approve first.
3. **`details` on `report_result` stays a free record.** It is machine-facing, no surface renders it, and no lint reads it.
4. **The verdict floor is a headline, a summary and a findings list.** The list may be empty, and a finding carries a severity. [#421](https://github.com/alp82/curia/issues/421) settled both, and the second section below is what it settled. The `notify` kind set was [#420](https://github.com/alp82/curia/issues/420)'s decision the same way, and the first section below is what it settled.
5. **A wayfinder ending carries the tracker state it leaves.** `map_updates[]` has one `{ text }` entry per map or child-ticket change. `new_frontier[]` has the complete takeable frontier after those writes, with each ticket's number and title. An empty array says that section is empty. A missing array says nothing and is refused for a wayfinder session.

### The notify kind set (#420)

Rule 4 above left this set open. [#420](https://github.com/alp82/curia/issues/420) settles it at three kinds, and the axis is **what the operator must do**.

| Kind | The operator | Prefix |
|---|---|---|
| `progress` | does nothing | ⚙️ |
| `look` | opens a file or a page now | 🔗 |
| `ask` | replies whenever they get to it | ❓ |

`progress` is the default, so a call that names no kind keeps the exact line the thread has always read.

The axis is what makes the set checkable. A set built on the agent's own weighting — routine against notable, minor against important — is a claim the payload cannot check, and this ADR retired the `recommended` boolean over exactly that. A `look` states that a file or a page is waiting, which the call itself carries. An `ask` states that a reply is wanted, which the card under it repeats in small print.

Three kinds and no fourth. A finding is `progress`, because the operator acts on it later. A prototype that is ready is `look`. An ending is neither, because `report_result` already sends the ending report (#419).

An `ask` blocks nothing, and that is the whole difference between it and `ask_human`. A reply reaches its agent as an operator note on the next tool result the agent reads. An agent that cannot go on without the answer calls `ask_human`, which blocks. The escalation contract of [ADR-0005](0005-escalation-contract.md) is unchanged: a decision still blocks, and an `ask` is never a way around it.

❓ joins the signal set of [ADR-0013](0013-one-voice-per-fact.md). The other six signals say what curia or an agent did, and none of them says that a reply is wanted.

**A refused status line never holds a turn.** The gate is the same three-strike gate, on a key of its own, so a refused line and a refused question never spend each other's attempts. The Stop-hook catch differs, because nobody waits on a status line: curia posts the held text itself, flagged, and lets the turn end. Holding a turn to redeliver a line the operator did not ask for costs more than the line is worth. #438's rule still holds, because the words reach the human either way.

### The verdict shape (#421)

Rule 4 left the finding shape open. [#421](https://github.com/alp82/curia/issues/421) settles it, on the last untyped surface of this map. The cross-check verdict is the reviewer's `report_result`, and [ADR-0010](0010-the-cross-check.md) makes it the reviewer's only output.

| Field | What it carries | Grade |
|---|---|---|
| `headline` | the verdict in one line | A |
| `summary` | what the reviewer read and what it ran | B |
| `findings[].text` | one finding: the file and the line, what is wrong, why it matters | B |
| `findings[].severity` | `blocker`, `concern` or `note` | enum |
| `findings[].out_of_scope` | the finding is real and sits beyond this ticket | flag |
| `detail`, `visual` | as everywhere else | A, geometry |

**A finding carries a severity, and the grade of the verdict is derived from it.** One blocker makes the verdict `fail`. One concern makes it `concerns`. Neither makes it `pass`. The reviewer never writes that word, so a verdict cannot pass over its own blocker. This is the rule that retired the `recommended` boolean, read on a second surface: a derived fact cannot lie, and a typed one can.

A severity is still the reviewer's own weighting, which [#420](https://github.com/alp82/curia/issues/420) refused as an axis for the `notify` kinds. The two differ in what the claim is about. A `notify` kind claims something about its own payload, which the payload can contradict. A severity claims something about the diff, which is the whole thing a cross-check is for. The verdict is an opinion by design, and ADR-0010 gives the builder and the operator the last word on it.

**An empty findings list is a verdict.** A clean reading is a real result, and a floor of one finding would make a reviewer that found nothing write filler — the fault this ADR named when it left `example` to agent judgment. The field is still required after the flip: an empty list says the reviewer found nothing, and a missing one says nothing at all.

**An out-of-scope finding is marked, not dropped.** ADR-0010 sends it to the builder's charting field, and the mark is what the builder sorts on. The reviewer marked it inside its own prose before this ticket, which no reader could sort by.

**The judgement keeps the round it already has.** The builder answers a verdict with `ask_human`, and #418 typed that surface. So the judgement needs no shape of its own: the builder puts one question per finding in one round, each with its recommendation, which earns the ✅ All as recommended button. `noteJudgement` posts the composed card as the second pull-request comment, so the record and the thread read the same text.

**One composer, and the artifact stores what it built.** The pull-request comment, the builder's note and the thread carrier (#252) are three renderings of one verdict. `composeVerdict` builds that text once, and `data/verdicts/<ticket>.json` keeps the parts beside it. The reviewer's ending post in the thread reads the same composer, because `composeResultReport` can render only a summary and would drop every finding.

**The reviewer's exemption ends here.** #419 exempted the reviewer from the report lint while this surface stayed untyped. It now takes the verdict lint, on the same `report-result` ledger key: a reviewer makes no other linted call, so nothing of its own spends those three attempts, and the Stop-hook catch the report already has fits a verdict unchanged.

### Two grades, and one check that is not a grade

`daemon/assets/voice.md` stays the one authority on words. The grade decides which of its rules a field is held to.

**Grade A is inline decision text**: `headline`, `question`, `option`, `consequence`, `detail`. This is the text the operator reads before deciding, so it is capped and structureless.

1. A hard character cap. The field is refused above it, never truncated.
2. One line. A newline is a fault.
3. No markdown structure: no heading, no table row, no blockquote, no code fence, no list marker.
4. No link. curia composes every link it renders (ADR-0013).
5. No semicolon, no em-dash, no marketing adjective.

**Grade B is block prose**: `example`, `summary`, `charting`, the `notify` message, and a verdict finding. This text explains, so it keeps its sentences and loses its decoration.

1. A character cap per field.
2. No heading, no table row, no blockquote. This is the `lintReply()` rule that already ships in `daemon/src/messaging.mjs`. It reads prose only (#432), so a table inside a fence passes. The code-block table is the one table form Discord renders.
3. At most 25 words per sentence.
4. No semicolon, no em-dash, no marketing adjective.
5. No emoji outside the signal set. This rule also already ships.

**`visual` is not prose, so no grade reads it.** curia checks its geometry and never its words.

**The lint checks deterministic rules only.** Passive voice, nominalizations and "-ing" main verbs stay in `voice.md` as author guidance. A rule a machine must guess at produces a false rejection, and a false rejection costs the agent one attempt out of three.

**The contraction rule is gone, and its absence is a decision.** `voice.md` used to be Simplified Technical English, which bans contractions, so the lint refused them. The voice is now the Google developer documentation style, which requires them. A lint that refuses what `voice.md` asks for would reject nearly every call an agent makes, so the check was deleted rather than inverted. Telling an author to contract a word is style advice, not a rule a machine decides.

### The caps

| Field | Cap |
|---|---|
| `headline` | 150 characters |
| `question` | 250 characters |
| `option` label | 80 characters |
| `consequence` | 300 characters |
| `example` | 300 characters |
| `detail` | 500 characters |
| `visual` | 42 columns by 20 lines |
| `summary`, `charting`, `message`, finding | 600 characters |

**A cap is a ceiling, not a target.** The operator set these numbers as the point where curia refuses. A card that says the whole decision in 40 characters is a better card, and no rule here pushes an agent toward the limit.

The 80 on an option label is the number a select menu can carry whole. [#431](https://github.com/alp82/curia/issues/431) built the menu and measured it: one option shows 100 characters of label and 100 of description, and `daemon/src/bridge.mjs` splits a longer option across the two. A consequence may run to 300, so it does not fit that description. The menu therefore carries the label and the tap, and the card body under it carries the whole option with its consequence. This is the rule #431 already ships, and the caps keep it true rather than change it.

The 500 on `detail` gives the spoiler room for several facts on one line. The rule that governs it is not the number. Facts belong in the spoiler, and reasoning belongs on the timeline. The spoiler [#415](https://github.com/alp82/curia/issues/415) judged was only 334 characters and it still read badly, because it held an argument.

The `visual` cap does more than fit a phone. 42 columns by 20 lines is under 900 characters, so it sits under `CODE_BLOCK_LIMIT`, which [#432](https://github.com/alp82/curia/issues/432) set at 1000 characters in `daemon/src/messaging.mjs`. A typed visual therefore passes the block cap the lint already ships, and it never reaches the 1600-character chunk limit.

The fence defect itself is closed, and this cap is not what closed it. [#432](https://github.com/alp82/curia/issues/432) made `chunkMessage()` read a fence: a block that fits moves whole into one chunk, and a block that cannot fit closes its fence at the split and reopens it. That covers bot prose and a flagged send, which no lint cap can reach. The `visual` cap earns its place as the phone limit from [#414](https://github.com/alp82/curia/issues/414), not as a fence guard.

### What the render path may use

[#414](https://github.com/alp82/curia/issues/414) and [#431](https://github.com/alp82/curia/issues/431) measured this on a phone. The catalogs are `prototypes/discord-render/index.html` and `prototypes/select-menu/index.html`.

| Form | Rule |
|---|---|
| Code-block table, ASCII diagram | at most 42 columns |
| Spoiler | the `detail` renderer |
| Small print (`-# `) | one line, never stacked |
| Image | scale 2 is the legibility floor, and a glyph is at least 10 pixels tall in an 800-pixel image |
| Buttons | 2 to 4 options, and bot voice only |
| Select menu | 5 to 25 options. It carries the label, and the card body carries the consequence |
| Numbered list | 26 options or more |
| Attachment | `.png .jpg .jpeg .gif .webp` at 8 MB, `.patch .diff .md .txt .log` at 1 MB, four files per call |
| Bare markdown table | refused in prose, Grade A and Grade B both |
| Code block | at most `CODE_BLOCK_LIMIT`, 1000 characters (#432) |

A card with buttons speaks in the bot voice, because an interactive component needs an application-owned webhook. This is the one place ADR-0013's speaker rule bends, and it bends for the answer surface only.

### The rejection

[ADR-0005](0005-escalation-contract.md) owns the reject-on-lint contract, and this ADR does not restate it. A lint fault refuses the call with the fault named and quoted. The agent rewrites its own text. Three rejections is the cap, the daemon counts them, and the fourth text goes out flagged. On codex the Stop hook is what makes the rejection unmissable.

A **schema** fault takes the same path, with one rule of its own. **A schema rejection never traps a question.** At the third schema rejection curia sends whatever text fields the call did carry, flagged, and the operator sees which fields were missing. A call that carried no text at all has nothing to send, so curia refuses it for good and says so. The alternative is a question that reaches nobody, which is the failure [#438](https://github.com/alp82/curia/issues/438) spent a whole ticket closing.

### The flip (#422)

The typed fields shipped one surface per ticket, and one deploy landed them all ([#422](https://github.com/alp82/curia/issues/422)). Before that deploy an untyped call was accepted and rendered as it always had. After it, a call that omits a required field is rejected. Every floor in the table above is unconditional now, and `notify` is the one surface the flip left alone: `message` was its floor before and after.

**The switch is gone, not set.** One constant held the floors off while the surfaces shipped. It had no second position left after the flip, and a rollback is a revert plus a deploy either way, so the flip deleted it rather than pinning it to true.

**The three retired fields are named, never dropped.** An `ask_human` call carried a `prompt`, an `options` array of bare strings and a top-level `recommended` boolean. All three are refused now, and each refusal says where that content goes. They stay declared on the tool schema for one reason: zod strips a key it does not declare, and a stripped `prompt` would take the agent's whole question with it. Losing information in silence is the fault this map exists to stop.

**An untyped call still reaches the operator at the cap.** The rejection rule above is unchanged by the flip: three refusals, then curia sends whatever text the call did carry, flagged. So the untyped rendering survives as the last stop of a refused call, and no question is lost to the flip. A call carrying no prose at all is still the one refusal that is final.

## Consequences

- The daemon lints a named field, not a blob. A rejection can quote the fault and name the field, and [#416](https://github.com/alp82/curia/issues/416) measured that a named fault is fixed in one attempt.
- The mandatory floor is now machine-checkable. A choice card that drops the cost of an option cannot send after the flip.
- The `recommended` boolean retires, and the ✅ button becomes a fact about the payload rather than a claim about it.
- An agent loses the freedom to lay out its own card. It writes the parts, and the bridge lays them out. This is ADR-0002 read at the level of one message: the bridge renders, it never interprets.
- A cap refuses rather than truncates. Truncation loses information in silence, and losing no information is the requirement this whole map serves.
- Every surface is settled and flipped. The `notify` kind set (#420) and the verdict shape (#421) are the two sections above, and both build against this vocabulary. #422 turned the floors on and retired the untyped fields.
- The lint is weaker than `voice.md`. It checks the deterministic rules only, so prose that passes the gate can still read badly. The operator remains the last reader.
- The `visual` field emits a fence on a common path, and the render path already carries it (#432). `fenceParts()` and `CODE_BLOCK_LIMIT` are exported from `daemon/src/messaging.mjs`, so [#418](https://github.com/alp82/curia/issues/418) reuses them rather than writing a second fence reader.
