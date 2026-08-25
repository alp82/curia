// The preview expectation (#735). The rule that decides whether a task has a
// page to look at, read off the gate's own diff digest.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  PREVIEW_RULE, NO_PREVIEW_LINE, rendersAPage, pageFiles, previewExpectation,
} from '../src/previewgate.mjs'

const digestOf = (...paths) => ({ files: paths.length, list: paths.map((p) => ({ path: p })) })

describe('what counts as a page (#735)', () => {
  test('markup, styles, components and templates do', () => {
    for (const p of [
      'web/index.html', 'web/app.css', 'ui/theme.scss', 'app/Card.tsx', 'app/Card.jsx',
      'ui/Panel.vue', 'ui/Panel.svelte', 'site/page.astro',
      'views/show.ejs', 'views/show.hbs', 'views/show.pug', 'views/show.njk',
      'views/show.liquid', 'views/show.twig', 'views/show.erb', 'views/show.blade.php',
    ]) assert.equal(rendersAPage(p), true, p)
  })

  test('server code, schema and config do not', () => {
    for (const p of [
      'daemon/src/dispatch.mjs', 'api/handler.ts', 'api/handler.js', 'db/schema.sql',
      'cmd/main.go', 'lib/thing.py', 'config/curia.yaml', 'package.json', 'Dockerfile',
    ]) assert.equal(rendersAPage(p), false, p)
  })

  test('tests, docs and generated files never make a task applicable', () => {
    // The gate ranks by the same classifier, so one file has one class here and
    // on the card. A snapshot page is not a page the operator reviews.
    for (const p of [
      'test/__snapshots__/page.html', 'docs/adr/0026-look.md', 'docs/mockup.html',
      'dist/app.css', 'web/vendor/bootstrap.css', 'app/Card.test.tsx',
      'e2e/checkout.html', 'build/index.html', 'site/styles.min.css',
    ]) assert.equal(rendersAPage(p), false, p)
  })
})

describe('the expectation the gate acts on (#735)', () => {
  test('a backend-only change expects nothing, and costs nothing', () => {
    const e = previewExpectation({ digest: digestOf('daemon/src/dispatch.mjs', 'daemon/test/dispatch.test.mjs') })
    assert.equal(e.expected, false)
    assert.equal(e.bounce, null)
    assert.equal(e.line, null)
  })

  test('a diff curia could not count is never treated as applicable', () => {
    // #355: null is not empty, and an absence of evidence must not render as a
    // fact. An uncounted gate asks for nothing.
    for (const digest of [null, undefined, {}]) {
      assert.equal(previewExpectation({ digest }).expected, false)
    }
  })

  test('a page change with a published preview asks for nothing', () => {
    const e = previewExpectation({
      digest: digestOf('web/app.css'),
      preview: { url: 'https://box.ts.net:8500/curia-check' },
    })
    assert.equal(e.expected, false)
    assert.equal(e.bounce, null)
  })

  test('a page change with no preview is bounced once, with the rule and both ways out', () => {
    const e = previewExpectation({ digest: digestOf('web/index.html', 'daemon/src/x.mjs') })
    assert.equal(e.expected, true)
    assert.deepEqual(e.paths, ['web/index.html'])
    assert.match(e.bounce, /no gate yet/)
    assert.match(e.bounce, /web\/index\.html/)
    assert.ok(e.bounce.includes(PREVIEW_RULE), 'the rule the agent must satisfy is printed')
    assert.match(e.bounce, /publish_preview/)
    assert.match(e.bounce, /call `request_review` again/)
    assert.equal(e.line, null)
  })

  test('the bounce names a few files and counts the rest', () => {
    const e = previewExpectation({ digest: digestOf('a.css', 'b.css', 'c.css', 'd.css', 'e.css') })
    assert.match(e.bounce, /• a\.css/)
    assert.match(e.bounce, /• c\.css/)
    assert.ok(!e.bounce.includes('• d.css'), 'the list stops')
    assert.match(e.bounce, /and 2 more/)
  })

  test('the second call opens the gate and carries the absence as a line', () => {
    const e = previewExpectation({ digest: digestOf('web/index.html'), asked: true })
    assert.equal(e.expected, true)
    assert.equal(e.bounce, null, 'review is never blocked')
    assert.equal(e.line, NO_PREVIEW_LINE)
    assert.match(e.line, /curia asked for one/)
  })

  test('pageFiles keeps the digest order it was given', () => {
    assert.deepEqual(
      pageFiles(digestOf('daemon/src/a.mjs', 'z.css', 'a.html')),
      ['z.css', 'a.html'],
    )
  })
})
