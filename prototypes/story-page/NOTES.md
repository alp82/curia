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

**The operator picked the medium, and settled four more things:**

> 1. medium
> 2. discords default colors
> 3. let's make this, thread names, etc. more accessible for the sake of the landing page. easy and
>    short, nothing cryptic
> 4. keep it. pressing the button can be visualized with some kind of mini animation and pulse or
>    even cursor movement that appears and disappears
>
> window title should be Discord instead of AI Stack. alp82 should be Alper. selected thread should
> be correct in the sidebar. the window can be bigger in both dimensions if there is the space, we
> can also scale the font once we reach a certain viewport width like you do for smallest screens

**Round 5.** The scene tells [#601](https://github.com/alp82/curia/issues/601), the medium of every
proof moment, and its answer is what built every scene of this page.

**The card is now the redressed shape of
[ADR-0025](../../docs/adr/0025-the-cards-under-the-one-voice.md).** That answers the head-line
question three rounds carried, and it answers it the accessible way, because the two answers agree:

- The card head is dead ([ADR-0021](../../docs/adr/0021-the-thread-formatting-and-the-one-voice.md)).
  No `[esc-1]`, no `curia-601`, no `(choice)`. The `❓` carries the signal on the headline.
- The button carries a letter and a short handle, `A · HTML`, because the body already holds the
  full words. It is a press target, not the option said twice.
- The answered mark is small print.

**The names came down to plain words.** A thread reads `⏳ 601 · the proof medium`, not
`⏳ 601 · curia · grilling`. That is a DEVIATION from `bridge.mjs:644`, taken on the operator's
ruling that this page reads to a stranger first. The open thread is the selected one, which it was
not before. The window is titled Discord, the operator is Alper, and the server is curia.

**The press is shown, not merely recorded.** The scroll fires the beat, a short animation runs, and
the answer lands on its heel. Then the true thing happens: curia edits the card and clears its
components, so the button rows really do collapse away, the mark comes up in small print, the
message wears `(edited)`, and the thread turns green in the header and the channel list at once.

Five presses ride `?d=1..5`:

1. **cursor** — a pointer flies in from off the window, lands on the button, clicks, and leaves.
2. **pulse** — the button rings twice before it takes the answer.
3. **tap** — a thumb lands in the middle of it.
4. **ripple** — the press washes across it.
5. **lift** — the button rises to meet the press.

**Bigger where there is room.** The window goes to 66rem past 64rem of viewport and 76rem past
96rem, the height cap takes 88 per cent of what the claim leaves, and the type scales with the
window up to 16.5px, which is about what the client itself uses. The floor of 7px on the smallest
screens is unchanged.

## The preview scene ([#627](https://github.com/alp82/curia/issues/627))

Scene 5, the preview. The operator's note at #551 round 2: the phone preview looks really bad, it
needs a much better and more realistic display and actual content inside, a really nice bright
artsy website design, and a prototype switcher that cycles automatically.

**Round 1.** The old phone was a rounded rectangle with three gray bars in it. It is gone. The
device is now drawn part by part: a titanium rail, a black bezel, the dynamic island with its
lens, the status bar with signal, wifi and battery, the four side buttons, the home indicator and
one specular pass over the glass. Safari's floating address bar carries the tailnet host, which is
the evidence the claim asks for.

**What plays inside is a round, not a page.** Curia sends five variations per prototype round
([#635](https://github.com/alp82/curia/issues/635)), so the phone shows five art directions of one
bright landing page, and the switcher inside the phone is the one curia ships with a prototype. It
cycles every three seconds, a tap takes it over, and the cycle comes back eight seconds later. The
five directions are sun (cream, one tangerine sun, editorial serif), acid (white, black grotesk,
a lime block with a hard magenta shadow), bloom (a pastel mesh with soft cards), riso (mint,
halftone dots, two inks overprinted) and dusk (a sunset poster with a white arch).

The screen is drawn against a 15.5rem device and zoomed to whatever width a variation gives it, so
a smaller phone is a smaller phone rather than a zoomed-in page.

Round 1 offered five presentations of the device on `?id=1..5`:

1. **deck** — front on and as large as the column allows, standing in the scene's stage light. The
   round cross-fades in place, and the switcher stays inside the phone.
2. **tilt** — the device in perspective under a stronger specular, with the round on a rail beside
   it. The screens slide like a carousel.
3. **stage** — the phone is pinned against the viewport and the reader's own scroll turns the
   round. Nothing cycles by itself, and the bar under the chips is the scroll's position.
4. **stack** — the rest of the round waits behind the front design as tilted plates in its key
   color, and cycling pushes the front one back.
5. **pair** — the other half of the claim. The same preview fills a workstation window, and the
   phone hangs off its bottom-left corner. The window is drawn at 720px and scaled into place,
   which is what makes a miniature read as a desktop rather than as a narrow column.

**One deviation to record.** The prototype inside the phone is an invented one, a bakery called
SUNROOM. Every other proof scene on this page shows real curia records ([#601](https://github.com/alp82/curia/issues/601)).
A real curia prototype is dark, and a dark page inside a dark page proves nothing at phone size,
so the ask for a bright artsy design and the ask for true content pull apart here. Round 1 asks
the operator which one wins.

**Round 2.** The operator picked **pair**, and asked for five distinct layouts: "you can place all
3 elements differently." The four other presentations left the file with round 1, the way the
identity switcher left it at #624. The three elements are the phone, the workstation window, and
the round switcher, and the five layouts on `?id=1..5` place all three differently:

1. **corner** — the window fills the right, and the phone hangs off its bottom-left corner. The
   switcher sits under the window.
2. **desk** — both devices stand on one baseline, the way they stand on a desk, and the switcher
   runs centered under the pair of them.
3. **overlap** — the phone stands in front of a window turned a little off square, and the
   switcher is a column on the left.
4. **split** — the window runs off the left edge of the page, so the workstation reads as the
   bigger surface, and the switcher is the spine between the two devices.
5. **stack** — a column for a reader holding a phone: the switcher on top, then the window, then
   the phone leaning up into it.

**A fault of round 1, worth writing down.** The markup order is phone, then workstation, then
switcher. The pair layout stated no position for any of them, so it took that order by accident:
the phone rendered above the window and its negative margin pulled it up into the claim. Every
layout now says where each of the three elements sits, and a build check refuses a layout that
leaves one of them to the markup order.

**Round 3.** The operator rejected all five layouts: "they all look bad. title is always in the
middle (we can play with that like we did for the first scenes). screens are always left aligned
which is a weird combo. make the 5 next variations vastly distinct and get more creative in
display, style and layout! this is for grabbing attention and really conveying how great curia
is!" Their screenshot showed the fault plainly. At desktop width the claim sat in a centered
`.wrap` while both devices leaned left inside a `.shot`, so the title floated in the middle with
the screens jammed against the left edge and a screen of dead space beside them.

**The scene is one composition canvas now.** The `.wrap` and the `.shot` are gone from it. The
claim, both devices, the switcher and the fact line are grid items of `.pv`, and every variation
places all five of them. Each variation is written twice, once for a phone and once past 60rem, so
the five stay distinct on the screen the operator judges from as well as on a desktop.

The five compositions on `?id=1..5`:

1. **bleed** — scale is the whole idea. The phone is enormous and the edge of the page cuts it, so
   the screen reads as a thing in the room rather than a picture of one. The claim holds the rest.
2. **desk** — the workstation lies back in perspective, the way a monitor sits on a desk, and the
   phone stands in front of it.
3. **field** — the section keeps a bright field of its own, and that field takes the color of
   whichever design is showing. The round repaints the page every three seconds, which is the
   point the scene is making.
4. **strip** — a round is five screens, so the scene shows five. The script clones the device once
   per design, each clone pinned to its own, and the strip slides the active one to the middle.
5. **stage** — one hard light, one phone, and the workstation lying flat behind it. The screen is
   the only color in the scene, and its own key color spills onto the dark.

**Round 4.** The operator picked **desk**, with two corrections: "give it a bit of the perspective
of stage (only a little bit) and dont overlap the two too much, only a bit". The other four
compositions left the file with round 3. Every variation is a desk now. The workstation lies back
a little, the phone stands in front of it and crosses only a corner, and a little of stage's light
falls on both. The color half of that light is the key color of whichever design is showing, so
the desk changes color as the round turns.

What varies across the five is the camera, the light and where the claim docks:

1. **low** — a low camera, both devices standing on a lit surface, the phone crossing the near
   corner of the workstation.
2. **light** — one spotlight out of the top-left corner, the workstation barely tipped, and the
   phone standing at the right where the light falls off.
3. **flat** — the workstation nearly lying down and seen from above, which is the most of stage's
   angle any of these takes. The phone stands upright out of it.
4. **turn** — the workstation faces the other way, and the claim docks right, which is the side
   this scene owns in the identity (#624 rule 2).
5. **plane** — both devices share one tilt, so they read as two things lying on the same desk.

The claim comes before the evidence on a phone in all five (#624 rule 1). On a wide screen two of
them put the evidence in the left column and dock the claim right, which is the alternation the
identity asks of an `sR` scene.

**Round 5.** The operator picked the light desk: "light is great!". Two corrections came with it.
The title was breaking into seven lines, and the copy of the previewed website read as weird. The
other four desks left the file with round 4.

**The title fault.** The claim was capped at `14ch`. A `ch` is relative to the element's own font
size, and the cap sat on the `header`, which inherits 1rem, not on the 3rem line it holds. So the
cap was about 112px and the title broke seven times. The claim takes the width of its grid column
now, and no cap.

**The copy.** The ask for cooler copy is also the answer to the question that rode rounds 1 to 4:
the page inside the phone stays an invented site rather than a real curia prototype. Deviation
from [#601](https://github.com/alp82/curia/issues/601) recorded here.

The composition is settled, so `?id=1..5` now picks what the agent built. One subject fills all
five art directions, which is what a prototype round looks like:

1. **conf** — OFFLINE FIRST, a one-day conference. "Software that works on a train."
2. **type** — GRAVITY, a type foundry. "A typeface with weight."
3. **synth** — PULSE 01, a pocket synth. "A synth that fits in a pocket."
4. **club** — NOCTURNE, a record club. "Records pressed at night."
5. **park** — DARK SKY, a night reserve. "Dark enough to see the galaxy."

Subject 1 is in the markup, so the page still reads whole with no script. The other four are in
the script, beside the table that names them.

**Six build checks** ran against the file, since no agent on this ticket has eyes on it: every
design appears once with its own palette and its own art, the composition places all five elements
of the scene and is written for a wide screen as well as a phone, every subject is whole and keeps
a headline the screen can hold, no two subjects share a headline, the markup carries a subject of
its own so the page reads with no script, every class the markup uses is styled and every hook the
script reaches for is in the markup, and the build rules hold (no image, no remote asset, no
webfont). Each check was validated by breaking the
file on purpose first, one break at a time, and every break produced exactly one failure.

## The atlas scene ([#628](https://github.com/alp82/curia/issues/628))

Scene 6, the atlas. The operator's note at #551 round 2, verbatim: "the dashboard should show just
the first map but with the tickets below as in the prototypes defined".

**Round 1.** The old scene showed three maps as three bands and no tickets at all. It is gone. The
scene now shows ONE map with its work under it, in the shapes
[prototypes/maps-screen/](../maps-screen/) decided at
[#522](https://github.com/alp82/curia/issues/522): the head with its fraction, the progress band,
and the ticket rows below.

**The map is this map.** Scene 6 shows [#600](https://github.com/alp82/curia/issues/600), the map
that is building this page, and every count is what the tracker held while this round was worked
(#601: real records):

| state | count | what it is |
|-------|-------|------------|
| walked | 10 | closed children, #627 the most recent |
| in flight | 1 | #628, this ticket, claimed and running on `claude-opus-5` |
| blocked | 5 | #629, #630, #631, #604, #145, one behind the other |
| the fog | 2 | the two patches under Not yet specified |

Nothing is takeable, because the one unblocked ticket is the one being worked. The map really is a
single chain, which is why several compositions can read it as one.

**The five differ by composition**, not by ornament. All five carry the same head, the same counts
and the same rows:

| id | composition | what it does with the map and its tickets |
|----|-------------|-------------------------------------------|
| 1 | panel | the maps screen transplanted: worded band, then every group under its own label |
| 2 | counters | no band and no group labels. Four big counts, then ONE flat list by state |
| 3 | board | every ticket is a card edged in its state, with its type and routed model |
| 4 | live | the running ticket leads at full size, and the rest of the map queues behind it |
| 5 | chain | the tickets are links off one rail, and the band drops to the foot as the summary |

The round bar rides `?id=1..5` and swaps a composition in place, so the operator compares the five
without leaving the scene. It is round chrome, and it leaves the file with the round that settles
this scene, the way the identity switcher left it at #624.

**Eight build checks** ran against the file, since no agent on this ticket has eyes on it: five
compositions numbered in order with a bar button each, the same real ticket numbers in every one of
them, the same counts however a composition states them and a sum that matches the map's sixteen
tickets, no two compositions sharing more than half their skeleton, every class styled and every
hook in the markup, composition 1 showing with no script and the bar hidden until the script runs,
the build rules of [build.md](../../docs/landing-page/build.md), and balanced markup. Each check was
validated by breaking the file on purpose first, one break at a time, and every break produced
exactly one failure.

**Two faults the checks caught before the operator saw them.** The first cut of composition 2 was a
vertical band with the ticket rows hanging off it. The distinctness check measured 66 per cent of
its skeleton shared with composition 1, which was fair: both were a head, a band and labeled groups
of the same row. It became the counters instead. The count check then failed on composition 2,
because it assumed every composition draws a band. A composition that states the counts another way
is not a fault, so the check now reads the counts from whichever shape carries them.

**The operator's answer.** No pick. The scene needs two screens, and the second one has to look
like the prototype that decided it:

> make it 2 screens. a simplified home dashboard and something like the panel but looking like the
> result of the respective prototype (the one with the red lined background for blocked and the
> diagonal grey stripes for the fog)

The red-lined blocked box and the striped fog strip are
[prototypes/frontier-visual/](../frontier-visual/) ([#588](https://github.com/alp82/curia/issues/588))
round 5. The three questions the answer did not touch ride into round 2.

**Round 2.** The scene is two screens now, and both redraw a decided curia screen rather than a
band of this ticket's invention:

1. **The home** is the synthesis home of [prototypes/home-directions/](../home-directions/)
   ([#519](https://github.com/alp82/curia/issues/519)), simplified for a phone: the ring of what
   needs you, the agents that run, and one progress bar per map. The log tail and the token
   readouts are gone, which is what "simplified" came down to.
2. **The map** is the stops line of [prototypes/frontier-visual/](../frontier-visual/)
   ([#588](https://github.com/alp82/curia/issues/588)), decided over six rounds: the walked stop,
   the running row, the frontier rule, then the blocked in their **red-lined box** and the fog on
   its **diagonal grey stripes**. Those two treatments are the ones the operator named, lifted
   value for value.

**The numbers are still real, and there are more of them now.** The home carries the three open
maps of this repo: Build the Atlas operator experience at 8/42, Model credentials and
provider-account failures at 16/19, and Ship the story landing page at 10/16 +2. The map screen
shows the frontier as it really stands, which is empty: the one unblocked ticket is the one being
worked, so the scene says "nothing takeable. the way is in flight", which is the empty-frontier
line #588 decided.

**The two screens live once.** Composition 1 holds them both, and the script clones them into the
other four, the way the preview scene fills its workstation from one pool. So the page still reads
whole with no script at all.

The five variations are how the two screens are put together:

| id | composition | what the reader sees |
|----|-------------|----------------------|
| 1 | stack | the home whole, a drill line, then the map under it |
| 2 | drill | one frame. The map slides up over the home as the scene arrives |
| 3 | pair | two cards in depth, the map standing in front of the home |
| 4 | focus | the map leads at full size, and the home is the inset it came from |
| 5 | ribbon | the home shrinks to one status line, and the map takes the room |

**Ten build checks** ran against the file: five numbered compositions with a bar button each, both
screens present and living once with a slot in every other composition, the home carrying the ring
and the agents and one bar per open map, the map carrying the stops line with the red-lined box and
the striped strip, the counts matching the tracker snapshot and summing to the map's sixteen
tickets, five layouts that each style themselves, every class styled and every hook in the markup,
composition 1 reading with no script, the build rules, and balanced markup. Each was validated by
breaking the file on purpose first, and every break produced exactly the failure it should.

**One fault the checks caught.** Composition 1 had a single layout rule of its own, which the
distinctness check called out. That was fair: stacking two screens is not a composition until it
says how they meet. It has the drill line between them now.

**One fault reading caught.** The drill overlay was absolutely placed against a frame the home
sized, so a map taller than the home would have been clipped by it. Both screens share one grid
cell now, so the frame is as tall as the taller of the two.

**The operator's answer.** Rejected, with a screenshot:

> looks completely broken. move the title to the center and move the slightly tilted dashboard
> screens left and right, both facing the title
>
> 5 variations like this and you can experiment with layout, etc.

The screenshot showed the fault plainly, and it is the SAME fault the preview scene hit at #627
round 3. At desktop width the claim sat in a centered `.wrap` on the left while the panel leaned
right inside a `.shot`, so the title stood alone with a screen of dead space beside it, and the
panel ran off the fold as one endless list. Round 2 read fine on a phone and fell apart on a
desktop, because nothing in the scene placed the claim and the evidence against each other.

**Round 3.** The repair is the one #627 already proved, and the composition is the one the
operator drew.

**The scene is one composition canvas.** The `.wrap` and the `.shot` are gone from it. The claim
and both screens are grid items of `.at`, placed for a phone and placed again past 60rem. On a
wide screen the grid is three columns, `hm claim mp`, so the title stands between the screens
rather than beside a gap.

**The claim is centered, and the screens face it.** `rotateY` turns a screen's normal toward the
side it is rotated to, so the home takes a positive angle and the map a negative one, and both
faces point at the title. A build check asserts those signs, because getting one backwards would
turn a screen away from the claim and nobody here can see it.

**A screen is a screen now.** Each one is a bounded card with its own header strip that clips what
runs past its bottom edge. Round 2 let the panel grow for ever, which is what made it run off the
fold.

The five compositions on `?id=1..5`, all of them centered claim, both screens tilted toward it:

| id | composition | what the reader sees |
|----|-------------|----------------------|
| 1 | flank | the plain reading. Same size, same tilt, level with the claim between them |
| 2 | stagger | depth rather than symmetry: the map larger and lower, the home smaller and higher |
| 3 | converge | a harder perspective, the screens turned well in, the claim in the pocket they leave |
| 4 | rise | two tall walls running past the claim top and bottom, cut by the section edges |
| 5 | desk | both screens lie back on one baseline, the way two monitors sit on a desk |

**Eleven build checks** ran against the file: the canvas holding all three items with no `.wrap`
and no `.shot`, the claim centered and every tilt facing it and staying slight, five compositions
that each lay the canvas out and differ in their declarations rather than only in their number,
the screens bounded and headed, the home carrying the #519 ring and agents and one bar per open
map, the map carrying the #588 stops line with the red-lined box and the striped strip, the counts
matching the tracker snapshot, every class styled and every hook present, the page reading with no
script and with reduced motion, the build rules, and balanced markup. Each was validated by
breaking the file on purpose first.

**Two faults the validation caught in the checks themselves**, which is the lesson this file keeps
relearning. A distinctness check compared whole CSS rules, so two compositions with different
selectors always looked different even when their declarations were identical. It compares the
declarations now. And a break that was meant to prove the `.wrap` check landed in a different
scene, so the check had never actually been shown a failure. Both were fixed and then proved.

**One fault reading caught.** The screens come in on opacity, so they read a class the scene wears
rather than the reveal's own. With reduced motion the observers never attach, so the screens would
have stayed invisible. The fail-open path sets that class too now, and a reduced-motion rule shows
them outright.

**The operator's answer.** The composition is settled, and nothing else is open:

> 1 - i have nothing to complain

## The terminal scene ([#629](https://github.com/alp82/curia/issues/629))

Scene 7 — the harness, live. The operator's note at #551 round 2, verbatim:

> the claude code and codex tui's look not like their original counterparts at all. they should
> be really realistic

**What the rebuild rests on.** This repo already holds verbatim tmux captures of both TUIs, taken
by earlier probes, so nothing here is drawn from memory:

| what | where | what it gives |
|------|-------|---------------|
| Claude Code v2.1.220 | [prototypes/overseer-pane/evidence/](../overseer-pane/evidence/) and [prototypes/pane-rewind/evidence/](../pane-rewind/evidence/) | the banner, the ❯ turn, the ● tool row, the ⎿ result row, the ✻ elapsed line, the two composer rules, the ⏵⏵ mode footer |
| Codex 0.146.0 | [prototypes/pane-rewind/evidence/codex-\*.txt](../pane-rewind/evidence/) | the rounded banner box, the Tip block, the › turn, the • Ran row with its └ output, the full-width separators around an answer, the `<model> <effort> · <cwd>` footer |
| the terminal chrome | [prototypes/embedded-terminal/](../embedded-terminal/) (#537) | the window, the tmux status bar |

**A terminal is a character grid, and that is what the old pane got wrong.** The panes are
authored at exactly 58 columns, and the script measures a 58ch ruler against the live frame and
scales the font until 58 columns fill it. So the Codex banner box, the Claude composer rules and
every ─ separator end on the same column at every width. Line height is exactly 1, because a
browser draws │ at the glyph height and any leading opens a gap a real terminal does not have.
Each pane is a scrollback and a composer, the way both TUIs are built: the transcript sits at the
bottom of the pane and the input row never moves.

**The records are real** ([#601](https://github.com/alp82/curia/issues/601)). The Claude Code pane
is this ticket's own session. `config/routing.yaml` routes a prototype ticket to `opus` on the
claude harness, which is why the banner says Opus 5 and the footer says bypass permissions. The
Codex pane is [#579](https://github.com/alp82/curia/issues/579), a research ticket, which the same
file sends to `gpt-5.6-sol` at high effort on the codex harness. Its numbers are the measured ones
in [docs/research/codex-deferred-curia-tools.md](../../docs/research/codex-deferred-curia-tools.md).
Both `Read 24 lines` rows are the true line counts of the two captures they name.

**The one thing a capture cannot record is color.** Every capture in this repo is plain text, so
the structure is lifted and the hues are chosen: Claude Code carries a warm clay accent on its
mark, its elapsed line and its permission mode, and Codex is almost monochrome. Round 1 asks the
operator to judge that by eye, because nothing here can.

**Round 1.** Five compositions on `?id=1..5`, differing in the chrome around the pane and in how
the two harnesses are reached, not in ornament: 1 tab (a browser window over the tailnet URL, tmux
windows switch), 2 split (one tmux, both harnesses at once), 3 full (edge to edge, the status bar
the only chrome), 4 rail (curia's own frame, a harness rail beside the pane), 5 type (the session
prints as you watch, then hands to codex). Four questions went with them: the composition, whether
the TUIs read as real, whether 58 columns is the right density on a phone, and whether the winner
should print itself.

**The operator's answer to round 1**, verbatim:

> let's try the rail and fallback to the bottom tabs on mobile. never both
>
> the type variation is good in theory but looks not very nice, too fast, hard to follow. make more
> variations that try different distinct unique things style, motion and layout wise

Two things settled with that reply, and they hold for every later round:

1. **The control is the rail past 60rem and bottom tabs below it, and never both.** So the tmux
   status bar went back to being what a real one is: text that states the current window, not a
   button. Exactly one control is on screen at any width, and a build check asserts it.
2. **The printing stays, and it slows down.** Round 1 printed a line every 52ms and looped. Nothing
   prints faster than a line every 180ms now, and the run happens ONCE. Scrolling back used to
   restart the session under the reader, which is part of what made it hard to follow.

**Round 2.** Five compositions over that settled control, each reaching the reading a different
way in style, motion and layout: 1 step (curia's quiet frame, the session arriving a block at a
time so a tool call and its result land together), 2 crawl (edge to edge under a vignette, prose
typing character by character while tool rows land whole), 3 desk (the pane tilted under a stage
light, with the SCROLL lighting the session so the reader sets the pace and can hold anywhere),
4 cut (a hard diagonal stage cut, the pane wiping in from the scene side and then printing block
by block), 5 relay (the browser tab the claim names, claude printing, the tmux window flipping,
codex carrying on).

**The typing takes no per-character spans.** A line is clipped to a whole number of `ch`, and on a
monospace grid 1ch IS one column, so the clip lands between characters exactly. The Discord scene
split text into one span per character at [#626](https://github.com/alp82/curia/issues/626), and
the whitespace between two elements became a flex item that cost about 250px of dead air. Clipping
cannot repeat that fault, because it adds no nodes at all.

**Two questions came back unanswered**, so they ride into round 3: whether the two TUIs read as
their real counterparts now, and whether 58 columns is the right density on a phone.

**The operator's answer to round 2**, verbatim:

> 5 is good
>
> the terminal should have only one tab at the top
> the statusline should stay but without the tabs
> the sidebar should have the harness logos
> add pi and opencode as well

**The composition is settled: 5 relay.** The browser tab the claim names, and the session printing
once, slowly, then handing over. The four corrections are in.

**Round 3.** The corrections applied, and the variations narrowed to the one thing the answer
opened: how the rail carries four harnesses and their marks. Five treatments ride `?id=1..5` —
1 tile (a filled tile behind each mark), 2 glyph (no tile, a large bare mark, a bar on the active
row), 3 grid (two by two cards, the mark over the name), 4 strip (a dense list, the mark inline,
the active row filled), 5 badge (the mark on a ring, the rail reading as a device list). This is a
narrower round than the default five vastly distinct variations, and the reason is the answer
itself: the operator picked a composition and gave four corrections, so offering five new
compositions would throw their pick away. The same shape #626 round 6 took.

**Two harnesses more, and the panes stay real.** The pi and opencode panes are the same kind of
thing as the other two: verbatim TUI chrome from this repo's own captures, in
[prototypes/model-switch/evidence/](../model-switch/evidence/) (#561). pi carries its version and
key-hint header, its plain turn lines, its two composer rules and its two-row footer with the
context percentage. opencode carries its block wordmark, the `┃` gutter on a turn, the `▣` row
that closes one, the `╹▀` rule under the composer and its two-column footer.

**But they are real in a different way, and the rail says so rather than hiding it.**
`config/routing.yaml` ships two harnesses, so curia dispatches to claude and codex only. The
claude pane is a real curia dispatch and so is the codex pane. The pi and opencode panes are the
**model-switch probe** of [#561](https://github.com/alp82/curia/issues/561), which is the only real
thing this repo has ever run on either. Their rail rows read `probe #561` where the other two read
a model and a ticket, and a build check asserts exactly two of the four say so.
[#604](https://github.com/alp82/curia/issues/604) already holds the four-harness fact line until
the code lands. It now holds this rail with it.

**The relay stays two harnesses wide.** claude prints, holds, and hands to codex. Running all four
in sequence takes past twenty seconds, and round 2's note was that the motion was hard to follow.
pi and opencode stand ready on the rail instead.

**The four marks are drawn, and none of them is that project's official logo.** The page ships no
image and no webfont ([build.md](../../docs/landing-page/build.md)), so a mark here is drawn in
inline SVG or it is not there at all. Each one is built from something the harness itself prints:
Claude Code's burst, Codex's `>_` prompt, the letterform of pi's wordmark, and the solid and broken
bars of opencode's block wordmark. Whether the page should carry the real logos instead is a
question for the operator, and it carries a licensing decision this ticket cannot make.

**154 build checks** now run against the file, and all 34 breaks that validate them land. The new
ones cover the four corrections, the four harnesses in the rail, the tabs and the panes, the marks
being drawn inline rather than fetched, and the two probe rows.

**The operator's answer to round 3**, verbatim:

> title is best
>
> no layout shift, the windows should have fixed height. no scrolling

**The rail is the tile.** Read as `tile`, treatment 1, which is one character away and was the
recommendation. The four that lost and the switcher that carried them left the file with this
round, the way the identity switcher did at #624. A build check refuses a `.tm.c` selector or an
`.idsw` rule now.

**The window is a fixed 30 rows**, at every harness and every width. This was a real fault and no
check had looked for it: the pane took its height from its own content, so switching from the
30-row claude pane to the 23-row pi pane shortened the window and moved everything under it. The
height is now the tallest pane's row count times the line box, plus the padding. Line height is
exactly 1, so one row is `1em`, which makes the height the row count and nothing else. A shorter
transcript sits at the bottom against its composer with blank rows above, which is what a real
full-screen TUI shows.

**Nothing scrolls, and nothing moves on load.** The font size drives the height, so it has to be
settled before the first paint, and `fit()` runs synchronously at setup for exactly that reason.
The page ships no webfont, so nothing reflows afterwards. Five checks hold this shape: the height
is a fixed row count, no `min-height` can grow it, every pane fits it, the count is the tallest
pane with no dead rows, and the fit is not deferred past the first paint.

**The operator's answer to round 4**, verbatim, with a screenshot:

> italic causes issues and opencode logo is cut off

**Every pane was italic, and one mistake caused both faults.** The colored runs were `<i>`
elements, and a browser slants `<i>` by default. An oblique face does not sit on the character grid
this whole scene rests on: the columns drift against the 58-column ruler, and the last glyph of a
run overhangs its advance and is clipped by the pane. The runs are `<span>` now, the generator
emits `<span>`, and a guard rule plus two checks refuse italic inside a pane.

**The lesson is the one this file keeps relearning, from a new direction.** 153 checks were green.
Not one of them could see the difference between a roman face and an oblique one, because every
check reads the source and no agent here has eyes. The check that would have caught it is the one
that asks what the markup MEANS rather than what it says: `<i>` is not a neutral wrapper, and a
scene built on a character grid cannot use it. The operator's screenshot was the only instrument
that could find this.

**The operator's answer to round 5**, verbatim, with a screenshot:

> good. logo is still cut off though
>
> then make variations for the actual content of the session. each of them working on something
> regarding the typeface project shown above in section 04

**The block art is drawn now, not set.** The italic was only half of it. The Claude Code mark and
the opencode wordmark are rows of `█ ▀ ▛ ▝`, and a browser draws those glyphs at the FONT's
metrics rather than at the line box. Two rows of them do not tile at line height 1: the halves
detach, and the mark reads as cut in two. Each ROW is one SVG of the same rectangles now, one `em`
tall and as many `ch` wide as it has cells, so rows stay rows, the halves meet, and the character
grid is unchanged. The quadrant map covers all fourteen block characters, so any block art this
scene ever carries is drawn the same way.

**The session is the type foundry of scene 4.** GRAVITY was locked at
[#627](https://github.com/alp82/curia/issues/627) — "A typeface with weight. Nine weights, two
widths, and one axis for the space between." Every session here is an agent working on that site,
so the preview scene and the terminal scene tell one story instead of two.

**That makes these transcripts invented, and it is the SECOND instance of one deviation, not a new
one.** [#601](https://github.com/alp82/curia/issues/601) rules every scene shows real records.
#627 already broke that for the same reason, on the operator's instruction, when they asked for a
site cooler than a real curia prototype. Extending that site into scene 7 extends the same
deviation. [#604](https://github.com/alp82/curia/issues/604) carries both. Nothing in the scene
claims to be a curia record any more: the rail rows state a model or a version and no ticket, the
working directory is `~/gravity`, and a build check refuses a `#nnn` in the rail or a curia ticket
number in a pane.

**What the checks can still hold**, now that the content is invented, is that the two scenes agree.
Scene 4's locked line and scene 7's sessions are compared against each other: nine weights, two
widths, one spacing axis, and all nine weight names in order.

**Round 6.** Five sessions on `?id=1..5`, each an agent doing a different job on GRAVITY: 1 the
specimen (all nine weights at four sizes), 2 the axes (wght, wdth and the spacing axis on one
tester), 3 the trial (the download and its licence gate), 4 the waterfall (twelve sizes down the
fonts page), 5 the payload (subsetting the font to Latin). Each one carries all four harnesses, so
switching the rail never leaves the project.

**The window is 26 rows now**, down from 30, because the tallest pane across all five sessions is
26. The check that refuses dead rows is what moved it.

**A weakness the break rig caught, which is the reason it exists.** Every TUI-marker check asked
whether a string appeared ANYWHERE in the scene. With one session that is the same question as
"does this pane have it". With five it is not: breaking one session's footer left four intact and
the check stayed green. The markers are asserted per pane now, over all twenty, and so is the rule
that no TUI borrows another one's chrome. **A check that was right for one instance can be wrong
for five, and only a break that lands in one instance can tell you.**

**The operator's answer to round 6**, verbatim, with a screenshot marking the wordmark in red:

> 1. 4 waterfall
> 2. the marked red rect shows that the problem still persists. upper half of the opencode logo is
>    missing. if you were fixing the icon in the sidebar panel, that was never broken
> 3. y

**The session is the waterfall.** Twelve sizes down the fonts page, from 96px. The four that lost
and the switcher that carried them left the file with this round. The invented transcripts stand,
answered `y`.

**The opencode wordmark is gone, and refusing to draw it is the point.** Two rounds tried to fix
the rendering. The rendering was never the fault. **This repo's capture of that banner is
incomplete.** `prototypes/model-switch/evidence/opencode-1-spawn.txt` caught the pane mid-scroll:
its first line is already the SECOND row of the mark, so the top row was never captured. Both
earlier fixes were real (the italic slanted the grid, the block glyphs did not tile) and neither
could put back a row that is not in the evidence.

**And the missing row cannot be derived.** On the two rows this repo does have, three of the eight
letters are identical, character for character:

| letter | captured row 1 | captured row 2 |
|--------|----------------|----------------|
| d | `█  █` | `▀▀▀▀` |
| n | `█  █` | `▀▀▀▀` |
| o | `█  █` | `▀▀▀▀` |

So the missing row is the only thing that tells `d`, `n` and `o` apart. Writing it would not be
reconstruction, it would be inventing another project's wordmark and inventing the difference
between three of its letters. The pane starts below the banner instead, which is exactly what the
capture itself shows: a session already underway. A build check refuses a wordmark in that pane,
and the file records why.

**The lesson, and it is a new one for this file.** Every check here reads the source, and the
source was faithful to the evidence at every round. The evidence was the thing that was wrong. **A
check can only hold a file to its sources, never a source to the truth**, and no amount of
checking finds a capture that is missing a row. The operator's eyes were the only instrument that
could, and it took a red rectangle to say which half.

**The rail marks were never broken**, which the operator also said. They are drawn shapes, not
captured ones, so they were never exposed to this fault.

**The operator's answer to round 7**, verbatim, with a screenshot:

> 1. i want to see the whole mark - not remove it
> 2. yes but the opencode harness looks also broken because the cursor is inside the text and
>    tehre is a scrollbar of some sort

**Two faults in the opencode composer, both from the same slip: a dropped row.**

- **The cursor sat inside the text.** The real composer is FOUR `┃` rows: the input row, then a
  BLANK one, then the mode row. This file had three. Losing the blank row put the cursor hard
  against `Build · gpt-5.6-sol · gravity`, which is what the operator read as the cursor being
  inside it.
- **The border read as a scrollbar.** The `╹▀▀▀…` under the composer was a run of `▀` glyphs, and
  a browser drew it as a light bar the width of the pane, sitting over the line above. It is drawn
  as one rectangle now, on its own row, in a much dimmer colour.

**The whole mark is still not in this repo, and the operator wants it.** Every file was searched,
not only the evidence directories: `prototypes/model-switch/evidence/opencode-1-spawn.txt` holds
the only copy, and it is the incomplete one. Nothing else in the repository carries that banner.
Round 8 asks the operator for a fresh capture of the opencode start screen, because that is the
one thing this session cannot get for itself, and the alternative is inventing three letters of
another project's wordmark.

**Round 8's answer was two screenshots of a live opencode**, and one of them corrected a line
nobody had questioned.

**The composer mode line names the PROVIDER, not the directory.** The repo capture reads
`Build · standin-1 stand-in` and the operator's live screenshot reads `Build · GPT-5.6 Luna
OpenAI`. Both are `Build · <model> <provider>`, so `stand-in` was never a suffix on the model name.
This file had been reading it as one and putting the project directory in that slot. It reads
`Build · gpt-5.6-sol OpenAI` now. **Two captures of the same line, taken a year apart on different
models, are what made the shape legible** — one alone leaves `standin-1 stand-in` looking like a
single name.

**The wordmark still needs its text.** The screenshot shows the whole mark, and reading it means
transcribing 39 cells by eye across three rows. The three letters that matter are exactly the ones
a wrong reading would invent: `d`, `n` and `o` are identical on both rows this repo holds, so the
row being transcribed is the only thing that separates them. Round 9 asks for the banner as text
rather than as pixels, which settles it in one paste.

**The operator's answer to round 9**, verbatim:

> maybe you can copy it from here? https://opencode.ai/brand
>
> web search subagent could help finding what you need

**The wordmark came from opencode's own source, and it settled everything.** The brand page carries
only PNG and SVG assets, so the block art is not there. The TUI renders it from
[`packages/tui/src/logo.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/logo.ts),
and [`packages/tui/src/component/logo.tsx`](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/logo.tsx)
says how it is coloured. Both were read with `gh`.

**The mark is FOUR rows, and this repo's capture held two.** That is why `d`, `n` and `o` looked
identical: rows 0 and 1 are the only things that separate them. Row 0 carries a single `▄`, the
ascender of the `d`. Row 1 is where `n` ends in `▄` rather than `█`.

**And no text capture could ever have held it, because half the mark is background colour.**
`logo.tsx` renders four characters against a `shadow` that is a 25 per cent tint of the foreground
toward the background:

| in the source | what it draws |
|---------------|---------------|
| `_` | a SPACE whose BACKGROUND is the shadow, so a whole filled cell |
| `^` | `▀` in the foreground, over a shadow background |
| `~` | `▀` drawn in the shadow colour |
| `,` | `▄` drawn in the shadow colour |

So `_` is not empty. It is a cell of colour that `tmux capture-pane` writes out as a blank, because
a text capture records characters and this mark keeps half of itself in the colour behind them.
`left` is "open" in the muted colour and `right` is "code" in the plain one, bold, which is the
two-tone the operator's screenshot shows. All four shades are drawn here as rectangles.

**This is the lesson of the whole ticket, and it took nine rounds to reach.** Rounds 5, 6 and 7
each fixed a real fault in the rendering — the italic, the tiling, the removal — and not one of
them could have produced a correct mark, because the input was wrong in two ways at once: it was
missing two rows, and it was missing the colour that carries half the letterform. **A capture is a
lossy record of a rendered thing, and the generator that made it is the only complete source.**
Every other pane on this page is still built from captures, and that is fine, because nothing else
in them depends on a background colour. Where it does, go to the source.

**The scene is one composition canvas.** The claim, the terminal and the fact line are grid items
of `.tm`. The old scene 7 held the claim in a centred `.wrap` and the pane in a `.shot`, which is
the pair that broke the preview scene at [#627](https://github.com/alp82/curia/issues/627) round 3
and the atlas at [#628](https://github.com/alp82/curia/issues/628) round 2, at a desktop width no
agent here can see.

**Eighteen build checks** run against the file, and every one was shown a real failure first. They
cover the canvas, the identity frame, the locked words, the character grid, the TUI markers, the
real records, the distinctness of the five compositions, the classes and hooks, the no-script and
reduced-motion paths, the build rules and balanced markup.

**Two of the eighteen were wrong before they were right**, which is the lesson this file keeps
relearning:

- **A break landed in the wrong scene.** The mutation meant to prove the `.wrap` check inserted a
  `.wrap` at the first `<header class="claim rv">` in the whole file, which belongs to an earlier
  scene. The check stayed green and proved nothing. This is the same fault #628 recorded, repeated
  by the same shortcut. The break targets scene 7 by its own hook now.
- **The distinctness check compared the wrong scope.** It gathered every declaration a composition
  contributes, including the ones inside the desktop media query. A composition copied wholesale
  still looked different, because its media-query rules survived the copy. It compares the base
  scope now, which is where a composition states what it is.

**One layout fault found by reading, not by a check.** The scrollback was a column flex box, which
made the transcript sit at the bottom. Composition 5 wraps every line in its own span so it can
print them one at a time, and in a flex box each of those spans becomes a flex item, with the
newline between two of them taking a row of its own. The pane is a block box now, pushed down with
`margin-top: auto`, which holds the same alignment and leaves the spans inline.

**The cutover check still stands.** The fact line names four harnesses and `config/routing.yaml`
ships `claude` and `codex` today, so [#604](https://github.com/alp82/curia/issues/604) must hold
that line until the code lands. A build check asserts the file still ships two, and it goes red on
the day it ships four, which is the day the line is safe.

## The ticket run scene ([#630](https://github.com/alp82/curia/issues/630))

Scene 8 — one ticket on GitHub, the "You are in charge" beat. The operator's note at #551 round 2,
verbatim:

> you are in charge horinzontal scroll hijacking is bad. the horizontal jouney might not work at
> all, we need a better solution here. the tickets look really bad, also they mix github and
> discord info/controls

Three faults, and each one gets a rule rather than a touch-up.

**1. The hijack is gone, and nothing replaces it.** The old scene grew to `300vh`, pinned a strip
and read the page scroll to walk that strip sideways. That code and that height are out of the
file. No composition offered here moves anything sideways under the reader's finger, and the
`walk()` loop that did it is deleted rather than disabled.

**2. One card carries one surface.** A GitHub card is a fragment of the GitHub page in GitHub's own
dark palette and its own shapes: the state pill, the octicons, the commit list with real SHAs, the
diffstat, and a label chip in the real hex of this repo's `wayfinder:prototype` label, `#fbca04`. A
Discord card is a fragment of a thread in the token set the operator picked at
[#626](https://github.com/alp82/curia/issues/626) round 4: the avatar, the name with its APP badge,
the component row. A build check reads every card in the scene and refuses GitHub chrome inside a
Discord card or the reverse.

**3. The gate is a Discord card.** That is the mixing fault at its source: the old gate was a
GitHub-chromed box carrying Discord buttons. It is now the shape `bridge.mjs` really sends for the
review kind — the `**[esc-4]** \`curia-587\` asks for review:` head from `#escalationBody`, curia's
own `Is alp82/curia#587 done?` question and the blocks under it from `reviewGateText`
(`lifecycle.mjs:429`), the two small-print lines verbatim, and three buttons. **Reject is RED**:
`bridge.mjs:1172` builds it with `ButtonStyle.Danger`, and the old card had it grey.

**The run is real** ([#601](https://github.com/alp82/curia/issues/601)). Every value in the six
events is read off the tracker: ticket #587 opened Aug 21 2026 with the `wayfinder:prototype`
label, `config/routing.yaml` routing a prototype ticket to `opus` on the claude harness, the five
commit SHAs and headlines on pull request #597, the branch `curia/587`, `3 files changed +757 −0`,
the merge commit `a71e154`, and the first line of the real resolution comment. The thread glyph
changes through the run the way `bridge.mjs` really changes it — 🎫 running, 🔎 holding a review
gate open (`STATE_GLYPHS`, `bridge.mjs:96`).

**Two invented values, and they are the only ones.** The two Discord timestamps. The tracker
records when the ticket was opened (15:08 UTC) and when the first push landed (18:55 UTC), so the
dispatch happened between them and nothing records the minute. The card says 18:41. The gate says
21:10, against a merge at 19:13 UTC. Both are clock faces on a card that has to carry one.

**Round 1.** Five readings of the same six events on `?id=1..5`. Four are vertical. The fifth keeps
the horizontal reading but hands the control to the reader, because the operator left the journey
itself on the table and the honest way to settle it is to show one that does not hijack:

1. **timeline** — one spine down the page, GitHub's own issue-timeline shape, every card hanging
   off its node with a surface tag above it.
2. **lanes** — the split IS the layout. Past 62rem GitHub runs down one lane and Discord down the
   other, with a hop crossing the spine wherever one surface moved the other. Below that width it
   is one column with a lane-coloured edge on every card.
3. **devices** — one surface per SCREEN. A browser window holds the GitHub page and only that, a
   phone holds the thread and only that, so the two can never be read as one control surface.
4. **deal** — no journey and no travel: the run is a paper trail, six documents dropped one on the
   next, tabbed and slightly turned. Two kinds of paper, so the split is what the eye sorts first.
5. **steps** — the horizontal reading survives as a step bar. One card at a time, advancing every
   3.6 seconds while the scene is on screen, a tap takes it over, and the cycle returns ten seconds
   later — the shape [#627](https://github.com/alp82/curia/issues/627) settled for the preview
   round. Nothing here touches the page scroll.

**The five are four layouts over ONE set of cards, plus one composition of its own.** That is
deliberate. The operator is judging the reading, not the evidence, so the same six cards go into
every layout and only the arrangement changes. Compositions 1, 2, 4 and 5 are `as-timeline`,
`as-lanes`, `as-deal` and `as-steps` over `#runset`. Composition 3 needs a browser and a phone, so
it is its own markup.

**The step slot is measured to the tallest card.** A stepper that resizes on each advance moves the
caption under it, which is the same fault as taking the scroll, in miniature.

**The press is the true thing curia does.** The Approve button swells in place, and then curia
edits the card and clears its components, so the button row collapses away and the receipt comes up
as small print with an `(edited)` mark. That is the behaviour [#626](https://github.com/alp82/curia/issues/626)
round 5 locked for scene 4, and this scene reuses it rather than inventing a second press.

**Two marks are drawn**, because the page ships no image and no webfont: GitHub's mark and
Discord's. Neither is fetched, and both are single paths. The six octicons are drawn from their
shapes, not from a capture. #629's lesson applies in the other direction here — there is no capture
of a GitHub page in this repo, so **round 1 asks the operator to judge the GitHub chrome by eye**,
the way #629 round 1 asked them to judge terminal colour.

**The devices composition does not press.** Its gate is a still, because a press on a screen inside
a screen competes with the caption under it. If the operator picks it, the press comes back in the
next round.

**86 build checks** ran against round 1, and all **36 breaks** that validate them landed. Three were
wrong before they were right, and each repeats a fault this file has already recorded once:

- **A check asked whether a value appears in the SCENE, not in a CARD.** The Reject button, curia's
  own question and the diffstat each appear twice. Breaking one of the two left every check green.
  They run per button and per card now. Same fault #629 recorded about its TUI-marker checks.
- **A mutation landed in a comment.** The break meant to prove the thread-glyph check hit the
  `🎫 587 · prototype` in the scene's own HTML comment, not the one in the card. The value checks
  read the markup with comments stripped now, and every mutation is confined to the spans scene 8
  owns.
- **The distinctness check compared prose, not rules.** A CSS comment sits in front of a selector,
  so the parser carried the paragraph each layout was documented with into its selector text. Two
  identical layouts read as different. It strips comments first now.

**Five faults found by reading the spliced result**, none of which a check could have named:

| what it was | why |
|-------------|-----|
| the deal pile hid the last row of every card | a tab is 1.35rem tall and sits ABOVE its own card, so tab plus pull is what covers the one below |
| the step slot could only grow | the active card carried the measured height as a `min-height`, so measuring without clearing it first ratchets upward for ever |
| the devices phone sat on the merge and close rows | the two screens overlapped, and the payoff of the scene was under the phone |
| every gate link pointed back at the scene | `href="#run"` on all six, so tapping the pull request landed where you already were |
| the old gate's lookalike buttons were still there | `.d-btn` and `.d-receipt` resembled Discord's shapes. The gate wears the real ones now |

**The operator's answer to round 1**, verbatim:

> Deals is a nice start
>
> The vertical telling is nice. I think while we scroll through the series of screens that should
> all look either like discord or a phone or the browser, there is one constant element on the
> screen that evolves but stays on place. The ticket

Three things settled with that reply, and they hold for every later round:

1. **The telling is vertical**, and the horizontal journey is off the table for good.
2. **Every beat is a DEVICE**, never a bare card: the Discord client, a browser, or a phone.
3. **The scene has a protagonist, and it is the ticket.** One element stays in place and evolves
   while the screens pass it.

Three of round 1's five left the file with that answer. The deal set stays, reachable at `?id=0`,
because it is what the operator called a nice start and round 2's desk is built on it.

**Round 2.** The constant ticket, and four screens that pass it.

**The ticket is the one thing here that wears NEITHER product's chrome.** It is curia's own object,
drawn in this page's identity, which is what lets it stand against a GitHub screen and a Discord
screen without reading as either. It carries no control of either product, so the
one-card-one-surface rule of round 1 still holds, and a build check asserts it.

**It walks the four stages this whole page is coloured by** ([#624](https://github.com/alp82/curia/issues/624)).
Five stages, one per beat, and the section carries the stage as `data-k`, so the state word, the
evolving line, the five-stop track and the pill's colour are all CSS off one attribute:

| stage | the ticket says | the screen |
|-------|-----------------|------------|
| 0 take | Open · opened by you on Aug 21, 2026 | the ticket, alone |
| 1 agent | running · dispatched to curia-587 on claude-opus-5 | Discord, the client's own window |
| 2 agent | running · pull request #597, 5 commits, +757 | the browser |
| 3 gate | in review · waiting on you | a phone, and the press |
| 4 merged | Merged · #597 merged, #587 closed as completed | the browser |

**The gate is on a phone**, which is the one placement this page has to earn: scene 8's claim is
"You are in charge", and the whole promise is that you answer from the couch. The four screens are
Discord, the browser, the phone, the browser.

**Five compositions ride `?id=1..5`**, differing in where the constant sits and how the screens
pass it. Two of them hold a screen-tall stage, and three let the page scroll the way it always
does:

1. **pin** (flow) — the ticket sticks at the top of the scene, the screens scroll under it. Nothing
   is pinned but the ticket.
2. **stage** (held) — one screen-tall stage. The ticket sits at the top and the screens cross-fade
   in the space below, so the constant never moves at all.
3. **rail** (flow) — the constant is a rail, not a card: one thin status line on a phone, and a
   full side rail past 60rem, with the screens running past it.
4. **desk** (held) — round 1's pile, with the constant under it. The ticket is a paper docket on
   the desk and the screens are dealt above it, each staying in the pile as the next lands. The
   state is a rubber stamp on that paper.
5. **ghost** (flow) — the constant is behind everything at poster size, and the screens scroll over
   it. The ticket takes no room in the flow, so nothing moves the screens off their column.

**Nothing here takes the scroll.** A held stage is a sticky element the page scrolls past, which is
what scenes 1 to 3 and scene 4 already do, and it is what the operator asked for. A build check
asserts the scene's script binds no `wheel` or `touchmove` listener, calls no `scrollTo`, and calls
`preventDefault` nowhere.

**Two more faults found by reading**, neither of which a check had named:

- **The rail stopped sticking.** `align-items: start` on the two-column grid shrinks each item to
  its own content, and a sticky item can only travel inside its own box. The rail would have come
  unstuck the moment the screens beside it grew taller than it, which is always.
- **The constant reached into GitHub's stylesheet** for its label chip. It keeps the label's real
  hex, which is a fact about the ticket rather than chrome borrowed for decoration, under a class of
  its own now. The rule holds with no exception, and the check reads it as any `gx-` or `dc-` class
  inside the ticket.

**108 build checks** run against the file and all **44 breaks** that validate them land. Two of the
checks were wrong before they were right:

- **The distinctness check accepted a stray rule as a difference.** A composition copied wholesale,
  with one leftover declaration from the block it replaced, is the same composition wearing a second
  name. It needs three declarations of difference now.
- **A fail-open rule matched nothing.** `.still .v-ghost .tkt-in` reads as a descendant, and both
  classes sit on the SAME element, the section. With reduced motion the ghost kept its 24vh offset
  and no stage under it to hold. It is `.still.v-ghost` now. The distinctness break is what exposed
  it: the rule showed up as the ghost's one asymmetric declaration.

**The operator's answer to round 2**, verbatim:

> desk is the new baseline
>
> problems: i have to scroll quite a long time before i see something at the bottom, it should
> appear right away. then we should have boxes like the section titles in the beginning of the page
> that scroll normally and narrate each step with simple words
>
> 5 new distinct variations based on this

**The desk is the baseline**, and two faults come with it.

**Fault 1: the long lead-in.** Round 2's desk grew the section to `430svh` and spent its first slot
on the ticket alone, so the reader travelled about a screen before anything arrived. The answer is
not a shorter track. **Nothing in this scene is held any more.** The section is its own height, the
whole column scrolls normally, and the first narration box and the first screen sit right under the
claim. A build check refuses a height on the track and refuses a sticky full-height stage.

**Fault 2: no narration.** Every step now carries a box built from the identity frame's own parts
(#624): the numbered mono kicker, then the line. They scroll normally and they never pin.

**The four lines are new words**, and that is the second time this file has authored copy
[#587](https://github.com/alp82/curia/issues/587) did not lock. The first was the five condensed
setup steps, which #587 left open. These four exist because the operator asked for them at round 3:

| box | the line |
|-----|----------|
| 01 | You send it to an agent from Discord. |
| 02 | The agent works and opens a pull request. |
| 03 | It asks you before anything merges. |
| 04 | You approve. It merges and closes the ticket. |

A build check holds them to simple words: at most twelve words, no semicolon, no em-dash.

**The constant still stays put, and now it does it without holding the page.** The docket is the
LAST thing in the column and it sticks to the BOTTOM of the viewport. That ordering is what pins it:
a bottom-sticky element whose own place is below the fold is pinned from the start, and it settles
onto the desk when the column ends. A check asserts the order, because a docket moved to the head of
the column would look identical in the source and never pin at all.

**Round 3.** Five compositions on `?id=1..5`, all on the desk baseline, differing in what the
narration box IS and how it meets its screen:

1. **step** — the plainest reading. A hairline down the box, the screens standing well apart, the
   docket an ordinary card at the near edge. No pile, no slab, no paper.
2. **slab** — the box is a solid stage-coloured slab that bleeds off the edge, the way the scene's
   own claim does (#624's one slab accent), alternating sides. The screens pile.
3. **memo** — the box is paper, the same stock as the docket, clipped over the corner of its screen.
   The whole scene is one desk. The screens pile.
4. **column** — past 60rem the narration runs down one column and the screens down the other, both
   scrolling normally, with the docket riding the top of the narration column. On a phone it is box,
   screen, box, screen.
5. **numeral** — megatype. The stage number stands behind the box at poster size and the docket is a
   full-bleed strip at the bottom edge. The screens pile.

**Round 1's deal set left the file with this round.** It is fully recorded here and in the round 1
commit, and every composition of round 3 is the desk it started, so there is nothing left to compare
it against.

**Three marks left with it.** `oc-gh`, `oc-dc` and `oc-issue` lost their last reader when round 1's
surface tags went. They were not put back in the browser bar or the Discord bar, because that would
be LESS true than leaving them out: a browser omnibox shows no favicon, and the Discord title bar
shows a status dot. A build check now refuses a sprite that carries a passenger, in either direction.

**Three more faults found by reading the spliced result**, none of which a check had named:

- **A comment claimed an overlap the code does not do.** With a narration box between every two
  screens, pulling one screen over the last one can only mean landing the box on it, and that is
  what `memo` is and the other two are not. What the desk actually carries here is the rest of it:
  every screen turned a little, dropped close to the one above it, and casting like paper.
- **The no-script default contradicted itself.** The section opened as `v-step piled`, and `v-step`
  is the one composition that stands its screens apart. With scripts off the reader got the plainest
  reading, dealt.
- **The column's docket could not stick.** `align-self: start` sizes a grid item to its own content,
  and a sticky box travels inside its own box. This is the SAME fault round 2's rail carried, in the
  same shape, one round later. The grid item stretches now and the card sticks inside it.

**110 build checks** run against the file and all **56 breaks** that validate them land. Six of the
checks were wrong before they were right, and they fall into two families:

- **A check read a comment as code.** Round 3's own header says the scene "calls no `scrollTo`, and
  calls `preventDefault` nowhere". The no-hijack check searched the script for those words and found
  them in that sentence. It strips comments first now.
- **A check read prose as code, the other way round.** The held-stage check searched for `v-desk`
  and matched `pv-desk`, which is scene 5's own class, and matched `430svh` inside the paragraph
  explaining that round 3 removed it. It reads `.v-desk` against comment-stripped source now.
- **Two slices ran backwards.** Moving the docket to the end of the column inverted the range the
  constant-chrome check read, and the claim-order check still compared against a container that had
  left the file. Both use `find` and an explicit ordering test now, so a missing anchor fails the
  check instead of raising.

**The other family is the distinctness check, which was wrong three times in three rounds.** Each
time it was reading the wrong thing:

- **It compared the base scope only** (#629's rule), so `v-col`, whose whole identity is a desktop
  two-column layout, declared almost nothing and the check that it declares SOMETHING could not be
  broken at all. It reads every rule now, tagged with the at-rule it sits in, which answers #629's
  original reason too: a composition copied wholesale matches under the renamed class.
- **It matched class names as substrings.** `.v-col` sits inside `.v-colx`, so renaming every one of
  a composition's rules away still left the check believing it declared them.
- **It accepted a stray rule as a difference** (round 2), and **it compared CSS comments** (round 1).

**One fault the checks found in the work, not in themselves.** `v-step` declared exactly one rule,
which is not a composition. The distinctness test caught it as a near-duplicate of `v-col`. It is
its own reading now: a hairline down the box, wider gaps, no pile.

**One fault found by reading.** The splice that removed round 2's five compositions also swallowed
the constant's own detail, the device chrome and the GitHub timeline, because the cut ran from a
marker above them to a marker below. All three outlive the compositions that happened to sit between
them, and they came back from the previous commit rather than being retyped.

**The operator's answer to round 3**, verbatim:

> nonono. i like the desk! plus my feedback
>
> that means we have the explanatory titles naturally scrolling on the side with some gap
>
> and the screens in the main view are toggled while the static part is staying where it is.
> although it should look much more like a github ticket and how it evolves over time

**Round 3 kept the wrong half.** It read "boxes that scroll normally" as "nothing is held", and
dissolved the desk to get there. The desk was never the problem: the long lead-in was.

**Round 4.** The shape the operator describes, exactly:

1. **The titles scroll, on the side, with gaps.** Each step is a tall slot in its own column past
   62rem, on the docking side, so the reader sets the pace. Below that width the held view pins to
   the top and the steps scroll under it.
2. **The main view is held, and the screens TOGGLE in it.** The step crossing the middle of the
   viewport owns the view.
3. **The static part stays, and it is a GITHUB TICKET that EVOLVES.** Not the abstract docket of
   round 2. It is the issue page of [#587](https://github.com/alp82/curia/issues/587), and its
   timeline grows a row per step.

**The lead-in fault does not come back with the held view.** The stage is stuck from the top of the
section, so the first screen and the ticket are both on screen before the reader has scrolled at
all. Round 2's fault was not that it held: it was that it spent its first slot on the ticket alone.
A check asserts the track carries no height of its own and that the first screen stands in the
static HTML.

**Every timeline row is a real, timestamped event**, read off
`GET /repos/alp82/curia/issues/587/timeline`:

| step | the row | when |
|------|---------|------|
| 01 dispatch | `curia-sh` assigned this to `alp82` | Aug 21, 18:46 |
| 02 the work | 🔗 curia pushed `curia/587` (1 commit) and opened #597 | Aug 21, 18:55 |
| 03 the gate | 🔗 curia pushed `curia/587` (5 commits) and updated #597 | Aug 22, 19:10 |
| 04 the end | `curia-sh` merged #597 and closed this as completed | Aug 22, 19:13 |

Two of those rows are the reason this works. **The claim at 18:46 IS the dispatch's mark on
GitHub** — curia claims a ticket by assigning it, before any work. And **the five-commit push at
19:10 lands three minutes before the merge**, which is the gate. The run's shape was already in the
tracker.

**The pill moves ONCE, which is what GitHub really does.** A ticket is Open until it is closed, so
the rows carry the run and the pill carries only its end. Making the pill walk four stages would
have been the page inventing a GitHub that does not exist.

**The one-card-one-surface rule bends here, on the operator's instruction.** The constant is now
GitHub chrome by design. What survives is the half of the rule the original fault named: it must
never carry a Discord control, and a check asserts that.

**Five compositions ride `?id=1..5`**, differing in where the constant sits inside the held view:

1. **desk** — the ticket lies at the near edge and the screens are dealt above it, each turned a
   little and casting like paper. Round 2's desk with the feedback in.
2. **head** — the ticket is the header of the view and its timeline grows downward, with the screens
   toggling under it.
3. **beside** — the ticket takes a column of its own beside the screens, so the record and the
   evidence are read together.
4. **behind** — the ticket fills the view and the screens toggle over it, dropped like windows.
5. **inset** — the ticket IS the view, a whole issue page, and the screen toggles in a slot inside
   its own timeline.

**116 build checks** run against the file and all **62 breaks** that validate them land. Three of
the checks were wrong before they were right, and all three are one fault: **a check matched a name
as a SUBSTRING.**

- `class="sc[^"]*"` matched `class="scx"`, so renaming a screen's class away left the count right.
- The gap check found `min-height` on the desktop media rule and stayed green when the base rule
  lost it. It reads the base rule by name now.
- The toggle check's `\.sc \{` matched `.still .sc {`. It anchors on the start of the selector now.

**And one break was too weak to prove anything.** The distinctness break copied `v-beside` onto
`v-head` from the base scope only, and `v-beside` keeps almost all of itself in a media query, so
the copy left the two genuinely different. It copies the whole composition now, media queries and
all, which is the hardest case the check has to survive.

**The operator's answer to round 4**, verbatim:

> behind is not bad. the github block should have fixed height but not that tall, only enough to fit
> everything without layout shift. then the other screens show below it without that huge of a gap
>
> narration should be:
> 1. open ticket (only github ticket visible)
> 2. you tell it to start (dashboard ticket + start click)
> 3. agent starts working on it (discord thread developing while scrolling, streaming questions,
>    prototypes, etc.)
> 4. agent waits for confirmation (pull request display)
> 5. agent finishes the work (discord confifmation in thread)
>
> it also kind of has parallel lanes. the ticket is always there, but the discord thead and pull
> request life together at the end of the journey, so we could also show them together evolving in
> the last 2 steps
>
> more variations in this direction

**Round 5.** Four things settle with that answer.

**1. The ticket block never moves, and not because a height was reserved for it.** Every timeline
row is always laid out and only its VISIBILITY changes, so nothing is ever added to the block and
there is nothing to shift. A build check refuses `display: none` on those rows for exactly that
reason: `display` would take the row out of the flow and hand the layout shift straight back.

**2. The lanes open close under it.** One small gap, not a screen of air.

**3. Five steps, the operator's own five**, and the ticket grows one real row per step:

| step | the title | what opens | the ticket's new row |
|------|-----------|------------|----------------------|
| 01 | You open a ticket. | nothing, the ticket alone | opened · Aug 21, 15:08 |
| 02 | You tell it to start. | curia's dashboard, and the Start click | assigned to alp82 · Aug 21, 18:46 |
| 03 | The agent starts working on it. | the Discord thread | pushed 1 commit, opened #597 · Aug 21, 18:55 |
| 04 | It waits for your confirmation. | the pull request, beside the thread | pushed 5 commits, updated #597 · Aug 22, 19:10 |
| 05 | It finishes the work. | both, still evolving | merged as `a71e154`, closed · Aug 22, 19:13 |

**4. The lanes are PARALLEL, not a sequence.** The thread opens at step 3 and stays. The pull
request opens at step 4 beside it. Both are still evolving at step 5, where the thread carries the
approval and the pull request turns Merged. That is the shape the operator named, and it is the
shape the run really has.

**The Start button is a real control.** `dashboard.mjs` serves `POST /api/start` from a frontier
card, and it runs the same `start <repo>#<ticket>` the command channel does. The lane draws that
card in the V6 dashboard tokens scene 6 already uses ([#519](https://github.com/alp82/curia/issues/519)),
so this page does not invent a second dashboard.

**The thread's name moves the way `bridge.mjs` moves it**: 🎫 while the agent runs, 🔎 while the
review gate is open, ✅ when the ticket is done (`STATE_GLYPHS`, `bridge.mjs:96`). Three glyphs
across three steps, and the check reads the script that moves them rather than one frozen value.

**Five compositions ride `?id=1..5`**, differing in how the parallel lanes share the floor:

1. **stack** — the lanes open one under the other, and at the end the thread and the pull request
   share the floor top to bottom.
2. **pair** — past 46rem the two stand SIDE BY SIDE, which is what makes them read as running at
   the same time rather than one after the other.
3. **deal** — the lanes are dealt onto the floor like paper, each turned a little and casting.
4. **rail** — a lane slides in from the docking side as it opens, so the newest is in front and the
   one that opened first is still there behind it.
5. **console** — the ticket block and the lanes share ONE frame with no gap at all: the ticket is
   the header band and the lanes are panes docked under it.

**121 build checks** run against the file and all **69 breaks** that validate them land. One check
was wrong before it was right, and it is the same family as round 4's three: **it measured the
wrong element.** The gate check read the position of `#rungate`, which is the whole thread window
and never moves. A gate card lifted out of the thread and dropped into the pull request lane left it
green. It reads the position of the Approve BUTTON now, which is the thing that must not end up on
the wrong surface.

**The operator's answer to round 5**, verbatim, with a screenshot of their phone:

> Can't check the desktop version right now but mobile is broken. The pinned element should be just
> the ticket and the rest moves and switches while scrolling

**What was actually broken, and it is not what it looked like.** The screenshot showed all three
lanes at once, every one of them squashed to a title bar or clipped mid-sentence. The layout was
not the cause. **Scene 9 already owns a class called `.lane`** — the VPS box's rows — and it
declares it LATER in this file. Same specificity, so it won: `.lane { display: none }` never
applied. The same collision was running the other way at the same time, because
`.lane > * { height: 100% }` was landing on scene 9's own bars.

**Two scenes, one generic name.** No check could have named it, because both scenes were exactly
what they each claimed to be, and both were valid CSS. This is the lesson of the round, and it now
has a check: **every class scene 8 ROOTS must be one no other scene roots.** The check compares the
first compound of every selector, because `.dcx-head .hash` cannot collide with anyone else's
`.hash` — the parent namespaces it — while a bare `.lane { }` can collide with anything, and did.
Every class this scene introduces is prefixed `r8-` now.

**Round 6.** The shape is the operator's own sentence: the ticket is the ONLY pinned thing, and
everything else moves.

- **Nothing is held but the ticket.** Round 5 pinned a whole 60dvh stage and packed the ticket,
  three lanes and their chrome into it, which is what clipped every one of them on a phone. There is
  no stage now. A check reads every sticky and fixed rule in the scene and refuses any but the
  ticket's.
- **The page scrolls through five BEATS**, one per step. Each beat is its words and the screens open
  at that point, and the ticket grows a timeline row as the beat arrives.
- **The thread and the pull request run together for the last two beats**, which is the parallel the
  operator named. Beat 4 is the gate waiting beside an Open pull request. Beat 5 is the report
  beside a Merged one.
- **The thread develops across its three beats**, and its name moves with it: 🎫 while the agent
  runs, 🔎 while the gate is open, ✅ when the ticket is done (`STATE_GLYPHS`, `bridge.mjs:96`).

**The five compositions are the same five**, and they still ride `?id=1..5`. The operator could not
check desktop, so nothing they said rules on them: stack, pair, deal, rail, console, differing in
how the two lanes share a beat.

**124 build checks** run against the file and all **67 breaks** that validate them land. The
collision check was wrong before it was right, in the way that matters: **it read every class in a
selector rather than the one the selector roots.** It flagged seventeen names, sixteen of them
descendants that cannot collide — `.dcx-head .hash`, `.gx .num`, `.win-bar .wn` — and would have
been switched off as noise. It compares roots now, and the one real collision is the only thing it
reports.

And **one check family had to learn to survive its own breaks.** Removing a beat made three checks
raise instead of fail, because they indexed into a list the break had shortened. Every one of them
tests its own precondition now: a check that crashes proves nothing, exactly like a check that
cannot go red.

**The operator's answer to round 6**, verbatim:

> do not scroll the actual screens associated the story titles. those are scrolling normally, but
> the cards with the discord and browser and phone screens fade in and out in different ways
>
> we had this in a previous prototype called "4 desk paper docket, screens dealt" - bring that
> concept back combined with the current setup and ideas and feedback

**This corrects a wrong reading, and it is worth naming which one.** At round 5 the operator wrote
"the pinned element should be just the ticket and the rest moves". I read "the rest moves" as
"nothing else is held", took the stage out entirely at round 6, and scrolled the cards along with
their words. That sentence was about the CLIPPING, not about holding. The titles move. The cards do
not.

**Round 7 brings the desk back**, with everything the rounds since have settled on it:

- **The titles scroll**, on the docking side, one tall slot each.
- **The cards do not.** They are dealt onto a desk that is held, and they fade in and out in place.
- **The ticket lies at the near edge** of that desk, and it is the GitHub issue page of #587 growing
  a real timeline row per beat.
- **The thread and the pull request are dealt TOGETHER** for the last two beats, which is the
  parallel of round 5.
- **Beat 1 deals no card at all**, so the ticket stands alone, which is the operator's own step 1.

**The round's question is the transition**, because that is what the answer asks about. Five ways a
card comes and goes, on `?id=1..5`:

1. **deal** — round 2's desk. A card lands from below, turned a little, and STAYS in the pile at
   low opacity as the next lands on it.
2. **dissolve** — no travel at all. The card that is leaving fades where it lies and the next comes
   up through it.
3. **lift** — the card that is done lifts off the desk and blurs out of focus, and the next rises
   into focus behind it.
4. **turn** — the cards swap on a turn, as if the top of the pile were being turned over.
5. **slide** — the card is dealt ACROSS the desk, in from the docking side and out to the other.

`seen` is what makes the deal a pile rather than a swap, and all five compositions read it. Only
`deal` keeps the leaving card on the desk. The other four take it away, each a different way.

**129 build checks** run against the file and all **67 breaks** that validate them land. Two of the
checks were wrong before they were right, and both are faults this file has already recorded:

- **A class matched as a SUBSTRING.** `r8-card[^"]*` matches `r8-cardx two`, so renaming a card's
  class away left the count right. Rounds 4 and 6 each recorded this once. It matches the class as
  a whole value now.
- **Checks crashed on their own breaks.** Dropping a card made three of them raise rather than fail,
  because they indexed into a list the break had shortened. Round 6 fixed this for the beats and
  round 7 had to fix it again for the cards. **A check that crashes proves exactly as much as one
  that cannot go red**, and the only way to find either is to break it.

**The operator's answer to round 7**, verbatim, with a screenshot of the desktop view and two red
arrows on it, both pointing UP — one from the title, one from the ticket:

> we should start directly at the top with the title and the ticket should appear there right away
> and stick to the top instead of the bottom
>
> the appearing screens then should be attached to its bottom with some padding

**Round 8 turns the desk over.** The ticket takes the TOP of the held stage and the cards hang off
its bottom with a little padding. Round 7 had it at the near edge, under the cards, which is what
left the top of the screen empty on every beat. Three changes carry it:

1. **The ticket comes first in the stage**, so it takes the top and it is on screen before the
   reader has scrolled at all.
2. **The cards hang from the top of the desk**, not its floor, so they sit against the ticket rather
   than against the bottom of the viewport. The deal's pile builds downward now instead of up.
3. **A title sits at the top of its own slot**, not its middle. That is the other arrow: a slot is
   most of a screen tall, and centring the words in it put half a screen of nothing above every one
   of them.

**The five transitions are unchanged** and still ride `?id=1..5`, because nothing in this answer
rules on them. The operator has not picked one yet.

**132 build checks** run against the file and all **71 breaks** that validate them land. The four
new ones test the correction itself, and the one worth naming asserts the ORDER of the two elements
in the stage: a ticket moved back under the cards is valid CSS and valid markup, and only its
position in the source says which way up the desk is.

**The operator's answer to round 8**, verbatim:

> we are getting in a better place here. lets pick turn
>
> now lets make variations for clear identification of the screens. we can use the
> application/product logos to make very clear what is discord, github, use a mobile phone for
> screens, etc. - also add browser shells or window borders and titles

**The transition is settled: turn.** It leaves the variations and becomes the base. The cards swap
on a turn from their TOP edge, which is the edge they hang from since round 8, and a build check
refuses a composition that redefines it — a variation quietly unpicking a decision the operator
already made is the one thing a switcher must not be able to do.

**Round 9.** Every screen says what it is. Each carries its product's own mark and a title, and the
five variations are five ways of framing that:

1. **tab** — a real browser tab strip: the site's mark and the page title in a tab, with the address
   under it. All three screens take the same tab shape, so they read as three tabs of one reader.
2. **shell** — full window chrome: the traffic lights, the app's mark and name in a title bar of its
   own, and the address or the channel under it.
3. **device** — identification by HARDWARE. The thread is answered on a phone, which is the whole
   claim of this scene, and the GitHub screens sit in a browser.
4. **badge** — almost no chrome. A product badge sits on the top corner of each screen, and the
   window keeps only the thinnest edge.
5. **header** — the label is the PAGE's, not the product's: a line in this page's own type naming
   the product and what you are looking at.

**The GitHub and Discord marks came back with this round**, and the way they left is why they came
back cleanly. Round 3 dropped them when round 1's surface tags went, and the check that refuses a
sprite passenger is what kept them out until something needed them again. A third mark joins them:
curia's own, the ring and the two dots, drawn rather than fetched like every other mark on this page.

**141 build checks** run against the file and all **77 breaks** that validate them land.

**The collision check caught ME, one round after it went in.** Round 9 wrote `.at-ht { align-items:
center; }` at the scene's root to line up the dashboard's header strip. `.at-ht` is scene 6's class.
That is the same fault that broke the operator's phone at round 5, made again by the same instinct —
reach for the class that is already there — and the check turned it red before the file was ever
served. Both rules are scoped `#run .at-ht` now.

**And a check matched a name as a substring for the fourth time in this ticket.** `.v-badge .r8-tab`
is a substring of `.v-badge .r8-tab i`, so renaming the rule that frames the badge left the check
green. It matches the selector exactly now. Rounds 4, 6, 7 and 9 have each recorded this once, which
is the strongest argument in this file for breaking every check you write: **it is never the check
you doubt that is wrong.**

**The operator's answer to round 9**, verbatim:

> i think shell or device are going in the right direction. i like a lot the browser and phone
> representations in the live previews section, so maybe we should build upon those here too
>
> then when we have those, we should fill those shells with actual simple spaced content. like curia
> atlas should look like a simple website that shows the frontier with the start button inside
> prominently
>
> also leave more gap between the fixed ticket and the screens

**Round 10.** The frames are scene 5's, and the content is simple.

**The frames are NOT new ones.** `.pv-win` and `.pv-wt` are the macOS browser window
[#627](https://github.com/alp82/curia/issues/627) drew, and `.pv-phone`, `.pv-bezel`, `.pv-screen`,
`.pv-island` and `.pv-btn` are its phone, down to the metal rail and the dynamic island. This scene
REFERENCES them and never re-roots one: every rule here that touches a `.pv-` class is scoped
`#run`, and a build check asserts it. That is the collision rule of round 6, applied on purpose
instead of learned again.

**The content is simple and spaced**, which is the other half of the answer and the harder half.
Round 9's screens were each product's real chrome at full density, and density is exactly what does
not survive being shrunk into a card on a desk. Every screen is now a few elements at a size that
still reads:

| screen | what it holds |
|--------|---------------|
| curia | the mark, the frontier rule, one ticket tile, and a full-width **Start** button |
| Discord | three short messages, spaced, and at the gate the question and three buttons |
| GitHub | the title, the state pill, `5 commits · 3 files · +757 −0`, one commit line |

**That simplification cost real evidence, and the checks say so rather than hiding it.** The pull
request showed all five commit SHAs and now shows one, `baa02ff`, beside the real counts. Every
value that survives is still read off the tracker, and the ticket's own timeline still carries the
whole run — but the check that used to demand five SHAs now demands one, and the reason is written
beside it.

**And the gate lost its two verbatim small-print lines.** They are the longest thing on that card
and the first casualty of "simple". The meaning they carried is not lost: the scene's own fact line
is the locked copy "just type your rejection reasons if you don't agree with the result".

**Five stagings ride `?id=1..5`**: mix (browser for curia and GitHub, phone for the thread), win
(one device kind, three sites), pocket (everything on a phone), desk (scene 5's tilted staging), and
flat (no tilt, both screens at full width).

**One thing the operator's own preview URL nearly shipped.** The curia screen's address bar was
drawn from the tailnet host curia published this ticket's preview on, which is the operator's real
tailnet identifier. It is `box.tailnet.ts.net` now, the generic host scene 5 already uses, and a
build check refuses anything matching a real tailnet id anywhere in the file. **A page that ships
publicly must not carry the host it was built on.**

**137 build checks** run against the file and all **80 breaks** that validate them land.

**The substring fault reached five rounds, so it stopped being a check bug and became a helper.**
`'pv-bezel' in sec` is true of `class="pv-bezelx"`. Rounds 4, 6, 7, 9 and 10 have each recorded one
instance of this, every time in a different check, and every time found only by breaking it. There
is a `has_class()` now that matches a whole class value, and every check that asks whether a class
is in the markup goes through it. **The fault was never in any one check. It was in reaching for
`in` when the question is about a name.**

**One cut went too far, and the checks caught it.** Removing the chrome round 10 made dead also
removed the track, the held stage, the titles and the ticket, because the cut ran between two
comment headers with live rules between them. Eleven checks went red at once. The same shortcut —
cut from marker to marker — is what #628, #629 and this file's round 1 each recorded once.

**The operator's answer to round 10**, verbatim, with a screenshot:

> i accidentally merged the PR but we are not done yet, can you bring it back?
>
> also the icon looks broken
>
> desk looks good

**The staging is settled: desk.** Scene 5's browser tilted back with the phone standing in front of
it. It is the default now, and a build check asserts the default is the composition that was picked
rather than whichever one happens to sit first in the list.

**The broken icon was an orphaned class, and it is the most instructive fault of this ticket.**
Round 10's dead-CSS cut removed the block that held `.r8-mk { width: 0.95em; height: 0.95em }`. The
mark did not get smaller or plainer when that rule went. **An inline `<svg>` is sized by CSS or by
its container, and there is no third option** — so curia's ring grew to fill an entire browser
screen on the operator's phone.

Nothing could have caught it. The markup was valid, the CSS was valid, every class was spelled
right, and no check asked the one question that mattered. Two now do:

- **A class scene 8 wears with no rule anywhere** is an orphan, and the check names it.
- **An inline `<svg>` whose class sets no width** takes its container, and that check names it too.

The second is the narrower one and it is the one that would have caught this, because `.r8-mk` was
not orphaned for long: two colour rules still mentioned it. **A class can be declared and still be
undressed.**

**Two classes left with the fix**, found by the same sweep: `.cont` on the closing section and `.sm`
on the kicker, both worn for rounds and neither ever given a rule.

**140 build checks** run against the file and all **83 breaks** that validate them land.

**The operator's answer to round 11**, verbatim, with two screenshots:

> desk: for this step the phone is not below the ticket
> all others: the phone is too Shuge and content is not filling it
>
> i want to keep desk and only do variations with that as a baseline
>
> the screens need the correct proportions for screens, even if we have only little elements to
> show, we then need to add a proper shell to give context where they are

**Two complaints, one cause.** The phone was given its LANE's width, and a lane is the whole card.
A 9:19.5 frame at that width is taller than the desk, which is the first complaint. Its three lines
of content then sat in a corner of all that glass, which is the second complaint seen from inside
the same mistake.

**A phone is narrow, and it is narrow in EVERY beat.** Round 11 sized and placed it only inside a
two-lane card, which is exactly why the one beat that deals a phone alone put it wherever it liked.
It has a width of its own now — `min(9.5rem, 44%)` — and a check refuses a `.pv-phone` rule that
takes 100% of anything.

**The shell is the answer to the empty glass, and it is the more interesting half.** Three lines do
not fill a phone, and shrinking the phone until they do would stop it being a phone. So each screen
carries the furniture its app really has:

| screen | its furniture |
|--------|---------------|
| the phone | a status bar with the clock and the signal, a channel header with a back arrow, and a composer pinned at the bottom |
| GitHub | a page header with the repo path, and the repo nav with Pull requests marked |
| curia | a site header with the mark, and the nav with Atlas marked |

**A screen is mostly furniture, which is why three lines can fill one.** The log flexes between the
header and the composer, so the content sits where content sits and the glass is full without a
single invented word.

**Desk is the baseline** and the five compositions are five arrangements of it: front (the phone
standing at the browser's lower corner), beside (nothing overlapping), flat (no tilt), lean (both
leaning the same way), over (the phone standing on the browser).

**149 build checks** run against the file and all **90 breaks** that validate them land.

**The orphan check caught the same fault one round after it was written.** Round 12's first cut
removed `.r8-mk`'s width rule again, in the same way round 10's did, and the check that round 11
added went red before the file was served. That is the whole argument for writing a check the moment
a fault has a name: **the second instance arrived one round later.**

**And four checks were too weak to break, all in the same shape.** A desktop media query that also
sized the phone kept the proportion check green while the phone was full-width on every phone. A
composition that still named a device in one surviving rule kept the staging check green. Six marks
of the wrong product still counted as six marks. The lesson each time is the one this file keeps
writing down: **a check that reads "somewhere" cannot see a fault that lives in "here".**

**The operator's answer to round 12**, verbatim, with a screenshot:

> they dont have the right dimensions, a screen should be higher, the phone is too small to read
> anything
>
> bigger padding between the ticket and the screens. a bit longer fade transitions
>
> sticky ticket should look more like a ticket card that updates with subtle motion and
> micro-animations

**The dimensions had one cause, and it is the opposite of round 12's.** A card was
`inset: 0 0 auto` — anchored to the top of the desk and only as tall as its content — so a browser
window collapsed to the height of the four lines it held, and the desk under it stayed empty. That
is the strip in the screenshot, and the void below it.

**A card fills the desk now**, and the devices take their size from it. A browser is `16 / 11`,
which is a viewport rather than a strip, and its page flexes to fill it.

**The phone is sized by HEIGHT, and that is the whole fix.** Round 12 made it narrow to stop it
being huge, which was right, and then it was too small to read, which was the price. A width is the
wrong handle for a device that is 9:19.5: the width that fits beside a browser is not the width that
makes it tall enough to read. Height is the handle. It stands as tall as the desk allows and its
width follows its own shape.

**The ticket is a card.** It has a header strip of its own with the repo path and the state, a body
under it, an edge and a shadow. And it UPDATES rather than jumping:

- a new timeline row slides in from the left as it fades, and only the row that just arrived lands
  its node — the ones before it are already on the card and must not twitch every time the step
  moves.
- the state pill CROSS-FADES. Both states are always laid out in one grid cell, so the header cannot
  change height when it turns.
- nothing about the block's size moves while any of it happens, because every row is always laid out
  and only its visibility changes. That rule has been in this file since round 5 and it is what
  makes micro-animation safe here at all.

**The fade is longer**, 0.85s, and the gap between the ticket and the screens is 2.4rem.

**156 build checks** run against the file and all **97 breaks** that validate them land.

**The operator's answer to round 13**, verbatim, with four screenshots:

> 1 front is the way foward
>
> screenshots:
> #1: first image coming too late
> #2: not enough browser like, maybe the all black bg is not helping here due to missing contrast
> #3: almost invisible phone, toooo small
> #4: desktop good, phone again too small (same for step 5)

**The arrangement is settled: front.** The browser tilted back with the phone standing at its lower
corner.

**The phone was a pill, and the cause is one missing link in a height chain.** A percentage height
resolves only against a DEFINITE one, and `.r8-lane` had no height of its own — so
`.pv-phone { height: 100% }` fell back to the phone's own content and became the little capsule in
screenshot 3. The lane carries `height: 100%` now, and every step of the chain is definite: the
stage has a height, the desk flexes inside it, the card is `inset: 0` of the desk, the card's grid
is `height: 100%`, the lane is `height: 100%`, and the phone finally has something real to be 100%
of.

**That one line is why the phone was too small in every beat**, including the two-lane ones the
operator flagged separately. It was never a sizing choice.

**A window needs an edge and a scrollbar, and a page needs to not be the colour of the scene.** The
browser did not read as a browser because it had none of the three: the page was `#0d1117`, which is
as black as the scene behind it, the window had no border, and nothing on it said it scrolls. The
page is lifted to `#12161f`, the window carries a hairline edge, and the app draws its own scrollbar.

**And the void under the content is filled with something real.** The atlas page now carries the
map's own progress: 13 of the 17 children of [#600](https://github.com/alp82/curia/issues/600) are
closed, which is the count on the tracker today.

**The first screen comes sooner.** The opening title takes a shorter slot than the others, because
nothing is on the desk while it holds.

**160 build checks** run against the file and all **101 breaks** that validate them land.

**One check was RETIRED this round, and that is worth as much as adding one.** "A lane is never
squeezed into a fixed box" came from round 5, where a lane at `height: 100%` inside a held 60dvh
stage with three lanes crammed into it clipped every one of them. Round 13 made the card fill the
desk, and from that moment the same declaration became the thing that lets a phone be tall enough to
read. A check that outlives its reason does not go quiet: **it argues for the bug.** It is replaced
by the rule that still holds — a lane follows the desk and is never pinned to a length.

**And one check was red for a reason that had nothing to do with what it checks.** Adding a
box-shadow as a second rule on the same selector made "a browser is a viewport" fail, because it
demanded that EVERY base rule mention the aspect ratio. It asks that one sets it and none unsets it
now, and the shadow lives in the same rule where it belongs.

**The operator's answer to round 14**, verbatim, with a screenshot:

> the screen and phone should have a fixed aspect ratio. as you can see, it depends on the viewport
> size

**A fixed aspect ratio means exactly ONE axis may be constrained**, and round 14 constrained two.
The browser had `width: 100%` and `max-height: 100%` together: whenever the cap bound, the ratio
broke, and WHICH viewport that happened at is exactly what made the shape look like it depended on
the window.

**The lane was doing the same thing more quietly.** It was a flex box with `align-items: stretch`,
and **a flex item's stretched height beats its aspect-ratio** — which is why a 16:11 window came out
portrait and a 9:19.5 phone came out a sliver. The lane is a plain block now and a device sizes
itself.

**Both devices set a WIDTH and let the ratio give the height**, and the width is the smaller of what
the desk has each way:

```
width: min(100%, calc(100cqh * 16 / 11))
```

The desk is a size container, so `100cqh` is the room the desk really has. That fits a device both
ways without ever touching its shape, and it is the same rule for both: the phone reads its budget
from `--ph-h`, so the `front` arrangement can hand it 92% of the desk without touching its ratio
either.

**Neither device carries a cap on the axis the ratio owns**, and a check refuses one, because that
is the fault in one line.

**163 build checks** run against the file and all **104 breaks** that validate them land.

**The operator's answer to round 15**, verbatim:

> let's pick front for now and call this prototype done. but we will need two follow up tickets: a
> second prototype round to flesh this out and another one for fleshing out the mobile experience
> from top to bottom once all sections are prototyped properly

**Settled.** The switcher and the four arrangements that lost left the file with this round, the way
#624's identity bar and #629's switchers did.

## The VPS scene ([#631](https://github.com/alp82/curia/issues/631))

The brief of [#551](https://github.com/alp82/curia/issues/551) round 2: the four bars explain
nothing, and the scene needs more information. The claim stays: four agents at once on a small
box, about 0.5 GB each. Every number on the scene is measured or counted, and the sources are
[positioning.md](../../docs/landing-page/positioning.md) claim 2 (four overlapping sessions,
733 MB peak, ~0.5 GB planning per agent, 30 GB box, 40 to 50 of headroom),
[ADR-0003](../../docs/adr/0003-tmux-ttyd-tailscale-worker-host.md) (tmux, one ttyd, Tailscale
Serve) and [ADR-0012](../../docs/adr/0012-one-container-per-worker.md) (one container, two
mounts, two cache volumes, three loopback ports per agent).

**Round 1.** Five readings of the same box on `?vps=1..5` and a rail under the claim:

1. **stack** - the box as layers top down: tailscaled, ttyd and the daemon, tmux, then the four
   containers as tiles, and one memory rail with the 733 MB peak against the 2 GB plan on 30 GB.
2. **gauge** - the whole memory of the box as sixty half-gigabyte blocks: the peak lit, the
   four planned blocks outlined, the 40 to 50 of headroom shaded, and a legend.
3. **readout** - what the box says over ssh: `docker ps`, `tmux ls`, `free -m` with the peak,
   `tailscale serve status`. The uptimes and port numbers are invented, the rest is counted.
4. **blueprint** - one agent exploded: the container, `/workspace`, `/cfg`, three ports, two
   caches, then times four with the measured peak.
5. **ledger** - the four figures large, then a definition list: the box, always on, per agent,
   what it reaches, what is public.

**Round 2.** The operator picked the gauge. Three changes: the scene is centered, the claim
included, which is the same deviation from #624 rule 2 the atlas took; the box is 4 GB, the more
common size, so the strip is eight half-gigabyte blocks with four lit; and the measured peak is
off the scene. Everything grew: the blocks are 2.6rem tall, the box is 30rem wide and the legend
reads at 0.84rem. The switcher and the four losing readings left the file with this round.

**Round 3.** The operator asked for the daemon and the parts it needs as a second colored block,
thinner columns of 0.1 GB, and five stylings. The strip is forty columns: twenty in the scene
green for the four agents, ten in the agent gold for the system, ten dark and free. Five stylings
on `?vps=1..5` and a rail: 1 flat (round 2 with thin columns), 2 pills (rounded, the lit ones
glow), 3 ruler (hairlines, the groups bracketed and named), 4 bar (one solid bar with hairline
columns through it), 5 tall (no box chrome, the columns are the scene, agents tallest).

**One number on this round is not measured.** The system block draws 1 GB for the OS, Docker,
tmux, ttyd, tailscaled and the daemon together. Nothing in the repo records what those take on
the box. The operator either confirms it by reading `free -m` on coinmatica with no agent alive,
or it changes before the round settles. The 4 GB box itself is the operator's pick at round 2 as
the common size, not a measurement.

**Round 4.** The operator kept pills and bar, and asked for the system first, a slider for the
agent count, and the columns grouped per agent. The strip is now groups with a gap between them
and none inside: ten gold columns for the system, five green per agent, the rest dark. A range
input under the strip sets one to six agents, and the legend and the free count follow it. The
group labels read system, agent, free; the ticket numbers left with the ruler. Flat, ruler and
tall left the file with this round. The 1 GB system block is still unmeasured.

**Round 5.** The operator picked the bar and asked for variations on it, plus a RAM slider. Two
sliders now: RAM in five stops (2, 4, 8, 16, 32 GB) and the agent count, clamped to what fits
after the system's 1 GB. A column is always 0.1 GB, so the strip thins as the box grows, and the
hairlines between columns drop past 80 columns. Five stylings on `?vps=1..5`, all built on the
bar: 1 bar (round 4 as it stood), 2 named (no hairlines, the name inside each bar), 3 pills
(rounded ends and a gigabyte ruler), 4 stack (tall bars, labels under them), 5 thin (one
hairline-thin bar with the ruler, the legend does the talking). The 1 GB system block is still
unmeasured.

**Round 6.** The operator picked the bar, and the four losing stylings and the rail left the
file. Three changes: from 16 GB the group labels shorten to S and A, and past 160 columns the
agent labels drop entirely because nothing fits; the two sliders sit on one three-column grid so
their tracks align and the value never wraps; and the system legend ends in "Curia" instead of
"the curia daemon". The 1 GB system block is still unmeasured.

**Round 7, the verdict.** The operator capped RAM at 16 GB and locked the scene. The RAM stops
are 2, 4, 8 and 16 GB, so the past-160-columns rule of round 6 went with the 32 GB stop.

The scene as it ships: the claim centered, then one box. A strip of 0.1 GB columns grouped into
bars: the system first in the agent gold, then one green bar of five columns per agent, then
free. Two sliders on one grid, RAM and agents at once, and the agent count is clamped to what
fits after the system. A legend of three lines: the system (Docker, tmux, ttyd, Tailscale,
Curia), N agents at about 0.5 GB each, and the free gigabytes. The fact line of #587 closes the
scene unchanged.

**The one unmeasured number.** The system bar is 1 GB. It is a stated estimate for the OS,
Docker, tmux, ttyd, tailscaled and the daemon together, not a reading from the box. The 0.5 GB
per agent is the planning number of positioning.md claim 2. [#604](https://github.com/alp82/curia/issues/604)
carries the estimate: a `free -m` on the box with no agent alive either confirms it or changes
the ten gold columns before cutover.

The `.box` and `.lane` classes of the old scene stay, unused by the new markup. Each variation
prefixes its classes (`st-`, `gg-`, `ro`, `bp`, `lg`), after the fault
[#773](https://github.com/alp82/curia/issues/773) records. The switcher and the four losing
readings leave the file with the round that settles it, the way every switcher before did.

## The merge that arrived early

The operator merged pull request #739 by accident at round 10, before the scene was done. **Nothing
was lost and nothing needed undoing.** The branch `curia/630` survives on the remote with all of its
commits, and the squash put the round 10 prototype on main — which is exactly the shape every
earlier scene ticket left main in, because a prototype living at `prototypes/story-page/` IS where
this map says prototypes live. The live page is untouched: only
[#604](https://github.com/alp82/curia/issues/604) copies this file to `docs/`.

So the work carried on where it was, and the next pull request carries only what came after. Curia's
own record is the thing that made this a non-event: the branch is curia's to push and delete, and it
had not deleted it.

## The verdict of the ticket run scene ([#630](https://github.com/alp82/curia/issues/630))

**Locked over fifteen operator rounds**, the longest run of any scene on this page. The ticket asked
for three things, from the operator's note at #551 round 2: no horizontal scroll hijack, tickets that
read as tickets, and a clean split between what GitHub shows and what Discord shows.

**What the scene is, finally:**

1. **The titles scroll, on the docking side, and the screens do not.** Each of the five steps owns a
   tall slot. The step crossing the middle of the viewport owns the desk.
2. **The desk is held, and the cards turn onto it.** The transition is `turn`, settled at round 8:
   a card swaps on a turn from its top edge, which is the edge it hangs from.
3. **The ticket is the constant, at the top, and it is a GITHUB TICKET.** Not an invented docket.
   Its timeline grows one real row per step, its state pill cross-fades once, and nothing about its
   size moves while either happens, because every row is always laid out and only its visibility
   changes.
4. **The screens are real devices.** Scene 5's own browser window and phone
   ([#627](https://github.com/alp82/curia/issues/627)), referenced and never re-rooted.
5. **The arrangement is `front`:** the browser tilted back and the phone standing at its lower
   corner, the way both really sit on a desk.
6. **The lanes are parallel.** The thread opens at step 3 and stays, the pull request opens beside it
   at step 4, and both are still evolving at step 5.

**The three faults of the ticket, and what answered each:**

| the fault | the answer |
|-----------|------------|
| the horizontal scroll hijack | deleted at round 1 and never replaced. A build check asserts the scene binds no `wheel` or `touchmove` listener, calls no `scrollTo`, and calls `preventDefault` nowhere |
| the tickets looked bad | the constant IS the issue page of #587, and every screen carries its product's real furniture at a size that reads |
| GitHub and Discord were mixed | one card carries one surface. The gate moved to Discord, where it belongs, with Reject in the red `ButtonStyle.Danger` really builds it |

**Everything on the page is real** ([#601](https://github.com/alp82/curia/issues/601)). Every
timeline row is a timestamped event read off `GET /repos/alp82/curia/issues/587/timeline`, and two of
them are why the scene works at all: the claim at 18:46 is the mark the dispatch leaves on GitHub,
and the five-commit push at 19:10 lands three minutes before the merge, which is the gate. The
Start button on the dashboard is a real control — `dashboard.mjs` serves `POST /api/start` from a
frontier card. The map's progress line is the count on the tracker today.

**Two deliberate reductions, both recorded above.** The pull request shows one real commit and the
real counts rather than all five SHAs, and the gate lost its two verbatim small-print lines. Both
are the price of "simple, spaced content", and the scene's own locked fact line still carries what
the small print said.

**Four new words this ticket authored**, the five step titles, which #587 never locked. That is the
second time this file has written copy #587 left open, and it happened on the operator's instruction
at round 3.

**One thing the preview nearly shipped.** The curia address bar was drawn from the tailnet host
curia published this ticket's own preview on, which is the operator's real tailnet identifier. A
build check now refuses one anywhere in the file. **A page that ships publicly must not carry the
host it was built on.**

**140 build checks** run against the file and all **98 breaks** that validate them land.

**What fifteen rounds of checking taught, in three lines:**

- **A check that reads "somewhere" cannot see a fault that lives in "here."** A desktop media query
  that also sized the phone hid a phone that was full-width on every phone. Six marks of the wrong
  product still counted as six marks. This was the fault five times.
- **A class matched as a substring is not a class.** `'pv-bezel' in sec` is true of
  `class="pv-bezelx"`. Five rounds recorded one instance each, in five different checks, before it
  stopped being a bug and became a `has_class()` helper. The fault was never in any one check: it
  was in reaching for `in` when the question is about a name.
- **A check that outlives its reason argues for the bug.** "A lane is never squeezed into a fixed
  box" was right at round 5 and became, at round 13, the exact declaration that lets a phone be tall
  enough to read. Retiring it was worth as much as writing one.

**And the fault this file could not stop repeating was a cut, not a check.** Removing dead CSS from
one comment header to the next carried live rules off with it at rounds 10, 12, 13 and 15 — the
desktop split four times, the mark's width twice. The sweep at this verdict cut by RULE instead,
selecting only rules whose every class is dead. **A marker is a place. A rule is a thing.**

## The verdict of the terminal scene ([#629](https://github.com/alp82/curia/issues/629))

**Locked over ten operator rounds**, the longest run of any scene on this page. Every variation
that lost, and the switchers that carried them, left the file with the round that settled it, the
way the identity switcher did at [#624](https://github.com/alp82/curia/issues/624).

The ticket asked for one thing: the operator's note at #551 round 2 said the two TUIs "look not
like their original counterparts at all. they should be really realistic". Eight of the ten rounds
were spent on what realistic means for a terminal, and the answer was not visual polish.

**What the scene is, finally:**

1. **A terminal is a CHARACTER GRID, and that is the whole of it.** All four panes are authored at
   exactly 58 columns, and the script measures a 58ch ruler against the live frame and scales the
   font until 58 columns fill it. So the Codex banner box, the Claude composer rules and every
   separator end on the same column at every width. Line height is exactly 1, because a browser
   draws box characters at the glyph height and any leading opens a gap a terminal does not have.
2. **Each pane is a scrollback and a composer**, the way all four TUIs are built. The transcript
   sits at the bottom of a window fixed at 26 rows, and the input row never moves.
3. **The window never changes height**, at any harness or any width. A shorter transcript sits
   against its composer with blank rows above, which is what a real full-screen TUI shows. Nothing
   scrolls and nothing moves on load: the font size drives the height, so `fit()` runs before the
   first paint and the page ships no webfont.
4. **The control is the harness rail past 60rem and bottom tabs below it, and never both.** So the
   tmux status line is what a real one is: text stating the session, controlling nothing.
5. **The composition is the browser tab the claim names**, with one tab, over the tailnet URL. The
   session prints once, a line every 190ms, then hands from Claude Code to Codex.
6. **The session is the type foundry of scene 4.** GRAVITY, locked at
   [#627](https://github.com/alp82/curia/issues/627), and the job is its size waterfall.
7. **Four harnesses**, each with the chrome its own TUI prints, and four drawn marks on the rail.

**One deliberate deviation from [#601](https://github.com/alp82/curia/issues/601)**, and it is the
SECOND instance of one deviation rather than a new one. The transcripts are invented, because
GRAVITY is invented. #627 already took that step, on the operator's instruction, when they asked
for a site cooler than a real curia prototype. Extending that site into this scene extends the same
step. Nothing here claims to be a curia record: the rail states a model or a version and no ticket,
the working directory is `~/gravity`, and a build check refuses a ticket number in either place.
[#604](https://github.com/alp82/curia/issues/604) carries it, beside the four-harness fact line.

**Three faults the operator's eyes found that no check could.** Every check here reads the source,
and at each of these the source was exactly what it claimed to be.

| what they saw | what it was |
|---------------|-------------|
| everything italic | the colored runs were `<i>` elements, which a browser slants. An oblique face does not sit on a character grid |
| the wordmark cut off | block characters are drawn at the FONT's metrics, not the line box, so two rows of them never tile at line height 1 |
| the cursor inside the text | the opencode composer is four gutter rows and this file had three, so the cursor landed against the mode line |

**And one fault that was in the EVIDENCE, not the file, which is the lesson of this ticket.** The
opencode wordmark was wrong for three rounds while every check stayed green, because the capture it
was built from is wrong in two ways at once:

- **It is missing half its rows.** `prototypes/model-switch/evidence/opencode-1-spawn.txt` caught
  the pane mid-scroll and held the bottom two of four. That is why `d`, `n` and `o` were
  character-for-character identical in it.
- **It is missing half its ink.** `logo.tsx` renders the shading on the BACKGROUND of a cell, so
  `_` in the source is a space whose background is filled. `tmux capture-pane` writes that out as a
  blank, because a text capture records characters and this mark keeps half of itself in the colour
  behind them.

The mark is drawn from
[`packages/tui/src/logo.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/logo.ts)
and [`packages/tui/src/component/logo.tsx`](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/logo.tsx)
now, in the four shades that source names. **A capture is a lossy record of a rendered thing, and
the generator that made it is the only complete source.** Where a pane depends on nothing but
characters, a capture is enough, and every other pane here still rests on one. Where it depends on
colour, go to the source.

**157 build checks** run against the file, and all **56 breaks** that validate them land. Three of
the checks were wrong before they were right, and each was a different kind of wrong:

- **A break landed in the wrong scene.** The `.wrap` mutation hit the first `<header class="claim
  rv">` in the file, which belongs to an earlier scene, so the check stayed green and proved
  nothing. That is the same fault #628 recorded, repeated by the same shortcut.
- **A check compared the wrong scope.** The distinctness check gathered declarations from inside
  the desktop media query too, so a composition copied wholesale still looked different.
- **A check that was right for one instance was wrong for five.** Every TUI-marker check asked
  whether a string appeared anywhere in the SCENE. With five candidate sessions that is not the
  same question as whether a PANE has it, and breaking one session of five left the check green.
  They run per pane now. **Only a break that lands in one instance can tell you this.**

**The four marks on the rail are drawn, and none is that project's official logo.** The page ships
no image and no webfont, so a mark is drawn or it is not there. Each is built from something the
harness itself prints. The operator confirmed they stand.

## The verdict of the atlas scene ([#628](https://github.com/alp82/curia/issues/628))

**Locked over three operator rounds.** The four compositions that lost, and the bar that carried
them, left the file with the round that settled it, the way the identity switcher left it at #624.

**What the scene is, finally:**

1. **Two screens, not one map.** Round 1 offered one map with its tickets under it. The operator
   ruled that too little: the scene shows a **home dashboard** and **one map**, side by side.
2. **Both screens redraw a DECIDED curia screen**, in the V6 dashboard tokens
   ([#519](https://github.com/alp82/curia/issues/519)). Nothing in this scene is a shape this
   ticket invented.
   - The home is the synthesis home of [prototypes/home-directions/](../home-directions/) (#519),
     cut back for a phone: the ring of what needs you, the agents that run, one progress bar per
     map. The log tail and the token readouts are gone.
   - The map is the stops line of [prototypes/frontier-visual/](../frontier-visual/)
     ([#588](https://github.com/alp82/curia/issues/588)), decided there over six rounds: the
     walked stop, the running row, the frontier rule, then the blocked in their **red-lined box**
     and the fog on its **diagonal grey stripes**. The operator named those two treatments by
     sight, and they are lifted value for value.
3. **The claim stands between them, and both screens face it.** `rotateY` turns a screen's normal
   toward the side it is rotated to, so the home takes a positive angle and the map a negative one.
4. **The scene is one composition canvas.** The claim and both screens are grid items of `.at`,
   placed for a phone and placed again past 60rem, where the grid is three columns.
5. **A screen is bounded.** Each one is a card with its own header strip that clips what runs past
   its bottom edge.
6. **The counts are real** ([#601](https://github.com/alp82/curia/issues/601)). The home carries
   this repo's three open maps at their true fractions: Build the Atlas operator experience at
   8/42, Model credentials and provider-account failures at 16/19, and Ship the story landing page
   at 10/16 +2. The map screen is #600, the map that is building this page, and the agent on the
   home screen is the one that built this scene. The frontier is empty, because the one unblocked
   ticket is the one being worked.

**One deliberate deviation from the identity**, taken on the operator's round 2 instruction and
recorded here rather than buried: the claim is **centred**. [#624](https://github.com/alp82/curia/issues/624)
rule 2 docks a scene's claim to its own side, and this scene is `sL`. Two screens flanking a title
need a middle to face, so the claim takes it.

**The fault that cost a round, and why it is worth keeping.** Round 2 read fine on a phone and
broke at desktop width. The claim sat in a centred `.wrap` while the evidence leaned right inside a
`.shot`, so the title stood alone with a screen of dead space beside it. That is the SAME fault the
preview scene hit at [#627](https://github.com/alp82/curia/issues/627) round 3, and the same repair
fixed it. **A scene that boxes its claim and its evidence in two separate centred containers has no
composition at all**, and the fault only shows at a width no agent here can see.

**Eleven build checks** run against the file, since no agent on this ticket has eyes on it: the
canvas holding all three items with no `.wrap` and no `.shot`, the claim centred and both tilts
facing it and staying slight, the losing compositions and the bar gone, the screens bounded and
headed, the home carrying the #519 ring and agents and one bar per open map, the map carrying the
#588 stops line with the red-lined box and the striped strip, the counts matching the tracker
snapshot, every class styled and every hook present, the page reading with no script and with
reduced motion, the build rules, and balanced markup.

**Five wrong records in scene 3, found by reading this scene's data against the tracker.** The
opening arc names real tickets, and #601 rules that every scene shows real records, so a twelfth
check now compares every one of them against `gh`. Five disagreed, and the operator ruled all five
fixed:

| ticket | the page said | the tracker says |
|--------|---------------|------------------|
| #627 | the atlas scene | the phone preview scene, and #628 is the atlas |
| #601 | research | grilling |
| #644 | task | research |
| #587 | grilling | prototype |
| #578 | grilling | task |

The operator was asked about #627 alone, at every round from the first. Their ruling was the
reason, not the instance: it is a correction to a real record, and #601 rules that every scene
shows real records. The other four are the same error, so they went with it.

**Two of the checks were wrong before they were right**, which is the lesson this file keeps
relearning. A distinctness check compared whole CSS rules, so two compositions with different
selectors always looked different even when their declarations were identical. And a break meant to
prove the `.wrap` check landed in a different scene, so that check had never been shown a failure
at all. **A green check that has never been shown a known failure proves nothing**, and neither
does a break you did not confirm landed.

## The verdict of the preview scene ([#627](https://github.com/alp82/curia/issues/627))

**Locked over five operator rounds.** Round 5 settled the last of it: "type is great, lets lock it
in". Every variation that lost, and the switchers that carried them, left the file with the round
that settled it, the way the identity switcher left it at #624.

**What the scene is, finally:**

1. **The device is drawn, not shot** ([#601](https://github.com/alp82/curia/issues/601)). A
   titanium rail, a black bezel, the dynamic island with its lens, a status bar with signal, wifi
   and battery, four side buttons, the home indicator, one specular pass, and Safari's floating
   address bar carrying the tailnet host, which is the evidence the claim asks for.
2. **What plays inside is a round, not a page.** Curia sends five variations per prototype round
   ([#635](https://github.com/alp82/curia/issues/635)), so the phone shows five art directions of
   one bright site and carries the switcher curia ships with a prototype. It cycles every three
   seconds, a tap takes it over, and the cycle comes back eight seconds later.
3. **Both devices show one preview.** The workstation window is filled from the same pool of
   screens as the phone, drawn at 720px and scaled into place, which is what makes a miniature
   read as a desktop rather than as a narrow column.
4. **The composition is the light desk.** One spotlight out of the top-left corner, the
   workstation barely tipped, and the phone standing at the right where the light falls off. The
   color half of the light is the key color of whichever design is showing, so the desk changes
   color as the round turns.
5. **The scene is one canvas.** The claim, both devices, the switcher and the fact line are grid
   items of it, placed for a phone and placed again past 60rem.
6. **The site is GRAVITY**, a type foundry, in five art directions: sun (cream, editorial serif),
   acid (white, black grotesk, a lime block), bloom (a pastel mesh), riso (mint, halftone dots,
   two inks) and dusk (a sunset poster).

**One deliberate deviation from #601**, taken on the operator's round 5 note asking for cooler
copy rather than for real records: the site inside the phone is invented. Every other proof scene
on this page shows real curia records. A real curia prototype is dark, and a dark page inside a
dark page proves nothing at phone size.

**What no round ruled on:** the five art directions themselves. The operator picked the device,
the composition and the subject, and the review gate carried the art directions with the rest.

**Two faults worth keeping.** Both were invisible to everyone but the operator's eyes, which is
the point of the preview rounds.

- **The markup order decided a layout.** Round 2's pair layout stated no position for any of its
  three elements, so it took the DOM order by accident: the phone rendered above the window and
  its negative margin pulled it into the claim. A build check refuses that now.
- **A cap in `ch` broke the title over seven lines.** A `ch` is relative to the element's own font
  size. The cap sat on the `header`, which inherits 1rem, not on the 3rem line it holds, so 14ch
  was about 112px. The claim takes the width of its grid column now, with no cap.

## The verdict of the Discord scene ([#626](https://github.com/alp82/curia/issues/626))

**Locked over six operator rounds.** Every variation that lost, and the switcher that carried them,
left the file with the round that settled it, the way the identity switcher left it at #624.

**Round 6** was the last, and it was corrections. The operator picked **lift**, with the swell
centred rather than rising, the pulse ring on top of it, and both bigger. They ruled the thread
names down again to `[ICON] 2 · grilling` with a wider channel list. And they caught a layout fault
in the button rows.

**The fault, and why it is worth writing down.** The rows were thrown apart and wrapped at two
buttons a line. The cause was the streaming: `chars()` splits every text node into one span per
character, and the whitespace BETWEEN two buttons in the markup is a text node. In a flex row each
of those spans is a flex ITEM, and each one takes the row's `gap`. Twenty spaces of indentation
became twenty flex items and about 250px of dead air. The fix is one line: a whitespace-only text
node is skipped unless it sits inside a code block, where the spaces are the content.

The lesson is the round-1 one again, sharpened. Round 1's `chars()` skipped whitespace with
`!txt.trim()`. Round 3 changed it to `!n.nodeValue` so the ASCII timeline kept its columns, and that
change carried this fault into three rounds of previews. **A guard that is loosened for one caller
has to be re-checked against every other caller,** and the operator's eyes were the only check
this file had.

**What the scene is, finally:**

1. **The claim leads and holds.** "Answer from the couch." rides to the top of the screen and
   sticks. What it leaves is the room the window may take.
2. **The window is placed against a stage that is the viewport**, so its distance from the bottom
   edge is a constant at every scroll position and every height. It cannot be cut off.
3. **It unfolds from the bottom row up**, so the typing row is the first thing on screen, holds
   there while curia thinks, then grows upward as the card streams in character by character.
4. **The chrome is the desktop client**, read off the operator's own screenshot rather than
   guessed: the title bar, the rail, threads nested under their channel, the breadcrumb header, the
   member list that drops on a narrow screen, the account panel, and the composer's tool row.
5. **The card is curia#601** in the ADR-0025 shape, and its answer is what built every proof scene
   on this page.
6. **The press is shown**, and then curia does the true thing: it edits the card and clears its
   components, so the rows collapse, the mark comes up in small print, the message wears
   `(edited)`, and the thread turns green in the header and the channel list at once.

**Two deliberate deviations from what curia really posts**, both taken on the operator's ruling
that this page reads to a stranger first, and both recorded here rather than buried:

- **Thread names.** The page says `⏳ 2 · grilling`. `bridge.mjs:644` writes
  `🎫 601 · curia · grilling`. The number is short and the repo is gone.
- **The card shape.** The page shows ADR-0025, which is accepted but not yet in `bridge.mjs`. The
  operator ruled that the page must not go live ahead of it, so this becomes a build-day check on
  the cutover ticket ([#604](https://github.com/alp82/curia/issues/604)), beside the one scene 7
  already carries for the harness names.

**The gate rejected round 6 on mobile:** "Looks good. On mobile the appear logic is a bit broken
though." The screenshot came as an attachment under `daemon/data/`, which a ticket container does
not mount, so this was worked from the words and from what is mobile-specific in the code. Three
faults were there, and all three are phone-only:

1. **A resize reset the scene under the reader.** A phone fires a resize every time its URL bar
   slides away on the scroll. `measure()` ran on every one of them, and it re-fitted the card and
   called `apply(0)`, which collapses the message to nothing. Now `apply(0)` is gone from
   `measure()`, and a resize whose width is unchanged and whose height moved less than a quarter is
   ignored.
2. **The script and the stylesheet disagreed about a viewport.** The stage is one viewport tall in
   CSS. The script read `window.innerHeight`, which on a phone moves by about a tenth of itself as
   the bar hides, so every threshold slid mid-scroll. The script now measures the stage itself, so
   the two agree by construction.
3. **The stage was still travelling when the window unfolded.** The track is pulled up under the
   claim so the stage is stuck before the window appears, and that pull was sized for a claim two
   lines tall. A phone wraps the claim to three, which pushed the track down far enough that the
   stage had not stuck yet, so the window appeared in mid-air and jumped into place. The pull went
   from 115svh to 160svh, which is past the worst claim rather than past the average one.

The bottom edge also moves on a phone, and `svh` is the height with the URL bar showing. The stage
is `100dvh` now, so the window's bottom follows the live edge instead of floating above it, and the
window's own gap is a `rem` rather than a viewport unit.

**Where the font still falls short.** The page ships no webfont, so the window runs Discord's own
fallback stack. gg sans is licensed and never loads. On an Apple device that lands on Helvetica,
which is what Discord itself falls back to, and it is narrower and more closed than gg sans. The
names and the bold lines run slightly short of the real thing. Nothing in the system stack is
closer.

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

## The whole page on a phone ([#773](https://github.com/alp82/curia/issues/773))

**Round 1.** The first read of the twelve scenes in sequence at 393px (iPhone 15), frame by
frame, with the page measured at every stop. Five faults, none visible in any one scene's own
ticket because each one only shows across scenes or across the whole document:

- **The page scrolled sideways.** Four things reached past the right edge: the arc panel
  frames (`inset: -20px`), the grilling orb (`-25vw`), the preview light (`-18%`), and every
  right-docked reveal parked at `translateX(2.4rem)` before it comes in. The phone's layout
  viewport grew to 491px to hold them, so every scene rendered a fifth too small. Every
  `.scene` and `.arc-flow` clips its own sides now. **The clip must not go on the root:** on
  `html` it unstuck every sticky stage on the page, measured A/B against the file on `main`.
- **The grilling window scrolled up through its own claim.** The stage let go at the section's
  end, but the sticky claim held on to the same end and the window climbed through the words.
  The claim has its own sticky box now, `.grill-headbox`, which ends a screen above the
  section, so the claim lets go first and rides off ahead of the window.
- **A class collision, the third.** Scene 7's bare `.oc { width: 1em }` (its octicons) reached
  the Discord card's option lines, which carry the same class, and squeezed each one to one em
  wide, so the text wrapped a word per line over the blocks below. Scoped to `.gx .oc`. The
  atlas scene's bare `.rl { margin-top }` reached the preview bar and the terminal rail the same
  way; scoped to `#atlas .rl`.
- **The terminal never started.** Its observer wrote `seen = true` and `seen` was never
  declared. Under `'use strict'` that is a `ReferenceError` on the first intersection, thrown
  before `start()`, so no harness ever typed. Declared.
- **The setup command clipped** at `--build`. The `pre` wraps now.

The scroll budget at 393×659: 20.6 screens. The opening arc takes 7.2 of them, the ticket run
4.3, the atlas 2.1, and every other scene one or less.

**Left for the operator:** on a phone the ticket-run scene's Discord phone lane shrinks to a
sliver beside the atlas window. That is the round 15 arrangement measured against a desk that
is only a phone wide, and it is a decision, not a fault.

**Round 2.** The operator, from an iPhone SE: "we got lots to do here". The art at the top
needs more room, and small screens may leave elements out and simplify the visualizations to
avoid density. The full page went through first at 375×667, scene by scene, and the operator
took the cuts as proposed, with one rule: desktop stays exactly as it was.

**The rule the round keeps:** one breakpoint, `max-width: 40rem`. Below it a scene shows one
object per beat and no chrome that is not the point. Above it nothing changes. The canvas
gates its own cuts on `W < 620`, the flag the arc already had. Proof: eight desktop screens at
1440×900 diffed pixel for pixel against the file before the round, zero pixels changed.

The cuts, scene by scene:

- **The arc.** The hero drops its kicker and its skills line and tightens, so the art has the
  top half of the first screen. The canvas draws ONE map on a phone, its rows as bars with the
  state dot and no words (11px in a 90px card reads as noise), and two thirds of the pile while
  it is only a pile; the rest join under the melt as they start to travel. The order beat is a
  screen shorter (`ORDER_SPAN` 3.2 on a phone) and the two rooms hold for less.
- **The grilling.** The guild rail and the channel list go. The chat pane is the whole window,
  and the base type grows from `w / 40` to `w / 33` under 640px, which the desktop window never
  is.
- **The preview.** The phone alone, at 54vw. The desk window behind it was a thumbnail.
- **The atlas.** Two maps instead of three; the walked line and the frontier; the five blocked
  rows and the fog go.
- **The terminal.** The browser tab and URL bar go. The tmux line and the four harness tabs
  stay, because they are the scene.
- **The ticket run.** One object per beat: the Discord phone beside the pull request was a
  sliver on a desk one phone wide, so on the two-lane cards it goes and the pull request stands
  square. The stage holds 52dvh instead of 62, and each beat holds for less scroll.
- **The `git clone` line** wraps instead of clipping.

The scroll budget at 375×667: 18.1 screens, from 20.5. The arc 5.9 (was 7.2), the ticket run
3.5 (was 4.3), the atlas 1.5 (was 2.0), the preview 1.2 (was 0.9, the bigger phone).

**Round 3.** The operator, from the phone: the first two scenes push the curia animation up
and down the screen while scrolling, busy and meaningless; scene 05 could overlay the two
screens, tilted toward each other, alternating which is in front like flip covers; scene 07
does not show the screens at all, the narration titles are in the way, and mobile needs a
different way to tell the story; the close ("just type your rejection reasons", "This page
itself was planned...") goes; the VPS bars are too thin at 8 GB. Desktop still diffs to zero.

- **The arc on a phone is one pipeline in every beat.** The pile above, curia in the middle,
  the map at the foot. Nothing changes place between beats: the pile changes shape (a flat
  ring, then a globe, then it resolves through curia), and the map leaves and comes back by
  the foot. The desktop keyframes, where the maps stand above in the hero and the pile turns
  around curia, were what moved curia. Gated on `W < 620`, in the frame after `keyframes()`.
- **The atlas flips.** Below 40rem both screens share one grid cell, each tilted toward the
  other, the front one whole and the back one dimmed and a step smaller. A 3.6s timer turns
  them. Without the script the atlas stays in front.
- **The ticket run is a stack.** Below 40rem the script moves the ticket under the first
  title and card k under title k, adds `stack` to the section, and the stage is gone: title,
  screen, title, screen, in reading order, nothing held. The beat observer still runs, so the
  ticket's timeline grows as the titles cross the middle. Decided once at load.
- **The close** is hidden below 40rem. It stands on desktop; the dogfood line is an operator
  addition of #508 and stays there until the operator rules on it.
- **The VPS bars** have a floor of 2.4rem per group and label below 40rem, and the free space
  gives it up.

The scroll budget at 375×667: 17.3 screens.

**Round 4.** The operator: the titles 01 and 02 still push the curia animation above and
below; remove them on a phone and go straight to the animation after 02. And the VPS boxes
are too wide at 8 and 16 GB (thirty agents ran past the box).

- **A phone reads the hero and then the order beat.** With the canvas on, claims 01 and 02
  and the room between them are gone below 40rem. The frame forces `rise` to 0 and drives
  `fall` from the arc's own scroll, a third of a screen in, over `ORDER_SPAN` screens; the
  map never leaves the foot. Each claim crossing the screen had shoved the art out of its
  way, and no keyframe change could fix that, because the art's box IS what the words leave.
  With no canvas the three panels stand and read as before, so the locked words are still on
  the page.
- **The bar floor is the even share at most.** The script writes `--gn`, the group count, on
  the strip and the label row, and the phone floor is `min(2.4rem, 100% / var(--gn))`.

Desktop diffs to zero pixels. The scroll budget at 375×667: 16.2 screens, the arc 4.8.

**Round 5.** The operator: the strip is still too wide at 16 GB. Round 4's floor forgot the
gaps between groups: thirty of them at 0.42rem are 13rem on their own. The floor is now the
even share of the row MINUS its gaps, the two rows clip as a backstop, and past a dozen groups
the agent labels are blank rather than slivers of glyph. Measured on the phone at 16 GB and
thirty agents: strip 293px in a 293px row. Desktop diffs to zero.
