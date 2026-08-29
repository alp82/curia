// Registering the box with aistack from Settings (#706, from the spec at #684).
//
// What is pinned here is the four things the acceptance criteria name: that
// curia starts the device flow and holds its code and link, that the status it
// answers names the machine and the last sync verdict, that no credential
// CONTENT can reach that status, and that each way a registration ends has a
// precise act after it.
//
// The flow spawns a real child process, so every test that runs one hands it a
// stub `npx` the test writes. Nothing here reaches aistack.to and nothing
// registers anything anywhere.

import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CLI_PACKAGE, DEFAULT_CLI_VERSION, credentialFile, homeFor } from '../src/aistack.mjs'
import {
  AistackRegistration, LOGIN_TIMEOUT_MS,
  loginArgs, optInArgs, logFile, parseDeviceFlow, registeredServers, shellLine,
} from '../src/aistackreg.mjs'
import { Reduction } from '../src/reduction.mjs'

let root
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-aistackreg-'))
  fs.mkdirSync(homeFor(root), { recursive: true })
})

// The credential a finished login leaves behind. The token is fake and stays in
// the temp directory.
function writeCredential(token = 'x'.repeat(64)) {
  const file = credentialFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ servers: { 'https://aistack.to': { token, userId: 'user-id-never-on-the-wire' } } }))
  return file
}

// A stub `npx`. It checks the argument shape curia promises to pass, prints
// what the CLI prints, and optionally writes the credential the way an approved
// login does.
function stubNpx({ print = '', code = 0, sleep = 0, writes = false, expect = 'login' } = {}) {
  const bin = path.join(root, 'npx-stub')
  const cred = credentialFile(root)
  fs.writeFileSync(bin, [
    '#!/bin/bash',
    'if [ "$1" != "-y" ]; then echo "the command did not pass -y" >&2; exit 90; fi',
    'case "$2" in @use-aistack/cli@*) ;; *) echo "the command did not pin the CLI: $2" >&2; exit 91;; esac',
    expect === 'login'
      ? 'if [ "$3" != "login" ]; then echo "not the login: $3" >&2; exit 92; fi'
      : 'if [ "$3" != "sync" ] || [ "$4" != "--auto" ] || [ "$5" != "on" ]; then echo "not the opt-in" >&2; exit 92; fi',
    `case "$HOME" in ${homeFor(root)}) ;; *) echo "the command did not run as curia's HOME: $HOME" >&2; exit 93;; esac`,
    // `%b`, so a multi-line `print` really is several lines, the way the CLI's
    // own output is.
    `printf '%b\\n' ${JSON.stringify(print)}`,
    writes ? `mkdir -p "$(dirname ${cred})" && printf '%s' '{"servers":{"https://aistack.to":{"token":"${'z'.repeat(64)}","userId":"u1"}}}' > ${cred}` : '',
    // `exec`, so a kill reaches the sleep rather than the bash that forked it.
    sleep > 0 ? `exec sleep ${sleep}` : '',
    `exit ${code}`,
  ].filter(Boolean).join('\n'))
  fs.chmodSync(bin, 0o755)
  return bin
}

const reg = (over = {}) => new AistackRegistration({
  root, hostname: () => 'curia.sh', ...over,
})

// The CLI's own two lines, as the prototype recorded them.
const DEVICE = 'CODE T72NNC\nOPEN https://aistack.to/cli/auth?code=T72NNC'

describe('the device flow curia starts (#706)', () => {
  test('the code and the link are read out of what the CLI printed', () => {
    assert.deepEqual(parseDeviceFlow(DEVICE), { code: 'T72NNC', url: 'https://aistack.to/cli/auth?code=T72NNC' })
  })

  test('the two halves are read separately, so an order change still finds both', () => {
    const seen = parseDeviceFlow('OPEN https://aistack.to/cli/auth?code=AB12\nwaiting…\nCODE AB12')
    assert.deepEqual(seen, { code: 'AB12', url: 'https://aistack.to/cli/auth?code=AB12' })
  })

  test('output with neither half in it is not half a flow', () => {
    assert.equal(parseDeviceFlow('npm warn exec the following package was not found'), null)
    assert.equal(parseDeviceFlow(''), null)
  })

  test('the login and the opt-in are the README\'s own two commands, pinned', () => {
    assert.deepEqual(loginArgs('9.9.9'), ['-y', `${CLI_PACKAGE}@9.9.9`, 'login'])
    assert.deepEqual(optInArgs('9.9.9'), ['-y', `${CLI_PACKAGE}@9.9.9`, 'sync', '--auto', 'on'])
    assert.match(loginArgs()[1], new RegExp(`@${DEFAULT_CLI_VERSION}$`), 'the default is the pinned version, never latest')
    assert.ok(!loginArgs().some((a) => a.includes('latest')))
  })

  test('the shell line names curia\'s HOME, because that is the whole trick', () => {
    assert.equal(shellLine('/w/home', ['-y', 'p', 'login']), 'HOME=/w/home npx -y p login')
  })
})

describe('the credential never reaches the browser (#706)', () => {
  test('the status carries the hosts the file is keyed by, and no value out of it', () => {
    writeCredential('secret-token-' + 'q'.repeat(50))
    const s = reg().status()
    const wire = JSON.stringify(s)
    assert.deepEqual(s.machine.servers, ['aistack.to'])
    assert.ok(!wire.includes('secret-token'), 'the bearer is not on this wire')
    assert.ok(!wire.includes('user-id-never-on-the-wire'), 'nor is anything else the file holds')
  })

  test('a credential file that grows new secret fields still yields only keys', () => {
    const file = credentialFile(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      servers: { 'https://aistack.to': { token: 'a'.repeat(64), refresh: 'b'.repeat(64), whateverIsNext: 'c'.repeat(64) } },
    }))
    assert.deepEqual(registeredServers(root), ['aistack.to'])
  })

  test('a key that is not a url is dropped rather than shown raw', () => {
    const file = credentialFile(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ servers: { 'not a url': { token: 'x' } } }))
    assert.deepEqual(registeredServers(root), [])
  })

  test('no file, unreadable file, and nonsense in the file are all no servers', () => {
    assert.deepEqual(registeredServers(root), [])
    const file = credentialFile(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'not json at all')
    assert.deepEqual(registeredServers(root), [])
    fs.writeFileSync(file, JSON.stringify({ servers: ['https://aistack.to'] }))
    assert.deepEqual(registeredServers(root), [])
  })

  test('curia writes no configuration for any of this — the credential is the switch', () => {
    // #695 gave the sync no `enabled` key deliberately. What proves that here is
    // that this object has no way to write one: it takes no config file, and the
    // only paths it names are curia's own HOME.
    const r = reg()
    assert.equal(r.registered(), false)
    writeCredential()
    assert.equal(r.registered(), true, 'the file appearing is the whole of the switch')
    assert.equal(logFile(root), path.join(homeFor(root), '.config', 'aistack', 'sync.log'))
  })
})

describe('what the status says before, during and after (#706)', () => {
  test('an unregistered box has no machine and nothing in flight', () => {
    const s = reg().status()
    assert.equal(s.registered, false)
    assert.equal(s.machine, null)
    assert.equal(s.flow.phase, 'unregistered')
    assert.match(s.commands.login, /login$/)
    assert.match(s.commands.opt_in, /sync --auto on$/)
  })

  test('a registered box names the machine it PROPOSED, and says when', () => {
    writeCredential()
    const s = reg().status({ machine: { machine: 'curia.sh', at: 1700 } })
    assert.equal(s.registered, true)
    assert.deepEqual(s.machine, { proposed: 'curia.sh', servers: ['aistack.to'], at: 1700 })
  })

  test('a registration curia has no record of still names the box, from its hostname', () => {
    writeCredential()
    const s = reg().status()
    assert.equal(s.machine.proposed, 'curia.sh')
    assert.equal(s.machine.at, null, 'unknown when, rather than a made-up instant')
  })
})

describe('one login at a time, and each way it ends (#706)', () => {
  test('the press holds the code and the link, and journals that it is waiting', async () => {
    const events = []
    const r = reg({ bin: stubNpx({ print: DEVICE, sleep: 30 }), journal: (t, d) => events.push([t, d]) })
    const out = await r.begin()
    assert.equal(out.ok, true)
    assert.equal(out.flow.phase, 'waiting')
    assert.equal(out.flow.code, 'T72NNC')
    assert.equal(out.flow.url, 'https://aistack.to/cli/auth?code=T72NNC')
    assert.equal(out.flow.expires_at - out.flow.started_at, LOGIN_TIMEOUT_MS)
    assert.deepEqual(events[0][0], 'aistack_login_started')
    r.cancel()
  })

  test('a second press returns the login already running rather than a rival code', async () => {
    const r = reg({ bin: stubNpx({ print: DEVICE, sleep: 30 }) })
    await r.begin()
    const again = await r.begin()
    assert.equal(again.already, true)
    assert.equal(again.flow.code, 'T72NNC')
    r.cancel()
  })

  test('an approved login ends registered, and the machine is journalled', async () => {
    const events = []
    const r = reg({ bin: stubNpx({ print: DEVICE, writes: true }), journal: (t, d) => events.push([t, d]) })
    await r.begin()
    await settled(r)
    assert.equal(r.last.phase, 'registered')
    assert.equal(r.registered(), true)
    const landed = events.find((e) => e[0] === 'aistack_registered')
    assert.deepEqual(landed[1], { machine: 'curia.sh', servers: ['aistack.to'] })
  })

  test('the journal restores the device flow and its Action identity after a restart', async () => {
    const data = path.join(root, 'data')
    fs.mkdirSync(data, { recursive: true })
    const reduction = new Reduction(data)
    const r = reg({
      bin: stubNpx({ print: DEVICE, sleep: 30 }),
      journal: (type, detail) => reduction.journal(type, detail),
    })

    await r.begin({ actionId: 'atlas-aistack-register' })
    const restarted = new Reduction(data)

    assert.deepEqual(restarted.aistackRegistration(), {
      phase: 'waiting', code: 'T72NNC', url: 'https://aistack.to/cli/auth?code=T72NNC',
      action_id: 'atlas-aistack-register',
      started_at: restarted.aistackRegistration().started_at,
      expires_at: restarted.aistackRegistration().expires_at,
    })
    assert.ok(restarted.aistackRegistration().expires_at > restarted.aistackRegistration().started_at)
    r.cancel()
  })

  test('a login that exits without a credential is a failure that names the CLI\'s last word', async () => {
    const r = reg({ bin: stubNpx({ print: `${DEVICE}\nauth failed`, code: 4 }) })
    await r.begin()
    await settled(r)
    assert.equal(r.last.phase, 'failed')
    assert.match(r.last.message, /exited 4: auth failed/)
    assert.equal(r.status().flow.phase, 'failed', 'the screen opened after the fact still says what happened')
  })

  test('nobody approving is EXPIRED, which is a different act from a failure', async () => {
    const r = reg({ bin: stubNpx({ print: DEVICE, sleep: 30 }) })
    const started = await r.begin()
    assert.equal(started.ok, true)
    // The CLI's three-minute poll, run down by hand rather than waited out.
    r.flow.timedOut = true
    r.flow.child.kill('SIGKILL')
    await settled(r)
    assert.equal(r.last.phase, 'expired')
    assert.match(r.last.message, /nobody approved the login within three minutes/)
  })

  test('a command that never prints a code is refused rather than left in flight', async () => {
    const r = reg({ bin: path.join(root, 'no-such-npx') })
    const out = await r.begin()
    assert.equal(out.ok, false)
    assert.match(out.error, /did not run/)
    assert.equal(r.flow, null, 'nothing is waiting, so the screen offers the press again')
  })

  test('an already-registered box is refused, and told where to revoke', async () => {
    writeCredential()
    const out = await reg({ bin: stubNpx({ print: DEVICE }) }).begin()
    assert.equal(out.ok, false)
    assert.match(out.error, /aistack\.to\/settings\/machines/)
  })

  test('cancelling ends the wait and says so, without pretending it failed', async () => {
    const events = []
    const r = reg({ bin: stubNpx({ print: DEVICE, sleep: 30 }), journal: (t, d) => events.push([t, d]) })
    await r.begin()
    const out = r.cancel()
    assert.equal(out.ok, true)
    assert.equal(out.flow.phase, 'cancelled')
    await new Promise((done) => setTimeout(done, 60))
    assert.ok(!events.some((e) => e[0] === 'aistack_login_failed'), 'the operator stopping it is not an alarm')
  })

  test('cancelling nothing is a refusal, not a silent yes', () => {
    assert.equal(reg().cancel().ok, false)
  })
})

describe('the standing permission, which a registration alone does not grant (#706)', () => {
  test('it refuses on a box with no credential, because it is granted with the token', async () => {
    const out = await reg().optIn()
    assert.equal(out.ok, false)
    assert.match(out.error, /register the box with aistack first/)
  })

  test('a clean run says the next tick publishes', async () => {
    writeCredential()
    const events = []
    const r = reg({ bin: stubNpx({ expect: 'optin', print: 'auto-sync on' }), journal: (t, d) => events.push([t, d]) })
    const out = await r.optIn()
    assert.equal(out.ok, true)
    assert.match(out.said, /the next tick publishes/)
    assert.deepEqual(events, [['aistack_optin', { version: DEFAULT_CLI_VERSION, ok: true }]])
  })

  test('a refusal from the stack comes back as the CLI\'s own words', async () => {
    writeCredential()
    const r = reg({ bin: stubNpx({ expect: 'optin', print: 'the stack has not permitted this machine', code: 5 }) })
    const out = await r.optIn()
    assert.equal(out.ok, false)
    assert.match(out.error, /exited 5: the stack has not permitted this machine/)
  })
})

describe('the sync verdict the section reports (#706)', () => {
  let reduction
  beforeEach(() => {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    reduction = new Reduction(path.join(root, 'data'))
  })

  test('a box that never ran one has no verdict, which is not a failure', () => {
    assert.equal(reduction.lastAistackSync(), null)
    assert.equal(reduction.registeredAistackMachine(), null)
  })

  test('a landed sync is the verdict, with the stack it published to', () => {
    reduction.journal('aistack_sync', { published: 'https://aistack.to/stacks/demo', claude_roots: 2 })
    const v = reduction.lastAistackSync()
    assert.equal(v.ok, true)
    assert.equal(v.published, 'https://aistack.to/stacks/demo')
    assert.ok(v.at > 0)
  })

  test('a failure is the verdict too, and the alarm is a separate fact', () => {
    reduction.journal('aistack_sync_failed', { message: 'npx exited 7', said: true })
    assert.equal(reduction.lastAistackSync().ok, false)
    assert.equal(reduction.lastAistackSync().message, 'npx exited 7')
    assert.equal(reduction.standingAistackAlarm().message, 'npx exited 7')
  })

  // A repaired sync clears the alarm. The verdict must then say SUCCESS rather
  // than going quiet, or the screen would read the same as a box that has never
  // published at all.
  test('a repair clears the alarm and leaves a success behind, not a silence', () => {
    reduction.journal('aistack_sync_failed', { message: 'npx exited 7', said: true })
    reduction.journal('aistack_sync', { published: 'https://aistack.to/stacks/demo' })
    assert.equal(reduction.standingAistackAlarm(), null)
    assert.equal(reduction.lastAistackSync().ok, true)
  })

  test('the registration survives the restart the operator does right after making it', () => {
    reduction.journal('aistack_registered', { machine: 'curia.sh', servers: ['aistack.to'] })
    const after = new Reduction(path.join(root, 'data'))
    assert.equal(after.registeredAistackMachine().machine, 'curia.sh')
    assert.ok(after.registeredAistackMachine().at > 0)
  })
})

// The child settles on its own clock, so the tests that assert on an end wait
// for the object to say it has one rather than for a fixed number of
// milliseconds.
async function settled(r, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (r.flow === null && r.last !== null) return
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.fail('the login never settled')
}
