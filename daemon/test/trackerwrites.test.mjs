import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { trackerWriteWaves } from '../src/trackerwrites.mjs'

describe('tracker write proposal waves', () => {
  test('shows every title, label, and native edge before publication', () => {
    const text = trackerWriteWaves([
      { id: 'schema', title: 'Define the retry schema', labels: ['ready-for-agent'] },
      { id: 'worker', title: 'Drain the retry queue', labels: ['ready-for-agent', 'backend'], after: ['schema'] },
      { id: 'replay', title: 'Add the replay command', labels: ['ready-for-human'], after: ['schema', 'worker'] },
    ])

    assert.match(text, /wave 1 - nothing blocks these/)
    assert.match(text, /1\. Define the retry schema/)
    assert.match(text, /label: `ready-for-agent`/)
    assert.match(text, /wave 2/)
    assert.match(text, /2\. Drain the retry queue/)
    assert.match(text, /after 1 - native blocked-by edge/)
    assert.match(text, /label: `ready-for-agent`, `backend`/)
    assert.match(text, /wave 3/)
    assert.match(text, /3\. Add the replay command/)
    assert.equal(text.match(/native blocked-by edge/g)?.length, 3)
  })

  test('refuses missing blockers and dependency cycles', () => {
    assert.throws(
      () => trackerWriteWaves([{ id: 'one', title: 'One', after: ['missing'] }]),
      /unknown item "missing"/,
    )
    assert.throws(
      () => trackerWriteWaves([
        { id: 'one', title: 'One', after: ['two'] },
        { id: 'two', title: 'Two', after: ['one'] },
      ]),
      /dependency cycle/,
    )
  })
})
