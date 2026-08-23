# The composite send, mocked

Prototype for [The composite send, mocked](https://github.com/alp82/curia/issues/640), on the map
[The UX map: the dashboard, Discord, and the way between them](https://github.com/alp82/curia/issues/511).
It stands after [ADR-0026](../../docs/adr/0026-the-composite-send.md), which fixed the structure and
sent the dressing here.

This directory is throwaway code. It decides taste questions on rendered mock transcripts, and it is
not the render path. The render path is `daemon/src/card.mjs` and `daemon/src/bridge.mjs`, and the
build lands with the handoff ([#533](https://github.com/alp82/curia/issues/533)).

## What it is

One self-contained HTML file, `index.html`. Each section is one round. A round offers five
variations of the same content, so only the taste under judgment differs. Every transcript is a real
past exchange, retold.

A switch at the top of the page draws the message boundaries. Discord groups consecutive messages
from one sender, so a send of three renders as one avatar, one timestamp and one block. That
grouping is the fact the dressing has to answer, and the switch makes it visible.

Run it:

```
python3 -m http.server 9012 --bind 0.0.0.0 --directory prototypes/composite-send
```

## What already binds every variation

- The deciding message posts last, and a send carries at most four messages (ADR-0026).
- Small print is one line, never stacked (ADR-0019).
- Grade B prose refuses any emoji outside the signal set: ⚙️ ✅ ❌ ⚠️ 🎫 ⚰️ 🔗 ❓, plus 🔎 for the
  cross-check and the six phase icons of ADR-0021.
- A code-block table or an ASCII diagram runs to 42 columns and under 1000 characters.
- The prose message caps at 1200 characters, and a question background at 600.
- Dressing curia writes takes no lint attempt. Dressing the agent writes does.

## The rounds

<!-- One entry per operator round: what was offered, what came back. -->

**Round 1 — the dressing and the order.** Five whole-send variations of one exchange: an operator
note on [#554](https://github.com/alp82/curia/issues/554) answered by prose, a visual and a choice.
V1 the bare run, V2 a Discord H3 title on every message, V3 a small-print rail that numbers each
message in the send, V4 one agent-written intent line and no other dressing, V5 the visual first
with a single H2 on the decision. Recommended V3.

**Round 1, the answer (2026-08-23).** V3 wins, with two amendments and one new question.

- The rail label loses its article and its flourish. Plain, simple, descriptive: "answer", not
  "the answer". "cost per stack", not "what each stack costs".
- A send of one message carries no rail. There is nothing to count.
- The implied rule: curia writes the count, the agent writes the label at 20 characters, linted as
  inline text. That is the status-line label rule of ADR-0021 on a second surface.
- New question, raised by the operator: what happens to text that will not fit one message. It
  became question 1 of round 2.

**Round 2 — the overflow and the two render forms.** Three questions, each with five variations,
all rendered under the picked rail.

- **q1, text that will not fit.** The prose cap is 1200 and the subject answer runs to about 1430.
  O1 two prose messages with the agent picking the break, O2 raise the cap to Discord's own 2000,
  O3 keep 1200 and point at the timeline, O4 the tail rides as a markdown file, O5 curia splits it
  at a paragraph edge. Recommended O1, plus the rule that the refusal at 1200 must name the
  second-message path.
- **q2, the prose message body.** P1 plain paragraphs, P2 the conclusion first in bold, P3 the
  operator's note quoted, P4 a lead sentence then a list, P5 the load-bearing terms in bold.
  Recommended P2.
- **q3, the question background.** B1 a plain paragraph, B2 a blockquote, B3 small print, B4 a
  spoiler, B5 the ↳ arrow of the choice card. Recommended B2.

Awaiting the operator.
