// PROTOTYPE (#73) — the non-PTY timeline attach surface #72 ranked first.
//
// Throwaway. No tests, no config validation, no journal. It exists to be
// judged live on a real phone and a real desktop, side by side with the ttyd
// attach page, and then thrown away or rewritten as asserted config (#70).
//
// Read  = tail the worker's own transcript JSONL under CLAUDE_CONFIG_DIR.
// Write = `tmux send-keys` into the worker's pane.
//
// Neither path parses a terminal and neither resizes a pane, so two devices on
// this surface never meet: they read one append-only file at their own widths
// and write to one composer, and the pane never learns either exists.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = process.env.CURIA_WORKSPACE ?? '/home/alp/curia-work'
const PORT = Number(process.env.TIMELINE_PORT ?? 4272)
const POLL_MS = Number(process.env.TIMELINE_POLL_MS ?? 600)

// The same whitelist the ttyd wrapper enforces (#30/#33). This surface has a
// write path into a bypassPermissions worker, so it gets the same bound.
const SESSION_RE = /^curia-[A-Za-z0-9._-]+$/

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------------------------------------------------------------------------
// transcript → timeline items
// ---------------------------------------------------------------------------

function readdirSafe(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

// The newest transcript under the session's own config dir. A worker writes one
// per project dir; a re-dispatch onto the same ticket writes a new one, so
// "newest by mtime" is the live run.
function transcriptFor(session) {
  const projects = path.join(WORKSPACE, 'cfg', session, 'projects')
  let best = null
  for (const proj of readdirSafe(projects)) {
    for (const f of readdirSafe(path.join(projects, proj))) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(projects, proj, f)
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs }
    }
  }
  return best?.path ?? null
}

function firstLine(s, n = 200) {
  const line = String(s ?? '').split('\n').find((l) => l.trim()) ?? ''
  return line.length > n ? `${line.slice(0, n)}…` : line
}

// One line that says what a tool call is DOING, per tool. This is the only
// place the surface knows anything about the agent's vocabulary.
function toolBrief(name, input = {}) {
  if (name === 'Bash') return firstLine(input.command)
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    return String(input.file_path ?? '').replace(/^\/home\/alp\//, '~/')
  }
  if (name === 'Grep' || name === 'Glob') return `${input.pattern ?? ''} ${input.path ?? ''}`.trim()
  if (name === 'TodoWrite') return `${input.todos?.length ?? 0} items`
  if (name?.startsWith('mcp__curia__')) {
    return firstLine(input.prompt ?? input.summary ?? input.message ?? JSON.stringify(input))
  }
  if (name === 'Task' || name === 'Agent') return firstLine(input.description ?? input.prompt)
  return firstLine(JSON.stringify(input), 160)
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n')
  }
  return JSON.stringify(content ?? '')
}

// A transcript line becomes zero or more timeline items. Everything geometry-
// bound is absent from the source by construction — there is nothing here to
// reflow, which is the whole reason this surface can be two sizes at once.
function toItems(e) {
  const at = e.timestamp ?? null
  if (e.type === 'assistant') {
    const out = []
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'say', at, text: c.text })
      else if (c.type === 'thinking' && c.thinking?.trim()) out.push({ kind: 'think', at, text: c.thinking })
      else if (c.type === 'tool_use') {
        out.push({ kind: 'tool', at, id: c.id, name: c.name, brief: toolBrief(c.name, c.input) })
      }
    }
    return out
  }
  if (e.type === 'user') {
    const content = e.message?.content
    if (typeof content === 'string') {
      return content.trim() ? [{ kind: 'prompt', at, text: content }] : []
    }
    const out = []
    for (const c of content ?? []) {
      if (c.type === 'tool_result') {
        const text = resultText(c.content)
        out.push({
          kind: 'result', at, forId: c.tool_use_id, ok: !c.is_error,
          brief: firstLine(text, 300), lines: text.split('\n').length,
        })
      } else if (c.type === 'text' && c.text?.trim()) {
        out.push({ kind: 'prompt', at, text: c.text })
      } else if (c.type === 'image') {
        out.push({ kind: 'note', at, text: '[image]' })
      }
    }
    return out
  }
  // A message driven in mid-turn is ENQUEUED, then `remove`d when the turn
  // picks it up and it reappears as a plain user message. Only the enqueue is
  // rendered — it is the moment the other device's input became visible.
  if (e.type === 'queue-operation' && e.operation === 'enqueue') {
    return e.content ? [{ kind: 'queued', at, text: String(e.content) }] : []
  }
  return []
}

// ---------------------------------------------------------------------------
// per-session tailer: append-only file in, SSE out
// ---------------------------------------------------------------------------

const sessions = new Map() // name -> { file, offset, rest, items, clients:Set, draft }

function sessionState(name) {
  let s = sessions.get(name)
  if (!s) {
    s = { file: null, offset: 0, rest: '', items: [], clients: new Set(), draft: '' }
    sessions.set(name, s)
  }
  return s
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(s, event, data, except = null) {
  for (const c of s.clients) if (c.res !== except) send(c.res, event, data)
}

function pump(name) {
  const s = sessionState(name)
  const file = transcriptFor(name)
  if (file !== s.file) {
    // A new run for this ticket: start the timeline over rather than splicing
    // two conversations together.
    s.file = file
    s.offset = 0
    s.rest = ''
    s.items = []
    broadcast(s, 'reset', { file })
    if (!file) return
  }
  if (!s.file) return
  let st
  try { st = fs.statSync(s.file) } catch { return }
  if (st.size < s.offset) { s.offset = 0; s.rest = ''; s.items = []; broadcast(s, 'reset', { file: s.file }) }
  if (st.size === s.offset) return

  const fd = fs.openSync(s.file, 'r')
  const buf = Buffer.alloc(st.size - s.offset)
  fs.readSync(fd, buf, 0, buf.length, s.offset)
  fs.closeSync(fd)
  s.offset = st.size

  const chunk = s.rest + buf.toString('utf8')
  const lines = chunk.split('\n')
  s.rest = lines.pop() ?? '' // a half-written line stays in the buffer
  const fresh = []
  for (const line of lines) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    for (const item of toItems(e)) {
      item.seq = s.items.length
      s.items.push(item)
      fresh.push(item)
    }
  }
  if (fresh.length) broadcast(s, 'items', fresh)
}

setInterval(() => {
  for (const name of sessions.keys()) {
    try { pump(name) } catch (e) { log('pump', name, e.message) }
  }
}, POLL_MS).unref?.()

// ---------------------------------------------------------------------------
// write path: tmux send-keys, which needs no attached client and no geometry
// ---------------------------------------------------------------------------

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout)
    })
  })
}

// -l sends the text LITERALLY (no key-name interpretation), then a separate
// Enter submits it. The pane target carries the trailing colon for the same
// reason capturePane does (#33): a real worker renames its window.
async function sendText(session, text) {
  await tmux(['send-keys', '-t', `=${session}:`, '-l', text])
  await tmux(['send-keys', '-t', `=${session}:`, 'Enter'])
}

const KEYS = { escape: 'Escape', 'ctrl-c': 'C-c', enter: 'Enter', up: 'Up', tab: 'Tab' }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }

  // ttyd's -O by hand: Origin must equal Host. This surface can drive a
  // bypassPermissions worker, so it does not get a weaker gate than the one it
  // sits beside. Real auth is the same deferred item as ttyd's (#30).
  if (req.method === 'POST') {
    const origin = req.headers.origin
    if (origin && new URL(origin).host !== req.headers.host) {
      return json(403, { error: 'cross-origin refused' })
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(HERE, 'page.html'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(html)
  }

  const session = url.searchParams.get('session') ?? ''

  if (url.pathname === '/events') {
    if (!SESSION_RE.test(session)) return json(400, { error: `"${session}" is not a curia session name` })
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const s = sessionState(session)
    // Pump BEFORE this client joins the broadcast set, or the first tick's
    // items reach it once as a broadcast and once again in the backlog below.
    try { pump(session) } catch { /* first pump may race the session's creation */ }
    const client = { res, id: url.searchParams.get('client') ?? String(Math.random()) }
    s.clients.add(client)
    // A late joiner replays the whole run for free: the backlog problem a broker
    // has to solve is solved by the file being a file.
    send(res, 'hello', { session, file: s.file, clients: s.clients.size, draft: s.draft })
    if (s.items.length) send(res, 'items', s.items)
    broadcast(s, 'clients', { clients: s.clients.size })
    // `once` closes the stream after the backlog. Only a screenshot harness
    // wants this: a page holding an open SSE never finishes loading, so a
    // headless browser can never draw it.
    if (url.searchParams.get('once')) {
      s.clients.delete(client)
      return res.end()
    }
    const ka = setInterval(() => res.write(': ka\n\n'), 15000)
    req.on('close', () => {
      clearInterval(ka)
      s.clients.delete(client)
      broadcast(s, 'clients', { clients: s.clients.size })
    })
    return
  }

  if (url.pathname === '/send' && req.method === 'POST') {
    const b = await body(req)
    if (!SESSION_RE.test(b.session)) return json(400, { error: 'bad session' })
    const text = String(b.text ?? '')
    if (!text.trim()) return json(400, { error: 'empty' })
    try {
      await sendText(b.session, text)
    } catch (e) {
      return json(502, { error: e.message })
    }
    const s = sessionState(b.session)
    s.draft = ''
    broadcast(s, 'draft', { text: '', by: b.client ?? null })
    broadcast(s, 'sent', { text, by: b.client ?? null })
    return json(200, { ok: true })
  }

  // The shared composer. tmux gives two attached clients ONE composer, and
  // pass-bar item 4 asks for that behavior back: what one device types shows on
  // the other in realtime. Here it is an explicit broadcast rather than a
  // consequence of sharing a grid.
  if (url.pathname === '/draft' && req.method === 'POST') {
    const b = await body(req)
    if (!SESSION_RE.test(b.session)) return json(400, { error: 'bad session' })
    const s = sessionState(b.session)
    s.draft = String(b.text ?? '')
    broadcast(s, 'draft', { text: s.draft, by: b.client ?? null })
    return json(200, { ok: true })
  }

  if (url.pathname === '/key' && req.method === 'POST') {
    const b = await body(req)
    if (!SESSION_RE.test(b.session)) return json(400, { error: 'bad session' })
    const key = KEYS[String(b.key ?? '').toLowerCase()]
    if (!key) return json(400, { error: 'unknown key' })
    try {
      await tmux(['send-keys', '-t', `=${b.session}:`, key])
    } catch (e) {
      return json(502, { error: e.message })
    }
    broadcast(sessionState(b.session), 'sent', { text: `⌨ ${key}`, by: b.client ?? null })
    return json(200, { ok: true })
  }

  json(404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => log(`timeline prototype on http://127.0.0.1:${PORT}`))
