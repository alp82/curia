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

**The operator's answer.** Three faults, and the last one is the one that matters:

> all 5 look the same to me. also you didn't use RISE as the baseline. and you didn't use ORBIT for
> the mess chapter at all.
>
> FOLLOW MY PREFERENCES WHEN BUILDING PROTOTYPES

All three were right, and two were plain instructions from the round before that this build did not
carry out. The round 3 answer said rise is the baseline. The build put the maps at the BOTTOM and
the pile at the top, which is stack. The same answer said the tickets translate into the orbiting
variation for the mess chapter. The build faded curia out during the mess, so there was nothing left
to orbit.

**Round 5.** The preferences first, then the variations.

**Rise is the baseline.** The maps stand ABOVE, curia holds the middle, and the loose work lies
BELOW it. Work climbs. That is what lets the maps ride up out of sight on the scroll and hand the
screen to the mess, which is the reason the operator gave for choosing it.

**The mess chapter is the orbit.** curia keeps its place and stays lit, and the work turns around
it on every side. The hero keeps the quality of stack that the operator singled out: notes float
into curia and come out as tickets for the maps, and that stream runs the whole time the hero words
are on screen.

**The five are the orbit**, because the orbit is the chapter the operator asked about:

| id | orbit | what turns around curia |
|----|-------|-------------------------|
| 1 | ring | one necklace, every piece at the same radius, evenly spaced |
| 2 | sphere | a globe, with real depth: work behind curia passes behind it |
| 3 | spiral | one arm winding out of curia over three and a half turns |
| 4 | lobes | a dumbbell, wide to each side, with sky above and below curia |
| 5 | orrery | three rings at three radii, each on its own tilt and speed |

A build check now asserts the preferences rather than trusting the build: the maps above curia and
the work below it at the hero, the maps gone and curia still lit at the mess, work on all four sides
of curia there, and the maps back for the order beat. It runs for every variation at two viewport
sizes. Two rounds were lost to not checking this, and the check found a third fault on the way: the
orbit was drawn wider than the space it had, so every card was clamped onto the boundary and all
five shapes collapsed into the same rectangle of work.

**The operator's answer.** The orbit is settled, and the order beat gets a new shape:

> 1 at hero, 2 when scrolling
>
> scrolling immediately starts moving the scene into the second one
>
> the organization animation at 3 is too fast. lets bring the maps in position as empty ones and
> tranform them into wayfinder tickets and put them into the maps in smaller pace to see what
> happens

**Round 6.** The orbit is the ring at rest and the globe on the scroll, and the two are blended by
the arc's own scroll rather than by a chapter, so the necklace starts opening from the first turn of
the wheel. The band also rounds out as it opens, bounded by the room it has.

The order beat is rebuilt in the three steps the operator named:

1. **The maps come back empty.** They travel into place on their own progress, ahead of everything
   else, and they carry no rows at all.
2. **Then the notes take their labels.** A card's chip now reads the label a ticket really wears on
   this repo, `wayfinder:prototype`, cut back to the bare kind when the card is too narrow.
3. **Then the tickets climb into the maps, one at a time.** A map fills from the top, and once it
   holds three the oldest steps out to make room.

**It is slower.** The tail room after the order claim went from 55svh to 110svh, and the beat's own
window widened with it. The landing now runs over about eleven scroll steps in forty, against five
before. That number is what "too fast" came down to, and it is the one thing this round changes
about the pace itself.

The five variations are the RHYTHM of that landing, which is what there is to watch:

| id | rhythm | what the reader sees |
|----|--------|----------------------|
| 1 | one at a time | nothing overlaps: label, climb, land, then the next one |
| 2 | labels first | the whole pile takes its labels, then the tickets go up in turn |
| 3 | steady stream | labeling and climbing overlap, a few in the air at once |
| 4 | map by map | one map fills, a pause, then the next |
| 5 | state by state | the merged ones first, then the takeable, then the blocked |

**The operator's answer.** Still too fast, and the maps arrive from the wrong side:

> scene 2 should scroll the maps into place from the bottom to feel more natural with the journey
>
> the tickets move too fast even with a single scroll tick, it's just a super fast movement from the
> mess into the map, i can see the actual ticket just for a split second
>
> i actually want to see how they move into curia, transform into the beautiful labeled self and the
> move into the maps

**Round 7.** The journey is three plain moves with a HOLD in the middle, so there is something to
watch at each one:

1. **Into curia.** The note climbs out of the orbit, straightening as it goes.
2. **The change.** It STOPS at curia and becomes a labeled ticket, in place.
3. **Into the map.** The ticket carries on up to the map it belongs to.

The three moves get equal scroll. Six pieces of work make the journey and the rest stay in the
orbit, because the backlog does not empty.

**The maps rise from the bottom.** They ride up and out of sight for the mess as before, and the
empty ones come back up from the foot of the screen, which is the way the reader is travelling. The
two sets never cross, because the swap happens while both are off the screen. The maps are drawn
last now, so one rising past the orbit passes in front of the work it is coming to collect.

**What was capping the pace.** The beat used to be driven by the order claim crossing the screen,
and a claim only takes about a screen to cross. It is driven by how far the reader has scrolled PAST
the claim now, so the beat can be given as much scroll as it needs.

**The five are a ladder of pace**, since pace is the open question. Everything else is identical in
all five. Each rung sets its own tail room, so a quick pace leaves no dead scroll behind it.
Measured on a 390 by 760 phone:

| id | pace | scroll per move | whole journey | the arc |
|----|------|-----------------|---------------|---------|
| 1 | slowest | 192 px | 575 px | 9.9 screens |
| 2 | slow | 150 px | 451 px | 8.4 screens |
| 3 | middle | 115 px | 345 px | 7.1 screens |
| 4 | quick | 88 px | 263 px | 6.1 screens |
| 5 | quickest | 66 px | 197 px | 5.3 screens |

For comparison, the whole journey was about 44 px of scroll in round 6, which is the split second
the operator saw. The arc's total height is the price of watching six journeys, and it is what the
ladder trades against.

The preference check caught a silent failure this round: an edit meant to introduce the ladder did
not apply, so the page kept one fixed pace while the notes claimed five. The five all measured
identical, which is how it surfaced.

**The operator's answer.** Three faults:

> problems with scene 2:
> * the maps should stay at the bottom, no need to move them above again
> * the tickets make huge steps. i want a smooth movement and transition path
> * first ticket can be done deliberately, and then it quickly grows exponentially to do the rest

**Round 8.**

**The maps stay at the bottom.** They still ride up and out of sight for the mess, and the empty
ones rise from the foot of the screen, but they stop at the foot of the box now instead of climbing
over curia again. curia sends work out of whichever rim faces its maps, so the ports and the routes
turned to face down, and the orbit keeps clear of the map cards as well as of the edges.

A map on its way up travels through space the words hold. Shoving it aside would spoil the arrival,
so it fades across them instead. Nothing is ever drawn on top of a word either way.

**The huge steps were one bad line, not a pace.** The journey's last move started at curia's PORT
while the two before it ended at the HOLD above curia's middle, so the card vanished from one and
reappeared at the other. The three moves share their end points now, and the last one is a curve
bent through the port rather than a jump to it. The card also travels linearly with the scroll, so
the movement tracks the reader's finger.

**The first journey is deliberate, and the rest accelerate.** Each journey's window is the one
before it times a ratio, so the first is long enough to follow and the last is a flash. The five
variations are how steep that ramp is. Scroll for each of the six journeys, on a 390 by 760 phone:

| id | ramp | #1 | #2 | #3 | #4 | #5 | #6 |
|----|------|----|----|----|----|----|----|
| 1 | gentle | 588 | 471 | 377 | 301 | 241 | 193 |
| 2 | easy | 738 | 517 | 362 | 253 | 177 | 124 |
| 3 | middle | 874 | 542 | 336 | 208 | 129 | 80 |
| 4 | steep | 1063 | 553 | 287 | 149 | 78 | 40 |
| 5 | steepest | 1266 | 532 | 223 | 94 | 39 | 17 |

The arc is 7.1 screens for all five, because only the ramp changes.

**A check for the path.** It follows one ticket by its number through its whole journey, with the
clock held still so nothing but the traveller moves, and reports the largest hop for a small scroll
step. The path now hops at most 19 px for an 8 px step. The check was wrong the first time: it
matched cards to their nearest neighbour, and a neighbouring card stood in for the one that had
jumped, so it reported smooth. Restoring the old bad line proved the fixed version catches it, at
85 px.

**The operator's answer.** The order beat becomes a pipeline, and the rhythm is named exactly:

> at roughly this point, the curia node should be a bit further below, the maps should already
> scroll in (faster than the content) and the sphereing ticket mess should resolve more above the
> node so that we have a pipeline from (center/top) right to bottom
>
> the first ticket should then be processed with full visibility
> then the second and third in very quick succession
> and then the rest very quickly to clean up everything until nothing of the mess remains
>
> 5 variations, but always make them distinct, not only slightly different

**Round 9.** The order beat is a pipeline read top to bottom: the mess resolves ABOVE curia, curia
sits lower in the middle than it did, and the maps hold the foot of the box.

**The maps arrive early and fast.** Their cue is the order claim approaching rather than the beat
itself, so they are already rising while the claim is below the fold, and they cross the screen
inside about two thirds of it. That is faster than the reader is scrolling.

**Every piece of work now clears.** All fourteen make the journey, against six before, and the
check asserts that nothing is left adrift at the end.

**The rhythm**, measured on a 390 by 760 phone over a beat of 2171 px:

| journey | scroll | share of the beat |
|---------|--------|-------------------|
| #1 | 1329 px | 0% to 61%, alone |
| #2 | 372 px | 61% to 78% |
| #3 | 319 px | 77% to 91% |
| #4 to #14 | 230 px down to 9 px | the last 17%, three in the air at once |

**The five pipelines** differ in the shape work takes on the way down, since the pipeline itself is
settled. They are wholly different figures, not variants of one:

| id | pipeline | the shape above curia |
|----|----------|-----------------------|
| 1 | column | one narrow stack, straight above curia |
| 2 | funnel | a V, wide at the top and closing to a throat |
| 3 | chute | one slant corner to corner, cutting across |
| 4 | tiers | three shelves with clear sky between them |
| 5 | vortex | a whirl standing over curia, winding inward |

A check compares where every pipeline puts its work, pair by pair. The weakest pair now differs on
45 per cent of cards, from 7 per cent when the shapes were first written: the early ones all lay
along one another's edges. The arc is 7.1 screens for all five.

**Two faults the checks caught.** `drawMapCard` took five arguments and was being called with six,
so the alpha that fades an arriving map had been ignored since round 6 and the maps never faded at
all. And a splice that inserted the pipelines deleted the curve helper the journey path depends on,
which would have thrown on the first ticket to leave curia.

**The operator's answer.** Curia went down while this question was open, and four calls failed
before the answer came back on a later one. Nobody answered in the meantime and nothing was decided
without them.

> vortex works and is good enough. lets lock this in

## The Discord scene ([#626](https://github.com/alp82/curia/issues/626))

Scene 4, the grilling. The operator's note at #551 round 2: the chat comes after the couch title,
it assembles while the page scrolls, the typing row stands alone at the bottom, the message
streams in, the whole of it is shown at two thirds of the viewport, and the chrome must read as a
real Discord chat.

**Round 1.** The scene became a pinned track. A lead holds the frame at the fold while the claim
is read, then the frame rises and the card writes itself into it. The scroll POSITION drives the
assembly, never a clock: `q` is 0 at the fold and 1 when the top of the frame stands two thirds of
the viewport up. The typing row goes at `q` 1. The press of button A and the receipt ride the pin
travel after that, so the answer lands last and the thread glyph turns from ⏳ to ✅.

Every line in the frame is a shape curia ships, read out of the daemon rather than invented:

| part | source |
|------|--------|
| the head line, esc id and agent name | `daemon/src/bridge.mjs:1251` |
| headline, options, the ↳ consequence and the › example | `daemon/src/card.mjs:53,67,42,43` |
| the recommendation line | `daemon/src/card.mjs:70` |
| the details spoiler and the timeline small print | `daemon/src/card.mjs:82,83` |
| one Primary button per option, carrying the full label | `daemon/src/bridge.mjs:1183` |
| the preview, timeline and terminal link row | `daemon/src/bridge.mjs:1491` |
| the answered receipt, edited onto the same message | `daemon/src/bridge.mjs:1521` |
| the thread name and its ⏳ and ✅ glyphs | `daemon/src/bridge.mjs:644,96` |
| the parent channel, `#curia` | `daemon/src/bridge.mjs:482` |

The question and the three options are the real escalation of curia#377, in card 4 of
[#415](https://github.com/alp82/curia/issues/415) — the shape the operator picked, word for word
from [`prototypes/escalation-card/variants.mjs`](../escalation-card/variants.mjs). The real answer
was A, the journal.

Five chromes ride `?d=1..5`, and each assembles its own way:

1. **phone** — the mobile app: status bar, back chevron, header, composer. Streamed character by
   character.
2. **desktop** — the guild rail, the channel list with the other ticket threads, the chat pane.
   Block by block, and the typing row sits under the composer the way the desktop client puts it.
3. **thread** — the thread panel with its breadcrumb. Typed, with a caret.
4. **bare** — no app chrome at all, the message alone on the stage. Each block rises from the
   typing row.
5. **channel** — the phone app with the channel behind it: the start line and the claim message
   above the card, which scroll out of the top as the card grows.

**The type.** The page ships no webfont ([build.md](../../docs/landing-page/build.md)), so the
frame uses Discord's own fallback stack, `"gg sans", "Noto Sans", "Helvetica Neue", Helvetica,
Arial`. gg sans is licensed and never loads. On an Apple device that lands on Helvetica, which is
what Discord itself falls back to. It is narrower and more closed than gg sans, so the names and
the bold lines run slightly short.

**The card is long.** The whole of it at once means small type: the frame measures the card
against the log and shrinks the root size until it fits, with a floor of 9px. The alternative is
life-size type with the top of the message clipped, the way a real chat clips. That is a round 1
question.

**The operator picked the desktop chrome** and rewrote the mechanic:

> lets continue further iterations with desktop
>
> then answer from the couch title should very soon after start with scrolling the discord window
> into screen. it should be minimum height and just show "writing ..." note that the bot has
> something to say. the bottom of the discord window stays fixed at the viewport bottom edge and
> it grows veritcally as more and more messages appear while scrolling the "answer from the couch"
> approaches the top

The three other questions of round 1 came back unanswered, so they ride into round 2.

**Round 2.** The window no longer travels. It comes in at its minimum height, catches the bottom
edge of the viewport, and GROWS upward as the card arrives. The claim leads, rides to the top of
the screen and sticks there, and the gap it leaves is the room the window may take.

The mechanics, in one place:

- **`position: sticky; bottom: 0`** on the stage is the whole trick. The window scrolls in from
  below, its bottom edge catches the viewport bottom, and every block that lands grows it upward.
- **Minimum height means minimum.** At `q` 0 the whole message is gone, name row and all, so the
  window is a header, a text box and the typing row. The guild rail and the channel list are
  absolutely placed inside boxes that measure zero, or the window could never come in short. The
  growing window then reveals more of the channel list, the way a resize does.
- **The clock is the track.** `q` is 0 the moment the window catches the bottom edge, which the
  script computes from the window's own minimum height, and 1 when the claim reaches a tenth of
  the way down the screen. One number drives the whole scene.
- **The cap keeps the words off the evidence.** The script measures where the claim comes to rest
  and gives the window everything below it, then shrinks the type until the whole card fits that
  room. On a wide screen the type lands near life size. On a phone a desktop window is a
  miniature, and no font size changes that.
- **The typing row sits under the text box**, which is where the desktop client puts it, and which
  is also what the operator asked for: nothing but that row at the bottom when the window arrives.

Five growths ride `?d=1..5`, all in the desktop chrome:

1. **grow** — the plain reading. Blocks land, the window grows.
2. **window** — the app in its own frame on a desk, with a title bar and full rounding.
3. **stream** — the characters type themselves into the block that is landing, with a caret.
4. **fill** — corner to corner. The app owns the bottom edge of the screen, square.
5. **history** — the start line and the claim message sit above the card and are pushed out of the
   top as it grows. The fit ignores them on purpose, so they really do ride out.

Three bugs in the first cut of this, caught by reading rather than by looking: a `flex: 1` on the
log gave it a basis of zero, so a window that sizes itself to its content had nothing to grow on.
A narrow-screen rule for the rail sat above the rule it meant to override, so it never applied.
The message name row survived at `q` 0, so the window came in showing a header with nothing under
it instead of the typing row alone.

**The operator picked the stream, and sent a screenshot of the scene on their own screen:**

> stream, but do not overflow the bottom. it should always have some padding and show the thinking
> state a bit longer
>
> also the thread names should be nicer, the prose much much easier to scan and understand
>
> the window should look even more like a real discord window. we can make it a bit wider too as
> long as it works both on desktop and mobile

The screenshot showed the composer cut off by the bottom edge of the screen while the card was
already streaming. Round 2's anchoring caused it, and the cause is worth recording.

**Why the window overflowed.** `position: sticky` with `bottom: 0` only pushes an element down
when its natural bottom would sit ABOVE the bottom of the viewport. The window's natural bottom is
its top plus its height, and the height was growing. So the growth raced the scroll: for every
pixel the track rose, the card added about a pixel, the natural bottom stayed put, and the sticky
rule had nothing to correct. The window simply hung past the edge.

**Round 3.** The anchoring is rebuilt so overflow is not a thing that can happen.

- **The stage IS the viewport.** It is a screen tall and sticks at the top, and the window is
  absolutely placed against its bottom with `bottom: 2.6svh`. The window's distance from the
  bottom of the screen is then a constant, at every scroll position and every height.
- **The track is pulled up under the claim**, 115svh of negative margin, so the stage is already
  stuck by the time the claim arrives. A stage that sticks late anchors the window late, which is
  the round 2 fault by another road.
- **The entry is an unfold, not a climb.** The window is clipped from the bottom up, so the typing
  row is the first thing on screen and nothing is ever placed past the edge.
- **The thinking state holds.** The first 17 per cent of the growth is the typing row alone.
- **Everything streams**, character by character with a caret, which is the cut the operator
  picked at round 2.
- **The words came down.** Every option is a bold label and one `↳` consequence. The `›` examples
  are gone, and #415 left them to the agent's judgment, so the card is still card 4. The headline
  went from "Re-arm it at boot, and from what?" to "Where does it re-arm from?", and the timeline
  lost its filler.
- **The thread names carry the type.** `⏳ 377 · curia · grilling`, `🔎 371 · curia · prototype`,
  `🎫 218 · dotfiles · research`, `✅ 364 · curia · task`. That is the real shape from
  `bridge.mjs:644`, and a second repo in the list is what makes it scan. The glyph turns green in
  the header AND in the channel list when the answer lands.
- **More of the real client.** The account panel pinned to the foot of the channel list, the
  add-server button on the rail, category arrows, the threads, notifications, members, search and
  help row in the channel header, and the gift, GIF, sticker and emoji row in the composer.
- **Wider**: 52rem, and 64rem on the `wide` cut.

Five cuts ride `?d=1..5`, all of them keeping the padding, the hold and the stream:

1. **full** — the whole client.
2. **wide** — the window across the whole page.
3. **chat** — no rail and no channel list, so every pixel of width is the card.
4. **lean** — the card cut to the bone. No visual, no spoiler, no small print.
5. **reply** — the operator answers in the thread in their own words.

**The operator picked full, and sent a screenshot of their own Discord session:**

> full looks best. we could use a little bit more padding and breathing room though. here is a
> screenshot from this discord session which shows even more that you can do to make the discord
> window more realistic. we can make things like the right sidebar responsive to not clutter mobile
> too much
>
> 5 more variations that do the changes above and mainly differ in the story they are telling
> (ticket, messages, etc.)

**Round 4.** The chrome is now read off that screenshot rather than guessed, and the five
variations are five real escalations of this repo.

What the screenshot corrected, item by item:

| what the mock had | what the client actually does |
|-------------------|-------------------------------|
| author `curia` | **`CuriaBot`**, with a plain `APP` badge |
| the classic dark palette | a darker one: near-black rail, then the channel list, then the chat |
| no window chrome | a title bar: back and forward, the server name, and the window buttons |
| threads as flat channels | threads **nested under their channel** on a tree line |
| header shows the thread | header shows **`# curia › ⏳ 377 · curia · grilling`** |
| no member list | a member list on the right, roles grouped, the bot under Online |
| one composer icon | gift, GIF, sticker and emoji |
| no edited mark | the receipt is an edit, so the message wears **(edited)** |

The member list is the first thing to go on a narrow screen, which is what the operator asked for.
Padding went up across the message, the header, the composer and the code block.

**The five stories.** Every line of every card is recorded on this tracker or in this repo. Where
curia's own recommendation was never written down, the card carries **no** `Recommendation` line.
`card.mjs:69` prints one only when an option is marked, so a card without it is still a card curia
sends. Nothing is invented to fill a slot.

| # | ticket | shape | answer |
|---|--------|-------|--------|
| 1 | [#377](https://github.com/alp82/curia/issues/377) cooling dies with the daemon | 3 options, a visual, a recommendation | A, the journal |
| 2 | [#601](https://github.com/alp82/curia/issues/601) the medium of every proof moment | 2 options, no recommendation, the operator's own reply | built HTML, every scene |
| 3 | [#624](https://github.com/alp82/curia/issues/624) the visual identity of this page | 5 options, so a **select menu** instead of buttons | duotone |
| 4 | [#635](https://github.com/alp82/curia/issues/635) where the five-variation rule lives | 3 options, a recommendation | config and a settings row |
| 5 | [#671](https://github.com/alp82/curia/issues/671) a login a restart cut in half | 4 options, the button ceiling | session for the login, journal for the clock |

The shapes are not decoration. `bridge.mjs:52` caps buttons at four options, so the five-option
identity card really does come through as a select menu with `Pick from the menu below.`, and its
receipt reads `via select menu` rather than `via button` (`bridge.mjs:1742`).

**Story 1 stays static markup.** The other four are rendered over it by the script. That keeps the
rule this file has held since #551: the page reads a whole real escalation with no script at all.
When a story is picked, it becomes the static one.

## The verdict of the opening arc ([#625](https://github.com/alp82/curia/issues/625))

**Locked over nine operator rounds.** The other four pipelines, the switcher and the `?id` parameter
left the file with the round that settled them, the way the identity switcher did at #624.

**The hero title** is "Run Matt Pocock's wayfinder from your phone", picked at round 1 from five
candidates. It overrides the headline locked at [#587](https://github.com/alp82/curia/issues/587),
and it lifts the wayfinder ban. Both changes are recorded in
[positioning.md](../../docs/landing-page/positioning.md) by this ticket.

**Scenes 1 to 3 are one arc over a sticky canvas**, 7.1 screens tall:

1. **The hero.** Rise is the baseline: the maps stand above, curia holds the middle, and loose work
   lies below in a flat ring. Work climbs. Notes float up into curia and come out as tickets for the
   maps, and that stream runs the whole time the hero words are on screen.
2. **The mess.** The ring opens into a globe with real depth from the first turn of the wheel. The
   maps ride up out of sight, and the work turns around a curia that keeps its place.
3. **The order.** A pipeline top to bottom. The globe resolves into a vortex above curia, curia
   sits lower, and the maps rise from the foot of the screen and stay there, arriving empty. Each
   piece of work climbs out of the whirl, STOPS at curia to take its labels, then carries on into
   its map. All fourteen clear, and nothing of the mess is left.

**The rules the build keeps:**

- **A note is not a ticket.** A note carries no number, no kind and no state, only marks nobody can
  act on. A ticket carries all three, and its chip reads `wayfinder:prototype`. One card is drawn
  for both, and every part crosses over on one number, so a note BECOMES a ticket.
- **The words and the art never overlap.** The canvas measures each block of words on screen, takes
  the largest space they leave, and eases into it. The blocks are measured apart, never merged. The
  eased box lags on purpose, so the promise is kept against the live rectangle every frame.
- **The scroll is never taken.** The words scroll in normal flow over a canvas that only reacts.
- **The path never breaks.** The three moves of a journey share their end points, and the card
  travels linearly with the scroll.
- **The first journey is deliberate**, at 61 per cent of the beat, and the rest accelerate.
- **The page reads with no script and with reduced motion.** The track collapses and the three
  panels stack as ordinary sections.

**Four build checks** run against the file, since no agent on this ticket can look at it:

| check | what it asserts |
|-------|-----------------|
| preferences | the fifteen things the operator asked for, at two viewport sizes |
| words | no canvas text lands on the words, at any scroll position |
| path | one ticket followed by number never leaps, with the clock held still |
| distinctness | five variations differ in fact, not only in the notes |

Each one caught a real fault, and three of them were wrong themselves before they were right. The
lesson worth keeping: a green check that has never been shown a known failure proves nothing. Every
check here was validated by breaking the code on purpose first.

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
