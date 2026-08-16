// Builds the one self-contained catalog page for ticket #414.
//
// It inlines two things into `template.html` and writes `index.html`:
//   1. the FORMS array from `forms.mjs`
//   2. the image probe, as a base64 data URI, so the page needs no network
//
// Run `node make-probe.mjs` first if the probe changed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORMS } from './forms.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// A form names its picture as `IMAGE:<file>`. Every one becomes a base64 data
// URI, so the page carries its own evidence and needs no network.
function inlineImage(token) {
  const file = token.slice('IMAGE:'.length)
  const bytes = fs.readFileSync(path.join(here, file))
  return `data:image/png;base64,${bytes.toString('base64')}`
}

const forms = FORMS.map((f) => (f.image?.startsWith('IMAGE:') ? { ...f, image: inlineImage(f.image) } : f))

const template = fs.readFileSync(path.join(here, 'template.html'), 'utf8')
const marker = 'const FORMS = []'
if (!template.includes(marker)) throw new Error(`template.html no longer contains "${marker}"`)

const html = template.replace(marker, `const FORMS = ${JSON.stringify(forms)}`)
const out = path.join(here, 'index.html')
fs.writeFileSync(out, html)
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB, ${forms.length} forms)`)
