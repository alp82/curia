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

**Round 2, the answer (2026-08-23).** O2, P2 with lists allowed, B3 with an info glyph. Two
recommendations were overruled, and each pick opened something.

- **O2.** The prose cap rises from 1200 to 2000. Two consequences went to round 3. `CHUNK_LIMIT`
  in `daemon/src/messaging.mjs` is 1600, so a prose entry above it becomes two Discord messages and
  the rail count stops being true. And 2000 is Discord's own ceiling, so past it there is no bigger
  single message.
- **P2, with P4's list allowed inside it.** The conclusion always leads in bold. Under it the agent
  writes paragraphs or a list, chosen by what the content is. The blend is on the page as P2+.
- **B3 with an info glyph.** The background is small print. Two consequences went to round 3. The
  signal set of ADR-0013 has no info glyph, so this adds a ninth. And the never-stacked rule turns
  out to be about authored newlines, so a background written as one line breaks nothing.

**Round 3 — the consequences and the two remaining bullets.** Five questions, five variations each.

- **q1, the prose message at 2000.** X1 one entry is always one Discord message, X2 leave the
  chunker at 1600 and let it split, X3 curia splits at a paragraph edge past 2000, X4 the refusal
  stands with the timeline flag, X5 cap the field at 1900 and reserve 100 for the rail.
  Recommended X1.
- **q2, the background layout.** I1 one wrapped line with the glyph in front, I2 a glyph line then
  a stack, I3 the glyph on every line, I4 the load-bearing sentence at full weight, I5 a one-line
  summary with the measurements behind a spoiler. Recommended I1.
- **q3, the glyph.** ℹ️, 💡, 📌, 📖 or 🔍. Recommended ℹ️.
- **q4, when the agent composes.** K1 only when a message would break a rule, K2 a named shape per
  call, K3 free composition under the structural rules, K4 a message per thing a reader would skip,
  K5 one message per intent. Recommended K4.
- **q5, the image and the visual.** G1 the image rides the deciding message, G2 one image message
  then the decision, G3 one image per option, G4 an ASCII diagram instead, G5 the image leads with
  prose reading it. Recommended G2, and the per-message `visual` field survives beside the
  `visual` message format.

**Round 3, the answer (2026-08-23).** Two recommendations taken, two overruled, one question
unanswered.

- **q1: neither X1 nor any other cut. The prose cap becomes 1600**, the number the chunker already
  uses, so the lint and the splitter agree and no shipped constant moves. It is on the page as X6.
  The cap still rose from 1200, which is what round 2 asked for.
- **q2: I1 and I2 both, and the agent decides per question.** A background that argues one point is
  one wrapped line. A background that lists separable facts is a stack. The question background
  becomes the named exception to the never-stacked rule of ADR-0019.
- **q3: b, 💡.** I had recommended ℹ️ because 💡 conventionally means an idea rather than a measured
  fact. Overruled, and it is a taste call on a surface the operator reads daily. 💡 joins the eight
  signals of ADR-0013 as the ninth.
- **q4: K4.** A message exists when a reader would want to skip it on its own. One sentence for the
  standing orders, no catalog.
- **q5: G1, G2, G4 and G5 all stand, and the agent picks per question. G3 is cut**, because a
  comparison is the one case that needs both images on one screen and G3 puts them on two.
- **Unanswered:** whether the per-message `visual` field survives beside the `visual` message
  format. It goes to round 4.

**Round 4 — three loose ends.** Fewer than five variations per question, on purpose. Each is a
closing question on a shape already picked, so a fifth cut would be invented to reach a number.

- **q1, the tape measure.** The rail line shares the Discord message with the prose it labels, so a
  1600-character field arrives as 1620 and the chunker splits it. A1 measure the composed message,
  A2 cap the field at 1500 and hold 100 back, A3 keep the field at 1600 and raise `CHUNK_LIMIT` to
  1700. Recommended A3.
- **q2, past 1600.** W1 the agent composes a second prose message and the refusal names that path,
  W2 the refusal stands and the agent cuts. Recommended W1.
- **q3, the two visuals.** U1 both stand and differ by what a reader does with them, U2 the field
  retires, U3 the format retires. Recommended U1.

Awaiting the operator.
