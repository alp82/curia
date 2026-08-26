// The timeline attach surface (#74, landing #73's pick): read an agent by
// tailing its own transcript, write to it with `tmux send-keys` — no terminal
// parsed, no pane resized, so a phone and a desktop each lay the same run out
// at their own width and both drive the same live turn (#72's division of
// labor: the timeline is where you drive; the PTY is where you go when you
// need to see the terminal itself).
//
// The daemon hosts this in-process rather than as a child: the surface then
// dies with the daemon (no orphan process to sweep — #19's lesson pre-empted),
// and it reads two things only the daemon has — the dispatcher's word on which
// harness a session runs, and the durable escalation record. The record
// matters because of #74's own measurement: the claude harness writes NOTHING to
// its transcript while an ask_human blocks (the tool_use line is flushed only
// with the result), so a timeline that reads the transcript alone is silent
// through every escalation — precisely when a human most needs to see one.
// Open escalations for the session are therefore overlaid from the reduction on
// both harnesses (the codex harness shows the call natively; the overlay adds the
// answer-surface state either way).
//
// THE DRIVEN SESSION (#267). Every session here was a tmux pane until the
// console chat: read a transcript under the workspace, write with send-keys.
// The chat is the OVERSEER, which has neither — it keeps its transcript in the
// daemon's data dir and it takes words as a turn. So a session may carry a
// DRIVER that names both, and the surface stays one surface: the same page,
// the same SSE, the same composer, the same escalation overlay. That is what
// "no second chat surface" costs — one seam, not a second server.
//
// IDENTITY (#151 — the deferral #74 item 6 restated is now CLOSED). Every
// request, read and write alike, must carry a `Tailscale-User-Login` on the
// allowlist and a Host this box actually serves (identity.mjs holds the
// predicate and the evidence behind it). Reads are gated too, not only writes:
// the transcript IS the sensitive thing here — a read-only caller still gets
// every line the agent has produced.
//
// The Origin-must-equal-Host check below stays where it was, unchanged. It is
// no longer load-bearing on its own — a non-browser client forges Origin
// trivially — but it costs nothing and it is the one control that survives if
// the identity check is ever misconfigured wide.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertServe, serveOff, attachBase, atlasChatUrl, validSessionName } from './attach.mjs'
import { paneTail } from './dispatch.mjs'
import { sendText, sendKey, sendDialogOption, capturePane } from './tmux.mjs'
import { detectHarness, findTranscript, transcriptForSession, readActiveTranscript } from './transcript.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// The card fields every answer surface renders from one payload (#712,
// ADR-0025): the per-option handle for a short control, whether the card is
// typed (letters mark its options; an untyped card counts), whether a round
// carries the one ✅ tap, and the directory a reply file lands in. The wire on
// Home carries the same four, composed by index.mjs.
export function cardFields(r, deps = {}) {
  return {
    option_handles: r.payload?.options?.map((option, index) => String(option?.handle ?? r.options?.[index] ?? '')) ?? null,
    typed: Boolean(r.payload),
    recommended: Boolean(r.recommended),
    files_dir: deps.filesDirFor?.(r.id) ?? null,
  }
}

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
export const TIMELINE_PROTO = 4
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
// with no trace on the page, the agent, or the journal). #715 keeps this guard
// and adds cards only for daemon-parsed dialog families with passing harness
// integration checks. Everything else stays terminal-only.
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
// composer, so its per-harness ready marker (#39) and a real dialog never
// share a tail; a footer phrase that scrolled by in agent output does.
export const DIALOG_MARKERS = [
  /Enter to [^·\n]{1,60}·/, // "Enter to <verb> …" joined to more chrome by a middot
  /↑\/↓ to navigate/, // belt and braces should the select footer reword its verb
  // The codex spelling, captured live on #176 (trust prompt and /model picker):
  //   "Press enter to continue"
  //   "Press enter to confirm or esc to go back"
  // No middot and no arrows, so neither claude marker sees it. Same veto
  // applies: both captures replace the composer AND the status footer, so the
  // codex ready marker ("· <cwd>") and a real dialog never share a tail.
  /Press enter to [^\n]{1,60}/,
]

export function detectDialog(pane, composerRe = null) {
  const tail = paneTail(pane)
  const hit = DIALOG_MARKERS.map((re) => re.exec(tail)?.[0]).find(Boolean)
  if (!hit) return null
  if (composerRe && composerRe.test(tail)) return null
  return { hint: hit.trim().replace(/·$/, '').trim() }
}

const DIALOG_OPTION_RE = /^\s*([❯›>]?)[ \t]*(?:([☐☑])\s*)?(\d+)[.)]\s+(.+?)\s*$/
const DIALOG_CHROME_RE = /^(?:[-─═]+|Enter to |Press enter to |↑\/↓ to navigate)/i
const FREE_TEXT_OPTION_RE = /^(?:type something|other)(?:\.|…)?$/i
const DIALOG_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// Native dialogs are untrusted pane text. This parser runs only after the
// narrow footer and composer checks in detectDialog. It emits the same choice
// payload shape Chat uses for a Curia card. Unsupported dialog families keep
// the terminal guard and expose no answer controls.
export function parseNativeDialog(pane, harness, composerRe = null) {
  const detected = detectDialog(pane, composerRe)
  if (!detected) return null

  const tail = paneTail(pane)
  const rows = tail.split('\n')
  const parsed = rows.map((row, rowIndex) => {
    const match = DIALOG_OPTION_RE.exec(row)
    if (!match) return null
    return {
      rowIndex,
      selected: Boolean(match[1]),
      multiSelect: Boolean(match[2]),
      index: Number(match[3]),
      label: match[4].trim(),
    }
  }).filter(Boolean)

  const base = { hint: detected.hint, card: null }
  if (!['claude', 'codex'].includes(harness)) {
    return { ...base, reason: `the ${harness || 'unknown'} harness has no passing native dialog integration check` }
  }
  if (!parsed.length) {
    return { ...base, reason: `curia could not parse options from the native ${harness} dialog` }
  }
  if (parsed.some((option) => option.multiSelect || FREE_TEXT_OPTION_RE.test(option.label))) {
    return { ...base, reason: 'the Claude multiSelect free-text path has no passing integration check' }
  }
  const selected = parsed.filter((option) => option.selected)
  if (selected.length !== 1) {
    return { ...base, reason: `curia could not measure the selected option in the native ${harness} dialog` }
  }

  const firstOption = parsed[0].rowIndex
  const headline = rows.slice(0, firstOption)
    .map((row) => row.trim().replace(/^>\s*/, ''))
    .filter((row) => row && !DIALOG_CHROME_RE.test(row) && !/^You are in\s/i.test(row))
    .at(-1) ?? `Native ${harness} dialog`
  const options = parsed.map((option, offset) => ({
    index: option.index,
    marker: offset < DIALOG_LETTERS.length ? DIALOG_LETTERS[offset] : String(offset + 1),
    label: option.label,
    handle: option.label,
  }))
  const key = JSON.stringify({ harness, headline, options: options.map(({ index, label }) => ({ index, label })) })
  return {
    hint: detected.hint,
    key,
    card: {
      kind: 'choice',
      headline,
      options,
      selected_index: selected[0].index,
    },
  }
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
  constructor({
    port, servePort, index, workspaceRoot, atlasServePort = null,
    log = console.log, pollMs = 600, dialogProbeMs = 2000, deps = {},
  }) {
    this.port = port
    // The port the LEGACY rule published this surface on. #711 retired that
    // rule: Atlas reaches this listener over loopback through the sidecar,
    // and the port is kept only so reconcile can keep withdrawing what an
    // older daemon left in tailscaled.
    this.servePort = servePort
    // Where Atlas is published. Every chat link composes against it now.
    this.atlasServePort = atlasServePort
    this.retired = false
    this.index = index
    this.workspaceRoot = workspaceRoot
    this.log = log
    this.pollMs = pollMs
    // The dialog probe is a tmux exec per watched session, so it runs at the
    // watchdog's cadence (#33), not the transcript tick's.
    this.dialogProbeMs = dialogProbeMs
    this.deps = {
      assertServe, serveOff, attachBase, sendText, sendKey, capturePane,
      answerDialog: sendDialogOption,
      // composerFor(harness): the per-harness ready regex (#39) — the veto in
      // detectDialog. Null skips the veto, never the marker match.
      composerFor: () => null,
      // journal(type, detail): `Reduction#journal`, injected by index.mjs.
      journal: () => {},
      // harnessFor(session): the dispatcher's word, with detectHarness as the
      // on-disk fallback for re-adopted and lab sessions.
      harnessFor: (session) => detectHarness(this.#cfgDir(session)),
      // driverFor(session): the #267 seam. Every session until now was a tmux
      // pane, so the surface could read one config dir and write with
      // send-keys. The console chat is the overseer, which has neither: it
      // keeps its transcript in the daemon's own data dir and it takes words as
      // a TURN rather than as keystrokes. A driver names both, and a session
      // with no driver is a pane exactly as before.
      //
      // `sessionId` is the live session id of the conversation this driver
      // serves, read from the daemon's journal at call time (#332). It is what
      // names the transcript file: many conversations share the driver's config
      // dir, so nothing else can tell them apart. Null while the conversation
      // has taken no turn.
      //   { cfgDir, sessionId, send(text) -> Promise, harness? }
      driverFor: () => null,
      // escalationsFor(session): open escalation records for this agent.
      escalationsFor: () => [],
      // escalationHistoryFor(session): every escalation record for this
      // agent, any status — the full-fidelity interleave (#108 item 1).
      escalationHistoryFor: () => [],
      // landingFor(session): the parent identity saved with a take-back
      // receipt. It temporarily replaces the transcript tail until the next
      // message records the fork. Agent and overseer sessions use this seam.
      landingFor: () => null,
      // takeBack(request): the shared pane runtime. The surface supplies the
      // active transcript and returns its composer draft and receipt unchanged.
      takeBack: null,
      // correct(request): sends edited text with Curia's correction framing.
      correct: null,
      // recordTurn(request): binds queued note drains to this operator turn.
      recordTurn: null,
      // sessionAlive(session): does a pane still run for this session (#711).
      // Null skips the check. A session that has ended keeps its transcript
      // readable and refuses new input with a sentence, rather than handing
      // the words to tmux and reporting whatever tmux says about a session
      // that is gone.
      sessionAlive: null,
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

  // Has this session's pane ended (#711)? Only a pane can end this way; a
  // driven conversation parks and returns. An unanswerable probe is not
  // evidence, and reads as alive: the send path's own failure is louder than
  // a guess here would be.
  async #ended(session) {
    if (this.#driver(session) || !this.deps.sessionAlive) return false
    try { return !(await this.deps.sessionAlive(session)) } catch { return false }
  }

  #endedRefusal(session) {
    return { error: `${session} has ended. Its transcript stays readable here, and it takes no new message.`, ended: true }
  }

  // A driven session (#267) or a pane. Read per call rather than cached: the
  // set is fixed at construction, so this is a map lookup either way.
  #driver(session) {
    return this.deps.driverFor(session) ?? null
  }

  #cfgDir(session) {
    return this.#driver(session)?.cfgDir ?? path.join(this.workspaceRoot, 'cfg', session)
  }

  // Where this session's transcript is (#332, building ADR-0016).
  //
  // A PANE gets a config dir of its own, so the newest file in it is that
  // agent's run. A DRIVEN session is a CONVERSATION, and every conversation
  // writes into ONE config dir — so newest-by-mtime there shows whichever
  // conversation answered last, and one Discord turn hides the browser chat.
  // A conversation is found by the session id its key is bound to. A key with
  // no session id yet has no transcript, and an empty screen is the right
  // answer: another conversation's words are not a fallback.
  #transcript(session, harness) {
    const driver = this.#driver(session)
    if (driver) return transcriptForSession(harness, this.#cfgDir(session), driver.sessionId ?? null)
    return findTranscript(harness, this.#cfgDir(session))
  }

  // The dispatcher's word is about agents it spawned, and it spawned no driven
  // session — so a driver answers from its own config dir instead.
  #harnessFor(session) {
    const driver = this.#driver(session)
    if (driver) return driver.harness ?? detectHarness(this.#cfgDir(session))
    return this.deps.harnessFor(session)
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

  // Reconcile hook, beside #assertAttachSurface. Since #711 the hook PUBLISHES
  // NOTHING: the Chat surface is the Atlas page, and the sidecar pipes its
  // routes to this listener over loopback. What the hook still does is
  // withdraw the legacy rule — `tailscale serve --bg` config persists in
  // tailscaled, so a daemon that skipped this would leave a previous run's
  // rule publishing the retired page tailnet-wide.
  async assert() {
    if (!this.listening) {
      this.deps.journal('timeline_surface_withdrawn', { reason: `the timeline listener on 127.0.0.1:${this.port} is not up` })
      return { verified: false }
    }
    if (!this.retired) {
      try {
        await this.deps.serveOff({ servePort: this.servePort, log: this.log })
        this.retired = true
        this.deps.journal('timeline_serve_retired', { serve_port: this.servePort })
      } catch (e) {
        this.log(`WARNING: withdrawing the retired timeline serve rule failed (${e.message}); if a rule for :${this.servePort} exists it REMAINS PUBLISHED tailnet-wide; run \`tailscale serve --https=${this.servePort} off\` by hand`)
      }
    }
    return { verified: true }
  }

  // The composed link (#54/#68's rule: every link a human gets comes from
  // curia's own records). It lands on the Atlas Chat route (#711), and it is
  // refused while this listener is down, because that route reads through it.
  async link(session) {
    if (!validSessionName(session)) throw new Error(`"${session}" is not a valid curia session name`)
    const { verified } = await this.assert()
    if (verified === false) throw new Error(`the timeline surface is down — see the daemon log`)
    if (!this.atlasServePort) throw new Error('the timeline was constructed with no Atlas serve port, so it cannot compose a chat link')
    const base = await this.deps.attachBase()
    return atlasChatUrl(base, this.atlasServePort, session)
  }

  // ---------------------------------------------------------------------------
  // tailer: append-only transcript in, SSE out (spike shape + loud failures)
  // ---------------------------------------------------------------------------

  #state(name) {
    let s = this.sessions.get(name)
    if (!s) {
      s = {
        harness: null, file: null, offset: 0, rest: '', lines: [], items: [],
        activeKey: null, activeFailures: new Set(),
        clients: new Set(), draft: '',
        correction: null,
        parse: null, // { reason, file, dropped } — current loud failure, if any
        journalled: new Set(), // parse failures journalled once per file+reason
        parseFailures: new Set(), // line-keyed failures already counted for this file
        escalations: '[]', // last broadcast snapshot, serialized
        escHistory: '[]', // last full-history snapshot, serialized (#108 item 1)
        dialog: null, // daemon-parsed native dialog while one owns the pane
        dialogSeq: 0,
        dialogAnswer: null, // id claimed synchronously by the first valid tap
        dialogReceipt: null, // one outcome replayed to every Chat client
        dialogAnsweredKey: null, // suppresses one stale TUI repaint after Enter
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
  // as "the agent is quiet". Every unknown/malformed line lands here — once
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
    s.lines = []
    s.items = []
    s.activeKey = null
    s.activeFailures = new Set()
    s.parse = null
    s.parseFailures.clear()
    this.#broadcast(s, 'reset', { file })
  }

  #publishActive(name, s) {
    const landing = this.deps.landingFor(name)
    const landingUuid = typeof landing === 'string' ? landing : landing?.uuid ?? null
    const landingTailUuid = typeof landing === 'string' ? null : landing?.tailUuid ?? null
    const key = `${s.lines.length}\0${landingUuid ?? ''}\0${landingTailUuid ?? ''}`
    if (key === s.activeKey) return
    s.activeKey = key

    const read = readActiveTranscript(s.harness, s.lines, { landingUuid, landingTailUuid })
    for (const reason of read.failures) {
      if (s.activeFailures.has(reason)) continue
      s.activeFailures.add(reason)
      this.#parseFailure(name, s, reason)
    }

    const next = read.items.map((item, seq) => ({ ...item, seq }))
    const prefix = s.items.length <= next.length
      && s.items.every((item, i) => JSON.stringify(item) === JSON.stringify(next[i]))
    if (!prefix) this.#broadcast(s, 'reset', { file: s.file, branch: true })
    const fresh = prefix ? next.slice(s.items.length) : next
    s.items = next
    if (fresh.length) this.#broadcast(s, 'items', fresh)
  }

  #pump(name) {
    const s = this.#state(name)
    // The dispatcher's word wins; on-disk evidence covers sessions it never
    // spawned. Re-probed while null so a harness that appears later is picked up.
    if (!s.harness) s.harness = this.#harnessFor(name)
    if (!s.harness) return
    const file = this.#transcript(name, s.harness)
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
    if (st.size === s.offset) return this.#publishActive(name, s)

    if (st.size !== s.offset) {
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
      s.rest = lines.pop() ?? '' // a half-written line waits for the next read
      s.lines.push(...lines)
    }
    this.#publishActive(name, s)
  }

  // Open escalations for the session, from the daemon's own record (#31). The
  // full open list goes out whenever it changes — open, answer, cancel,
  // supersede and nudge all just change the snapshot.
  #pumpEscalations(name) {
    const s = this.#state(name)
    // The typed-card fields ride here too (#712): the Chat room draws the
    // same card Home and Discord draw, so it needs the handles, whether the
    // markers are letters, the round's one tap, and where a reply file lands.
    const open = this.deps.escalationsFor(name).map((r) => ({
      id: r.id, kind: r.kind, prompt: r.prompt, options: r.options ?? null,
      ...cardFields(r, this.deps),
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
    // the transcript's tool line is a clipped brief on both harnesses.
    const history = this.deps.escalationHistoryFor(name).map((r) => ({
      id: r.id, kind: r.kind, prompt: r.prompt, options: r.options ?? null,
      ...cardFields(r, this.deps),
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

  // The composer veto's regex, resolved through the same harness probe #pump
  // uses (the dispatcher's word, on-disk evidence as fallback).
  #composerRe(name, s) {
    if (!s.harness) s.harness = this.#harnessFor(name)
    return s.harness ? this.deps.composerFor(s.harness) : null
  }

  #dialogPayload(dialog) {
    if (!dialog) return { up: false }
    return {
      up: true,
      hint: dialog.hint,
      reason: dialog.reason ?? null,
      card: dialog.card ? { ...dialog.card, id: dialog.id } : null,
    }
  }

  #setDialog(name, s, dialog, receipt = null) {
    if (!dialog) {
      if (!s.dialog && !receipt) return
      s.dialog = null
      s.dialogAnswer = null
      if (receipt) s.dialogReceipt = receipt
      this.#broadcast(s, 'dialog', { up: false, ...(receipt ? { receipt } : {}) })
      return
    }

    const semanticKey = dialog.key ?? `guard:${dialog.hint}:${dialog.reason ?? ''}`
    const sameDialog = s.dialog?.semanticKey === semanticKey
    const next = {
      ...dialog,
      semanticKey,
      id: sameDialog ? s.dialog.id : `native-${++s.dialogSeq}`,
    }
    if (sameDialog && JSON.stringify(this.#dialogPayload(s.dialog)) === JSON.stringify(this.#dialogPayload(next))) return
    s.dialog = next
    if (!sameDialog) {
      s.dialogAnswer = null
      s.dialogReceipt = null
    }
    // Journalled on the rising edge: #75's incident had nothing to grep
    // anywhere, and the dialog's appearance is the first fact that went
    // unrecorded.
    if (!sameDialog) {
      this.deps.journal('timeline_dialog', {
        session: name,
        hint: next.hint,
        card: next.card?.kind ?? null,
        parse_failure: next.reason ?? null,
      })
    }
    this.#broadcast(s, 'dialog', this.#dialogPayload(next))
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
      const parsed = parseNativeDialog(pane, s.harness, this.#composerRe(name, s))
      const semanticKey = parsed?.key ?? (parsed ? `guard:${parsed.hint}:${parsed.reason ?? ''}` : null)
      if (semanticKey && semanticKey === s.dialogAnsweredKey) return s.dialog
      if (!semanticKey || semanticKey !== s.dialogAnsweredKey) s.dialogAnsweredKey = null
      this.#setDialog(name, s, parsed)
    } catch { /* indeterminate — keep the last known state */ }
    return s.dialog
  }

  #pumpDialog(name, s) {
    // A driven session has no pane to capture, so there is no dialog it could
    // ever be in (#267). Probing one would ask tmux about a session that does
    // not exist and read the failure as "indeterminate" forever.
    if (this.#driver(name)) return
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
    // a caller who may not drive this agent may not read its transcript
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
      // The dialog event is daemon-parsed and belongs in the initial SSE
      // reading. A phone opening Chat must not wait for the background probe
      // before it learns that a card or terminal guard owns the composer.
      if (!this.#driver(session)) await this.#probeDialog(session, s)
      const client = { res, id: url.searchParams.get('client') ?? String(Math.random()) }
      s.clients.add(client)
      // A late joiner replays the whole run for free: the backlog problem a
      // broker has to solve is solved by the file being a file (#72).
      // `ended` is the pane's word (#711): a session no pane runs for stays
      // readable and takes no new message. A driven conversation is never
      // ended this way — a parked pane returns on its next message, and the
      // page must not show it as anything but a conversation.
      const ended = await this.#ended(session)
      this.#send(res, 'hello', { session, file: s.file, harness: s.harness, clients: s.clients.size, draft: s.draft, ended })
      if (s.items.length) this.#send(res, 'items', s.items)
      if (s.parse) this.#send(res, 'parse', s.parse)
      if (s.dialog) this.#send(res, 'dialog', this.#dialogPayload(s.dialog))
      else if (s.dialogReceipt) this.#send(res, 'dialog', { up: false, receipt: s.dialogReceipt })
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

    if (url.pathname === '/take-back' && req.method === 'POST') {
      const b = await readBody(req)
      if (!validSessionName(String(b.session ?? ''))) return json(400, { error: 'bad session' })
      if (!this.deps.takeBack) return json(501, { error: 'message take back is not configured' })
      const s = this.#state(b.session)
      try { this.#pump(b.session) } catch { /* the runtime reports transcript failures */ }
      try {
        const result = await this.deps.takeBack({
          session: b.session,
          role: this.#driver(b.session) ? 'overseer' : 'agent',
          harness: s.harness,
          source: s.lines.join('\n'),
          landing: this.deps.landingFor(b.session),
          target: b.target ?? null,
        })
        s.draft = result.composer ?? ''
        s.correction = result.correction?.kind === 'note' ? result.correction : null
        this.#broadcast(s, 'draft', { text: s.draft, by: b.client ?? null })
        return json(200, result)
      } catch (e) {
        return json(e.status ?? 502, { error: e.message })
      }
    }

    if (url.pathname === '/dialog-answer' && req.method === 'POST') {
      const b = await readBody(req)
      if (!validSessionName(String(b.session ?? ''))) return json(400, { error: 'bad session' })
      const s = this.#state(b.session)
      const dialogId = String(b.dialog ?? '')
      const targetIndex = Number(b.index)

      if (s.dialogReceipt?.dialog === dialogId) {
        return json(409, { error: 'this native dialog already has an answer', receipt: s.dialogReceipt })
      }
      const dialog = await this.#probeDialog(b.session, s)
      if (!dialog?.card) {
        return json(409, {
          error: `${dialog?.reason ?? 'curia could not parse this native dialog'}; open the terminal to answer it`,
          terminal: `/terminal/?arg=${encodeURIComponent(b.session)}`,
        })
      }
      if (!dialogId || dialog.id !== dialogId) {
        return json(409, { error: 'this native dialog changed; use the current card' })
      }
      if (!Number.isInteger(targetIndex)) return json(400, { error: 'the option index must be an integer' })
      const option = dialog.card.options.find((candidate) => candidate.index === targetIndex)
      if (!option) return json(400, { error: 'that option index is not on this native dialog' })
      if (s.dialogAnswer === dialogId) {
        return json(409, { error: 'the first valid native dialog answer is still being sent' })
      }

      // Claim before the first await. Two Chat clients can tap the same card
      // together, and only one may reach tmux.
      s.dialogAnswer = dialogId
      try {
        await this.deps.answerDialog(b.session, {
          currentIndex: dialog.card.selected_index,
          targetIndex,
          harness: s.harness,
        })
      } catch (error) {
        s.dialogAnswer = null
        this.deps.journal('native_dialog_answer_failed', {
          session: b.session, dialog: dialogId, index: targetIndex, error: error.message,
        })
        return json(502, { error: `curia could not answer the native dialog: ${error.message}` })
      }

      const receipt = {
        dialog: dialogId,
        index: targetIndex,
        marker: option.marker,
        answer: option.label,
        by: String(b.client ?? 'atlas'),
        at: new Date().toISOString(),
      }
      this.deps.journal('native_dialog_answered', {
        session: b.session, dialog: dialogId, index: targetIndex,
        answer: option.label, by: receipt.by, harness: s.harness,
      })
      s.dialogAnsweredKey = dialog.semanticKey
      this.#setDialog(b.session, s, null, receipt)
      return json(200, { ok: true, receipt })
    }

    if (url.pathname === '/send' && req.method === 'POST') {
      const b = await readBody(req)
      if (!validSessionName(String(b.session ?? ''))) return json(400, { error: 'bad session' })
      const text = String(b.text ?? '')
      if (!text.trim()) return json(400, { error: 'empty' })
      const s = this.#state(b.session)
      const by = b.client ?? null
      if (s.correction) {
        if (!this.deps.correct) return json(501, { error: 'message correction is not configured' })
        try {
          await this.deps.correct({
            session: b.session,
            role: this.#driver(b.session) ? 'overseer' : 'agent',
            correction: s.correction,
            text,
          })
        } catch (e) {
          return json(e.status ?? 502, { error: e.message })
        }
        this.deps.journal('timeline_send', {
          session: b.session, by, outcome: 'corrected', target: s.correction.id, text: clip(text),
        })
        s.correction = null
        s.draft = ''
        this.#broadcast(s, 'draft', { text: '', by })
        this.#broadcast(s, 'sent', { text, by })
        return json(200, { ok: true })
      }
      // A driven session takes the words as a TURN (#267). There is no pane, so
      // the #75 dialog guard has nothing to guard: it exists because keystrokes
      // land wherever the pane's focus is, and a turn lands in exactly one
      // place. The call runs to completion — an overseer turn is seconds, and
      // the failure is the whole reason this waits: a turn that ends with no
      // answer must reach the operator as words, not as silence on the page.
      const driver = this.#driver(b.session)
      if (driver) {
        try {
          await driver.send(text)
        } catch (e) {
          this.deps.journal('timeline_send', { session: b.session, by, outcome: 'failed', error: e.message, text: clip(text) })
          return json(502, { error: e.message })
        }
        this.deps.recordTurn?.({ session: b.session, role: 'overseer', text })
        this.deps.journal('timeline_send', { session: b.session, by, outcome: 'sent', text: clip(text) })
        s.draft = ''
        this.#broadcast(s, 'draft', { text: '', by })
        this.#broadcast(s, 'sent', { text, by })
        return json(200, { ok: true })
      }
      // A pane that has ended takes no words (#711). The refusal is a sentence
      // about the session, not a tmux error about a missing one.
      if (await this.#ended(b.session)) {
        this.deps.journal('timeline_send', { session: b.session, by, outcome: 'refused_ended', text: clip(text) })
        return json(409, this.#endedRefusal(b.session))
      }
      // The #75 guard: fresh capture, positive evidence only. Typing into a
      // dialog answers it blind or vanishes without a trace — refusing keeps
      // the text in the composer, and the broadcast pins the banner on every
      // device at the same moment.
      const dialog = await this.#probeDialog(b.session, s)
      if (dialog) {
        this.deps.journal('timeline_send', { session: b.session, by, outcome: 'refused_dialog', hint: dialog.hint, text: clip(text) })
        return json(409, { error: `the agent is in a terminal dialog ("${dialog.hint}") the timeline cannot show — open the terminal surface to answer it; your text was NOT sent`, dialog: true })
      }
      try {
        const delivery = await this.deps.sendText(b.session, text)
        if (delivery?.status === 'not-sent') {
          this.deps.journal('timeline_send', { session: b.session, by, outcome: 'not_sent', text: clip(text) })
          return json(409, { error: 'the pane stayed active, so curia did not send the text' })
        }
        if (delivery?.status === 'unconfirmed') {
          this.deps.recordTurn?.({ session: b.session, role: 'agent', text })
          this.deps.journal('timeline_send', { session: b.session, by, outcome: 'unconfirmed', text: clip(text) })
          s.draft = ''
          this.#broadcast(s, 'draft', { text: '', by })
          return json(202, { error: 'curia sent the keys, but the pane did not confirm a new turn', unconfirmed: true })
        }
      } catch (e) {
        this.deps.journal('timeline_send', { session: b.session, by, outcome: 'failed', error: e.message, text: clip(text) })
        return json(502, { error: e.message })
      }
      this.deps.recordTurn?.({ session: b.session, role: 'agent', text })
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
      // No pane, no keys (#267). This is the one thing the console chat cannot
      // do, and it says so rather than reporting a key nothing received: an
      // overseer turn runs to its end, so there is nothing here to interrupt.
      if (this.#driver(b.session)) {
        this.deps.journal('timeline_key', { session: b.session, by, key, outcome: 'refused_no_pane' })
        return json(409, { error: `${b.session} is not a terminal — it takes words, and a turn runs to its end, so there is no key to send it` })
      }
      if (await this.#ended(b.session)) {
        this.deps.journal('timeline_key', { session: b.session, by, key, outcome: 'refused_ended' })
        return json(409, this.#endedRefusal(b.session))
      }
      if (!DIALOG_SAFE_KEYS.has(key)) {
        const dialog = await this.#probeDialog(b.session, s)
        if (dialog) {
          this.deps.journal('timeline_key', { session: b.session, by, key, outcome: 'refused_dialog', hint: dialog.hint })
          return json(409, { error: `the agent is in a terminal dialog ("${dialog.hint}") — ${key} would drive its selection blind; open the terminal surface`, dialog: true })
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
