# ADR-0013: One voice per fact

**Status**: accepted (2026-08)
**Provenance**: [Who speaks in a thread, and where a note's outcome appears (#247)](https://github.com/alp82/curia/issues/247), grounded in [the thread surprise catalog](../research/discord-thread-surprises.md) from [#245](https://github.com/alp82/curia/issues/245), on [map #244](https://github.com/alp82/curia/issues/244)

## Context

Six composers speak in a ticket thread, and no rule divides them. The cold read of 131 threads found every ending narrated by three identities in four messages, every spawn announced twice, every button answer echoed twice, and operator notes acted on with no word back. One cross-check verdict expired unread nine seconds after a reviewer session produced it, and the thread showed nothing. Each composer speaks correctly by its own rule, and no rule owns the thread as a whole.

## Decision

### The root rule

CuriaBot states mechanics. The agent voice states meaning. A fact belongs to exactly one voice, and no fact is said twice in one thread.

- **CuriaBot** owns lifecycle facts the daemon can verify: spawned, at composer, waiting, cancelled, failed, session closed. It owns receipts.
- **The `curia-<n>` webhook voice** owns the work: what was done, what a note led to, what the result is.
- **The overseer's `curia` voice** owns conversation the operator addressed to the channel. It never states ticket lifecycle.

### The events

- **Ending**: two messages, fixed order. First the agent's report. The report holds the pull-request link, and it is the only place the link appears. Then one CuriaBot small-print receipt that merges the old resolved, done, and finished lines. The mechanics line carries no bare links, so nothing re-unfurls.
- **Spawn**: CuriaBot's composer-ready line is the only announcement. The overseer never narrates a dispatch it triggered. When the overseer chose the ticket, the choice is meaning: it may state the choice and the reason, never "is running".
- **Button answer**: the card is the only record. The bridge acknowledges the interaction silently and edits the card in place. No interaction reply exists.
- **Thread rename**: Discord posts one system line per rename, and no flag suppresses it. This is the one voice curia does not own, so the rule is enforced by renaming less. The thread name answers one question the status line cannot reach: does this thread need the operator. Putting the ⏳ or 🔎 glyph ON is worth its line, because its reader is away. Taking it OFF is not, because its reader just answered. So a clear is held for two minutes and any newer state cancels it ([#277](https://github.com/alp82/curia/issues/277)).

### The note loop

A thread message has two delivery modes, and the operator picks.

- **Queued** is the default and is fire-and-forget. The receipt carries an interrupt button. No drain receipt exists: an operator who wants a reply presses interrupt.
- **Interrupt** gives the current tool call a grace of a few seconds, then injects the message as a user turn. The agent answers it the way it answers any user message. That reply is the outcome, in the thread, in the agent's voice.
- **Expiry always announces.** A note that dies with no reader gets a CuriaBot line in the thread. A dead agent cannot reply, so the daemon must.

### The verdict

- **A pending cross-check gates the ending.** When a reviewer starts, the builder is told at once: a cross-check is reading your diff, and the verdict arrives as a message. The daemon enforces the wait: while a verdict is pending, `report_result`, resolve, and merge park exactly as `request_review` parks ([ADR-0010](0010-the-cross-check.md), #165). The verdict then always has a live reader.
- **A verdict with no live reader is posted, not mourned.** When the target agent is gone, CuriaBot posts the verdict content into the thread with attribution: who wrote it, what it found, where the full text lives. An ordinary note gets one expiry line. A verdict gets its content, because it is the output of a whole reviewer session and the thread is its last reader.

## Consequences

- The ending trio, the spawn duo, and the answer echo collapse. A thread reads as one narrator per fact.
- A held clear buys a false positive, bounded by the window: a thread can read ⏳ for two minutes after it was answered. The hold is ephemeral, so a daemon restart inside the window loses it and the thread keeps the glyph until the agent's next question or its ending. The ending always settles the name.
- The interrupt mode needs daemon plumbing: abort a running tool call after grace and inject a user turn. Queued keeps the shipped path.
- The cross-check gate closes the #223 race by construction. The carrier rule stays as the net for a cross-check started after the builder is gone.
- The overseer loses its spawn narration. Its remaining surface is conversation and choice rationale.
- The degraded mode (a missing Manage Webhooks grant collapses every voice into CuriaBot, #143) still announces itself. The ownership rule survives as message prefixes until the grant returns.
