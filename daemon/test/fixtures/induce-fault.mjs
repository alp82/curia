// Fault injection for the #56 crash-guard test, preloaded into the REAL daemon
// with `--import` so no injection hook exists in product code.
//
// `ws-handshake` recreates the crash exactly as discord.js produces it: a
// WebSocket still in CONNECTING whose handshake timer is armed, stripped of its
// error listeners the way WebSocketShard.destroy() strips them (it nulls
// onmessage/onclose/onerror and skips close(), because close() only runs on a
// socket that reached OPEN). When the timer fires, ws emits 'error' on a
// listener-less emitter — the `websocket.js:890` frame from the incident.
//
// `bug` plants a plain logic error instead: no network code, no network
// message. The guard must still kill the daemon for that one.

//
// `live` is the mode the LIVE check uses against the real Discord bridge. It
// adds nothing to the daemon: it patches the `ws` module in the CommonJS cache
// before @discordjs/ws captures its WebSocket constructor, so every gateway
// socket the library opens is recorded, and it exposes a loopback control port:
//
//   POST /abandon  — the #56 crash, on a socket that was never a shard's
//   POST /drop     — terminate the LIVE gateway socket: a real disconnect, so
//                    the library's own reconnect ladder is what gets watched
//   GET  /sockets  — what is tracked, and in what state

import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { WebSocket } from 'ws'

const mode = process.env.CURIA_INDUCE
const after = Number(process.env.CURIA_INDUCE_AFTER_MS ?? 1500)

// The exact shape WebSocketShard.destroy() leaves behind on a CONNECTING socket.
function abandonConnectingSocket(onReady) {
  const blackhole = net.createServer(() => {})
  blackhole.listen(0, '127.0.0.1', () => {
    const ws = new WebSocket(`ws://127.0.0.1:${blackhole.address().port}`, [], { handshakeTimeout: 500 })
    ws.onmessage = () => {}
    ws.onclose = () => {}
    ws.onerror = () => {}
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    console.log('[induce] abandoned a CONNECTING socket with 0 error listeners')
    onReady?.()
  })
}

if (mode === 'ws-handshake') {
  setTimeout(() => abandonConnectingSocket(), after)
} else if (mode === 'bug') {
  setTimeout(() => {
    throw new TypeError('planted logic bug: this is not a network failure')
  }, after)
} else if (mode === 'live') {
  const require = createRequire(import.meta.url)
  const wsModule = require('ws')
  const Real = wsModule.WebSocket
  const tracked = []

  // A TCP listener that accepts and never upgrades. While the blackhole is
  // armed, every gateway socket the library opens is redirected here, so the
  // gateway is unreachable for real: handshakes hang, the shard gives up on
  // sockets that are still CONNECTING, and #56's crash arises from the library's
  // own reconnect ladder rather than from a socket this file hand-crafted.
  const sink = net.createServer(() => {})
  let blackholeUntil = 0
  sink.listen(0, '127.0.0.1')
  sink.unref()

  class TrackedWebSocket extends Real {
    constructor(...args) {
      const target = Date.now() < blackholeUntil ? `ws://127.0.0.1:${sink.address().port}` : args[0]
      super(target, ...args.slice(1))
      tracked.push(this)
      const swallowed = target === args[0] ? '' : ' [BLACKHOLED]'
      console.log(`[induce] gateway socket #${tracked.length} opening: ${String(args[0]).slice(0, 60)}${swallowed}`)
    }
  }
  // @discordjs/ws reads `import_ws.WebSocket` when its module body runs, which
  // is after this preload — so it picks the subclass up.
  wsModule.WebSocket = TrackedWebSocket

  const reply = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  const control = http.createServer((req, res) => {
    if (req.url === '/sockets') {
      return reply(res, 200, { sockets: tracked.map((s, i) => ({ i, readyState: s.readyState, url: s.url })) })
    }
    if (req.url === '/abandon' && req.method === 'POST') {
      abandonConnectingSocket()
      return reply(res, 200, { ok: true, induced: 'abandoned CONNECTING socket, handshake times out in ~500ms' })
    }
    if (req.url?.startsWith('/blackhole') && req.method === 'POST') {
      const ms = Number(new URL(req.url, 'http://x').searchParams.get('ms') ?? 90_000)
      blackholeUntil = Date.now() + ms
      const live = [...tracked].reverse().find((s) => s.readyState === Real.OPEN)
      live?.terminate() // kick it off the working socket so the ladder starts now
      return reply(res, 200, { ok: true, induced: `gateway unreachable for ${ms}ms`, kicked: Boolean(live) })
    }
    if (req.url === '/drop' && req.method === 'POST') {
      const live = [...tracked].reverse().find((s) => s.readyState === Real.OPEN)
      if (!live) return reply(res, 409, { ok: false, reason: 'no OPEN gateway socket tracked' })
      live.terminate() // no close frame: what a yanked network looks like
      return reply(res, 200, { ok: true, induced: 'terminated the live gateway socket' })
    }
    reply(res, 404, { error: 'not found' })
  })
  control.listen(Number(process.env.CURIA_INDUCE_PORT ?? 4272), '127.0.0.1', () => {
    console.log(`[induce] control on http://127.0.0.1:${control.address().port} (/sockets, /abandon, /drop)`)
  })
  control.unref()
}
