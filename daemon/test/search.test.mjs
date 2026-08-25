import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { GlobalSearch } from '../src/search.mjs'

describe('global operator search (#693)', () => {
  test('one query returns every supported source with typed landing targets', async () => {
    const calls = []
    const source = (name, rows) => ({
      search: async (query) => { calls.push([name, query]); return rows },
    })
    const search = new GlobalSearch({
      github: source('github', [
        { kind: 'ticket', id: 'alp82/curia#684', title: 'Build Atlas', snippet: 'Atlas operator surface', updated_at: '2026-08-25T10:00:00Z', attention: 'needs you', conversation: 'curia-684' },
        { kind: 'map', id: 'alp82/curia#685', title: 'Atlas map', snippet: 'Execution map', updated_at: '2026-08-25T09:00:00Z', map: 685 },
        { kind: 'decision', id: 'decision:685:1', title: 'Keep one spec', snippet: 'Atlas and Discord', updated_at: '2026-08-24T09:00:00Z', url: 'https://github.com/alp82/curia/issues/685' },
      ]),
      journal: source('journal', [
        { kind: 'journal', id: 'event-4', title: 'Agent started', snippet: 'curia-684', at: '2026-08-25T08:00:00Z' },
      ]),
      transcripts: source('transcripts', [
        { kind: 'chat', id: 'console-2:7', title: 'Atlas discussion', snippet: 'show every map', at: '2026-08-25T07:00:00Z', conversation: 'console-2' },
      ]),
      now: () => Date.parse('2026-08-25T11:00:00Z'),
    })

    const result = await search.query('atlas')

    assert.deepEqual(calls.sort(), [
      ['github', 'atlas'], ['journal', 'atlas'], ['transcripts', 'atlas'],
    ])
    assert.deepEqual(result.results.map(({ kind, landing }) => ({ kind, landing })), [
      { kind: 'ticket', landing: { surface: 'chat', conversation: 'curia-684' } },
      { kind: 'map', landing: { surface: 'maps', map: 685 } },
      { kind: 'decision', landing: { surface: 'github', url: 'https://github.com/alp82/curia/issues/685' } },
      { kind: 'journal', landing: { surface: 'feed', event: 'event-4' } },
      { kind: 'chat', landing: { surface: 'chat', conversation: 'console-2' } },
    ])
    assert.equal(result.results[0].age_s, 3600)
    assert.equal(result.results[0].attention, 'needs you')
  })

  test('rejects an empty or oversized query before reading a source', async () => {
    let calls = 0
    const source = { search: async () => { calls += 1; return [] } }
    const search = new GlobalSearch({ github: source, journal: source, transcripts: source })

    await assert.rejects(search.query('  '), /search query has no words/)
    await assert.rejects(search.query('x'.repeat(201)), /200 characters/)
    assert.equal(calls, 0)
  })

  test('reports one failed source without hiding successful results', async () => {
    const search = new GlobalSearch({
      github: { search: async () => [{ kind: 'ticket', id: 'o/r#1', title: 'one', snippet: '', conversation: 'curia-1' }] },
      journal: { search: async () => { throw new Error('database busy') } },
      transcripts: { search: async () => [] },
    })

    const result = await search.query('one')

    assert.equal(result.results.length, 1)
    assert.deepEqual(result.errors, [{ source: 'journal', error: 'database busy' }])
  })

  test('does not accept a Discord thread-body source', () => {
    assert.throws(() => new GlobalSearch({
      github: { search: async () => [] },
      journal: { search: async () => [] },
      transcripts: { search: async () => [] },
      discord: { search: async () => [] },
    }), /unsupported search source "discord"/)
  })
})
