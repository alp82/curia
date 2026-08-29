// The last third of the full loop (#41): "the ticket resolves and the map
// updates". `report_result` closes curia's DISPATCH lifecycle; this module is
// what closes the TICKET.
//
// Division of labour, settled on #41:
//
//   The AGENT resolves, in the tracker's own idiom — `gh issue comment` →
//   `gh issue close` → one appended line in the parent map's
//   `## Decisions so far`. That is exactly what the wayfinder skill does at the
//   end of a session, and a curia-specific resolve path would put every ticket
//   prompt at odds with the grammar curia consumes (#7). The standing orders in
//   workspace.mjs spell it out.
//
//   The DAEMON does not resolve. It does three things the agent cannot:
//
//   1. VERIFY and REPAIR. An agent that reported `resolved` and forgot to
//      close; a resolution comment that never landed; a map append lost to a
//      concurrent agent's read-modify-write of the same body (GitHub has no
//      compare-and-swap on an issue body, and max_concurrent > 1). The
//      appended line is journalled verbatim, so a lost update stays replayable
//      from the journal — the one durable artifact (#9).
//
//   2. LAND the code: push `curia/<n>` and open the PR. The agent never holds
//      that authority — same containment boundary as preview allocation (#40),
//      and the reason the base clone's push URL stays disabled.
//
//      Since #54 the agent ASKS for this, through the `open_pull_request` tool,
//      because landing now happens in the middle of the ticket rather than at its
//      end: the pull request is what the human reviews before anything is
//      resolved. `landBranch` below is that tool's body. resolveAndLand keeps
//      landing only as a REPAIR — an agent that reported `resolved` with commits
//      and no pull request would otherwise leave the only copy of its work in a
//      worktree.
//
//   3. TELL THE TRUTH about what was committed. The PR body's commit list is
//      read out of git by the daemon, not taken from the agent's account of
//      itself.
//
//   4. Since #54: check that the code is actually IN. `resolved` means merged
//      (#48), so a ticket closed over an unmerged pull request is reported as the
//      defect it is rather than passed off as a clean resolution.
//
// Evidence rule, inherited from #33's review waves: a failed READ is never
// evidence. If the comment list or the map body cannot be read, nothing is
// repaired on that axis — the outcome says "unknown" and a human hears about
// it. Repairing on a failed read is how you get a duplicate resolution comment
// or a map body rewritten from a partial view.

import { parentNumberOf, hasLabel } from './github.mjs'
import { composeWayfinderResult } from './card.mjs'
import { pullRequestTitle } from './pullrequesttitle.mjs'

export const DECISIONS_HEADING = /^##\s+Decisions so far\s*$/i

// Curia's own comments carry this marker, and the resolution-comment check
// ignores every comment that has it.
//
// Without it the check is wrong in the one direction that matters. It asks "is
// there a comment by us since this dispatch", and the daemon itself now comments
// on an OPEN ticket — `open_pull_request` posts the pull-request link mid-ticket.
// That comment would satisfy the check, so an agent that closed its ticket
// without writing a resolution would have curia's own link comment accepted as
// its resolution and no fallback posted.
export const MACHINE_MARKER = '<!-- curia:machine -->'

function machine(lines) {
  return [MACHINE_MARKER, ...lines].join('\n')
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Line span of a `## <heading>` section: from the heading to the next `## `
// (exclusive), or end of body.
export function sectionBounds(body, headingRe) {
  const lines = String(body ?? '').split('\n')
  const start = lines.findIndex((l) => headingRe.test(l))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break }
  }
  return { lines, start, end }
}

export function pointerLine({ title, url, gist }) {
  // one line means one line: a gist with newlines would silently become several
  // list items, or worse, break the section shape
  const oneLine = String(gist ?? '').replace(/\s+/g, ' ').trim()
  return `- [${title}](${url}) — ${oneLine || '(no gist recorded)'}`
}

// Is there already a Decisions-so-far pointer FOR THIS TICKET?
//
// Matching "does the section mention #41 anywhere" would be wrong and loudly
// so: entries on a real map reference other tickets constantly ("waits on
// #35", "superseded by #30"), so a bare mention test reports a pointer for
// every ticket any other decision happens to cite. The pointer is specifically
// a list item whose OWN link target is this ticket, which is exact.
export function mapPointerFor(body, repo, n) {
  const b = sectionBounds(body, DECISIONS_HEADING)
  if (!b) return null
  const target = new RegExp(`/${escapeRe(repo)}/issues/${n}(?![0-9])`)
  for (const line of b.lines.slice(b.start + 1, b.end)) {
    const m = line.match(/^\s*[-*]\s+\[[^\]]*\]\(([^)]+)\)/)
    if (m && target.test(m[1])) return line
  }
  return null
}

// Append at the END of Decisions-so-far: after its last non-blank line, so the
// blank line separating it from the next heading survives. Returns null when
// the section is absent — a map without one is not a shape to guess at.
export function insertMapPointer(body, line) {
  const b = sectionBounds(body, DECISIONS_HEADING)
  if (!b) return null
  let at = b.end
  while (at > b.start + 1 && !b.lines[at - 1].trim()) at--
  const out = [...b.lines]
  out.splice(at, 0, line)
  return out.join('\n')
}

// What the report SAID, for a record curia writes from it (#419, ADR-0019).
//
// The report is typed now: a `headline` says what the work came to in one line
// and the `summary` says what changed. A record that printed only the summary
// would drop the headline, and losing no information is the requirement the
// whole #413 map serves. An untyped report has no headline and reads exactly as
// it did before this ticket.
export function reportProse(result) {
  const headline = String(result?.headline ?? '').trim()
  const summary = String(result?.summary ?? '').trim()
  const wayfinder = composeWayfinderResult(result)
  if (!headline && !summary && !wayfinder) return '(no summary)'
  return [headline && `**${headline}**`, summary, wayfinder].filter(Boolean).join('\n\n')
}

export function fallbackResolutionComment(result) {
  return [
    '## Resolution (recorded by curia)',
    '',
    reportProse(result),
    '',
    `_The agent reported **${result.status}** but posted no resolution comment of its own; curia`,
    'recorded its `report_result` text verbatim rather than let the ticket close silently._',
  ].join('\n')
}

export function nonCleanComment({ agent, result, released }) {
  return machine([
    `⚠️ curia: agent \`${agent}\` stopped with status **${result.status}** and did **not** resolve this ticket.`,
    '',
    reportProse(result),
    '',
    released
      ? '_The ticket stays open and its claim has been released, so it returns to the frontier. Nothing was pushed._'
      : '_The ticket stays open. Releasing its claim FAILED, so it is still assigned and will not appear on the frontier until reconcile retries. Nothing was pushed._',
  ])
}

// ---- the map dispatch (#160) --------------------------------------------------

// What a charting agent leaves on the map. The DAEMON posts it, from the
// `report_result` summary — the same division of labour as the review gate's
// links (#40): a record curia writes from what it knows is evidence, and one
// the agent writes about itself is an account. It also makes the summary
// arrive exactly once, whatever the agent did with `gh` on its own.
//
// No MACHINE_MARKER: this is the substantive record of a charting session, not
// plumbing for a later check to skip over.
//
// The map is never closed and its `## Decisions so far` is never touched here.
// That section indexes the route walked — one line per RESOLVED ticket — and a
// charting session walks no step of it.
// `landing` is what the session put on a branch (#297, ADR-0008). A charting
// session that burned down research tickets carries findings, and the footer
// says where they got to — merged, or sitting on a pull request nobody merged.
// The daemon reads that from its own journal and from GitHub, so the sentence
// is evidence rather than the agent's account of itself.
export function chartingComment({ agent, model, instruction, result, landing = null }) {
  const clean = result.status === 'resolved'
  const landed = landing?.landed
  return [
    `## ${clean ? 'Charting' : `Charting — **${result.status}**`} (curia session \`${agent}\`)`,
    '',
    ...(instruction ? ['The operator asked for:', '', `> ${instruction}`, ''] : ['Dispatched with no instruction.', '']),
    reportProse(result),
    '',
    ...(landed
      ? [
        landing.merged
          ? `**The research findings are merged.** ${landing.url ? `Pull request: ${landing.url}. ` : ''}${landing.approved ? 'A human approved them at the review gate.' : '⚠️ NOBODY approved them at the review gate.'}`
          : `⚠️ **The research findings are NOT in the default branch.** ${landing.url ? `Pull request (**${landing.state ?? '?'}**): ${landing.url}. ` : ''}Any research ticket closed on them is closed on an answer no branch carries — check them.`,
        '',
      ]
      : []),
    '---',
    '',
    clean
      ? `_A map dispatch: this session edited the map and its tickets. It closed no ticket but the research ones it burned down itself, and it never closes the map. Model \`${model ?? '?'}\`._`
      : `_The charting agent stopped with status **${result.status}**. Whatever it had already written to the map STANDS — read the changes above before you dispatch another one. Model \`${model ?? '?'}\`._`,
  ].join('\n')
}

// ---- the cross-check, on the pull request (#165, ADR-0010) -------------------
//
// Two comments, and the daemon writes both because it already holds both texts:
// it spawned the reviewer, and the builder's judgement is the escalation prompt
// of the question the duty asks for. No agent write bound widens for either.
//
// They go on the PULL REQUEST, not on the ticket. The verdict is a reading of a
// DIFF, and the diff is what a pull request is — a reader who opens it reads the
// finding beside the line it names. ADR-0001 makes GitHub the durable home, and
// this is the record that outlives the builder, the reviewer and the daemon.
//
// No MACHINE_MARKER on either: both are substantive, and a later check must not
// skip over them.
export function verdictComment({ agent, model, builder_model: builderModel, sha, verdict, same_provider: sameProvider }) {
  return [
    '## 🔎 Cross-check verdict',
    '',
    `\`${agent}\` on \`${model ?? '?'}\` read \`${String(sha ?? '').slice(0, 12)}\`.`
      + ` The builder ran on \`${builderModel ?? '?'}\`.`,
    '',
    verdict || '(the reviewer said nothing)',
    '',
    '---',
    '',
    sameProvider
      ? '_curia spawned this reviewer when the operator pressed 🔎 on the review gate. It ran on the builder\'s OWN provider, which is the weaker check. It wrote nothing anywhere: the verdict is its only output, and the builder judges it next._'
      : '_curia spawned this reviewer when the operator pressed 🔎 on the review gate. It wrote nothing anywhere: the verdict is its only output, and the builder judges it next._',
  ].join('\n')
}

export function judgementComment(agent, prompt) {
  return [
    '## 🔨 The builder answers the cross-check',
    '',
    String(prompt ?? '').trim() || '(nothing said)',
    '',
    '---',
    '',
    `_\`${agent}\` judged the verdict above finding by finding and put this to the operator as a plain question, never a gate. curia composed the card from the parts the builder typed (#421). The operator decides, and the review gate that follows is a pure approve-or-reject._`,
  ].join('\n')
}

// The same verdict, as the builder reads it on its note queue. Shorter than the
// comment: the builder knows which ticket it is on and does not need the framing
// a pull-request reader needs.
export function verdictNote({ agent, model, verdict }) {
  return [
    `\`${agent}\` on \`${model ?? '?'}\` cross-checked your diff and returned this verdict.`,
    '',
    verdict || '(the reviewer said nothing)',
  ].join('\n')
}

// The verdict as the THREAD reads it when no agent is left to read it (#252,
// ADR-0013). A whole reviewer session's output is not a thing to mourn in one
// line: on #223 a four-finding `fail` verdict expired nine seconds after it was
// written and the thread showed nothing, so the loss was total and silent.
//
// Attribution first, because the thread is now the verdict's only reader and it
// must not read as curia's own opinion: who wrote it, what model, what it found,
// and where the full text lives. The pull-request comment is that full text and
// it is posted first on every path, so the link here always resolves — when
// curia has one. It is wrapped in <> so Discord renders no embed (#89): the
// findings above it are what a reader came for.
//
// This one is a MESSAGE, unlike its two neighbours, and it lives beside them
// anyway: verdictComment, verdictNote and this are the three renderings of one
// verdict, and one thing is easier to keep true in one place.
export function verdictCarrier({ agent, model, verdict, ticket, url, why }) {
  return [
    `📭 the cross-check verdict on #${ticket} has no live reader — ${why}. It is posted here in full rather than lost.`,
    '',
    `\`${agent ?? '?'}\` on \`${model ?? '?'}\` read the diff and returned this:`,
    '',
    String(verdict ?? '').trim() || '(the reviewer said nothing)',
    '',
    url
      ? `The full text is on the pull request: <${url}>. \`resume ${ticket}\` puts an agent back on the ticket to act on it.`
      : `curia could NOT put this on a pull request, so this message is the only copy. \`resume ${ticket}\` puts an agent back on the ticket to act on it.`,
  ].join('\n')
}

export function prLinkComment({ branch, commits, url, state }) {
  return machine([
    `🔗 curia pushed \`${branch}\` (${commits} commit${commits === 1 ? '' : 's'}) and ${state === 'updated' ? 'updated' : 'opened'} ${url}`,
  ])
}

// `onIssue` is the issue this pull request belongs to, which is the ticket for
// every dispatch but a charting one (#297): a map dispatch's work belongs to
// its map, and a new-map dispatch's bound "ticket" is a chat handle that no
// issue answers to. It never changes what is journalled — the journal is keyed
// by the bound ticket everywhere.
export function prBody({ repo, ticket, onIssue = null, title, summary, commits, agent, model }) {
  const n = onIssue ?? ticket
  return [
    // deliberately NOT a closing keyword: the agent closes the ticket itself
    // after the merge, and "Resolves #n" on top of that reads as if the merge
    // did it
    `Ticket: ${repo}#${n} — [${title}](https://github.com/${repo}/issues/${n})`,
    '',
    summary ?? '(no summary)',
    '',
    '---',
    '',
    `Dispatched by the curia daemon — session \`${agent}\`${model ? `, model \`${model}\`` : ''}.`,
    '',
    commits.length
      ? ['Commits (read out of git by the daemon, not reported by the agent):', '', ...commits.map((c) => `- \`${c.sha}\` ${c.subject}`)].join('\n')
      : 'No commits on the branch.',
  ].join('\n')
}

// ---- landing (the `open_pull_request` tool) -----------------------------------

// Push `curia/<n>` and open — or update — its pull request. Idempotent across
// the rejection loop by design (#54 item 1): the first call opens, every later
// call pushes the new commits and rewrites the body in place, so one ticket has
// one pull request however many review rounds it takes.
//
// A pull request that is no longer OPEN (merged or closed by an earlier
// dispatch) is not reused — a merged pull request cannot carry new commits, so
// the branch gets a fresh one.
//
// The default branch is read from the WORKSPACE, never from the base clone: a
// repo whose dispatches are all sandboxed has private clones and no base clone
// at all (#238). A worktree answers too, through its shared common dir.
export async function landBranch({
  repo, ticket, onIssue = null, title, summary, releaseLevel = null, agent, model, wtPath, branch, deps, journal,
}) {
  const defaultBranch = await deps.defaultBranchOf(wtPath)
  const commits = await deps.commitsOnBranch(wtPath, defaultBranch)
  if (!commits.length) {
    journal('land_skipped', { repo, ticket, agent, branch, reason: 'no commits on the branch' })
    return { ok: false, state: 'no-commits', branch }
  }
  const sha = await deps.pushBranch(wtPath, repo, branch)
  journal('branch_pushed', { repo, ticket, agent, branch, sha, commits: commits.length })

  const body = prBody({ repo, ticket, onIssue, title, summary, commits, agent, model })
  const prTitle = pullRequestTitle(title, `${repo}#${onIssue ?? ticket}`, releaseLevel)
  const existing = await deps.findPullRequest(repo, branch)
  if (existing && existing.state === 'OPEN') {
    await deps.setPullRequestBody(repo, existing.number, body)
    if (releaseLevel != null) await deps.setPullRequestTitle(repo, existing.number, prTitle)
    journal('pr_reused', { repo, ticket, agent, branch, url: existing.url, commits: commits.length })
    return { ok: true, state: 'updated', url: existing.url, number: existing.number, commits: commits.length, branch }
  }
  const url = await deps.createPullRequest(repo, {
    head: branch, base: defaultBranch, title: prTitle, body,
  })
  journal('pr_opened', { repo, ticket, agent, branch, url, commits: commits.length })
  return { ok: true, state: 'opened', url, commits: commits.length, branch }
}

// ---- the pipeline ------------------------------------------------------------

// Verify + repair the resolve protocol, then land the code. Every external
// effect arrives through `deps` (the Dispatcher's own injected seam), and
// `journal(type, data)` writes to the events log.
//
// `withMapLock(key, fn)` serialises the map body's read-modify-write against
// this daemon's other agents. It cannot serialise against a human editing the
// same body in another window — GitHub offers no conditional issue update — so
// the write is bracketed by a fresh read and a verifying re-read, and the line
// itself is journalled.
export async function resolveAndLand({
  repo, ticket, agent, result, wtPath, branch, epochTs, login, model,
  deps, journal, withMapLock, log = () => {},
}) {
  const out = { comment: 'unknown', close: 'unknown', map: { state: 'none' }, land: { state: 'skipped' }, repaired: [], warnings: [] }

  const issue = await deps.fetchIssue(repo, ticket)
  const url = issue.html_url ?? `https://github.com/${repo}/issues/${ticket}`
  const title = issue.title ?? `#${ticket}`

  // --- 1. resolution comment -------------------------------------------------
  let comments = null
  try {
    comments = await deps.issueComments(repo, ticket)
  } catch (e) {
    out.warnings.push(`could not read the ticket's comments (${e.message}) — no resolution comment was posted or repaired`)
    journal('resolve_verify_indeterminate', { repo, ticket, agent, axis: 'comment', error: e.message })
  }
  if (comments && !login) {
    // No confirmed gh identity ⇒ no way to tell OUR comment from anyone's, and
    // "no comment by nobody" would post a duplicate resolution on top of the
    // agent's own. Same rule as reconcile's identity check: a failed identity
    // read is a failed pass.
    out.warnings.push('the gh viewer identity is unknown, so the resolution comment could not be verified')
    journal('resolve_verify_indeterminate', { repo, ticket, agent, axis: 'comment', error: 'no viewer login' })
  } else if (comments) {
    // The agent holds the same gh identity as the daemon, so "a comment by us
    // since this dispatch" is the test. A comment Alp wrote himself after the
    // spawn also satisfies it; the failure direction is "post no fallback",
    // which is the harmless one. Curia's OWN machine comments are excluded —
    // see MACHINE_MARKER: `open_pull_request` comments on an open ticket, and
    // that link would otherwise pass for the agent's resolution.
    const own = comments.some((c) => c.user?.login === login
      && !String(c.body ?? '').includes(MACHINE_MARKER)
      && (!epochTs || String(c.created_at) >= epochTs))
    if (own) {
      out.comment = 'present'
    } else {
      await deps.commentIssue(repo, ticket, fallbackResolutionComment(result))
      out.comment = 'repaired'
      out.repaired.push('resolution comment')
      journal('resolve_repaired', { repo, ticket, agent, axis: 'comment' })
    }
  }

  // --- 2. closed -------------------------------------------------------------
  if (issue.state === 'open') {
    await deps.closeIssue(repo, ticket)
    out.close = 'repaired'
    out.repaired.push('close')
    journal('resolve_repaired', { repo, ticket, agent, axis: 'close' })
  } else {
    out.close = 'present'
  }

  // --- 3. map pointer --------------------------------------------------------
  const parent = parentNumberOf(issue)
  if (parent) {
    try {
      const parentIssue = await deps.fetchIssue(repo, parent)
      if (!hasLabel(parentIssue, 'wayfinder:map')) {
        out.map = { state: 'parent-not-a-map', number: parent }
      } else {
        out.map = await withMapLock(`${repo}#${parent}`, async () => {
          // read INSIDE the lock: the body this write is derived from must be
          // the newest one this daemon can see
          const fresh = await deps.fetchIssue(repo, parent)
          const existing = mapPointerFor(fresh.body, repo, ticket)
          if (existing) {
            journal('map_pointer_present', { repo, map: parent, ticket, line: existing })
            return { state: 'present', number: parent }
          }
          // The HEADLINE is the gist when the report carries one (#419). The
          // map's Decisions-so-far is an index — one line per closed ticket —
          // and a headline is that line already. Without one the summary is
          // flattened to one line, which is what this did before the field
          // existed.
          const line = pointerLine({ title, url, gist: result.headline || result.summary })
          const next = insertMapPointer(fresh.body, line)
          if (!next) {
            journal('map_pointer_failed', { repo, map: parent, ticket, line, reason: 'no "## Decisions so far" section' })
            return { state: 'no-section', number: parent, line }
          }
          await deps.setIssueBody(repo, parent, next)
          // journal the line whatever the verification says: this is what makes
          // a lost update replayable
          journal('map_pointer_appended', { repo, map: parent, ticket, line })
          const check = await deps.fetchIssue(repo, parent)
          const verified = Boolean(mapPointerFor(check.body, repo, ticket))
          if (!verified) journal('map_pointer_unverified', { repo, map: parent, ticket, line })
          return { state: verified ? 'appended' : 'append-unverified', number: parent, line }
        })
        if (out.map.state === 'appended') out.repaired.push(`map pointer on #${parent}`)
      }
    } catch (e) {
      out.map = { state: 'error', number: parent, error: e.message }
      out.warnings.push(`the map pointer on #${parent} could not be written (${e.message})`)
      journal('map_pointer_failed', { repo, map: parent, ticket, reason: e.message })
    }
  }

  // --- 4. is the code IN? ----------------------------------------------------
  //
  // Landing itself moved to `landBranch`, which the agent calls mid-ticket so a
  // human can review the pull request before anything is resolved (#54 item 1).
  // What is left here is the check `resolved` now has to pass — merged, not
  // merely pushed (#48) — plus the one repair that has no other cure: an agent
  // that committed and never opened a pull request would leave the ONLY copy of
  // its work in a worktree the lifecycle is about to stop protecting.
  if (wtPath && branch) {
    try {
      const defaultBranch = await deps.defaultBranchOf(wtPath)
      const commits = await deps.commitsOnBranch(wtPath, defaultBranch)
      if (!commits.length) {
        out.land = { state: 'no-commits' }
      } else {
        const pr = await deps.findPullRequest(repo, branch)
        if (!pr) {
          const landed = await landBranch({
            repo, ticket, title, summary: result.summary, agent, model,
            wtPath, branch, deps, journal,
          })
          out.land = { state: 'repaired', url: landed.url, commits: landed.commits, branch }
          out.repaired.push('pull request')
          out.warnings.push(`the agent never called \`open_pull_request\` — curia pushed \`${branch}\` and opened ${landed.url}, which NOBODY REVIEWED and which is not merged`)
          journal('land_repaired', { repo, ticket, agent, branch, url: landed.url })
          await deps.commentIssue(repo, ticket, prLinkComment({ branch, commits: landed.commits, url: landed.url, state: landed.state }))
        } else if (pr.state === 'MERGED') {
          out.land = { state: 'merged', url: pr.url, commits: commits.length, branch }
        } else {
          // Open or closed and unmerged: the ticket now states a decision whose
          // code is not in the default branch, which is the thing #48 set out to
          // make impossible. Curia cannot merge it — only a human approval can —
          // so it says so loudly and keeps the workspace.
          out.land = { state: pr.state === 'OPEN' ? 'unmerged' : 'pr-closed', url: pr.url, commits: commits.length, branch }
          out.warnings.push(`${pr.url} is **${pr.state}**, not merged — this ticket is closed over code that is not in \`${defaultBranch}\``)
          journal('resolved_unmerged', { repo, ticket, agent, branch, url: pr.url, pr_state: pr.state })
          // push whatever is not on the remote yet, so nothing lives only in a
          // worktree the human may now discard
          if (await deps.hasUnpushedCommits(wtPath, branch, defaultBranch).catch(() => true)) {
            const sha = await deps.pushBranch(wtPath, repo, branch)
            journal('branch_pushed', { repo, ticket, agent, branch, sha, commits: commits.length, reason: 'unmerged at resolve' })
          }
        }
      }
    } catch (e) {
      out.land = { state: 'failed', error: e.message, branch }
      out.warnings.push(`curia could not establish whether the work is landed (${e.message}) — the commits are in ${wtPath}`)
      journal('land_failed', { repo, ticket, agent, branch, error: e.message })
      log(`landing check for ${repo}#${ticket} failed: ${e.message}`)
    }
  }

  return out
}

// One human-readable line per axis — goes to the Discord thread and back to the
// agent as its report_result tool result.
//
// Every URL here is wrapped in <> (#253). This sentence rides the ending
// receipt, and the agent's own report already carries the pull-request link
// bare — one embed for one pull request. Unwrapped, the same GitHub embed
// rendered three times in four consecutive messages.
export function summariseOutcome(out) {
  const bits = []
  bits.push(out.close === 'repaired' ? 'ticket closed by curia' : out.close === 'present' ? 'ticket closed' : 'close state unknown')
  if (out.comment === 'repaired') bits.push('resolution comment recorded by curia')
  else if (out.comment === 'unknown') bits.push('resolution comment unverified')
  const m = out.map
  if (m.state === 'appended') bits.push(`map #${m.number} updated`)
  else if (m.state === 'present') bits.push(`map #${m.number} already had the pointer`)
  else if (m.state === 'append-unverified') bits.push(`map #${m.number} written but NOT verified`)
  else if (m.state === 'no-section') bits.push(`map #${m.number} has no "Decisions so far" section — pointer journalled only`)
  else if (m.state === 'parent-not-a-map') bits.push(`parent #${m.number} is not a map — no pointer`)
  else if (m.state === 'error') bits.push(`map #${m.number} FAILED`)
  const l = out.land
  if (l.state === 'merged') bits.push(`code merged (<${l.url}>)`)
  else if (l.state === 'unmerged') bits.push(`⚠️ <${l.url}> is still OPEN — the code is NOT merged`)
  else if (l.state === 'pr-closed') bits.push(`⚠️ <${l.url}> was closed unmerged — the code is NOT in`)
  else if (l.state === 'repaired') bits.push(`⚠️ curia opened <${l.url}> for you — unreviewed and unmerged`)
  else if (l.state === 'no-commits') bits.push('no code to land')
  else if (l.state === 'failed') bits.push(`landing check FAILED: ${l.error}`)
  const warn = out.warnings.length ? ` · ⚠️ ${out.warnings.join(' · ⚠️ ')}` : ''
  return bits.join(' · ') + warn
}
