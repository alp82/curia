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

  test('daemon lifecycle evidence reconciles a restart Action after the process exits', () => {
    const restart = {
      action_id: 'atlas-daemon-restart', kind: 'daemon-restart', target: 'daemon', conflict_key: 'daemon:lifecycle',
    }
    reduction.recordAction({ ...restart, status: 'accepted' })
    reduction.journal('restart_requested', {
      by: 'dashboard', exit_code: 75, action_id: restart.action_id,
    })
    assert.equal(actions.get(restart.action_id).status, 'progress')
    assert.equal(actions.get(restart.action_id).progress, 'Restarting daemon')

    reduction.close()
    reduction = new Reduction(dir)
    actions = new ActionCoordinator(reduction)
    assert.equal(actions.get(restart.action_id).status, 'progress')

    reduction.journal('daemon_boot', { pid: 4321 })
    assert.equal(actions.get(restart.action_id).status, 'confirmed')
    assert.equal(actions.get(restart.action_id).receipt.exit_code, 75)
  })

  test('terminal evidence is immutable', async () => {
    await actions.run(action('act-terminal'), async () => ({ status: 'refused', reason: 'not takeable' }))
    assert.throws(
      () => reduction.recordAction({ ...action('act-terminal'), status: 'confirmed' }),
      /terminal Action evidence is immutable/,
    )
  })

  test('a domain event that settles the Action releases the first response', async () => {
    const evidence = await Promise.race([
      actions.run(action('act-domain-ending'), async () => {
        reduction.recordAction({ ...action('act-domain-ending'), status: 'confirmed' })
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no response')), 25)),
    ])
    assert.equal(evidence.status, 'confirmed')
  })

  test('credential sign-in facts reconcile progress and every ending after restart', async () => {
    const signIn = {
      action_id: 'atlas-reauth-openai', kind: 'credential-sign-in', target: 'openai', conflict_key: 'reauth:openai',
    }
    await actions.run(signIn, async ({ accept, progress }) => {
      accept()
      progress('Preparing the agent image')
      return { status: 'progress' }
    })
    reduction.journal('reauth_started', { provider: 'openai', session: 'curia-auth-openai', action_id: signIn.action_id })
    assert.equal(actions.get(signIn.action_id).progress, 'Waiting for browser sign-in')
    reduction.journal('reauth_code_seen', { provider: 'openai', session: 'curia-auth-openai', action_id: signIn.action_id })
    assert.equal(actions.get(signIn.action_id).progress, 'Waiting for browser completion')
    reduction.journal('reauth_completed', { provider: 'openai', session: 'curia-auth-openai', action_id: signIn.action_id })
    assert.equal(actions.get(signIn.action_id).status, 'confirmed')

    for (const [event, reason] of [
      ['reauth_failed', 'the fresh credential was refused'],
      ['reauth_timed_out', 'the sign-in timed out'],
      ['reauth_code_expired', 'the one-time code expired'],
      ['reauth_abandoned', 'the sign-in session ended'],
    ]) {
      const id = `atlas-${event}`
      await actions.run({ ...signIn, action_id: id }, async ({ accept }) => {
        accept()
        return { status: 'progress' }
      })
      reduction.journal(event, { provider: 'openai', session: 'curia-auth-openai', action_id: id, why: reason })
      assert.equal(actions.get(id).status, 'failed')
      assert.equal(actions.get(id).reason, reason)
    }

    reduction.close()
    reduction = new Reduction(dir)
    actions = new ActionCoordinator(reduction)
    assert.equal(actions.get(signIn.action_id).status, 'confirmed')
    assert.equal(actions.get('atlas-reauth_abandoned').status, 'failed')
  })
})
