// Inbound message text (#697, spec #684): one reading of what the operator
// actually said, whether Discord kept it in the message or spilled it into a
// file.
//
// Discord's client silently turns any message past 2000 characters into a
// short body plus a `message.txt` attachment. Every inbound path took
// `m.content` and nothing else, so the overflow half of a long request simply
// did not exist for the overseer, the agent, or an escalation answer. The
// operator saw a message they had written in full; curia read the first 2000
// characters of it.
//
// So there is one seam now, and every inbound path goes through it: top-level
// turns, thread turns, agent notes, and escalation answers all take the text
// this module composes. The rules it holds:
//
//   order      the message body first, then each text attachment in the order
//              Discord listed it. Source order, because a continuation that
//              lands above its own opening is a different message.
//   once       a segment appears exactly once. The body is never re-read out
//              of the file, and the file is never inlined twice.
//   limits     a per-file cap and a whole-message cap. Past either, the file
//              is refused BY NAME rather than truncated — half a diff read as
//              a whole one is the failure worth avoiding.
//   refusals   visible and non-destructive. A refused or undownloadable file
//              costs its own text and nothing else: the body and every other
//              segment still arrive, and a line names what is missing.
//
// Images are not this module's business. They keep the disk-path route from
// #34/#430, which puts the picture in the agent's context as a content block.

import path from 'node:path'
import { attachmentMimeFor, MAX_TEXT_BYTES } from './attachments.mjs'

// Per file. Same ceiling an OUTBOUND text attachment gets (#430), for the same
// reason: past a megabyte the file is an archive, and a conversation is the
// wrong place to read one.
export const MAX_INBOUND_TEXT_BYTES = MAX_TEXT_BYTES
// Per message, across every file. Four files under the per-file cap would be
// four megabytes of turn, and the cap that matters is the one on what a model
// reads in a single turn.
export const MAX_INBOUND_TEXT_TOTAL_BYTES = MAX_TEXT_BYTES
// How many files may contribute text at all. The rest are named, not read.
export const MAX_INBOUND_TEXT_FILES = 4

// What counts as text curia will read. The extension list is the one
// `attachments.mjs` already enforces outbound, minus the images — so both
// directions agree on which files are readable, and neither grows a type
// without a ticket. Discord's own `contentType` is a second yes for the
// extensionless case (`message.txt` always has the extension, but a pasted
// snippet may not).
export function isInboundText(attachment) {
  const name = String(attachment?.name ?? '')
  const mime = attachmentMimeFor(name)
  if (mime) return !mime.startsWith('image/')
  if (path.extname(name)) return false
  return String(attachment?.contentType ?? '').startsWith('text/')
}

// A refusal the recipient reads. It names the file, so the operator can tell
// which of four attachments did not arrive, and it says the text is missing
// rather than implying the message failed.
function refusal(name, why) {
  return `[attachment ${name}: ${why} — its text is not included; the rest of this message is complete]`
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

// Download one attachment as text. Kept separate so a caller with the bytes
// already on disk can pass its own reader instead of fetching twice.
export function fetchLoader(fetchFn = globalThis.fetch) {
  return async (attachment) => {
    const res = await fetchFn(attachment.url)
    if (res.ok === false) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
}

// The whole seam: a Discord-shaped message → the text every inbound path uses.
//
// `message` needs only `content` and `attachments` (a Map, an array, or
// anything iterable — the bridge holds a discord.js Collection). `load` returns
// the bytes of one attachment.
//
// Returns `{ text, segments, refusals }`. `text` is what the recipient reads:
// every segment in source order, then the refusal lines. `segments` and
// `refusals` are separate so a caller can react or journal without re-parsing.
export async function readInboundText(message, { load = fetchLoader() } = {}) {
  const body = String(message?.content ?? '').trim()
  const segments = body ? [body] : []
  const refusals = []

  let read = 0
  let files = 0
  for (const attachment of message?.attachments?.values?.() ?? message?.attachments ?? []) {
    if (!isInboundText(attachment)) continue
    const name = String(attachment?.name ?? 'attachment')
    if (files >= MAX_INBOUND_TEXT_FILES) {
      refusals.push(refusal(name, `beyond the first ${MAX_INBOUND_TEXT_FILES} text files curia reads`))
      continue
    }
    // Discord states the size before the download, so an archive is refused
    // without spending the bytes. A source that states none is measured after.
    const stated = Number(attachment?.size)
    if (Number.isFinite(stated) && stated > MAX_INBOUND_TEXT_BYTES) {
      files += 1
      refusals.push(refusal(name, `${mb(stated)} is past the ${mb(MAX_INBOUND_TEXT_BYTES)} limit`))
      continue
    }
    let bytes
    try {
      bytes = await load(attachment)
    } catch (e) {
      files += 1
      refusals.push(refusal(name, `curia could not download it (${e.message})`))
      continue
    }
    files += 1
    if (bytes.length > MAX_INBOUND_TEXT_BYTES) {
      refusals.push(refusal(name, `${mb(bytes.length)} is past the ${mb(MAX_INBOUND_TEXT_BYTES)} limit`))
      continue
    }
    if (read + bytes.length > MAX_INBOUND_TEXT_TOTAL_BYTES) {
      refusals.push(refusal(name, `this message is already at the ${mb(MAX_INBOUND_TEXT_TOTAL_BYTES)} of attached text curia reads`))
      continue
    }
    read += bytes.length
    const segment = bytes.toString('utf8').trim()
    if (segment) segments.push(segment)
  }

  return { text: [...segments, ...refusals].join('\n\n'), segments, refusals }
}
