// The last third of the golden thread (#41): "the ticket resolves and the map
// updates". `report_result` closes curia's DISPATCH lifecycle; this module is
// what closes the TICKET.
//
// Division of labour, settled on #41:
//
//   The WORKER resolves, in the tracker's own idiom — `gh issue comment` →
//   `gh issue close` → one appended line in the parent map's
//   `## Decisions so far`. That is exactly what the wayfinder skill does at the
//   end of a session, and a curia-specific resolve path would put every ticket
//   prompt at odds with the grammar curia consumes (#7). The standing orders in
//   workspace.mjs spell it out.
//
//   The DAEMON does not resolve. It does three things the worker cannot:
//
//   1. VERIFY and REPAIR. A worker that reported `resolved` and forgot to
//      close; a resolution comment that never landed; a map append lost to a
//      concurrent worker's read-modify-write of the same body (GitHub has no
//      compare-and-swap on an issue body, and max_concurrent > 1). The
//      appended line is journalled verbatim, so a lost update stays replayable
//      from the journal — the one durable artifact (#9).
//
//   2. LAND the code: push `curia/<n>` and open the PR. The worker never holds
//      that authority — same containment boundary as preview allocation (#40),
//      and the reason the base clone's push URL stays disabled.
//
//   3. TELL THE TRUTH about what was committed. The PR body's commit list is
//      read out of git by the daemon, not taken from the worker's account of
//      itself.
//
// Evidence rule, inherited from #33's review waves: a failed READ is never
// evidence. If the comment list or the map body cannot be read, nothing is
// repaired on that axis — the outcome says "unknown" and a human hears about
// it. Repairing on a failed read is how you get a duplicate resolution comment
// or a map body rewritten from a partial view.

import { parentNumberOf, hasLabel } from './github.mjs'

export const DECISIONS_HEADING = /^##\s+Decisions so far\s*$/i

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

export function fallbackResolutionComment(result) {
  return [
    '## Resolution (recorded by curia)',
    '',
    result.summary ?? '(no summary)',
    '',
    `_The worker reported **${result.status}** but posted no resolution comment of its own; curia`,
    'recorded its `report_result` summary verbatim rather than let the ticket close silently._',
  ].join('\n')
}

export function nonCleanComment({ worker, result, released }) {
  return [
    `⚠️ curia: worker \`${worker}\` stopped with status **${result.status}** and did **not** resolve this ticket.`,
    '',
    result.summary ?? '(no summary)',
    '',
    released
      ? '_The ticket stays open and its claim has been released, so it returns to the frontier. Nothing was pushed._'
      : '_The ticket stays open. Releasing its claim FAILED, so it is still assigned and will not appear on the frontier until reconcile retries. Nothing was pushed._',
  ].join('\n')
}

export function prBody({ repo, ticket, title, result, commits, worker, model }) {
  return [
    // deliberately NOT a closing keyword: the worker already closed the ticket,
    // and "Resolves #n" on top of that reads as if the merge did it
    `Ticket: ${repo}#${ticket} — [${title}](https://github.com/${repo}/issues/${ticket})`,
    '',
    result.summary ?? '(no summary)',
    '',
    '---',
    '',
    `Dispatched by the curia daemon — session \`${worker}\`${model ? `, model \`${model}\`` : ''}.`,
    '',
    commits.length
      ? ['Commits (read out of git by the daemon, not reported by the worker):', '', ...commits.map((c) => `- \`${c.sha}\` ${c.subject}`)].join('\n')
      : 'No commits on the branch.',
  ].join('\n')
}

// ---- the pipeline ------------------------------------------------------------

// Verify + repair the resolve protocol, then land the code. Every external
// effect arrives through `deps` (the Dispatcher's own injected seam), and
// `journal(type, data)` writes to the events log.
//
// `withMapLock(key, fn)` serialises the map body's read-modify-write against
// this daemon's other workers. It cannot serialise against a human editing the
// same body in another window — GitHub offers no conditional issue update — so
// the write is bracketed by a fresh read and a verifying re-read, and the line
// itself is journalled.
export async function resolveAndLand({
  repo, ticket, worker, result, wtPath, basePath, branch, epochTs, login, model,
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
    journal('resolve_verify_indeterminate', { repo, ticket, worker, axis: 'comment', error: e.message })
  }
  if (comments && !login) {
    // No confirmed gh identity ⇒ no way to tell OUR comment from anyone's, and
    // "no comment by nobody" would post a duplicate resolution on top of the
    // worker's own. Same rule as reconcile's identity check: a failed identity
    // read is a failed pass.
    out.warnings.push('the gh viewer identity is unknown, so the resolution comment could not be verified')
    journal('resolve_verify_indeterminate', { repo, ticket, worker, axis: 'comment', error: 'no viewer login' })
  } else if (comments) {
    // The worker holds the same gh identity as the daemon, so "a comment by us
    // since this dispatch" is the test. A comment Alp wrote himself after the
    // spawn also satisfies it; the failure direction is "post no fallback",
    // which is the harmless one.
    const own = comments.some((c) => c.user?.login === login && (!epochTs || String(c.created_at) >= epochTs))
    if (own) {
      out.comment = 'present'
    } else {
      await deps.commentIssue(repo, ticket, fallbackResolutionComment(result))
      out.comment = 'repaired'
      out.repaired.push('resolution comment')
      journal('resolve_repaired', { repo, ticket, worker, axis: 'comment' })
    }
  }

  // --- 2. closed -------------------------------------------------------------
  if (issue.state === 'open') {
    await deps.closeIssue(repo, ticket)
    out.close = 'repaired'
    out.repaired.push('close')
    journal('resolve_repaired', { repo, ticket, worker, axis: 'close' })
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
          const line = pointerLine({ title, url, gist: result.summary })
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

  // --- 4. land the code ------------------------------------------------------
  if (wtPath && basePath && branch) {
    try {
      const defaultBranch = await deps.defaultBranchOf(basePath)
      const commits = await deps.commitsOnBranch(wtPath, defaultBranch)
      if (!commits.length) {
        out.land = { state: 'no-commits' }
        journal('land_skipped', { repo, ticket, worker, branch, reason: 'no commits on the branch' })
      } else {
        const sha = await deps.pushBranch(wtPath, repo, branch)
        journal('branch_pushed', { repo, ticket, worker, branch, sha, commits: commits.length })
        const existing = await deps.findPullRequest(repo, branch)
        const prUrl = existing?.url ?? await deps.createPullRequest(repo, {
          head: branch,
          base: defaultBranch,
          title: `${title} (${repo}#${ticket})`,
          body: prBody({ repo, ticket, title, result, commits, worker, model }),
        })
        out.land = { state: existing ? 'pr-reused' : 'pr-opened', url: prUrl, commits: commits.length, branch }
        journal('pr_' + (existing ? 'reused' : 'opened'), { repo, ticket, worker, branch, url: prUrl })
        // the ticket is closed by now, so this comment is the only pointer from
        // the ticket to the artifact
        await deps.commentIssue(repo, ticket, `🔗 curia pushed \`${branch}\` (${commits.length} commit${commits.length > 1 ? 's' : ''}) and ${existing ? 'reused' : 'opened'} ${prUrl}`)
      }
    } catch (e) {
      out.land = { state: 'failed', error: e.message, branch }
      out.warnings.push(`the work was NOT landed (${e.message}) — the commits are still in ${wtPath}`)
      journal('land_failed', { repo, ticket, worker, branch, error: e.message })
      log(`landing ${repo}#${ticket} failed: ${e.message}`)
    }
  }

  return out
}

// One human-readable line per axis — goes to the Discord thread and back to the
// worker as its report_result tool result.
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
  if (l.state === 'pr-opened') bits.push(`PR opened: ${l.url}`)
  else if (l.state === 'pr-reused') bits.push(`branch pushed, existing PR ${l.url}`)
  else if (l.state === 'no-commits') bits.push('nothing to land (no commits)')
  else if (l.state === 'failed') bits.push(`landing FAILED: ${l.error}`)
  const warn = out.warnings.length ? `\n⚠️ ${out.warnings.join('\n⚠️ ')}` : ''
  return bits.join('; ') + warn
}
