# ADR-0023: The overseer take back rides the session chain

**Status**: superseded by [ADR-0024](0024-the-overseer-chat-is-a-pane.md) (2026-08). The take-back policy stands and ADR-0024 carries it. The journal-append mechanism retires.
**Provenance**: [The overseer chat rewind, and the two chat handlings (#543)](https://github.com/alp82/curia/issues/543), on [map #511](https://github.com/alp82/curia/issues/511), extending [ADR-0021](0021-the-take-back-is-the-harness-rewind.md) (#516).

## Context

ADR-0021 gave agent chats the take back: one press steps the conversation back one operator message, and curia drives the rewind the harness ships with keystrokes in the pane. It deferred overseer chats to this ticket, together with the question whether the two chat handlings must stay different.

An overseer conversation is no pane. Every operator message is one turn: one SDK query, with the resume id in and a new session id out (ADR-0015, ADR-0016). The daemon journals every session id as an `overseer_session` event, so the journal holds the whole chain of a conversation and not only its head. Queued curia notes drain into the next turn and ride inside the operator's own message, as prefixed lines.

## Decision

### The take back is a journal append

One press takes back the operator's last message. Curia appends a journal event that moves the conversation's resume id to the session id from before that message. The next turn resumes from the earlier session. The chat page follows the same pointer, so it shows the conversation as of the landing point. Another press steps one message further. The landing is exact, so this surface needs no correction path: every landing point is an operator message, because the drained notes ride inside it.

### The floor is the first message

No press removes the first message of a conversation. It is the invocation of the work, and that invocation cannot be undone. The same floor binds the agent chat: no press removes the dispatch prompt. ADR-0021 stated no floor, so the pane-driven rewind prototype (#542) carries this one.

### Only the operator's words go back

The take back applies to the operator's own messages, and never to what curia or the overseer said. A queued note that rode a taken-back message returns to the queue and rides the next one. The operator takes back their words, not the news.

### The press acts at once

A press while a turn runs stops the answer at once, and the landing is before the message that started it. This matches the agent chat, where the press also acts at once. The world keeps what ran: verbs that crossed the seam stand, and the receipt names them.

### The receipt is in the chat

The chat draws the receipt in place: a line that quotes the taken-back message, with the composer prefilled for editing. A Discord conversation reads the receipt as a thread message. A browser conversation has no thread, so the journal event is the receipt and the chat page draws it, the way the dropped-turn line works today.

### One surface today, terminals as the direction to explore

The chat surface stays one surface, with the driver seam of #267 beneath it. The operator picked the direction of giving the overseer terminals too, so both chats would be panes. That direction is not decided here: it needs research, a prototype and a grilling of its own, and the map gains those tickets. Until that decision, the split beneath the seam stays, and the overseer take back rides the session chain.

### The map outputs specs

This map outputs design specs and no implementation. The overseer take back lands with the build handoff. The terminal exploration builds its prototype on this map, because prototypes are how this map works.

## Considered options

A press during a running turn could refuse with a line until the turn ends. The operator rejected it: the take back acts at once on both chat kinds.

The receipt could live on the feed screen only. The operator rejected it: the text stays in the chat, and the composer prefills it.

The two handlings could stay split as the settled end state. The operator did not take it: the terminal direction gets its own research, prototype and grilling first.

## Consequences

- The overseer container gains a turn abort route, which it does not have today.
- The take back needs no correction path and no per-harness prototype on this surface: the resume is the mechanic every turn already uses.
- The pane-driven rewind prototype (#542) carries the floor: no press removes the dispatch prompt.
- The map gains three tickets: research, a prototype and a grilling on the overseer in a terminal. If that direction lands, the overseer take back becomes the pane rewind of ADR-0021, and the journal append retires.
- The chat screen (#524) and the messaging mockups shape the button and the receipt, as ADR-0021 says.
