// The per-turn messaging standard (#95), from the messaging-discipline
// decision (#89). One module holds the vocabulary every Discord-bound reply
// path shares — the signal emoji, small print, link wrapping, list clamping —
// plus a lint the tests run over composed replies so drift fails loudly.
// GitHub comment bodies (resolve.mjs) are NOT messages and stay out of scope.
//
// The signals, one meaning each (#89's fixed set — nothing else appears in a
// message):
//   ⚙️ work in motion        ✅ done / confirmed     ❌ refused / declined
//   ⚠️ warning / failure     🎫 ticket               ⚰️ dead — an agent torn
//   🔗 link                  ❓ a reply is wanted        down, a lapsed confirm
//
// ❓ is #420's entry. The other six say what curia or an agent DID, and a
// notify of kind `ask` says something none of them can: a reply is wanted and
// nothing is blocked on it.
//
// Button LABELS are UI chrome, not messages: the ✅/❌ confirm pair is fixed
// by #94. There is no cancel button any more (#200) — ending an agent is
// `cancel <n>` in the command channel, and nowhere else.

export const SIGNALS = {
  work: '⚙️',
  ok: '✅',
  no: '❌',
  warn: '⚠️',
  ticket: '🎫',
  dead: '⚰️',
  link: '🔗',
  ask: '❓',
}

// Discord renders `-# ` as small print — the meta register (#89). Applied per
// line so a multi-line meta message stays small print throughout.
export function smallPrint(text) {
  return String(text).split('\n').map((l) => `-# ${l}`).join('\n')
}

// Links wrap in <> so Discord skips the embed (#89). Attach links are the
// stated exception — their call sites leave them bare so the phone gets a
// tappable card.
export function link(url) {
  return `<${url}>`
}

// One line per item, and "N more" small print instead of the tail (#89).
export function clampList(lines, max = 10) {
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), smallPrint(`… ${lines.length - max} more`)]
}

// Discord caps a message at 2000 chars. The chunk limit sits well under it so
// an edit can append a suffix (answered/cancelled marks, ~250 chars max)
// without crossing the cap (#119). Decision-bearing text is never silently
// truncated: a long composed message becomes consecutive chunks, split at
// paragraph boundaries first, then lines, then a hard slice as the last
// resort (a single 1600-char line is code, not prose).
export const CHUNK_LIMIT = 1600

// ---- fenced code blocks (#432) ----------------------------------------------
//
// The code-block table and the ASCII diagram are the two visual forms #414 kept,
// and both live in a fence. The same test proved the fence break live: a 34-row
// table crossed a chunk boundary, both halves then rendered as literal
// backticks, the font fell back to proportional, and the columns lost the
// alignment that made it a table.
//
// Two rules answer it, and the code needs both.
//
// The LINT caps a block, so a block that large never reaches the chunker at all.
// A capped table plus a `.md` attachment (#430) beats two half-tables, which is
// the verdict #414 recommended.
//
// The CHUNKER reads the fence anyway, because the cap is not a guarantee. Bot
// prose never passes the lint. The flagged send (#416) puts un-fixed text
// through on purpose. And a block well under the cap still straddles a boundary
// when the prose in front of it is long, so the cap alone leaves the defect
// standing. A block that fits moves whole into one chunk. A block that cannot
// fit closes its fence at the split and reopens it on the next chunk, so every
// half is still monospace and still aligned.

// A fence opens on up to three spaces of indent, then three or more backticks
// or tildes. An info string (```js) may follow the opening marker only.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

// Split text into parts: prose runs and whole fenced blocks, in source order.
// A fence with no closing marker runs to the end of the text, which is how
// Discord renders it too.
export function fenceParts(text) {
  const lines = String(text).split('\n')
  const parts = []
  let prose = []
  const flushProse = () => {
    if (prose.length) parts.push({ code: false, text: prose.join('\n') })
    prose = []
  }
  for (let i = 0; i < lines.length;) {
    const opened = lines[i].match(FENCE_OPEN)
    if (!opened) {
      prose.push(lines[i])
      i += 1
      continue
    }
    flushProse()
    const open = lines[i]
    const marker = opened[1]
    // Neither fence character is a regex metacharacter, so neither needs an escape.
    const closeRe = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`)
    const block = [open]
    let close = null
    for (i += 1; i < lines.length; i += 1) {
      block.push(lines[i])
      if (closeRe.test(lines[i])) { close = lines[i]; i += 1; break }
    }
    parts.push({ code: true, text: block.join('\n'), open, close })
  }
  flushProse()
  return parts
}

export function chunkMessage(text, limit = CHUNK_LIMIT) {
  const s = String(text)
  if (s.length <= limit) return [s]
  const chunks = []
  let current = ''
  const push = () => {
    const done = current.replace(/^\n+|\n+$/g, '')
    if (done) chunks.push(done)
    current = ''
  }
  const add = (piece, sep) => {
    if (current && current.length + sep.length + piece.length <= limit) {
      current += sep + piece
      return
    }
    push()
    while (piece.length > limit) {
      chunks.push(piece.slice(0, limit))
      piece = piece.slice(limit)
    }
    current = piece
  }
  // A block that fits rides `add`, which starts a new chunk rather than break
  // it. A block that does not fit is rebuilt, one fenced part per chunk.
  const addFence = (part) => {
    const close = part.close ?? part.open.match(FENCE_OPEN)[1]
    const room = limit - part.open.length - close.length - 2
    if (part.text.length <= limit || room < 1) {
      add(part.text, '\n')
      return
    }
    push()
    const body = part.text.split('\n').slice(1, part.close ? -1 : undefined)
    let held = []
    let len = 0
    const flushBlock = () => {
      chunks.push([part.open, ...held, close].join('\n'))
      held = []
      len = 0
    }
    for (let line of body) {
      while (line.length > room) {
        if (held.length) flushBlock()
        chunks.push([part.open, line.slice(0, room), close].join('\n'))
        line = line.slice(room)
      }
      if (len + (held.length ? 1 : 0) + line.length > room) flushBlock()
      len += (held.length ? 1 : 0) + line.length
      held.push(line)
    }
    // The tail stays open for the prose that follows it, and it keeps the
    // closing marker only where the source had one.
    current = [part.open, ...held, ...(part.close ? [close] : [])].join('\n')
  }
  for (const part of fenceParts(s)) {
    if (part.code) {
      addFence(part)
      continue
    }
    // The parts are line-adjacent, so the first paragraph of a prose run joins
    // with one newline. The blank line the source had is inside the run.
    let sep = '\n'
    for (const para of part.text.split('\n\n')) {
      if (para.length <= limit) add(para, sep)
      else for (const line of para.split('\n')) add(line, '\n')
      sep = '\n\n'
    }
  }
  push()
  return chunks
}

// The one-line handle on a long prompt (#118): the first non-empty line,
// markdown emphasis stripped, cut at a word boundary — never mid-word, which
// is how "frontier re" happened (#108 item 13).
export function promptTitle(prompt, max = 80) {
  const line = String(prompt).split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const plain = line.replace(/[*_`#]+/g, '').trim()
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max)
  return `${(cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trimEnd()}…`
}

// Webhook speaker name: the session name, alone (#254). #108 item 15 moved
// the multi-agent shape out of the prose and into the speaker label, and hung
// the ticket title off it: `curia-9 · <ticket title>`. Discord caps a webhook
// username at SPEAKER_NAME_LIMIT, so a long title was cut and given an
// ellipsis, and nine agents in the #245 cold read spoke under a mangled
// identity. The budget was also one char short of its own cap — a name of 81
// chars, which Discord REFUSES, so the longest identities collapsed into the
// bot voice instead of speaking at all.
//
// A session name is `curia-<n>` or `curia-review-<n>`. It always fits, one
// agent wears one name for its whole life, and a reviewer adopted after a
// restart wears the same name as before it. The title is not lost: the thread
// is bound to the ticket, and the agent's own prose says what it did.
export const SPEAKER_NAME_LIMIT = 80
export function speakerName(agent) {
  return String(agent)
}

// "how long has this been waiting" for reminders and keepalives (#118).
export function elapsedLabel(sinceIso, now = Date.now()) {
  const ms = now - new Date(sinceIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
}

// ---- failure lines (#256) ----------------------------------------------------
//
// A daemon-side failure says one sentence in the thread, once.
//
// #81 is the exhibit the #245 cold read caught: `open_pull_request` failed three
// times, and every retry pasted the same two lines of git stderr — a
// `git -C /home/alp/…` command echo and a `fatal:` line — into the thread. Two
// faults ride one line. The daemon speaks its own internals in a surface built
// for prose, and it speaks them once per retry.
//
// Nothing is lost by not saying the raw error here. Every failure path journals
// it (`land_failed`, `resolve_failed`, `verdict_delivery_failed`, and the claim
// release reason), and the tool return hands it back verbatim to the agent that
// has to act on it. The thread is the operator's surface, so it gets the
// operator's sentence.

// The stderr shapes the daemon's own git, gh and tmux calls produce. Each maps
// to one sentence, so one cause reads the same way wherever it is raised.
const FAILURE_CAUSES = [
  [/authentication failed|could not read username|bad credentials|invalid username or password|permission to .* denied|http 40[13]|gh auth login/i,
    'GitHub refused the daemon login'],
  [/rate limit/i, 'GitHub rate-limited the daemon'],
  [/cannot change to|no such file or directory|not a git repository/i,
    'the checkout on the box is gone'],
  [/non-fast-forward|updates were rejected|fetch first|\[rejected\]/i,
    'the branch on GitHub has moved on, so the push was refused'],
  [/could not resolve host|connection timed out|network is unreachable|etimedout|econnreset|econnrefused|eai_again|enotfound/i,
    'the box could not reach GitHub'],
  [/no server running|session not found|can't find pane|no current session/i,
    'the tmux session for this agent is gone'],
]

// The sentence is bounded because it is a thread line, not the record. This is
// not the #119 rule breaking: decision-bearing text still never truncates, and
// the raw error is decision-bearing text — which is why it goes to the journal
// and to the agent whole, and why only its restatement is cut here.
export const FAILURE_PROSE_LIMIT = 140

export function failureProse(raw) {
  const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  // Node names the whole command in `Command failed: …`. That line is the
  // daemon's own path and flags, and an operator can act on none of it.
  const body = lines.filter((l) => !/^(Command failed:|\+ )/.test(l) && !/^(git|gh|docker|tmux|node) /.test(l))
  // git says the reason on a `fatal:` line and the context on `remote:` or
  // `error:` above it, so the strongest prefix wins rather than the first line.
  const pick = (re) => body.find((l) => re.test(l))
  const reason = pick(/^fatal:/i) ?? pick(/^error:/i) ?? pick(/^remote:/i) ?? body[0] ?? lines[0] ?? ''
  for (const [re, sentence] of FAILURE_CAUSES) if (re.test(reason)) return sentence
  // Unrecognized: say what the daemon was told, in one sentence. git quotes a
  // path it could not use, and that path is always a daemon path.
  const plain = reason
    .replace(/^(fatal|error|remote|warning):\s*/i, '')
    .replace(/'\/[^']*'/g, 'a path on the box')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
  if (!plain) return 'the daemon reported no reason'
  const first = plain.includes('. ') ? plain.slice(0, plain.indexOf('. ')) : plain
  if (first.length <= FAILURE_PROSE_LIMIT) return first
  const cut = first.slice(0, FAILURE_PROSE_LIMIT)
  return `${(cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// the recorded-answer hand-off line (#139, corrected by #457)
// ---------------------------------------------------------------------------
//
// What the thread is told when an answer landed with no resolver waiting. The
// usual cause is a daemon restart that emptied `pending`, so the agent's own
// call died with the last process.
//
// It is composed HERE rather than at the call site so a test can read all three
// lanes. The line is a promise about delivery, and #457 found the codex one
// making a promise the harness cannot keep.
//
//   not running   a fresh agent drains the queue on its first tool result, so
//                 the verb is `resume`.
//   parked        a codex agent whose call died with NO last word. #371
//                 measured that case: the agent is told nothing, and
//                 `CODEX_TOOL_TIMEOUT_S`, a day, is the only bound. It makes no
//                 next tool result, so the old line promised a delivery that
//                 never came.
//   working       everyone else. The claude client aborts a dropped call in
//                 about 120 s (#341), and since #458 a planned death ends every
//                 blocked call with an error on BOTH lanes. So the agent has its
//                 turn back and the queued answer rides its next tool result.
//
// `spoken` is what separates the last two, and it is a positive fact rather than
// a guess: it says this agent has made an MCP call against THIS daemon process
// (#194's `mcpLastAt`). A codex agent that spoke since boot is not parked, so
// the goodbye reached it, or its own call ended some other way. One that has not
// spoken may be parked, and after a SIGKILL it is — that is the one death #458
// leaves to the pane, measured on #457.
//
// The parked line names `cancel` and then `resume`, in that order. `resume`
// alone is refused while the session is live, and a fresh agent inherits the
// surviving worktree (#81) and drains this answer on its first tool result.
//
// A codex agent that is merely young reads the parked line too, because it has
// not spoken yet. That costs a warning where none was needed. The other way
// round costs a lost answer, so the doubt is spent on the safe side.
//
// An unknown harness takes the working line. That is the default lane, and a
// session adopted from before the harness was recorded is a claude one.
export function handOffLine({ agent, ticket, harness = null, live = false, spoken = false }) {
  if (!live) return `${SIGNALS.ok} recorded — \`${agent}\` is not running; \`resume ${ticket}\` hands it over`
  if (harness === 'codex' && !spoken) {
    return `${SIGNALS.warn} recorded, and \`${agent}\` did not get it.`
      + ' That codex agent has not spoken since this daemon started, so its own call died with no last word.'
      + ' It is parked, and it reads nothing until that call times out, a day out.'
      + ` To hand this answer over: \`cancel ${ticket}\`, then \`resume ${ticket}\`.`
  }
  return `${SIGNALS.ok} recorded — \`${agent}\` gets this answer with its next tool result`
}

// How long one failure stays said. A retry loop inside this window is one line.
export const FAILURE_REPEAT_WINDOW_MS = 10 * 60_000

// The repeat filter. `say` returns the line to post, or null when the thread has
// already heard it.
//
// Silence is bounded on both sides. A loop that outlasts the window says the
// line again with a count, so a stuck agent never reads as an idle one. A
// failure that returns after the window is a fresh burst, not a repeat, and it
// says the full line again.
export class FailureLines {
  constructor({ window = FAILURE_REPEAT_WINDOW_MS } = {}) {
    this.window = window
    this.seen = new Map()
  }

  say(key, text, now = Date.now()) {
    for (const [k, v] of this.seen) if (now - v.last > this.window * 2) this.seen.delete(k)
    const s = this.seen.get(key)
    if (!s || now - s.last > this.window) {
      this.seen.set(key, { first: now, last: now, posted: now, count: 1 })
      return text
    }
    s.count += 1
    s.last = now
    if (now - s.posted < this.window) return null
    s.posted = now
    const span = elapsedLabel(new Date(s.first).toISOString(), now)
    return `${text} (the same failure, ${s.count} times${span ? ` in ${span}` : ''})`
  }
}

// Variation selectors differ between source literals and runtime strings, so
// membership compares with them stripped.
const bare = (s) => s.replace(/️/g, '')
const SIGNAL_SET = new Set(Object.values(SIGNALS).map(bare))
const EMOJI_RE = /[\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}]\u{FE0F}?/gu

// The cap on one fenced block (#432). 1000 chars is 42 columns by 23 rows —
// the width #414 kept, at the depth a phone still scrolls — and it leaves 600
// chars of the chunk for the prose around the block. A block over the cap
// belongs in an attachment (#430), so the message keeps a short table and a
// file carries the long one.
export const CODE_BLOCK_LIMIT = 1000

// The executable half of the standard: no headings, no tables, no
// blockquotes, no emoji outside the signal set, no code block over the cap.
// Returns the violations, empty when the text conforms — tests assert on that.
//
// The three markdown rules read prose only. A table inside a fence is the ONE
// table form Discord renders (#414), so the lint that bans a markdown table
// must not ban the form the standard keeps. The emoji rule stays whole-text: a
// reader sees an emoji in a code block the same way as one in a sentence.
export function lintReply(text) {
  const problems = []
  for (const part of fenceParts(String(text))) {
    if (part.code) {
      if (part.text.length > CODE_BLOCK_LIMIT) {
        problems.push(`code block of ${part.text.length} chars over the ${CODE_BLOCK_LIMIT} cap: shorten it and attach the whole thing as a file`)
      }
      continue
    }
    for (const raw of part.text.split('\n')) {
      const line = raw.replace(/^-# /, '')
      if (/^#{1,6} /.test(line)) problems.push(`heading: ${line}`)
      if (/^>/.test(line.trim())) problems.push(`blockquote: ${line}`)
      if (/^\|.*\|/.test(line.trim())) problems.push(`table: ${line}`)
    }
  }
  for (const m of String(text).match(EMOJI_RE) ?? []) {
    if (!SIGNAL_SET.has(bare(m))) problems.push(`emoji outside the signal set: ${m}`)
  }
  return problems
}
