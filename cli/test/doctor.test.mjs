import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runDoctor, redactDiagnostic, DOCTOR_SECTIONS, SERVICE_PORT, APP_PORT } from '../src/doctor.mjs'
import { runInstall } from '../src/install.mjs'
import { runCli } from '../src/cli.mjs'
import { packageVersion } from '../src/commands.mjs'
import { EXIT } from '../src/exit.mjs'
import { operatorConfigPath } from '../src/config.mjs'
import { versionPaths } from '../src/root.mjs'
import { fakeDocker, fakeTailscale, healthy, hostProbes, release as releaseIn, releaseProbesFor, stageOf as stageIn } from './fixtures/install.mjs'

const VERSION = packageVersion

// ---------------------------------------------------------------------------
// Fixtures: one installed root, made the way `curia install` makes one, and
// a fake service that answers the routes the doctor reads.

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'curia-doctor-')) })
after(() => rmSync(scratch, { recursive: true, force: true }))

function capture() {
  const out = []
  const err = []
  return {
    stdout: { write: (s) => { out.push(s); return true } },
    stderr: { write: (s) => { err.push(s); return true } },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

async function installed() {
  const home = mkdtempSync(join(scratch, 'home-'))
  const root = join(home, '.local', 'share', 'curia')
  const r = releaseIn(scratch, { version: VERSION })
  const io = capture()
  const env = { HOME: home, CURIA_ROOT: root, CURIA_STAGE: stageIn(scratch, r) }
  const exit = await runInstall(
    { env, args: [], stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root, mode: 'install' },
    { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker: fakeDocker(), tailscale: fakeTailscale(), sleep: async () => {}, now: () => 0 },
  )
  assert.equal(exit, EXIT.ok, io.out())
  return { home, root, r, env: { HOME: home, CURIA_ROOT: root } }
}

const OPERATOR = 'alp@example.com'
const ADDRESS = 'host.tail1234.ts.net'

function card(key, title, state, extra = {}) {
  return { key, title, state, badge: null, footer: null, error: null, pending: [], ...extra }
}

// The `GET /setup` answer of a service whose four cards are connected.
function setupReady(overrides = {}) {
  return {
    format: 1,
    step: 'model',
    progress: {},
    cards: [
      card('github', 'GitHub', 'connected', { footer: { primary: '🎫 #12 · Add the thing', secondary: 'ready-for-agent · example/app · 3 open tickets', emoji: '🎫' } }),
      card('discord', 'Discord', 'connected', { footer: { primary: '💬 #curia · Example', secondary: 'Confirmation delivered · 5 commands registered', emoji: '💬' } }),
      card('tailscale', 'Tailscale', 'connected', { footer: { primary: `🔒 ${ADDRESS}`, secondary: `${OPERATOR} · admitted in 12 ms`, emoji: '🔒' }, detail: { address: ADDRESS, app_url: `https://${ADDRESS}:8445/` } }),
      card('model', 'Model provider', 'connected', {
        badge: 'Provider verified',
        footer: { primary: 'OpenAI', secondary: 'Routing ready · verification request completed in 2 s', emoji: '⚡' },
        providers: { openai: { title: 'OpenAI', state: 'connected' }, anthropic: { title: 'Anthropic', state: 'unconnected' } },
      }),
    ],
    full_loop: { ready: true, missing: [], reason: null, facts: {} },
    ...overrides,
  }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

// A fake `fetch` for the service on loopback and the app on loopback.
function fakeService({ setup = setupReady(), identity = { allow: [OPERATOR], first_operator: false }, app = 403, down = false } = {}) {
  const calls = []
  return Object.assign(async (url) => {
    calls.push(String(url))
    const u = new URL(String(url))
    if (u.port === String(APP_PORT)) return response(app, '')
    if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:4271')
    if (u.pathname === '/ping') return response(200, { curia: 'curia', port: SERVICE_PORT })
    if (u.pathname === '/setup') return response(200, setup)
    if (u.pathname === '/identity') return response(200, identity)
    return response(404, { error: 'no such route' })
  }, { calls })
}

async function doctor(installation, { env = {}, docker = fakeDocker(), fetch = fakeService(), host = {}, release = {}, uid = process.getuid() } = {}) {
  const io = capture()
  const exit = await runDoctor(
    { env: { ...installation.env, ...env }, args: [], stdout: io.stdout, stderr: io.stderr, uid, gid: process.getgid(), root: installation.root },
    { hostProbes: hostProbes(host), releaseProbes: { ...releaseProbesFor(installation.r), ...release }, docker, fetch },
  )
  return { exit, out: io.out(), err: io.err(), docker, fetch }
}

const lines = (text) => text.split('\n')
const line = (text, name) => lines(text).find((l) => new RegExp(`^(ok|warning|failed|refused) +${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} {2}`).test(l))
const status = (text, name) => line(text, name)?.split(/\s+/)[0]

function tree(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(entry.parentPath ?? dir, entry.name)
    out.push(`${path} ${entry.isDirectory() ? 'd' : statSync(path).mtimeMs}`)
    if (entry.isDirectory()) out.push(...tree(path))
  }
  return out.sort()
}

// ---------------------------------------------------------------------------

describe('curia doctor on a healthy installation', () => {
  test('every check passes, the app address is printed, and the exit is ok', async () => {
    const i = await installed()
    const d = await doctor(i)
    assert.equal(d.exit, EXIT.ok, d.out)
    for (const section of DOCTOR_SECTIONS) assert.ok(d.out.includes(`\n${section}\n`) || d.out.startsWith(`${section}\n`), `${section} in ${d.out}`)
    assert.equal(status(d.out, 'installation'), 'ok')
    assert.equal(status(d.out, 'operator configuration'), 'ok')
    assert.equal(status(d.out, 'installed files'), 'ok')
    assert.equal(status(d.out, 'image provenance'), 'ok')
    assert.equal(status(d.out, 'secret files'), 'ok')
    assert.equal(status(d.out, 'containers'), 'ok')
    assert.equal(status(d.out, 'service'), 'ok')
    assert.equal(status(d.out, 'GitHub'), 'ok')
    assert.equal(status(d.out, 'Discord'), 'ok')
    assert.equal(status(d.out, 'Tailscale'), 'ok')
    assert.equal(status(d.out, 'model provider'), 'ok')
    assert.equal(status(d.out, 'Full loop'), 'ok')
    assert.equal(status(d.out, 'admitted operator'), 'ok')
    assert.equal(status(d.out, 'Curia app'), 'ok')
    assert.ok(d.out.includes(`https://${ADDRESS}:8445/`), d.out)
    assert.ok(/\d+ checks passed\.\n$/.test(d.out), d.out)
    assert.ok(!/warning|failed|refused/.test(d.out.split('\n').at(-2)), d.out)
  })

  test('the doctor reads and never writes: the root is unchanged, Docker sees only ps, and a second run says the same', async () => {
    const i = await installed()
    const before = tree(i.root)
    const first = await doctor(i)
    assert.deepEqual(tree(i.root), before)
    assert.deepEqual([...new Set(first.docker.verbs())], ['ps'])
    const second = await doctor(i)
    assert.equal(second.out, first.out)
  })

  test('the command table routes doctor through the root boundary', async () => {
    const i = await installed()
    const io = capture()
    const exit = await runCli({ argv: ['doctor'], env: i.env, uid: 0, stdout: io.stdout, stderr: io.stderr })
    assert.equal(exit, EXIT.refused)
    assert.match(io.err(), /runs as root/)
  })
})

describe('curia doctor on a degraded installation', () => {
  test('a warning names the condition and leaves the exit ok', async () => {
    const i = await installed()
    const d = await doctor(i, {
      host: { cpus: () => 2 },
      docker: fakeDocker({ ps: { ok: true, stdout: healthy(undefined, { overseer: { Health: 'starting' } }) } }),
    })
    assert.equal(d.exit, EXIT.ok, d.out)
    assert.equal(status(d.out, 'host capacity'), 'warning')
    assert.equal(status(d.out, 'containers'), 'warning')
    assert.match(line(d.out, 'containers'), /overseer is starting/)
    assert.match(d.out, /2 warnings\.\n$/)
  })

  test('an unhealthy container fails with the log command as the action', async () => {
    const i = await installed()
    const d = await doctor(i, { docker: fakeDocker({ ps: { ok: true, stdout: healthy(undefined, { daemon: { Health: 'unhealthy' } }) } }) })
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'containers'), 'failed')
    assert.match(line(d.out, 'containers'), /daemon is unhealthy/)
    assert.match(d.out, /docker compose --env-file .*compose\.env -f .*compose\.yaml logs daemon/)
    assert.match(d.out, /failed: 1 condition\.\n$/)
  })

  test('an exited container and a missing service each fail by name', async () => {
    const i = await installed()
    const states = healthy(['daemon', 'tmux', 'ttyd', 'dashboard'], { ttyd: { State: 'exited', Health: '', ExitCode: 2 } })
    const d = await doctor(i, { docker: fakeDocker({ ps: { ok: true, stdout: states } }) })
    assert.equal(d.exit, EXIT.failed)
    assert.match(line(d.out, 'containers'), /ttyd exited with code 2/)
    assert.match(line(d.out, 'containers'), /overseer is not in the project/)
  })

  test('a Docker that cannot be asked fails the container check without stopping the rest', async () => {
    const i = await installed()
    const d = await doctor(i, { docker: fakeDocker({ ps: { ok: false, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket', code: 1 } }) })
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'containers'), 'failed')
    assert.match(line(d.out, 'containers'), /permission denied/)
    assert.equal(status(d.out, 'service'), 'ok')
  })

  test('a service that does not answer fails the service check and leaves the integrations unchecked', async () => {
    const i = await installed()
    const d = await doctor(i, { fetch: fakeService({ down: true }) })
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'service'), 'failed')
    assert.match(line(d.out, 'service'), /ECONNREFUSED/)
    assert.match(d.out, /integrations not checked: the service did not answer/)
    assert.equal(line(d.out, 'GitHub'), undefined)
    assert.equal(status(d.out, 'Curia app'), 'ok')
  })

  test('an app that does not answer on loopback fails with the log command', async () => {
    const i = await installed()
    const d = await doctor(i, { fetch: fakeService({ app: 502 }) })
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'Curia app'), 'failed')
    assert.match(d.out, /logs dashboard/)
  })
})

describe('curia doctor on an invalid configuration', () => {
  test('the contract message is printed verbatim with one action', async () => {
    const i = await installed()
    const path = operatorConfigPath(i.root)
    writeFileSync(path, 'max_concurrent: many\n')
    const d = await doctor(i)
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'operator configuration'), 'failed')
    assert.match(line(d.out, 'operator configuration'), new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} line 1: \`max_concurrent\` must be a positive whole number`))
    assert.match(d.out, /Fix that line or revert the file/)
  })

  test('an absent configuration file is a warning: the shipped defaults apply', async () => {
    const i = await installed()
    rmSync(operatorConfigPath(i.root))
    const d = await doctor(i)
    assert.equal(d.exit, EXIT.ok, d.out)
    assert.equal(status(d.out, 'operator configuration'), 'warning')
  })
})

describe('curia doctor on a lost integration', () => {
  test('the failed card names the failed verification and its action, and the Full loop is not ready', async () => {
    const i = await installed()
    const setup = setupReady({ full_loop: { ready: false, missing: ['github'], reason: 'Waiting for GitHub.', facts: null } })
    setup.cards[0] = card('github', 'GitHub', 'failed', { badge: 'Action required', error: { failed: 'The App is installed on no watched owner.', action: 'Install the App on example, then select Try again.' } })
    const d = await doctor(i, { fetch: fakeService({ setup }) })
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'GitHub'), 'failed')
    assert.match(line(d.out, 'GitHub'), /The App is installed on no watched owner\./)
    assert.match(d.out, /Install the App on example, then select Try again\./)
    assert.equal(status(d.out, 'Full loop'), 'warning')
    assert.match(line(d.out, 'Full loop'), /Waiting for GitHub\./)
  })

  test('an unconnected card is a warning that points at the Setup screen', async () => {
    const i = await installed()
    const setup = setupReady({ full_loop: { ready: false, missing: ['discord'], reason: 'Waiting for Discord.', facts: null } })
    setup.cards[1] = card('discord', 'Discord', 'unconnected', { badge: 'Ready to connect' })
    const d = await doctor(i, { fetch: fakeService({ setup, identity: { allow: [], first_operator: true } }) })
    assert.equal(d.exit, EXIT.ok, d.out)
    assert.equal(status(d.out, 'Discord'), 'warning')
    assert.match(line(d.out, 'Discord'), /not connected/)
    assert.match(d.out, /Setup/)
    assert.equal(status(d.out, 'admitted operator'), 'warning')
    assert.match(line(d.out, 'admitted operator'), /no operator confirmed/)
  })
})

// The node's name is the Tailscale card's field since the #891 rehearsal, and
// `state/tailscale.json` records it. The doctor reads the record and holds
// it against the node the host reports.
describe('curia doctor and the recorded node name', () => {
  const record = (i, machine_name) => writeFileSync(join(i.root, 'state', 'tailscale.json'), JSON.stringify({ format: 1, operator: { login: OPERATOR, confirmed_at: '2026-09-02T10:00:00.000Z' }, machine_name, serve: [] }))

  test('a recorded name the node carries passes and names the record', async () => {
    const i = await installed()
    record(i, 'host')
    const d = await doctor(i, { fetch: fakeService() })
    assert.equal(d.exit, EXIT.ok, d.out)
    assert.equal(status(d.out, 'Tailscale node'), 'ok')
    assert.match(line(d.out, 'Tailscale node'), /host, as state\/tailscale\.json records/)
  })

  test('a recorded name the node does not carry is a warning that names both and the card', async () => {
    const i = await installed()
    record(i, 'curia')
    const d = await doctor(i, { fetch: fakeService() })
    assert.equal(d.exit, EXIT.ok, d.out)
    assert.equal(status(d.out, 'Tailscale node'), 'warning')
    assert.match(line(d.out, 'Tailscale node'), /records the name curia, but the node is host/)
    assert.match(d.out, /Node name/)
  })

  test('with no name recorded there is no node-name check: the admitted-operator check already says setup is pending', async () => {
    const i = await installed()
    const d = await doctor(i, { fetch: fakeService() })
    assert.equal(status(d.out, 'Tailscale node'), undefined)
  })
})

describe('curia doctor on a missing installation', () => {
  test('an absent root fails the installation check with the bootstrap as the action and checks nothing that needs a root', async () => {
    const home = mkdtempSync(join(scratch, 'home-'))
    const root = join(home, '.local', 'share', 'curia')
    const d = await doctor({ root, env: { HOME: home, CURIA_ROOT: root }, r: releaseIn(scratch, { version: VERSION }) })
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'operating system'), 'ok')
    assert.equal(status(d.out, 'installation'), 'failed')
    assert.match(line(d.out, 'installation'), /holds no installation/)
    assert.match(d.out, /curia-install\.sh/)
    assert.equal(line(d.out, 'containers'), undefined)
    assert.equal(line(d.out, 'service'), undefined)
  })

  test('a refused host condition is reported and fails the run without a refusal', async () => {
    const i = await installed()
    const d = await doctor(i, { host: { arch: () => 'arm64' } })
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'architecture'), 'refused')
    assert.equal(status(d.out, 'installation'), 'ok')
  })
})

describe('curia doctor and release provenance', () => {
  test('a missing attestation fails image provenance with the gh command as the action and does not touch the staged verification', async () => {
    const i = await installed()
    const d = await doctor(i, { release: { attestation: async () => ({ ok: false, error: 'gh: To get started with GitHub CLI, please run: gh auth login' }) } })
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'image provenance'), 'failed')
    assert.match(d.out, /gh attestation verify oci:\/\/ghcr\.io\/alp82\/curia-daemon@sha256:/)
    assert.equal(status(d.out, 'package integrity'), 'ok')
  })

  test('a drifted installed file fails with reinstall as the action', async () => {
    const i = await installed()
    const compose = versionPaths(i.root, VERSION).bundle
    chmodSync(compose, 0o600)
    writeFileSync(compose, `${i.r.compose}# edited\n`)
    const d = await doctor(i)
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'installed files'), 'failed')
    assert.match(d.out, /curia reinstall/)
  })
})

describe('curia doctor and secrets', () => {
  // Joined at run time so the file holds no token-shaped literal for a
  // secret scanner to match; the doctor sees the assembled shape.
  const DISCORD = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345678'].join('.')
  const ANTHROPIC = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyz'
  const GITHUB = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  const AGENT = 'f'.repeat(64)
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbHAifQ.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc'

  test('a secret-bearing error from the service, from Docker, and from the environment is printed with every value redacted', async () => {
    const i = await installed()
    const setup = setupReady({ full_loop: { ready: false, missing: ['discord'], reason: `token ${DISCORD} was refused`, facts: null } })
    setup.cards[1] = card('discord', 'Discord', 'failed', { error: { failed: `Discord refused the token ${DISCORD} (Authorization: Bot ${DISCORD}).`, action: `Sign in again with ${ANTHROPIC} or ${JWT}.` }, detail: { token: DISCORD, session: { capability: AGENT } } })
    const d = await doctor(i, {
      env: { GH_TOKEN: GITHUB, DISCORD_BOT_TOKEN: DISCORD },
      docker: fakeDocker({ ps: { ok: false, stdout: '', stderr: `error: bad token ${GITHUB} and agent ${AGENT}`, code: 1 } }),
      fetch: fakeService({ setup, identity: { allow: [OPERATOR], first_operator: false, token: AGENT } }),
    })
    assert.equal(d.exit, EXIT.failed)
    for (const value of [DISCORD, ANTHROPIC, GITHUB, AGENT, JWT]) assert.ok(!d.out.includes(value) && !d.err.includes(value), `${value} in ${d.out}`)
    assert.match(line(d.out, 'Discord'), /Discord refused the token \[redacted\]/)
    assert.equal(status(d.out, 'environment'), 'warning')
    assert.match(line(d.out, 'environment'), /DISCORD_BOT_TOKEN, GH_TOKEN/)
    assert.match(d.out, /secrets\/discord-bot-token/)
  })

  test('secret files are reported by presence, and a refused file names the chmod', async () => {
    const i = await installed()
    writeFileSync(join(i.root, 'secrets', 'discord-bot-token'), `${DISCORD}\n`, { mode: 0o644 })
    writeFileSync(join(i.root, 'secrets', 'anthropic.json'), '{"token":"x"}', { mode: 0o600 })
    const d = await doctor(i)
    assert.equal(d.exit, EXIT.failed)
    assert.equal(status(d.out, 'secret files'), 'failed')
    assert.match(line(d.out, 'secret files'), /discord-bot-token has mode 0644/)
    assert.match(d.out, /chmod 0600/)
    assert.match(d.out, /present: anthropic\.json/)
    assert.ok(!d.out.includes(DISCORD))
  })

  test('redactDiagnostic covers the long-lived, renewable, one-turn, and session shapes and keeps the installation ID', () => {
    const id = 'a'.repeat(32)
    const text = `id ${id} discord ${DISCORD} anthropic ${ANTHROPIC} openai sk-proj-${'x'.repeat(40)} github ${GITHUB} pat github_pat_${'y'.repeat(30)} agent ${AGENT} jwt ${JWT} bearer Bearer abc.def-ghi token=abcdef pem -----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY----- code XKCD-12345 end`
    const out = redactDiagnostic(text)
    for (const value of [DISCORD, ANTHROPIC, GITHUB, AGENT, JWT, 'abc.def-ghi', 'MIIE', 'x'.repeat(40), 'y'.repeat(30)]) assert.ok(!out.includes(value), `${value} in ${out}`)
    assert.ok(out.includes(id), out)
    assert.ok(out.startsWith('id '), out)
    assert.ok(out.endsWith(' end'), out)
    assert.match(out, /token=\[redacted\]/)
  })
})
