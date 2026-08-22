# ADR-0025: The interactive cards under the one voice

**Status**: accepted (2026-08)
**Provenance**: [The Discord cards, redressed (#606)](https://github.com/alp82/curia/issues/606), on [map #511](https://github.com/alp82/curia/issues/511). The operator picked on rendered mocks, all as recommended. Details [ADR-0021](0021-the-thread-formatting-and-the-one-voice.md) and [ADR-0020](0020-the-thread-story.md). Extends the card shape of [ADR-0019](0019-typed-payloads-and-the-lint-grades.md), the option bands of #415 and #431, and the wave grouping of [ADR-0023](0023-the-skill-dispatch-from-prose.md).

## Context

ADR-0021 redressed the thread and killed the card head, but the interactive parts kept their old rules. Buttons repeat the full option label. The answered and cancelled marks are full weight. The verdict leads with the reviewer's status. The wave grouping of the gate had a mock on the skill route only. The mockups under `prototypes/card-mockups/` put each part beside its redressed cut, and the operator picked.

## Decision

### The choice card's buttons carry a handle

A button says the letter and a short handle, for example `A · journal`. The body holds the full words, so the button is a press target and not a second statement of the option. The handle comes from the option label. How it is authored is a build question: a new per-option field, or a cut the daemon makes.

### Every card names the file path

The answer instruction is one small-print line, and it says that a reply may carry files. The files ride the answer as stored paths, every file, in reply order.

### The bands survive

Two to four options are buttons. Five to 25 options are one select menu. Past 25 the numbered list stays, as the surface of last resort. The cap stays at 25, which is Discord's own ceiling on a string select.

### The ticket gate groups charting by waves

A charting that proposes tickets prints wave heads: what can dispatch at once. The card numbers the items itself, edges name card numbers, and the real issue numbers appear only on the receipt after approval. This is the shape ADR-0023 picked for the skill gate, now on both routes. A charting with no new tickets keeps plain prose lines and no wave heads.

### The verdict leads with the finding

The verdict opens with `🔎 the cross-check found:` and the typed headline. The grade line and the findings follow. The reviewer's status drops to mechanics small print. A blocked reading still leads with blocked at full weight, because there the status is the news.

### The marks are small print

The answered mark and the cancelled mark edit onto the card in small print. A mark is mechanics, and the receipt already reads that way. The answered mark counts the files the answer carried.

### One card, two surfaces

The dashboard chat card binds to a four-line contract. One payload: both surfaces render the typed card, and neither invents a word. Same markers: the letters and the numbers match, so a typed reply, a Discord press and a chat tap resolve the same index. First valid answer wins, and the second surface shows the receipt, never a second question. One receipt: the same mark text on the card, the chat and the record.

## Consequences

- `bridge.mjs` changes: the choice buttons take the handle, the marks drop to small print, and the instruction lines name the file path.
- The band constants and `selectFits` stand unchanged.
- `card.mjs` reorders the verdict composition, and the gate text grows wave heads when the charting proposes tickets.
- The chat screen build (#524) takes the parity contract as a requirement.
- The handle needs an authoring path, and that lands with the build.
- The mockups live under `prototypes/card-mockups/`, one self-contained page, as the primary source of these picks.
