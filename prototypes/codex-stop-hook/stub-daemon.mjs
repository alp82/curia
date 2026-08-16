#!/usr/bin/env node
// Stands in for the curia daemon's `POST /agent_done`, the one route the Stop
// hook talks to. It answers `{decision:"block", reason}` while a step is
// outstanding, which is exactly what daemon/src/index.mjs does at `/agent_done`.
//
// The point is to measure codex, not the daemon. So this server is the smallest
// thing that carries the same contract: it logs every payload the hook posts,
// blocks the first BLOCKS stops, then allows.
//
// Env:
//   HOOK_PORT   default 8901
//   HOOK_LOG    file for one JSON line per stop
//   BLOCKS      how many stops to refuse before allowing (default 2)
//   REASON      the refusal text; must be findable on the model's wire
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = Number(process.env.HOOK_PORT ?? 8901)
const LOG = process.env.HOOK_LOG ?? '/tmp/codex-stop-hook/stops.jsonl'
const BLOCKS = Number(process.env.BLOCKS ?? 2)
const REASON = process.env.REASON ?? 'CURIA-BLOCK-SENTINEL: the ending is not done. Call report_result before you stop.'

mkdirSync(dirname(LOG), { recursive: true })
writeFileSync(LOG, '')

let stops = 0

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (!req.url.startsWith('/agent_done')) {
      res.writeHead(404).end('{}')
      return
    }
    stops += 1
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* log it raw anyway */ }

    // The two keys this whole check turns on. `stop_hook_active` is what #438
    // keys its flagged send on, so whether it flips on the second stop is a
    // measurement and not a detail.
    appendFileSync(LOG, `${JSON.stringify({
      stop: stops,
      stop_hook_active: parsed?.stop_hook_active ?? null,
      keys: parsed ? Object.keys(parsed).sort() : null,
      headers: { 'content-type': req.headers['content-type'] ?? null },
      raw: body,
    })}\n`)

    // Block while a step is outstanding, then allow — the daemon's own shape.
    //
    // EXTRA_KEY=1 answers `{ok:true}` instead of a bare `{}` on the allow path.
    // That is the shape the daemon USED to send, and codex rejected it against a
    // closed schema (the comment at index.mjs `/agent_done` records it). The
    // knob is here so a version bump can re-measure whether that still bites.
    const allow = process.env.EXTRA_KEY === '1' ? { ok: true } : {}
    const answer = stops <= BLOCKS
      ? { decision: 'block', reason: `${REASON} (stop ${stops})` }
      : allow
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`stub daemon on 127.0.0.1:${PORT}, blocking ${BLOCKS} stop(s), log ${LOG}\n`)
})
