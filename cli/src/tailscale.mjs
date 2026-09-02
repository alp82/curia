import { spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeAtomically } from './atomic.mjs'

// The Tailscale record of an installation and Curia's own Serve routes
// (#877 wrote the record; #886 withdraws the routes).
//
// `state/tailscale.json` holds the allowed operator, the machine name the
// operator expects, and the Serve routes Curia created. Nothing in it is a
// secret. The service (`daemon/src/tailscalesetup.mjs`) writes it during
// integration setup and reads it at boot; the lifecycle interface reads it
// at uninstall and purge to withdraw exactly the routes Curia created and no
// other. One reader and one writer live here, dependency-free, and the
// service imports them by relative path the way it imports `config.mjs`.
//
// CURIA DETECTS TAILSCALE AND NEVER CHANGES IT, except for its own routes.
// `withdrawServeRoutes` reads what the node serves, turns off only a recorded
// route that is standing, and leaves every other route alone. A route that
// is no longer standing is nothing to do, so a rerun is quiet, and so is a
// route that went away between the read and the off: Tailscale's "handler
// does not exist" is the answer of a rule that is already off, which the
// #891 rehearsal saw fail a purge.
//
// A rule stands under a MagicDNS name, and `serve --https=<port> off`
// addresses the node's current name only. A node renamed by hand keeps
// Curia's rule under the old name, where the port off cannot reach it and
// only `serve reset`, which clears the whole Serve config, can. The reset
// runs when every rule the node serves is Curia's, because then it is
// Curia's own routes and no other. Otherwise the stale rule is left and
// named, with the reset the operator can decide on.

export const TAILSCALE_FILE = 'tailscale.json'
export const tailscalePath = (stateDir) => join(stateDir, TAILSCALE_FILE)

// A Tailscale login as Serve stamps it: an email-shaped identity, or a
// GitHub-style `name@github` handle. Bounded, and never whitespace.
export const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}@[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/
// The machine name the operator types, the same shape `state/setup.json` keeps.
export const MACHINE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

const EMPTY = () => ({ operator: null, machine_name: null, serve: [] })

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
    if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link. Replace the link with the real file.`)
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return EMPTY()
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

// The routes in a `tailscale serve status --json` answer, which is the
// node's whole serve config: `{ Web: { "<host>:<port>": { Handlers: { "/":
// { Proxy } } } } }`.
// Each route names the MagicDNS host the rule stands under.
export function serveRoutes(config) {
  const out = []
  for (const [hostPort, site] of Object.entries(config?.Web ?? {})) {
    const at = hostPort.lastIndexOf(':')
    const host = at > 0 ? hostPort.slice(0, at) : ''
    const port = Number(hostPort.slice(at + 1))
    for (const [mount, handler] of Object.entries(site?.Handlers ?? {})) {
      if (handler?.Proxy) out.push({ https: port, host, mount, target: String(handler.Proxy) })
    }
  }
  return out
}

// The real `tailscale` CLI, the same shape as `dockerRunner` in compose.mjs:
// one invocation, output captured, never a throw. `onLine` receives each
// line of output as it arrives, which is how the tailnet step (tailnet.mjs)
// takes the login link off a `tailscale up` that blocks until the login.
export const tailscaleRunner = (args, { timeoutMs = 60_000, onLine } = {}) => new Promise((resolve) => {
  let child
  try {
    child = spawn('tailscale', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return resolve({ ok: false, stdout: '', stderr: error.message, code: error.code, missing: error.code === 'ENOENT', timedOut: false })
  }
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
  const lines = { out: '', err: '' }
  const feed = (which, chunk) => {
    lines[which] += chunk
    let at
    while ((at = lines[which].indexOf('\n')) >= 0) {
      onLine?.(lines[which].slice(0, at))
      lines[which] = lines[which].slice(at + 1)
    }
  }
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; feed('out', chunk) })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; feed('err', chunk) })
  child.once('error', (error) => {
    clearTimeout(timer)
    resolve({ ok: false, stdout, stderr: stderr || error.message, code: error.code, missing: error.code === 'ENOENT', timedOut })
  })
  child.once('close', (code, signal) => {
    clearTimeout(timer)
    for (const which of ['out', 'err']) if (lines[which]) onLine?.(lines[which])
    if (code === 0) return resolve({ ok: true, stdout, stderr, code: 0 })
    resolve({ ok: false, stdout, stderr: stderr || (signal ? `killed by ${signal}` : `exit ${code}`), code: code ?? signal, missing: false, timedOut })
  })
})

export class TailscaleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TailscaleError'
  }
}

// Withdraws the Serve routes the record under `stateDir` names, and no
// other. Returns `{ recorded, withdrawn, absent, stale, unreachable }`: the
// recorded routes, the ones turned off on this call, the ones that were not
// standing, the ones that stand under a name the node no longer has and
// were left, and whether the node could be asked at all. The `tailscale`
// command missing from the path counts every route as absent and the node
// as unreachable: with no CLI there is no node this operator can reach, and
// the record is kept for the next run that can. A node that answers with an
// error fails, because a route may still stand.
export async function withdrawServeRoutes({ stateDir, stdout }, { tailscale = tailscaleRunner } = {}) {
  const recorded = readTailscaleRecord(stateDir).serve
  if (recorded.length === 0) return { recorded, withdrawn: [], absent: [], stale: [], unreachable: false }

  const status = await tailscale(['serve', 'status', '--json'])
  if (!status.ok && status.missing) {
    stdout?.write(`the tailscale command is not on the path, so no Serve route is withdrawn; the record keeps ${recorded.length === 1 ? 'the route' : 'the routes'} for a host that runs Tailscale\n`)
    return { recorded, withdrawn: [], absent: recorded, stale: [], unreachable: true }
  }
  if (!status.ok) throw new TailscaleError(`tailscale serve status failed: ${firstLine(status.stderr || status.stdout) || `exit ${status.code}`}`)
  const standing = parseServeStatus(status)

  const same = (a, b) => a.https === b.https && a.target === b.target
  const withdrawn = []
  const absent = []
  // Rules of a recorded route that the port off left standing.
  const left = []
  for (const route of recorded) {
    const rules = standing.filter((s) => same(s, route))
    if (rules.length === 0) {
      absent.push(route)
      continue
    }
    const off = await tailscale(['serve', `--https=${route.https}`, 'off'])
    if (off.ok) {
      stdout?.write(`withdrew the Serve route ${describe(route)}\n`)
      withdrawn.push(route)
      // One rule was the one the off reached. More than one stand under
      // different names, and the node says which remain.
      if (rules.length > 1) left.push(...parseServeStatus(await tailscale(['serve', 'status', '--json'])).filter((s) => same(s, route)))
      continue
    }
    if (!handlerMissing(off)) throw new TailscaleError(`tailscale serve --https=${route.https} off failed: ${firstLine(off.stderr || off.stdout) || `exit ${off.code}`}`)
    // The off addressed the node's current name and found nothing there:
    // the rule went away since the read, or stands under another name.
    // The node says which.
    left.push(...parseServeStatus(await tailscale(['serve', 'status', '--json'])).filter((s) => same(s, route)))
  }

  const stale = []
  if (left.length > 0) {
    const others = standing.filter((s) => !recorded.some((r) => same(s, r)))
    if (others.length === 0) {
      const reset = await tailscale(['serve', 'reset'])
      if (!reset.ok) throw new TailscaleError(`tailscale serve reset failed: ${firstLine(reset.stderr || reset.stdout) || `exit ${reset.code}`}`)
      for (const route of recorded) {
        const rules = left.filter((s) => same(s, route))
        if (rules.length === 0) continue
        stdout?.write(`withdrew the Serve route ${describe(route)}, which stood under ${rules.map(at).join(' and ')}, a name this node no longer has; the node served nothing else, so 'tailscale serve reset' cleared it\n`)
        if (!withdrawn.includes(route)) withdrawn.push(route)
      }
    } else {
      for (const route of recorded) {
        const rules = left.filter((s) => same(s, route))
        if (rules.length === 0) continue
        stdout?.write(`the Serve route ${describe(route)} stands under ${rules.map(at).join(' and ')}, a name this node no longer has; 'tailscale serve --https=${route.https} off' cannot reach it, and 'tailscale serve reset' would also remove ${others.map((s) => `${at(s)} -> ${s.target}`).join(' and ')}\n`)
        stale.push(route)
      }
    }
  }
  for (const route of recorded) {
    if (!withdrawn.includes(route) && !absent.includes(route) && !stale.includes(route)) absent.push(route)
  }
  return { recorded, withdrawn, absent, stale, unreachable: false }
}

function parseServeStatus(status) {
  if (!status.ok) throw new TailscaleError(`tailscale serve status failed: ${firstLine(status.stderr || status.stdout) || `exit ${status.code}`}`)
  try {
    return serveRoutes(JSON.parse(status.stdout.trim() || '{}'))
  } catch {
    throw new TailscaleError('tailscale serve status --json did not answer JSON')
  }
}

// Tailscale's answer to an off on a hostport it does not serve: the rule
// is already off, whether it never stood or stands under another name.
const handlerMissing = (off) => /handler does not exist/.test(`${off.stderr}\n${off.stdout}`)
const describe = (route) => `https://:${route.https} -> ${route.target}`
const at = (rule) => `https://${rule.host}:${rule.https}`

const firstLine = (text) => String(text ?? '').trim().split('\n')[0]
