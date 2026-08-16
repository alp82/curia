// The card mocks for ticket #415, kept beside the page that renders them.
//
// One real past escalation, mocked four ways, then three Details affordances on
// the same card. `build.mjs` inlines this array into `index.html`, so the page
// stays one self-contained file. Edit the verdicts here, then run the build. Do
// not edit the generated block inside `index.html` by hand.
//
// The subject is the escalation from ticket #377, "Cooling dies with the
// daemon". Map #413 quotes its prose as the anti-example that started this
// effort, so it is the fairest card to rebuild.
//
// `source` is the EXACT text sent to the #415 thread through `notify`. The
// thread is the render evidence. This page holds the source so a later ticket
// reproduces any row without a screenshot.
//
// verdict: pick | drop | null (null means the operator has not judged it yet).

export const SUBJECT = {
  ticket: 'alp82/curia#377',
  url: 'https://github.com/alp82/curia/issues/377',
  title: 'Cooling dies with the daemon',
  question: 'Is rate-limit cooling re-armed at boot, and from what source?',
  answer: 'The journal, and only the journal. Landed caps only, armed in the store constructor.',
}

export const VARIANTS = [
  {
    kind: 'card',
    n: 1,
    name: 'Today\'s card',
    adds: 'The control. One prose block, no headline, no options, no example, no visual.',
    source: `-# rehearsal #415 · card 1 of 4 · today's shape
**[esc-1]** \`curia-377\` asks (*free-text*):
Cooling is in memory and never persisted (settled answer 6). A 5-hour window outlives a deploy, so today the next start spawns a container, walks into the cap, and cools again from a fresh reading. #346 needed the arm to survive a restart and made it a store reduction, and the cooling itself was left alone because the resume fires after the window rolls. The journal already carries \`provider_cooling\` and \`model_cooling\` with \`reset_at\` and \`reset_source\`, so the evidence for a boot re-arm is written. Should cooling be re-armed at boot, and from what source? A fresh account reading answers a different question, which is #339's trigger and not this one, so I recommend the journal.

_Reply in this thread to answer._`,
    look: 'The decision is in the second half of a paragraph. The options are never listed, so the operator has to build them from the prose. This is the shape that produced the anti-example on the map.',
    verdict: {
      pick: "drop",
      label: "NOT PICKED",
      why: "The control. The decision sits in the second half of a paragraph and the options are never listed, so the operator has to build them from the prose.",
    },
  },
  {
    kind: 'card',
    n: 2,
    name: 'Headline and options with consequences',
    adds: 'A one-line headline, then one option per line with the consequence under it.',
    source: `-# rehearsal #415 · card 2 of 4 · headline + consequences
**[esc-1]** \`curia-377\` asks (*choice*):

**A restart forgets every rate-limit cooling. Re-arm it at boot, and from what?**

Cooling lives in memory only. A deploy inside a 5-hour window clears it. The next start then spends a container on a cap curia already measured.

**A. From the journal.** Re-read the caps curia already landed.
↳ curia waits at the next start and spends no container. A guessed reset can hold at most 55 minutes too long.

**B. From a fresh account reading.** Ask the provider at boot.
↳ This answers "am I near the cap", not "did I hit one". It can hold the frontier on a reading that already rolled. It costs one API call per boot.

**C. Leave it in memory.** A restart clears cooling.
↳ Every deploy inside a window costs one container. This is the behavior today.

Recommendation: **A**.`,
    look: 'The headline carries the whole decision in one line. Each option states its own cost, so nothing has to be inferred from the prose above it.',
    verdict: {
      pick: "part",
      label: "THE MANDATORY FLOOR",
      why: "Its three fields become the mandatory floor of card 4: a headline, the options, and one consequence per option. An agent may not drop any of them.",
    },
  },
  {
    kind: 'card',
    n: 3,
    name: 'Plus an example per option',
    adds: 'Card 2, and one concrete example under each consequence.',
    source: `-# rehearsal #415 · card 3 of 4 · + an example per option
**[esc-1]** \`curia-377\` asks (*choice*):

**A restart forgets every rate-limit cooling. Re-arm it at boot, and from what?**

Cooling lives in memory only. A deploy inside a 5-hour window clears it. The next start then spends a container on a cap curia already measured.

**A. From the journal.** Re-read the caps curia already landed.
↳ A guessed reset can hold at most 55 minutes too long.
› You deploy at 13:02. \`start curia#390\` at 13:03 answers "opus cools until 14:20", and no container starts.

**B. From a fresh account reading.** Ask the provider at boot.
↳ It answers "am I near the cap", not "did I hit one". One API call per boot.
› The boot reading says 41% used, so curia starts the ticket. The cap that landed at 09:00 is invisible, and the container dies on it.

**C. Leave it in memory.** A restart clears cooling.
↳ Every deploy inside a window costs one container.
› \`start curia#390\` clones a worktree, starts a container, and the first turn dies on the cap.

Recommendation: **A**.`,
    look: 'B\'s example is the one that earns its line: it names the failure the consequence only gestures at. C\'s example restates its own consequence in longer words. That is what a mandatory example field produces when the option has nothing left to show.',
    verdict: {
      pick: "part",
      label: "ITS EXAMPLE IS A JUDGMENT FIELD",
      why: "The example survives, but as a judgment field, not a required one per option. Option C's example is the evidence: it restates its own consequence in longer words, which is what a mandatory field produces when the option has nothing left to show.",
    },
  },
  {
    kind: 'card',
    n: 4,
    name: 'Plus a visual',
    adds: 'Card 3, and one width-capped ASCII timeline. The visual replaces the intro paragraph.',
    source: `-# rehearsal #415 · card 4 of 4 · + a visual
**[esc-1]** \`curia-377\` asks (*choice*):

**A restart forgets every rate-limit cooling. Re-arm it at boot, and from what?**

\`\`\`
09:00  cap lands, cooling until 14:20
13:02  deploy ......... memory wiped
13:03  start curia#390
        A journal -> waits, no container
        B reading -> starts, dies at cap
        C memory  -> starts, dies at cap
\`\`\`

**A. From the journal.** Re-read the caps curia already landed.
↳ A guessed reset can hold at most 55 minutes too long.
› \`start\` at 13:03 answers "opus cools until 14:20".

**B. From a fresh account reading.** Ask the provider at boot.
↳ It answers "am I near the cap", not "did I hit one". One API call per boot.
› The boot reading says 41% used, so the 09:00 cap is invisible.

**C. Leave it in memory.** A restart clears cooling.
↳ Every deploy inside a window costs one container.
› 13:03 clones a worktree and the first turn dies on the cap.

Recommendation: **A**.`,
    look: 'The diagram carries the three outcomes side by side, so the intro paragraph and half of every example come out. A visual earns its space by removing prose, not by sitting beside it. Width is 42 columns, the cap #414 set.',
    verdict: {
      pick: "pick",
      label: "PICKED - THE TARGET SHAPE",
      why: "The operator picked this shape. The example and the visual inside it stay agent judgment, so a card that needs neither is still card 4.",
    },
  },

  {
    kind: 'details',
    n: 5,
    name: 'Details as a spoiler',
    adds: 'The evidence rides the same message, hidden behind a tap.',
    messages: 1,
    source: `-# rehearsal #415 · details 1 of 3 · spoiler
**[esc-1]** \`curia-377\` asks (*choice*): **A restart forgets every rate-limit cooling. Re-arm it at boot, and from what?** (A journal / B fresh reading / C leave it)

Details: ||\`#handleLimit\` has journalled \`model_cooling\` and \`provider_cooling\` with \`reset_at\` and \`reset_source\` since #175, so this reads events curia already writes. #346 made the limit resume a store reduction and left cooling alone. #339 decides cooling BEFORE a cap lands, which is a different trigger and a different ticket.||`,
    look: 'One message, one tap, no button and no second post. #414 already proved the render. The cost is that a long detail block still lives inside the card, so the card grows even while it looks short.',
    verdict: {
      pick: "part",
      label: "KEPT AS THE SHORT FIELD",
      why: "Kept, but as one of two typed fields rather than the whole answer. A short detail renders as a spoiler in the card. It carries facts, and it takes a character cap, because this 334-character block put a paragraph of argument back inside the card.",
    },
  },
  {
    kind: 'details',
    n: 6,
    name: 'Details as a follow-up small print',
    adds: 'The card posts, then a second message carries the evidence in small print.',
    messages: 2,
    source: `-# rehearsal #415 · details 2 of 3 · follow-up small print
**[esc-1]** \`curia-377\` asks (*choice*): **A restart forgets every rate-limit cooling. Re-arm it at boot, and from what?** (A journal / B fresh reading / C leave it)`,
    followUp: `-# Details: #175 already journals model_cooling and provider_cooling with reset_at, so this reads events curia writes today. #346 left cooling alone. #339 is the before-the-cap trigger.`,
    look: 'The card stays short, and the evidence never has to be opened. #414 caps small print at ONE line, so this affordance also caps the detail length. Two stacked small-print lines read as one mangled line on a phone.',
    verdict: {
      pick: "drop",
      label: "NOT PICKED",
      why: "Dropped. It costs a second message, and #414 caps small print at one line, so the affordance caps the detail length rather than the agent judging it.",
    },
  },
  {
    kind: 'details',
    n: 7,
    name: 'Details as a timeline link',
    adds: 'The card carries a pointer. The evidence stays on the timeline.',
    messages: 1,
    source: `-# rehearsal #415 · details 3 of 3 · timeline link
**[esc-1]** \`curia-377\` asks (*choice*): **A restart forgets every rate-limit cooling. Re-arm it at boot, and from what?** (A journal / B fresh reading / C leave it)

Details: the agent's own timeline, \`/timeline/curia-377\`. curia composes the real link.`,
    look: 'The card cannot grow, whatever the agent wants to say. The cost is a trip out of Discord, and the timeline shows the agent\'s turns, not a written argument for this decision.',
    verdict: {
      pick: "pick",
      label: "PICKED - THE DETAILS FIELD",
      why: "The operator picked this. It carries the reasoning behind the decision, and the card cannot grow whatever the agent wants to say. curia composes the link from its own records, so this field is a flag the daemon renders, never text the agent writes.",
    },
  },
]
