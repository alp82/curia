# The words of every scene

Prototype for [Choose the words of every scene of the final page](https://github.com/alp82/curia/issues/587),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).
It stands between the storyboard ([#567](https://github.com/alp82/curia/issues/567)) and the final
build ([#551](https://github.com/alp82/curia/issues/551)).

This directory is throwaway code. It answers one question: the words inside each of the twelve
locked scenes, before the final build. It is not the live page, and it is not the final prototype.

## What it is

One self-contained HTML file, `index.html`. Each card is one scene, in the locked order of
[the storyboard](../landing-storyboard/NOTES.md). Each card holds the copy slots of its scene, and
each slot holds lettered candidates. A tap on a candidate puts it into the "reads as" panel, which
shows the scene in the look of the live page. A `current` badge marks a line that is on the live
page or in the storyboard today. A `new` badge marks a line this ticket offers. A dagger (†) marks
a number the final build regenerates on build day.

The rules are [positioning.md](../../docs/landing-page/positioning.md): the voice is plain and
concrete, the promise stays, and the banned words and moves hold. The bottom of the page lists
every new line, which is the list the review gate carries.

The round 1 candidate set of [#567](https://github.com/alp82/curia/issues/567) is not in git
history. The branch was squashed to one commit before its pull request opened, so the candidates
here start from the live page and the storyboard instead.

Run it:

```
python3 -m http.server 9021 --bind 0.0.0.0 --directory prototypes/landing-copy
```

## The rounds

<!-- One entry per operator round: what was offered, what came back. -->

**Round 1.** Twelve questions, one per scene, against the preview. Each slot offered the current
line beside new candidates, with a recommendation per scene: keep the approved claim lines and the
promise, shorten the first-screen paragraph, take the personal mess line, and fold the stats into
one dogfood line with the count regenerated on build day.

## The verdict

<!-- Filled when the operator locks the words. -->
