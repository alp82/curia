# ADR-0026: The composite send

**Status**: accepted (2026-08)
**Provenance**: [When Discord response structure must yield to message intent (#622)](https://github.com/alp82/curia/issues/622), on [map #511](https://github.com/alp82/curia/issues/511). Five operator rounds decided the shape. Extends the typed payloads of [ADR-0019](0019-typed-payloads-and-the-lint-grades.md), the one voice of [ADR-0021](0021-the-thread-formatting-and-the-one-voice.md) and the cards of [ADR-0025](0025-the-cards-under-the-one-voice.md).

## Context

A typed card fits a decision, and not every exchange is one. An agent that answers an operator question has no field for the answer. The explanation lands in the one-line spoiler or in an attached markdown file, and the operator named both counterproductive. A grilling cannot always live in the question-and-answer shape. [aistack#205](https://github.com/alp82/aistack/issues/205) is the named example.

Round 2 considered one loose `context` field with a meaning per surface. The operator rejected it. Those meanings are standard fields that deserve proper names, and one name means one thing (ADR-0019). The operator set the direction instead: a response returns an array, and each entry keeps its own format.

## Decision

### One send, several messages

A send is one agent call. It returns an ordered array, and each entry renders as its own Discord message, with its own typed format and its own optional attachments. The sequence carries the intent: an answer, then an image, then a round. Each message keeps its rigid shape and its own lint. Nothing loosens. Composition replaces relaxation.

### The deciding message posts last

At most one message of a send decides. A round, a choice, an approve-reject or a preview-review is a deciding message. It posts last, so the buttons sit at the thread bottom. One answer surface, unique markers, one receipt. The first valid answer wins, and the chat parity contract of ADR-0025 binds the whole sequence.

### The cap on a send

A send carries at most four messages. The count is a `curia.yaml` default, `dispatch.messages_per_send`, with a row on the settings screen. This is the pattern [#635](https://github.com/alp82/curia/issues/635) set for the prototype variation count. curia refuses a send above the cap, and it never drops a message.

### The message catalog

| Format | Carries | Lint |
|---|---|---|
| prose | the answer to an operator note, or the intent of the send | Grade B, 1600 characters (#640, was 1200) |
| round | `questions[]`, as ADR-0019 | unchanged |
| choice | `options[]`, as ADR-0019 | unchanged |
| approve-reject, preview-review | as ADR-0019 | unchanged |
| visual | a code-block table or an ASCII diagram | geometry, as ADR-0019 |
| files | attachments with one caption line | caption Grade A |

Any message may carry attachments, and a file rides the message it belongs to. The files format exists for the artifact that stands alone.

The prose message and the question background below are the two new caps. Every other cap of ADR-0019 stands, and the word lint stands unchanged (#622, round 2). The prose cap was 1200 when #622 set it. [#640](https://github.com/alp82/curia/issues/640) moved it to 1600, and the amendment below says why.

### The question background

A question of a round takes an optional background block: Grade B, 600 characters, rendered under its line. The question line and the recommendation stay one line each, so the round still reads as a numbered list of decisions.

### Which calls compose

`ask_human` sends an array with the deciding message last. `notify` sends one with no deciding message, and a prose message carries the answer that never fit the 600-character status line. `request_review` composes one for the reply after a rejection. `report_result` and the verdict stay single messages.

**On `request_review`, the gate card is the decision.** The card is curia's: it composes the pull request, the preview, the diff digest and the tracker-write waves from records no agent can author, so no agent could write it as a `preview-review` message. The send therefore carries the reply and nothing that decides, and the card posts last, under it. That is the ADR-0026 order read on this surface rather than an exception to it, and a send here that carries a deciding message is refused by name.

The send is judged in the gate's own verdict rather than on a key of its own. A send and a gate arrive on one call, so they spend one of the three attempts together, and an agent fixing both reads both faults at once. `summary` still says what changed; the reply to the rejection is the send.

The messages post from inside the gate call, at the instant the card is certain to open. `requestReview` refuses on five paths before it composes anything - a live cross-check, an unjudged verdict, a skill run with no tracker writes, a broken binding, the preview bounce - and posting above the call would leave the agent's reply in the thread with no gate under it. A send that fails to post does not take the card with it: the operator can still judge the diff.

### The disciplines

`detail` carries facts only. A file carries an artifact: a diff, a mock, a log. The explanation lives in a prose message, never in the spoiler and never in an attached markdown file. A card stands alone without a download.

### The dressing goes to a prototype

The operator wants better use of the Discord formatting palette: titles, small text and the signal emoji, plus richer visuals and images for clarity of intent. Layout is curia's, so the palette is a render choice, judged by taste on mocks. A prototype ticket mocks composite sends in five distinct variations per round (#635) and settles the dressing, the message order and the image use. The agent's word lint does not change with it.

That prototype is [The composite send, mocked (#640)](https://github.com/alp82/curia/issues/640), and the section below is what it settled.

## The dressing, settled (#640)

Five operator rounds on `prototypes/composite-send/index.html` decided every question this ADR left open. Titles lost. The dressing is a small-print rail, and the palette entry that won is the one ADR-0021 already uses for mechanics.

### The rail

Every message of a send opens with one small-print line: its number in the send, then a label.

```
-# 1 of 3 · answer
-# 2 of 3 · cost per stack
-# 3 of 3 · decision
```

curia writes the count, so the reader knows how far the send runs before it asks. The agent writes the label, at most 20 characters, linted as inline text. That is the status-line label rule of ADR-0021 read on a second surface. The label is plain and descriptive, with no article and no flourish: `answer`, not `the answer`.

A send of one message carries no rail, because there is nothing to count.

Discord groups consecutive messages from one sender, so a send of three renders under one avatar and one timestamp. The rail is what gives that block its seams back. A Discord heading was the alternative and it lost: three headings for 400 words is furniture, and a two-message send takes a title it does not need.

### The prose message

The cap rises from 1200 to **1600**, which is `CHUNK_LIMIT` in `daemon/src/messaging.mjs`, so the lint and the splitter agree on one number and no prose entry is ever split behind the agent's back.

`CHUNK_LIMIT` rises to **1700**. The rail line shares the Discord message with the prose it labels, so a full 1600-character field arrives as about 1620 and the old limit would have cut it. 1700 is still 300 under Discord's own 2000, so the margin that keeps a code fence off a split survives.

Past 1600 the agent composes a second prose message, and the refusal names that path rather than only naming the cap. An agent that only hears the number spends its three attempts squeezing. Composition is what this ADR says answers length, and the agent breaks where the meaning breaks.

The conclusion leads, in bold. The body under it is paragraphs or a list, chosen by what the content is: a sequence of timestamped events is a list, and an argument is not. Leading with the conclusion is the shape the ending report already takes (ADR-0021) and the shape the verdict took in ADR-0025, and it survives being read halfway, which is what a phone does to a long block.

### The question background

Small print, behind 💡. The glyph joins the eight signals of ADR-0013 as the ninth, and it means the background of a question.

The block renders as one wrapped line or as a stack, and the agent chooses per question. A background that argues one point is one line. A background that lists separable facts is a stack. This is the prose rule above read on a third surface: the form follows what the content is.

**The question background is the named exception to ADR-0019's never-stacked small-print rule.** That rule stands everywhere else. It was always about authored newlines, so a background written as one line breaks nothing and needs no exception at all.

### When the agent composes

One rule, and no shape catalog:

> A message exists when a reader would want to skip it on its own. Anything a reader always reads together stays one message.

It goes in the standing orders and the tool description. A named catalog of send shapes was the alternative and it lost, because a catalog is a second type system over a typed payload, and the first send that needs a shape outside it is refused for being unusual rather than wrong.

### The image

Four forms stand, and the agent picks per question under the rule above:

- The image rides the deciding message, when the reader will not want to skip it.
- The image is its own message, posted before the decision, so the buttons keep the thread bottom.
- An ASCII diagram replaces it, when the question is about structure rather than finish.
- The image leads the send and a prose message reads it, when the agent's reading of its own render is worth having before the decision.

One image per option is **cut**. A comparison is the one case that needs both images on one screen, and one image per option puts them on two.

### The visual fields

`visual` names a **message format** and nothing else. The `visual` field of ADR-0019 retires, and three fields replace it, one per form the [#414](https://github.com/alp82/curia/issues/414) catalog measured and kept:

| Field | Carries | Check |
|---|---|---|
| `picture` | an image the reader looks at in place | the #414 legibility floor |
| `table` | a code-block table | geometry, and the columns line up |
| `diagram` | an ASCII drawing | geometry |

The `visual` message format carries the same three. Splitting `table` from `diagram` is what lets curia check that a table's columns align. One combined field could never run that check, because a diagram has no columns to align.

`images` is renamed **`attachments`**. It has accepted `.patch`, `.diff`, `.md`, `.txt` and `.log` since it shipped, so the name has never been true. The pair now states the two acts it always meant: `picture` is what a reader looks at, and `attachments` is what a reader downloads.

## Consequences of the #640 amendment

- ADR-0019 changes in four places. Its `visual` field retires in favor of `picture`, `table` and `diagram`. Its `images` field is renamed `attachments`. Its never-stacked small-print rule gains one named exception, the question background. Its prose cap moves from 1200 to 1600.
- ADR-0013's signal set gains a ninth entry, 💡, for the background of a question.
- `CHUNK_LIMIT` in `daemon/src/messaging.mjs` moves from 1600 to 1700, and the prose lint reads the same 1600 the chunker used to.
- `bridge.mjs` gains the rail: the count is curia's, the label is the agent's, and a send of one message gets none.
- The refusal at the prose cap names the second-message path. A refusal that only names a number teaches the agent to cut rather than to compose.
- The mockups live under `prototypes/composite-send/`, one self-contained page with 57 variations, as the primary source of these picks. `NOTES.md` beside it records all five rounds and what came back from each.

## Consequences

- The build lands with the handoff ([#533](https://github.com/alp82/curia/issues/533)): the tool schemas grow the array shape, the bridge posts a sequence, and the chat screen renders the same sequence.
- The one `context` field from round 2 of #622 is superseded and never ships.
- ADR-0019 gains two caps: the prose message at 1200 and the question background at 600. Its vocabulary, floors, grades and other caps stand.
- ADR-0020 is unchanged. A composite send lives in the middle of the thread story, and the story floor holds.
- `curia.yaml` gains `dispatch.messages_per_send`, default 4, with a settings row.
- A new prototype ticket mocks the composite sends and blocks the handoff.
