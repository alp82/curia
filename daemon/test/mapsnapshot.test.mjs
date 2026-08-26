import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapSnapshot, readMapSnapshot } from '../src/mapsnapshot.mjs'

const issue = (number, title, {
  state = 'open', labels = [], assignees = [], blockedBy = 0, body = '', updatedAt = null,
} = {}) => ({
  number,
  title,
  state,
  body,
  updated_at: updatedAt,
  labels: labels.map((name) => ({ name })),
  assignees: assignees.map((login) => ({ login })),
  issue_dependencies_summary: {
    blocked_by: blockedBy,
    blocking: 0,
    total_blocked_by: blockedBy,
    total_blocking: 0,
  },
})

const routing = {
  defaults: { untyped: 'sonnet', task: 'gpt' },
  models: {
    sonnet: { id: 'claude-sonnet-5', provider: 'anthropic', harness: 'claude' },
    gpt: { id: 'gpt-5.6-sol', provider: 'openai', harness: 'codex' },
  },
}

test('the map snapshot returns walked tickets for every open map', async () => {
  const children = {
    10: [issue(11, 'the first walked ticket', { state: 'closed', labels: ['wayfinder:task'] })],
    20: [issue(21, 'the second walked ticket', { state: 'closed' })],
  }
  const github = {
    repoMaps: async () => [
      issue(10, 'the first map'),
      issue(20, 'the second map', { labels: ['wayfinder:deferred'] }),
      issue(30, 'the closed map', { state: 'closed' }),
    ],
    mapFrontier: async (repo, number) => children[number] ?? [],
    blockedByOf: async () => [],
  }
  const journal = { mapSnapshotFacts: async () => new Map() }

  const { maps } = await readMapSnapshot({ watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal })

  assert.deepEqual(maps.map((map) => ({ number: map.number, walked: map.walked })), [
    {
      number: 10,
      walked: [{ number: 11, title: 'the first walked ticket', type: 'task' }],
    },
    {
      number: 20,
      walked: [{ number: 21, title: 'the second walked ticket', type: null }],
    },
  ])
  // A paused map is still an open map, so it is READ (#700). What the pause
  // costs it is the start control on every surface, and that needs the flag.
  assert.deepEqual(maps.map((map) => [map.number, map.deferred]), [[10, false], [20, true]])
})

test('an assigned open ticket returns its current agent as in flight', async () => {
  let journalRead
  const github = {
    repoMaps: async () => [issue(10, 'the map')],
    mapFrontier: async () => [
      issue(11, 'the running ticket', { labels: ['wayfinder:task'], assignees: ['alp82'] }),
    ],
    blockedByOf: async () => [],
  }
  const journal = {
    mapSnapshotFacts: async (repo, tickets) => {
      journalRead = { repo, tickets }
      return new Map([['11', {
        latest_event_at: '2026-08-25T10:00:00.000Z',
        agent: {
          session: 'curia-11', model: 'gpt', harness: 'codex', started_at: '2026-08-25T09:00:00.000Z',
        },
      }]])
    },
  }

  const { maps: [map] } = await readMapSnapshot({
    watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal,
  })

  assert.deepEqual(journalRead, { repo: 'o/r', tickets: [10, 11] })
  assert.deepEqual(map.in_flight, [{
    number: 11,
    title: 'the running ticket',
    type: 'task',
    assignees: ['alp82'],
    agent: {
      session: 'curia-11', model: 'gpt-5.6-sol', harness: 'codex', started_at: '2026-08-25T09:00:00.000Z',
    },
  }])
})

test('an unassigned unblocked ticket returns its routed model as takeable', async () => {
  const github = {
    repoMaps: async () => [issue(10, 'the map')],
    mapFrontier: async () => [
      issue(11, 'the takeable ticket', { labels: ['wayfinder:task'] }),
      issue(12, 'the pinned ticket', { labels: ['wayfinder:task', 'model:sonnet'] }),
    ],
    blockedByOf: async () => { throw new Error('an unblocked ticket needs no edge read') },
  }
  const journal = { mapSnapshotFacts: async () => new Map() }

  const { maps: [map] } = await readMapSnapshot({
    watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal,
  })

  assert.deepEqual(map.takeable, [
    { number: 11, title: 'the takeable ticket', type: 'task', model: 'gpt-5.6-sol' },
    { number: 12, title: 'the pinned ticket', type: 'task', model: 'claude-sonnet-5' },
  ])
})

test('a blocked ticket names each open blocker', async () => {
  const github = {
    repoMaps: async () => [issue(10, 'the map')],
    mapFrontier: async () => [issue(14, 'the blocked ticket', { blockedBy: 3 })],
    blockedByOf: async (repo, number) => {
      assert.deepEqual({ repo, number }, { repo: 'o/r', number: 14 })
      return [
        issue(11, 'the first open blocker'),
        issue(12, 'the closed blocker', { state: 'closed' }),
        issue(13, 'the second open blocker'),
      ]
    },
  }
  const journal = { mapSnapshotFacts: async () => new Map() }

  const { maps: [map] } = await readMapSnapshot({
    watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal,
  })

  assert.deepEqual(map.blocked, [{
    number: 14,
    title: 'the blocked ticket',
    type: null,
    blockers: [
      { number: 11, title: 'the first open blocker' },
      { number: 13, title: 'the second open blocker' },
    ],
  }])
})

test('a blocked ticket never returns without a readable open blocker', async () => {
  const github = {
    repoMaps: async () => [issue(10, 'the map')],
    mapFrontier: async () => [issue(14, 'the blocked ticket', { blockedBy: 1 })],
    blockedByOf: async () => [],
  }
  const journal = { mapSnapshotFacts: async () => new Map() }

  await assert.rejects(
    readMapSnapshot({ watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal }),
    /blocked ticket o\/r#14 names no open blocker/,
  )
})

test('fog returns the facts under Not yet specified', async () => {
  const body = [
    '## Decisions so far',
    '',
    '- one walked decision',
    '',
    '## Not yet specified',
    '',
    '<!-- a note for agents, not a fog fact -->',
    '- Pick the retention period',
    '* Decide whether exports include raw rows',
    '',
    '## Out of scope',
    '',
    '- another concern',
  ].join('\n')
  const github = {
    repoMaps: async () => [issue(10, 'the map', { body })],
    mapFrontier: async () => [],
    blockedByOf: async () => [],
  }
  const journal = { mapSnapshotFacts: async () => new Map() }

  const { maps: [map] } = await readMapSnapshot({
    watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal,
  })

  assert.deepEqual(map.fog, [
    { text: 'Pick the retention period' },
    { text: 'Decide whether exports include raw rows' },
  ])
})

// #698: the empty-map question shows this same fog, so a `###` line grouping
// it would read as a patch of uncertainty and hold a finished map open.
test('a sub-heading inside the fog is a shape, not a fact', async () => {
  const body = [
    '## Not yet specified',
    '',
    '### The retention questions',
    '',
    '- Pick the retention period',
    '',
    '#### Later',
    '- Decide whether exports include raw rows',
  ].join('\n')
  const github = {
    repoMaps: async () => [issue(10, 'the map', { body })],
    mapFrontier: async () => [],
    blockedByOf: async () => [],
  }
  const journal = { mapSnapshotFacts: async () => new Map() }

  const { maps: [map] } = await readMapSnapshot({
    watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal,
  })

  assert.deepEqual(map.fog, [
    { text: 'Pick the retention period' },
    { text: 'Decide whether exports include raw rows' },
  ])
})

test('a fog section that is nothing but headings is empty fog', async () => {
  const github = {
    repoMaps: async () => [issue(10, 'the map', { body: '## Not yet specified\n\n### Open questions\n' })],
    mapFrontier: async () => [],
    blockedByOf: async () => [],
  }
  const journal = { mapSnapshotFacts: async () => new Map() }

  const { maps: [map] } = await readMapSnapshot({
    watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal,
  })

  assert.deepEqual(map.fog, [])
})

test('None and empty Not yet specified sections return no fog', async () => {
  const github = {
    repoMaps: async () => [
      issue(10, 'none', { body: '## Not yet specified\n\nNone. The child set covers the destination.\n' }),
      issue(20, 'empty', { body: '## Not yet specified\n\n*(empty)*\n' }),
    ],
    mapFrontier: async () => [],
    blockedByOf: async () => [],
  }
  const journal = { mapSnapshotFacts: async () => new Map() }

  const { maps } = await readMapSnapshot({
    watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal,
  })

  assert.deepEqual(maps.map((map) => map.fog), [[], []])
})

test('each map returns counts and a latest event stamp ordered by the journal', async () => {
  const body = '## Not yet specified\n\n- Decide the retention period\n'
  const github = {
    repoMaps: async () => [issue(10, 'the map', { body, updatedAt: '2026-08-25T13:00:00.000Z' })],
    mapFrontier: async () => [
      issue(11, 'walked', { state: 'closed', updatedAt: '2026-08-25T09:00:00.000Z' }),
      issue(12, 'in flight', { assignees: ['alp82'] }),
      issue(13, 'takeable'),
      issue(14, 'blocked', { blockedBy: 1 }),
    ],
    blockedByOf: async () => [issue(13, 'takeable')],
  }
  const journal = {
    mapSnapshotFacts: async () => new Map([
      ['10', { latest_event_id: 4, latest_event_at: '2026-08-25T12:00:00.000Z', agent: null }],
      ['12', { latest_event_id: 5, latest_event_at: '2026-08-25T11:00:00.000Z', agent: { session: 'curia-12' } }],
    ]),
  }

  const { maps: [map] } = await readMapSnapshot({
    watch: [{ repo: 'o/r', mode: 'map' }], routing, github, journal,
  })

  assert.deepEqual(map.counts, {
    walked: 1,
    in_flight: 1,
    takeable: 1,
    blocked: 1,
    fog: 1,
    total: 4,
  })
  assert.equal(map.latest_event_at, '2026-08-25T11:00:00.000Z')
})

test('the map snapshot refreshes after invalidation and stays cached otherwise', async () => {
  let reads = 0
  const snapshot = new MapSnapshot(async () => ({
    computed_at: `read-${++reads}`,
    maps: [{ number: reads }],
  }))

  assert.deepEqual(await snapshot.read(), {
    computed_at: 'read-1', maps: [{ number: 1 }], error: null,
  })
  assert.equal((await snapshot.read()).computed_at, 'read-1')

  snapshot.invalidate()

  assert.deepEqual(await snapshot.read(), {
    computed_at: 'read-2', maps: [{ number: 2 }], error: null,
  })
})

test('an invalidation during a refresh returns the newer map snapshot', async () => {
  let release
  let reads = 0
  const firstRead = new Promise((resolve) => { release = resolve })
  const snapshot = new MapSnapshot(async () => {
    reads += 1
    if (reads === 1) await firstRead
    return { computed_at: `read-${reads}`, maps: [] }
  })

  const result = snapshot.read()
  snapshot.invalidate()
  release()

  assert.equal((await result).computed_at, 'read-2')
})

test('a failed map snapshot retries on the next read', async () => {
  let reads = 0
  const snapshot = new MapSnapshot(async () => {
    reads += 1
    if (reads === 1) throw new Error('GitHub is unavailable')
    return { computed_at: 'recovered', maps: [] }
  })

  assert.deepEqual(await snapshot.read(), {
    computed_at: null, maps: null, error: 'GitHub is unavailable',
  })
  assert.deepEqual(await snapshot.read(), {
    computed_at: 'recovered', maps: [], error: null,
  })
})
