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

// The decisions #415 owes map #413, taken from the operator's answers in the
// #415 thread. The first is the shape they picked. The other two are the two
// questions the ticket names.
export const DECISIONS = [
  {
    q: 'Which card shape wins?',
    a: 'Card 4. A headline, the options with one consequence each, an example where it earns its line, and a width-capped visual.',
  },
  {
    q: 'Are examples mandatory per kind, or agent judgment?',
    a: 'Agent judgment. The mandatory floor is the headline, the options, and one consequence per option. The example and the visual are judgment fields. The rehearsal shows both costs of forcing them: option C\'s example restates its own consequence, and card 4 came out SHORTER than card 3, because a visual that earns its place replaces prose instead of sitting beside it.',
  },
  {
    q: 'Which Details affordance wins?',
    a: 'Two typed fields, not one affordance. A short detail renders as a spoiler inside the card. The timeline link is the second field, and curia composes it from its own records, so the agent never writes it. The agent judges which field carries what, under two rules: a character cap on the spoiler, and facts in the spoiler with the reasoning on the timeline. 200 characters is this prototype\'s proposal for the cap. ADR #417 locks the number. The follow-up small print is dropped, because #414 caps it at one line.',
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
