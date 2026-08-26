import fs from 'node:fs'
import path from 'node:path'

import { detectHarness, parseLine } from './transcript.mjs'

const MAX_FILES = 500
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024

const labelsOf = (issue) => (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name)

function mapDecisions(issue, query) {
  const lines = String(issue.body ?? '').split('\n')
  const start = lines.findIndex((line) => /^##\s+Decisions(?:\s+so\s+far)?\s*$/i.test(line.trim()))
  if (start < 0) return []
  const out = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (/^##\s+/.test(line)) break
    const text = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '').trim()
    if (!text || !text.toLowerCase().includes(String(query).toLowerCase())) continue
    out.push({
      kind: 'decision',
      id: `decision:${issue.repository?.nameWithOwner ?? issue.repo}#${issue.number}:${index}`,
      title: text,
      snippet: `Decision on ${issue.title}`,
      updated_at: issue.updatedAt ?? issue.updated_at,
      url: issue.url,
    })
  }
  return out
}

export function githubSearchSource({ repos, searchIssues }) {
  return {
    async search(query) {
      const groups = await Promise.all(repos().map((repo) => searchIssues(repo, query)))
      return groups.flat().flatMap((issue) => {
        const map = labelsOf(issue).includes('wayfinder:map')
        const result = {
          kind: map ? 'map' : 'ticket',
          id: `${issue.repository?.nameWithOwner ?? issue.repo}#${issue.number}`,
          map: map ? issue.number : undefined,
          conversation: map ? undefined : `curia-${issue.number}`,
          title: issue.title,
          snippet: issue.body ?? '',
          updated_at: issue.updatedAt ?? issue.updated_at,
          url: issue.url,
          attention: labelsOf(issue).find((label) => label === 'needs-info' || label === 'ready-for-human') ?? null,
        }
        return map ? [result, ...mapDecisions(issue, query)] : [result]
      })
    },
  }
}

export function journalSearchSource(db) {
  return {
    async search(query) {
      const pattern = `%${String(query).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      return db.prepare(`
        select id, ts, type, body from events
         where body like ? escape '\\'
         order by id desc limit 50
      `).all(pattern).map((row) => {
        let event = {}
        try { event = JSON.parse(row.body) } catch {}
        return {
          kind: 'journal', id: String(row.id), title: String(row.type),
          snippet: event.message ?? event.prompt ?? event.text ?? row.body,
          at: row.ts,
          attention: String(row.type).includes('failed') || String(row.type).includes('refused') ? 'warning' : null,
        }
      })
    },
  }
}

async function transcriptFiles(root) {
  const files = []
  const walk = async (dir) => {
    if (files.length >= MAX_FILES) return
    let entries = []
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file)
    }
  }
  await walk(root)
  return files
}

function conversationFor(file, cfgDir, sessions) {
  if (path.basename(cfgDir) !== 'curia-overseer') return path.basename(cfgDir)
  const session = path.basename(file, '.jsonl').replace(/^rollout-.*-([0-9a-f-]+)$/i, '$1')
  const key = sessions.get(session)
  return key ? `curia-${key}` : session
}

export function transcriptSearchSource({ workspaceRoot, overseerSessions = () => [] }) {
  return {
    async search(query) {
      const wanted = String(query).toLowerCase()
      const roots = path.join(workspaceRoot, 'cfg')
      const sessionKeys = new Map(overseerSessions().map(({ key, session }) => [String(session), String(key)]))
      const results = []
      let bytesRead = 0
      for (const file of await transcriptFiles(roots)) {
        if (results.length >= 50) break
        const relative = path.relative(roots, file).split(path.sep)
        const cfgDir = path.join(roots, relative[0])
        const harness = detectHarness(cfgDir)
        if (!harness) continue
        let stat
        try { stat = await fs.promises.stat(file) } catch { continue }
        if (stat.size > MAX_FILE_BYTES || bytesRead + stat.size > MAX_TOTAL_BYTES) continue
        let lines
        try { lines = (await fs.promises.readFile(file, 'utf8')).split('\n') } catch { continue }
        bytesRead += stat.size
        for (const line of lines) {
          if (!line.toLowerCase().includes(wanted)) continue
          const parsed = parseLine(harness, line)
          for (const item of parsed.items ?? []) {
            const text = String(item.text ?? item.brief ?? '').trim()
            if (!text.toLowerCase().includes(wanted)) continue
            const conversation = conversationFor(file, cfgDir, sessionKeys)
            results.push({
              kind: 'chat', id: `${path.basename(cfgDir)}:${conversation}`,
              conversation, title: `Chat ${conversation}`, snippet: text, at: item.at ?? stat.mtime.toISOString(),
            })
            break
          }
          if (results.length >= 50) break
        }
      }
      return results
    },
  }
}
