# The living-organism experiment

Prototype for [Try the living-organism prompt as a landing-page experiment](https://github.com/alp82/curia/issues/363),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).

This directory is throwaway code. It answers one question. It is not the live page.

## What it is

One self-contained HTML file, `index.html`. It holds four variants of the page on one route.
Switch them with the bar at the bottom, with the left and right arrow keys, or with `?variant=`.

| Key | Name | What it tries |
|---|---|---|
| `live` | The live page | The current https://curia.sh page, as the baseline to beat. |
| `bloodstream` | Bloodstream | A WebGL field behind the whole page. Scroll drives one phase value that morphs the field between scenes. The pointer is a pressure source. |
| `queue` | The queue, alive | A different page structure. A live pipeline runs down the left, and the content hangs off it as stations. Tickets travel the spine and stop at the station you read. |
| `vitals` | Vital signs | The calm page, alive in one place. A hairline trace breathes in the left margin and reacts to scroll speed. The headline letters carry a small spring. |

Run it:

```
python3 -m http.server 9006 --bind 0.0.0.0 --directory prototypes/living-organism
```

## The rule the variants share

Every variant renders the same words from one `CONTENT` object at the top of the script.
The prompt changes the presentation. It does not change the claims.
A variant may re-order or re-weight the approved copy. It may not rewrite it.

Two additions are the only new words on the page, and the operator decides both:

1. The large-type section reads `An agent cannot finish by talking. Nothing lands without you.`
   Both halves come from claim 3 on the live page. This joins them into one sentence.
2. The `queue` variant labels its stations `the queue`, `the seat`, `the gate`, `the run`,
   `the cost` and `your turn`. These are signposts, not claims.

## Findings

### The prompt did not force a build step

This is the answer to the constraint from [#111](https://github.com/alp82/curia/issues/111).
The whole experiment is one file of 88 KB with no build, no package and no CDN.
The WebGL runs from GLSL source in the file. The sound is synthesized, so no audio file exists.
The three links in the page go to GitHub, and the page loads no remote resource.
A build step buys nothing here, so `docs/` can keep the no-build-step decision if a part carries over.

### The design skill fits Part A better than Part B

The pinned `landing-page-design` skill is a design input, per
[Evaluate the ai-design-skills repo for landing-page work](https://github.com/alp82/curia/issues/364).

Applied: B7 motion, with `IntersectionObserver` and one cubic-bezier curve everywhere.
B9 focus and active states. B10 semantic HTML, a skip link, page metadata and alt text.
B11, as the large-type section with word-by-word reveal.
A4 for proof next to the claim it supports.

Rejected, with the reason:

- **B1 fonts.** Geist, Manrope and Poppins need a webfont request. That breaks the one-file rule and
  adds a network dependency. The page uses the system stack.
- **B4, no gradients in backgrounds.** The prompt asks for a WebGL field. The rule forbids it.
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
All four variants show the live wording, because a fair comparison needs identical copy.
The fix belongs to the live page, not to this experiment.

### Sound stays off, and a browser agrees

The ticket requires sound off until the user turns it on. A browser requires a gesture before it
starts audio, so the two rules agree. The bar carries the switch. Nothing sounds before a tap.

### An agent cannot check this page by looking

Two nets protect the reader, because nobody working this ticket has eyes on a phone.
An uncaught error reveals the whole page at once. Anything still hidden two seconds after mount,
while it sits on screen, gives up and shows itself.
Motion follows `prefers-reduced-motion`, and the bar can force it off.
A device with no WebGL gets a flat background instead of a blank one.

## How this was checked without a browser

`docs/agents` has no harness for a page, so this run built a throwaway one.
It stubs the DOM with Node builtins alone, and it installs nothing.
It proves the code runs. It cannot judge how the page looks, and the operator makes that call.

The harness mounts each variant, runs the animation loops, fires every reveal, turns sound on and
off, walks the switcher through all four variants, toggles motion and opens the lightbox.
It then reads the rendered text back and checks it.

Checks that pass for all four variants:

- No banned word from `positioning.md` reaches the page.
- Twenty-two required sentences appear word for word.
- The guide contains no `just` and no `simply`.
- Reduced motion and missing WebGL both mount and render the same copy.

One real defect came out of this. The `vitals` headline splits into one span per letter, so the
letters can move on their own. A screen reader can spell such a heading out instead of reading it.
The heading now carries the plain sentence as its label, and the pieces leave the accessibility tree.

The harness lives in the session scratchpad, not in this repo. It is scaffolding, not a test suite.
