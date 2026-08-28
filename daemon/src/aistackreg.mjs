// Registering the box with aistack from Settings (#706, building the spec at
// #684 and the prototype at prototypes/aistack-machine/findings.md).
//
// #695 built the recurring sync and left the registration a shell ritual: two
// commands typed over ssh, written down in the daemon README. This module is
// the same ceremony with the ssh taken out of it. Not a different ceremony —
// the SAME two commands, spawned by the daemon, with their device code and
// their approval link shown on the Settings screen instead of on a terminal
// nobody is sitting at.
//
// WHO APPROVES DOES NOT CHANGE, and that is the point #695 was making. The
// approval is a human act in a signed-in browser, and nothing here can perform
// it. What #695 ruled out was curia registering ITSELF. What this does is start
// the flow and hand the operator the two things only the box knows — the code
// and the URL — so the human half happens on the phone they already have open.
//
// THE CREDENTIAL NEVER MOVES. The CLI writes the bearer to a file under curia's
// durable HOME and that is the only copy. This module reads that file for
// exactly one thing: the SERVER HOSTS it is keyed by. It returns map keys and
// never map values, so there is no path from the token to a response body.
// Nothing here writes configuration either — #695 deliberately gave the sync no
// `enabled` key, because the credential IS the switch, and a Settings section
// that wrote one would be a second answer to a settled question.
//
// THE FLOW IS ONE AT A TIME. A login holds a child process and a code that a
// second login would invalidate, so a begin while one is in flight returns the
// flow already running rather than starting a rival.
//
// The three ends of a login, and each one has a named act after it:
//
//   registered  the credential landed. Next: grant the standing permission.
//   expired     the CLI polled for three minutes and nobody approved. The
//               session itself lives fifteen, but the CLI stopped watching, so
//               the act is to start a new login.
//   failed      the command itself did not work. The message is the CLI's own,
//               and the act is to read the log or start a new login.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  CLI_PACKAGE, CLI_RUNNER, DEFAULT_CLI_VERSION,
  credentialFile, hasCredential, homeFor,
} from './aistack.mjs'

// The CLI polls the approval every five seconds, thirty-six times: three
// minutes (research §"The login poll is short"). This waits a little past that,
// so a login that simply ran out is reported as expired by the CLI's own exit
// rather than killed here and reported as a wedge.
export const LOGIN_TIMEOUT_MS = 3.5 * 60 * 1000

// How long `begin` waits for the code and the URL before it gives up on the
// child. The CLI prints both before its first poll, so a spawn that has said
// nothing in this long is npx fetching a package or npx failing to.
export const DEVICE_WAIT_MS = 90 * 1000

// The opt-in writes two hook files and asks the stack once. It prompts for
// nothing, so it either answers or it is wedged.
export const OPTIN_TIMEOUT_MS = 2 * 60 * 1000

// The CLI's own log, which every failure line points at.
export const logFile = (root) => path.join(homeFor(root), '.config', 'aistack', 'sync.log')

// ---- what the browser is allowed to know about the credential ---------------

// The hosts the credential file is keyed by, and nothing else in it. The file is
// `{ "servers": { "https://aistack.to": { "token": …, "userId": … } } }`, so
// this returns KEYS and never VALUES — there is no branch here that can reach a
// token, whatever the CLI adds to that object later.
export function registeredServers(root) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(credentialFile(root), 'utf8'))
  } catch {
    return []
  }
  const servers = data?.servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
  const out = []
  for (const key of Object.keys(servers)) {
    try {
      out.push(new URL(key).host)
    } catch {
      // A key that is not a URL is not shown at all rather than shown raw: the
      // only thing this function promises is that what it returns is a host.
    }
  }
  return out
}

// ---- the device flow --------------------------------------------------------

// What the CLI prints before it starts polling. The prototype recorded both
// lines verbatim: `CODE T72NNC` and `OPEN https://aistack.to/cli/auth?code=…`.
// Read separately, because the CLI is free to reorder them or put words between
// them, and a single combined pattern would then match nothing.
const CODE_RE = /\bCODE\s+([A-Z0-9-]{4,32})\b/
const URL_RE = /\bhttps:\/\/\S*\/cli\/auth\S*/

// The code and the link, or null while neither has been printed yet. The link
// carries the code in its query, so the code alone is enough to show the pair —
// but curia shows the URL the CLI printed rather than one it composed, because
// the composed one would be a guess about a route it does not own.
export function parseDeviceFlow(text) {
  const s = String(text ?? '')
  const url = URL_RE.exec(s)?.[0] ?? null
  const code = CODE_RE.exec(s)?.[1] ?? null
  if (!url && !code) return null
  return { code, url }
}

// The two commands the README documents, as arrays. The version is pinned for
// the reason `aistack.mjs` pins the sync's: `@latest` changes behavior on a box
// nobody touched.
export const loginArgs = (version = DEFAULT_CLI_VERSION) => ['-y', `${CLI_PACKAGE}@${version}`, 'login']
export const optInArgs = (version = DEFAULT_CLI_VERSION) => ['-y', `${CLI_PACKAGE}@${version}`, 'sync', '--auto', 'on']

// The shell line for one of those, for the operator who would rather do it over
// ssh. It names curia's HOME because that is the whole trick of the ceremony.
export const shellLine = (home, args) => `HOME=${home} ${CLI_RUNNER} ${args.join(' ')}`

// ---- the registration -------------------------------------------------------

export class AistackRegistration {
  // `journal` writes one event, so a registration survives a restart as a fact
  // rather than as this object's memory. `log` is the daemon's line.
  constructor({
    root, journal = () => {}, log = () => {}, now = () => Date.now(),
    version = DEFAULT_CLI_VERSION, bin = CLI_RUNNER, env = process.env,
    hostname = () => os.hostname(),
    spawnFn = spawn,
  }) {
    this.root = root
    this.journal = journal
    this.log = log
    this.now = now
    this.version = version
    this.bin = bin
    this.env = env
    this.hostname = hostname
    this.spawnFn = spawnFn
    // The login in flight, or null. One at a time.
    this.flow = null
    // How the last finished attempt ended, so a screen opened after the fact
    // still says what happened.
    this.last = null
    this.optInBusy = false
  }

  home() {
    return homeFor(this.root)
  }

  registered() {
    return hasCredential(this.root)
  }

  // The whole of what the browser learns. Every field here is public: a code
  // meant to be read aloud, a link meant to be opened, a hostname, and the two
  // shell lines already printed in the README.
  status({ machine = null } = {}) {
    const home = this.home()
    const registered = this.registered()
    const servers = registered ? registeredServers(this.root) : []
    return {
      registered,
      // What aistack shows for this box. The name is the one the box PROPOSED —
      // the CLI proposes the hostname and the approval page may overwrite it —
      // so the screen says so rather than claiming to have read it back. The
      // credential file records no machine name at all (research §2).
      machine: registered
        ? { proposed: machine?.machine ?? this.hostname(), servers, at: machine?.at ?? null }
        : null,
      flow: this.flow
        ? {
          phase: 'waiting', code: this.flow.code, url: this.flow.url,
          action_id: this.flow.actionId,
          started_at: this.flow.startedAt, expires_at: this.flow.startedAt + LOGIN_TIMEOUT_MS,
        }
        : (this.last ? { ...this.last } : { phase: registered ? 'registered' : 'unregistered' }),
      log_file: logFile(this.root),
      commands: {
        login: shellLine(home, loginArgs(this.version)),
        opt_in: shellLine(home, optInArgs(this.version)),
      },
    }
  }

  // Start the device flow. Resolves once the CLI has printed the code and the
  // link, which is the moment the operator has something to act on; the child
  // keeps polling behind it and settles `this.last` when it ends.
  //
  // A login already in flight is RETURNED, not replaced: a second `login` mints
  // a second session and would invalidate the code the operator is already
  // holding.
  async begin({ actionId = null } = {}) {
    if (this.flow) return { ok: true, already: true, ...this.status() }
    if (this.registered()) {
      return { ok: false, error: 'this box is already registered with aistack — revoke the machine at aistack.to/settings/machines and delete the credential on the box before registering it again' }
    }

    const startedAt = this.now()
    let child
    try {
      child = this.spawnFn(this.bin, loginArgs(this.version), {
        cwd: this.home(),
        env: { ...this.env, HOME: this.home() },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return { ok: false, error: `${this.bin} did not run: ${e.message}` }
    }

    const flow = { child, startedAt, code: null, url: null, text: '', actionId }
    this.flow = flow

    let settleDevice = () => {}
    const device = new Promise((resolve) => { settleDevice = resolve })

    const read = (chunk) => {
      if (flow.text.length < 8000) flow.text += chunk
      const seen = parseDeviceFlow(flow.text)
      if (!seen?.code || !seen?.url) return
      flow.code = seen.code
      flow.url = seen.url
      settleDevice({ ok: true })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', read)
    child.stderr.on('data', read)

    const kill = setTimeout(() => { flow.timedOut = true; child.kill('SIGKILL') }, LOGIN_TIMEOUT_MS)
    kill.unref?.()
    const giveUp = setTimeout(() => {
      settleDevice({ ok: false, error: `the aistack CLI printed no login code within ${Math.round(DEVICE_WAIT_MS / 1000)} seconds — check that the box can reach npm and aistack.to` })
    }, DEVICE_WAIT_MS)
    giveUp.unref?.()

    child.once('error', (e) => {
      clearTimeout(kill)
      clearTimeout(giveUp)
      if (this.flow === flow) this.flow = null
      this.#settle({ phase: 'failed', message: `${this.bin} did not run: ${e.message}` }, flow.actionId)
      settleDevice({ ok: false, error: `${this.bin} did not run: ${e.message}` })
    })
    child.once('close', (code, signal) => {
      clearTimeout(kill)
      clearTimeout(giveUp)
      this.#finish({ flow, code, signal })
      settleDevice({ ok: false, error: this.last?.message ?? 'the login ended before it printed a code' })
    })

    const out = await device
    if (!out.ok) {
      // The child is gone or is going: a spawn that printed nothing has nothing
      // for the operator to do, so it does not stay in flight as a live flow.
      if (this.flow === flow) {
        this.flow = null
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
      return { ok: false, error: out.error }
    }
    this.log(`an aistack registration is waiting for approval: ${flow.url}`)
    this.journal('aistack_login_started', {
      code: flow.code, url: flow.url, version: this.version,
      ...(flow.actionId ? { action_id: flow.actionId } : {}),
      started_at: flow.startedAt, expires_at: flow.startedAt + LOGIN_TIMEOUT_MS,
    })
    return { ok: true, ...this.status() }
  }

  // Stop waiting. The session on aistack's side ages out on its own; this ends
  // the box's half so the screen is not left holding a code nobody will use.
  cancel({ restored = null } = {}) {
    const flow = this.flow
    if (!flow && restored?.phase !== 'waiting') return { ok: false, error: 'no aistack registration is waiting' }
    if (!flow) {
      this.last = { phase: 'cancelled', message: 'the registration was cancelled before it was approved', at: this.now() }
      this.journal('aistack_login_cancelled', {
        message: this.last.message,
        ...(restored.action_id ? { action_id: restored.action_id } : {}),
      })
      return { ok: true, ...this.status() }
    }
    flow.cancelled = true
    this.flow = null
    try { flow.child.kill('SIGKILL') } catch { /* already gone */ }
    this.last = { phase: 'cancelled', message: 'the registration was cancelled before it was approved', at: this.now() }
    this.journal('aistack_login_cancelled', {
      message: this.last.message,
      ...(flow.actionId ? { action_id: flow.actionId } : {}),
    })
    return { ok: true, ...this.status() }
  }

  // Step three of the README ceremony, as a press. It prompts for nothing, so
  // it runs headless; it needs the credential, so it refuses on a box that has
  // not been registered yet.
  async optIn() {
    if (!this.registered()) {
      return { ok: false, error: "register the box with aistack first — the standing permission is granted with the box's own token" }
    }
    if (this.optInBusy) return { ok: false, error: 'the standing permission is already being granted' }
    this.optInBusy = true
    try {
      const out = await this.#run(optInArgs(this.version), OPTIN_TIMEOUT_MS)
      this.journal('aistack_optin', { version: this.version, ok: out.ok, ...(out.ok ? {} : { message: out.error }) })
      if (!out.ok) return { ok: false, error: out.error }
      return { ok: true, said: 'the standing auto-sync permission is granted — the next tick publishes' }
    } finally {
      this.optInBusy = false
    }
  }

  // ---- the ends ------------------------------------------------------------

  // What a finished login means. The credential file is the judge: the CLI can
  // exit 0 having done nothing useful, and it is the token on disk that decides
  // whether this box is a machine.
  #finish({ flow, code, signal }) {
    if (this.flow === flow) this.flow = null
    if (flow.cancelled) return
    if (this.registered()) {
      const machine = this.hostname()
      this.log(`the box registered with aistack as ${machine}`)
      this.journal('aistack_registered', {
        machine, servers: registeredServers(this.root),
        ...(flow.actionId ? { action_id: flow.actionId } : {}),
      })
      this.#settle({ phase: 'registered', message: null }, flow.actionId)
      return
    }
    if (flow.timedOut) {
      this.#settle({
        phase: 'expired',
        message: 'nobody approved the login within three minutes, so the CLI stopped waiting',
      }, flow.actionId)
      return
    }
    const why = lastLine(flow.text)
    this.#settle({
      phase: 'failed',
      message: signal
        ? `the login was killed on ${signal}`
        : `the login exited ${code}${why ? `: ${why}` : ' without writing a credential'}`,
    }, flow.actionId)
  }

  #settle(entry, actionId = null) {
    this.last = { ...entry, ...(actionId ? { action_id: actionId } : {}), at: this.now() }
    if (entry.phase === 'failed' || entry.phase === 'expired') {
      this.log(`the aistack registration ended ${entry.phase}: ${entry.message}`)
      this.journal('aistack_login_failed', {
        phase: entry.phase, message: entry.message,
        ...(actionId ? { action_id: actionId } : {}),
      })
    }
  }

  // One short command, run to completion.
  #run(args, timeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = this.spawnFn(this.bin, args, {
          cwd: this.home(),
          env: { ...this.env, HOME: this.home() },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        resolve({ ok: false, error: `${this.bin} did not run: ${e.message}` })
        return
      }
      let text = ''
      let timedOut = false
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      const read = (c) => { if (text.length < 4000) text += c }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
      timer.unref?.()
      child.once('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, error: `${this.bin} did not run: ${e.message}` })
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        if (timedOut) return resolve({ ok: false, error: `the command ran past ${Math.round(timeoutMs / 60000)} minutes and was killed` })
        if (signal) return resolve({ ok: false, error: `${this.bin} was killed on ${signal}` })
        if (code !== 0) {
          const why = lastLine(text)
          return resolve({ ok: false, error: `${this.bin} exited ${code}${why ? `: ${why}` : ''}` })
        }
        resolve({ ok: true, text: text.trim() })
      })
    })
  }
}

// The last thing a failing command said, which is the line worth repeating.
function lastLine(text) {
  return String(text ?? '').trim().split('\n').slice(-1)[0]?.trim() ?? ''
}
