// The per-turn messaging standard (#95), from the messaging-discipline
// decision (#89). One module holds the vocabulary every Discord-bound reply
// path shares — the signal emoji, small print, link wrapping, list clamping —
// plus a lint the tests run over composed replies so drift fails loudly.
// GitHub comment bodies (resolve.mjs) are NOT messages and stay out of scope.
//
// The signals, one meaning each (#89's fixed set — nothing else appears in a
// message):
//   ⚙️ work in motion        ✅ done / confirmed     ❌ refused / declined
//   ⚠️ warning / failure     🎫 ticket               ⚰️ dead — a worker torn
//   🔗 link                                            down, a lapsed confirm
//
// Button LABELS are UI chrome, not messages: the ✅/❌ confirm pair is fixed
// by #94, and the 🛑 Cancel withdraw button stays visually distinct from
// ❌ Reject on purpose.

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
