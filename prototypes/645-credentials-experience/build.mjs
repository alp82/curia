// Builds the one self-contained page for wayfinder #645.
//
// It reads the REAL dashboard — `daemon/assets/dashboard.html` — and injects
// three things:
//
//   1. `proto.css` into the head, after the page's own tokens
//   2. `pre.js` as its own <script> BEFORE the page's script, so the canned
//      `fetch` is in place before the page's first poll
//   3. `post.js` at the END of the page's own <script>, inside its scope, so it
//      can read `SCREENS`, `NAMES`, `UI` and reassign the page's functions
//
// Reading the real page rather than copying it is the point: a credentials
// surface has to survive the density it actually lands in, and a variant judged
// on a blank route always looks fine. It also means the prototype re-picks up
// any dashboard change on the next build.
//
// Run `node build.mjs`, then open `index.html`. No server, no daemon, no network.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const source = path.join(repo, 'daemon', 'assets', 'dashboard.html')

const html = fs.readFileSync(source, 'utf8')
const css = fs.readFileSync(path.join(here, 'proto.css'), 'utf8')
const pre = fs.readFileSync(path.join(here, 'pre.js'), 'utf8')
const post = fs.readFileSync(path.join(here, 'post.js'), 'utf8')

// The page has exactly one <style> and one <script>, and the build refuses
// rather than guesses if that ever stops being true.
const styleEnd = html.indexOf('</style>')
const scriptStart = html.indexOf('<script>')
const scriptEnd = html.lastIndexOf('</script>')
if (styleEnd < 0 || scriptStart < 0 || scriptEnd < 0) throw new Error(`${source} no longer has the one <style> / one <script> shape this build injects into`)
if (html.indexOf('<script>', scriptStart + 1) !== -1) throw new Error(`${source} now carries more than one <script> — pick the right one before rebuilding`)

const banner = `<!-- PROTOTYPE — wayfinder #645, "what the operator sees, from the alarm to a
     healed agent". BUILT from daemon/assets/dashboard.html by build.mjs; edit
     pre.js / post.js / proto.css, never this file. Canned state, no daemon, no
     network. Throwaway: do not wire, do not promote. -->\n`

const out = banner
  + html.slice(0, styleEnd)
  + `\n/* ==== #645 prototype ==== */\n` + css
  + html.slice(styleEnd, scriptStart)
  + `<script>\n${pre}\n</script>\n`
  + html.slice(scriptStart, scriptEnd)
  + `\n/* ==== #645 prototype ==== */\n` + post
  + html.slice(scriptEnd)

const file = path.join(here, 'index.html')
fs.writeFileSync(file, out)
console.log(`wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB) from ${path.relative(repo, source)}`)
