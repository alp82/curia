// PROTOTYPE (#570) — the chat-page proof harness.
//
// Runs the REAL TimelineSurface (daemon/src/timeline.mjs) with its default
// deps — real tmux send-keys, real transcript reader, real dialog guard — so
// the probe exercises the exact pane path the chat page gives an agent.
// Only two deps are stubbed: identityCheck (this is loopback, no tailnet
// header exists) and journal (captured to stdout instead of a daemon journal).
// driverFor stays the default null: THAT is the point — the overseer pane is
// read as a pane, not as a driven session.
//
// Usage:
//   node chatread.mjs events <workspaceRoot> <session>          # SSE backlog as JSON lines
//   node chatread.mjs send   <workspaceRoot> <session> <text…>  # the page's own /send
//   node chatread.mjs key    <workspaceRoot> <session> <key>    # the page's own /key

import { TimelineSurface, DEFAULT_TIMELINE_INDEX } from '../../daemon/src/timeline.mjs'

const [, , cmd, workspaceRoot, session, ...rest] = process.argv

const journal = []
const surface = new TimelineSurface({
  port: 0,
  servePort: 8444,
  index: DEFAULT_TIMELINE_INDEX,
  workspaceRoot,
  log: (m) => console.error(`[surface] ${m}`),
  pollMs: 100,
  deps: {
    identityCheck: () => null,
    journal: (type, detail) => journal.push({ type, ...detail }),
  },
})

const { verified } = await surface.start()
if (!verified) { console.error('surface did not start'); process.exit(1) }
const port = surface.port

if (cmd === 'events') {
  const res = await fetch(`http://127.0.0.1:${port}/events?session=${session}&once=1`)
  const text = await res.text()
  for (const block of text.split('\n\n')) {
    const ev = /event: (.+)/.exec(block)?.[1]
    const data = /data: ([\s\S]+)/.exec(block)?.[1]
    if (ev) console.log(JSON.stringify({ event: ev, data: data ? JSON.parse(data) : null }))
  }
} else if (cmd === 'send') {
  const r = await fetch(`http://127.0.0.1:${port}/send`, {
    method: 'POST', body: JSON.stringify({ session, text: rest.join(' ') }),
  })
  console.log(JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }))
} else if (cmd === 'key') {
  const r = await fetch(`http://127.0.0.1:${port}/key`, {
    method: 'POST', body: JSON.stringify({ session, key: rest[0] }),
  })
  console.log(JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }))
} else {
  console.error('unknown command', cmd)
  surface.stop()
  process.exit(1)
}

for (const j of journal) console.error(`[journal] ${JSON.stringify(j)}`)
surface.stop()
process.exit(0)
