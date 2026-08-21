# The landing page storyboard

Prototype for [Storyboard the final landing page](https://github.com/alp82/curia/issues/567),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).
It stands between the grilling ([#550](https://github.com/alp82/curia/issues/550)) and the final
build ([#551](https://github.com/alp82/curia/issues/551)).

This directory is throwaway code. It answers one question: the order and the rough contents of
every scene of the final landing page, before the final build. It is not the live page, and it is
not the final prototype.

## What it is

One self-contained HTML file, `index.html`, at wireframe fidelity on purpose. Each card is one
scene of the final page, in page order. The grey boxes are sketches, not the design. The letters
inside a scene are word candidates, and they repeat across arcs, so a pick carries over.

Switch arcs with the bar at the bottom, the arrow keys, or `?arc=`:

| Key | Name | Logic |
|---|---|---|
| `story` | The operator's story | Dictated at round 1: projects, the mess, maps bring order, grilling, preview, atlas, harness, lifecycle, the self-hosted close. |
| `saga` | The saga, tightened | The five acts as picked at #508, proof moments folded into the acts they prove. |
| `diary` | One ticket's diary | The whole page follows one named ticket from the pile to the merge. |
| `phone` | The phone first | The phone arrives right after the mess, the queue is revealed behind it. |
| `drain` | The queue drains | The page stays wide: maps fill, four lanes run at once, gates come to one phone. |

Fixed by earlier decisions, not up for a vote here: the bare first screen, the honesty block after
the story and before the guide, no sound and no bottom bar on the final page, and the banned words
and moves of [positioning.md](../../docs/landing-page/positioning.md).

Run it:

```
python3 -m http.server 9018 --bind 0.0.0.0 --directory prototypes/landing-storyboard
```

## The rounds

<!-- One entry per operator round: what was offered, what came back. -->

**Round 1.** Four arcs with lettered word candidates inside every scene, and a thirteen-question
round on the arc, the words and the guide depth. The operator redirected the round: the arc first,
the copy later, and the copy decision extracted into its own prototype ticket. All four arcs hold
good elements, and the operator dictated a story of their own in eleven scenes: three projects with
steady unorganized work, the zoom into the mess, maps bring order (up to two screens, out of the
drain arc), the grilling with A/B/C on Discord, preview prototypes on the phone, the atlas
dashboard with maps and what needs you (mobile first), the real harness in the browser with a
toggle across the supported ones, the ticket lifecycle on GitHub as a horizontal sub story (out of
the diary arc), self-hosted on your VPS with parallel agents, open source with GitHub and
Tailscale, and the footer with the GitHub link. Round 2 builds that story as the lead arc and drops
the word candidates from the cards.

**Round 2.** The operator merged the first two scenes: the first screen tells the story above the
fold, with grey drifting tickets funneling through a prominent curia node into ordered maps, and
the kicker and headline sit readable at the bottom of the screen. The scroll then dives into the
mess (former scene 3) and continues into the ordering beat (former scene 4). This overrides the
bare-first-screen rule from the grilling, and positioning.md changes with this ticket. The three
placement questions of round 2 (the approve moment, the dogfood line, the honesty card) got no
answer and return in round 3.

**Round 3.** The merged first screen is confirmed. The approve moment is the climax of the GitHub
lifecycle scene, and the dogfood line closes that scene, real count regenerated and pull requests
linked. The honesty block leaves the page. Its three facts live on in the guide, which still names
Tailscale, Discord and the harness login, and stays honest that setup is manual with packaging
coming. That is the second override of a grilling rule, and positioning.md changes with this
ticket. The story arc is twelve scenes.

**Round 4.** The guide shows the five condensed steps only. The complete thirteen live in the
README, which the page links.

## The verdict

**The story arc, twelve scenes, is the storyboard of the final page.** In page order:

1. The first screen, merged with the story: drifting tickets funnel through a prominent curia
   node and come out as ordered maps. The kicker and the headline sit readable at the bottom.
2. Into the mess: the scroll dives into the drift seen above the fold.
3. Maps bring order: the long beat, up to two screens. Edges draw in, takeable tickets light up
   and drain into a queue. Carries claim 1, your tracker is the queue.
4. The grilling: a Discord thread writes itself, a real question with A, B and C buttons.
   Carries claim 2, any device is a full seat.
5. The preview: the phone fills the scene with a running preview of the agent's work.
6. The atlas: every map, its progress, and the needs-you row. Mobile first.
7. The harness, live: the real terminal in the browser, a toggle across Claude Code and Codex CLI.
8. One ticket on GitHub: a horizontal sub story from issue to merge. The approve button is the
   climax, and the dogfood line closes the scene, real count regenerated, pull requests linked.
   Carries claim 3, an agent cannot finish by talking.
9. Your VPS: one box, four agent lanes at once, the measured numbers.
10. Open source: the repo, Tailscale, your keys.
11. Set it up: the five condensed steps only. The complete thirteen live in the README.
12. Footer with the GitHub link.

**Cut**: the honesty block (round 3). Its facts live in the guide. **Changed**: the bare first
screen rule (round 2). Both overrides are recorded in positioning.md by this ticket.

**Extracted**: the words of every scene. Copy is a follow-up prototype ticket, judged in its own
rounds, between this storyboard and the final build (#551).
