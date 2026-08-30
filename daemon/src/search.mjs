// The global search query (#693, decided in #589).
//
// One request searches every source Curia app can land on: the GitHub facts
// (tickets and maps), the decisions a map records under `## Decisions so far`,
// the journal, and the local chat transcripts. The lens overlay in every screen
// header calls this once, and the rows it draws come back already typed.
//
// Four rules come out of the decision on #589, and this module keeps them.
//
//   - **One request, four sources.** The caller passes a query and the
//     adapters. A source that throws contributes no rows and names itself in
//     `failures`, so a dead transcript directory can't blank the ticket hits.
//   - **Discord thread bodies stay out of the first index.** There is no Discord
//     adapter here, and `SEARCH_SOURCES` is the whole list. Discord is the alert
//     surface; its thread text is a copy of what the journal and the transcripts
//     already hold.
//   - **Every row names where it lands.** `landing` is a typed target, never a
//     URL the caller has to parse. A ticket hit and a chat hit land in Chat, a
//     map hit lands on Maps, a journal hit lands on the Feed, and a decision
//     lands on its resolution comment on GitHub.
//   - **Every row states its age and its attention state.** `age_ms` is measured
//     against the `now` the caller passes, so the age of a reading is the
//     caller's clock and not this module's. `attention` is `needs_you` for an
//     item on the operator's list, `closed` for finished work, and `open`
//     otherwise.
//
// Everything here is pure given its adapters. `test/search.test.mjs` drives it
// with local GitHub, journal, and transcript adapters, and nothing in this file
// reaches the network or the disk.

import { normalizeEvent } from './journal.mjs'
import { DECISIONS_HEADING, sectionBounds } from './resolve.mjs'
import { readActiveMessages } from './transcript.mjs'

// The five kinds a row can carry, in the order the lens ranks them when two
// rows are equally recent.
export const SEARCH_KINDS = ['ticket', 'map', 'decision', 'journal', 'chat']

// The four sources of the first index. Discord is deliberately absent.
export const SEARCH_SOURCES = ['github', 'decisions', 'journal', 'transcripts']

// The shared query interface groups GitHub facts and decisions behind one
// adapter. The detailed search above still names decisions as their own source
// when it reports a partial failure.
const QUERY_SOURCES = ['github', 'journal', 'transcripts']
export const MAX_SEARCH_QUERY = 200

// The three attention states a row can carry. `needs_you` is the amber word the
// row shows instead of its kind.
export const ATTENTION_STATES = ['needs_you', 'open', 'closed']

// How much text a snippet carries, and how far ahead of the first hit it starts.
const SNIPPET_WIDTH = 180
const SNIPPET_LEAD = 40

// How many rows one request returns when the caller names no limit.
const DEFAULT_LIMIT = 40

// The transcript items that hold operator-readable words. `think` is left out:
// a hit inside a model's reasoning isn't a line the operator remembers writing
// or reading.
const CHAT_ITEM_KINDS = new Set(['prompt', 'say', 'note', 'queued'])

// Who said a transcript item, in the words the row shows.
const CHAT_SPEAKERS = { prompt: 'operator', queued: 'operator', note: 'curia', say: 'agent' }

// The journal fields that are bookkeeping rather than words. They stay out of
// the searchable text so that a query for "result" doesn't match every row's
// own type twice.
const JOURNAL_SKIP_KEYS = new Set(['ts', 'type', 'epoch'])

function wireLandingFor(row) {
  switch (row.kind) {
    case 'ticket':
    case 'chat':
      return { surface: 'chat', conversation: String(row.conversation ?? row.id) }
    case 'map':
      return { surface: 'maps', map: Number(row.map ?? String(row.id).match(/#(\d+)$/)?.[1]) }
    case 'decision':
      return { surface: 'github', url: String(row.url) }
    case 'journal':
      return { surface: 'feed', event: String(row.id) }
    default:
      throw new Error(`unsupported search result kind "${row.kind}"`)
  }
}

function resultOnWire(row, now) {
  const stamp = Date.parse(row.at ?? row.updated_at ?? '')
  return {
    kind: String(row.kind),
    id: String(row.id),
    title: String(row.title ?? ''),
    snippet: String(row.snippet ?? ''),
    age_s: Number.isFinite(stamp) ? Math.max(0, Math.floor((now - stamp) / 1000)) : null,
    attention: row.attention == null ? null : String(row.attention),
    landing: wireLandingFor(row),
  }
}

// Curia app calls one checked interface while its source adapters own retrieval.
// Discord thread bodies remain outside this source set.
export class GlobalSearch {
  constructor({ now = Date.now, ...sources }) {
    for (const name of Object.keys(sources)) {
      if (!QUERY_SOURCES.includes(name)) throw new Error(`unsupported search source "${name}"`)
    }
    for (const name of QUERY_SOURCES) {
      if (typeof sources[name]?.search !== 'function') throw new Error(`search source "${name}" has no search interface`)
    }
    this.sources = sources
    this.now = now
  }

  async query(raw, { limit = 50 } = {}) {
    const query = String(raw ?? '').trim()
    if (!query) throw new Error('search query has no words')
    if (query.length > MAX_SEARCH_QUERY) {
      throw new Error(`search queries may not exceed ${MAX_SEARCH_QUERY} characters`)
    }

    const settled = await Promise.all(QUERY_SOURCES.map(async (source) => {
      try {
        const rows = await this.sources[source].search(query)
        return { source, rows: Array.isArray(rows) ? rows : [] }
      } catch (error) {
        return { source, error: error?.message ?? String(error) }
      }
    }))
    const results = []
    const errors = []
    const now = this.now()
    for (const part of settled) {
      if (part.error) {
        errors.push({ source: part.source, error: part.error })
        continue
      }
      for (const row of part.rows) {
        if (results.length >= limit) break
        results.push(resultOnWire(row, now))
      }
    }
    return { query, results, errors }
  }
}

// The terms a query means: every whitespace-separated word, lowercased. A row
// matches when its text holds all of them, in any order and any position.
export function queryTerms(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

// Where the first term lands in this text, or -1 when any term is missing.
// The index is what centers the snippet, so it's the earliest hit of any term
// and not of the first one the operator typed.
export function matchIndex(terms, text) {
  if (!terms.length) return -1
  const hay = String(text ?? '').toLowerCase()
  let first = -1
  for (const term of terms) {
    const at = hay.indexOf(term)
    if (at === -1) return -1
    if (first === -1 || at < first) first = at
  }
  return first
}

// One readable line around the first hit. Whitespace collapses first, so a
// snippet out of a JSON body or a wrapped issue body reads as prose.
export function snippetAround(text, terms, { width = SNIPPET_WIDTH } = {}) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const at = matchIndex(terms, flat)
  let start = at <= SNIPPET_LEAD ? 0 : at - SNIPPET_LEAD
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space !== -1 && space - start < 20) start = space + 1
  }
  const cut = flat.slice(start, start + width)
  return `${start > 0 ? '…' : ''}${cut}${start + width < flat.length ? '…' : ''}`
}

// The typed landing target for a row. The caller renders the word; the surface
// and its key are what Curia app routes on.
export function landingFor(kind, fact) {
  switch (kind) {
    case 'ticket':
    case 'chat':
      return { surface: 'chat', repo: fact.repo, ticket: fact.ticket }
    case 'map':
      return { surface: 'maps', repo: fact.repo, map: fact.map }
    case 'journal':
      return { surface: 'feed', event: fact.event }
    case 'decision':
      return { surface: 'github', url: fact.url }
    default:
      throw new Error(`no landing target for search kind "${kind}"`)
  }
}

const keyOf = (repo, ticket) => (ticket == null ? null : `${repo ?? ''}#${ticket}`)

function attentionOf({ repo, ticket, state }, needsYou) {
  const key = keyOf(repo, ticket)
  if (key && needsYou.has(key)) return 'needs_you'
  return state === 'closed' ? 'closed' : 'open'
}

function ageOf(at, now) {
  const stamp = Date.parse(at ?? '')
  if (!Number.isFinite(stamp)) return null
  return Math.max(0, now - stamp)
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name))
}

function isMap(issue) {
  return labelsOf(issue).includes('wayfinder:map')
}

function issueUrl(repo, number, issue) {
  return issue?.html_url ?? `https://github.com/${repo}/issues/${number}`
}

// A row, in the one shape every source returns.
function row({ kind, repo, ref, title, snippet, at, attention, landing, extra = {} }, now) {
  return {
    kind,
    repo: repo ?? null,
    ref: ref ?? null,
    title: title ?? '',
    snippet,
    at: at ?? null,
    age_ms: ageOf(at, now),
    attention,
    landing,
    ...extra,
  }
}

// The GitHub facts: every open and recently closed issue the adapter hands over.
// A `wayfinder:map` issue becomes a map row, and everything else a ticket row.
function githubRows(issues, { repo, terms, needsYou, now }) {
  const rows = []
  for (const issue of issues) {
    const title = issue.title ?? ''
    const body = issue.body ?? ''
    // The title and the body are one text for matching, so a query whose terms
    // are split between the two still finds the issue.
    if (matchIndex(terms, `${title}\n${body}`) === -1) continue
    const kind = isMap(issue) ? 'map' : 'ticket'
    const fact = kind === 'map'
      ? { repo, map: issue.number }
      : { repo, ticket: issue.number }
    rows.push(row({
      kind,
      repo,
      ref: `#${issue.number}`,
      title,
      snippet: snippetAround(body || title, terms),
      at: issue.updated_at ?? null,
      attention: attentionOf({ repo, ticket: issue.number, state: issue.state }, needsYou),
      landing: landingFor(kind, fact),
      extra: { url: issueUrl(repo, issue.number, issue) },
    }, now))
  }
  return rows
}

// One pointer line under `## Decisions so far`. The link is the ticket that
// decided it, which is where its resolution comment lives.
export function decisionPointers(body) {
  const section = sectionBounds(body, DECISIONS_HEADING)
  if (!section) return []
  const out = []
  for (const line of section.lines.slice(section.start + 1, section.end)) {
    const m = line.match(/^\s*[-*+]\s+\[([^\]]*)\]\(([^)]+)\)\s*(?:[-–—:]\s*)?(.*)$/)
    if (!m) continue
    const url = m[2].trim()
    const number = Number(url.match(/\/issues\/(\d+)/)?.[1] ?? NaN)
    out.push({
      title: m[1].trim(),
      url,
      gist: m[3].trim(),
      ticket: Number.isInteger(number) ? number : null,
    })
  }
  return out
}

function decisionRows(maps, { repo, terms, now }) {
  const rows = []
  for (const map of maps) {
    for (const pointer of decisionPointers(map.body)) {
      const text = `${pointer.title} ${pointer.gist}`
      if (matchIndex(terms, text) === -1) continue
      rows.push(row({
        kind: 'decision',
        repo,
        ref: pointer.ticket == null ? null : `#${pointer.ticket}`,
        title: pointer.title,
        snippet: snippetAround(pointer.gist || pointer.title, terms),
        at: map.updated_at ?? null,
        // A decision is settled work. It never carries the amber word.
        attention: 'closed',
        landing: landingFor('decision', { url: pointer.url }),
        extra: { map: map.number, url: pointer.url },
      }, now))
    }
  }
  return rows
}

// What a journal row offers the query: the words in the line, without the
// bookkeeping keys. The body is verbatim (ADR-0017), so `normalizeEvent` is
// what translates a pre-#184 line before the operator reads it.
export function journalText(body) {
  let event
  try { event = normalizeEvent(JSON.parse(body)) } catch { return '' }
  if (!event || typeof event !== 'object') return ''
  const parts = []
  const walk = (value) => {
    if (typeof value === 'string') parts.push(value)
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value))
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (!JOURNAL_SKIP_KEYS.has(key)) walk(inner)
      }
    }
  }
  walk(event)
  return parts.join(' ')
}

function journalRows(events, { terms, needsYou, now }) {
  const rows = []
  for (const event of events) {
    const parsed = (() => {
      try { return normalizeEvent(JSON.parse(event.body ?? '')) ?? {} } catch { return {} }
    })()
    const text = journalText(event.body)
    const type = event.type ?? parsed.type ?? ''
    if (matchIndex(terms, `${type} ${text}`) === -1) continue
    const ticket = event.ticket == null ? null : Number(event.ticket)
    const repo = event.repo ?? parsed.repo ?? null
    rows.push(row({
      kind: 'journal',
      repo,
      ref: ticket == null ? null : `#${ticket}`,
      title: event.title ?? (ticket == null ? type : `${type} on #${ticket}`),
      snippet: snippetAround(text, terms),
      at: event.ts ?? parsed.ts ?? null,
      attention: attentionOf({ repo, ticket, state: 'open' }, needsYou),
      landing: landingFor('journal', { event: event.id }),
      extra: { type },
    }, now))
  }
  return rows
}

// One conversation, one row at most. A transcript that matches in several
// messages lands on its latest matching message, because that's the one the
// operator scrolls to.
function chatRows(conversations, { terms, needsYou, now }) {
  const rows = []
  for (const conversation of conversations) {
    const { items } = readActiveMessages(conversation.harness, conversation.lines ?? [])
    let best = null
    for (const item of items) {
      if (!CHAT_ITEM_KINDS.has(item.kind)) continue
      if (matchIndex(terms, item.text ?? '') === -1) continue
      const at = Date.parse(item.at ?? '')
      const bestAt = best ? Date.parse(best.at ?? '') : NaN
      if (!best || !Number.isFinite(bestAt) || (Number.isFinite(at) && at >= bestAt)) best = item
    }
    if (!best) continue
    const ticket = conversation.ticket ?? null
    rows.push(row({
      kind: 'chat',
      repo: conversation.repo ?? null,
      ref: ticket == null ? null : `#${ticket}`,
      title: conversation.title ?? conversation.session ?? '',
      snippet: snippetAround(best.text, terms),
      at: best.at ?? null,
      attention: attentionOf({ repo: conversation.repo, ticket, state: 'open' }, needsYou),
      landing: landingFor('chat', { repo: conversation.repo ?? null, ticket }),
      extra: { session: conversation.session ?? null, speaker: CHAT_SPEAKERS[best.kind] ?? 'agent' },
    }, now))
  }
  return rows
}

// Newest first. A row with no stamp sorts last, and two rows of the same age
// fall back to the kind order the lens draws.
function rank(a, b) {
  const at = (rowValue) => (Number.isFinite(Date.parse(rowValue.at ?? '')) ? Date.parse(rowValue.at) : -Infinity)
  const byAge = at(b) - at(a)
  if (byAge !== 0) return byAge
  return SEARCH_KINDS.indexOf(a.kind) - SEARCH_KINDS.indexOf(b.kind)
}

// One request over every indexed source.
//
// The adapters:
//
//   - `github.searchIssues(repo, query)` returns the issues of one repo, each
//     with `number`, `title`, `body`, `state`, `labels`, and `updated_at`.
//   - `github.repoMaps(repo)` returns the maps whose bodies hold the decisions.
//   - `journal.searchEvents(query, { limit })` returns journal rows, each with
//     `id`, `ts`, `type`, `ticket`, `repo`, and the verbatim `body`.
//   - `transcripts.conversations()` returns the local chat transcripts, each
//     with `harness`, `lines`, and the ticket the conversation belongs to.
//
// `needsYou` is the operator's attention list, as `repo#number` keys. `now` is
// the clock every age is measured against.
export async function searchAll({
  query,
  repos = [],
  github = null,
  journal = null,
  transcripts = null,
  needsYou = [],
  now = Date.now(),
  limit = DEFAULT_LIMIT,
} = {}) {
  const terms = queryTerms(query)
  const attention = new Set(needsYou)
  const failures = []
  const rows = []

  const gather = async (source, read) => {
    try { rows.push(...(await read())) } catch (error) {
      failures.push({ source, reason: error.message })
    }
  }

  if (!terms.length) {
    return { query: String(query ?? ''), computed_at: new Date(now).toISOString(), results: [], failures, truncated: false }
  }

  for (const repo of repos) {
    if (github?.searchIssues) {
      await gather('github', async () => githubRows(
        await github.searchIssues(repo, query),
        { repo, terms, needsYou: attention, now },
      ))
    }
    if (github?.repoMaps) {
      await gather('decisions', async () => decisionRows(
        await github.repoMaps(repo),
        { repo, terms, now },
      ))
    }
  }

  if (journal?.searchEvents) {
    await gather('journal', async () => journalRows(
      await journal.searchEvents(query, { limit }),
      { terms, needsYou: attention, now },
    ))
  }

  if (transcripts?.conversations) {
    await gather('transcripts', async () => chatRows(
      await transcripts.conversations(),
      { terms, needsYou: attention, now },
    ))
  }

  rows.sort(rank)
  return {
    query: String(query),
    computed_at: new Date(now).toISOString(),
    results: rows.slice(0, limit),
    failures,
    truncated: rows.length > limit,
  }
}
