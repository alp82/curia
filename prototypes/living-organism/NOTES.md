# The living-organism experiment

Prototype for [Try the living-organism prompt as a landing-page experiment](https://github.com/alp82/curia/issues/363),
continued by [Take the living-organism run further, on a second model](https://github.com/alp82/curia/issues/508),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).

This directory is throwaway code. It answers one question. It is not the live page.

## The verdict

**#508: the story in acts (`saga`) is the picked baseline for the final page.**
The operator picked it at #508 round 10, and it is the default the link opens on.
Two follow-up tickets carry it on: a grilling on how the final landing page should look
(the copy questions from round 7 belong there), and a prototype that builds the final
result from `saga` plus that grilling's outcome.

**#363: the vertical run won the direction, and `descent` was the locked-in variant.**
The operator locked it in at #363 round 4. #508 evolved it over ten more rounds into `saga`.

The living-organism prompt does not beat the live page as written. What survives it is one idea:
a vertical line down the left that carries the story while the reader scrolls, with the reader's
own ticket riding it and changing state as the stages pass. The spectacle the prompt asks for did
not survive contact with the brief. The WebGL page, the rail across the top and the restrained
page were all cut by the operator across rounds 1 and 2.

Nothing here goes to the live page yet. A follow-up prototype carries the direction on, and the
operator runs that one with a different model.

## What it is

One self-contained HTML file, `index.html`. It holds the locked baseline and the candidates of the
open round. Switch with the bar at the bottom, the arrow keys, or `?variant=`.

| Key | Name | State |
|---|---|---|
| `base` | You move the ticket | **The locked baseline.** The `descent` mechanic plus the bigger left-aligned reader's card that names its stage (#508 round 1). |
| `lens` | One ticket, then all of it | **The round 9 winner, unchanged.** A camera story: one huge ticket, its siblings, the map frame closing around them, then the ride. |
| `saga` | The story in acts | #508 candidate. The lens evolution: the mess, the camera pull-back, the horizontal run mid page, the gate, the merged stack. Every act carries one bold message from the approved copy. |

Every candidate carries the locked learnings: GitHub-row tickets with number, type and speaking
name, badged map cards with real names, no overlay of content and ride, natural scroll, random
types out of every map, and the skills line in the hero.

The variants of #363 (`live`, `grow`, `lanes`, `descent`), of #508 round 1 (`story`, `cards`),
of round 2 (`braid`, `tree`, `acts`, `stack`, `trail`), of round 3 (`flood`, `metro`, `dock`,
`palm`, `swell`), of round 4 (`voyage`, `relay`, `kinds`, `poster`, `grove`), of round 5
(`epic`, `chapters`, `hud`, `harvest`, `flags`) and of round 6 (`atlas`, `chart`, `wide`,
`weave`, `grand`) were removed on the operator's orders. Git history keeps them. The round 7
keys `story` and `stacks` reuse round 1 and round 2 names for different things, and this table
is the current meaning.

All variations share one page, four stages and the same real ticket numbers.
The stages are `takeable`, `agent`, `gate` and `merged`, and each one has its own color.
A stage name sits on the same line as its node, so a card parked on the node reads its state
straight off the label beside it. A key above the claims spells the four colors out once.

Run it:

```
python3 -m http.server 9006 --bind 0.0.0.0 --directory prototypes/living-organism
```

## The rounds

**Round 1.** The operator picked the vertical spine over the WebGL page and the restrained page.
The dots needed meaning, so each took a real ticket number and each station a real stage name.
The green flashed, because a station switched color in one step and an arrival set the glow to full
in one frame. Both ease now, and the spring is clamped.

**Round 2.** The green went missing: the round 1 fix took the steady green down with the flash,
because one value was doing two jobs. They are separate now. The spine and every node keep a
constant green, and only the arrival pulse scales down with depth. Tickets became cards. The
vertical line won, because it carries the story while scrolling.

**Round 3.** The operator asked to iterate from `descent`, fold in multiple repos, grow the story
from one repo and one ticket, enlarge the cards and color the states. That produced `grow`.

**Round 4.** The operator rejected the round 3 result and locked in `descent`.
The lesson is recorded here because it cost four rounds: each round rebuilt the variant set instead
of making one small change to the thing already approved. An iteration the operator cannot compare
against the last one is not an iteration. A follow-up prototype takes the direction on, run by a
different model.

## The #508 rounds

**Round 1.** Two candidates stood beside `descent`, one change each: `story` retold the growth
with a silent start, and `cards` enlarged the reader's card and named its stage on it. The operator
took the bigger card as the new baseline with one fix: left-aligned instead of cut off at the left
edge. The growth story was too weak, multiple repos had no visible evidence, and the map to ticket
hierarchy was missing. The order: use the bigger card as the baseline, remove the rest, and build
five variations that explore different storytelling techniques. That order supersedes the round 4
rule against rebuilding the set, for this round only.

**Round 2.** The set was the locked `base` plus five one-layer techniques: `braid`, `tree`,
`acts`, `stack` and `trail`. The reader's card became this ticket, #508. The operator found
interesting elements in `braid`, `tree` and `acts`, and called the round too cowardly. The order:
go bold, go wild, make the variations really distinct, and aim at storytelling, multi-branches,
the scroll experience, and instant intuitive understanding of what curia does and why it matters.

**Round 3.** Five distinct scroll experiences beside `base`: `flood`, `metro`, `dock`, `palm` and
`swell`. Each absorbs a surviving element: `metro` carries the branches of `braid` and the
hierarchy of `tree`, and `swell` retells `acts` with drama. `flood` and `dock` are new bets on
the opening screen, and `palm` bets on the phone as the story. The verdict: the dock and metro
combination is the direction. The line connections were a bit off, and the arcs stay. Wanted
next: the maps-finish-and-a-new-one-opens story, bigger ticket cards, and an experiment with the
wayfinder words research, prototype and grilling. That last order is an operator exception to
the fixed-copy rule, for canvas labels only.

**Round 4.** Five directions of the combined experience beside `base`: `voyage`, `relay`,
`kinds`, `poster` and `grove`. All open full screen and dock into the gutter, and every join
eases in and out, which answers the connection note. In `kinds` the companions carry a type word
instead of a number, because the page cannot verify a type for every real ticket number. The
reader's card says prototype, which #508 really is. The verdict: `kinds` is awesome, `poster`
folds in, `relay` makes sense but the parallel repos were almost invisible. Wanted next: clearer
maps with several visible at once as the story moves, a hero that shows more, and the title
fully readable at the bottom of the first screen.

**Round 5.** The kept mix became the shared frame: typed two-row companions, the three-row
reader's card, wider and brighter lines, dashed map cards that never read as tickets, and a
compressed opening stage above the title. Five identities beside `base`: `epic`, `chapters`,
`hud`, `harvest` and `flags`. The verdict: the map visualization did not make sense, and the
maps must be more central.

**Round 6.** The maps hold the center, five ways: `atlas` hangs them as hubs with their tickets
on spokes, `chart` draws map 109 as a real indented tree that drains into the queue, `wide` lays
the overview sideways before the ride turns vertical, `weave` runs the line side to side with a
map card centered at every turn, and `grand` detours the line into a full-width map band at
every stage. The line, the stations, the companions and the reader's card all ride one shared
path function now, so a candidate can put the line anywhere on the screen. The verdict: `weave`
has the potential and the parallel lanes are nice, `atlas` is too jumbled, `chart` is not
understandable, `wide` confuses with its flip, and the pinned reader's card breaks the story by
looking different from every other ticket. The order: tailor the whole page around the journey,
with mini GitHub tickets, larger session-holding map cards, queues and stacks, one lane per map,
scroll-revealed features, and a prominent line that curia is a wrapper for Matt Pocock's skills.

**Round 7.** The page is the journey: the copy narrows and spreads out, every stage gets a
screen of scene space, and the scroll reveals the story beat by beat. The protagonist is a mini
ticket like every other, marked only by a lit border and the stage word beside it. Wireframe
panels use only the page's own words: the Discord thread and its buttons, the preview line, the
gate with its approve button, and the harness names Claude Code and Codex CLI from the guide.
Three candidates beside `base`: `story`, `stacks` and `drift`. The verdict: directionally
correct, but content and lanes must sit next to each other and never overlay, tickets must look
more like tickets, maps and tickets get speaking names and badges, the types come out of every
map at random, the dashboard from the UX map joins the journey, most of the prose can go, and
the copy iteration becomes a follow-up prototype ticket that asks its questions first.

**Round 8.** Copy blocks alternate with full-width story rooms joined by an edge line. Tickets
carry number, type and name. Maps carry a map badge and their name. The dashboard room shows
every map's progress and a needs-you row, after the UX map's atlas decision (curia#511 and its
child curia#512). Three candidates differ only in the entry and exit of the rooms: `flow`,
`doors` and `zoom`. The verdict: a method correction. Variations must explore completely fresh
ideas, and three entry styles on one concept are the same idea three times. The page also felt
repetitive and hard to follow.

**Round 9.** Four completely different concepts, each one clear storytelling device: `thread`
tells the ticket as a Discord chat, `board` pins a control-room atlas over the top of the
screen, `lens` pulls the camera back from one huge ticket to all of it, and `dawn` shows the
scattered mess before the line arrives and snaps it into queues. All four carry the locked
learnings from rounds 1 to 8. The verdict: `lens` wins with huge potential in the camera
storytelling. `thread` is out, because Discord is one aspect of curia, not the whole. The
board's horizontal line belongs in the middle of the story, not in a fixed header. `dawn` folds
in as an ingredient. Every step of the story gets one clear bold message, so the animations and
the content blend into one scroll that explains all of working with curia.

**Round 10.** `saga` evolves the winner into five acts, each with a bold message from the
approved copy: the mess (the lede's first sentence), the camera pull-back (claim 1), the
horizontal run mid page (claim 2), the gate (claim 3), and merged (the proof heading). The
stage sounds fire at act milestones, and `lens` stays in the bar unchanged for comparison.
The verdict: **the story in acts is the picked baseline.** Two follow-up tickets carry it on:
a grilling on how the final landing page should look, and a prototype that builds the final
result from `saga` plus that grilling's outcome.

## The rule the variations share

Every variation renders the same words from one `CONTENT` object at the top of the script.
The prompt changes the presentation. It does not change the claims.
A variation may re-order or re-weight the approved copy. It may not rewrite it.

One addition is the only new sentence on the page, and the operator decides it:

- One line above the stats names what the moving numbers are.
  The words are `The numbers moving down the left are this page's own tickets.`

The stage labels `takeable`, `agent`, `gate` and `merged` are not new vocabulary.
Each one already appears in the page copy, so the labels reuse the page's own words.

The large-type line that joined claim 3 to its own under-line went out with the two variants that
carried it. Say the word and it comes back.

## Findings

### The prompt did not force a build step

This is the answer to the constraint from [#111](https://github.com/alp82/curia/issues/111).
The whole experiment is one file with no build, no package and no CDN.
The run is drawn on a canvas from code in the file. The sound is synthesized, so no audio file exists.
The three links in the page go to GitHub, and the page loads no remote resource.
A build step buys nothing here, so `docs/` can keep the no-build-step decision if a part carries over.

### The design skill fits Part A better than Part B

The pinned `landing-page-design` skill is a design input, per
[Evaluate the ai-design-skills repo for landing-page work](https://github.com/alp82/curia/issues/364).

Applied: B7 motion, with `IntersectionObserver` and one cubic-bezier curve everywhere.
B9 focus and active states. B10 semantic HTML, a skip link, page metadata and alt text.
A4 for proof next to the claim it supports.

Rejected, with the reason:

- **B1 fonts.** Geist, Manrope and Poppins need a webfont request. That breaks the one-file rule and
  adds a network dependency. The page uses the system stack.
- **B1 and B2 fixed scales.** The live page uses `clamp()` so the headline fits a 320px screen.
  [Polish the live page](https://github.com/alp82/curia/issues/137) fixed that overflow. Fixed
  Tailwind steps would break it again.
- **A2 required structure.** The skill demands testimonials, six to twelve FAQ entries and a risk
  reversal. `positioning.md` bans fake proof, and curia sells no trial, plan or refund.
- **B8 invented content.** The skill tells a worker to invent names and nonround numbers.
  Every number on this page comes from the live page and stays there.

### The live page carries a stale number

The honesty block says `Curia is fifteen days old.` A worker counted that on 5 August 2026.
The first commit is 2026-07-21, so the age is 27 days today, 17 August 2026.
Every variation shows the live wording, because a fair comparison needs identical copy.
The fix belongs to the live page, not to this experiment.

### Sound stays off, and a browser agrees

The ticket requires sound off until the user turns it on. A browser requires a gesture before it
starts audio, so the two rules agree. The bar carries the switch. Nothing sounds before a tap.

### An agent cannot check this page by looking

Two nets protect the reader, because nobody working this ticket has eyes on a phone.
An uncaught error reveals the whole page at once. Anything still hidden two seconds after mount,
while it sits on screen, gives up and shows itself.
Motion follows `prefers-reduced-motion`, and the bar can force it off.
The run falls back to a plain line if a canvas cannot be had.

## How this was checked without a browser

`docs/agents` has no harness for a page, so this run built a throwaway one.
It stubs the DOM with Node builtins alone, and it installs nothing.
It proves the code runs. It cannot judge how the page looks, and the operator makes that call.

The harness mounts each variant, runs the animation loops, fires every reveal, turns sound on and
off, walks the switcher through every variation, toggles motion and opens the lightbox.
It then reads the rendered text back and checks it.

Checks that pass for every variation:

- No banned word from `positioning.md` reaches the page.
- Twenty-two required sentences appear word for word.
- The guide contains no `just` and no `simply`.
- Reduced motion and four screen widths all mount and render the same copy.

Two real defects came out of this, both on variants that no longer ship.
A headline split into one span per letter can be spelled out by a screen reader instead of read.
The same split also lets a 320px screen break a word in half, because every letter becomes a break
opportunity. The fixes were a label on the heading and a nowrap box per word.
Neither trap applies to the run, which splits no text.

The harness lives in the session scratchpad, not in this repo. It is scaffolding, not a test suite.
