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
        // The map-close is curia-side context, not skill doctrine: manual
        // wayfinder sessions close an emptied map by judgment, and a checklist
        // session exercises none past its steps — so the checklist says it.
        'If your close left the map with no open child and nothing under Not yet specified, close the',
        'map itself with a verdict comment: the way is walked, and no one else is dispatched to say so.',
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

// ---- the charting ending (#160, grown by #297 out of #286 and ADR-0008) ------
//
// A map dispatch produces a different thing from a ticket one. Its first output
// is the MAP ITSELF — issue bodies and child issues on the tracker — which is
// inside an agent's ordinary write bounds and cannot be staged in a branch at
// all. There is nothing to push and nothing for a review gate to show, and #149
// settled that trade: no gate, an operator in the loop, and the strongest model.
//
// #286 gave the same session a SECOND output. Version 1.2 of the wayfinder
// skill ends charting by firing a `/research` subagent per research ticket it
// just created, and those subagents write files. The old reasoning — no branch
// to stage it in, nothing for a pull request to carry — is false whenever they
// do. So the ending forks on one fact: did this session produce any file?
//
//   no files   edit the map, then `report_result` — the two steps #160 shipped.
//   files      commit → open_pull_request → request_review → merge → close the
//              research tickets → `report_result`. ADR-0008 in full: resolved
//              means merged for a research ticket exactly as for any other, and
//              the close comes AFTER the merge, which is the #48 failure.
//
// The fork lives in the `todo`s, never in the list. Every step below is prose
// the agent reads, and `hasCommits` decides which of them the Stop hook holds it
// to — so a session that wrote nothing is still held to `report_result` alone.
//
// The summary comment is deliberately NOT a step. The daemon posts it from the
// `report_result` summary (see chartingComment in resolve.mjs), for the same
// reason the review gate composes its own links: a record curia writes from its
// own knowledge of what happened is evidence, and one the agent writes about
// itself is an account.

// The five landing steps a charting session owes ONLY when it produced files
// (#297). Shared by both charting endings, because a new-map session fires the
// same research subagents the moment it creates the tickets.
const CHARTING_LANDING = [
  {
    key: 'commit',
    prose: ({ branch }) => [
      `If your research subagents wrote findings, commit them locally on \`${branch}\` — the notes under`,
      '`docs/research/` and the index rows you wrote for them, and no other file. Never `git push`: curia',
      'pushes for you. A session that wrote no file skips this step and the four below it.',
    ],
    // The one step of this ending the daemon CAN see without a commit: a
    // finding sitting uncommitted in the worktree dies with the workspace, and
    // "no commits" alone reads exactly like a session that researched nothing.
    todo: (s) => (s.uncommittedFindings
      ? 'commit the research findings sitting uncommitted under `docs/research/` — a file no commit holds dies with this workspace. Delete the ones that should not land'
      : null),
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
    key: 'review',
    prose: () => [
      'Call `request_review`: what you charted, what the research found, and any contradiction between two',
      'findings. It blocks until a human answers. A rejection comes back as their own words — fix, commit,',
      'call `open_pull_request` again, then `request_review` again. The loop has no limit.',
    ],
    todo: (s) => (s.hasCommits && !s.reviewApproved
      ? 'call `request_review` and get an approval — findings nobody approved resolve no research ticket'
      : null),
  },
  {
    key: 'merge',
    prose: ({ repo }) => [
      `Only after the approval: merge it — \`gh pr merge <url> --repo ${repo} --squash --delete-branch\`.`,
      'This is the one write to the remote you own, and it is limited to what the human just approved.',
    ],
    todo: (s) => (s.hasCommits && s.reviewApproved && s.prOpened && s.prState === 'OPEN'
      ? 'merge the approved pull request — a research ticket is not resolved until its findings are in the default branch'
      : null),
  },
  {
    key: 'close',
    prose: () => [
      'Only after the merge: resolve each research ticket you burned down — its resolution comment, its',
      'close, then its line in the map\'s Decisions so far. Never close one before the merge: a ticket',
      'closed on unmerged findings makes the map state an answer no branch carries (#48).',
    ],
  },
]

export const CHARTING_ENDING = [
  {
    key: 'chart',
    prose: ({ repo, ticket }) => [
      `Update the map: edit ${repo}#${ticket}'s body, and create, edit or close its child tickets.`,
      'Those tracker writes ARE the work, and nothing stages them. Burn down the research tickets you',
      'create in the same session, one `/research` subagent each.',
    ],
  },
  ...CHARTING_LANDING,
  {
    key: 'report',
    prose: () => [
      'Call `report_result` exactly once, with `resolved` and a summary of what you changed on the map.',
      'curia posts that summary as a comment on the map. It never closes the map.',
    ],
    todo: (s) => (s.hasResult ? null : 'call `report_result` exactly once'),
  },
]

// ---- the new-map ending (#241) ------------------------------------------------
//
// A third ending, and it is the charting one with a step in front of it. A map
// dispatch is handed its map; a NEW-map dispatch has to bring one into being
// first, and until it does, curia knows nothing to hang the session on: not
// where the summary comment goes, not what the thread is called, not which map
// `map <n>` must refuse while this agent lives.
//
// So the adoption is a STEP, not a courtesy. It is the one thing the daemon
// cannot see for itself — GitHub has no query for "the map this pane just made"
// — and the Stop hook holds the agent to it for exactly that reason. The tool
// verifies the number before taking it (dispatch.mjs, adoptMap), so a step
// reported is a step done.
export const NEW_MAP_ENDING = [
  {
    key: 'chart',
    prose: () => [
      'Settle the destination and the scope WITH the operator, then create the `wayfinder:map` issue and',
      'its first tickets yourself. Those tracker writes ARE the work. Nothing here is staged or merged.',
    ],
  },
  {
    key: 'adopt',
    prose: () => [
      'Call `map_created` with the number of the map you created, as soon as it exists — not at the end.',
      'Until you do, curia does not know which map is yours: your thread keeps a handle for a name, a',
      'second charting agent could be sent to the same map, and your summary has nowhere to land.',
    ],
    todo: (s) => (s.mapAdopted ? null : 'create the `wayfinder:map` issue, then call `map_created` with its number'),
  },
  // #297: a new-map session creates research tickets too, so it owes the same
  // landing when its subagents wrote files.
  ...CHARTING_LANDING,
  {
    key: 'report',
    prose: () => [
      'Call `report_result` exactly once, with `resolved` and a summary of what you charted.',
      'curia posts that summary as a comment on the map you created. It never closes the map.',
    ],
    todo: (s) => (s.hasResult ? null : 'call `report_result` exactly once'),
  },
]

// What a charting agent must NOT do — one bullet per entry, its own lines.
// Prose only: the refusals themselves live in dispatch.mjs, and this is the
// copy the model reads.
//
// #297 inverted the second bullet. The gate is now this session's, for the
// findings its subagents wrote — and what has to be said instead is the two
// bounds that gate does not carry: whose tickets these are, and when they may
// close.
export const CHARTING_NEVER = [
  ['Never close the map. It is the standing artifact, not a ticket you resolve.'],
  [
    'Resolve NOTHING you did not create. The research tickets you burned down in this session are yours',
    'to close. Every other child of this map belongs to its own dispatch, whatever you learned about it.',
  ],
  [
    'Never close a research ticket before the merge. Its findings are an answer only once they are in',
    'the default branch, and a close ahead of that makes the map lie (#48).',
  ],
  [
    'Commit nothing but the findings. `docs/research/` is the only directory a charting session writes,',
    'and curia refuses a pull request that touches any other file.',
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
  if (state.newMap) return NEW_MAP_ENDING
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
  const items = listFor(state).map((s) => (s.todo ? s.todo(state) : null)).filter(Boolean)
  // #237: the cross-check duty, ahead of every ordinary step. A builder that
  // stops with a verdict unjudged is skipping the one act the operator ruled
  // must precede any merge or report_result; a builder that stops while the
  // reviewer still reads is one whose park a restart severed, and
  // `request_review` is what re-parks it.
  if (state.unjudgedVerdict) {
    items.unshift('judge the cross-check verdict finding by finding, then put one summary with a recommendation to the operator with `ask_human` — the verdict is on the pull request if you no longer hold it')
  } else if (state.crossCheckInFlight) {
    // #258: `report_result` parks now too, and a builder that has already
    // merged and resolved must not be sent back to a gate it has passed.
    items.unshift('a cross-check is still reading your diff — call `request_review`, or `report_result` if you are at the end. Both park you until the verdict lands.')
  }
  return items
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
//
// #297: a charting session reaches this gate too, and the question it asks is
// NOT the map's. Approving research findings never says the map is done, so the
// heading says what is being approved — the map stays open either way, and a
// heading that implied otherwise would be the one thing #160 forbids.
export function reviewGateText({ repo, ticket, title, summary, charting, links, mapDispatch = false, digestLine = null }) {
  const parts = [
    mapDispatch
      ? `**Approve the research findings charted on ${repo}#${ticket}?** — ${title}`
      : `**Is ${repo}#${ticket} done?** — ${title}`,
    '',
    '**What the agent did**',
    summary.trim() || '(nothing said)',
    '',
    '**Charting it proposes for the map**',
    charting.trim() || '(nothing said)',
    '',
    '**Look at**',
    ...links.map((l) => `- ${l}`),
    // The digest (#355). ONE line, under the links, and never the hunks: a
    // phone-sized message cannot hold them, so the console keeps the read. It
    // is a fact curia measured rather than a second account of the work, which
    // is the whole rule #343 settled about what may join this card.
    ...(digestLine ? ['', digestLine] : []),
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
