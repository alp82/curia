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

// Webhook speaker name (#108 item 15): `curia-9 · <ticket title>` — the
// multi-agent shape moves from the prose into the speaker label. Discord caps
// webhook usernames at 80 chars, so the title cuts at a word boundary.
export function speakerName(agent, title = '') {
  if (!title) return agent
  return `${agent} · ${promptTitle(title, 80 - agent.length - 3)}`
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
