#!/usr/bin/env node
// Build the attach page (#70) — assets/attach-index.html, the file ttyd is
// spawned with as `-I`.
//
//     npm run build-attach-index --prefix daemon
//
// ttyd inlines its whole client bundle into one index.html, so the built page
// is ~750 KB and it PINS the ttyd it was built from. That is the trade this
// ticket chose over generating the page at boot:
//
//   - The bytes served to a browser on the tailnet are in git, diffable, and
//     reviewed like every other curia surface.
//   - Nothing spawns, fetches or rewrites HTML on the daemon's boot path.
//   - A ttyd upgrade takes the attach surface DOWN, loudly, until someone runs
//     this and commits the result. Generating at boot would instead let the
//     surface change without anyone deciding — which is #69's whole lesson,
//     under a friendlier name.
//
// The stock index comes from a scratch ttyd on a loopback port rather than
// from the shared one: the shared one is already running with -I, so fetching
// it would build the new page out of the old page.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TTYD_BIN, DEFAULT_INDEX, CHROME_BASENAME, ttydVersion, stampMeta, sha256 } from '../src/attach.mjs'

const OUT = DEFAULT_INDEX
const CHROME = path.join(path.dirname(OUT), CHROME_BASENAME)

// ttyd 1.7.7 ships no viewport meta, and no flag can add one — a phone lays
// the page out at ~980 CSS px and scales it down, so a 15px font lands at
// about 5px of real screen (#69 defect 2). This is why a custom index is
// unavoidable rather than a preference.
const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1,'
  + 'maximum-scale=1,viewport-fit=cover">'

function die(msg) {
  console.error(`build-attach-index: ${msg}`)
  process.exit(1)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitListening(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port, timeout: 300 })
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
      s.once('timeout', () => { s.destroy(); resolve(false) })
    })
    if (up) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

// A stock ttyd, read-only (no -W) and loopback-bound, purely to read the index
// it serves. `true` is a command that exits at once — nothing ever attaches.
async function stockIndex() {
  const port = await freePort()
  const child = spawn(TTYD_BIN, ['-p', String(port), '-i', '127.0.0.1', 'true'], { stdio: 'ignore' })
  child.once('error', () => {})
  try {
    if (!(await waitListening(port, 5000))) die(`no scratch ttyd came up on :${port} — is ${TTYD_BIN} there?`)
    const res = await fetch(`http://127.0.0.1:${port}/`)
    if (!res.ok) die(`scratch ttyd answered ${res.status} for /`)
    return await res.text()
  } finally {
    child.kill('SIGTERM')
  }
}

const version = ttydVersion()
if (!version) die(`could not read \`${TTYD_BIN} --version\``)

let chrome
try {
  chrome = fs.readFileSync(CHROME, 'utf8')
} catch (e) {
  die(`cannot read the chrome source ${CHROME}: ${e.message}`)
}

let html = await stockIndex()

// Anchored at the FIRST <head> and the LAST </body></html>: the minified
// bundle inlined in the body can contain either marker as a string, and a
// global replace would corrupt it (spike #32 learned this the hard way).
const headAt = html.indexOf('<head>')
if (headAt === -1) die('stock ttyd index has no <head> — the injection points moved; fix this builder')
const bodyAt = html.lastIndexOf('</body></html>')
if (bodyAt === -1) die('stock ttyd index has no </body></html> — the injection points moved; fix this builder')
if (html.includes('name="viewport"')) die('stock ttyd index already carries a viewport meta — drop the injection here')

const stamp = stampMeta({ ttyd: version, chrome: sha256(chrome) })

// The stamp goes just inside <head>, not before the doctype: a comment ahead
// of <!DOCTYPE html> puts the browser in quirks mode.
const injected = html.slice(0, headAt + '<head>'.length)
  + stamp + VIEWPORT
  + html.slice(headAt + '<head>'.length, bodyAt)
  + chrome
  + html.slice(bodyAt)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, injected)
console.log(`wrote ${OUT}`)
console.log(`  ttyd    ${version}`)
console.log(`  chrome  ${sha256(chrome)}`)
console.log(`  size    ${(injected.length / 1024).toFixed(0)} KB`)
