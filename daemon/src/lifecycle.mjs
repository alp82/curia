// The merge-gated ending (#54, implementing #48): a dispatched ticket is
// resolved when its work is MERGED, and the worker stays alive through the
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

// The kind the review gate opens under (#54 item 2). Its own kind rather than a
// plain approve-reject, for three reasons: /status must read *awaiting review*
// distinguishably from any other block (item 9), the Stop hook needs a durable
// journal fact for "a human approved this" (item 4), and only the daemon may open
// one — so an approval is never something a worker could stage for itself with a
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

// The prose block for the spawn prompt: a numbered list, in order.
export function endingProse(ctx) {
  const out = []
  ENDING.forEach((step, i) => {
    const lines = step.prose(ctx).map((l) => l.replace('#{n}', `#${ctx.ticket}`))
    out.push(`${i + 1}. ${lines[0]}`)
    for (const l of lines.slice(1)) out.push(`   ${l}`)
  })
  return out
}

// What the Stop hook blocks on. `report_result` ends the sequence WHATEVER its
// status: a worker that reports `blocked` has complied with the one order that
// covers not finishing, and holding it here would trap the very worker that
// cannot comply — the loop #48 refused.
export function outstanding(state) {
  if (state.hasResult) return []
  return ENDING.map((s) => (s.todo ? s.todo(state) : null)).filter(Boolean)
}

// The `reason` a blocked Stop hands back to the worker. It is the only text the
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
// opposite case as a live limit: a worker can hand `ask_human` any string it
// likes for `preview_url`, and a forged link is worst exactly here.
//
// The worker supplies the two things only it knows: what it did, and the
// charting it proposes. #49: that proposal must be CONCRETE in the thread text
// — ticket titles, the lines to be removed — or approval from a phone degrades
// to a rubber stamp and the worker holds full map authority with no gate at all.
export function reviewGateText({ repo, ticket, title, summary, charting, links }) {
  const parts = [
    `**Is ${repo}#${ticket} done?** — ${title}`,
    '',
    '**What the worker did**',
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

export function classifyReviewAnswer(text) {
  const t = String(text ?? '').trim()
  if (APPROVE_RE.test(t)) return { approved: true, feedback: '' }
  return { approved: false, feedback: t }
}
