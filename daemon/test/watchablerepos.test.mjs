import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { TokenMinter } from '../src/githubapp.mjs'
import { WatchableRepos } from '../src/watchablerepos.mjs'

test('discovery mints an installation token without asking for a host login', async () => {
  const calls = []
  const app = new TokenMinter({ appId: '42', key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    fetchImpl: async (url, init) => {
      const route = new URL(url).pathname
      calls.push(route)
      let payload
      if (route === '/app/installations') payload = [{ id: 7, account: { login: 'owner' } }]
      else if (route === '/app/installations/7/access_tokens') payload = { token: 'ghs_fixture', expires_at: new Date(Date.now() + 3600_000).toISOString() }
      else if (route === '/installation/repositories') {
        assert.equal(init.headers.authorization, 'Bearer ghs_fixture')
        payload = { repositories: [{ full_name: 'Owner/Repo' }] }
      } else assert.fail(`Unexpected route: ${route}`)
      return { ok: true, text: async () => JSON.stringify(payload) }
    },
  })
  const discovery = new WatchableRepos({ minter: () => app, legacy: () => assert.fail('host login consulted') })
  assert.deepEqual((await discovery.read()).repos, ['owner/repo'])
  assert.deepEqual(calls, ['/app/installations', '/app/installations/7/access_tokens', '/installation/repositories'])
})

test('retry bypasses cached success and retains stale repositories on failure', async () => {
  let failure = false, reads = 0
  const app = { refreshInstallations: async () => { reads++; if (failure) throw Object.assign(new Error('secret diagnostic'), { status: 403 }); return [{ owner: 'o' }] }, reposFor: async () => ['o/r'] }
  const discovery = new WatchableRepos({ minter: () => app })
  await discovery.read()
  await discovery.read()
  assert.equal(reads, 1)
  failure = true
  const failed = await discovery.read({ refresh: true })
  assert.equal(failed.stale, true)
  assert.deepEqual(failed.repos, ['o/r'])
  assert.equal(failed.recovery, 'setup')
  assert.doesNotMatch(JSON.stringify(failed), /secret diagnostic/)
  failure = false
  assert.equal((await discovery.read({ refresh: true })).error, null)
  assert.equal(reads, 3)
})

test('transient errors retry with bounded backoff and failed reads are not cached', async () => {
  let reads = 0, failure = true
  const waits = []
  const app = { refreshInstallations: async () => { reads++; if (failure) throw Object.assign(new Error('outage'), { status: 502 }); return [] } }
  const discovery = new WatchableRepos({ minter: () => app, sleep: async (ms) => waits.push(ms) })
  const failed = await discovery.read()
  assert.equal(failed.recovery, 'retry')
  assert.equal(failed.repos, null)
  assert.equal(reads, 3)
  assert.deepEqual(waits, [250, 500])
  failure = false
  assert.deepEqual((await discovery.read()).repos, [])
})

test('a missing App offers setup and never invents an empty repository list', async () => {
  const discovery = new WatchableRepos({ minter: () => null })
  assert.equal((await discovery.read()).recovery, 'setup')
  assert.equal((await discovery.read()).repos, null)
})

test('source installations can use the legacy reader and concurrent requests share a read', async () => {
  let reads = 0
  const discovery = new WatchableRepos({ minter: () => null, legacy: async () => { reads++; return { login: 'operator', repos: ['o/r'] } } })
  const [first, second] = await Promise.all([discovery.read(), discovery.read({ refresh: true })])
  assert.equal(reads, 1)
  assert.equal(first, second)
  assert.equal(first.source, 'host')
})

test('all owners are combined and a failure never masquerades as a partial success', async () => {
  let failure = false
  const app = { refreshInstallations: async () => [{ owner: 'a' }, { owner: 'b' }],
    reposFor: async (owner) => {
      if (failure && owner === 'b') throw Object.assign(new Error('no access'), { status: 403 })
      return [owner + '/repo']
    } }
  const discovery = new WatchableRepos({ minter: () => app })
  assert.deepEqual((await discovery.read()).repos, ['a/repo', 'b/repo'])
  failure = true
  const failed = await discovery.read({ refresh: true })
  assert.equal(failed.stale, true)
  assert.deepEqual(failed.repos, ['a/repo', 'b/repo'])
  assert.ok(failed.error)
})
