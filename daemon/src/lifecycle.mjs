// The merge-gated ending (#54, implementing #48): a dispatched ticket is
// resolved when its work is MERGED, and the agent stays alive through the
// review to do it.
//
//   work → commit → open_pull_request → publish_preview → request_review
//        ↓ rejected: more commits, ask again        ↓ approved
//                                             merge → resolve → report_result
//
// ONE structure, read twice. `ENDING` renders as prose in the spawn prompt
// (workspace.mjs) and as the outstanding checklist the Stop hook blocks with
// (dispatch.mjs). #49 recorded that authoring those two separately is exactly
// the duplication it deleted — so this file is the only copy, and a step whose
// prose and whose checklist line disagree is a single edit away, not two.
//
// `todo(state)` is PURE, over the state dispatch.mjs gathers. A step with no
// `todo` is prose only: the resolve step is daemon-invisible (#49 — there is no
// expected value to compare a charting proposal against), and committing is not
// required at all, since a grilling ticket resolves with a comment and no code.
//
// Since #160 there is more than one ending, and every one of them is read the
// same two ways: `ENDING` for a ticket dispatch, `CHARTING_ENDING` for a map one
// (#160), and `REVIEW_ENDING` for the cross-check reviewer (#164). `listFor`
// picks, in the one function each caller already goes through.

// The kind the review gate opens under (#54 item 2). Its own kind rather than a
// plain approve-reject, for three reasons: /status must read *awaiting review*
// distinguishably from any other block (item 9), the Stop hook needs a durable
// journal fact for "a human approved this" (item 4), and only the daemon may open
// one — so an approval is never something an agent could stage for itself with a
// hand-rolled ask_human.
export const REVIEW_KIND = 'review-gate'

export const ENDING = [
  {
    key: 'commit',
    prose: ({ branch }) => [
      `Commit your work locally on \`${branch}\`. Never \`git push\`: curia pushes for you.`,
    ],
  },
  {
    key: 'pr',
    prose: () => [
      'If you committed anything, call `open_pull_request`. curia pushes the branch and opens the pull',
      'request. Call it again after later commits — it updates the same pull request.',
    ],
    todo: (s) => (s.hasCommits && !s.prOpened
      ? 'call `open_pull_request` — your branch holds commits that are in no pull request yet'
      : null),
  },
  {
    key: 'preview',
    prose: () => [
      'If there is something to look at, start the dev server and call `publish_preview` with its port and',
      'the path of the page you changed. The link curia shows the human is the one it composed from that',
      'call, so a missing path sends them to the site root (#68).',
    ],
  },
  {
    key: 'review',
    prose: () => [
      'Call `request_review`: a summary of what you did, plus the charting you propose for the map. Keep',
      'both SHORT — the human reads them on a phone and judges the work through the links, so a gate that',
      'scrolls for screens hides its own approve button. It blocks until a human answers. A rejection comes',
      'back as their own words — make the changes, commit, call `open_pull_request` again, then',
      '`request_review` again. The loop has no limit.',
    ],
    todo: (s) => (s.reviewApproved
      ? null
      : 'call `request_review` and get an approval — nothing here is resolved until a human approves it'),
  },
  {
    key: 'merge',
    prose: ({ repo }) => [
      `Only after the approval: merge it — \`gh pr merge <url> --repo ${repo} --squash --delete-branch\`.`,
      'This is the one write to the remote you own, and it is limited to what the human just approved.',
    ],
    todo: (s) => (s.reviewApproved && s.prOpened && s.prState === 'OPEN'
      ? 'merge the approved pull request — the tracker must not state a decision whose code is not in the default branch'
      : null),
  },
  {
    key: 'resolve',
    prose: ({ mapNumber, repo }) => (mapNumber
      ? [
        'Then resolve the ticket: the resolution comment, the close, the map line, and the charting the',
        'human approved — the resolve step of the skill you are running, in that order.',
      ]
      : [
        `Then resolve the ticket on the tracker with \`gh\`: post the resolution as a comment on ${repo}#{n},`,
        'then close it.',
      ]),
  },
  {
    key: 'report',
    prose: () => [
      'Call `report_result` exactly once, and stop.',
    ],
    todo: (s) => (s.hasResult ? null : 'call `report_result` exactly once'),
  },
]

// ---- the charting ending (#160) ----------------------------------------------
//
// A map dispatch has a different ending, because it produces a different thing.
// A ticket agent's output is CODE, so the ending is the merge gate: pull
// request → review → merge → resolve. A charting agent's output is the MAP
// ITSELF — issue bodies and child issues on the tracker — which is inside an
// agent's ordinary write bounds and cannot be staged in a branch at all. There
// is nothing to push, so there is nothing for a review gate to show, and #149
// settled the trade: no gate, an operator in the loop, and the strongest model.
//
// So four steps of ENDING are not merely skipped here — they are refused
// (dispatch.mjs turns `open_pull_request` and `request_review` down for a
// charting agent). What is left is the map edit, and the one call that ends
// every dispatch.
//
// The summary comment is deliberately NOT a step. The daemon posts it from the
// `report_result` summary (see chartingComment in resolve.mjs), for the same
// reason the review gate composes its own links: a record curia writes from its
// own knowledge of what happened is evidence, and one the agent writes about
// itself is an account. It also keeps the Stop-hook checklist off a `gh` read
// at the end of every turn.
export const CHARTING_ENDING = [
  {
    key: 'chart',
    prose: ({ repo, ticket }) => [
      `Update the map: edit ${repo}#${ticket}'s body, and create, edit or close its child tickets.`,
      'Those tracker writes ARE the work. Nothing here is staged, reviewed or merged.',
    ],
  },
  {
    key: 'report',
    prose: () => [
      'Call `report_result` exactly once, with `resolved` and a summary of what you changed on the map.',
      'curia posts that summary as a comment on the map. It never closes the map.',
    ],
    todo: (s) => (s.hasResult ? null : 'call `report_result` exactly once'),
  },
]

// What a charting agent must NOT do — one bullet per entry, its own lines.
// Prose only: the refusals themselves live in dispatch.mjs, and this is the
// copy the model reads.
export const CHARTING_NEVER = [
  ['Never close the map. It is the standing artifact, not a ticket you resolve.'],
  [
    'Never call `open_pull_request` or `request_review`, and never merge anything. curia refuses both',
    'calls on a map dispatch. There is no review gate here: the operator who dispatched you is the check.',
  ],
  [
    'The resolve protocol — resolution comment, close, Decisions-so-far line — belongs to a TICKET',
    "agent. Do not run it, and do not resolve any of the map's children yourself.",
  ],
]

// ---- the reviewer's ending (#164, ADR-0010) ----------------------------------
//
// A third ending, and the smallest one there is. The cross-check reviewer
// produces no code, no tracker write and no map edit — it produces a VERDICT, a
// text the daemon captures and holds for the return path (#165). So there is one
// step, and the daemon refuses every tool that could add a second.
//
// The reviewer is never held past that one call: an agent that cannot push,
// cannot comment and cannot ask has nothing else it could be nudged toward.
export const REVIEW_ENDING = [
  {
    key: 'verdict',
    prose: ({ ticket }) => [
      `Call \`report_result\` exactly once, with the verdict as its \`summary\` and \`${ticket}\` as its`,
      'ticket — the bare number, not a qualified one. That text IS your output: curia captures it and',
      'holds it. Nothing else you do reaches anyone.',
    ],
    todo: (s) => (s.hasResult ? null : 'call `report_result` once, with your verdict as the summary'),
  },
]

// What the reviewer must NOT do — one bullet per entry, its own lines. Prose
// only: the refusals themselves live in dispatch.mjs, and this is the copy the
// model reads.
export const REVIEWER_NEVER = [
  [
    'Write nothing. No commit, no push, no merge, no branch, no file edit in the checkout. It is there',
    'to be read and to run tests in, and every change you make to it is thrown away.',
  ],
  [
    'No tracker write. Do not comment on the ticket, do not label it, do not close it, and do not touch',
    'the map or any other issue. Read the tracker as much as you like.',
  ],
  [
    'No gate and no question. curia refuses `open_pull_request`, `request_review`, `publish_preview`',
    'and `ask_human` for you. A doubt you cannot settle belongs IN the verdict, named as a doubt.',
  ],
  [
    'You are not the builder. Do not fix what you find, and do not judge whether the ticket should be',
    'approved. You state findings; a human decides.',
  ],
]

const listFor = (state) => {
  if (state.reviewer) return REVIEW_ENDING
  return state.charting ? CHARTING_ENDING : ENDING
}

// The prose block for the spawn prompt: a numbered list, in order.
export function endingProse(ctx) {
  const out = []
  listFor(ctx).forEach((step, i) => {
    const lines = step.prose(ctx).map((l) => l.replace('#{n}', `#${ctx.ticket}`))
    out.push(`${i + 1}. ${lines[0]}`)
    for (const l of lines.slice(1)) out.push(`   ${l}`)
  })
  return out
}

// What the Stop hook blocks on. `report_result` ends the sequence WHATEVER its
// status: an agent that reports `blocked` has complied with the one order that
// covers not finishing, and holding it here would trap the very agent that
// cannot comply — the loop #48 refused.
export function outstanding(state) {
  if (state.hasResult) return []
  return listFor(state).map((s) => (s.todo ? s.todo(state) : null)).filter(Boolean)
}

// The `reason` a blocked Stop hands back to the agent. It is the only text the
// model sees, so it names the step rather than the policy.
export function stopReason(items, { attempt, budget }) {
  return [
    `curia: this ticket is not finished. ${items.length} step${items.length > 1 ? 's' : ''} outstanding:`,
    ...items.map((t) => `- ${t}`),
    '',
    `Do the next one, then stop again (nudge ${attempt} of ${budget}; after that curia stops holding you`,
    'here and reports the ticket unfinished).',
  ].join('\n')
}

// ---- the review gate ---------------------------------------------------------

// The gate's payload. Every link is composed by the DAEMON from its own records
// — an allocated preview rule, a pull request it pushed, the ticket it claimed —
// because the links are the evidence the human approves on. #40 recorded the
// opposite case as a live limit: an agent can hand `ask_human` any string it
// likes for `preview_url`, and a forged link is worst exactly here.
//
// The agent supplies the two things only it knows: what it did, and the
// charting it proposes. #49: that proposal must be CONCRETE in the thread text
// — ticket titles, the lines to be removed — or approval from a phone degrades
// to a rubber stamp and the agent holds full map authority with no gate at all.
export function reviewGateText({ repo, ticket, title, summary, charting, links }) {
  const parts = [
    `**Is ${repo}#${ticket} done?** — ${title}`,
    '',
    '**What the agent did**',
    summary.trim() || '(nothing said)',
    '',
    '**Charting it proposes for the map**',
    charting.trim() || '(nothing said)',
    '',
    '**Look at**',
    ...links.map((l) => `- ${l}`),
  ]
  // No length cap (#108 item 16 follow-through): the pre-#119 self-truncation
  // cut exactly the charting the gate exists to judge. The bridge chunks long
  // messages at paragraph boundaries now, buttons on the last chunk — so the
  // gate hands over the whole payload and the durable record matches what the
  // human was shown, in full.
  return { text: parts.join('\n') }
}

// Approval is a narrow set on purpose. The ✅ button sends the literal
// `approve`; everything else — a thread reply, the ❌ button — is a rejection
// carrying feedback, because a false reject costs one more loop while a false
// approve merges code no one read.
const APPROVE_RE = /^(approve|approved|lgtm)$/i

// The third button (#165, ADR-0010). The 🔎 button sends this literal word, and
// an operator who types it in the thread means the same thing. It is neither
// half of the two-way answer: nothing merges and nothing is rejected, so the
// narrow-set rule above costs nothing here — a press the operator did not mean
// spends quota on a second reading and ends where it started.
export const CROSS_CHECK_ANSWER = 'cross-check'
const CROSS_CHECK_RE = /^cross[- ]?check$/i

export function classifyReviewAnswer(text) {
  const t = String(text ?? '').trim()
  if (APPROVE_RE.test(t)) return { approved: true, crossCheck: false, feedback: '' }
  if (CROSS_CHECK_RE.test(t)) return { approved: false, crossCheck: true, feedback: '' }
  return { approved: false, crossCheck: false, feedback: t }
}

// ---- the builder's duty after a cross-check (#165, ADR-0010) -----------------
//
// ONE copy, read twice, the same discipline `ENDING` runs on. The builder is
// told this in its standing orders at spawn time (workspace.mjs), and told it
// again in the tool result that hands it the verdict (dispatch.mjs) — hours or
// days later, in a context that may no longer hold the prompt.
//
// The shape ADR-0010 fixes: the verdict is not an authority. The builder judges
// it, the operator decides, and the gate that follows is a plain
// approve-or-reject about the final code.
// One bullet per entry, its own lines — the CHARTING_NEVER shape, so both
// readers render it the same way.
export const CROSS_CHECK_DUTY = [
  [
    'Judge every finding on its own, and say whether you agree or disagree with it. A reviewer that',
    'read the diff cold can be wrong, and saying so is your job — not deferring to it.',
  ],
  [
    'Write one summary with a recommendation, and send it with `ask_human`. A plain question, never a',
    'gate: the operator decides what happens to a finding, and you get the first word, not the last.',
  ],
  [
    'Act only on the answer they give you. Then call `request_review` again, and that gate is a pure',
    'approve-or-reject about the final code.',
  ],
  [
    'A finding that sits beyond this ticket becomes a charting line in that gate. Never open a fault',
    'ticket for it yourself.',
  ],
]

// The bullet block both readers print. One function, so the prompt and the tool
// result can never drift into two renderings of one list.
export const dutyLines = (indent = '') => CROSS_CHECK_DUTY
  .flatMap(([first, ...rest]) => [`${indent}- ${first}`, ...rest.map((l) => `${indent}  ${l}`)])
