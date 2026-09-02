// The Tailscale card of integration setup (#877, filling the #874 seam under
// the #852 contract and the #853 journey).
//
// One module holds the whole Tailscale step: the panel's own read, the one
// confirmation that records the initial allowed operator, the Serve route
// Curia publishes for its own app, and the verifier the frame asks on every
// read. Tailscale is reached through its CLI over the host's tailscaled
// socket on an injectable `exec`, and the app is probed on loopback with an
// injectable `fetch`, so the suite needs no tailnet.
//
// CURIA DETECTS TAILSCALE AND NEVER CHANGES IT. The node's login, its name,
// its certificates, and the operator permission are the host's (#850). Every
// miss names the exact command the operator runs by hand. The one thing
// Curia writes into tailscaled is its own Serve route, the app on the
// dashboard's Serve port, and the record of that route is what uninstall
// (#886) withdraws later.
//
// THE OPERATOR IS THE IDENTITY THAT OPENED THE APP. Tailscale Serve stamps
// `Tailscale-User-Login` on every request and overwrites a forged one
// (ADR-0011), so the login the sidecar read is a fact and not a claim. The
// panel shows it, and nothing is recorded until the operator presses the
// confirmation. The record is `state/tailscale.json`: the login, when it was
// confirmed, the machine name the operator expects, and the Serve routes
// Curia created. No value in it is a secret.
//
// WHERE THE ALLOWLIST COMES FROM. Under an installation root the recorded
// operator IS the identity allowlist every published surface admits by. The
// `identity.allow` list in `curia.yaml` stays the source deployment's answer
// (#866); the packaged images carry that file, and a login written for one
// box must not admit anyone on another. `allow` is the live set the daemon's
// surfaces hold, and this module is its one writer: filled at boot from the
// record, and again on confirmation, so no restart stands between the press
// and the admission.
//
// VERIFICATION IS THE CURRENT FACT, in the order the operator meets it:
//
//   1. an operator is recorded (else the card is plain, "Ready to connect");
//   2. tailscale answers on this host;
//   3. the node is logged in, running, and online;
//   4. the tailnet issues a certificate for the node, which names the
//      private address;
//   5. the node's MagicDNS name is the machine name the operator expects;
//   6. Curia's own Serve route stands, created when it is missing;
//   7. the app answers on loopback and admits the confirmed login, timed.
//
// Each miss is one failed verification with one corrective action and the
// stage it failed at. Nothing is remembered between reads: a retry measures
// again, and a node that went offline reads as offline.

import fs from 'node:fs'
import path from 'node:path'

import { writeAtomically } from '../../cli/src/atomic.mjs'
import { execFileP } from './exec.mjs'

export const TAILSCALE_FILE = 'tailscale.json'
export const tailscalePath = (stateDir) => path.join(stateDir, TAILSCALE_FILE)

// The machine-name input's default (#853). A node named `curia.sh` reads as
// `curia-sh` in MagicDNS, which is what `magicDnsLabel` computes.
export const DEFAULT_MACHINE_NAME = 'curia.sh'

// A Tailscale login as Serve stamps it: an email-shaped identity, or a
// GitHub-style `name@github` handle. Bounded, and never whitespace.
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}@[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/
// The machine name the operator types, the same shape `state/setup.json` keeps.
const MACHINE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

// The MagicDNS label tailscaled derives from a hostname: lowercase, every
// run of characters outside `a-z0-9-` becomes one hyphen, no leading or
// trailing hyphen, at most 63 characters.
export function magicDnsLabel(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
}

// The Serve route Curia publishes for the app, as `tailscale serve` names it.
export const appRoute = ({ servePort, appPort }) => ({ https: servePort, target: `http://127.0.0.1:${appPort}` })

function checked(data, source) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${source}: not a mapping`)
  for (const key of Object.keys(data)) {
    if (!['format', 'operator', 'machine_name', 'serve'].includes(key)) throw new Error(`${source}: unknown key ${key}`)
  }
  let operator = null
  if (data.operator !== null && data.operator !== undefined) {
    const op = data.operator
    if (!op || typeof op !== 'object' || typeof op.login !== 'string' || !LOGIN_RE.test(op.login)) {
      throw new Error(`${source}: operator.login must be a Tailscale login`)
    }
    operator = { login: op.login.toLowerCase(), confirmed_at: typeof op.confirmed_at === 'string' ? op.confirmed_at : null }
  }
  const machine = data.machine_name ?? null
  if (machine !== null && (typeof machine !== 'string' || !MACHINE_NAME_RE.test(machine))) {
    throw new Error(`${source}: machine_name must be a machine name or absent`)
  }
  const serve = data.serve ?? []
  if (!Array.isArray(serve) || serve.some((r) => !r || !Number.isInteger(r.https) || typeof r.target !== 'string')) {
    throw new Error(`${source}: serve must be a list of { https, target } routes`)
  }
  return { operator, machine_name: machine, serve: serve.map((r) => ({ https: r.https, target: r.target })) }
}

// The record, or the empty answer when there is no file: no operator is
// recorded, which is what a fresh installation runs until setup writes it.
export function readTailscaleRecord(stateDir) {
  const file = tailscalePath(stateDir)
  let text
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link. Replace the link with the real file.`)
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { operator: null, machine_name: null, serve: [] }
    throw e
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${file}: not JSON`)
  }
  return checked(data, file)
}

export function writeTailscaleRecord(stateDir, data) {
  const record = checked(data, tailscalePath(stateDir))
  writeAtomically(tailscalePath(stateDir), `${JSON.stringify({ format: 1, ...record }, null, 2)}\n`, { mode: 0o600 })
  return record
}

// One `tailscale` call. `exec` answers `{ stdout, stderr }` or throws with
// the child's stderr on it, which is the sentence the failure carries.
async function tailscale(exec, args) {
  try {
    return await exec('tailscale', args, { maxBuffer: 8 * 1024 * 1024 })
  } catch (e) {
    const detail = String(e?.stderr ?? '').trim().split('\n')[0] || e.message
    throw Object.assign(new Error(detail), { missing: e?.code === 'ENOENT' })
  }
}

const parseJson = (text) => { try { return JSON.parse(text) } catch { return null } }

// The routes in a `tailscale serve status --json` answer, which is the
// node's whole serve config: `{ Web: { "<host>:<port>": { Handlers: { "/":
// { Proxy } } } } }`.
export function serveRoutes(config) {
  const out = []
  for (const [hostPort, site] of Object.entries(config?.Web ?? {})) {
    const port = Number(hostPort.split(':').pop())
    for (const [mount, handler] of Object.entries(site?.Handlers ?? {})) {
      if (handler?.Proxy) out.push({ https: port, mount, target: String(handler.Proxy) })
    }
  }
  return out
}

export class TailscaleSetup {
  // `root` null is the source deployment: the allowlist is `curia.yaml`'s
  // and there is no record to write. `allow` is the live set the daemon's
  // surfaces check against; `configAllow` is what `curia.yaml` said.
  constructor({
    root = null, stateDir, servePort, appPort, allow = new Set(), configAllow = [],
    exec = execFileP, fetchImpl = globalThis.fetch, log = console.log, now = () => new Date(),
  }) {
    this.root = root
    this.stateDir = stateDir
    this.servePort = servePort
    this.appPort = appPort
    this.allow = allow
    this.configAllow = configAllow.map((l) => String(l).toLowerCase())
    this.exec = exec
    this.fetchImpl = fetchImpl
    this.log = log
    this.now = now
    // The last request that reached setup through Serve: who, and when. In
    // memory only; the next arrival through the panel writes it again.
    this.lastSeen = null
    this.syncAllow()
  }

  #record() {
    return this.root ? readTailscaleRecord(this.stateDir) : { operator: null, machine_name: null, serve: [] }
  }

  // The logins every published surface admits, from the one place each
  // deployment keeps them, written into the live set in place.
  syncAllow() {
    let logins = this.configAllow
    if (this.root) {
      try {
        const op = this.#record().operator
        logins = op ? [op.login] : []
      } catch (e) {
        this.log(`tailscale setup: ${tailscalePath(this.stateDir)} could not be read (${e.message}) — no operator is admitted until it is fixed or confirmed again`)
        logins = []
      }
    }
    this.allow.clear()
    for (const l of logins) this.allow.add(l)
    return [...this.allow]
  }

  // What the sidecar asks at boot and on every poll: the allowlist, and
  // whether the first-operator window is open, which it is only under a root
  // with no operator recorded yet.
  identity() {
    const allow = this.syncAllow()
    return { allow, first_operator: Boolean(this.root) && allow.length === 0 }
  }

  async #node() {
    let status
    try {
      status = parseJson((await tailscale(this.exec, ['status', '--json'])).stdout)
    } catch (e) {
      return { installed: !e.missing, error: e.message }
    }
    if (!status) return { installed: true, error: 'tailscale status answered no JSON' }
    const self = status.Self ?? {}
    const dns = String(self.DNSName ?? '').replace(/\.$/, '')
    return {
      installed: true,
      error: null,
      backend_state: String(status.BackendState ?? 'Unknown'),
      online: Boolean(self.Online),
      dns_name: dns || null,
      cert_domains: Array.isArray(status.CertDomains) ? status.CertDomains.map((d) => String(d).replace(/\.$/, '')) : [],
      ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : [],
      version: String(status.Version ?? '').split('-')[0] || null,
    }
  }

  async #serve() {
    try {
      const { stdout } = await tailscale(this.exec, ['serve', 'status', '--json'])
      return { routes: serveRoutes(parseJson(stdout)), error: null }
    } catch (e) {
      return { routes: [], error: e.message }
    }
  }

  appUrl(dns) {
    return `https://${dns}:${this.servePort}/`
  }

  // The panel's own read: who opened the app, what is recorded, and what the
  // node says right now. `login` is the identity Serve stamped on the request
  // that asked, which the sidecar passes and the browser never chooses.
  async overview({ login = null } = {}) {
    const requester = typeof login === 'string' && LOGIN_RE.test(login) ? login.toLowerCase() : null
    if (requester) this.lastSeen = { login: requester, at: this.now().toISOString() }
    let record
    let error = null
    try {
      record = this.#record()
    } catch (e) {
      record = { operator: null, machine_name: null, serve: [] }
      error = e.message
    }
    const node = await this.#node()
    const serve = await this.#serve()
    const address = node.cert_domains?.[0] ?? node.dns_name ?? null
    return {
      root: Boolean(this.root),
      requester,
      operator: record.operator,
      machine_name: record.machine_name ?? DEFAULT_MACHINE_NAME,
      default_machine_name: DEFAULT_MACHINE_NAME,
      first_operator: Boolean(this.root) && !record.operator,
      node,
      serve: { ...serve, route: appRoute({ servePort: this.servePort, appPort: this.appPort }), recorded: record.serve },
      app_url: address ? this.appUrl(address) : null,
      last_seen: this.lastSeen,
      error,
    }
  }

  // The one confirmation (#852): the identity that opened the app becomes
  // the initial allowed operator. The sidecar sends the login off the request
  // it verified, so a body that names someone else never reaches here; the
  // shape is checked again all the same.
  async confirmOperator({ login, machine_name: machineName = DEFAULT_MACHINE_NAME } = {}) {
    if (typeof login !== 'string' || !LOGIN_RE.test(login)) throw refuse('The request carried no Tailscale identity. Open the Curia app through its Tailscale address, not on loopback, then confirm again.')
    if (typeof machineName !== 'string' || !MACHINE_NAME_RE.test(machineName)) throw refuse('That is not a machine name. Use letters, digits, hyphens, and dots, such as curia.sh.')
    if (!this.root) throw refuse('This deployment reads the allowed operators from identity.allow in curia.yaml and has no record to write. Add the login there and deploy.')
    const current = this.#record()
    const record = writeTailscaleRecord(this.stateDir, {
      ...current,
      operator: { login: login.toLowerCase(), confirmed_at: this.now().toISOString() },
      machine_name: machineName,
    })
    this.syncAllow()
    this.log(`tailscale setup: ${record.operator.login} is the allowed operator, recorded in ${tailscalePath(this.stateDir)}`)
    return this.overview({ login })
  }

  // The frame's verifier (#874): `{ ok, primary, secondary, emoji, detail }`,
  // `{ ok: false, failed, action, detail }`, or `{ ok: false, unconnected }`.
  verifier() {
    return async ({ progress = {} } = {}) => {
      let record
      try {
        record = this.#record()
      } catch (e) {
        return { ok: false, failed: e.message, action: `Fix ${tailscalePath(this.stateDir)}, or confirm the operator again in this panel.`, detail: { stage: 'record' } }
      }
      if (!record.operator) return { ok: false, unconnected: true }
      try {
        return await this.#verify(record, progress)
      } catch (e) {
        this.log(`tailscale setup: verification did not finish: ${e.message}`)
        return { ok: false, failed: e.message, action: 'Fix the cause the message names, then try again.', detail: { stage: 'unknown' } }
      }
    }
  }

  async #verify(record, progress) {
    const facts = { operator: { ...record.operator, last_seen_at: this.lastSeen?.login === record.operator.login ? this.lastSeen.at : null } }
    const fail = (stage, failed, action) => ({ ok: false, failed, action, detail: { stage, ...facts } })

    const node = await this.#node()
    facts.node = node
    if (node.error) {
      return node.installed
        ? fail('node', `Tailscale isn't answering on this host: ${node.error}`, 'Start tailscaled on this host (`sudo systemctl start tailscaled`), then try again.')
        : fail('node', 'Tailscale isn\'t installed on this host, or the tailscale command isn\'t on the path', 'Install Tailscale from https://tailscale.com/download/linux and log the node in, then try again.')
    }
    if (node.backend_state !== 'Running' || !node.online) {
      const state = node.backend_state === 'Running' ? 'offline' : node.backend_state === 'NeedsLogin' ? 'logged out' : node.backend_state.toLowerCase()
      return fail('node', `This node is ${state}`, 'Run `sudo tailscale up` on this host, finish the login in the browser, then try again.')
    }
    const address = node.cert_domains[0] ?? null
    if (!address) {
      return fail('certificate', 'The tailnet issues no HTTPS certificate for this node, so Serve can\'t publish the Curia app', 'Enable HTTPS certificates under DNS in the Tailscale admin console at https://login.tailscale.com/admin/dns, then try again.')
    }
    facts.address = address
    facts.app_url = this.appUrl(address)

    // The machine name: what the operator expects, against what the node is
    // named. Curia never renames the node; the action is the command.
    const wanted = progress.machine_name || record.machine_name || DEFAULT_MACHINE_NAME
    const expected = magicDnsLabel(wanted)
    const actual = address.split('.')[0]
    facts.machine_name = { wanted, expected, actual }
    if (expected !== actual) {
      return fail('name', `This node is named ${actual}, not ${expected}`, `Run \`sudo tailscale set --hostname ${wanted}\` on this host, or enter ${actual} as the machine name in this panel, then try again.`)
    }

    // Curia's own Serve route: the app on the Serve port. Found when it
    // stands, created when it is missing, and recorded either way.
    const route = appRoute({ servePort: this.servePort, appPort: this.appPort })
    let serve = await this.#serve()
    const standing = (routes) => routes.some((r) => r.https === route.https && r.mount === '/' && r.target === route.target)
    let created = false
    if (serve.error || !standing(serve.routes)) {
      try {
        await tailscale(this.exec, ['serve', '--bg', `--https=${route.https}`, route.target])
        created = true
      } catch (e) {
        facts.serve = { url: facts.app_url, route, created: false, error: e.message }
        return fail('serve', `curia could not publish the app with Tailscale Serve: ${e.message}`, 'Run `sudo tailscale set --operator=$USER` on this host so Serve is permitted for your user, then try again.')
      }
      serve = await this.#serve()
      if (!standing(serve.routes)) {
        facts.serve = { url: facts.app_url, route, created, error: serve.error }
        return fail('serve', `Tailscale accepted the Serve route for :${route.https} and does not list it${serve.error ? ` (${serve.error})` : ''}`, 'Run `tailscale serve status` on this host to see what is published, then try again.')
      }
    }
    facts.serve = { url: facts.app_url, route, created, error: null }
    if (!record.serve.some((r) => r.https === route.https && r.target === route.target)) {
      writeTailscaleRecord(this.stateDir, { ...record, serve: [...record.serve, route] })
    }

    // The app, on loopback, as the confirmed operator: the same identity
    // check Serve's requests meet, so a 200 is the admission and a 403 is
    // the refusal, timed.
    const started = Date.now()
    let res
    try {
      res = await this.fetchImpl(`http://127.0.0.1:${this.appPort}/`, {
        headers: { host: `${address}:${this.servePort}`, 'tailscale-user-login': record.operator.login, accept: 'text/html' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
    } catch (e) {
      facts.app = { status: null, ms: Date.now() - started, error: e.message }
      return fail('app', `The Curia app isn't answering on 127.0.0.1:${this.appPort} (${e.message})`, 'Check that the dashboard service is running (`docker compose ps`), then try again.')
    }
    const ms = Date.now() - started
    facts.app = { status: res.status, ms, error: null }
    if (res.status === 403) {
      const why = String(await res.text().catch(() => '')).trim().split('\n')[0]
      return fail('app', `The Curia app refuses ${record.operator.login}${why ? `: ${why}` : ''}`, 'Restart Curia so the app reads the confirmed operator, then try again.')
    }
    if (res.status < 200 || res.status >= 400) {
      return fail('app', `The Curia app answered ${res.status} on its own address`, 'Read the dashboard service log (`docker compose logs dashboard`), then try again.')
    }
    facts.verified_at = this.now().toISOString()

    return {
      ok: true,
      emoji: '🔒',
      primary: address,
      secondary: `${record.operator.login} · admitted in ${ms} ms`,
      detail: facts,
    }
  }
}
