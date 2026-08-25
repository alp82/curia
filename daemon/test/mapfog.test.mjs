import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLEAR_MAP_FOG, KEEP_MAP_OPEN, MAP_FOG_VERB,
  clearMapFog, mapFog, mapFogQuestion,
} from '../src/mapfog.mjs'
import { Reduction } from '../src/reduction.mjs'

test('mapFog returns only meaningful content from Not yet specified', () => {
  const body = [
    '## Destination',
    '',
    'Ship the operator surface.',
    '',
    '## Not yet specified',
    '',
    '<!-- this comment is map structure, not fog -->',
    '',
    '- Decide the offline receipt.',
    '- Measure the long transcript path.',
    '',
    '## Out of scope',
    '',
    '- Native mobile applications.',
  ].join('\n')

  assert.deepEqual(mapFog(body), {
    found: true,
    text: '- Decide the offline receipt.\n- Measure the long transcript path.',
  })
})

test('mapFog treats headings, whitespace, and HTML comments as empty fog', () => {
  const body = [
    '## Not yet specified',
    '',
    '<!--',
    'This template comment spans lines.',
    '-->',
    '',
    '## Out of scope',
  ].join('\n')

  assert.deepEqual(mapFog(body), { found: true, text: '' })
})

test('clearMapFog removes retained fog and preserves the map sections', () => {
  const body = [
    '## Destination',
    '',
    'Ship it.',
    '',
    '## Not yet specified',
    '',
    '<!-- fog belongs here -->',
    '',
    '- Retained work.',
    '',
    '## Out of scope',
    '',
    '- Native application.',
  ].join('\n')

  const cleared = clearMapFog(body)
  assert.deepEqual(mapFog(cleared), { found: true, text: '' })
  assert.match(cleared, /## Destination\n\nShip it\./)
  assert.match(cleared, /<!-- fog belongs here -->/)
  assert.match(cleared, /## Out of scope\n\n- Native application\./)
})

test('mapFogQuestion always asks for a verdict, even when the fog is empty', () => {
  const question = mapFogQuestion('o/r', {
    number: 19,
    title: 'Finish the map',
    body: '## Not yet specified\n\n<!-- keep -->\n',
  })

  assert.equal(question.action.verb, MAP_FOG_VERB)
  assert.equal(question.action.repo, 'o/r')
  assert.equal(question.action.map, 19)
  assert.match(question.payload.headline, /o\/r#19/)
  assert.match(question.payload.detail, /No meaningful fog remains/)
  assert.deepEqual(question.options, [CLEAR_MAP_FOG, KEEP_MAP_OPEN])
})

test('Reduction rebuilds an answered map verdict and its completed effects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-map-fog-'))
  try {
    const first = new Reduction(dir)
    const one = first.open({
      agent: 'overseer', ticket: '19',
      ...mapFogQuestion('o/r', { number: 19, body: '## Not yet specified\n\n- work' }),
    }).record
    const two = first.open({
      agent: 'overseer', ticket: '20',
      ...mapFogQuestion('o/r', { number: 20, body: '## Not yet specified\n' }),
    }).record
    first.open({
      agent: 'overseer', ticket: 'chat-1', kind: 'choice', prompt: 'Pick one', options: ['One', 'Two'],
    })
    assert.equal(one.status, 'open')
    assert.equal(two.status, 'open', 'one empty map question must not supersede another')

    first.answer(one.id, { answer: CLEAR_MAP_FOG, by: 'operator', via: 'discord' })
    first.journal('map_fog_verdict_posted', { id: one.id, repo: 'o/r', map: 19 })
    first.journal('map_fog_cleared', { id: one.id, repo: 'o/r', map: 19 })
    first.close()

    const rebuilt = new Reduction(dir)
    const held = rebuilt.mapFogQuestion('o/r', 19)
    assert.equal(held.status, 'answered')
    assert.equal(held.answer, CLEAR_MAP_FOG)
    assert.ok(held.verdict_posted_at)
    assert.ok(held.fog_cleared_at)
    assert.equal(rebuilt.mapFogQuestion('o/r', 20).status, 'open')
    rebuilt.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
