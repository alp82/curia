// Tests for src/images.mjs — the image half of the escalation payload contract
// (#34, amending #11).
//
// The contract these pin:
//
//   resolveOutboundImages(paths, { roots, cwd, guestRoot }) -> { files, refusals }
//     An agent may publish files from inside `roots` only. The daemon holds a
//     Discord token and a tailnet position, so an unbounded path here is an
//     exfiltration primitive — containment is checked against REAL paths, so a
//     symlink planted inside the worktree cannot smuggle /etc/passwd out.
//     Refusals are returned, never thrown: text stays the floor, and the human
//     still gets the message.
//     `roots` are HOST paths and every agent runs in a container, so `guestRoot`
//     translates the agent's own absolute view of its worktree (#429). The
//     translation runs BEFORE containment and never in place of it.
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
  resolveOutboundImages, inboundContent, safeLeaf, mimeFor,
  MAX_IMAGES, MAX_OUTBOUND_BYTES, MAX_INBOUND_BYTES,
} from '../src/images.mjs'

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

describe('resolveOutboundImages containment', () => {
  test('a file inside the root is accepted', () => {
    const { root, inside } = fixture()
    const { files, refusals } = resolveOutboundImages([inside], { roots: [root] })
    assert.equal(refusals.length, 0)
    assert.equal(files.length, 1)
    assert.equal(files[0].name, 'shot.png')
  })

  test('a file outside every root is refused, not thrown', () => {
    const { root } = fixture()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-elsewhere-'))
    const outside = path.join(other, 'secret.png')
    fs.writeFileSync(outside, PNG_1X1)
    const { files, refusals } = resolveOutboundImages([outside], { roots: [root] })
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
    const { files, refusals } = resolveOutboundImages([link], { roots: [root] })
    assert.equal(files.length, 0, 'realpath must defeat the symlink')
    assert.match(refusals[0], /refused/)
  })

  test('a traversal path is refused', () => {
    const { root } = fixture()
    const { files } = resolveOutboundImages([path.join(root, '..', '..', 'etc', 'passwd')], { roots: [root] })
    assert.equal(files.length, 0)
  })

  test('a relative path resolves against the agent cwd', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundImages(['shot.png'], { roots: [root], cwd: root })
    assert.equal(refusals.length, 0)
    assert.equal(files.length, 1)
  })
})

// #429. Every agent runs in a container that mounts its worktree at
// /workspace, so the absolute path an agent reads off its own filesystem is a
// GUEST path and the roots are HOST paths. `guestRoot` is the translation, and
// it must not become a second, softer way past containment.
describe('resolveOutboundImages maps the container path to its host root (#429)', () => {
  const GUEST = '/workspace'
  const guestRootFor = (root) => ({ guest: GUEST, host: root })

  test('the absolute path the agent sees resolves to the file the daemon knows', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundImages([`${GUEST}/shot.png`], {
      roots: [root], guestRoot: guestRootFor(root),
    })
    assert.deepEqual(refusals, [])
    assert.equal(files.length, 1)
    assert.equal(files[0].attachment, fs.realpathSync(path.join(root, 'shot.png')))
  })

  test('the worktree-relative form keeps working alongside it', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundImages(['shot.png'], {
      roots: [root], cwd: root, guestRoot: guestRootFor(root),
    })
    assert.equal(refusals.length, 0)
    assert.equal(files.length, 1)
  })

  test('the guest root itself maps to the host root', () => {
    const { root } = fixture()
    const { refusals } = resolveOutboundImages([GUEST], { roots: [root], guestRoot: guestRootFor(root) })
    // A directory is not an image, which proves the map ran: an unmapped
    // /workspace would have been refused for sitting outside the roots.
    assert.match(refusals[0], /not an image/)
  })

  test('a traversal out of the guest root is still refused', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundImages([`${GUEST}/../../etc/passwd`], {
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
    const { files } = resolveOutboundImages([`${GUEST}/innocent.png`], {
      roots: [root], guestRoot: guestRootFor(root),
    })
    assert.equal(files.length, 0, 'the map must not skip the realpath check')
  })

  test('a path that only LOOKS like the guest root is untouched without a mapping', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundImages([`${GUEST}/shot.png`], { roots: [root] })
    assert.equal(files.length, 0, 'a caller that speaks host paths gets no translation')
    assert.match(refusals[0], /refused/)
  })

  test('the map never reaches past the guest root onto a sibling name', () => {
    const { root } = fixture()
    const { files } = resolveOutboundImages(['/workspaces/shot.png'], {
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

    const missing = resolveOutboundImages([path.join(root, 'ghost.png')], { roots: [root] })
    assert.match(missing.refusals[0], /no file at that path/)

    const elsewhere = resolveOutboundImages([outside], { roots: [root] })
    assert.match(elsewhere.refusals[0], /outside your workspace/)
    assert.doesNotMatch(elsewhere.refusals[0], /readable/)
  })

  test('the refusal names the guest form when the agent has one', () => {
    const { root } = fixture()
    const { refusals } = resolveOutboundImages([`/workspace/ghost.png`], {
      roots: [root], guestRoot: { guest: '/workspace', host: root },
    })
    assert.match(refusals[0], /\/workspace\//)
    assert.match(refusals[0], /relative/)
  })
})

describe('resolveOutboundImages rejects what Discord should not receive', () => {
  test('a non-image is refused', () => {
    const { root } = fixture()
    const txt = path.join(root, 'notes.txt')
    fs.writeFileSync(txt, 'hello')
    const { files, refusals } = resolveOutboundImages([txt], { roots: [root] })
    assert.equal(files.length, 0)
    assert.match(refusals[0], /not an image/)
  })

  test('a missing file is refused rather than crashing the call', () => {
    const { root } = fixture()
    const { files, refusals } = resolveOutboundImages([path.join(root, 'ghost.png')], { roots: [root] })
    assert.equal(files.length, 0)
    assert.equal(refusals.length, 1)
  })

  test('an oversized image is refused', () => {
    const { root } = fixture()
    const big = path.join(root, 'big.png')
    fs.writeFileSync(big, Buffer.alloc(MAX_OUTBOUND_BYTES + 1))
    const { files, refusals } = resolveOutboundImages([big], { roots: [root] })
    assert.equal(files.length, 0)
    assert.match(refusals[0], /exceeds/)
  })

  test('images beyond the per-call cap are refused, the first ones still go', () => {
    const { root } = fixture()
    const paths = []
    for (let i = 0; i < MAX_IMAGES + 2; i++) {
      const p = path.join(root, `shot-${i}.png`)
      fs.writeFileSync(p, PNG_1X1)
      paths.push(p)
    }
    const { files, refusals } = resolveOutboundImages(paths, { roots: [root] })
    assert.equal(files.length, MAX_IMAGES)
    assert.equal(refusals.length, 2)
  })

  test('no images at all is not an error', () => {
    assert.deepEqual(resolveOutboundImages(undefined, { roots: ['/tmp'] }), { files: [], refusals: [] })
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

describe('mimeFor', () => {
  test('known image extensions map, case-insensitively', () => {
    assert.equal(mimeFor('a.PNG'), 'image/png')
    assert.equal(mimeFor('a.jpeg'), 'image/jpeg')
    assert.equal(mimeFor('a.webp'), 'image/webp')
  })

  test('anything else is not an image', () => {
    assert.equal(mimeFor('a.txt'), null)
    assert.equal(mimeFor('a.pdf'), null)
    assert.equal(mimeFor('noext'), null)
  })
})
