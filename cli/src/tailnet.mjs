import { Refusal } from './exit.mjs'
import { tailscaleRunner } from './tailscale.mjs'

// The tailnet step of `curia install` (#891, changing the #850, #868, and
// #877 decisions): the node joins the tailnet during installation, and the
// operator names it up front with `--name`.
//
// The Curia app is reachable only through Tailscale Serve, so the login
// cannot happen in the browser. It happens here, on the terminal, before
// anything is downloaded, so that nothing lands on a host the operator
// cannot reach. Installing the Tailscale package stays a prerequisite,
// because Curia never installs software on the host; the preflight
// (`preflight.mjs`) checks the package and the daemon and nothing more.
//
// The step is idempotent by inspection, like the others:
//
//   logged in    the node's name and MagicDNS address are reported. When the
//                name differs from `--name`, that is said as a fact, the
//                existing name wins, and the actual name is what the
//                installation continues with: Curia never renames a node.
//                The operator reruns with the actual name or renames the
//                node by hand.
//   logged out   `tailscale up --hostname <name>` runs through the runner,
//                the login URL it prints is the one action, and the step
//                polls the status until the node is Running, bounded by
//                LOGIN_TIMEOUT_MS. A rerun lands at this step again.
//
// Then, in both cases, the operator permission (`tailscale serve` must be
// allowed for this user, else the refusal names the exact `sudo tailscale
// set --operator=<user>` command) and the certificate (`CertDomains` must
// name the node, else the refusal names the tailnet's HTTPS setting). The
// inspect-only form (`mode: 'inspect'`, which reinstall, update, and
// rollback run) never runs `tailscale up`: a logged-out node is a refusal
// that names `curia install`.
//
// Nothing here writes into tailscaled but the login itself. The Serve route
// stays the Tailscale card's (`daemon/src/tailscalesetup.mjs`).

// A MagicDNS label, which is what a machine name becomes: lowercase letters,
// digits, and hyphens, at most 63, not starting or ending with a hyphen.
export const MAGICDNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
export const DEFAULT_NODE_NAME = 'curia'

export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const CERTIFICATE_WAIT_MS = 30 * 1000
const POLL_MS = 2000
const LOGIN_URL_RE = /https:\/\/login\.tailscale\.com\/\S+/

const firstLine = (text) => String(text ?? '').trim().split('\n')[0]
const denied = (text) => /access denied|requires root or operator|operator permission/i.test(text)

// The name is the operator's choice, made before the app exists (#891):
// `--name` on the bootstrap or on `curia install`, `curia` by default. The
// step says which name was chosen first, so the choice is on the terminal
// beside what the tailnet then reports. The Tailscale card of Setup shows
// the name as a fact and never edits it, because the sidecar reads the
// hosts it serves at start and a rename under a running app breaks it.
//
// The step's seam. `context` is `{ name, mode, user, stdout }`: the name the
// operator asked for, `join` or `inspect`, the user the operator command
// names, and where the step speaks. `deps` are the boundaries a test
// replaces: the `tailscale` runner (`tailscaleRunner` in tailscale.mjs, with
// `onLine` for the login link) and the clock the wait uses. Returns
// `{ name, address, loggedIn }`: the node's actual label, its MagicDNS
// address, and whether this call logged it in.
export async function joinTailnet({ name = DEFAULT_NODE_NAME, mode = 'join', user, stdout }, { tailscale = tailscaleRunner, sleep = defaultSleep, now = Date.now } = {}) {
  const say = (text) => stdout?.write(`${text}\n`)
  const operatorRefusal = (detail) => new Refusal(`your user may not operate Tailscale on this host (${detail}). Run \`sudo tailscale set --operator=${user}\` and run the command again.`)

  say(`the node name is ${name}, chosen with --name`)
  let node = await readNode(tailscale)
  let loggedIn = false
  if (node.backendState !== 'Running') {
    if (mode !== 'join') {
      throw new Refusal(`this node is not logged in to a tailnet (${node.backendState}). Run 'curia install' to join the tailnet as this node, or \`sudo tailscale up\` on this host, and run the command again.`)
    }
    say(`this node is not logged in to a tailnet; joining it as ${name}`)
    node = await login({ name, node, tailscale, sleep, now, say, operatorRefusal })
    loggedIn = true
    say(`logged in as node ${node.name} (${node.dnsName})`)
  } else {
    say(`node ${node.name} (${node.dnsName}) is logged in to the tailnet`)
  }

  if (node.name !== name) {
    say(`this node is named ${node.name}, not ${name}. The existing name wins: Curia never renames a node, and the installation continues with ${node.name}. To use ${name}, run \`sudo tailscale set --hostname ${name}\` on this host and run the command again, or run the command again with --name ${node.name}.`)
  }

  const serve = await tailscale(['serve', 'status'])
  if (!serve.ok) {
    const detail = firstLine(serve.stderr) || firstLine(serve.stdout) || `exit ${serve.code}`
    if (denied(detail)) throw operatorRefusal(detail)
    throw new Error(`tailscale serve status failed: ${detail}`)
  }
  say('the operator may use Tailscale Serve, so the Curia app can be published')

  // The certificate follows the login by a moment while the node receives
  // its network map, so a node that just logged in is given a short wait.
  const started = now()
  while (node.certDomains.length === 0 && loggedIn && now() - started < CERTIFICATE_WAIT_MS) {
    await sleep(POLL_MS)
    node = await readNode(tailscale)
  }
  if (node.certDomains.length === 0) {
    throw new Refusal('the tailnet issues no HTTPS certificate for this node, so Tailscale Serve cannot publish the Curia app. Enable HTTPS certificates under DNS in the Tailscale admin console at https://login.tailscale.com/admin/dns and run the command again.')
  }
  const address = node.certDomains[0]
  say(`the tailnet issues an HTTPS certificate for ${address}`)
  return { name: node.name, address, loggedIn }
}

// `tailscale up` prints the login link and blocks until the node is
// Running, so it runs beside the poll: the link is taken off its output as
// it appears, the status is what says the login arrived, and the bound is
// the same on both.
async function login({ name, node, tailscale, sleep, now, say, operatorRefusal }) {
  let url = null
  let finished = null
  const args = node.backendState === 'NeedsLogin' ? ['up', '--hostname', name, '--timeout', '10m'] : ['up', '--timeout', '10m']
  const up = tailscale(args, {
    timeoutMs: LOGIN_TIMEOUT_MS + 30_000,
    onLine: (line) => {
      const m = String(line).match(LOGIN_URL_RE)
      if (m && !url) {
        url = m[0]
        say(`Open this link on a device where you are signed in to Tailscale and approve this machine:\n  ${url}\nwaiting for the login (up to 10 minutes)`)
      }
    },
  }).then((result) => { finished = result; return result }, (e) => { finished = { ok: false, stderr: e.message, code: null }; return finished })

  const started = now()
  for (;;) {
    node = await readNode(tailscale)
    if (node.backendState === 'Running') break
    if (finished && !finished.ok) {
      const detail = firstLine(finished.stderr) || firstLine(finished.stdout) || `exit ${finished.code}`
      if (denied(detail)) throw operatorRefusal(detail)
      throw new Error(`tailscale up failed: ${detail}`)
    }
    if (now() - started >= LOGIN_TIMEOUT_MS) {
      throw new Error('no login arrived within 10 minutes. Approve this machine from the link, then run the command again; it resumes at this step.')
    }
    await sleep(POLL_MS)
  }
  await up
  return node
}

// The node as `tailscale status --json` reports it. `name` is the first
// label of the MagicDNS name, the machine name as the tailnet knows it.
async function readNode(tailscale) {
  const status = await tailscale(['status', '--json'])
  if (!status.ok) throw new Error(`tailscale status failed: ${firstLine(status.stderr) || firstLine(status.stdout) || `exit ${status.code}`}`)
  let parsed
  try {
    parsed = JSON.parse(status.stdout)
  } catch {
    throw new Error('tailscale status --json did not answer JSON')
  }
  const dnsName = String(parsed?.Self?.DNSName ?? '').replace(/\.$/, '')
  const certDomains = Array.isArray(parsed?.CertDomains) ? parsed.CertDomains.map((d) => String(d).replace(/\.$/, '')) : []
  return {
    backendState: String(parsed?.BackendState ?? 'Unknown'),
    online: Boolean(parsed?.Self?.Online),
    dnsName: dnsName || certDomains[0] || null,
    name: (dnsName || certDomains[0] || '').split('.')[0] || null,
    certDomains,
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
