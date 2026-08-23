// Local cross-check of the aistack claude scan: same window, same dedup rule
// (key by message.id, keep the record with the largest cumulative usage).
// Reads CLAUDE_CONFIG_DIR/projects/**/*.jsonl. Prints per-model token counts.
import fs from 'node:fs'
import path from 'node:path'

const roots = (process.env.CLAUDE_CONFIG_DIR ?? '').split(',').filter(Boolean)
  .map((d) => path.join(d.trim(), 'projects'))
const now = new Date()
const windowStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * 86400000

function* walk(dir) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(full)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full
  }
}

const seen = new Map() // message.id -> { total, model, counts }
let files = 0
let lines = 0
for (const root of roots) {
  for (const file of walk(root)) {
    files++
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      lines++
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      const ts = Date.parse(rec.timestamp ?? '')
      if (!Number.isFinite(ts) || ts < windowStart) continue
      const u = rec?.message?.usage
      if (!u) continue
      const counts = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
      }
      const total = counts.input + counts.output + counts.cacheWrite + counts.cacheRead
      const id = rec.message.id ?? `${file}:${lines}`
      const prev = seen.get(id)
      if (!prev || total > prev.total) {
        seen.set(id, { total, model: rec.message.model ?? '(unknown)', counts })
      }
    }
  }
}

const perModel = {}
for (const { model, counts } of seen.values()) {
  const m = (perModel[model] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, responses: 0 })
  m.input += counts.input
  m.output += counts.output
  m.cacheWrite += counts.cacheWrite
  m.cacheRead += counts.cacheRead
  m.responses += 1
}
const grand = Object.values(perModel).reduce((s, m) => s + m.input + m.output + m.cacheWrite + m.cacheRead, 0)
console.log(JSON.stringify({
  windowFrom: new Date(windowStart).toISOString(),
  roots, files, lines, responses: seen.size, perModel, grandTotal: grand,
}, null, 2))
