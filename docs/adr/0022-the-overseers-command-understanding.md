# ADR-0022: The overseer's command understanding

**Status**: accepted (2026-08)
**Provenance**: [The overseer's command understanding (#528)](https://github.com/alp82/curia/issues/528), on [map #511](https://github.com/alp82/curia/issues/511), grounded in [Why prose in the main channel is misunderstood](../research/misunderstood-prose.md) (#518).

## Context

Prose in the main channel fails three ways. The router refuses a line the overseer composed. The bridge sends words to the wrong handler, because place decides the handler and the operator thinks in content. The overseer itself misreads: it paraphrased a refusal into the invented cause "Ticket 91 does not exist", and it retyped the ids in a `tickets` summary wrongly. The research note holds the incidents. The six decisions below close the ticket, all taken as recommended.

## Decision

### The refusal is quoted, never explained

When the router refuses a line the overseer composed, the overseer repeats the refusal word for word, then names its retry. It must not state a cause the refusal did not name. A prompt test asserts the standing order text, the way the new-map phrase test does today.

### One roundtrip test guards the seam

A generated test builds every tool-call shape, composes each through `canonicalFor`, and asserts `parseCommand` returns the same verb and fields. The cases cover every verb spec and every optional-argument combination. Today only `map` and `start` have spot checks, and the A-class incidents came from hand-maintained agreement.

### A typed verb runs before a model turn

A top-level message in `#curia` goes through `parseCommand` first. When the whole trimmed line parses, it runs as a typed command: no overseer session, and no thread named after the text. Prose still opens a conversation thread. The reference incident is three `status` threads and three model sessions in four minutes.

### Ids are copied, never retyped

A standing order: the overseer copies every ticket id from the tool reply of this turn, never from memory. A later daemon check can flag an answer id that no tool reply of the turn holds, the way curia lints agent text today ([ADR-0019](0019-typed-payloads-and-the-lint-grades.md)).

### The map tool becomes two

`map_update` requires a map number. `map_new` requires the operator's brief and has no number field. Both compose the same router verb, so the router and the slash surface do not change. The exists-test moves from prompt prose into the schemas, and the wrong shape becomes impossible to call. The header-resolution rule stays prose, because it needs the model's judgment.

### The production journal gets a read script

A committed read-only script lists every refused command, every thread a typed verb opened, and every command-shaped note after 2026-08-01. The operator runs it on the box and pastes the output on a task ticket. Local evidence ends on 2026-08-01, so the script is the one source of newer misrouted turns.

## Consequences

- `overseerprompt.mjs` gains two standing orders, refusal speech and verbatim ids, and loses the map-shape prose the schemas will carry.
- `overseerverbs.mjs` splits the `map` spec in two and keeps `canonicalFor` as the one tool-to-router contract.
- The bridge gains a `parseCommand` fast path in front of `overseerTurn` for top-level text.
- A task ticket carries the journal mining, with the script in the repo.
- The rest of the build lands with the map's to-spec and to-tickets handoff.
