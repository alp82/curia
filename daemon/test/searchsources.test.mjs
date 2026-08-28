import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { githubSearchSource, journalSearchSource, transcriptSearchSource } from '../src/searchsources.mjs'

let root
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-search-sources-')) })
after(() => fs.rmSync(root, { recursive: true, force: true }))

test('GitHub results distinguish maps from ticket conversations', async () => {
  const source = githubSearchSource({
    repos: () => ['o/r'],
    searchIssues: async (repo) => [
      { repo, number: 7, title: 'Atlas map', body: '## Decisions so far\n\n- Keep one search term contract.\n', url: 'https://github.com/o/r/issues/7', labels: [{ name: 'wayfinder:map' }] },
      { repo, number: 8, title: 'Search ticket', body: 'search term', labels: [] },
    ],
  })
  const rows = await source.search('search')
  assert.equal(rows[0].kind, 'map')
  assert.equal(rows[1].kind, 'decision')
  assert.equal(rows[1].url, 'https://github.com/o/r/issues/7')
  assert.equal(rows[2].conversation, 'curia-8')
})

test('journal search uses an escaped substring query', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('create table events (id integer, ts text, type text, body text)')
  db.prepare('insert into events values (?, ?, ?, ?)').run(1, '2026-08-25T10:00:00Z', 'notify', JSON.stringify({ message: '100% Atlas' }))
  const rows = await journalSearchSource(db).search('100%')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].snippet, '100% Atlas')
  db.close()
})

test('transcript search returns only operator-facing parsed text', async () => {
  const dir = path.join(root, 'cfg', 'curia-7', 'projects', 'workspace')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), [
    JSON.stringify({ type: 'system', secret: 'Atlas hidden' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-25T10:00:00Z', message: { content: [{ type: 'text', text: 'Atlas visible' }] } }),
  ].join('\n'))
  const rows = await transcriptSearchSource({ workspaceRoot: root }).search('Atlas')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].snippet, 'Atlas visible')
  assert.equal(rows[0].conversation, 'curia-7')
})

test('transcript search reads a new per-Harness configuration root', async () => {
  const dir = path.join(root, 'cfg', 'curia-8', 'claude', 'projects', 'workspace')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Nested Harness transcript' }] },
  }))
  const rows = await transcriptSearchSource({ workspaceRoot: root }).search('Nested Harness')
  assert.equal(rows[0].conversation, 'curia-8')
})

test('overseer transcript search lands on the Atlas session name', async () => {
  const session = '11111111-2222-4333-8444-555555555555'
  const dir = path.join(root, 'cfg', 'curia-overseer', 'projects', 'workspace')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Overseer Atlas result' }] },
  }))

  const rows = await transcriptSearchSource({
    workspaceRoot: root,
    overseerSessions: () => [{ key: 'console-9', session }],
  }).search('Overseer Atlas')

  assert.equal(rows[0].conversation, 'curia-console-9')
})
