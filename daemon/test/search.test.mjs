// The global search query (#693).
//
// Every source here is a local adapter: an object with the same method the
// daemon's GitHub, journal, and transcript modules expose. Nothing in this file
// reaches the network, the `gh` CLI, or a transcript directory, so the suite
// proves the query and not the plumbing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTENTION_STATES,
  SEARCH_KINDS,
  SEARCH_SOURCES,
  decisionPointers,
  journalText,
  landingFor,
  matchIndex,
  searchAll,
  snippetAround,
} from '../src/search.mjs'
import { Questions } from '../src/questions.mjs'
import { Journal } from '../src/journal.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NOW = Date.parse('2026-08-25T12:00:00.000Z')

const issue = (number, title, {
  body = '', state = 'open', labels = [], updatedAt = '2026-08-25T11:00:00.000Z',
} = {}) => ({
  number,
  title,
  body,
  state,
  updated_at: updatedAt,
  labels: labels.map((name) => ({ name })),
})

const MAP_BODY = `## Destination

Decide the operator surfaces.

## Decisions so far

- [The maps screen](https://github.com/o/r/issues/522) - One band per map: walked, in flight, takeable, blocked, fog, with counts.
- [The embedded terminal](https://github.com/o/r/issues/537) - ttyd behind the identity proxy, with touch keys on phones.

## Not yet specified

- The search index.
`

const line = (event) => JSON.stringify(event)

const journalEvents = [
  {
    id: 41,
    ts: '2026-08-25T10:00:00.000Z',
    type: 'review_answered',
    ticket: '588',
    repo: 'o/r',
    body: line({
      ts: '2026-08-25T10:00:00.000Z',
      type: 'review_answered',
      ticket: '588',
      repo: 'o/r',
      approved: true,
      note: 'the frontier visual is approved',
    }),
  },
  {
    id: 42,
    ts: '2026-08-25T09:00:00.000Z',
    type: 'agent_spawned',
    ticket: '589',
    repo: 'o/r',
    body: line({
      ts: '2026-08-25T09:00:00.000Z',
      type: 'worker_spawned',
      ticket: '589',
      repo: 'o/r',
      worker: 'curia-589',
      backend: 'claude',
      note: 'started on the terminal work',
    }),
  },
]

const claudeLine = (uuid, parentUuid, event) => JSON.stringify({ uuid, parentUuid, ...event })

const transcript = [
  claudeLine('a', null, {
    type: 'user',
    timestamp: '2026-08-25T08:00:00.000Z',
    message: { content: 'Does the embedded terminal survive a restart?' },
  }),
  claudeLine('b', 'a', {
    type: 'assistant',
    timestamp: '2026-08-25T08:01:00.000Z',
    message: { content: [{ type: 'text', text: 'The terminal reconnects through the identity proxy.' }] },
  }),
]

const adapters = ({ issues = [], maps = [], events = journalEvents, conversations = [] } = {}) => ({
  github: {
    searchIssues: async () => issues,
    repoMaps: async () => maps,
  },
  journal: { searchEvents: async () => events },
  transcripts: { conversations: async () => conversations },
})

const conversation = () => ({
  repo: 'o/r',
  ticket: 537,
  session: 'curia-537',
  title: 'The embedded terminal',
  harness: 'claude',
  lines: transcript,
})

test('one request searches tickets, maps, decisions, journal entries, and chat transcripts', async () => {
  const { results } = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    ...adapters({
      issues: [
        issue(537, 'The embedded terminal', { body: 'ttyd behind the identity proxy.' }),
        issue(511, 'The UX map', { body: 'The terminal retires its own address.', labels: ['wayfinder:map'] }),
      ],
      maps: [{ number: 511, body: MAP_BODY, updated_at: '2026-08-25T07:00:00.000Z' }],
      conversations: [conversation()],
    }),
  })

  assert.deepEqual([...new Set(results.map((row) => row.kind))].sort(), [
    'chat', 'decision', 'journal', 'map', 'ticket',
  ])
})

test('every result names its kind, title, snippet, age, attention state, and landing target', async () => {
  const { results } = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    needsYou: ['o/r#537'],
    ...adapters({
      issues: [issue(537, 'The embedded terminal', { body: 'ttyd behind the identity proxy, with touch keys.' })],
    }),
  })

  const [row] = results
  assert.equal(row.kind, 'ticket')
  assert.equal(row.title, 'The embedded terminal')
  assert.match(row.snippet, /identity proxy/)
  assert.equal(row.age_ms, 60 * 60 * 1000)
  assert.equal(row.attention, 'needs_you')
  assert.deepEqual(row.landing, { surface: 'chat', repo: 'o/r', ticket: 537 })
  for (const key of ['kind', 'title', 'snippet', 'age_ms', 'attention', 'landing']) {
    assert.ok(key in row, `a result carries ${key}`)
  }
})

test('a result with no stamp reports a null age rather than a wrong one', async () => {
  const { results } = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    ...adapters({ issues: [issue(537, 'The embedded terminal', { updatedAt: null })], events: [] }),
  })

  assert.equal(results[0].age_ms, null)
})

test('each kind lands on the surface the decision on #589 gave it', async () => {
  const { results } = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    ...adapters({
      issues: [
        issue(537, 'The embedded terminal'),
        issue(511, 'The UX map', { body: 'the terminal', labels: ['wayfinder:map'] }),
      ],
      maps: [{ number: 511, body: MAP_BODY }],
      conversations: [conversation()],
    }),
  })

  const landings = Object.fromEntries(results.map((row) => [row.kind, row.landing]))
  assert.deepEqual(landings.ticket, { surface: 'chat', repo: 'o/r', ticket: 537 })
  assert.deepEqual(landings.chat, { surface: 'chat', repo: 'o/r', ticket: 537 })
  assert.deepEqual(landings.map, { surface: 'maps', repo: 'o/r', map: 511 })
  assert.deepEqual(landings.journal, { surface: 'feed', event: 42 })
  assert.deepEqual(landings.decision, { surface: 'github', url: 'https://github.com/o/r/issues/537' })
})

test('the first index holds no Discord source', async () => {
  assert.deepEqual(SEARCH_SOURCES, ['github', 'decisions', 'journal', 'transcripts'])
  assert.ok(!SEARCH_SOURCES.includes('discord'))
  assert.ok(!SEARCH_KINDS.includes('discord'))

  let asked = false
  const discord = { threads: async () => { asked = true; return [] } }
  const { results } = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    discord,
    ...adapters({ issues: [issue(537, 'The embedded terminal')] }),
  })

  assert.equal(asked, false, 'the query never reads a Discord thread body')
  assert.ok(results.length > 0)
})

test('a map issue is a map row and an ordinary issue is a ticket row', async () => {
  const { results } = await searchAll({
    query: 'surfaces',
    repos: ['o/r'],
    now: NOW,
    ...adapters({
      issues: [
        issue(511, 'The UX map of the surfaces', { labels: ['wayfinder:map'] }),
        issue(560, 'The navigation of the surfaces', { labels: ['wayfinder:task'] }),
      ],
      events: [],
    }),
  })

  // Both rows carry the same stamp, so the tie falls back to the kind order.
  assert.deepEqual(results.map((row) => [row.kind, row.ref]), [['ticket', '#560'], ['map', '#511']])
})

test('a closed ticket reports the closed attention state and an open one reports open', async () => {
  const { results } = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    ...adapters({
      issues: [
        issue(537, 'The embedded terminal', { state: 'closed', updatedAt: '2026-08-25T11:00:00.000Z' }),
        issue(538, 'The terminal keys', { state: 'open', updatedAt: '2026-08-25T10:30:00.000Z' }),
      ],
      events: [],
    }),
  })

  assert.deepEqual(results.map((row) => row.attention), ['closed', 'open'])
  for (const row of results) assert.ok(ATTENTION_STATES.includes(row.attention))
})

test('a decision row comes out of the map pointer and lands on its resolution comment', async () => {
  const { results } = await searchAll({
    query: 'walked',
    repos: ['o/r'],
    now: NOW,
    ...adapters({ maps: [{ number: 511, body: MAP_BODY }], events: [] }),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].kind, 'decision')
  assert.equal(results[0].title, 'The maps screen')
  assert.equal(results[0].attention, 'closed')
  assert.deepEqual(results[0].landing, { surface: 'github', url: 'https://github.com/o/r/issues/522' })
})

test('a journal hit reads the verbatim line in today\'s spelling', async () => {
  const { results } = await searchAll({
    query: 'started',
    repos: [],
    now: NOW,
    ...adapters(),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].kind, 'journal')
  assert.equal(results[0].title, 'agent_spawned on #589')
  assert.match(results[0].snippet, /started on the terminal work/)
  assert.deepEqual(results[0].landing, { surface: 'feed', event: 42 })
})

test('a chat hit names the speaker and lands on the ticket\'s chat thread', async () => {
  const { results } = await searchAll({
    query: 'reconnects',
    repos: [],
    now: NOW,
    ...adapters({ events: [], conversations: [conversation()] }),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].kind, 'chat')
  assert.equal(results[0].title, 'The embedded terminal')
  assert.equal(results[0].speaker, 'agent')
  assert.match(results[0].snippet, /identity proxy/)
  assert.deepEqual(results[0].landing, { surface: 'chat', repo: 'o/r', ticket: 537 })
})

test('an operator turn in a transcript is a chat hit with the operator as its speaker', async () => {
  const { results } = await searchAll({
    query: 'survive a restart',
    repos: [],
    now: NOW,
    ...adapters({ events: [], conversations: [conversation()] }),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].speaker, 'operator')
})

test('one conversation returns one row, on its latest matching message', async () => {
  const later = {
    ...conversation(),
    lines: [
      ...transcript,
      claudeLine('c', 'b', {
        type: 'assistant',
        timestamp: '2026-08-25T08:05:00.000Z',
        message: { content: [{ type: 'text', text: 'The terminal is embedded now.' }] },
      }),
    ],
  }

  const { results } = await searchAll({
    query: 'terminal',
    repos: [],
    now: NOW,
    ...adapters({ events: [], conversations: [later] }),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].at, '2026-08-25T08:05:00.000Z')
})

test('the results come back newest first', async () => {
  const { results } = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    ...adapters({
      issues: [issue(537, 'The embedded terminal', { updatedAt: '2026-08-25T11:00:00.000Z' })],
      conversations: [conversation()],
    }),
  })

  const stamps = results.map((row) => Date.parse(row.at))
  assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a))
})

test('a query needs every term, in any order', async () => {
  const { results } = await searchAll({
    query: 'identity terminal',
    repos: ['o/r'],
    now: NOW,
    ...adapters({
      issues: [
        issue(537, 'The embedded terminal', { body: 'ttyd behind the identity proxy.' }),
        issue(538, 'The terminal keys', { body: 'touch keys on phones.' }),
      ],
      events: [],
    }),
  })

  assert.deepEqual(results.map((row) => row.ref), ['#537'])
})

test('an empty query returns no rows rather than everything', async () => {
  const answer = await searchAll({ query: '   ', repos: ['o/r'], now: NOW, ...adapters() })

  assert.deepEqual(answer.results, [])
  assert.deepEqual(answer.failures, [])
})

test('a source that throws names itself and leaves the other sources standing', async () => {
  const answer = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    github: {
      searchIssues: async () => [issue(537, 'The embedded terminal')],
      repoMaps: async () => { throw new Error('gh is not logged in') },
    },
    journal: { searchEvents: async () => { throw new Error('events journal is unreadable') } },
    transcripts: { conversations: async () => [] },
  })

  assert.deepEqual(answer.results.map((row) => row.kind), ['ticket'])
  assert.deepEqual(answer.failures, [
    { source: 'decisions', reason: 'gh is not logged in' },
    { source: 'journal', reason: 'events journal is unreadable' },
  ])
})

test('the limit bounds the answer and says the rows were cut', async () => {
  const issues = Array.from({ length: 5 }, (_, index) => issue(600 + index, `The terminal ${index}`, {
    updatedAt: `2026-08-25T1${index}:00:00.000Z`,
  }))
  const answer = await searchAll({
    query: 'terminal',
    repos: ['o/r'],
    now: NOW,
    limit: 2,
    ...adapters({ issues, events: [] }),
  })

  assert.equal(answer.results.length, 2)
  assert.equal(answer.truncated, true)
})

test('the snippet centers on the first hit and marks what it cut', () => {
  const text = `${'a word '.repeat(30)}the identity proxy ${'b word '.repeat(30)}`
  const snippet = snippetAround(text, ['identity'])

  assert.match(snippet, /^…/)
  assert.match(snippet, /identity proxy/)
  assert.match(snippet, /…$/)
})

test('matchIndex reports the earliest hit of any term', () => {
  assert.equal(matchIndex(['proxy', 'ttyd'], 'ttyd behind the proxy'), 0)
  assert.equal(matchIndex(['proxy', 'nope'], 'ttyd behind the proxy'), -1)
  assert.equal(matchIndex([], 'anything'), -1)
})

test('landingFor refuses a kind it has no surface for', () => {
  assert.throws(() => landingFor('discord', {}), /no landing target for search kind "discord"/)
})

test('decisionPointers reads the title, the link, and the gist of every pointer', () => {
  assert.deepEqual(decisionPointers(MAP_BODY), [
    {
      title: 'The maps screen',
      url: 'https://github.com/o/r/issues/522',
      gist: 'One band per map: walked, in flight, takeable, blocked, fog, with counts.',
      ticket: 522,
    },
    {
      title: 'The embedded terminal',
      url: 'https://github.com/o/r/issues/537',
      gist: 'ttyd behind the identity proxy, with touch keys on phones.',
      ticket: 537,
    },
  ])
})

test('decisionPointers reads a pointer written with the em dash the resolve path writes', () => {
  const body = '## Decisions so far\n\n- [The one voice](https://github.com/o/r/issues/13) — one voice per fact.\n'

  assert.deepEqual(decisionPointers(body), [
    { title: 'The one voice', url: 'https://github.com/o/r/issues/13', gist: 'one voice per fact.', ticket: 13 },
  ])
})

test('a map with no Decisions so far section contributes no decision rows', () => {
  assert.deepEqual(decisionPointers('## Destination\n\nSomething.\n'), [])
})

test('journalText drops the bookkeeping keys and keeps the words', () => {
  const text = journalText(JSON.stringify({
    ts: '2026-08-25T09:00:00.000Z',
    type: 'result',
    epoch: 12,
    ticket: '589',
    headline: 'the terminal is embedded',
  }))

  assert.ok(!text.includes('2026-08-25T09:00:00.000Z'))
  assert.match(text, /the terminal is embedded/)
  assert.match(text, /589/)
})

test('journalText survives a line that is not JSON', () => {
  assert.equal(journalText('not json at all'), '')
})

// The journal adapter the daemon actually passes: the indexed question over the
// real `node:sqlite` store. The rest of this file uses a local adapter, so this
// is the one test that opens a database.
test('the journal question answers the query over the real store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-search-'))
  const journal = new Journal(path.join(dir, 'events.db'))
  try {
    journal.append(line({
      ts: '2026-08-25T09:00:00.000Z', type: 'worker_spawned', ticket: '589', repo: 'o/r', worker: 'curia-589',
      note: 'the embedded terminal starts',
    }))
    journal.append(line({
      ts: '2026-08-25T09:30:00.000Z', type: 'result', ticket: '590', repo: 'o/r', headline: 'the maps screen ships',
    }))
    const questions = new Questions(journal.db)

    const rows = questions.searchEvents('embedded TERMINAL')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].ticket, '589')
    assert.equal(rows[0].type, 'agent_spawned')

    assert.deepEqual(questions.searchEvents('   '), [])
    assert.equal(questions.searchEvents('e', { limit: 1 }).length, 1)
    // A `%` in a term is a literal character, not a wildcard.
    assert.deepEqual(questions.searchEvents('%terminal%'), [])
  } finally {
    journal.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the real journal question feeds the query as its journal adapter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-search-'))
  const journal = new Journal(path.join(dir, 'events.db'))
  try {
    journal.append(line({
      ts: '2026-08-25T09:00:00.000Z', type: 'worker_spawned', ticket: '589', repo: 'o/r', worker: 'curia-589',
      note: 'the embedded terminal starts',
    }))
    const questions = new Questions(journal.db)

    const { results } = await searchAll({
      query: 'embedded terminal',
      now: NOW,
      journal: { searchEvents: (query, opts) => questions.searchEvents(query, opts) },
    })

    assert.deepEqual(results.map((row) => [row.kind, row.title, row.landing.surface]), [
      ['journal', 'agent_spawned on #589', 'feed'],
    ])
  } finally {
    journal.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
