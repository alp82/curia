// Facts for one Atlas map. This module stays pure so tests can supply GitHub
// facts and journal events without starting the daemon.

const labelsOf = (item) => (item?.labels ?? []).map((label) => typeof label === 'string' ? label : label.name)

const typeOf = (item) => {
  const label = labelsOf(item).find((name) => String(name).startsWith('wayfinder:'))
  return label ? String(label).slice('wayfinder:'.length) : 'untyped'
}

const itemFact = (item) => ({
  number: item.number,
  title: item.title ?? '',
  labels: labelsOf(item),
  type: typeOf(item),
})

export function fogOf(body = '') {
  const lines = String(body).replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+not yet specified\s*$/i.test(line.trim()))
  if (start < 0) return []
  const section = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break
    const text = line.trim()
      .replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, '')
      .replace(/^\d+[.)]\s+/, '')
      .trim()
    if (!text || /^(none|nothing|n\/a)[.!]?$/i.test(text)) continue
    section.push(text)
  }
  return section
}

function latestStamp(map, items, events, repo) {
  const children = new Set(items.map((item) => String(item.number)))
  const stamps = [map.updated_at, ...items.map((item) => item.updated_at)]
  for (const event of events ?? []) {
    if (event.repo && event.repo !== repo) continue
    const isMap = event.map != null && String(event.map) === String(map.number)
    const isChild = event.ticket != null && children.has(String(event.ticket))
    if (isMap || isChild) stamps.push(event.ts ?? event.at)
  }
  return stamps
    .filter((stamp) => stamp && Number.isFinite(Date.parse(stamp)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
}

export function completeMaps({ repo, maps, activeMapNumbers, mapItems, edges, routing, resolveModel, events = [] }) {
  const active = new Set((activeMapNumbers ?? []).map(Number))
  return (maps ?? [])
    .filter((map) => active.has(Number(map.number)))
    .map((map) => {
      const items = mapItems?.[map.number] ?? []
      const walked = items.filter((item) => item.state === 'closed').map(itemFact)
      const inFlight = items
        .filter((item) => item.state === 'open' && !item.pull_request && (item.assignees ?? []).length > 0)
        .map(itemFact)
      const blocked = items
        .filter((item) => item.state === 'open' && !item.pull_request && (item.assignees ?? []).length === 0)
        .filter((item) => (item.issue_dependencies_summary?.blocked_by ?? 0) > 0)
        .map((item) => ({
          ...itemFact(item),
          blockers: (edges?.[item.number] ?? [])
            .filter((blocker) => blocker.state === 'open')
            .map((blocker) => ({ number: blocker.number, title: blocker.title ?? '' })),
        }))
      const takeable = items
        .filter((item) => item.state === 'open' && !item.pull_request && (item.assignees ?? []).length === 0)
        .filter((item) => (item.issue_dependencies_summary?.blocked_by ?? 0) === 0)
        .map((item) => ({
          ...itemFact(item),
          model: resolveModel(routing, labelsOf(item), null),
        }))
      const fog = fogOf(map.body)
      return {
        repo,
        number: map.number,
        title: map.title ?? '',
        latest_event_at: latestStamp(map, items, events, repo),
        counts: {
          walked: walked.length,
          in_flight: inFlight.length,
          takeable: takeable.length,
          blocked: blocked.length,
          fog: fog.length,
        },
        walked,
        in_flight: inFlight,
        takeable,
        blocked,
        fog,
      }
    })
}
