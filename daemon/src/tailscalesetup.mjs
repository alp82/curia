// The Tailscale card of integration setup (#877, filling the #874 seam under
// the #852 contract and the #853 journey; the node-name field decided at
// the #891 rehearsal).
//
// One module holds the whole Tailscale step: the panel's own read, the one
// confirmation that records the initial allowed operator and names the
// node, the Serve route Curia publishes for its own app, and the verifier
// the frame asks on every read. Tailscale is reached through its CLI over
// the host's tailscaled socket on an injectable `exec`, and the app is
// probed on loopback with an injectable `probe` over `node:http`, so the
// suite needs no tailnet.
//
// CURIA DETECTS TAILSCALE AND CHANGES TWO THINGS ABOUT IT: the node's name,
// and its own Serve route. The node's login is `curia install`'s tailnet
// step (`cli/src/tailnet.mjs`), where the operator names the node up front
// with `--name` and the login happens on the terminal; its certificates and
// the operator permission are the host's (#850). The card's **Node name**
// field is prefilled with the name the node has, and a changed name renames
// the node through `tailscale set --hostname` on the confirmation (the
// owner's decision at the #891 rehearsal: the name belongs in onboarding,
// with the current name as the default). Every other miss names the exact
// command the operator runs by hand. The Serve route is the app on the
// dashboard's Serve port, re-asserted after a rename because Serve keys its
// routes by the node's name, and the record of that route is what uninstall
// (#886) withdraws later.
//
// THE OPERATOR IS THE IDENTITY THAT OPENED THE APP. Tailscale Serve stamps
// `Tailscale-User-Login` on every request and overwrites a forged one
// (ADR-0011), so the login the sidecar read is a fact and not a claim. The
// panel shows it, and nothing is recorded until the operator presses the
// confirmation. The record is `state/tailscale.json`: the login, when it was
// confirmed, the machine name as the node reports it, and the Serve routes
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
//      private address; the node's name is the first label of it, recorded;
//   5. Curia's own Serve route stands, created when it is missing;
//   6. the app answers on loopback and admits the confirmed login, timed.
//
// Each miss is one failed verification with one corrective action and the
// stage it failed at. Nothing is remembered between reads: a retry measures
// again, and a node that went offline reads as offline.

import { LOGIN_RE, TAILSCALE_FILE, readTailscaleRecord, serveRoutes, tailscalePath, writeTailscaleRecord } from '../../cli/src/tailscale.mjs'
import { MAGICDNS_LABEL_RE } from '../../cli/src/tailnet.mjs'
import http from 'node:http'
import { execFileP } from './exec.mjs'

// How long a renamed node is given to report its new MagicDNS name.
const RENAME_WAIT_MS = 30_000
const RENAME_POLL_MS = 1000

// The record and the route parser live in `cli/src/tailscale.mjs`, because
// `curia uninstall` (#886) reads the same record to withdraw the routes.
export { TAILSCALE_FILE, readTailscaleRecord, serveRoutes, tailscalePath, writeTailscaleRecord }

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

// The node's machine name: the first label of its MagicDNS name, which is
// what the tailnet calls it.
const nodeName = (node) => (node?.dns_name ?? node?.cert_domains?.[0] ?? '').split('.')[0] || null

// The Serve route Curia publishes for the app, as `tailscale serve` names it.
export const appRoute = ({ servePort, appPort }) => ({ https: servePort, target: `http://127.0.0.1:${appPort}` })

// The loopback probe of the app, over `node:http` and never `fetch`: the
// probe must arrive as a Serve request does, with `Host: <address>:<serve
// port>` and the recorded login, because that Host is the second leg of the
// identity check. `fetch` (undici) drops a caller-set `Host` as forbidden,
// so the app saw `Host: 127.0.0.1:4273` and refused every probe (#891).
// `http.request` sends the header verbatim. Answers `{ status, text }`;
// throws on no connection or no answer within `timeoutMs`.
export function loopbackProbe({ port, path = '/', headers, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: async () => Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000}s`)))
    req.on('error', reject)
    req.end()
  })
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
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class TailscaleSetup {
  // `root` null is the source deployment: the allowlist is `curia.yaml`'s
  // and there is no record to write. `allow` is the live set the daemon's
  // surfaces check against; `configAllow` is what `curia.yaml` said.
  constructor({
    root = null, stateDir, servePort, appPort, allow = new Set(), configAllow = [],
    exec = execFileP, probe = loopbackProbe, log = console.log, now = () => new Date(), sleep = defaultSleep,
  }) {
    this.root = root
    this.stateDir = stateDir
    this.servePort = servePort
    this.appPort = appPort
    this.allow = allow
    this.configAllow = configAllow.map((l) => String(l).toLowerCase())
    this.exec = exec
    this.probe = probe
    this.log = log
    this.now = now
    this.sleep = sleep
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
      machine_name: nodeName(node) ?? record.machine_name,
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
  // shape is checked again all the same. `machine_name` is the card's field:
  // the name the node has changes nothing, another name renames the node
  // first, and nothing is recorded when the rename does not land. Omitted,
  // the node's own name is recorded.
  async confirmOperator({ login, machine_name: wanted } = {}) {
    if (typeof login !== 'string' || !LOGIN_RE.test(login)) throw refuse('The request carried no Tailscale identity. Open the Curia app through its Tailscale address, not on loopback, then confirm again.')
    if (!this.root) throw refuse('This deployment reads the allowed operators from identity.allow in curia.yaml and has no record to write. Add the login there and deploy.')
    if (wanted !== undefined && wanted !== null && (typeof wanted !== 'string' || !MAGICDNS_LABEL_RE.test(wanted))) {
      throw refuse('The node name must be a MagicDNS label: lowercase letters, digits, and hyphens, up to 63 characters, not starting or ending with a hyphen.')
    }
    const current = this.#record()
    let node = await this.#node()
    let renamed = null
    if (wanted && wanted !== nodeName(node)) {
      node = await this.#rename(node, wanted)
      renamed = { from: nodeName(node.before), to: wanted, previous_app_url: this.appUrl(node.before.cert_domains?.[0] ?? node.before.dns_name), app_url: this.appUrl(node.cert_domains?.[0] ?? node.dns_name) }
    }
    const record = writeTailscaleRecord(this.stateDir, {
      ...current,
      operator: { login: login.toLowerCase(), confirmed_at: this.now().toISOString() },
      machine_name: nodeName(node) ?? current.machine_name,
    })
    this.syncAllow()
    this.log(`tailscale setup: ${record.operator.login} is the allowed operator, recorded in ${tailscalePath(this.stateDir)}`)
    return { ...(await this.overview({ login })), renamed }
  }

  // The rename: `tailscale set --hostname <name>` (the operator permission
  // suffices), then the status until tailscaled reports the new MagicDNS
  // name, then Curia's Serve route asserted again, because Serve keys its
  // routes by the node's name and the old key names an address that no
  // longer resolves. Answers the node under its new name, with the node it
  // was under `before`.
  async #rename(before, name) {
    const from = nodeName(before)
    if (before.error) {
      throw refuse(`Tailscale isn't answering on this host (${before.error}), so the node can't be renamed. Start tailscaled (\`sudo systemctl start tailscaled\`), then confirm again.`)
    }
    if (before.backend_state !== 'Running' || !from) {
      throw refuse(`This node is not logged in to a tailnet, so it can't be renamed here. Run \`curia install --name ${name}\` on the host to join the tailnet under that name.`)
    }
    try {
      await tailscale(this.exec, ['set', '--hostname', name])
    } catch (e) {
      throw refuse(`curia could not rename the node: ${e.message}. Run \`sudo tailscale set --operator=$USER\` on the host so your user may operate Tailscale, then confirm again.`)
    }
    let node = await this.#node()
    for (let waited = 0; nodeName(node) !== name && waited < RENAME_WAIT_MS; waited += RENAME_POLL_MS) {
      await this.sleep(RENAME_POLL_MS)
      node = await this.#node()
    }
    if (nodeName(node) !== name) {
      throw refuse(`Tailscale accepted the name ${name}, but the node still reports the name ${from} after ${RENAME_WAIT_MS / 1000} s. Check \`tailscale status\` on the host, then confirm again.`)
    }
    const route = appRoute({ servePort: this.servePort, appPort: this.appPort })
    try {
      await tailscale(this.exec, ['serve', '--bg', `--https=${route.https}`, route.target])
    } catch (e) {
      this.log(`tailscale setup: the Serve route was not re-asserted after the rename (${e.message}); the verification names the action`)
    }
    this.log(`tailscale setup: renamed the node ${from} to ${name}; the app is at ${this.appUrl(node.cert_domains?.[0] ?? node.dns_name)}`)
    return { ...node, before }
  }

  // The frame's verifier (#874): `{ ok, primary, secondary, emoji, detail }`,
  // `{ ok: false, failed, action, detail }`, or `{ ok: false, unconnected }`.
  verifier() {
    return async () => {
      let record
      try {
        record = this.#record()
      } catch (e) {
        return { ok: false, failed: e.message, action: `Fix ${tailscalePath(this.stateDir)}, or confirm the operator again in this panel.`, detail: { stage: 'record' } }
      }
      if (!record.operator) return { ok: false, unconnected: true }
      try {
        return await this.#verify(record)
      } catch (e) {
        this.log(`tailscale setup: verification did not finish: ${e.message}`)
        return { ok: false, failed: e.message, action: 'Fix the cause the message names, then try again.', detail: { stage: 'unknown' } }
      }
    }
  }

  async #verify(record) {
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

    // The machine name is the node's own: a fact the record keeps, refreshed
    // here when the node was renamed by hand or through the card.
    const machineName = address.split('.')[0]
    facts.machine_name = machineName
    if (record.machine_name !== machineName) {
      record = writeTailscaleRecord(this.stateDir, { ...record, machine_name: machineName })
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
      res = await this.probe({
        port: this.appPort,
        headers: { host: `${address}:${this.servePort}`, 'tailscale-user-login': record.operator.login, accept: 'text/html' },
        timeoutMs: 10_000,
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
