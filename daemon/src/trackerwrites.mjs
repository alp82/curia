// A proposed tracker wave is pure data until the review gate approves it.
// This renderer assigns temporary card numbers and preserves every native edge.

const clean = (value) => String(value ?? '').trim()

export function trackerWriteWaves(items = []) {
  if (!Array.isArray(items) || items.length === 0) return ''
  const rows = items.map((raw, index) => ({
    number: index + 1,
    id: clean(raw?.id) || String(index + 1),
    title: clean(raw?.title),
    labels: [...new Set((raw?.labels ?? []).map(clean).filter(Boolean))],
    after: [...new Set((raw?.after ?? []).map(clean).filter(Boolean))],
  }))
  const byId = new Map()
  for (const row of rows) {
    if (!row.title) throw new Error(`tracker write ${row.number} has no title`)
    if (byId.has(row.id)) throw new Error(`tracker write id "${row.id}" is repeated`)
    byId.set(row.id, row)
  }
  for (const row of rows) {
    for (const blocker of row.after) {
      if (!byId.has(blocker)) throw new Error(`tracker write ${row.number} names unknown item "${blocker}"`)
      if (blocker === row.id) throw new Error(`tracker write ${row.number} has a dependency cycle`)
    }
  }

  const pending = new Set(rows.map((row) => row.id))
  const done = new Set()
  const waves = []
  while (pending.size) {
    const wave = rows.filter((row) => pending.has(row.id) && row.after.every((id) => done.has(id)))
    if (!wave.length) throw new Error('tracker write proposal has a dependency cycle')
    waves.push(wave)
    for (const row of wave) {
      pending.delete(row.id)
      done.add(row.id)
    }
  }

  const lines = ['**Proposed tracker writes**', 'Nothing is published until this gate is approved.']
  for (let index = 0; index < waves.length; index += 1) {
    lines.push('', `-# wave ${index + 1}${index === 0 ? ' - nothing blocks these' : ''}`)
    for (const row of waves[index]) {
      lines.push(`**${row.number}. ${row.title}**`)
      lines.push(`label: ${row.labels.length ? row.labels.map((label) => `\`${label}\``).join(', ') : 'none'}`)
      for (const blocker of row.after) {
        lines.push(`after ${byId.get(blocker).number} - native blocked-by edge`)
      }
    }
  }
  return lines.join('\n')
}
