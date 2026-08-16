// What one #readJournal costs, at the sizes the journal will reach (#303).
//
// Synthetic journal, shaped like the real one: mostly small operational lines,
// a tail of long-text lines (esc_open prompts, result summaries, verdicts).
// The real file lives on the operator's box and no agent container mounts it,
// so the shape is reconstructed from the event types the daemon writes.
//
// Run:  node docs/research/journal-scan-cost.bench.mjs [scratch-dir]
// The numbers it prints are the table in journal-scan-cost.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeEvent } from '../../daemon/src/journal.mjs'

const dir = process.argv[2] || path.join(os.tmpdir(), 'curia-journal-bench')
fs.mkdirSync(dir, { recursive: true })

const text = (n) => 'x'.repeat(n)

function line(i) {
  const ticket = 200 + (i % 120)
  const agent = `curia-${ticket}`
  const ts = new Date(Date.UTC(2026, 6, 24, 0, 0, 0) + i * 60_000).toISOString()
  const r = i % 20
  if (r === 0) return { seq: i, ts, type: 'agent_spawned', agent, ticket, repo: 'alp82/curia', model: 'opus', harness: 'claude', kind: 'ticket', instruction: null }
  if (r === 1) return { seq: i, ts, type: 'dispatch_claimed', agent, ticket, repo: 'alp82/curia', by: 'alp82' }
  if (r === 2) return { seq: i, ts, type: 'esc_open', agent, ticket, kind: 'free-text', id: `esc-${i}`, prompt: text(900) }
  if (r === 3) return { seq: i, ts, type: 'esc_answer', agent, ticket, id: `esc-${i - 1}`, answer: text(180), by: 'alp82' }
  if (r === 4) return { seq: i, ts, type: 'stop_blocked', agent, ticket, reason: 'the pull request is not open' }
  if (r === 5) return { seq: i, ts, type: 'result', agent, ticket, status: 'resolved', summary: text(700) }
  if (r === 6) return { seq: i, ts, type: 'ticket_resolved', agent, ticket, repo: 'alp82/curia', summary: text(300) }
  if (r === 7) return { seq: i, ts, type: 'pr_opened', agent, ticket, url: 'https://github.com/alp82/curia/pull/300' }
  if (r === 8) return { seq: i, ts, type: 'agent_note', agent, ticket, id: `note-${i}`, text: text(140), by: 'alp82' }
  if (r === 9) return { seq: i, ts, type: 'reviewer_spawned', agent: `curia-review-${ticket}`, ticket, repo: 'alp82/curia', model: 'gpt', same_provider: false }
  if (r === 10) return { seq: i, ts, type: 'notify', agent, ticket, message: text(220) }
  if (r === 11) return { seq: i, ts, type: 'thread_bound', ticket, thread_id: `1399${i}` }
  if (r === 12) return { seq: i, ts, type: 'review_answered', agent, ticket, approved: true, by: 'alp82' }
  if (r === 13) return { seq: i, ts, type: 'command', by: 'alp82', command: 'start', args: `curia#${ticket}` }
  if (r === 14) return { seq: i, ts, type: 'agent_done', agent, ticket }
  if (r === 15) return { seq: i, ts, type: 'lifecycle_closed', agent, ticket, repo: 'alp82/curia' }
  if (r === 16) return { seq: i, ts, type: 'status_line', agent, ticket, text: text(120) }
  if (r === 17) return { seq: i, ts, type: 'esc_render', id: `esc-${i - 15}`, message_id: `1399${i}` }
  if (r === 18) return { seq: i, ts, type: 'usage_read', provider: 'anthropic', pct: 0.42, resets_at: ts }
  return { seq: i, ts, type: 'agent_note_drained', agent, ticket }
}

function build(n) {
  const file = path.join(dir, `j-${n}.jsonl`)
  if (!fs.existsSync(file)) {
    const out = []
    for (let i = 0; i < n; i++) out.push(JSON.stringify(line(i)))
    fs.writeFileSync(file, out.join('\n') + '\n')
  }
  return file
}

// Verbatim shape of dispatch.mjs #readJournal.
function readJournal(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const events = []
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    try { events.push(normalizeEvent(JSON.parse(l))) } catch { /* torn tail */ }
  }
  return events
}

// The shape of #epochScan on top of one read.
function epochScan(journal, ticket, agentName) {
  let epochIdx = -1
  journal.forEach((ev, i) => {
    if ((ev.type === 'dispatch_claimed' || ev.type === 'agent_spawned') && String(ev.ticket ?? '') === ticket) epochIdx = i
  })
  const mine = (ev) => ev.agent === agentName || String(ev.ticket ?? '') === ticket
  const since = (pred) => journal.some((ev, i) => i > epochIdx && pred(ev))
  return {
    prOpened: since((ev) => ['pr_opened', 'pr_reused', 'land_repaired'].includes(ev.type) && mine(ev)),
    reviewApproved: since((ev) => ev.type === 'review_answered' && ev.approved === true && mine(ev)),
    blocks: journal.filter((ev, i) => i > epochIdx && ev.type === 'stop_blocked' && ev.agent === agentName).length,
  }
}

const sizes = [2_800, 10_000, 30_000, 60_000, 250_000]
const rows = []
for (const n of sizes) {
  const file = build(n)
  const bytes = fs.statSync(file).size
  // warm
  readJournal(file)
  const reps = n > 100_000 ? 5 : 20
  let t0 = performance.now()
  let j
  for (let k = 0; k < reps; k++) j = readJournal(file)
  const read = (performance.now() - t0) / reps
  t0 = performance.now()
  for (let k = 0; k < reps; k++) epochScan(j, '260', 'curia-260')
  const scan = (performance.now() - t0) / reps
  rows.push({ lines: n, MB: +(bytes / 1e6).toFixed(2), readMs: +read.toFixed(1), scanMs: +scan.toFixed(1), totalMs: +(read + scan).toFixed(1) })
}
console.table(rows)
