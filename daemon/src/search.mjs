// Atlas global search (#693). This module owns the query contract and typed
// landing targets. Source adapters own storage and retrieval. Discord thread
// bodies are deliberately absent from the supported source set.

export const SEARCH_SOURCES = Object.freeze(['github', 'journal', 'transcripts'])
export const MAX_SEARCH_QUERY = 200

function landingFor(row) {
  switch (row.kind) {
    case 'ticket':
    case 'chat':
      return { surface: 'chat', conversation: String(row.conversation ?? row.id) }
    case 'map':
      return { surface: 'maps', map: Number(row.map ?? String(row.id).match(/#(\d+)$/)?.[1]) }
    case 'decision':
      return { surface: 'github', url: String(row.url) }
    case 'journal':
      return { surface: 'feed', event: String(row.id) }
    default:
      throw new Error(`unsupported search result kind "${row.kind}"`)
  }
}

function resultOnWire(row, now) {
  const stamp = Date.parse(row.at ?? row.updated_at ?? '')
  return {
    kind: String(row.kind),
    id: String(row.id),
    title: String(row.title ?? ''),
    snippet: String(row.snippet ?? ''),
    age_s: Number.isFinite(stamp) ? Math.max(0, Math.floor((now - stamp) / 1000)) : null,
    attention: row.attention == null ? null : String(row.attention),
    landing: landingFor(row),
  }
}

export class GlobalSearch {
  constructor({ now = Date.now, ...sources }) {
    for (const name of Object.keys(sources)) {
      if (!SEARCH_SOURCES.includes(name)) throw new Error(`unsupported search source "${name}"`)
    }
    for (const name of SEARCH_SOURCES) {
      if (typeof sources[name]?.search !== 'function') throw new Error(`search source "${name}" has no search interface`)
    }
    this.sources = sources
    this.now = now
  }

  async query(raw, { limit = 50 } = {}) {
    const query = String(raw ?? '').trim()
    if (!query) throw new Error('search query has no words')
    if (query.length > MAX_SEARCH_QUERY) throw new Error(`search queries may not exceed ${MAX_SEARCH_QUERY} characters`)

    const settled = await Promise.all(SEARCH_SOURCES.map(async (source) => {
      try {
        const rows = await this.sources[source].search(query)
        return { source, rows: Array.isArray(rows) ? rows : [] }
      } catch (error) {
        return { source, error: error?.message ?? String(error) }
      }
    }))
    const results = []
    const errors = []
    const now = this.now()
    for (const part of settled) {
      if (part.error) {
        errors.push({ source: part.source, error: part.error })
        continue
      }
      for (const row of part.rows) {
        if (results.length >= limit) break
        results.push(resultOnWire(row, now))
      }
    }
    return { query, results, errors }
  }
}
