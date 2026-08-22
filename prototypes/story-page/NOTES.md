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

## The verdict

<!-- Filled at resolution. -->
