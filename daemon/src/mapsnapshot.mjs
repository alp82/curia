import { resolveModel, spawnModelId } from './routing.mjs'
import { sectionBounds } from './resolve.mjs'

const FOG_HEADING = /^##\s+Not yet specified\s*$/i

// One complete map snapshot covers every open map. GitHub owns map and ticket
// state. The journal adapter adds the current agent and latest event without a
// history scan. Tests inject both adapters at this public boundary.

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name)
}

function typeOf(issue) {
  const label = labelsOf(issue).find((name) => name.startsWith('wayfinder:'))
  return label ? label.slice('wayfinder:'.length) : null
}

function ticketFact(issue) {
  return {
    number: issue.number,
    title: issue.title ?? '',
    type: typeOf(issue),
  }
}

function agentFact(fact, routing) {
  if (!fact) return null
  return {
    ...fact,
    model: fact.model ? spawnModelId(routing, fact.model) : null,
  }
}

export function fogFacts(body) {
  const section = sectionBounds(body, FOG_HEADING)
  if (!section) return []
  const source = section.lines.slice(section.start + 1, section.end).join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean)
    // A sub-heading inside the fog is a shape, not a patch of fog (#698). The
    // section is written by hand and by charting agents, and both group long
    // fog under `###` lines — counting those as facts would make an empty map
    // look uncertain and hold its close forever.
    .filter((line) => !/^#{1,6}\s/.test(line))
  if (lines[0] && /^none(?:\b|[.!])/i.test(lines[0])) return []
  return lines
    .filter((line) => line.replace(/[*_()]/g, '').trim().toLowerCase() !== 'empty')
    .map((line) => ({ text: line.replace(/^(?:[-*+] |\d+[.)] )/, '').trim() }))
    .filter((fact) => fact.text)
}

function latestStamp(stamps) {
  return stamps.filter((stamp) => Number.isFinite(Date.parse(stamp)))
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null
}

function categoriesOf(children) {
  const categories = { walked: [], in_flight: [], takeable: [], blocked: [] }
  for (const child of children) {
    if (child.state === 'closed') categories.walked.push(child)
    else if ((child.assignees ?? []).length > 0) categories.in_flight.push(child)
    else if ((child.issue_dependencies_summary?.blocked_by ?? 0) > 0) categories.blocked.push(child)
    else categories.takeable.push(child)
  }
  return categories
}

function latestEventAt(facts, fallbackStamps) {
  const latest = [...facts.values()]
    .filter((fact) => Number.isInteger(fact.latest_event_id))
    .sort((a, b) => a.latest_event_id - b.latest_event_id)
    .at(-1)
  return latest?.latest_event_at ?? latestStamp(fallbackStamps)
}

export async function readMapSnapshot({ watch, routing, github, journal }) {
  const repos = [...new Set(watch.map((entry) => entry.repo))]
  const maps = []

  for (const repo of repos) {
    const openMaps = (await github.repoMaps(repo)).filter((map) => map.state === 'open')
    for (const map of openMaps) {
      const children = (await github.mapFrontier(repo, map.number)).filter((child) => !child.pull_request)
      const facts = await journal.mapSnapshotFacts(repo, [map.number, ...children.map((child) => child.number)])
      const categories = categoriesOf(children)
      const blocked = await Promise.all(categories.blocked
        .map(async (child) => {
          const blockers = (await github.blockedByOf(repo, child.number))
            .filter((blocker) => blocker.state === 'open')
            .map((blocker) => ({ number: blocker.number, title: blocker.title ?? '' }))
          if (!blockers.length) {
            throw new Error(`blocked ticket ${repo}#${child.number} names no open blocker`)
          }
          return { ...ticketFact(child), blockers }
        }))
      const walked = categories.walked.map(ticketFact)
      const inFlight = categories.in_flight
        .map((child) => ({
          ...ticketFact(child),
          assignees: child.assignees.map((assignee) => assignee.login),
          agent: agentFact(facts.get(String(child.number))?.agent, routing),
        }))
      // LEVEL TWO RIDES THE SAME READ (#768). A blocked child already names
      // its open blockers, so what each takeable child DIRECTLY unblocks is
      // those edges walked the other way round, at no extra call. One level,
      // never a transitive closure, and only within this map: the operator's
      // question is which takeable ticket opens the most of THIS way.
      const takeable = categories.takeable
        .map((child) => ({
          ...ticketFact(child),
          model: spawnModelId(routing, resolveModel(routing, labelsOf(child), null)),
          unblocks: blocked
            .filter((item) => item.blockers.some((blocker) => blocker.number === child.number))
            .map((item) => ({ number: item.number, title: item.title })),
        }))
      const fog = fogFacts(map.body)
      maps.push({
        repo,
        number: map.number,
        title: map.title ?? '',
        url: map.html_url ?? `https://github.com/${repo}/issues/${map.number}`,
        // A PAUSED MAP IS STILL AN OPEN MAP (#700). This snapshot reads every
        // open map, deferred ones included, because hiding a pause is how a
        // pause becomes a disappearance. But a pause is only ever ended by
        // hand, so the flag rides along and every surface that could START
        // work on this map must honor it.
        deferred: labelsOf(map).includes('wayfinder:deferred'),
        walked,
        in_flight: inFlight,
        takeable,
        blocked,
        fog,
        counts: {
          walked: walked.length,
          in_flight: inFlight.length,
          takeable: takeable.length,
          blocked: blocked.length,
          fog: fog.length,
          total: walked.length + inFlight.length + takeable.length + blocked.length,
        },
        latest_event_at: latestEventAt(facts, [
          map.updated_at,
          ...children.map((child) => child.updated_at),
        ]),
      })
    }
  }

  return { computed_at: new Date().toISOString(), maps }
}

// The map snapshot the poll serves. `read()` NEVER waits on GitHub: it hands
// back the last computed value and, if a journal event marked it dirty, starts
// the refresh in the background. One refresh costs a `gh api` call per watched
// repo, per open map and per blocked child — twenty-odd process spawns on the
// live box, 18 to 28 seconds — which is why the poll must not sit on it.
// `refresh()` is the awaiting form, for boot and `/reconcile`, where the caller
// wants the reading that comes AFTER its own writes.
export class MapSnapshot {
  constructor(read, { onError = () => {} } = {}) {
    this.readSnapshot = read
    this.onError = onError
    this.value = { computed_at: null, maps: null, error: null }
    this.dirty = true
    this.pending = null
  }

  invalidate() {
    this.dirty = true
  }

  read() {
    if (this.dirty) this.refresh()
    return this.value
  }

  refresh() {
    if (this.pending) return this.pending
    if (!this.dirty) return Promise.resolve(this.value)
    this.pending = (async () => {
      try {
        do {
          this.dirty = false
          try {
            this.value = { ...(await this.readSnapshot()), error: null }
          } catch (error) {
            this.dirty = true
            this.value = { ...this.value, error: error.message }
            this.onError(error)
            break
          }
        } while (this.dirty)
      } finally {
        this.pending = null
      }
      return this.value
    })()
    return this.pending
  }
}
