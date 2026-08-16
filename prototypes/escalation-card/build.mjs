// Builds the one self-contained card page for ticket #415.
//
// It inlines three things into `template.html` and writes `index.html`:
//   1. the VARIANTS array from `variants.mjs`
//   2. the SUBJECT block from `variants.mjs`
//   3. the DECISIONS array below — the two answers this ticket owes the map
//
// The page needs no network. Run `node build.mjs` after any edit to
// `variants.mjs`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VARIANTS, SUBJECT } from './variants.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// The two decisions #415 owes map #413. Filled in from the operator's answer.
export const DECISIONS = [
  {
    q: 'Are examples mandatory per kind, or agent judgment?',
    a: 'Not yet answered by the operator.',
  },
  {
    q: 'Which Details affordance wins?',
    a: 'Not yet answered by the operator.',
  },
]

const template = fs.readFileSync(path.join(here, 'template.html'), 'utf8')
const subs = [
  ['const VARIANTS = []', `const VARIANTS = ${JSON.stringify(VARIANTS)}`],
  ['const SUBJECT = {}', `const SUBJECT = ${JSON.stringify(SUBJECT)}`],
  ['const DECISIONS = []', `const DECISIONS = ${JSON.stringify(DECISIONS)}`],
]

let html = template
for (const [marker, value] of subs) {
  if (!html.includes(marker)) throw new Error(`template.html no longer contains "${marker}"`)
  html = html.replace(marker, value)
}

const out = path.join(here, 'index.html')
fs.writeFileSync(out, html)
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB, ${VARIANTS.length} mocks)`)

// A card that outruns 1600 characters is split by `chunkMessage()`, and #414
// showed a split inside a fence breaks both fences. Print the widths so the
// margin is visible.
for (const v of VARIANTS) {
  const bodies = [v.source].concat(v.followUp ? [v.followUp] : [])
  const widest = Math.max(...v.source.split('\n').map((l) => l.length))
  console.log(`  ${String(v.n).padStart(2, '0')} ${v.name}: ${bodies.map((b) => b.length).join(' + ')} chars, widest line ${widest}`)
}
