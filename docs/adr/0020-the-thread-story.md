# ADR-0020: The thread story

**Status**: accepted (2026-08)
**Provenance**: [What the thread must say (#514)](https://github.com/alp82/curia/issues/514), on [map #511](https://github.com/alp82/curia/issues/511), grounded in a code read of the bridge, the status line and the dispatch messages. Amends the ending clause of [ADR-0013](0013-one-voice-per-fact.md).

## Context

A fresh ticket thread carries six to nine entries before work begins. Three of them state the same fact: an agent is starting. The thread never states what the ticket is about until the review gate asks whether the work is done. During work, `notify` is unrationed, so a long thread buries its own story. The ending spends four entries: the agent report, a small-print receipt, the deletion of the status line, and a rename system line. Prototyping agents explain their work badly. The operator decided the shape below on #514.

## Decision

### The thread is the alert surface

The thread carries decisions and outcomes. The reasoning lives in Chat, behind the link on every card. A thread message that explains process points at Chat instead.

The operator renamed the timeline surface to Chat on #514. One name serves agent sessions and overseer conversations alike, because both read the same way, from the transcript. Only the drive path differs under the hood.

### The story floor

Every thread tells this story, in this order. The floor is mandatory. The middle is unbounded: a grilling or a prototyping ticket spends as many rounds as the work needs, and no cap holds it down.

1. CuriaBot posts one title line: the ticket number and the ticket title. The title is a tracker fact, so it is mechanics.
2. The status line carries every dispatch mechanic: dispatched, image build, at the composer, working. The composer receipt and its attach buttons fold into it. No other start message posts.
3. The agent opens with one short typed message: the goal as the agent reads it, then its first step. Two lines at most. A reading of the ticket is meaning, so the agent voice says it.
4. The middle: question cards and milestone messages, as many as the work needs.
5. The gate, then the agent's ending report, led by the typed headline.
6. The status line settles into the receipt. Its last edit says resolved and what curia did. It is never deleted, and no separate receipt message posts.

### Live status on the status line

The status line replaces the working icon with a phase: one icon from a curated set, plus a freeform label of at most 20 characters, linted as inline text. The agent sets it. Routine progress lives there, because the line edits in place and costs no message. A thread message carries a milestone: a fact the operator acts on, or news that spares them worry.

A prototype finds the exact phase shape and the curated icon set. It rides the messaging mockups of [#520](https://github.com/alp82/curia/issues/520).

### The prototype agent's duty

A prototyping agent's opening names the question the prototype answers. Its gate summary lists what to look at on the preview, in viewing order, one line per stop.

### The closing line

The typed headline of the ending report is the one closing line. The same line leads the thread report, the resolution comment, and the map pointer.

### The voice rules bind daemon prose

`voice.md` binds daemon lines too: the same word rules and the eight-signal emoji set. Enforcement is at authoring time, in code review. The lint gate stays on agent prose only.

## Consequences

- A fresh thread reads in three entries before work: the rename system line, the title line, and the status line. The agent's opening is the fourth.
- The ending clause of ADR-0013 changes. The report stays the first message, and the receipt becomes the status line's last edit. The retire path, which deleted the line, dies.
- The status line becomes the one mechanics carrier from dispatch to resolution. The composer receipt, the image-build line and the ending receipt die as separate messages.
- Typed payloads grow: an opening-statement surface, and a phase field for the status-line label.
- The messaging mockups (#520) show this story beside today's flow, and carry the status-line prototype.
- Several daemon lines use emoji outside the signal set today. Each changes when its line is next touched.
