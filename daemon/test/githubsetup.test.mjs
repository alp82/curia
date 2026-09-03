// The GitHub card of integration setup (#875, filling the #874 seam under the
// #852 contract).
//
// What is pinned: the card is plain until the App's secret exists; once it
// does, verification is the current external fact — the installation read,
// one real write-token mint per installed owner, the repositories that
// installation states, and the tickets those repositories hold. A covered
// watched repository connects the card with a real discovered ticket when one
// exists and an honest zero-ticket line otherwise. Every miss is one failed
// verification with one corrective action. Nothing here touches the network:
// GitHub is a fake `fetch`, and the minter is the real one over it.

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { TokenMinter } from '../src/githubapp.mjs'
import { githubVerifier } from '../src/githubsetup.mjs'

let key
before(() => { key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })

const TOKEN = 'ghs_minted.for-this-read'

// A GitHub that answers by route. Every call is recorded with its method and
// its authorization header, so a test can say which credential did what.
function github(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const route = url.replace('https://api.github.com', '')
    calls.push({ route, method: init.method ?? 'GET', auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : null })
    const answer = routes[`${init.method ?? 'GET'} ${route}`] ?? routes[route]
    if (!answer) return { ok: false, status: 404, text: async () => JSON.stringify({ message: `no route ${route}` }) }
    const [status, body] = typeof answer === 'function' ? answer() : answer
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
  }
  return { fetchImpl, calls }
}

const installations = [{ id: 7, account: { login: 'alp82', id: 1001 } }]
const tokenAnswer = [201, { token: TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' } }]
const issue = (number, title, over = {}) => ({ number, title, state: 'open', html_url: `https://github.com/alp82/curia/issues/${number}`, labels: [], assignees: [], ...over })

function verifierOver(routes, { watch = [{ repo: 'alp82/curia' }], minter } = {}) {
  const gh = github(routes)
  const m = minter === undefined ? new TokenMinter({ appId: '42', key, fetchImpl: gh.fetchImpl }) : minter
  const verify = githubVerifier({ minter: () => m, watch: () => watch, fetchImpl: gh.fetchImpl })
  return { verify, gh }
}

describe('the GitHub card (#875)', () => {
  test('with no App secret on disk the card is unconnected, and GitHub is not asked anything', async () => {
    const { verify, gh } = verifierOver({}, { minter: null })
    assert.deepEqual(await verify({ progress: {} }), { ok: false, unconnected: true, detail: { step: 'create' } })
    assert.equal(gh.calls.length, 0)
  })

  test('with no watched repository there is nothing an installation could cover: the card is plain at the watch step, not failed', async () => {
    const { verify } = verifierOver({
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }] }],
    }, { watch: [] })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.unconnected, true)
    assert.equal(answer.failed, undefined, 'an expected step is never a failure')
    assert.equal(answer.detail.step, 'watch')
  })

  test('an App GitHub refuses is one failed verification naming the refusal, with the App and the clock as the action', async () => {
    const { verify } = verifierOver({ '/app/installations?per_page=100': [401, { message: 'Bad credentials' }] })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /refused curia's app JWT \(401\)/)
    assert.match(answer.action, /try again/i)
  })

  test('an App installed on none of the watched owners names the owners to install on', async () => {
    const { verify } = verifierOver({ '/app/installations?per_page=100': [200, []] }, { watch: [{ repo: 'alp82/curia' }, { repo: 'getalfredo/landing-page' }] })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /not installed on alp82 or getalfredo/)
    assert.match(answer.action, /Install the App on alp82/)
    assert.deepEqual(answer.detail, {
      step: 'install',
      owners: [{ owner: 'alp82', installed: false }, { owner: 'getalfredo', installed: false }],
      covered: [], watched: ['alp82/curia', 'getalfredo/landing-page'], available: [], install_url: 'https://github.com/settings/installations',
    })
  })

  test('a mint the installation refuses is the failed verification, and the action is the grant', async () => {
    const { verify } = verifierOver({
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': [422, { message: 'The permissions requested are not granted to this installation.' }],
    })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /could not mint an installation token for alp82/)
    assert.match(answer.failed, /permissions requested are not granted/)
    assert.match(answer.action, /Accept the App's permissions on the alp82 installation/)
  })

  test('an installation that covers no watched repository fails on coverage, and the action names the repository to grant', async () => {
    const { verify, gh } = verifierOver({
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/other' }] }],
    })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /doesn't cover alp82\/curia/)
    assert.match(answer.action, /Grant the App access to alp82\/curia on the alp82 installation/)
    // The coverage read runs on the token this verification minted, with the
    // write set agents need — the credential the card has to prove.
    const mint = gh.calls.find((c) => c.route === '/app/installations/7/access_tokens')
    assert.deepEqual(mint.body, { permissions: { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' } })
    assert.equal(gh.calls.find((c) => c.route.startsWith('/installation/repositories')).auth, `Bearer ${TOKEN}`)
  })

  test('a covered repository with a ready-for-agent ticket connects the card on that real ticket', async () => {
    const { verify, gh } = verifierOver({
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }] }],
      '/repos/alp82/curia/issues?state=open&per_page=100': [200, [
        issue(900, 'A pull request', { pull_request: { url: 'x' } }),
        issue(862, 'Something claimed', { labels: [{ name: 'ready-for-agent' }], assignees: [{ login: 'alp82' }] }),
        issue(861, 'Chart backup and recovery lifecycle', { labels: [{ name: 'ready-for-agent' }] }),
        issue(850, 'A plain open issue'),
      ]],
    })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, true)
    assert.equal(answer.emoji, '🎫')
    assert.equal(answer.primary, '#861 · Chart backup and recovery lifecycle')
    assert.equal(answer.secondary, 'ready-for-agent · alp82/curia · 3 open tickets')
    assert.deepEqual(answer.detail.ticket, { repo: 'alp82/curia', number: 861, title: 'Chart backup and recovery lifecycle', url: 'https://github.com/alp82/curia/issues/861' })
    assert.deepEqual(answer.detail.covered, ['alp82/curia'])
    assert.equal(answer.detail.open_tickets, 3)
    assert.deepEqual(answer.detail.owners, [{ owner: 'alp82', installed: true }])
    assert.equal(gh.calls.find((c) => c.route.startsWith('/repos/alp82/curia/issues')).auth, `Bearer ${TOKEN}`)
    assert.ok(!JSON.stringify(answer).includes(TOKEN), 'the minted token is used and dropped, never reported')
  })

  test('a covered repository with no open ticket is an honest zero, naming the repository and what the credential can do', async () => {
    const { verify } = verifierOver({
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }] }],
      '/repos/alp82/curia/issues?state=open&per_page=100': [200, []],
    })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, true)
    assert.equal(answer.emoji, '📦')
    assert.equal(answer.primary, 'alp82/curia')
    assert.equal(answer.secondary, 'No open tickets · Issues, pull requests, and contents ready')
    assert.equal(answer.detail.ticket, null)
    assert.equal(answer.detail.open_tickets, 0)
  })

  test('open tickets with none ready for an agent are counted, not invented', async () => {
    const { verify } = verifierOver({
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }] }],
      '/repos/alp82/curia/issues?state=open&per_page=100': [200, [issue(850, 'Plain'), issue(851, 'Also plain')]],
    })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, true)
    assert.equal(answer.primary, 'alp82/curia')
    assert.equal(answer.secondary, '2 open tickets, none ready for an agent · Issues, pull requests, and contents ready')
    assert.equal(answer.detail.ticket, null)
  })

  test('a ticket read GitHub refuses is a failed verification, not a zero', async () => {
    const { verify } = verifierOver({
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }] }],
      '/repos/alp82/curia/issues?state=open&per_page=100': [503, { message: 'unavailable' }],
    })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /could not read the tickets of alp82\/curia/)
    assert.match(answer.action, /try again/i)
  })

  test('try again repeats the current verification: the installation read and the mint run again, and a repaired install connects', async () => {
    let installed = false
    const { verify, gh } = verifierOver({
      '/app/installations?per_page=100': () => [200, installed ? installations : []],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }] }],
      '/repos/alp82/curia/issues?state=open&per_page=100': [200, []],
    })
    assert.equal((await verify({ progress: {} })).ok, false)
    installed = true
    assert.equal((await verify({ progress: {} })).ok, true)
    assert.equal((await verify({ progress: {} })).ok, true)
    assert.equal(gh.calls.filter((c) => c.route === '/app/installations?per_page=100').length, 3)
    assert.equal(gh.calls.filter((c) => c.route === '/app/installations/7/access_tokens').length, 2, 'every verification mints afresh; nothing is a cached yes')
  })
})

// The rehearsal of the packaged lifecycle (#891) found the card summing every
// watched owner into one "not installed" sentence while one of them was
// installed, and a fresh installation with no watched repository had nowhere
// to go. The rule (#875) is that ONE covered watched repository connects the
// card; a missing owner is a fact the detail carries, never a failure while
// another owner covers; and with no watch list the card offers the
// repositories the App's installations cover so the operator can choose.
describe('the GitHub card after the rehearsal (#891)', () => {
  const appFacts = [200, { id: 42, slug: 'curia-box', name: 'curia-box', owner: { login: 'alp82' }, html_url: 'https://github.com/apps/curia-box' }]

  test('one installed owner that covers a watched repository connects the card, and the other owner is missing as a fact only', async () => {
    const { verify } = verifierOver({
      '/app': appFacts,
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }] }],
      '/repos/alp82/curia/issues?state=open&per_page=100': [200, []],
    }, { watch: [{ repo: 'getalfredo/landing-page' }, { repo: 'alp82/curia' }] })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.deepEqual(answer.detail.owners, [{ owner: 'getalfredo', installed: false }, { owner: 'alp82', installed: true }])
    assert.deepEqual(answer.detail.covered, ['alp82/curia'])
    assert.deepEqual(answer.detail.watched, ['getalfredo/landing-page', 'alp82/curia'])
    assert.ok(!JSON.stringify(answer).includes('not installed'), 'an installed owner is never called missing')
  })

  test('with no installed owner the failure names exactly the missing owners, which is every watched one', async () => {
    const { verify } = verifierOver({ '/app': appFacts, '/app/installations?per_page=100': [200, []] }, { watch: [{ repo: 'alp82/curia' }, { repo: 'getalfredo/landing-page' }] })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.failed, "curia's GitHub App is not installed on alp82 or getalfredo")
    assert.deepEqual(answer.detail.owners, [{ owner: 'alp82', installed: false }, { owner: 'getalfredo', installed: false }])
  })

  test('with no watched repository and an installed App, the card lists the repositories the installations cover, so the operator can choose', async () => {
    const { verify, gh } = verifierOver({
      '/app': appFacts,
      '/app/installations?per_page=100': [200, [...installations, { id: 8, account: { login: 'getalfredo', id: 2002 } }]],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      'POST /app/installations/8/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': () => {
        const last = gh.calls.filter((c) => c.route === '/app/installations/8/access_tokens').length
        return [200, { repositories: last ? [{ full_name: 'getalfredo/landing-page' }] : [{ full_name: 'alp82/curia' }, { full_name: 'alp82/aistack' }] }]
      },
    }, { watch: [] })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.unconnected, true, 'the choice is a step of the guide, not a failure')
    assert.equal(answer.detail.step, 'watch')
    assert.deepEqual(answer.detail.available, ['alp82/curia', 'alp82/aistack', 'getalfredo/landing-page'])
    assert.deepEqual(answer.detail.watched, [])
    assert.deepEqual(answer.detail.owners, [])
    assert.equal(answer.detail.install_url, 'https://github.com/apps/curia-box/installations/new')
    assert.ok(!JSON.stringify(answer).includes(TOKEN))
  })

  test('with no watched repository and no installation, the card is plain at the install step with the install link, not failed', async () => {
    const { verify } = verifierOver({ '/app': appFacts, '/app/installations?per_page=100': [200, []] }, { watch: [] })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.unconnected, true)
    assert.equal(answer.failed, undefined)
    assert.equal(answer.detail.step, 'install')
    assert.deepEqual(answer.detail.available, [])
    assert.equal(answer.detail.install_url, 'https://github.com/apps/curia-box/installations/new')
  })

  test('a connected card carries the repositories the installations cover beside the watched ones, so the choice can be changed', async () => {
    const { verify } = verifierOver({
      '/app': appFacts,
      '/app/installations?per_page=100': [200, installations],
      'POST /app/installations/7/access_tokens': tokenAnswer,
      '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }, { full_name: 'alp82/aistack' }] }],
      '/repos/alp82/curia/issues?state=open&per_page=100': [200, []],
    })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.detail.available, ['alp82/curia', 'alp82/aistack'])
    assert.deepEqual(answer.detail.watched, ['alp82/curia'])
  })
})

// The approval is posted as the operator (#891, ADR-0031), so the card proves
// the operator's own authorization is present and GitHub accepts it, and
// reports the login as a fact. A missing one, or one GitHub refuses and curia
// cannot refresh, is a real failure whose action is the reinstall. The source
// deployment wires no operator and keeps its host login, so the card says
// nothing about it there.
describe('the operator authorization on the GitHub card (#891)', () => {
  const routes = () => ({
    '/app/installations?per_page=100': [200, installations],
    'POST /app/installations/7/access_tokens': tokenAnswer,
    '/installation/repositories?per_page=100&page=1': [200, { repositories: [{ full_name: 'alp82/curia' }] }],
    '/repos/alp82/curia/issues?state=open&per_page=100': [200, []],
  })

  test('a present, accepted authorization is a fact on the connected card: the login, never the token', async () => {
    const gh = github(routes())
    const m = new TokenMinter({ appId: '42', key, fetchImpl: gh.fetchImpl })
    const operator = { verify: async () => ({ login: 'alp' }) }
    const verify = githubVerifier({ minter: () => m, watch: () => [{ repo: 'alp82/curia' }], operator: () => operator, fetchImpl: gh.fetchImpl })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.deepEqual(answer.detail.operator, { login: 'alp' })
    assert.equal(answer.secondary, 'No open tickets · Issues, pull requests, and contents ready · approvals as alp')
  })

  test('a missing or refused authorization fails the card at the install step, with the reinstall as the action', async () => {
    const gh = github(routes())
    const m = new TokenMinter({ appId: '42', key, fetchImpl: gh.fetchImpl })
    const operator = { verify: async () => { throw new Error('curia holds no GitHub authorization for you, so it cannot post the approval as you. Reinstall the App from the GitHub card of Setup, which authorizes curia as you again') } }
    const verify = githubVerifier({ minter: () => m, watch: () => [{ repo: 'alp82/curia' }], operator: () => operator, fetchImpl: gh.fetchImpl })
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.unconnected, undefined, 'a lost authorization is a real failure')
    assert.match(answer.failed, /holds no GitHub authorization for you/)
    assert.match(answer.action, /Reinstall the App from the link in this panel/)
    assert.equal(answer.detail.step, 'install')
    assert.equal(answer.detail.install_url, 'https://github.com/settings/installations')
    assert.equal(gh.calls.some((c) => c.route.startsWith('/repos/')), false, 'the tickets are not read past a failed authorization')
  })

  test('with no installation yet the authorization is not asked for: the install is what produces it', async () => {
    const gh = github({ '/app/installations?per_page=100': [200, []] })
    const m = new TokenMinter({ appId: '42', key, fetchImpl: gh.fetchImpl })
    let asked = 0
    const operator = { verify: async () => { asked += 1; throw new Error('none') } }
    const verify = githubVerifier({ minter: () => m, watch: () => [], operator: () => operator, fetchImpl: gh.fetchImpl })
    const answer = await verify({ progress: {} })
    assert.equal(answer.unconnected, true)
    assert.equal(answer.detail.step, 'install')
    assert.equal(asked, 0)
  })

  test('the source deployment wires no operator, and the card says nothing about one', async () => {
    const { verify } = verifierOver(routes())
    const answer = await verify({ progress: {} })
    assert.equal(answer.ok, true)
    assert.equal('operator' in answer.detail, false)
    assert.equal(answer.secondary, 'No open tickets · Issues, pull requests, and contents ready')
  })
})
