// Tests for src/attachments.mjs — the file half of the escalation payload
// contract (#34, amending #11; widened past images by #430).
//
// The contract these pin:
//
//   resolveOutboundFiles(paths, { roots, cwd, guestRoot }) -> { files, refusals }
//     An agent may publish files from inside `roots` only. The daemon holds a
//     Discord token and a tailnet position, so an unbounded path here is an
//     exfiltration primitive — containment is checked against REAL paths, so a
//     symlink planted inside the worktree cannot smuggle /etc/passwd out.
//     Refusals are returned, never thrown: text stays the floor, and the human
//     still gets the message.
//     `roots` are HOST paths and every agent runs in a container, so `guestRoot`
//     translates the agent's own absolute view of its worktree (#429). The
//     translation runs BEFORE containment and never in place of it.
//     The allowlist carries five image types and five text types, and a text
//     file gets the smaller cap (#430).
//
//   inboundContent(paths) -> MCP content blocks
//     Images become real `image` blocks so the picture lands in the agent's
//     context. Anything unreadable, oversized or not an image degrades to a
//     text line naming the path — visible, never silently dropped.
//
//   safeLeaf(name, fallback) -> filename
//     Discord supplies attachment names; `..` must not walk out of the
//     attachments directory.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveOutboundFiles, inboundContent, safeLeaf, imageMimeFor, attachmentMimeFor,
  ALLOWED_EXTENSIONS, MAX_FILES, MAX_OUTBOUND_BYTES, MAX_TEXT_BYTES, MAX_INBOUND_BYTES,
} from '../src/attachments.mjs'

// A 1x1 PNG — enough that mime/size logic has a real file to stat.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-images-'))
  const inside = path.join(root, 'shot.png')
  fs.writeFileSync(inside, PNG_1X1)
  return { root, inside }
}

describe('resolveOutboundFiles containment', () => {
  test('a file inside the root is accepted', () => {
    const { root, inside } = fixture()
    const { files, refusals } = resolveOutboundFiles([inside], { roots: [root] })
    assert.equal(refusals.length, 0)
    assert.equal(files.length, 1)
    assert.equal(files[0].name, 'shot.png')
  })

  test('a file outside every root is refused, not thrown', () => {
    const { root } = fixture()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-elsewhere-'))
    const outside = path.join(other, 'secret.png')
    fs.writeFileSync(outside, PNG_1X1)
    const { files, refusals } = resolveOutboundFiles([outside], { roots: [root] })
    assert.equal(files.length, 0)
    assert.match(refusals[0], /refused/)
  })

  test('a symlink inside the root pointing outside is refused', () => {
    const { root } = fixture()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-elsewhere-'))
    const secret = path.join(other, 'secret.png')
    fs.writeFileSync(secret, PNG_1X1)
    const link = path.join(root, 'innocent.png')
    fs.symlinkSync(secret, link)
    const { files, refusals } = resolveOutboundFiles([link], { roots: [root] })
    assert.equal(files.length, 0, 'realpath must defeat the symlink')
    assert.match(refusals[0], /refused/)
  })

  test('a traversal path is refused', () => {
    const { root } = fixture()
    const { files } = resolveOutboundFiles([path.join(root, '..', '..', 'etc', 'passwd')], { roots: [root] })
    assert.equal(files.length, 0)
  })

  test('a relative path resolves against the agent cwd', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundFiles(['shot.png'], { roots: [root], cwd: root })
    assert.equal(refusals.length, 0)
    assert.equal(files.length, 1)
  })
})

// #429. Every agent runs in a container that mounts its worktree at
// /workspace, so the absolute path an agent reads off its own filesystem is a
// GUEST path and the roots are HOST paths. `guestRoot` is the translation, and
// it must not become a second, softer way past containment.
describe('resolveOutboundFiles maps the container path to its host root (#429)', () => {
  const GUEST = '/workspace'
  const guestRootFor = (root) => ({ guest: GUEST, host: root })

  test('the absolute path the agent sees resolves to the file the daemon knows', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundFiles([`${GUEST}/shot.png`], {
      roots: [root], guestRoot: guestRootFor(root),
    })
    assert.deepEqual(refusals, [])
    assert.equal(files.length, 1)
    assert.equal(files[0].attachment, fs.realpathSync(path.join(root, 'shot.png')))
  })

  test('the worktree-relative form keeps working alongside it', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundFiles(['shot.png'], {
      roots: [root], cwd: root, guestRoot: guestRootFor(root),
    })
    assert.equal(refusals.length, 0)
    assert.equal(files.length, 1)
  })

  test('the guest root itself maps to the host root', () => {
    const { root } = fixture()
    const { refusals } = resolveOutboundFiles([GUEST], { roots: [root], guestRoot: guestRootFor(root) })
    // A directory carries no allowed extension, which proves the map ran: an
    // unmapped /workspace would have been refused for sitting outside the
    // roots, and that refusal reads differently.
    assert.match(refusals[0], /cannot attach that file type/)
  })

  test('a traversal out of the guest root is still refused', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundFiles([`${GUEST}/../../etc/passwd`], {
      roots: [root], guestRoot: guestRootFor(root),
    })
    assert.equal(files.length, 0)
    assert.match(refusals[0], /outside your workspace|no file at that path/)
  })

  test('a symlink out of the guest root is still refused', () => {
    const { root } = fixture()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-elsewhere-'))
    const secret = path.join(other, 'secret.png')
    fs.writeFileSync(secret, PNG_1X1)
    fs.symlinkSync(secret, path.join(root, 'innocent.png'))
    const { files } = resolveOutboundFiles([`${GUEST}/innocent.png`], {
      roots: [root], guestRoot: guestRootFor(root),
    })
    assert.equal(files.length, 0, 'the map must not skip the realpath check')
  })

  test('a path that only LOOKS like the guest root is untouched without a mapping', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundFiles([`${GUEST}/shot.png`], { roots: [root] })
    assert.equal(files.length, 0, 'a caller that speaks host paths gets no translation')
    assert.match(refusals[0], /refused/)
  })

  test('the map never reaches past the guest root onto a sibling name', () => {
    const { root } = fixture()
    const { files } = resolveOutboundFiles(['/workspaces/shot.png'], {
      roots: [root], guestRoot: guestRootFor(root),
    })
    assert.equal(files.length, 0, '/workspaces is not /workspace')
  })
})

// #429. "Not a readable path" named a permission problem for a file that was
// merely somewhere else, and the refusal named no form that would have worked.
describe('a refusal says which fault it was, and what to send instead', () => {
  test('a missing file is told apart from a file outside the workspace', () => {
    const { root } = fixture()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-elsewhere-'))
    const outside = path.join(other, 'secret.png')
    fs.writeFileSync(outside, PNG_1X1)

    const missing = resolveOutboundFiles([path.join(root, 'ghost.png')], { roots: [root] })
    assert.match(missing.refusals[0], /no file at that path/)

    const elsewhere = resolveOutboundFiles([outside], { roots: [root] })
    assert.match(elsewhere.refusals[0], /outside your workspace/)
    assert.doesNotMatch(elsewhere.refusals[0], /readable/)
  })

  test('the refusal names the guest form when the agent has one', () => {
    const { root } = fixture()
    const { refusals } = resolveOutboundFiles([`/workspace/ghost.png`], {
      roots: [root], guestRoot: { guest: '/workspace', host: root },
    })
    assert.match(refusals[0], /\/workspace\//)
    assert.match(refusals[0], /relative/)
  })
})

describe('resolveOutboundFiles rejects what Discord should not receive', () => {
  test('a type off the allowlist is refused, and the refusal names the list', () => {
    const { root } = fixture()
    const pdf = path.join(root, 'report.pdf')
    fs.writeFileSync(pdf, 'hello')
    const { files, refusals } = resolveOutboundFiles([pdf], { roots: [root] })
    assert.equal(files.length, 0)
    assert.match(refusals[0], /cannot attach that file type/)
    assert.match(refusals[0], /\.patch/)
  })

  test('a missing file is refused rather than crashing the call', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundFiles([path.join(root, 'ghost.png')], { roots: [root] })
    assert.equal(files.length, 0)
    assert.equal(refusals.length, 1)
  })

  test('an oversized image is refused', () => {
    const { root } = fixture()
    const big = path.join(root, 'big.png')
    fs.writeFileSync(big, Buffer.alloc(MAX_OUTBOUND_BYTES + 1))
    const { files, refusals } = resolveOutboundFiles([big], { roots: [root] })
    assert.equal(files.length, 0)
    assert.match(refusals[0], /exceeds/)
  })

  test('files beyond the per-call cap are refused, the first ones still go', () => {
    const { root } = fixture()
    const paths = []
    for (let i = 0; i < MAX_FILES + 2; i++) {
      const p = path.join(root, `shot-${i}.png`)
      fs.writeFileSync(p, PNG_1X1)
      paths.push(p)
    }
    const { files, refusals } = resolveOutboundFiles(paths, { roots: [root] })
    assert.equal(files.length, MAX_FILES)
    assert.equal(refusals.length, 2)
  })

  test('no files at all is not an error', () => {
    assert.deepEqual(resolveOutboundFiles(undefined, { roots: ['/tmp'] }), { files: [], refusals: [] })
  })
})

// #430. A diff is the one artifact a review gate cannot fit in prose, and
// Discord previews a text file inline. So the allowlist carries text as well as
// images, under a smaller cap and the same containment.
describe('the allowlist carries text as well as images (#430)', () => {
  const TEXT_EXTENSIONS = ['.patch', '.diff', '.md', '.txt', '.log']

  test('every text form on the list is accepted', () => {
    const { root } = fixture()
    for (const ext of TEXT_EXTENSIONS) {
      const file = path.join(root, `note${ext}`)
      fs.writeFileSync(file, 'diff --git a/a b/a\n')
      const { files, refusals } = resolveOutboundFiles([file], { roots: [root] })
      assert.deepEqual(refusals, [], `${ext} must be accepted`)
      assert.equal(files.length, 1)
      assert.equal(files[0].name, `note${ext}`)
    }
  })

  test('the hint list and the check name the same types', () => {
    assert.deepEqual(ALLOWED_EXTENSIONS, ['.png', '.jpg', '.jpeg', '.gif', '.webp', ...TEXT_EXTENSIONS])
    for (const ext of ALLOWED_EXTENSIONS) assert.ok(attachmentMimeFor(`a${ext}`), `${ext} must resolve to a mime type`)
  })

  test('a text file gets the text cap, not the image one', () => {
    const { root } = fixture()
    const big = path.join(root, 'huge.patch')
    fs.writeFileSync(big, Buffer.alloc(MAX_TEXT_BYTES + 1))
    const { files, refusals } = resolveOutboundFiles([big], { roots: [root] })
    assert.equal(files.length, 0)
    assert.match(refusals[0], /exceeds the 1 MB limit/)
  })

  test('an image that size still goes, so the two caps are really two', () => {
    const { root } = fixture()
    const png = path.join(root, 'wide.png')
    fs.writeFileSync(png, Buffer.alloc(MAX_TEXT_BYTES + 1))
    const { files, refusals } = resolveOutboundFiles([png], { roots: [root] })
    assert.deepEqual(refusals, [])
    assert.equal(files.length, 1)
    assert.ok(MAX_TEXT_BYTES < MAX_OUTBOUND_BYTES)
  })

  test('images and text share one per-call count', () => {
    const { root } = fixture()
    const paths = []
    for (let i = 0; i < MAX_FILES; i++) {
      const p = path.join(root, `shot-${i}.png`)
      fs.writeFileSync(p, PNG_1X1)
      paths.push(p)
    }
    const patch = path.join(root, 'fix.patch')
    fs.writeFileSync(patch, 'diff --git a/a b/a\n')
    const { files, refusals } = resolveOutboundFiles([...paths, patch], { roots: [root] })
    assert.equal(files.length, MAX_FILES)
    assert.match(refusals[0], new RegExp(`at most ${MAX_FILES} files per call`))
  })

  test('containment still runs on a text file', () => {
    const { root } = fixture()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-elsewhere-'))
    const secret = path.join(other, 'secret.md')
    fs.writeFileSync(secret, 'private')
    fs.symlinkSync(secret, path.join(root, 'innocent.md'))
    const { files, refusals } = resolveOutboundFiles([path.join(root, 'innocent.md')], { roots: [root] })
    assert.equal(files.length, 0, 'a wider allowlist must not widen the map')
    assert.match(refusals[0], /outside your workspace/)
  })
})

describe('inboundContent', () => {
  test('an image becomes a real MCP image block', () => {
    const { inside } = fixture()
    const [block] = inboundContent([inside])
    assert.equal(block.type, 'image')
    assert.equal(block.mimeType, 'image/png')
    assert.equal(block.data, PNG_1X1.toString('base64'))
  })

  test('a non-image degrades to a visible path line, never silence', () => {
    const { root } = fixture()
    const txt = path.join(root, 'log.txt')
    fs.writeFileSync(txt, 'hello')
    const [block] = inboundContent([txt])
    assert.equal(block.type, 'text')
    assert.match(block.text, /not an image/)
    assert.match(block.text, /log\.txt/)
  })

  // #430 widened the OUTBOUND allowlist only. An inbound text file stays a
  // path line on purpose: the agent has the file and a shell, and inlining it
  // would spend context on a file the agent may never open.
  test('an inbound text file stays a path line, allowlist or not', () => {
    const { root } = fixture()
    const patch = path.join(root, 'fix.patch')
    fs.writeFileSync(patch, 'diff --git a/a b/a\n')
    const [block] = inboundContent([patch])
    assert.equal(block.type, 'text')
    assert.match(block.text, /fix\.patch/)
  })

  test('an oversized image degrades to a path line rather than blowing up the context', () => {
    const { root } = fixture()
    const big = path.join(root, 'huge.png')
    fs.writeFileSync(big, Buffer.alloc(MAX_INBOUND_BYTES + 1))
    const [block] = inboundContent([big])
    assert.equal(block.type, 'text')
    assert.match(block.text, /too large/)
  })

  test('a vanished file is reported, not thrown', () => {
    const [block] = inboundContent(['/nonexistent/gone.png'])
    assert.equal(block.type, 'text')
    assert.match(block.text, /unavailable/)
  })

  test('nothing attached yields no blocks', () => {
    assert.deepEqual(inboundContent([]), [])
    assert.deepEqual(inboundContent(), [])
  })
})

describe('safeLeaf keeps Discord-supplied names inside the attachments dir', () => {
  test('a traversal name is reduced to its leaf', () => {
    assert.equal(safeLeaf('../../etc/passwd', 'fallback'), 'passwd')
  })

  test('dot names fall back', () => {
    assert.equal(safeLeaf('..', 'fallback'), 'fallback')
    assert.equal(safeLeaf('', 'fallback'), 'fallback')
    assert.equal(safeLeaf(undefined, 'fallback'), 'fallback')
  })

  test('an ordinary name survives untouched', () => {
    assert.equal(safeLeaf('screenshot.png', 'fallback'), 'screenshot.png')
  })
})

// Two lookups, and the difference is the point (#430). Outbound asks what may
// go to Discord. Inbound asks what may become an `image` content block, and a
// text file that answered yes would build a malformed one.
describe('imageMimeFor and attachmentMimeFor', () => {
  test('known image extensions map, case-insensitively', () => {
    assert.equal(imageMimeFor('a.PNG'), 'image/png')
    assert.equal(imageMimeFor('a.jpeg'), 'image/jpeg')
    assert.equal(imageMimeFor('a.webp'), 'image/webp')
  })

  test('a text file is not an image, however attachable it is', () => {
    assert.equal(imageMimeFor('a.patch'), null)
    assert.equal(imageMimeFor('a.md'), null)
    assert.equal(attachmentMimeFor('a.PATCH'), 'text/x-patch')
    assert.equal(attachmentMimeFor('a.md'), 'text/markdown')
  })

  test('a type off the list resolves to nothing either way', () => {
    assert.equal(imageMimeFor('a.pdf'), null)
    assert.equal(attachmentMimeFor('a.pdf'), null)
    assert.equal(attachmentMimeFor('a.zip'), null)
    assert.equal(attachmentMimeFor('noext'), null)
  })
})
