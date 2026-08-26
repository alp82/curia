// The preview expectation at the review gate (#735, on #685's map).
//
// #40 gave the daemon the only honest preview link there is: one it allocated
// itself, through `publish_preview`, and #563 made that allocation survive a
// restart. The gate has always PRINTED that link when one existed. What it
// never did was NOTICE when one should have and did not — so a change to a
// page reached the operator as a diff and a pull request, and the one thing
// the operator wanted to do with it, look at it, was the thing curia had not
// set up.
//
// This module answers one question, from evidence curia already counted:
//
//   does this change have a page to look at?
//
// THE RULE, in these words, because a rule the agent cannot read is a rule it
// cannot satisfy — the refusal prints it verbatim:
//
//   A task is applicable when its committed diff changes at least one SOURCE
//   file that renders a page: markup, styles, a component, or a template.
//   Tests, docs and generated files never make a task applicable, and a change
//   of only server code, schema or config never does.
//
// The evidence is the gate's own diff digest (#355) — the file list curia
// measured at the instant the gate opened, against the merge base. Nothing
// here asks the agent what its change was about, for the same reason #40 does
// not take a `preview_url` from it: at the gate, the agent's account of the
// work is the thing being judged, not the thing deciding what to judge.
//
// classOf (diffdigest.mjs) is reused rather than re-implemented: it is what the
// gate card already ranks by, and one classifier means one answer. A snapshot
// `.html` under `__tests__/` and a mock-up in `docs/` are both changes to a
// page, and neither is a page the operator reviews.
//
// IT NEVER BLOCKS REVIEW. An applicable gate that carries no preview is
// BOUNCED ONCE, with the rule and both ways out. The second call opens, and the
// card says curia asked and got nothing — a fact the operator can weigh, which
// is what a gate is for. Backend-only work never sees any of this, and a diff
// curia could not count is never treated as applicable: an unreadable digest is
// an absence of evidence, and #355 settled that it must not render as a fact.

import { classOf } from './diffdigest.mjs'

// Printed on the bounce. One sentence, and one an agent can act on.
export const PREVIEW_RULE = 'a task needs a preview when its diff changes a source file that renders a page — markup, styles, a component or a template; tests, docs and generated files do not count, and neither does server code, schema or config'

// The extensions that render a page. Deliberately narrow: an extension that is
// sometimes a page and usually not (`.js`, `.ts`, `.json`, `.yaml`) is left out,
// because a false expectation costs every backend ticket one bounced call, and a
// missed one costs a link the agent can still publish by hand. `.md` and `.mdx`
// are out for a second reason on top: `classOf` calls them doc, and one
// classifier means one answer here and on the card.
const PAGE_EXT = /\.(html?|css|s[ac]ss|less|styl|jsx|tsx|vue|svelte|astro|ejs|hbs|handlebars|pug|jade|njk|liquid|twig|erb|haml|slim|blade\.php)$/i

// One file. `true` when changing it changes something a person can look at.
export function rendersAPage(file) {
  const p = String(file ?? '')
  if (!PAGE_EXT.test(p)) return false
  // Only source. `classOf` asks generated first, so a built `dist/app.css` and a
  // `__snapshots__` page are out for the same reason a doc mock-up is.
  return classOf(p) === 'source'
}

// The applicable files in one digest, in the digest's own ranked order. An
// absent or uncounted digest yields none — never an expectation.
export function pageFiles(digest) {
  return (digest?.list ?? []).map((f) => f.path).filter((p) => rendersAPage(p))
}

// How many of the applicable paths the bounce names. Enough to show the agent
// what curia saw, short enough for a tool result.
const NAMED = 3

export function bounceText(paths) {
  const named = paths.slice(0, NAMED)
  const rest = paths.length - named.length
  return [
    '❌ no gate yet — this change touches a page and no preview is published.',
    '',
    ...named.map((p) => `• ${p}`),
    ...(rest > 0 ? [`• …and ${rest} more`] : []),
    '',
    `curia asks for one because ${PREVIEW_RULE}.`,
    '',
    'Two ways on, and both end at the gate:',
    '• Start your dev server, call `publish_preview` with its port and the PATH the change is on, then call `request_review` again. Curia allocates the link and puts it on the card itself.',
    '• If there is nothing to look at — no dev server serves this, or the change is one the operator would only read — say which in your summary and call `request_review` again. The second call opens the gate, and the card says curia asked and got no preview.',
  ].join('\n')
}

// The line the gate card carries when the second call opens without one. It
// sits with the other links, in the place the preview would have taken, because
// its absence is the fact it replaces.
export const NO_PREVIEW_LINE = '_No preview — curia asked for one on this change and none was published; the summary should say why._'

// The gate's whole decision, in one call:
//
//   { expected, paths, bounce, line }
//
// `bounce` is set only on the first applicable call with no preview, and the
// caller refuses with it. `line` is set on the second, and the caller pushes it
// onto the links. Both are null for a published preview and for backend-only
// work, which is the case that must cost nothing.
export function previewExpectation({ digest, preview = null, asked = false } = {}) {
  if (preview?.url) return { expected: false, paths: [], bounce: null, line: null }
  const paths = pageFiles(digest)
  if (!paths.length) return { expected: false, paths: [], bounce: null, line: null }
  if (asked) return { expected: true, paths, bounce: null, line: NO_PREVIEW_LINE }
  return { expected: true, paths, bounce: bounceText(paths), line: null }
}
