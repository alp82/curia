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
