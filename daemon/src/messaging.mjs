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
//   🔗 link                                            down, a lapsed confirm
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

export function chunkMessage(text, limit = CHUNK_LIMIT) {
  const s = String(text)
  if (s.length <= limit) return [s]
  const chunks = []
  let current = ''
  const push = () => { if (current) { chunks.push(current); current = '' } }
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
  for (const para of s.split('\n\n')) {
    if (para.length <= limit) {
      add(para, '\n\n')
    } else {
      for (const line of para.split('\n')) add(line, '\n')
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

// The executable half of the standard: no headings, no tables, no
// blockquotes, no emoji outside the signal set. Returns the violations, empty
// when the text conforms — tests assert on that.
export function lintReply(text) {
  const problems = []
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/^-# /, '')
    if (/^#{1,6} /.test(line)) problems.push(`heading: ${line}`)
    if (/^>/.test(line.trim())) problems.push(`blockquote: ${line}`)
    if (/^\|.*\|/.test(line.trim())) problems.push(`table: ${line}`)
  }
  for (const m of String(text).match(EMOJI_RE) ?? []) {
    if (!SIGNAL_SET.has(bare(m))) problems.push(`emoji outside the signal set: ${m}`)
  }
  return problems
}
