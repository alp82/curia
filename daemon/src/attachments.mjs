// Attachment passthrough, both directions (#34 — amends the #11 escalation
// payload contract. #430 widened it past images and renamed the module).
//
// Before this module the bridge could render `files` but nothing on the
// agent-facing MCP surface could supply them, and an inbound Discord image
// reached the agent only as a `[attachment: <path>]` line of text — a disk
// path the agent had to go Read for itself (#28's workaround shape). Both
// directions now carry real files:
//
//   outbound  agent → human: `images: [<path>]` on ask_human / notify; the
//             daemon validates and hands the files to discord.js
//   inbound   human → agent: Discord attachments come back as MCP `image`
//             content blocks (base64) in the ask_human result, so the picture
//             lands in the agent's context directly
//
// Refusals are never silent: a rejected path is reported back to the caller in
// the tool result and journalled. Text stays the floor — a bad file never
// costs the human the message or the agent the answer.

import fs from 'node:fs'
import path from 'node:path'

// Discord's free-tier per-file ceiling is 10 MB; leave margin.
export const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024
// A text attachment is there to be READ in the thread, so it gets its own,
// much smaller ceiling (#430). A diff a human opens on a phone is kilobytes,
// and 1 MB is already about 20000 lines. Past that the file is an archive, and
// the thread is the wrong place for it.
export const MAX_TEXT_BYTES = 1 * 1024 * 1024
// Inbound rides into the model's context as base64 — the API's own per-image
// ceiling is the binding constraint, not Discord's.
export const MAX_INBOUND_BYTES = 5 * 1024 * 1024
// One count for the whole call, images and text together (#430).
export const MAX_FILES = 4

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

// The text forms Discord previews inline, which is what makes them worth
// carrying (#414, #430): a diff is the one artifact a review gate cannot fit
// in prose. Text only, and nothing joins this list without a ticket — a `.pdf`
// or a `.zip` is a download, not something the operator reads on a phone.
const TEXT_MIME_BY_EXT = {
  '.patch': 'text/x-patch',
  '.diff': 'text/x-diff',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
}

// The image forms, in the agent's own terms. `picture` (ADR-0026) takes one of
// these and nothing else, so the lint and the attachment check read one list.
export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_BY_EXT)

// What an agent may attach, in the agent's own terms. Exported so the tool
// hint names the same list the check enforces.
export const ALLOWED_EXTENSIONS = [...Object.keys(IMAGE_MIME_BY_EXT), ...Object.keys(TEXT_MIME_BY_EXT)]

// Two lookups, because the two callers ask different questions. Outbound asks
// "may this file go to Discord". Inbound asks "may this file become an `image`
// content block", and a `text/markdown` block would be a malformed one.
export function imageMimeFor(file) {
  return IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()] ?? null
}

export function attachmentMimeFor(file) {
  const ext = path.extname(file).toLowerCase()
  return IMAGE_MIME_BY_EXT[ext] ?? TEXT_MIME_BY_EXT[ext] ?? null
}

// Resolve `p` and assert it really sits inside one of `roots`. realpath on both
// sides so a symlink inside the worktree cannot point the daemon at
// ~/.ssh/id_rsa and have it uploaded to Discord.
//
// The two failures are told apart (#429). Both used to read "not a readable
// path", which named a permission problem for a file that was merely somewhere
// else, and sent the agent looking for the wrong fault.
function containedIn(p, roots) {
  let real
  try {
    real = fs.realpathSync(p)
  } catch {
    return { real: null, why: 'there is no file at that path' }
  }
  for (const root of roots) {
    let realRoot
    try {
      realRoot = fs.realpathSync(root)
    } catch {
      continue
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return { real, why: null }
  }
  return { real: null, why: 'that file is outside your workspace' }
}

// The agent's own view of a path → the daemon's view of the same file (#429).
//
// Every agent runs in a container that mounts its worktree at a guest path
// (`/workspace`), so `/workspace/shot.png` is the natural absolute form for an
// agent to write, and it is the form the tool text asked for. The daemon knows
// that same file only by its HOST path, so before #429 the absolute form
// matched no root and the file was dropped.
//
// This is a translation, never a widening: containment below still runs on the
// real host path, so a mapped path that lands outside the roots — `/workspace/
// ../etc/passwd`, a symlink out — is refused exactly like any other. Only the
// worktree is mapped. The container's other mount is the agent config dir, and
// it holds the agent token, so nothing there is publishable by either name.
function fromGuest(p, guestRoot) {
  const { guest, host } = guestRoot ?? {}
  if (!guest || !host) return p
  if (p === guest) return host
  if (p.startsWith(guest + path.sep)) return path.join(host, p.slice(guest.length + 1))
  return p
}

// The tail of a refusal: the forms that DO work, in the agent's own names for
// them (#429). A refusal that only says no makes the next attempt a guess.
function howToSay(guestRoot) {
  return guestRoot?.guest
    ? `either as a path relative to it or as an absolute path under ${guestRoot.guest}/`
    : 'as a path relative to it or as its absolute path'
}

// Agent-supplied outbound paths → files discord.js can send.
// `roots` bounds what an agent may publish: its own worktree and the daemon's
// data dir, never the whole box. `guestRoot` is `{ guest, host }` — the path
// the agent calls its worktree and the path the daemon calls it (#429); omit it
// for a caller that already speaks host paths. Returns { files, refusals } —
// refusals are strings meant to go straight back to the agent.
export function resolveOutboundFiles(paths, { roots, cwd, guestRoot = null }) {
  const files = []
  const refusals = []
  for (const raw of paths ?? []) {
    if (files.length >= MAX_FILES) {
      refusals.push(`${raw}: refused — at most ${MAX_FILES} files per call`)
      continue
    }
    const candidate = path.isAbsolute(raw)
      ? fromGuest(raw, guestRoot)
      : path.resolve(cwd ?? roots[0] ?? '.', raw)
    const { real, why } = containedIn(candidate, roots)
    if (!real) {
      refusals.push(`${raw}: refused — ${why}. Send a file from your workspace, ${howToSay(guestRoot)}`)
      continue
    }
    const mime = attachmentMimeFor(real)
    if (!mime) {
      refusals.push(`${raw}: refused — curia cannot attach that file type (allowed: ${ALLOWED_EXTENSIONS.join(', ')})`)
      continue
    }
    // Two caps, because a picture and a diff are read in different ways (#430).
    const cap = mime.startsWith('image/') ? MAX_OUTBOUND_BYTES : MAX_TEXT_BYTES
    const { size } = fs.statSync(real)
    if (size > cap) {
      refusals.push(`${raw}: refused — ${(size / 1048576).toFixed(1)} MB exceeds the ${cap / 1048576} MB limit`)
      continue
    }
    files.push({ attachment: real, name: path.basename(real) })
  }
  return { files, refusals }
}

// Downloaded Discord attachments → MCP content blocks for the ask_human result.
// Images become real `image` blocks; anything else (or anything too big to
// inline) degrades to the path line so it is visible rather than dropped.
//
// Only an image inlines, and #430 did not change that: the agent has the file
// on disk and a shell, so a `.patch` the operator sends is one Read away. An
// inbound text block would spend context on a file the agent may not need.
export function inboundContent(attachments = []) {
  const blocks = []
  let inlined = 0
  for (const file of attachments) {
    const mime = imageMimeFor(file)
    let size = null
    try {
      ({ size } = fs.statSync(file))
    } catch {
      blocks.push({ type: 'text', text: `[attachment unavailable: ${file}]` })
      continue
    }
    if (!mime || size > MAX_INBOUND_BYTES || inlined >= MAX_FILES) {
      const why = !mime ? 'not an image' : inlined >= MAX_FILES ? `beyond the first ${MAX_FILES} images` : 'too large to inline'
      blocks.push({ type: 'text', text: `[attachment on disk (${why}), read it if you need it: ${file}]` })
      continue
    }
    blocks.push({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: mime })
    inlined++
  }
  return blocks
}

// Filename from an untrusted source (a Discord attachment name) → a leaf that
// cannot escape its directory. basename() alone still lets ".." through.
export function safeLeaf(name, fallback) {
  const leaf = path.basename(String(name ?? '').replace(/\0/g, ''))
  if (!leaf || leaf === '.' || leaf === '..') return fallback
  return leaf
}
