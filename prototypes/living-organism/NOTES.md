# The living-organism experiment

Prototype for [Try the living-organism prompt as a landing-page experiment](https://github.com/alp82/curia/issues/363),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).

This directory is throwaway code. It answers one question. It is not the live page.

## The verdict

**The vertical run wins the direction, and `descent` is the locked-in variant.**
The operator locked it in at round 4, and it is the default the link opens on.

The living-organism prompt does not beat the live page as written. What survives it is one idea:
a vertical line down the left that carries the story while the reader scrolls, with the reader's
own ticket riding it and changing state as the stages pass. The spectacle the prompt asks for did
not survive contact with the brief. The WebGL page, the rail across the top and the restrained
page were all cut by the operator across rounds 1 and 2.

Nothing here goes to the live page yet. A follow-up prototype carries the direction on, and the
operator runs that one with a different model.

## What it is

One self-contained HTML file, `index.html`. It holds the locked-in variant and the record of what
was tried. Switch with the bar at the bottom, the arrow keys, or `?variant=`.

| Key | Name | State |
|---|---|---|
| `descent` | You move the ticket | **Locked in.** Your ticket holds still, the page runs under it, and its state changes as each stage passes. |
| `live` | The live page | The current https://curia.sh page, the reference the verdict is measured against. |
| `grow` | The run grows | Not chosen. Adds growing traffic and repo lanes as the reader descends. |
| `lanes` | Many repos, one queue | Not chosen. Three repos converging, with no pinned ticket. |

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
