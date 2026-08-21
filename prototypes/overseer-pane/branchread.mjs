// PROTOTYPE (#570) — the branch-aware read, the fix the linear scan needs.
//
// The chat page's pane path scans a claude transcript line by line, so after a
// pane rewind it shows BOTH branches (chatread-5-after-fork.jsonl). The
// transcript itself names the active branch: every conversation line carries
// uuid + parentUuid, and a rewind makes the NEXT user turn point at an earlier
// parent. Walking parents from the LAST conversation line yields exactly the
// active branch. This script is that walk, feeding the daemon's own parseLine —
// the shape a build change to the tailer would take.
//
// Usage: node branchread.mjs <transcript.jsonl>

import fs from 'node:fs'
import { parseLine } from '../../daemon/src/transcript.mjs'

const file = process.argv[2]
const raw = fs.readFileSync(file, 'utf8').trim().split('\n')

const byUuid = new Map()
let tail = null
for (const line of raw) {
  let e
  try { e = JSON.parse(line) } catch { continue }
  if (!e?.uuid) continue // bookkeeping lines carry no uuid and sit outside the chain
  byUuid.set(e.uuid, line)
  tail = e // the last uuid-carrying line is the head of the active branch
}

const chain = []
for (let e = tail; e; e = e.parentUuid ? JSON.parse(byUuid.get(e.parentUuid) ?? 'null') : null) {
  chain.push(byUuid.get(e.uuid))
}
chain.reverse()

for (const line of chain) {
  const r = parseLine('claude', line)
  for (const item of r.items ?? []) {
    console.log(JSON.stringify({ kind: item.kind, text: String(item.text ?? item.brief ?? '').replace(/\s+/g, ' ').slice(0, 90) }))
  }
}
