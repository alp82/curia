# ADR-0023: The skill dispatch from prose

**Status**: accepted (2026-08)
**Provenance**: [Mock transcripts of prose skill invocation (#535)](https://github.com/alp82/curia/issues/535), on [map #511](https://github.com/alp82/curia/issues/511). The operator picked on rendered mock transcripts. Details the skill decisions of [Who runs to-spec and to-tickets (#517)](https://github.com/alp82/curia/issues/517), and applies the story of [ADR-0020](0020-the-thread-story.md) and the rendering of [ADR-0021](0021-the-thread-formatting-and-the-one-voice.md) to a skill run.

## Context

#517 opened the vendored skills to dispatch and left the UX open: how a skill asked for in prose reads on Discord. ADR-0022 fixed the ground under it. A typed verb runs typed, and prose opens an overseer conversation. The mockups told one story, a finished map handed to the build, with candidates at the two open joints: how the overseer routes the ask, and how the review gate shows the proposed tracker writes.

## Decision

### Two routes coexist, split by the ticket

An ask that resolves to a ticket carrying the skill routes as `start`. The seam composes `start <n>`, curia types the slash command into the dispatch prompt as it does for `/wayfinder`, and the run is a normal ticket run.

An ask that no ticket carries routes as a new `skill` verb. The seam composes `skill <name> <target>`, and the run has no ticket behind it. The build must give this run a durable record home, because the thread alone is not one ([ADR-0001](0001-github-is-the-only-durable-state-home.md)), and the review gate must bind to a run no ticket claims.

### No confirm press on a skill dispatch

The confirm press belongs to impactful decisions, like canceling an agent, and `cancel` already confirms that way (#94). A skill dispatch publishes nothing before the review gate, so the route runs without a press.

### The gate card groups by waves

The card that guards a skill run's tracker writes shows every title, every edge and every label, grouped under wave heads: what can dispatch at once, wave by wave. Every edge stays on its own line. Nothing is on the tracker when the card posts, so the card numbers the items itself, edges name card numbers, and the real issue numbers appear only on the receipt after approval.

### The run thread tells the ADR-0020 story unchanged

A skill run adds one fact to the opening: its product is tracker writes, so the opening says that nothing posts before the gate. The status line shows no preview button when no preview exists. A run with no commits has no pull request, and the receipt names the tracker writes instead of a merge.

## Consequences

- The verb catalogue grows a ninth verb, `skill`, beside the eight of `overseerverbs.mjs`. The roundtrip test of [ADR-0022](0022-the-overseers-command-understanding.md) covers it like every other verb.
- The record home and the gate binding for a ticketless run are build questions, and they land with the map's to-spec and to-tickets handoff.
- The mockups live under `prototypes/prose-skill-mockups/`, one self-contained page, as the primary source of these picks.
