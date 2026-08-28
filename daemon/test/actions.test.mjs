import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ActionCoordinator } from '../src/actions.mjs'
import { Reduction } from '../src/reduction.mjs'

const action = (id) => ({
  action_id: id,
  kind: 'dispatch',
  target: 'alp82/curia#803',
  conflict_key: 'dispatch:alp82/curia#803',
})

describe('shared Action evidence', () => {
  let dir
  let reduction
  let actions

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-actions-'))
    reduction = new Reduction(dir)
    actions = new ActionCoordinator(reduction)
  })

  afterEach(() => {
    reduction.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('accepted returns before slow work completes, and meaningful progress advances the shared record', async () => {
    let finish
    const terminal = new Promise((resolve) => { finish = resolve })
    const response = await actions.run(action('act-accepted'), async ({ accept, progress }) => {
      accept()
      progress('Preparing the private clone')
      await terminal
      return { status: 'confirmed' }
    })

    assert.equal(response.status, 'accepted', 'the caller is released by durable acceptance, not terminal completion')
    assert.equal(actions.get('act-accepted').status, 'progress')
    assert.equal(actions.get('act-accepted').progress, 'Preparing the private clone')
    assert.ok(actions.get('act-accepted').revision > response.revision)

    finish()
    await actions.settled('act-accepted')
    assert.equal(actions.get('act-accepted').status, 'confirmed')
  })

  test('confirmed progress prevents a short caller timeout while the accepted operation keeps running', async () => {
    let finish
    const terminal = new Promise((resolve) => { finish = resolve })
    const response = await Promise.race([
      actions.run(action('act-timeout'), async ({ accept }) => {
        accept()
        await terminal
        return { status: 'confirmed' }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no response')), 25)),
    ])

    assert.equal(response.status, 'accepted')
    finish()
    await actions.settled('act-timeout')
  })

  test('work that cannot accept records a refusal, while accepted work that breaks records a failure', async () => {
    const refused = await actions.run(action('act-refused'), async () => ({
      status: 'refused', reason: 'the ticket is already claimed', receipt: { by: 'alp', at: '2026-08-28T10:00:00.000Z' },
    }))
    assert.equal(refused.status, 'refused')
    assert.equal(refused.reason, 'the ticket is already claimed')
    assert.equal(refused.receipt.by, 'alp')

    const accepted = await actions.run(action('act-failed'), async ({ accept }) => {
      accept()
      throw new Error('the container could not start')
    })
    assert.equal(accepted.status, 'accepted')
    await actions.settled('act-failed')
    assert.equal(actions.get('act-failed').status, 'failed')
    assert.equal(actions.get('act-failed').reason, 'the container could not start')
  })

  test('a retry and a restarted reduction return journalled evidence without repeating the operation', async () => {
    let calls = 0
    await actions.run(action('act-retry'), async ({ accept, progress }) => {
      calls += 1
      accept()
      progress('Preparing the agent image')
      return new Promise(() => {})
    })

    const retry = await actions.run(action('act-retry'), async () => {
      calls += 1
      return { status: 'confirmed' }
    })
    assert.equal(retry.status, 'progress')
    assert.equal(calls, 1, 'the same action identity never repeats its side effect')

    reduction.close()
    reduction = new Reduction(dir)
    actions = new ActionCoordinator(reduction)
    assert.deepEqual(actions.get('act-retry'), retry)
    assert.deepEqual(actions.overview(), [retry], 'overview reads recover the nonterminal Action after restart')
  })

  test('dispatcher evidence reconciles an accepted Action whose coordinator was lost in a restart', async () => {
    await actions.run(action('act-recovered-spawn'), async ({ accept }) => {
      accept()
      return new Promise(() => {})
    })
    reduction.journal('agent_spawned', { repo: 'alp82/curia', ticket: '803', agent: 'curia-803' })
    assert.equal(actions.get('act-recovered-spawn').status, 'confirmed')

    await actions.run(action('act-recovered-failure'), async ({ accept }) => {
      accept()
      return new Promise(() => {})
    })
    reduction.journal('dispatch_unclaimed', {
      repo: 'alp82/curia', ticket: '803', agent: 'curia-803', reason: 'the daemon restarted during preparation',
    })
    assert.equal(actions.get('act-recovered-failure').status, 'failed')
    assert.equal(actions.get('act-recovered-failure').reason, 'the daemon restarted during preparation')

    reduction.close()
    reduction = new Reduction(dir)
    actions = new ActionCoordinator(reduction)
    assert.equal(actions.get('act-recovered-spawn').status, 'confirmed')
    assert.equal(actions.get('act-recovered-failure').status, 'failed')
  })

  test('terminal evidence is immutable', async () => {
    await actions.run(action('act-terminal'), async () => ({ status: 'refused', reason: 'not takeable' }))
    assert.throws(
      () => reduction.recordAction({ ...action('act-terminal'), status: 'confirmed' }),
      /terminal Action evidence is immutable/,
    )
  })
})
