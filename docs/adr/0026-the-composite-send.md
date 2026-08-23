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
| prose | the answer to an operator note, or the intent of the send | Grade B, 1200 characters |
| round | `questions[]`, as ADR-0019 | unchanged |
| choice | `options[]`, as ADR-0019 | unchanged |
| approve-reject, preview-review | as ADR-0019 | unchanged |
| visual | a code-block table or an ASCII diagram | geometry, as ADR-0019 |
| files | attachments with one caption line | caption Grade A |

Any message may carry attachments, and a file rides the message it belongs to. The files format exists for the artifact that stands alone.

The prose message at 1200 characters and the question background below are the two new caps. Every other cap of ADR-0019 stands, and the word lint stands unchanged (#622, round 2).

### The question background

A question of a round takes an optional background block: Grade B, 600 characters, rendered under its line. The question line and the recommendation stay one line each, so the round still reads as a numbered list of decisions.

### Which calls compose

`ask_human` sends an array with the deciding message last. `notify` sends one with no deciding message, and a prose message carries the answer that never fit the 600-character status line. `request_review` composes one for the reply after a rejection. `report_result` and the verdict stay single messages.

### The disciplines

`detail` carries facts only. A file carries an artifact: a diff, a mock, a log. The explanation lives in a prose message, never in the spoiler and never in an attached markdown file. A card stands alone without a download.

### The dressing goes to a prototype

The operator wants better use of the Discord formatting palette: titles, small text and the signal emoji, plus richer visuals and images for clarity of intent. Layout is curia's, so the palette is a render choice, judged by taste on mocks. A prototype ticket mocks composite sends in five distinct variations per round (#635) and settles the dressing, the message order and the image use. The agent's word lint does not change with it.

## Consequences

- The build lands with the handoff ([#533](https://github.com/alp82/curia/issues/533)): the tool schemas grow the array shape, the bridge posts a sequence, and the chat screen renders the same sequence.
- The one `context` field from round 2 of #622 is superseded and never ships.
- ADR-0019 gains two caps: the prose message at 1200 and the question background at 600. Its vocabulary, floors, grades and other caps stand.
- ADR-0020 is unchanged. A composite send lives in the middle of the thread story, and the story floor holds.
- `curia.yaml` gains `dispatch.messages_per_send`, default 4, with a settings row.
- A new prototype ticket mocks the composite sends and blocks the handoff.
