import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { HEALTH_POLL_MS, compose, composeProject, dockerRunner, pullAgentImage, waitForHealth, writeComposeEnvironment } from './compose.mjs'
import { APP_PORT, SERVICE_PORT } from './doctor.mjs'
import { writeInstallationRecord } from './root.mjs'

// The switch of a live installation from one installed release to another
// (#884, implementing #854), the one door `curia update` and `curia
// rollback` (#885) share.
//
// Both releases are complete under versions/<version>/, the target is
// validated, and the caller holds the lifecycle lock. What happens here:
//
//   1. The live sessions are read from the running service (`GET /overview`
//      on loopback): every agent whose tmux pane is live. That is the list
//      the recreated service must adopt back.
//   2. `run/compose.env` is rewritten with the same values, the target's
//      images are pulled by digest, and the core services (the service, the
//      app, and the overseer) are recreated from the target's bundle with
//      `up --detach --no-deps`. The tmux runtime, the attach surface, and
//      every agent container keep running: they are not named, `--no-deps`
//      keeps Compose off the runtime the service depends on, and nothing
//      removes orphans. An agent keeps the image it started on; the
//      target's agent image is pulled here too, so the recreated service
//      starts the next agent from the target release's image with no pull
//      on the dispatch path. The recreated service reads that image from
//      the target's release manifest; it builds nothing. The overseer comes back beside the service, which is the
//      shape its replay of an interrupted turn was built for (ADR-0015).
//   3. Acceptance: every declared service reports healthy, the service and
//      the app report the target version on their `/ping` routes, and every
//      live session from step 1 is adopted by the recreated service's
//      reconcile, read from `/overview` until it settles or the deadline
//      passes. A session that vanished from tmux meanwhile ended on its
//      own and is reported, not failed.
//   4. Activation: the installation record names the target, through one
//      atomic write, and every directory under versions/ other than the
//      target and the release that was active is removed. The release that
//      was active is the one rollback release.
//
// A failure anywhere after the recreate switches the core services back to
// the release that was active, once, and proves that release the same way:
// its health, its version on both `/ping` routes, and the same live
// sessions adopted back. Then it reports both outcomes. Nothing runs the
// target a second time, and nothing runs the switch back a second time: a
// switch back that fails its own proof is reported as failed too, with the
// reinstall as the way out. The record is untouched by a failure: it names
// the target only after acceptance, so the launcher and the service's own
// reads follow the switch and never a half of one. The staged target stays
// under versions/ for the rerun.
//
// Docker is reached through `compose.mjs` and its injectable runner; the
// service and the app through an injectable `fetch`. Nothing here prints or
// reads a secret.

export const CORE_SERVICES = Object.freeze(['daemon', 'dashboard', 'overseer'])


// How long the recreated service may take to report the target version and
// adopt every live session, counted after its health check passed. The boot
// reconcile reads GitHub once per live ticket, so a fleet of a dozen agents
// on a slow origin needs a minute; two is the bound.
export const READOPTION_TIMEOUT_MS = 120_000
const READ_TIMEOUT_MS = 10_000

export class SwitchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SwitchError'
  }
}

// Switches the core services from `from` to `to` and records `to` active.
// `record` is the installation record as it stands; `environment` is what
// `run/compose.env` carries (`uid`, `gid`, `dockerGid`, `installationId`).
// Returns what was re-adopted. Throws a `SwitchError` that says what failed
// and where the installation stands.
export async function switchRelease(
  { root, from, to, record, environment, stdout },
  { docker = dockerRunner, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {},
) {
  const say = (text) => stdout.write(`${text}\n`)
  const read = reader(fetchImpl)
  const target = composeProject({ root, version: to })
  const previous = composeProject({ root, version: from })

  // 1. What is live now, from the service that is about to be recreated.
  const live = await liveSessions(read)
  if (live === null) say('the service did not answer before the switch, so no live session is expected back')
  else if (live.length === 0) say('no live session to re-adopt')
  else say(`${live.length} live ${live.length === 1 ? 'session' : 'sessions'} to re-adopt after the switch: ${live.join(', ')}`)

  // 2. The recreate.
  writeComposeEnvironment(target, environment)
  say(`pulling the images of ${to} by digest`)
  await compose(target, ['pull', ...CORE_SERVICES], { docker })
  await pullAgentImage(target, { docker })
  say(`recreating ${CORE_SERVICES.join(', ')} from ${to}; tmux, ttyd, and the agent containers keep running`)
  say('an agent keeps the image it started on; the next agent uses the image of the target release')
  say('the overseer replays a turn the switch interrupted, as it does after any restart')
  await compose(target, ['up', '--detach', '--no-deps', ...CORE_SERVICES], { docker })

  // 3. Acceptance, then 4. activation. A failure past the recreate goes back.
  let adopted
  try {
    await waitForHealth(target, { docker, sleep, now, stdout })
    adopted = await acceptRecreated({ to, live, read, sleep, now, say })
    writeInstallationRecord(root, { ...record, activeVersion: to })
  } catch (e) {
    throw await switchBack({ previous, from, live, read, docker, sleep, now, stdout, cause: e })
  }
  say(`${to} is the active version; ${from} is kept for 'curia rollback'`)
  for (const other of readdirSync(join(root, 'versions'))) {
    if (other === to || other === from) continue
    rmSync(join(root, 'versions', other), { recursive: true, force: true })
    if (!other.startsWith('.')) say(`removed ${other}, which is no longer a rollback release`)
  }
  return adopted
}

// The sessions whose tmux pane is live, as the running service reports
// them, or null when the service does not answer.
export async function liveSessions(read) {
  const overview = await read.json(`http://127.0.0.1:${SERVICE_PORT}/overview`)
  if (!overview.ok || !Array.isArray(overview.body?.agents)) return null
  return overview.body.agents.filter((a) => a?.tmux_live === true).map((a) => String(a.session)).sort()
}

// The recreated service must say the target version, the app must say it
// too, and every live session must be adopted. The version reads settle at
// once (a healthy service answers its version on the first read); the
// adoption settles when the boot reconcile has run, which the listener
// answers before. So the loop polls until the fleet is determinate and
// every session is either adopted or gone, and fails at the deadline on the
// first one still unadopted.
async function acceptRecreated({ to, live, read, sleep, now, say }) {
  const service = await read.json(`http://127.0.0.1:${SERVICE_PORT}/ping`)
  const app = await read.json(`http://127.0.0.1:${APP_PORT}/ping`)
  const reported = (answer) => (answer.ok ? String(answer.body?.version ?? 'no version') : `no answer (${answer.error})`)
  if (!service.ok || service.body?.version !== to || !app.ok || app.body?.version !== to) {
    throw new SwitchError(`the service reports ${reported(service)} and the Curia app reports ${reported(app)}, not ${to}.`)
  }
  say(`the service reports ${to} and the Curia app reports ${to}`)

  if (live === null || live.length === 0) return { adopted: [], ended: [] }
  const started = now()
  for (;;) {
    const overview = await read.json(`http://127.0.0.1:${SERVICE_PORT}/overview`)
    const agents = overview.ok && Array.isArray(overview.body?.agents) ? overview.body.agents : null
    if (agents !== null) {
      const untracked = new Set(Array.isArray(overview.body.untracked) ? overview.body.untracked.map(String) : [])
      const adopted = live.filter((s) => agents.some((a) => String(a?.session) === s && a.tmux_live === true))
      const ended = live.filter((s) => !adopted.includes(s) && !untracked.has(s))
      const pending = live.filter((s) => !adopted.includes(s) && !ended.includes(s))
      if (pending.length === 0) {
        if (adopted.length > 0) say(`re-adopted ${adopted.length} live ${adopted.length === 1 ? 'session' : 'sessions'}: ${adopted.join(', ')}`)
        for (const s of ended) say(`${s} ended during the switch; nothing to re-adopt`)
        return { adopted, ended }
      }
      if (now() - started >= READOPTION_TIMEOUT_MS) {
        throw new SwitchError(`${to} did not re-adopt ${pending[0]} within ${Math.round(READOPTION_TIMEOUT_MS / 1000)} seconds: its pane is live and the service does not track it.`)
      }
    } else if (now() - started >= READOPTION_TIMEOUT_MS) {
      throw new SwitchError(`${to} did not report its agents within ${Math.round(READOPTION_TIMEOUT_MS / 1000)} seconds, so the ${live.length} live ${live.length === 1 ? 'session was' : 'sessions were'} not proven re-adopted.`)
    }
    await sleep(HEALTH_POLL_MS)
  }
}

// One switch back to the release that was active, proven the way the target
// was (health, version, re-adoption of the same live sessions), then the
// failure that names both outcomes. The record was never changed.
async function switchBack({ previous, from, live, read, docker, sleep, now, stdout, cause }) {
  const say = (text) => stdout.write(`${text}\n`)
  say(`switching back to ${from}`)
  let adopted
  try {
    await compose(previous, ['up', '--detach', '--no-deps', ...CORE_SERVICES], { docker })
    await waitForHealth(previous, { docker, sleep, now, stdout })
    adopted = await acceptRecreated({ to: from, live, read, sleep, now, say })
  } catch (e) {
    return new SwitchError(`${cause.message} The switch back to ${from} failed too: ${e.message} The record still names ${from}; run 'curia reinstall' to start it again, or read the logs first.`)
  }
  const n = adopted.adopted.length
  const readopted = n === 0 ? '' : ` and re-adopted ${n} live ${n === 1 ? 'session' : 'sessions'}`
  return new SwitchError(`${cause.message} Switched back to ${from}, which is healthy${readopted}. The record still names ${from}.`)
}

// A JSON read that answers instead of throwing.
function reader(fetchImpl) {
  return {
    async json(url) {
      try {
        const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        return { ok: true, body: await response.json() }
      } catch (e) {
        return { ok: false, error: String(e.cause?.message ?? e.message).split('\n')[0] }
      }
    },
  }
}
