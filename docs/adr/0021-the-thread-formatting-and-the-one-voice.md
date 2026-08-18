# ADR-0021: The thread formatting and the one voice

**Status**: accepted (2026-08)
**Provenance**: [Discord messaging and formatting mockups (#520)](https://github.com/alp82/curia/issues/520), on [map #511](https://github.com/alp82/curia/issues/511). The operator picked on rendered mock transcripts. Details [ADR-0020](0020-the-thread-story.md), and amends the surface of [ADR-0013](0013-one-voice-per-fact.md).

## Context

ADR-0020 fixed the story a thread tells and left two things to a prototype: the exact live-status shape and the icon set. The mockups put today's flow beside three renderings of that story, plus the status-line candidates. The operator picked a blend, and then went further: two bot names in one thread read as two actors, and the operator ruled that the surface must read as one.

## Decision

### The rendering

The base is the Signal rendering: bold ids and the signal emoji, in today's markdown dressing. Two parts come from the Quiet rendering. The status line is small print, and the settled receipt is small print.

The status line carries the link buttons: preview, chat, ticket. Cards carry only their decision buttons. The gate keeps approve, reject and cross-check. The status line still moves to the thread bottom on a state change, so its buttons stay in reach.

The receipt is the status line's last edit. It keeps the final meter readings on a second small-print line, so the cost of the ticket is never lost. It drops the preview button, because the preview dies with the ticket. A dead button is a trap. Chat and ticket stay.

### Live status

The shape is the S3 candidate. The phase icon replaces the working glyph, and the label sits in code marks, then the meters:

```
🧭 `reads the call sites` · claude-opus-5 · ctx 47% · 5h 🟩 ▓▓▓▓░┃░░░░ 38%
```

The label is at most 20 characters, set by the agent, linted as inline text. The icon set is Field:

| Icon | Phase |
|---|---|
| 🧭 | explore |
| 💭 | think |
| 🔨 | build |
| 🚦 | test |
| 🩹 | fix |
| 🚢 | ship |

The other states keep their base lines. This set covers the working state only.

### One surface identity

Every message in a ticket thread posts under one name, curia, with one avatar. The split under the hood stays, because buttons need app messages and agent prose rides a webhook, but the reader never sees it. The session name, for example `curia-612`, survives only as an identifier: in the receipt, and in commands like `resume 612`.

### The voice of the one bot

Work prose speaks in first person. Mechanics stay impersonal, in small print. Third-person self-reference is banned: no "the agent", no "What the agent did", no "reports".

- The card head dies. The message is curia asking, so ❓ carries the signal and the esc id drops to the subtext.
- The gate heads become "What changed" and "Charting".
- The ending report opens `✅ **resolved** — ` followed by the typed headline.
- A real second actor is named by its role. A cross-check verdict still says the cross-check found, because that is another reader, not curia in third person.

## Consequences

- The webhook username changes from the session name to curia, and the avatars unify.
- ADR-0013 keeps its rule, one voice per fact, and loses its speaker attribution by name. Attribution moves to typography: normal weight for meaning, small print for mechanics.
- `voice.md` gains the first-person rule and the third-person ban.
- The esc id moves from the card head to the subtext. Replies that name an id keep working.
- The status line grows the link-button row, and the composer receipt's buttons die with it (ADR-0020 already kills that receipt).
- The mockups live under `prototypes/thread-mockups/`, one self-contained page, as the primary source of these picks.
