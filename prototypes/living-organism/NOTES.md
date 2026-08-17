# The living-organism experiment

Prototype for [Try the living-organism prompt as a landing-page experiment](https://github.com/alp82/curia/issues/363),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).

This directory is throwaway code. It answers one question. It is not the live page.

## What it is

One self-contained HTML file, `index.html`. It holds the vertical run and three variations of it.
Switch them with the bar at the bottom, with the left and right arrow keys, or with `?variant=`.

| Key | Name | How the story moves |
|---|---|---|
| `grow` | The run grows | Your ticket holds still and the page runs under it. The run grows as you descend: one repo and one ticket, then more tickets, then a second repo, then a third. |
| `descent` | You move the ticket | The same pinned ticket, without the growth. Round 2, kept for comparison. |
| `lanes` | Many repos, one queue | Three repos converging, without a pinned ticket. |
| `live` | The live page | The current https://curia.sh page. Kept as the reference the verdict is measured against. |

All three variations share one page, four stages and the same real ticket numbers.
The stages are `takeable`, `agent`, `gate` and `merged`, and each one has its own color.
A stage name sits on the same line as its node, so a card parked on the node reads its state
straight off the label beside it. A key above the claims spells the four colors out once.

Run it:

```
python3 -m http.server 9006 --bind 0.0.0.0 --directory prototypes/living-organism
```

## The rounds

### Round 1

The operator picked the vertical spine over the WebGL page and the restrained page.
The dots needed meaning, so each one took a real ticket number and each station took a real stage
name. The green flashed, because a station switched color in one step and an arrival set the glow
to full in one frame. Both ease now, and the spring is clamped.

### Round 2

**The green went missing.** The round 1 fix took the steady green down with the flash, because one
value was doing two jobs. The two are separate now. The spine, its column of light and every node
keep a constant green that does not answer to scroll depth. Only the arrival pulse scales down as
the reader descends. So the ambience stays and the flash stays tame.

**Tickets needed state transitions.** A ticket is drawn as a ticket, a card carrying its number.

**The vertical line won**, because it carries the story while scrolling. The rail across the top,
the WebGL page and the restrained page are all removed.

### Round 3

**The run grows as you descend.** The operator asked the story to start with one repo and one
ticket, then more tickets, then a second repo. The reader's depth drives it. Past the first stage
the traffic thickens, past the second a second repo lane opens, past the third a third opens.
The lanes fold into the one queue at `takeable`, which is what the headline claims.

**The cards got bigger, and the state got a color.** Each card carries a colored dot and its
number. Each stage carries the same color on its own dot. A key above the claims names all four,
so no dot needs guessing. The color never carries the state alone: the stage word sits beside every
dot as DOM text, so a reader who cannot separate the hues still gets the state.

**Your ticket rides along.** The pinned card from round 2 stays, drawn larger than the traffic
around it, and its state changes as the stages pass it.

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
