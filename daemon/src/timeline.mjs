// The timeline attach surface (#74, landing #73's pick): read a worker by
// tailing its own transcript, write to it with `tmux send-keys` — no terminal
// parsed, no pane resized, so a phone and a desktop each lay the same run out
// at their own width and both drive the same live turn (#72's division of
// labor: the timeline is where you drive; the PTY is where you go when you
// need to see the terminal itself).
//
// The daemon hosts this in-process rather than as a child: the surface then
// dies with the daemon (no orphan process to sweep — #19's lesson pre-empted),
// and it reads two things only the daemon has — the dispatcher's word on which
// backend a session runs, and the durable escalation record. The record
// matters because of #74's own measurement: the claude lane writes NOTHING to
// its transcript while an ask_human blocks (the tool_use line is flushed only
// with the result), so a timeline that reads the transcript alone is silent
// through every escalation — precisely when a human most needs to see one.
// Open escalations for the session are therefore overlaid from the store on
// both lanes (the codex lane shows the call natively; the overlay adds the
// answer-surface state either way).
//
// IDENTITY (#151 — the deferral #74 item 6 restated is now CLOSED). Every
// request, read and write alike, must carry a `Tailscale-User-Login` on the
// allowlist and a Host this box actually serves (identity.mjs holds the
// predicate and the evidence behind it). Reads are gated too, not only writes:
// the transcript IS the sensitive thing here — a read-only caller still gets
// every line the worker has produced.
//
// The Origin-must-equal-Host check below stays where it was, unchanged. It is
// no longer load-bearing on its own — a non-browser client forges Origin
// trivially — but it costs nothing and it is the one control that survives if
// the identity check is ever misconfigured wide.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertServe, serveOff, attachBase, validSessionName } from './attach.mjs'
import { paneTail } from './dispatch.mjs'
import { sendText, sendKey, capturePane } from './tmux.mjs'
import { detectBackend, findTranscript, parseLine } from './transcript.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_TIMELINE_INDEX = path.resolve(DIR, '..', 'assets', 'timeline.html')

// The page and this server are two halves of one protocol (SSE event names,
// POST shapes, item kinds). They cannot drift on disk — both live in this repo
// and there is no build step; the file the server reads IS the reviewed
// source, re-read per request. What CAN drift is the running process against
// the disk: a repo pull that changes both halves, with no daemon restart,
// leaves an old server serving a new page. That is #70's staleness one layer
// up, and the stamp closes it the same way: the page declares the protocol it
// speaks, the server compares against its own constant on every reconcile and
// every request, and a mismatch refuses loudly rather than serving a surface
// nobody agreed to. It also refuses an operator-pointed index that was never
// written against this server at all.
export const TIMELINE_PROTO = 3
export const STAMP_NAME = 'curia-timeline'
const STAMP_RE = new RegExp(`<meta name="${STAMP_NAME}" content="proto=(\\d+)">`)

// Same classification rule as attach.mjs indexRefusal: only POSITIVE evidence
// refuses — a missing file, a page with no stamp, a stamp for another proto.
export function pageRefusal(indexFile) {
  let head
  try {
    head = fs.readFileSync(indexFile, 'utf8')
  } catch {
    return `timeline page ${indexFile} is not readable — it ships committed in daemon/assets/`
  }
  const m = STAMP_RE.exec(head)
  if (!m) return `timeline page ${indexFile} carries no ${STAMP_NAME} proto stamp — it is not a page this server speaks`
  if (Number(m[1]) !== TIMELINE_PROTO) {
    return `timeline page ${indexFile} speaks proto ${m[1]} but this daemon speaks proto ${TIMELINE_PROTO} — restart the daemon on the same checkout as the page`
  }
  return null
}

const KEYS = { escape: 'Escape', 'ctrl-c': 'C-c', enter: 'Enter', up: 'Up', tab: 'Tab' }

// ---------------------------------------------------------------------------
// the terminal-dialog guard (#75)
// ---------------------------------------------------------------------------
//
// A native dialog (AskUserQuestion, the folder-trust prompt) is the PTY's half
// of #73's division of labor: it never reaches the transcript, so the timeline
// is blind to it — and a /send while one owns the pane is typed INTO the
// dialog, where the trailing Enter answers it blind, or is swallowed outright
// (#75's live incident: the operator's own approval of #74 vanished this way,
// with no trace on the page, the worker, or the journal). The surface must not
// render or answer the dialog itself — only stop being silent about it.
//
// Detection is pane-text, the same evidence #25 recorded these prompts leave
// (they read as false-`idle` to state probes, so text is all there is). Every
// dialog footer verified live carries the same chrome — "Enter to <verb> ·":
//   trust prompt        "Enter to confirm · Esc to cancel"
//   /model picker       "Enter to set as default · s to use this session only …"
//   AskUserQuestion     "Enter to select · ↑/↓ to navigate"   (#75's capture)
// The pane is UNTRUSTED TEXT (#33's lesson: a ticket body can quote any
// phrase, and this ticket's own body quotes the AskUserQuestion footer), so
// two narrowings apply: the classifier sees only the pane TAIL, and a visible
// composer VETOES the match — verified live: every dialog above replaces the
// composer, so its per-backend ready marker (#39) and a real dialog never
// share a tail; a footer phrase that scrolled by in worker output does.
export const DIALOG_MARKERS = [
  /Enter to [^·\n]{1,60}·/, // "Enter to <verb> …" joined to more chrome by a middot
  /↑\/↓ to navigate/, // belt and braces should the select footer reword its verb
]

export function detectDialog(pane, composerRe = null) {
  const tail = paneTail(pane)
  const hit = DIALOG_MARKERS.map((re) => re.exec(tail)?.[0]).find(Boolean)
  if (!hit) return null
  if (composerRe && composerRe.test(tail)) return null
  return { hint: hit.trim().replace(/·$/, '').trim() }
}

// While a dialog is up, Escape and Ctrl-C still pass — dismissing or
// interrupting is how a phone gets unstuck, and neither answers the dialog.
// Enter/Up/Tab would drive its selection blind, so they refuse like /send.
const DIALOG_SAFE_KEYS = new Set(['Escape', 'C-c'])

// What lands in the journal for a /send: enough text to identify the vanished
// input by grep, without archiving a pasted novel.
const JOURNAL_TEXT_MAX = 500
const clip = (text) => (text.length > JOURNAL_TEXT_MAX ? `${text.slice(0, JOURNAL_TEXT_MAX)}…` : text)

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

export class TimelineSurface {
  constructor({ port, servePort, index, workspaceRoot, log = console.log, pollMs = 600, dialogProbeMs = 2000, deps = {} }) {
    this.port = port
    this.servePort = servePort
    this.index = index
    this.workspaceRoot = workspaceRoot
    this.log = log
    this.pollMs = pollMs
    // The dialog probe is a tmux exec per watched session, so it runs at the
    // watchdog's cadence (#33), not the transcript tick's.
    this.dialogProbeMs = dialogProbeMs
    this.deps = {
      assertServe, serveOff, attachBase, sendText, sendKey, capturePane,
      // composerFor(backend): the per-backend ready regex (#39) — the veto in
      // detectDialog. Null skips the veto, never the marker match.
      composerFor: () => null,
      // journal(type, detail): the store's logEvent, injected by index.mjs.
      journal: () => {},
      // backendFor(session): the dispatcher's word, with detectBackend as the
      // on-disk fallback for re-adopted and lab sessions.
      backendFor: (session) => detectBackend(this.#cfgDir(session)),
      // escalationsFor(session): open escalation records for this worker.
      escalationsFor: () => [],
      // escalationHistoryFor(session): every escalation record for this
      // worker, any status — the full-fidelity interleave (#108 item 1).
      escalationHistoryFor: () => [],
      // identityCheck(headers): the #151 gate — a refusal reason, or null to
      // admit. The default REFUSES: this is a security control, so an
      // unconfigured surface must fail closed rather than inherit the
      // tailnet-membership-only posture it exists to end. index.mjs injects the
      // real predicate; a test that wants the check out of its way says so.
      identityCheck: () => 'the timeline was constructed with no identity check',
      ...deps,
    }
    this.sessions = new Map() // name -> tail state
    this.server = null
    this.listening = false
    this.timer = null
  }

  #cfgDir(session) {
    return path.join(this.workspaceRoot, 'cfg', session)
  }

  // Bind the loopback listener. A port that will not bind (a foreign process
  // took it) leaves the surface down — verified:false — and reconcile's
  // assert() keeps the serve rule withdrawn rather than publishing whatever is
  // listening there (#70's rule: only a listener that is positively ours is
  // ever published; this one is ours by construction or it is not up at all).
  start() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.#handle(req, res).catch((e) => {
          this.log(`timeline request ${req.method} ${req.url} failed: ${e.message}`)
          if (res.writableEnded) return
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        })
      })
      server.once('error', (e) => {
        this.log(`WARNING: timeline surface could not bind 127.0.0.1:${this.port} (${e.message}) — the timeline is DOWN and will not be published`)
        this.deps.journal('timeline_bind_failed', { port: this.port, error: e.message })
        this.listening = false
        resolve({ verified: false })
      })
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server
        this.port = server.address().port // resolves port 0 (tests bind ephemerally)
        this.listening = true
        this.timer = setInterval(() => this.#tick(), this.pollMs)
        this.timer.unref?.()
        this.log(`timeline surface on http://127.0.0.1:${this.port}`)
        resolve({ verified: true })
      })
    })
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.server?.close()
    this.listening = false
  }

  // Reconcile hook, beside #assertAttachSurface and under its rules: the serve
  // rule is asserted only over a verified surface, and a refused one is
  // actively withdrawn — `tailscale serve --bg` config persists in tailscaled,
  // so skipping the assert alone would leave a previous run's rule publishing
  // a page nobody agreed to (or a foreign listener on our port).
  async assert() {
    const refusal = this.listening ? pageRefusal(this.index) : `the timeline listener on 127.0.0.1:${this.port} is not up`
    if (refusal) {
      this.deps.journal('timeline_surface_withdrawn', { reason: refusal })
      try {
        await this.deps.serveOff({ servePort: this.servePort, log: this.log })
        this.log(`WARNING: ${refusal} — timeline serve rule for :${this.servePort} withdrawn`)
      } catch (e) {
        this.log(`WARNING: ${refusal} — and withdrawing the timeline serve rule failed (${e.message}); if a rule for :${this.servePort} exists it REMAINS PUBLISHED tailnet-wide; run \`tailscale serve --https=${this.servePort} off\` by hand`)
      }
      return { verified: false }
    }
    await this.deps.assertServe({ servePort: this.servePort, targetPort: this.port })
    return { verified: true }
  }

  // The composed link (#54/#68's rule: every link a human gets comes from
  // curia's own records). Runs the same verification the reconcile assert
  // does, so a link is never handed out for a surface that would refuse.
  async link(session) {
    if (!validSessionName(session)) throw new Error(`"${session}" is not a valid curia session name`)
    const { verified } = await this.assert()
    if (verified === false) throw new Error(`the timeline surface is down — see the daemon log`)
    const base = await this.deps.attachBase()
    return `https://${base}:${this.servePort}/?session=${session}`
  }

  // ---------------------------------------------------------------------------
  // tailer: append-only transcript in, SSE out (spike shape + loud failures)
  // ---------------------------------------------------------------------------

  #state(name) {
    let s = this.sessions.get(name)
    if (!s) {
      s = {
        backend: null, file: null, offset: 0, rest: '', items: [],
        clients: new Set(), draft: '',
        parse: null, // { reason, file, dropped } — current loud failure, if any
        journalled: new Set(), // parse failures journalled once per file+reason
        escalations: '[]', // last broadcast snapshot, serialized
        escHistory: '[]', // last full-history snapshot, serialized (#108 item 1)
        dialog: null, // { hint } while a terminal dialog owns the pane (#75)
        dialogAt: 0, // last probe, for the throttle
        dialogProbing: false, // one in-flight capture at a time
      }
      this.sessions.set(name, s)
    }
    return s
  }

  #send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  #broadcast(s, event, data, except = null) {
    for (const c of s.clients) if (c.res !== except) this.#send(c.res, event, data)
  }

  // The one failure mode the ticket forbids: an unreadable transcript reading
  // as "the worker is quiet". Every unknown/malformed line lands here — once
  // per file+reason in the journal, permanently on the page banner until the
  // file rotates.
  #parseFailure(name, s, reason) {
    if (!s.parse || s.parse.reason !== reason) {
      s.parse = { reason, file: s.file, dropped: 0 }
    }
    s.parse.dropped += 1
    const key = `${s.file} ${reason}`
    if (!s.journalled.has(key)) {
      s.journalled.add(key)
      this.deps.journal('timeline_parse_failure', { session: name, file: s.file, reason })
      this.log(`timeline: cannot parse ${s.file} for ${name} (${reason}) — the page shows a warning, NOT silence`)
    }
    this.#broadcast(s, 'parse', s.parse)
  }

  #reset(s, file) {
    s.file = file
    s.offset = 0
    s.rest = ''
    s.items = []
    s.parse = null
    this.#broadcast(s, 'reset', { file })
  }

  #pump(name) {
    const s = this.#state(name)
    // The dispatcher's word wins; on-disk evidence covers sessions it never
    // spawned. Re-probed while null so a lane that appears later is picked up.
    if (!s.backend) s.backend = this.deps.backendFor(name)
    if (!s.backend) return
    const file = findTranscript(s.backend, this.#cfgDir(name))
    if (file !== s.file) {
      // A new run for this ticket: start over rather than splicing two
      // conversations together.
      this.#reset(s, file)
      if (!file) return
    }
    if (!s.file) return
    let st
    try { st = fs.statSync(s.file) } catch { return }
    if (st.size < s.offset) this.#reset(s, s.file) // truncated: same file, new run
    if (st.size === s.offset) return

    let buf
    try {
      const fd = fs.openSync(s.file, 'r')
      try {
        buf = Buffer.alloc(st.size - s.offset)
        fs.readSync(fd, buf, 0, buf.length, s.offset)
      } finally {
        fs.closeSync(fd)
      }
    } catch (e) {
      this.#parseFailure(name, s, `transcript read failed: ${e.message}`)
      return
    }
    s.offset = st.size

    const chunk = s.rest + buf.toString('utf8')
    const lines = chunk.split('\n')
    s.rest = lines.pop() ?? '' // a half-written line stays in the buffer
    const fresh = []
    for (const line of lines) {
      if (!line.trim()) continue
      const r = parseLine(s.backend, line)
      if (r.malformed) {
        this.#parseFailure(name, s, 'line is not JSON — the transcript format may have moved')
        continue
      }
      if (r.unknown) {
        this.#parseFailure(name, s, `unknown ${s.backend} line type "${r.unknown}" — the transcript format moved underneath the reader`)
        continue
      }
      for (const item of r.items) {
        item.seq = s.items.length
        s.items.push(item)
        fresh.push(item)
      }
    }
    if (fresh.length) this.#broadcast(s, 'items', fresh)
  }

  // Open escalations for the session, from the daemon's own record (#31). The
  // full open list goes out whenever it changes — open, answer, cancel,
  // supersede and nudge all just change the snapshot.
  #pumpEscalations(name) {
    const s = this.#state(name)
    const open = this.deps.escalationsFor(name).map((r) => ({
      id: r.id, kind: r.kind, prompt: r.prompt, options: r.options ?? null,
      preview_url: r.preview_url ?? null, opened_at: r.opened_at, nudges: r.nudges,
    }))
    const snapshot = JSON.stringify(open)
    if (snapshot !== s.escalations) {
      s.escalations = snapshot
      this.#broadcast(s, 'escalations', open)
    }
    // The full history, closed records included, from the daemon's own record
    // (#108 item 1): the page interleaves these with the transcript tail, so
    // an answered question keeps its full body, its answer and who gave it —
    // the transcript's tool line is a clipped brief on both lanes.
    const history = this.deps.escalationHistoryFor(name).map((r) => ({
      id: r.id, kind: r.kind, prompt: r.prompt, options: r.options ?? null,
      preview_url: r.preview_url ?? null, opened_at: r.opened_at,
      closed_at: r.closed_at ?? null, status: r.status,
      answer: r.answer ?? null, answered_by: r.answered_by ?? null,
      answered_via: r.answered_via ?? null, nudges: r.nudges,
    }))
    const hsnap = JSON.stringify(history)
    if (hsnap !== s.escHistory) {
      s.escHistory = hsnap
      this.#broadcast(s, 'esc_history', history)
    }
  }

  // The composer veto's regex, resolved through the same backend probe #pump
  // uses (the dispatcher's word, on-disk evidence as fallback).
  #composerRe(name, s) {
    if (!s.backend) s.backend = this.deps.backendFor(name)
    return s.backend ? this.deps.composerFor(s.backend) : null
  }

  #setDialog(name, s, dialog) {
    if ((s.dialog?.hint ?? null) === (dialog?.hint ?? null)) return
    s.dialog = dialog
    // Journalled on the rising edge: #75's incident had nothing to grep
    // anywhere, and the dialog's appearance is the first fact that went
    // unrecorded.
    if (dialog) this.deps.journal('timeline_dialog', { session: name, hint: dialog.hint })
    this.#broadcast(s, 'dialog', dialog ? { up: true, hint: dialog.hint } : { up: false })
  }

  // Fresh pane evidence for a write, and the banner state as a side effect. A
  // failed capture is NOT evidence (#33's rule, both directions): it neither
  // pins a dialog nor clears one — the last read that succeeded stands, so a
  // guard may still refuse on ≤2s-old knowledge, and a session nothing was
  // ever read from falls through to send-keys, whose own failure is louder
  // than a guess here would be.
  async #probeDialog(name, s) {
    try {
      const pane = await this.deps.capturePane(name)
      this.#setDialog(name, s, detectDialog(pane, this.#composerRe(name, s)))
    } catch { /* indeterminate — keep the last known state */ }
    return s.dialog
  }

  #pumpDialog(name, s) {
    const now = Date.now()
    if (s.dialogProbing || now - s.dialogAt < this.dialogProbeMs) return
    s.dialogProbing = true
    s.dialogAt = now
    this.#probeDialog(name, s).finally(() => { s.dialogProbing = false })
  }

  #tick() {
    for (const [name, s] of this.sessions) {
      if (!s.clients.size) continue // nobody watching; the file is replayable later
      try {
        this.#pump(name)
        this.#pumpEscalations(name)
        this.#pumpDialog(name, s)
      } catch (e) {
        this.log(`timeline pump ${name} failed: ${e.message}`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  async #handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`)
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    // The #151 identity check, ahead of everything including the page itself:
    // a caller who may not drive this worker may not read its transcript
    // either. Journalled so a refusal is one grep away, the same way the
    // terminal surface's proxy records its own.
    const refused = this.deps.identityCheck(req.headers)
    if (refused) {
      this.deps.journal('timeline_identity_refused', {
        reason: refused,
        path: url.pathname,
        host: req.headers.host ?? null,
      })
      this.log(`timeline: REFUSED ${req.method} ${url.pathname} — ${refused}`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(`curia refused this request: ${refused}\n`)
    }

    // ttyd's -O by hand (see the module header for what that does and does
    // not buy). Writes only — an SSE GET carries no side effect.
    if (req.method === 'POST') {
      const origin = req.headers.origin
      let originHost = null
      if (origin) {
        try { originHost = new URL(origin).host } catch { originHost = '' }
      }
      if (originHost !== null && originHost !== req.headers.host) {
        return json(403, { error: 'cross-origin refused' })
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Re-read per request with no-store: the served bytes are always the
      // committed file, and a refusal here is the same refusal reconcile
      // withdraws the serve rule for — a request racing that withdrawal gets
      // the loud page, not the stale one.
      const refusal = pageRefusal(this.index)
      if (refusal) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(`timeline surface refused: ${refusal}\n`)
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(fs.readFileSync(this.index))
    }

    const session = url.searchParams.get('session') ?? ''

    if (url.pathname === '/events') {
      if (!validSessionName(session)) return json(400, { error: `"${session}" is not a curia session name` })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const s = this.#state(session)
      // Pump BEFORE this client joins the broadcast set, or the first tick's
      // items reach it once as a broadcast and once again in the backlog.
      try { this.#pump(session) } catch { /* first pump may race the session's creation */ }
      const client = { res, id: url.searchParams.get('client') ?? String(Math.random()) }
      s.clients.add(client)
      // A late joiner replays the whole run for free: the backlog problem a
      // broker has to solve is solved by the file being a file (#72).
      this.#send(res, 'hello', { session, file: s.file, backend: s.backend, clients: s.clients.size, draft: s.draft })
      if (s.items.length) this.#send(res, 'items', s.items)
      if (s.parse) this.#send(res, 'parse', s.parse)
      if (s.dialog) this.#send(res, 'dialog', { up: true, hint: s.dialog.hint })
      this.#send(res, 'escalations', JSON.parse(s.escalations))
      this.#send(res, 'esc_history', JSON.parse(s.escHistory))
      this.#pumpEscalations(session)
      this.#broadcast(s, 'clients', { clients: s.clients.size })
      // `once` closes the stream after the backlog — a page holding an open
      // SSE never finishes loading, so a headless check could never draw it.
      if (url.searchParams.get('once')) {
        s.clients.delete(client)
        return res.end()
      }
      const ka = setInterval(() => res.write(': ka\n\n'), 15000)
      req.on('close', () => {
        clearInterval(ka)
        s.clients.delete(client)
        this.#broadcast(s, 'clients', { clients: s.clients.size })
      })
      return
    }

    if (url.pathname === '/send' && req.method === 'POST') {
      const b = await readBody(req)
      if (!validSessionName(String(b.session ?? ''))) return json(400, { error: 'bad session' })
      const text = String(b.text ?? '')
      if (!text.trim()) return json(400, { error: 'empty' })
      const s = this.#state(b.session)
      const by = b.client ?? null
      // The #75 guard: fresh capture, positive evidence only. Typing into a
      // dialog answers it blind or vanishes without a trace — refusing keeps
      // the text in the composer, and the broadcast pins the banner on every
      // device at the same moment.
      const dialog = await this.#probeDialog(b.session, s)
      if (dialog) {
        this.deps.journal('timeline_send', { session: b.session, by, outcome: 'refused_dialog', hint: dialog.hint, text: clip(text) })
        return json(409, { error: `the worker is in a terminal dialog ("${dialog.hint}") the timeline cannot show — open the terminal surface to answer it; your text was NOT sent`, dialog: true })
      }
      try {
        await this.deps.sendText(b.session, text)
      } catch (e) {
        this.deps.journal('timeline_send', { session: b.session, by, outcome: 'failed', error: e.message, text: clip(text) })
        return json(502, { error: e.message })
      }
      // The journal line #75 had to infer from four absences: whether the
      // send even fired, one grep away.
      this.deps.journal('timeline_send', { session: b.session, by, outcome: 'sent', text: clip(text) })
      s.draft = ''
      this.#broadcast(s, 'draft', { text: '', by })
      this.#broadcast(s, 'sent', { text, by })
      return json(200, { ok: true })
    }

    // The shared composer (#73 pass-bar item 4): tmux gives two attached
    // clients ONE composer because they share a grid; here it is an explicit
    // broadcast, the one behavior with no upstream to inherit.
    if (url.pathname === '/draft' && req.method === 'POST') {
      const b = await readBody(req)
      if (!validSessionName(String(b.session ?? ''))) return json(400, { error: 'bad session' })
      const s = this.#state(b.session)
      s.draft = String(b.text ?? '')
      this.#broadcast(s, 'draft', { text: s.draft, by: b.client ?? null })
      return json(200, { ok: true })
    }

    // The one thing a grid-less surface cannot do is send a key; interrupting
    // a turn is the key that matters.
    if (url.pathname === '/key' && req.method === 'POST') {
      const b = await readBody(req)
      if (!validSessionName(String(b.session ?? ''))) return json(400, { error: 'bad session' })
      const key = KEYS[String(b.key ?? '').toLowerCase()]
      if (!key) return json(400, { error: 'unknown key' })
      const s = this.#state(b.session)
      const by = b.client ?? null
      if (!DIALOG_SAFE_KEYS.has(key)) {
        const dialog = await this.#probeDialog(b.session, s)
        if (dialog) {
          this.deps.journal('timeline_key', { session: b.session, by, key, outcome: 'refused_dialog', hint: dialog.hint })
          return json(409, { error: `the worker is in a terminal dialog ("${dialog.hint}") — ${key} would drive its selection blind; open the terminal surface`, dialog: true })
        }
      }
      try {
        await this.deps.sendKey(b.session, key)
      } catch (e) {
        this.deps.journal('timeline_key', { session: b.session, by, key, outcome: 'failed', error: e.message })
        return json(502, { error: e.message })
      }
      this.deps.journal('timeline_key', { session: b.session, by, key, outcome: 'sent' })
      this.#broadcast(s, 'sent', { text: `⌨ ${key}`, by })
      return json(200, { ok: true })
    }

    json(404, { error: 'not found' })
  }
}
