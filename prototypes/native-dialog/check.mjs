// PROTOTYPE (#538) — run parseDialog (extracted from index.html, so the demo
// and this check cannot drift) against the LIVE captures in evidence/ and the
// #542 rewind capture. Prints one line per capture: parsed shape or null.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
const start = html.indexOf('const DIALOG_MARKERS')
const end = html.lastIndexOf('/* =====', html.indexOf('THROWAWAY PAGE'))
const module_ = html.slice(start, end)
const fn = new Function(`${module_}; return { parseDialog, answerPlan }`)
const { parseDialog, answerPlan } = fn()

const files = fs.readdirSync(path.join(DIR, 'evidence')).filter((f) => f.endsWith('.txt')).sort()
files.push('../../pane-rewind/evidence/claude-2-menu.txt')
for (const f of files) {
  const pane = fs.readFileSync(path.join(DIR, 'evidence', f), 'utf8')
  const m = parseDialog(pane)
  if (!m) { console.log(`${f}: NULL (banner fallback)`); continue }
  console.log(`${f}: ${m.harness}/${m.kind} header=${m.header ?? '-'} tabs=${m.tabs ?? '-'} opts=${m.options.length} sel=${m.options.find((o) => o.selected)?.n} q="${m.question.slice(0, 50)}"`)
  for (const o of m.options) console.log(`    ${o.n}. [${o.checked === null ? ' ' : o.checked ? 'x' : 'o'}]${o.synth ? ` (${o.synth})` : ''} ${o.label.slice(0, 60)}${o.desc ? ` — ${o.desc.slice(0, 40)}` : ''}`)
  console.log(`    plan(tap 2): ${JSON.stringify(answerPlan(m, 2))}`)
}
