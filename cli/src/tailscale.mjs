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
// is no longer standing is nothing to do, so a rerun is quiet.

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
// other. Returns `{ recorded, withdrawn, absent, unreachable }`: the
// recorded routes, the ones turned off on this call, the ones that were not
// standing, and whether the node could be asked at all. The `tailscale`
// command missing from the path counts every route as absent and the node
// as unreachable: with no CLI there is no node this operator can reach, and
// the record is kept for the next run that can. A node that answers with an
// error fails, because a route may still stand.
export async function withdrawServeRoutes({ stateDir, stdout }, { tailscale = tailscaleRunner } = {}) {
  const recorded = readTailscaleRecord(stateDir).serve
  if (recorded.length === 0) return { recorded, withdrawn: [], absent: [], unreachable: false }

  const status = await tailscale(['serve', 'status', '--json'])
  if (!status.ok && status.missing) {
    stdout?.write(`the tailscale command is not on the path, so no Serve route is withdrawn; the record keeps ${recorded.length === 1 ? 'the route' : 'the routes'} for a host that runs Tailscale\n`)
    return { recorded, withdrawn: [], absent: recorded, unreachable: true }
  }
  if (!status.ok) throw new TailscaleError(`tailscale serve status failed: ${firstLine(status.stderr || status.stdout) || `exit ${status.code}`}`)
  let standing
  try {
    standing = serveRoutes(JSON.parse(status.stdout.trim() || '{}'))
  } catch {
    throw new TailscaleError('tailscale serve status --json did not answer JSON')
  }

  const withdrawn = []
  const absent = []
  for (const route of recorded) {
    const stands = standing.some((s) => s.https === route.https && s.target === route.target)
    if (!stands) {
      absent.push(route)
      continue
    }
    const off = await tailscale(['serve', `--https=${route.https}`, 'off'])
    if (!off.ok) throw new TailscaleError(`tailscale serve --https=${route.https} off failed: ${firstLine(off.stderr || off.stdout) || `exit ${off.code}`}`)
    stdout?.write(`withdrew the Serve route https://:${route.https} -> ${route.target}\n`)
    withdrawn.push(route)
  }
  return { recorded, withdrawn, absent, unreachable: false }
}

const firstLine = (text) => String(text ?? '').trim().split('\n')[0]
