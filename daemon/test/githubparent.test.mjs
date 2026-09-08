import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchIssue, parentNumberOf } from '../src/github.mjs'

test('an App issue response without the parent field discovers its parent through the dedicated endpoint', async () => {
  const calls = []
  const request = async (args, opts) => {
    calls.push([args, opts])
    return JSON.stringify(args[1].endsWith('/parent') ? { number: 102 } : { number: 103, state: 'closed' })
  }
  const issue = await fetchIssue('seen-is/seen-site', 103, { request })
  assert.equal(parentNumberOf(issue), 102)
  assert.deepEqual(calls.map(([args]) => args[1]), ['repos/seen-is/seen-site/issues/103', 'repos/seen-is/seen-site/issues/103/parent'])
  assert.ok(calls.every(([, opts]) => opts.repo === 'seen-is/seen-site'))
})

test('a missing parent is distinct from a failed parent read', async () => {
  for (const code of [404, 403, 429, 500]) {
    const request = async (args) => {
      if (!args[1].endsWith('/parent')) return JSON.stringify({ number: 103 })
      throw new Error(`gh: request failed (HTTP ${code})`)
    }
    if (code === 404) assert.equal(parentNumberOf(await fetchIssue('o/r', 103, { request })), null)
    else await assert.rejects(fetchIssue('o/r', 103, { request }), new RegExp(`HTTP ${code}`))
  }
})
