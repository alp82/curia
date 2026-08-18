# ADR-0021: The take back is the harness rewind

**Status**: accepted (2026-08)
**Provenance**: [Taking back a message (#516)](https://github.com/alp82/curia/issues/516), on [map #511](https://github.com/alp82/curia/issues/511), grounded in the checkpoint docs of both harnesses.

## Context

The operator wants to take back a sent message, as Claude Code does with its rewind: the conversation returns to an earlier message and goes on from there. The important case is the agent chat, not the overseer chat.

A message reaches an agent two ways, and they differ under rewind. An Ask now note enters the pane as a user turn. A queued note and a card answer ride a tool result, inside the agent's turn. The harness rewinds list user turns only. Claude checkpoints every user prompt and can restore files with the conversation. Codex backtrack steps through user messages and restores the conversation only. Neither can stop at a tool result.

## Decision

### The rewind on user turns

One press steps the agent back one message. The conversation returns to just before the operator's last user turn, and the work after it leaves the conversation. Another press steps one message further. Curia drives the rewind each harness ships, with keystrokes in the pane. Files restore together with the conversation where the harness checkpoints them. Where it cannot, the receipt says the tree stands.

### The correction on tool results

Text that rode a tool result cannot be a landing point, so it is never rewound. There the press interrupts the agent at once. A card answer re-opens as a fresh card, and the operator answers again. The fresh answer follows first-valid-wins, as any re-asked question does. A read note takes a fresh correction, written with the old text in hand. Both enter the pane behind a correction prefix, words like "correction to the above". Curia writes the prefix, because the framing is mechanics. No work drops on this path.

An unread queued note is the trivial case. The take back pulls it from the queue, the receipt edits to say taken back, and nothing ever reaches the agent.

### The world keeps what ran

A rollback restores the conversation, never the world. Verbs that ran, bash side effects, subagent edits, and commits stand. The receipt names what stands, so nothing is silently forgotten.

### The text is never lost

The receipt quotes the taken-back message. The dashboard composer prefills it for editing. The exact method rides the prototype.

### The surfaces

The button sits in Discord and on the dashboard chat. In Discord it rides the status line, which gains buttons on the messaging mockups. Agent chats ship first. Overseer chats follow on their own ticket, although their session id chain would make a rollback cheap there. That ticket also asks whether the vastly different chat handling between the two must stay.

## Considered options

Transcript surgery was the one path to an exact landing on a card answer: cut the session file at the answer and resume the cut copy. The operator rejected it. It is unproven on every harness, and files would not follow the cut.

## Consequences

- A prototype must prove the pane-driven rewind on claude, codex, opencode, and pi. The button shows only where a lane passes. Codex 0.147.0 shipped a backtrack regression, so the pin matters.
- The take back needs no new delivery machinery for corrections. The interrupt is the Ask now mechanic, and the fresh card is a re-ask under supersede.
- The receipt becomes a first-class message: it keeps the text, names the landing point, and names what stands.
- The chat screen and the messaging mockups shape the button and the receipt.
