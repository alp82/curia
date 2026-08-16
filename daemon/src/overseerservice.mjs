// The overseer service (#327, building ADR-0015). Two halves live here: the
// block `config/curia.yaml` carries for it, and the health check the daemon
// asks about it.
//
// COMPOSE OWNS ITS LIVENESS, as ADR-0015 decides. `restart: unless-stopped` is
// what keeps it up, and the daemon asserts nothing and spawns nothing — the
// same posture #260 left `ttyd` in. What the daemon still does is SAY whether
// it is up, because a dead overseer is a chat that answers nothing, and silence
// is the one failure an operator cannot tell from a quiet day.
//
// THE PORT IS LOOPBACK ON THE HOST, AND THE BRIDGE INSIDE. Every other service
// in the stack runs on the host network. This one does not, and the difference
// is the containment ADR-0014 asks for: on the host network a shell in this
// container reaches the daemon's own loopback surface, ttyd, the identity proxy
// and the tailscaled socket. On the compose bridge it reaches none of them. It
// still reaches the daemon, at `host.docker.internal:<daemon port>`, which is
// the path every agent container already takes (#156/#188), and the daemon
// reaches it at `127.0.0.1:<this port>`, which is what compose publishes. #314
// took BOTH: the daemon posts the turn inward, and the model's verb tools reach
// the seam outward over the MCP side channel.

import net from 'node:net'
import { TURN_PATH } from './overseerturn.mjs'

// Beside the daemon (4271), the timeline (4272) and the dashboard (4273). It
// joins the collision check and the preview reserved list for the reason #263
// gave the sidecar's ports: a surface that shadowed another would be found as
// an outage instead of as a config error.
export const DEFAULT_OVERSEER = { port: 4274 }

// What answers "is it up". A plain marker, not JSON: the same shape #188 gave
// the side-channel probe, and for the same reason — something answering is not
// the same as OUR service answering.
export const PING_PATH = '/ping'
export const PING_MARK = 'curia-overseer'

// The `overseer:` block. Optional with a default, like `timeline:` and
// `dashboard:`: a config predating the container must still boot.
export function readOverseer(cfg, fail) {
  const over = cfg.overseer ?? {}
  if (typeof over !== 'object' || Array.isArray(over)) fail('`overseer` must be a mapping')
  const out = { port: over.port ?? DEFAULT_OVERSEER.port }
  if (!(Number.isInteger(out.port) && out.port > 0 && out.port < 65536)) {
    fail('overseer.port must be a port number — it is the loopback port compose publishes the overseer container on')
  }
  return out
}

// A dial, and the same 750 ms as the ttyd probe. A bind test would be the wrong
// question here: the port is held by a container, and this process asks whether
// something is behind it.
export function portLive(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 750 })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
}

// The health check. It never throws and it never restarts anything: the answer
// is a fact for the overview, and compose owns what to do about it.
//
// The marker is read, not just the connection: a preview proxy or a hand-run
// server on the same loopback port would accept a connection and answer
// something else, and "the overseer is up" would then be a claim about the
// wrong process.
export async function probeOverseer({ port, fetchImpl = fetch, timeoutMs = 2_000 } = {}) {
  if (!(await portLive(port))) return { up: false, why: 'nothing is listening' }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}${PING_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.text()
    if (!res.ok || !body.includes(PING_MARK)) {
      return { up: false, why: 'something answers on that port, and it is not the overseer' }
    }
  } catch (e) {
    return { up: false, why: `the ping failed: ${String(e.message ?? e).split('\n')[0]}` }
  }
  return { up: true, why: null }
}

// The container's own request handler, here rather than in `bin/` so the suite
// can drive it without a container.
//
// TWO ROUTES, and no third. `GET /ping` is the health check the daemon reads.
// `POST /turn` is the turn #314 carried across the boundary, and its whole
// shape lives in `overseerturn.mjs` — this file routes to it and knows nothing
// about it. Everything else is a 404: this container serves the daemon, and a
// route it does not have is a caller error rather than a promise for later.
//
// `turn` is injected. A handler built without one still answers the health
// check, which is what the suite drives and what a container with a broken
// config can still say for itself.
export function overseerHandler({ log = console.log, turn = null } = {}) {
  return (req, res) => {
    const url = new URL(req.url, 'http://overseer.invalid')
    if (req.method === 'GET' && url.pathname === PING_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`${PING_MARK}\n`)
      return
    }
    if (req.method === 'POST' && url.pathname === TURN_PATH && turn) {
      return turn(req, res)
    }
    log(`refused ${req.method} ${url.pathname}: the overseer container serves ${PING_PATH} and ${TURN_PATH}`)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: `no route ${req.method} ${url.pathname} — the overseer container serves ${PING_PATH} and ${TURN_PATH}`,
    }))
  }
}
