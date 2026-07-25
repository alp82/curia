// Image passthrough, both directions (#34 — amends the #11 escalation payload
// contract).
//
// Before this module the bridge could render `files` but nothing on the
// worker-facing MCP surface could supply them, and an inbound Discord image
// reached the worker only as a `[attachment: <path>]` line of text — a disk
// path the worker had to go Read for itself (#28's workaround shape). Both
// directions now carry real images:
//
//   outbound  worker → human: `images: [<path>]` on ask_human / notify; the
//             daemon validates and hands the files to discord.js
//   inbound   human → worker: Discord attachments come back as MCP `image`
//             content blocks (base64) in the ask_human result, so the picture
//             lands in the worker's context directly
//
// Refusals are never silent: a rejected path is reported back to the caller in
// the tool result and journalled. Text stays the floor — a bad image never
// costs the human the message or the worker the answer.

import fs from 'node:fs'
import path from 'node:path'

// Discord's free-tier per-file ceiling is 10 MB; leave margin.
export const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024
// Inbound rides into the model's context as base64 — the API's own per-image
// ceiling is the binding constraint, not Discord's.
export const MAX_INBOUND_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES = 4

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export function mimeFor(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? null
}

// Resolve `p` and assert it really sits inside one of `roots`. realpath on both
// sides so a symlink inside the worktree cannot point the daemon at
// ~/.ssh/id_rsa and have it uploaded to Discord.
function containedIn(p, roots) {
  let real
  try {
    real = fs.realpathSync(p)
  } catch {
    return null
  }
  for (const root of roots) {
    let realRoot
    try {
      realRoot = fs.realpathSync(root)
    } catch {
      continue
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real
  }
  return null
}

// Worker-supplied outbound image paths → files discord.js can send.
// `roots` bounds what a worker may publish: its own worktree and the daemon's
// data dir, never the whole box. Returns { files, refusals } — refusals are
// strings meant to go straight back to the worker.
export function resolveOutboundImages(images, { roots, cwd }) {
  const files = []
  const refusals = []
  for (const raw of images ?? []) {
    if (files.length >= MAX_IMAGES) {
      refusals.push(`${raw}: refused — at most ${MAX_IMAGES} images per call`)
      continue
    }
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(cwd ?? roots[0] ?? '.', raw)
    const real = containedIn(candidate, roots)
    if (!real) {
      refusals.push(`${raw}: refused — not a readable path inside this worker's workspace`)
      continue
    }
    const mime = mimeFor(real)
    if (!mime) {
      refusals.push(`${raw}: refused — not an image (allowed: ${Object.keys(MIME_BY_EXT).join(', ')})`)
      continue
    }
    const { size } = fs.statSync(real)
    if (size > MAX_OUTBOUND_BYTES) {
      refusals.push(`${raw}: refused — ${(size / 1048576).toFixed(1)} MB exceeds the ${MAX_OUTBOUND_BYTES / 1048576} MB limit`)
      continue
    }
    files.push({ attachment: real, name: path.basename(real) })
  }
  return { files, refusals }
}

// Downloaded Discord attachments → MCP content blocks for the ask_human result.
// Images become real `image` blocks; anything else (or anything too big to
// inline) degrades to the path line so it is visible rather than dropped.
export function inboundContent(attachments = []) {
  const blocks = []
  let inlined = 0
  for (const file of attachments) {
    const mime = mimeFor(file)
    let size = null
    try {
      ({ size } = fs.statSync(file))
    } catch {
      blocks.push({ type: 'text', text: `[attachment unavailable: ${file}]` })
      continue
    }
    if (!mime || size > MAX_INBOUND_BYTES || inlined >= MAX_IMAGES) {
      const why = !mime ? 'not an image' : inlined >= MAX_IMAGES ? `beyond the first ${MAX_IMAGES} images` : 'too large to inline'
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
