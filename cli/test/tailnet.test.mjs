// The tailnet step of `curia install` (#891): the node joins the tailnet
// during installation, named up front, and the login happens on the
// terminal because the app is reachable only through Tailscale Serve.
//
// What is pinned: a logged-in node is reported and never renamed; a node
// that is not logged in is brought up as `--name` and the login link is the
// one action, with a bounded wait; the operator permission and the
// certificate are refusals that name the exact command or setting; the
// inspect-only form logs nothing in. Nothing here touches a tailnet: the
// `tailscale` CLI is a fake runner.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { LOGIN_TIMEOUT_MS, MAGICDNS_LABEL_RE, joinTailnet } from '../src/tailnet.mjs'
import { Refusal } from '../src/exit.mjs'

const DNS = 'curia.tail1234.ts.net'
const URL = 'https://login.tailscale.com/a/0123456789abcdef'

const running = (label = 'curia') => ({
  BackendState: 'Running',
  CertDomains: [`${label}.tail1234.ts.net`],
  Self: { DNSName: `${label}.tail1234.ts.net.`, Online: true, TailscaleIPs: ['100.98.118.33'] },
})
const loggedOut = () => ({ BackendState: 'NeedsLogin', CertDomains: [], Self: { DNSName: '', Online: false } })

// A fake `tailscale`: `status` is the node's answer, `up` says what
// `tailscale up` does (the lines it prints, whether it is denied, and after
// how many status reads the node is Running), `serve` whether `serve
// status` is permitted. Every call is recorded.
function fakeTailscale({ status = running(), up = {}, serve = { ok: true } } = {}) {
  const calls = []
  const state = { status, reads: 0 }
  const run = async (args, { onLine } = {}) => {
    calls.push(args)
    const line = args.join(' ')
    if (line === 'status --json') {
      state.reads += 1
      if (up.after !== undefined && state.reads > up.after) state.status = up.becomes ?? running()
      if (state.status instanceof Error) return { ok: false, stdout: '', stderr: state.status.message, code: 1 }
      return { ok: true, stdout: JSON.stringify(state.status), stderr: '' }
    }
    if (args[0] === 'up') {
      if (up.denied) return { ok: false, stdout: '', stderr: 'Access denied: tailscale up requires root or operator permission\n', code: 1 }
      if (up.fails) return { ok: false, stdout: '', stderr: up.fails, code: 1 }
      for (const l of up.lines ?? ['', 'To authenticate, visit:', '', `\t${URL}`, '']) onLine?.(l)
      return { ok: true, stdout: '', stderr: '' }
    }
    if (line === 'serve status') {
      if (serve.ok) return { ok: true, stdout: 'No serve config\n', stderr: '' }
      return { ok: false, stdout: '', stderr: 'Access denied: serve config denied\n', code: 1 }
    }
    return { ok: false, stdout: '', stderr: `fake: no such tailscale command: ${line}`, code: 1 }
  }
  run.calls = calls
  run.state = state
  return run
}

async function join({ name = 'curia', mode = 'join', tailscale = fakeTailscale(), clock = 0 } = {}) {
  const out = []
  let error = null
  let result = null
  const stdout = { write: (s) => { out.push(s); return true } }
  let time = clock
  try {
    result = await joinTailnet({ name, mode, user: 'operator', stdout }, { tailscale, sleep: async (ms) => { time += ms }, now: () => time })
  } catch (e) {
    error = e
  }
  return { result, error, out: out.join(''), tailscale }
}

describe('the name', () => {
  test('is a MagicDNS label: lowercase letters, digits, and hyphens, up to 63, not starting or ending with a hyphen', () => {
    for (const ok of ['curia', 'curia-2', 'a', 'x'.repeat(63)]) assert.ok(MAGICDNS_LABEL_RE.test(ok), ok)
    for (const bad of ['', 'curia.sh', 'Curia', '-curia', 'curia-', 'x'.repeat(64), 'my box']) assert.ok(!MAGICDNS_LABEL_RE.test(bad), bad)
  })
})

describe('a node that is logged in', () => {
  test('is reported with its name and MagicDNS address, and nothing is changed', async () => {
    const r = await join()
    assert.equal(r.error, null, r.error?.stack)
    assert.deepEqual(r.result, { name: 'curia', address: DNS, loggedIn: false })
    assert.match(r.out, /node curia \(curia\.tail1234\.ts\.net\) is logged in to the tailnet/)
    assert.match(r.out, /operator may use Tailscale Serve/)
    assert.match(r.out, /HTTPS certificate for curia\.tail1234\.ts\.net/)
    assert.ok(r.tailscale.calls.every((c) => c[0] !== 'up'), 'never runs tailscale up on a logged-in node')
  })

  test('under another name than --name says so as a fact and continues with the actual name', async () => {
    const r = await join({ name: 'curia', tailscale: fakeTailscale({ status: running('alp-workstation') }) })
    assert.equal(r.error, null, r.error?.stack)
    assert.deepEqual(r.result, { name: 'alp-workstation', address: 'alp-workstation.tail1234.ts.net', loggedIn: false })
    assert.match(r.out, /this node is named alp-workstation, not curia\. The tailnet step never renames a node/)
    assert.match(r.out, /Node name field of the Tailscale card/)
    assert.match(r.out, /sudo tailscale set --hostname curia/)
    assert.match(r.out, /--name alp-workstation/)
    assert.ok(r.tailscale.calls.every((c) => c[0] === 'status' || c[0] === 'serve'), 'only reads')
  })
})

describe('a node that is not logged in', () => {
  test('is brought up as --name, the login link is printed as the one action, and the step waits for the login', async () => {
    const tailscale = fakeTailscale({ status: loggedOut(), up: { after: 3 } })
    const r = await join({ tailscale })
    assert.equal(r.error, null, r.error?.stack)
    assert.deepEqual(r.result, { name: 'curia', address: DNS, loggedIn: true })
    assert.deepEqual(tailscale.calls.filter((c) => c[0] === 'up'), [['up', '--hostname', 'curia', '--timeout', '10m']])
    assert.match(r.out, /not logged in to a tailnet; joining it as curia/)
    assert.match(r.out, /Open this link on a device where you are signed in to Tailscale and approve this machine:\n\s+https:\/\/login\.tailscale\.com\/a\/0123456789abcdef/)
    assert.match(r.out, /logged in as node curia \(curia\.tail1234\.ts\.net\)/)
    assert.ok(tailscale.calls.filter((c) => c[0] === 'status').length >= 4, 'polled the status until the node was running')
    assert.ok(tailscale.calls.findIndex((c) => c[0] === 'serve') > tailscale.calls.findIndex((c) => c[0] === 'up'), 'the operator permission is checked after the login')
  })

  test('the login link is the only URL printed, and the node name the tailnet gave is the one reported', async () => {
    const tailscale = fakeTailscale({ status: loggedOut(), up: { after: 1, becomes: running('curia-1') } })
    const r = await join({ tailscale })
    assert.equal(r.error, null, r.error?.stack)
    assert.equal(r.result.name, 'curia-1')
    assert.match(r.out, /this node is named curia-1, not curia/)
    assert.equal((r.out.match(/https:\/\/login\.tailscale\.com/g) ?? []).length, 1)
  })

  test('a login that does not arrive within the bound fails at this step, and a rerun lands here again', async () => {
    const tailscale = fakeTailscale({ status: loggedOut(), up: { after: 10_000 } })
    const r = await join({ tailscale })
    assert.ok(r.error && !(r.error instanceof Refusal))
    assert.match(r.error.message, /no login arrived within 10 minutes/)
    assert.match(r.error.message, /run the command again/)
    assert.equal(LOGIN_TIMEOUT_MS, 10 * 60 * 1000)
  })

  test('a tailscale up that is denied is the operator refusal with the exact command', async () => {
    const r = await join({ tailscale: fakeTailscale({ status: loggedOut(), up: { denied: true } }) })
    assert.ok(r.error instanceof Refusal, r.error?.stack)
    assert.match(r.error.message, /may not operate Tailscale on this host \(Access denied/)
    assert.match(r.error.message, /Run `sudo tailscale set --operator=operator` and run the command again/)
  })

  test('a tailscale up that fails otherwise fails the step with its own sentence', async () => {
    const r = await join({ tailscale: fakeTailscale({ status: loggedOut(), up: { fails: 'backend error: control server unreachable\n' } }) })
    assert.ok(r.error && !(r.error instanceof Refusal))
    assert.match(r.error.message, /tailscale up failed: backend error: control server unreachable/)
  })

  test('the inspect-only form logs nothing in and refuses, naming curia install', async () => {
    const tailscale = fakeTailscale({ status: loggedOut() })
    const r = await join({ mode: 'inspect', tailscale })
    assert.ok(r.error instanceof Refusal, r.error?.stack)
    assert.match(r.error.message, /not logged in to a tailnet \(NeedsLogin\)/)
    assert.match(r.error.message, /curia install/)
    assert.ok(tailscale.calls.every((c) => c[0] === 'status'), 'only reads')
  })
})

describe('after the login', () => {
  test('an operator who may not use Serve is refused with the exact command', async () => {
    const r = await join({ tailscale: fakeTailscale({ serve: { ok: false } }) })
    assert.ok(r.error instanceof Refusal, r.error?.stack)
    assert.match(r.error.message, /may not operate Tailscale on this host \(Access denied: serve config denied\)/)
    assert.match(r.error.message, /Run `sudo tailscale set --operator=operator` and run the command again/)
  })

  test('a tailnet that issues no HTTPS certificate is refused naming the HTTPS setting', async () => {
    const r = await join({ tailscale: fakeTailscale({ status: { ...running(), CertDomains: [] } }) })
    assert.ok(r.error instanceof Refusal, r.error?.stack)
    assert.match(r.error.message, /issues no HTTPS certificate for this node/)
    assert.match(r.error.message, /Enable HTTPS certificates under DNS in the Tailscale admin console at https:\/\/login\.tailscale\.com\/admin\/dns/)
  })

  test('a certificate that arrives a moment after the login is waited for', async () => {
    const tailscale = fakeTailscale({ status: loggedOut(), up: { after: 1, becomes: { ...running(), CertDomains: [] } } })
    let reads = 0
    const inner = tailscale
    const late = async (args, opts) => {
      const answer = await inner(args, opts)
      if (args[0] === 'status' && answer.ok) {
        reads += 1
        if (reads >= 4) return { ...answer, stdout: JSON.stringify(running()) }
      }
      return answer
    }
    late.calls = inner.calls
    const r = await join({ tailscale: late })
    assert.equal(r.error, null, r.error?.stack)
    assert.equal(r.result.address, DNS)
  })

  test('a tailscaled that stops answering fails the step with its sentence', async () => {
    const r = await join({ tailscale: fakeTailscale({ status: new Error('failed to connect to local tailscaled') }) })
    assert.ok(r.error && !(r.error instanceof Refusal))
    assert.match(r.error.message, /tailscale status failed: failed to connect to local tailscaled/)
  })

  test('never prints a secret-shaped value', async () => {
    const r = await join({ tailscale: fakeTailscale({ status: loggedOut(), up: { after: 1 } }) })
    assert.doesNotMatch(r.out, /token|password|secret|tskey/i)
  })
})
