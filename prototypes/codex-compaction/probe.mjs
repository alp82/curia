// Whether the codex skill catalog survives a compaction (#577).
//
// PROTOTYPE — throwaway instrument, kept under prototypes/ per ADR-0008.
//
// The instrument is #399's: a local stub of the Responses API behind
// `-c model_provider=fake`. A real codex CLI runs a real multi-turn session
// against it, no credential anywhere, and every request body is written to
// disk. The input list the model would have read IS the reading.
//
// What is new here is the LOAD. The stub reports the `usage` numbers codex
// trusts for its token accounting: it estimates the serialized input at four
// characters per token and reports that. The run sets
// `model_auto_compact_token_limit` low, so the session crosses the limit and
// codex must compact — the condition #360 and #399 could observe the catalog
// at rest but never under.
//
// A compaction request is recognized by codex's own instruction text,
// "CONTEXT CHECKPOINT COMPACTION", read off the wire rather than assumed.
//
// Run:  node prototypes/codex-compaction/probe.mjs <case>
//       node prototypes/codex-compaction/probe.mjs all
//
// Cases:
//   rest     the control. No limit set, three turns. The #399 shipped case,
//            re-taken so the compaction rows have a baseline from the same rig.
//   compact  the reading. A low limit, five turns, compaction forced.
//   twice    the same limit held for nine turns, so a second compaction can
//            fire. The first could ride turn-one state; the second cannot.
//
// Needs the `codex` binary on PATH. It needs no credential and no network.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SELF), '../..')
const ROOT = process.env.PROBE_DIR || path.join(os.tmpdir(), 'curia-577-compact')
const PORT = Number(process.env.PROBE_MODEL_PORT ?? 8899)

const { seedConfigDir, writeConnectionSettings, writePrompt, DEFAULT_SKILLS } =
  await import(path.join(REPO, 'daemon/src/workspace.mjs'))

// ---- the fixture (curia's own spawn, as in #399) ---------------------------

function seed(dir) {
  const cfg = path.join(dir, 'ch')
  const ws = path.join(dir, 'ws')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(ws, { recursive: true })
  const skills = { root: path.join(REPO, 'skills'), install: DEFAULT_SKILLS }
  seedConfigDir(cfg, ws, skills, 'codex', { sandboxed: false })
  writeConnectionSettings({
    wtPath: ws, cfgDir: cfg, agent: 'curia-577', ticket: '577',
    daemonPort: 4271, harness: 'codex', reasoningEffort: 'high',
    daemonHost: '127.0.0.1', token: 'a'.repeat(64), skills,
  })
  writePrompt(cfg, { number: 577, title: 'x', body: 'Part of #511' }, {
    repo: 'alp82/curia', wtPath: ws, mapNumber: 511,
    type: 'wayfinder:prototype', ports: [9003, 9004, 9005], harness: 'codex',
  })
  return { cfg, ws }
}

// ---- the stub model --------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
  })
}

const isCompaction = (body) =>
  JSON.stringify(body.instructions ?? '').includes('CONTEXT CHECKPOINT COMPACTION') ||
  JSON.stringify(body.input ?? []).includes('CONTEXT CHECKPOINT COMPACTION')

// The stub answers every request with one message. For an ordinary turn that
// is one word. For a compaction request it is a plausible handoff summary,
// because what codex DOES with the summary is part of what is under test.
// `usage` is the lever: codex trusts the provider's count, so the stub
// estimates the serialized input at four characters per token and reports it.
// With `state.remaining`, the scripted model reads those files (via the same
// `exec` mechanics as #399's reread case), so the transcript carries real
// bulk a compaction can visibly cut. The list is refilled per INVOCATION by
// `turns`, never inferred from the input: #399 counted execs after the last
// user message, and a mid-turn compaction breaks that count — the rebuilt
// history ends with codex's own summary bridge as the newest user message,
// the count resets, the stub reads again, and the session compacts forever.
// The first run of this probe found that loop at 5,608 requests.
function serveModel(dir, requests, state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (req.method !== 'POST' || !url.pathname.endsWith('/responses')) { res.writeHead(404).end('{}'); return }
    const body = await readBody(req)
    requests.push(body)
    fs.writeFileSync(path.join(dir, `request-${String(requests.length).padStart(2, '0')}.json`), JSON.stringify(body, null, 2))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
    const n = requests.length
    const inputTokens = Math.ceil(JSON.stringify(body.input ?? []).length / 4)
    const usage = { input_tokens: inputTokens, output_tokens: 40, total_tokens: inputTokens + 40 }
    const response = { id: `resp_${n}`, object: 'response', status: 'completed', output: [], usage }
    send('response.created', { response: { ...response, status: 'in_progress' } })
    // A compaction request never reads: it must answer with a summary.
    const next = isCompaction(body) ? null : state.remaining.shift()
    if (next) {
      // `exec` takes raw JavaScript, not a shell line (#399).
      send('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'custom_tool_call', id: `ct_${n}`, call_id: `call_${n}`, name: 'exec',
          input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(`cat ${next}`)} });\ntext(r)\n`,
          status: 'completed',
        },
      })
    } else {
      const text = isCompaction(body)
        ? 'Handoff summary: a curia wayfinder dispatch for ticket 577 on repo alp82/curia. '
          + 'The agent read prompt.md and the fixture notes, acknowledged the standing orders, and '
          + 'answered each turn. No files changed yet. Next step: continue the dispatched task.'
        : 'ok'
      send('response.output_item.done', {
        output_index: 0,
        item: { type: 'message', id: `msg_${n}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] },
      })
    }
    send('response.completed', { response })
    res.end()
  })
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)))
}

// The two `--dangerously-*` flags are curia's own, copied from the codex
// template in `config/routing.yaml` — fidelity rather than convenience.
function codex(args, { cfg, ws }, extraConfig = []) {
  return new Promise((resolve) => {
    const p = spawn('codex', [
      'exec', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '-c', 'model_providers.fake.name=fake',
      '-c', `model_providers.fake.base_url=http://127.0.0.1:${PORT}/v1`,
      '-c', 'model_providers.fake.wire_api=responses',
      '-c', 'model_providers.fake.env_key=FAKE_KEY',
      '-c', 'model_provider=fake',
      ...extraConfig.flatMap((kv) => ['-c', kv]),
      ...args,
    ], { cwd: ws, env: { ...process.env, CODEX_HOME: cfg, FAKE_KEY: 'x' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { out += c })
    p.on('exit', (code) => resolve({ code, out }))
  })
}

// ---- the readings ----------------------------------------------------------

// Everything is read off the request. The catalog is the
// `<skills_instructions>` developer message. The standing orders ride the
// `# AGENTS.md instructions` user message (#340). The summary is codex's own
// bridge, "Another language model started to solve this problem ...", which
// wraps the text the stub returned to the compaction request.
function readings(body) {
  const items = body.input ?? []
  const parts = items.flatMap((m) => (m.content ?? []).map((c) => ({ role: m.role, text: c.text ?? '' })))
  const catalog = parts.find((p) => p.text.startsWith('<skills_instructions>'))?.text ?? ''
  const agentsMd = parts.find((p) => p.text.includes('# AGENTS.md instructions'))?.text ?? ''
  const summary = parts.find((p) => p.text.includes('Another language model started')
    || p.text.includes('Handoff summary:'))?.text ?? ''
  const outputs = items.filter((i) => i?.type === 'custom_tool_call_output')
  const readChars = outputs.reduce((a, o) => a + JSON.stringify(o.output ?? '').length, 0)
  const entries = ['curia-wayfinder', 'curia-implement']
    .filter((n) => catalog.split('\n').some((l) => l.startsWith(`- ${n}:`)))
  return {
    compaction: isCompaction(body),
    items: items.length,
    users: items.filter((m) => m.role === 'user').length,
    catalog: catalog.length,
    catalogText: catalog,
    entries: entries.join('+') || '—',
    agentsMd: agentsMd.length,
    summary: summary.length,
    reads: outputs.length,
    readChars,
    chars: parts.reduce((a, p) => a + p.text.length, 0) + readChars,
  }
}

function table(name, requests, turnOf) {
  console.log(`\n### ${name}`)
  console.log('\n| req | turn | kind | input items | user msgs | catalog chars | pointer entries | catalog same as req 1 | AGENTS.md chars | summary chars | read chars | input chars |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  const first = requests.length ? readings(requests[0]).catalogText : ''
  requests.forEach((b, i) => {
    const r = readings(b)
    const kind = r.compaction ? '**compaction**' : 'turn'
    const same = r.catalogText === first ? 'yes' : (r.catalog ? 'NO (differs)' : 'NO (absent)')
    console.log(`| ${i + 1} | ${turnOf[i]} | ${kind} | ${r.items} | ${r.users} | ${r.catalog} | ${r.entries} | ${same} | ${r.agentsMd} | ${r.summary} | ${r.readChars} | ${r.chars} |`)
  })
}

async function turns(name, dir, seeded, prompts, extraConfig, { reads = [] } = {}) {
  const requests = []
  const turnOf = []
  const state = { remaining: [] }
  const server = await serveModel(dir, requests, state)
  for (const [i, prompt] of prompts.entries()) {
    const before = requests.length
    state.remaining = [...reads]
    const { code, out } = await codex(i === 0 ? [prompt] : ['resume', '--last', prompt], seeded, extraConfig)
    if (code !== 0) console.error(`turn ${i + 1} exited ${code}\n${out.slice(-1200)}`)
    // Codex announces its own compactions on stdout. Kept beside the wire
    // reading, so the two can disagree visibly if they ever do.
    const said = out.split('\n').filter((l) => /compact/i.test(l))
    if (said.length) console.log(`turn ${i + 1} CLI said: ${said.join(' | ')}`)
    for (let k = before; k < requests.length; k += 1) turnOf.push(`${i + 1}`)
  }
  await new Promise((r) => server.close(r))
  table(name, requests, turnOf)
  return requests
}

const PROMPTS = [
  'resolve the ticket in prompt.md',
  'turn two, keep going',
  'turn three, keep going',
  'turn four, keep going',
  'turn five, keep going',
  'turn six, keep going',
  'turn seven, keep going',
  'turn eight, keep going',
  'turn nine, keep going',
]

// A deterministic 40,000-character fixture the scripted model reads once per
// turn. Real bulk in the transcript, so a compaction has something to cut and
// the cut shows as a number.
function bulkFile(ws) {
  const p = path.join(ws, 'notes.txt')
  const line = 'fixture line for ticket 577: the transcript needs weight a compaction can cut. '
  fs.writeFileSync(p, line.repeat(Math.ceil(40000 / line.length)).slice(0, 40000))
  return p
}

const CASES = {
  // The control: the same rig with no limit. Matches #399 section 5.
  async rest() {
    const dir = path.join(ROOT, 'rest')
    const seeded = seed(dir)
    await turns('rest — no limit, 3 turns', dir, seeded, PROMPTS.slice(0, 3), [])
  },

  // The reading. The developer prefix alone is about 13,000 tokens by the
  // stub's count, and each turn adds a 40,000-character read (about 10,000
  // tokens). A 30,000-token limit sits above one turn of bulk and below two,
  // so the session grows, crosses, compacts, and grows again.
  async compact() {
    const dir = path.join(ROOT, 'compact')
    const seeded = seed(dir)
    await turns('compact — limit 30000, a 40,000-char read per turn, 6 turns', dir, seeded,
      PROMPTS.slice(0, 6), ['model_auto_compact_token_limit=30000'], { reads: [bulkFile(seeded.ws)] })
  },

  // The floor: a limit BELOW the developer prefix, so codex must compact on
  // every turn and compaction can never win. Nine turns, eight compactions.
  // The catalog after the eighth is the strong reading: nothing conversational
  // of turn one remains to carry it.
  async floor() {
    const dir = path.join(ROOT, 'floor')
    const seeded = seed(dir)
    await turns('floor — limit 9000, under the prefix, 9 turns', dir, seeded,
      PROMPTS, ['model_auto_compact_token_limit=9000'])
  },
}

const which = process.argv[2]
if (which === 'all') for (const run of Object.values(CASES)) await run()
else if (CASES[which]) await CASES[which]()
else {
  console.error(`usage: node ${path.relative(REPO, SELF)} <${Object.keys(CASES).join('|')}|all>`)
  process.exit(2)
}
