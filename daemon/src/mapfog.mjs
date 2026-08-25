const FOG_HEADING = /^##\s+Not yet specified\s*$/i
const NEXT_SECTION = /^##\s+/
const HTML_COMMENT = /<!--[\s\S]*?-->/g

export const MAP_FOG_VERB = 'empty-map-verdict'
export const CLEAR_MAP_FOG = 'Clear fog and close'
export const KEEP_MAP_OPEN = 'Keep map open'

function fogBounds(body) {
  const lines = String(body ?? '').split('\n')
  const start = lines.findIndex((line) => FOG_HEADING.test(line))
  if (start === -1) return { lines, start: -1, end: -1 }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (NEXT_SECTION.test(lines[i])) {
      end = i
      break
    }
  }
  return { lines, start, end }
}

export function mapFog(body) {
  const bounds = fogBounds(body)
  if (bounds.start === -1) return { found: false, text: '' }
  const text = bounds.lines
    .slice(bounds.start + 1, bounds.end)
    .join('\n')
    .replace(HTML_COMMENT, '')
    .trim()
  return { found: true, text }
}

export function clearMapFog(body) {
  const source = String(body ?? '')
  const bounds = fogBounds(source)
  if (bounds.start === -1 || !mapFog(source).text) return source
  const comments = bounds.lines
    .slice(bounds.start + 1, bounds.end)
    .join('\n')
    .match(HTML_COMMENT) ?? []
  const section = ['', ...comments.flatMap((comment, i) => (i ? ['', comment] : [comment])), '']
  return [
    ...bounds.lines.slice(0, bounds.start + 1),
    ...section,
    ...bounds.lines.slice(bounds.end),
  ].join('\n')
}

export function mapFogQuestion(repo, map) {
  const fog = mapFog(map?.body)
  const remaining = fog.text.replace(/\s+/g, ' ')
  const detail = remaining
    ? `Remaining fog: ${remaining}`
    : 'No meaningful fog remains under Not yet specified.'
  const payload = {
    headline: `Map ${repo}#${map.number} has no open tickets. What should Curia do?`,
    options: [
      {
        label: CLEAR_MAP_FOG,
        handle: 'Clear and close',
        consequence: 'Curia posts your verdict, removes retained fog, checks the map again, and closes it when no child remains open.',
      },
      {
        label: KEEP_MAP_OPEN,
        handle: 'Keep open',
        consequence: 'Curia posts your verdict and leaves the map open with its current fog.',
      },
    ],
    detail: detail.length <= 500 ? detail : `${detail.slice(0, 499)}…`,
  }
  return {
    kind: 'choice',
    prompt: [payload.headline, ...payload.options.map((o) => `${o.label}: ${o.consequence}`), payload.detail].join('\n\n'),
    options: payload.options.map((o) => o.label),
    payload,
    action: { verb: MAP_FOG_VERB, repo, map: Number(map.number) },
  }
}
