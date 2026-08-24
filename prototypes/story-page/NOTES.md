# The story page

Prototype for [Prototype the final landing page from the saga baseline](https://github.com/alp82/curia/issues/551),
on the map [Ship the story landing page](https://github.com/alp82/curia/issues/600).

This directory holds the candidate for https://curia.sh. It is the final build of the story
page, beside the live page. [Cut over to the story page](https://github.com/alp82/curia/issues/604)
copies `index.html` to `docs/index.html` after the operator approves the cutover. Until then, the
live page stands.

## What it is

One self-contained HTML file, `index.html`. No build step, no CDN, no package, no webfont
([build.md](../../docs/landing-page/build.md)). The twelve scenes follow the locked storyboard
([prototypes/landing-storyboard/NOTES.md](../landing-storyboard/NOTES.md)). The words are the
locked copy of [#587](https://github.com/alp82/curia/issues/587), recorded in
[prototypes/landing-copy/NOTES.md](../landing-copy/NOTES.md). The visual baseline is the `saga`
variant of [prototypes/living-organism/](../living-organism/) (#508). Every proof scene is built
HTML, ruled at [#601](https://github.com/alp82/curia/issues/601) — no screenshots.

No sound and no bottom bar ([positioning.md](../../docs/landing-page/positioning.md)). The system
reduced-motion setting decides motion. The page stays readable if the canvas fails.

Run it:

```
python3 -m http.server 9000 --bind 0.0.0.0 --directory prototypes/story-page
```

## The rounds

<!-- One entry per operator round: what was offered, what came back. -->

**Round 1.** The full page against the preview, and four decisions. The operator took all four
recommendations in one reply. The scene 7 line keeps the four harness names, and the cutover
ticket ([#604](https://github.com/alp82/curia/issues/604)) checks `config/routing.yaml` on cutover
day: if `pi` and `opencode` have not landed, the line becomes a two-name line before the page goes
live. The dogfood links stand: "planned, decided" points at map #109, which chains to map #600,
and "written" points at the merged pull request list. The five condensed setup steps, new words of
this ticket, stand as shown. No scene needs another round.

**Round 2.** The review gate came back rejected, with notes across the whole page: the hero
animation is too small and too spread, the mess scene does not transport, the order scene is not
narrated and misses the blocked tickets, the section titles have no design or visual identity,
titles must come before their evidence, the Discord scene must look 100% real and assemble on
scroll, the phone preview needs real content and an auto-cycling switcher, the atlas should show
one map with its tickets, the two TUIs must match their real counterparts, the horizontal
scroll hijack of scene 8 is bad, the VPS scene explains too little, and the whole page needs a
unique visual identity. The operator also wants the Matt Pocock wrapper claim promoted into the
hero title, which would override the locked headline of #587. The operator did not want these
groups iterated in one session, so the iteration splits into follow-up tickets on the map.

**Round 3.** The split is confirmed, all as recommended: eight follow-up tickets on the map, one
identity ticket first and then one per scene group, chained one at a time. The last one unblocks
the cutover ([#604](https://github.com/alp82/curia/issues/604)). This ticket merges the baseline
candidate and closes, so every follow-up edits the same base. The hero-title override is
confirmed: the opening-arc ticket offers titles that lead with the Matt Pocock wrapper claim, and
positioning.md records the change with that ticket.

## The identity rounds ([#624](https://github.com/alp82/curia/issues/624))

**Round 1.** The identity frame went in: every scene leads with its claim (a numbered kicker,
then the bold line), scenes alternate sides, and the evidence leans toward the other side. Three
skins rode `?id=a|b|c`: A pipeline (stage-colored rules), B ledger (hairlines and outlined
numerals), C chart (dashed route and map-card frames). The operator: numbering starts at 1, and
all three read as book chapters instead of a continuous story. The direction is an action movie:
fast cuts, different backgrounds, color transitions. From now on every round offers five vastly
distinct variations built from the feedback so far. That default also becomes curia policy:
the grilling ticket [#635](https://github.com/alp82/curia/issues/635) decides the rule, and the
task ticket [#636](https://github.com/alp82/curia/issues/636) applies it.

**Round 2.** Five action-movie skins on `?id=1..5`: 1 smash (hard-cut stage panels), 2 slash
(diagonal cuts), 3 flood (scroll-driven background hues, spotlights), 4 slate (wipe bars),
5 montage (tilted planes, zoom cuts). All kept claim-first, alternation, numbering from 01 and
the four stage colors. The operator: smash is best, but the others deserve places too, and the
page will likely vary its treatment across the scroll. The ask for round 3 is much more unique
boldness. Background colors, transitions and layouts are all open, wild but with taste.

**Round 3.** Five bolder composites led by smash: 1 acts (one cut per pipeline stage), 2 megatype
(ghost numerals, poster titles), 3 fullflood (hard body-background hue journey), 4 slab (solid
stage-color claim slabs), 5 poster (boxed uppercase titles). The operator: fullflood is the
baseline for more exploration. Slab stays, but only as an accent of importance. The acts flow is
liked. The flood must change: each section owns its color, so a color change never repaints an
earlier section, and sections transition from and into grayscale, with opacity and blur in play.

**Round 4.** Five flood variations with per-scene color fields, a scroll-driven activity value,
grayscale and blur passage, and the slab on the gate claim: 1 grayfade, 2 focus, 3 stagelight,
4 chromawipe, 5 actsflood. The operator rejected all five: potential, but the execution looks
sloppy and without craftsmanship. Each section must stand out, with even bolder distinctness.

**Round 5.** The craft floor rose: every scene got a designed hue pair leaning toward its
medium, words never dim or blur, and the scroll value drives decoration only. Five design
languages over that palette: 1 duotone (glow orbs over grain), 2 poster (numeral watermarks),
3 frames (gallery hairlines), 4 beam (edge light), 5 collage (slashes and tilts). The operator
picked duotone, confirmed the per-medium palette as the identity rule, and confirmed the hero
exception. The losing languages and the switcher left the file with this round.

## The opening arc ([#625](https://github.com/alp82/curia/issues/625))

Scenes 1 to 3 — the hero, the mess and the maps-bring-order beat.

**Round 1.** The three scenes became ONE pinned stage, which is what the operator's round 2 note
asked for: the animation holds its place, the hero words dock at the bottom and leave, the camera
climbs into the mess above, then falls back through curia onto the maps. One scroll value drives
the camera, the cards and the words.

The rule of the arc: above the curia line a ticket is gray and askew, and below it the same ticket
is colored and square. That line is what curia does, and it is what makes the effect visible.

What the round 2 notes changed, one by one:

- **curia is large.** The node is a tenth of the shorter viewport edge, never under 58 px across,
  with its name set at 42 per cent of its radius.
- **The maps are large and close.** Three cards, 252 px wide, 20 px apart, centered. One card on a
  phone. They stand from the first frame, so the first screen shows ordered work coming out.
- **Tickets look like tickets.** A state edge, a GitHub issue icon that goes dashed when the ticket
  is blocked, the number in mono, a label chip in the state color, and the title. 216 px wide.
- **The effect is loud.** Every card crosses the line gray and leaves it colored, with a pop and a
  ring thrown from the node.
- **Agents pick tickets up.** In the last beat an amber orb flies to the takeable row of each map,
  the row runs, merges, fades out, the map bar advances, and the ticket it blocked lights up.
- **The mess is the same place, closer.** It is no longer a separate screen. The camera rises into
  it and the background drains toward gray.
- **The order beat explains itself.** The maps are three real maps of this repo with their real
  tickets. Blocked rows carry a dashed ring and hang off the row they wait on, and a legend names
  blocked, takeable and an agent on it.

Five stagings ride `?id=1..5`, five hero titles ride `?t=1..5`, and a switcher carries both:

| id | staging | the mess | what curia is |
|----|---------|----------|---------------|
| 1 | funnel | free scatter, drifting | a ring with a turning collar |
| 2 | scanner | a neat grid | a full-width scan bar with a lens |
| 3 | collapse | an overlapping, tilted pile | a disc throwing shockwaves |
| 4 | lanes | one unsorted column | a sorting bracket, one map close up, every row tagged |
| 5 | orbit | a cloud turning around the node | a solid disc |

The five hero titles, offered because #551 round 3 confirmed the Matt Pocock wrapper claim
overrides the headline locked at [#587](https://github.com/alp82/curia/issues/587):

1. The locked line, kept as the control: "Coding agents controlled from your phone".
2. The wrapper claim on its own line above the locked line.
3. "Matt Pocock's skills, dispatched to coding agents from your phone".
4. "Run Matt Pocock's wayfinder from your phone".
5. The kicker carries it: "curia — a self-hosted wrapper for Matt Pocock's skills".

Title 4 uses "wayfinder", which positioning.md bans as internal vocabulary, so it needs an
operator ruling before it can ship.

The page still reads with no script and with reduced motion: the track collapses to one screen and
the three panels stack as ordinary sections.

**The operator's answers.** The hero title is **4**, "Run Matt Pocock's wayfinder from your phone".
The wayfinder ban is **removed**, because the page should encourage the word rather than avoid it.
Both changes are recorded in [positioning.md](../../docs/landing-page/positioning.md) by this
ticket. The scroll length is left for a later round.

No staging won. The notes, grouped:

- **The scroll.** Every staging hijacked it. Visuals may react to the scroll, but some content must
  scroll normally, and the big titles and their subtext must never wait.
- **The mess.** The orbiting cloud of staging 5 is the winner. The scatter of 1 and 3 drew a
  diagonal that looks bad, and the rows of 2 and 4 look sorted already.
- **The design.** Best at 5 and 1. Tickets coming in and going out is the part that works.
- **The maps.** They feel static, and tickets stay in them.
- **curia.** It is big, but its purpose is unclear.
- **The order beat.** The same in all five, and it works.
- **Staging 4** carries an extra fault: only one map.

**Round 2.** The arc was rebuilt on those notes, and the hero now carries title 4.

The pin is gone. The canvas sticks for one screen and the words scroll over it in normal flow, so
the reader keeps the scroll and no title ever waits. The camera reads the words rather than a
scroll fraction: the mess claim pulls it up into the cloud, and the order claim brings it down onto
the maps.

The mess orbits in every staging now, at several radii, in two counter-turning shells. The maps run
on their own clocks from the first frame: an agent flies in for the takeable row, works it, the row
merges, the agent carries it off, the queue steps up a place, and new work drops in at the bottom.
The stream never stops, so work is always entering curia and always leaving it. The scroll into the
order beat pushes the whole stream forward, which is what the scroll buys.

Every staging tells curia's purpose a different way. That was the open fault, so it became the
axis the five vary on:

| id | staging | how curia's job reads |
|----|---------|-----------------------|
| 1 | routes | three lit routes run from curia to three named maps, before a ticket moves |
| 2 | ports | one port per map on curia's rim, and a ticket leaves by its own port |
| 3 | stamp | curia stamps the map badge onto each card as it crosses, with a harder flash |
| 4 | queue | tickets line up at the rim and curia pulls them in one at a time |
| 5 | pulse | curia beats, and each beat pulls a batch in and fires it out |

All five keep the orbiting cloud, the live maps, the solid disc with its turning collar, and the
order beat. The disc carries one line under its name that says what it does.

**The operator's answer.** Two faults, and no pick:

> strange, all 5 look the same to me. also the scrolling content is blocking the animations. they
> should never get in each others way. instead they need to dance together in a flowing motion

Both were fair. The five differed only in ornament: a port dot, a badge chip, a flash. The
composition was the same in all five, so on a phone they read as one page. And the words scrolled
over a canvas that knew nothing about them, so the art sat under the text.

**Round 3.** Two changes, and a lesson worth keeping.

**The lesson.** Round 2 varied the fix for a fault instead of varying the design. curia's unclear
purpose was a fault to repair everywhere, not an axis to spread across five. So all five now carry
the whole repair: the disc says "reads every repo" under its name, its rim holds one port per map,
and lit routes run from it to each map before a ticket moves. The variations went to the design.

**The words and the art share the screen.** They never overlap. Every frame the canvas measures
each block of words on screen, takes the largest space they have left, and eases into it. On a wide
screen each claim docks to its own side and the art takes the other, which is the alternation #624
already asked for. On a phone they trade the top and the bottom.

The blocks are measured apart rather than merged. One rectangle around all of them swallows the
whole screen whenever two claims are on it at once, one leaving the top and the next arriving,
which is most of the scroll.

The eased box is where the art wants to be, and it lags the scroll on purpose, because easing is
what makes the motion flow. The words move at scroll speed, so the promise is kept against their
live rectangle every frame, after the fact. A card that would land on a word is pushed off it by
the shortest distance.

**The five differ by axis.** Not by ornament:

| id | composition | where the work goes |
|----|-------------|---------------------|
| 1 | stack | the pile above, curia, the maps below. Work falls |
| 2 | rise | the pile below, curia, the maps above. Work climbs |
| 3 | conveyor | the pile at one end, curia in the middle, the maps stacked at the far end |
| 4 | diagonal | the pile in one corner, the maps stepping down to the far one |
| 5 | hub | curia holds the middle, large, and the work turns around it on every side |

**The operator's answer.** No single pick. They took parts of two compositions, named the story the
arc should tell, and changed what the mess is made of:

> rise is nice because it can scroll the maps up out of sight naturally and focus on the mess
>
> at the hero level 1 does a better job to show the floating mess coming into curia
>
> scrolling 2 should move the maps away and translate the tickets in the orbiting variations from
> earlier
>
> scrolling further should then bring the order by giving them the labels
>
> mess -> grayscale notes
> organized -> labeled tickets

**Round 5.** The composition is settled, and it borrows from both:

1. **The hero** is stack, because it shows loose work floating down into curia with the maps
   standing under it.
2. **Scrolling** rides the maps up out of sight, the way rise made natural, while the work gathers
   into the orbiting cloud.
3. **Further** brings the labels, and that is what order means.

The mess is no longer gray tickets. **A note carries no number, no kind and no state, only marks
nobody can act on. A ticket carries all three.** One card is drawn for both, and every part of it
crosses over on a single number, so a note becomes a ticket rather than fading into one. That makes
curia's whole effect one move a reader can name: it gives work its labels.

The five variations are the MOMENT the labels land, because that moment is the point of the scene:

| id | moment | what the reader sees |
|----|--------|----------------------|
| 1 | sweep | a line walks down the cloud, and everything it has passed is labeled where it lies |
| 2 | through | nothing is labeled until it has been through curia and out of a port |
| 3 | snap | curia takes one beat and the whole pile turns at once, on a shockwave |
| 4 | stamp | labels fly out of curia and land on the notes one at a time |
| 5 | unfold | each note opens into a ticket where it floats, with a pop |

## The verdict

**The identity is duotone, locked at [#624](https://github.com/alp82/curia/issues/624) over
five operator rounds.** The frame every scene ticket (#625 to #631) conforms to:

1. The claim comes first: the numbered kicker, then the bold line, then the evidence.
2. Scenes alternate sides. The claim docks on the scene side, and the evidence leans toward
   the other side. Reveals come from the scene's own side, fast.
3. Numbering starts at 01 on the first scene after the hero.
4. Every scene owns a designed hue pair, inline on its section as `--g1`/`--g2`, leaning
   toward the hue of its medium: Discord blurple, tailnet teal, atlas cyan, terminal green,
   gate indigo, merged forest. A color never repaints an earlier scene.
5. A stage-colored glow orb burns on the docking side as the scene arrives, over a fine
   grain. The scroll value `--p` drives decoration and evidence saturation only. Words are
   never filtered or dimmed.
6. The four stage colors of the pipeline mark the kickers and the slab.
7. One slab accent: the gate climax claim. Slabs mark importance and stay rare.
8. The hero stays out of this frame. Its words sit at the bottom, locked at #567, and the
   opening arc ticket [#625](https://github.com/alp82/curia/issues/625) revisits it.
