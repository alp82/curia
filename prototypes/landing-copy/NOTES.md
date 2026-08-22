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
line beside two or three new candidates, with a recommendation per scene. The operator redirected
the round: the headline candidates were all rejected, and the operator asked for different
directions after different qualities, five variations per slot, a free-type row for their own
lines, a "nothing lands" headline choice, and copy buttons to report picks with. The eleven other
questions return in round 2.

**Round 2.** The page rebuilt: five to six candidates per slot, the headline in six directions
each named after its quality (the promise, motion, presence, rigor, the pipeline, ownership,
with "Nothing lands without you." as the rigor one), a `mine` input row on every slot, a copy
button on every row, and a Copy-my-picks bar that copies every pick on the page in one block.
The operator answered with a full pick block: sixteen of their own lines, and picks on every
other slot. The headline is their own: "Coding agents controlled from your phone". The picks are
applied in `index.html` as the round 2 overlay, so every panel reads as the picked page.

**Round 3.** Six findings on the picked lines, each with a proposed `R` fix beside the pick:
the headline drops "many repos, one queue" from the promise (a positioning.md change to record),
a grammar slip in the first-screen paragraph, the harness fact line names Pi and Opencode which
`config/routing.yaml` does not ship today, "PR" beside a page that says pull request, a "just"
plus a contraction in the rejection fact line, and the honesty line dropping "manual today,
packaging coming" which positioning.md keeps. Docker in the need line checked out: the README
setup path is the compose stack now. The operator ruled: the headline stays their line, the
grammar fix is taken, the four-harness line stays as written because support is there soon, the
caption fix is taken but the rejection line stays as written, the need line becomes "One Linux
box with Docker, Tailscale, a Discord server and your coding agent subscription", and the honesty
line stays without the manual-today clause. positioning.md records the overrides with this ticket.

**Round 4.** Two drifts against locked decisions, named before the gate: the picked dogfood line
carries no regenerated count and no pull-request link, which the storyboard locked, and the three
claim bold lines no longer carry the claim wording that positioning.md keeps. The operator ruled:
the dogfood line stays without a count, with "planned, decided" linked to the tickets and
"written" linked to the pull requests. The claim wording is confirmed, and the scene 3 story line
takes the GitHub tail. positioning.md records both with this ticket.

## The verdict

**The words of every scene are locked.** The final build ([#551](https://github.com/alp82/curia/issues/551),
on the map [Ship the story landing page](https://github.com/alp82/curia/issues/600)) builds these
lines and no others:

1. **The first screen** — kicker: "self-hosted agent dispatcher" · headline: "Coding agents
   controlled from your phone" · paragraph: "Curia knows about all your projects and tells you
   what to build next. It helps you dispatch parallel agents without losing track." · skills
   line: "Built on Matt Pocock’s skills." · buttons: "Set it up · GitHub".
2. **Into the mess** — "The backlog panic grows".
3. **Maps bring order** — bold: "Maps turn the pile into a queue." · story: "Blocked tickets
   wait. Open ones light up, and agents take them in order, straight from your GitHub issues." ·
   no fact line.
4. **The grilling** — bold: "Answer from the couch." · story: "An agent hits a real decision and
   asks you in Discord." · fact: "one thread per ticket · parallel chats".
5. **The preview** — "Live previews from your phone or workstation" · fact: "A secure link on
   your tailnet".
6. **The atlas** — "A dashboard that shows where every map stands and which agents are currently
   running."
7. **The harness, live** — "Watch the agent type in your browser tab." · fact: "Claude Code,
   Codex, Pi and Opencode are supported". The operator says this support lands soon. The build
   checks `config/routing.yaml` on build day: today it ships `claude` and `codex` only, and the
   line must not ship ahead of the code.
8. **One ticket on GitHub** — bold: "You are in charge" · climax caption: "Your approval merges
   the pull request and closes the ticket" · fact: "just type your rejection reasons if you
   don't agree with the result" · dogfood: "This page itself was planned, decided and written by
   curia agents.", with "planned, decided" linked to the tickets and "written" linked to the
   merged pull requests. No count.
9. **Your VPS** — bold: "Your VPS is enough." · fact: "four agents at once on a small box ·
   about 0.5 GB each".
10. **Open source** — bold: "Open source." · fact: "Your box, your subscription, your keys."
11. **Set it up** — heading: "Set it up" · what you need: "One Linux box with Docker, Tailscale,
    a Discord server and your coding agent subscription" · closing line: "All steps are described
    in the set up guide", linking the README.
12. **Footer** — "curia · source on GitHub".

No line on the page regenerates on build day any more: the counts left with the dogfood pick and
the cut scene 3 fact line. The overrides of earlier decisions are recorded in
[positioning.md](../../docs/landing-page/positioning.md) by this ticket.
