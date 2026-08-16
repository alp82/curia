// What arms a skill on codex, and what each arming costs per turn (#399).
//
// The instrument is [#360](https://github.com/alp82/curia/issues/360)'s: a local
// stub of the Responses API behind `-c model_provider=fake`. A real codex CLI
// runs a real multi-turn session against it, and no credential is needed
// anywhere. Every request body is written to disk, so the input list the model
// would have read IS the reading.
//
// #360 described its stub in prose and committed no code, so this ticket rebuilt
// it. The file is committed for that reason: the next codex version bump owes a
// re-run, and a re-run should not start at a blank page.
//
// The fixture is curia's own spawn. `seedConfigDir`, `writeConnectionSettings`
// and `writePrompt` from `daemon/src/workspace.mjs` write the config dir, with
// `harness: 'codex'` and the vendored tree at `skills/`.
//
// Run:  node docs/live-checks/399-codex-skill-arming.probe.mjs <case>
//       node docs/live-checks/399-codex-skill-arming.probe.mjs all
//
// Cases:
//   mention  the #360 control. `$wayfinder` on turn one, nothing after it.
//   flip     `policy.allow_implicit_invocation: true` in a PATCHED copy of the
//            tree. The route the operator rejected, measured for its price.
//   pointer  a skill curia GENERATES into the agent config dir, carrying no
//            manifest at all. Nothing upstream is patched.
//   lever    can `config.toml` list a skill? Rendered, not run, with a control.
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
const ROOT = process.env.PROBE_DIR || path.join(os.tmpdir(), 'curia-399-arm')
const PORT = Number(process.env.PROBE_MODEL_PORT ?? 8899)

const { seedConfigDir, writeConnectionSettings, writePrompt, DEFAULT_SKILLS } =
  await import(path.join(REPO, 'daemon/src/workspace.mjs'))

// ---- the fixture -----------------------------------------------------------

// curia's own spawn, into a throwaway CODEX_HOME. `skillsRoot` is a parameter so
// the `flip` case can point at a patched copy of the tree without touching the
// checkout.
function seed(dir, { skillsRoot = path.join(REPO, 'skills'), install = DEFAULT_SKILLS } = {}) {
  const cfg = path.join(dir, 'ch')
  const ws = path.join(dir, 'ws')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(ws, { recursive: true })
  const skills = { root: skillsRoot, install }
  seedConfigDir(cfg, ws, skills, 'codex', { sandboxed: false })
  writeConnectionSettings({
    wtPath: ws, cfgDir: cfg, agent: 'curia-399', ticket: '399',
    daemonPort: 4271, harness: 'codex', reasoningEffort: 'high',
    daemonHost: '127.0.0.1', token: 'a'.repeat(64), skills,
  })
  writePrompt(cfg, { number: 399, title: 'x', body: 'Part of #244' }, {
    repo: 'alp82/curia', wtPath: ws, mapNumber: 244,
    type: 'wayfinder:grilling', ports: [9018, 9019, 9020], harness: 'codex',
  })
  return { cfg, ws }
}

// A copy of the vendored tree with one line changed. The checkout is never
// written to: `skills/` is upstream's bytes, pinned in `skills/UPSTREAM.md`.
function flippedTree(dir) {
  const root = path.join(dir, 'skills-flipped')
  fs.rmSync(root, { recursive: true, force: true })
  fs.cpSync(path.join(REPO, 'skills'), root, { recursive: true, dereference: true })
  const manifest = path.join(root, 'wayfinder/agents/openai.yaml')
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8')
    .replace('allow_implicit_invocation: false', 'allow_implicit_invocation: true'))
  return root
}

// The pointer. Curia would write this at seed time, beside `standing.md`. It
// carries no `agents/openai.yaml`, and codex lists a skill with no manifest by
// default, so nothing upstream is patched and nothing is restated.
function writePointer(cfg) {
  const dir = path.join(cfg, 'skills/curia-wayfinder')
  const target = path.join(cfg, 'skills/wayfinder/SKILL.md')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    'name: curia-wayfinder',
    `description: This dispatch runs the wayfinder skill. Read ${target} in full before you chart a map, resolve a ticket, or write a resolution comment.`,
    '---',
    '',
    `Read \`${target}\` completely, then follow it. It is the skill this dispatch runs.`,
    'The curia standing orders win where the two disagree.',
    '',
  ].join('\n'))
  return dir
}

// ---- the stub model --------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
  })
}

// Three server-sent events are the whole Responses wire protocol codex needs:
// `response.created`, `response.output_item.done` and `response.completed`. The
// model says one word, because what is under test is the input list codex builds
// and never the answer it gets back.
function serveModel(dir, requests) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (req.method !== 'POST' || !url.pathname.endsWith('/responses')) { res.writeHead(404).end('{}'); return }
    const body = await readBody(req)
    requests.push(body)
    fs.writeFileSync(path.join(dir, `request-${String(requests.length).padStart(2, '0')}.json`), JSON.stringify(body, null, 2))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
    const n = requests.length
    const response = { id: `resp_${n}`, object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    send('response.created', { response: { ...response, status: 'in_progress' } })
    send('response.output_item.done', {
      output_index: 0,
      item: { type: 'message', id: `msg_${n}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    })
    send('response.completed', { response })
    res.end()
  })
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)))
}

// `</dev/null` matters: the CLI waits on stdin and never returns without it.
function codex(args, { cfg, ws }) {
  return new Promise((resolve) => {
    const p = spawn('codex', [
      'exec', '--skip-git-repo-check',
      '-c', 'model_providers.fake.name=fake',
      '-c', `model_providers.fake.base_url=http://127.0.0.1:${PORT}/v1`,
      '-c', 'model_providers.fake.wire_api=responses',
      '-c', 'model_providers.fake.env_key=FAKE_KEY',
      '-c', 'model_provider=fake',
      ...args,
    ], { cwd: ws, env: { ...process.env, CODEX_HOME: cfg, FAKE_KEY: 'x' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { out += c })
    p.on('exit', (code) => resolve({ code, out }))
  })
}

// ---- the readings ----------------------------------------------------------

// The catalog is the second content part of the third input item, and the
// `<skill>` body is a user message. Both are read off the request rather than
// counted here, so a codex that moves either one reads as a zero and not as a
// wrong number.
function readings(body) {
  const items = body.input ?? []
  const parts = items.flatMap((m) => (m.content ?? []).map((c) => ({ role: m.role, text: c.text ?? '' })))
  const catalog = parts.find((p) => p.text.startsWith('<skills_instructions>'))?.text ?? ''
  const line = catalog.split('\n').find((l) => l.startsWith('- wayfinder:') || l.startsWith('- curia-wayfinder:')) ?? ''
  return {
    items: items.length,
    users: items.filter((m) => m.role === 'user').length,
    blocks: parts.filter((p) => p.text.startsWith('<skill>')).length,
    body: parts.filter((p) => p.text.startsWith('<skill>')).reduce((a, p) => a + p.text.length, 0),
    catalog: catalog.length,
    entry: line.length,
    chars: parts.reduce((a, p) => a + p.text.length, 0),
  }
}

function table(name, requests) {
  console.log(`\n### ${name}`)
  console.log('\n| turn | input items | user msgs | `<skill>` blocks | body chars | catalog chars | wayfinder entry | input chars |')
  console.log('|---|---|---|---|---|---|---|---|')
  requests.forEach((b, i) => {
    const r = readings(b)
    console.log(`| ${i + 1} | ${r.items} | ${r.users} | ${r.blocks} | ${r.body} | ${r.catalog} | ${r.entry || '—'} | ${r.chars} |`)
  })
}

async function turns(name, dir, seeded, prompts) {
  const requests = []
  const server = await serveModel(dir, requests)
  for (const [i, prompt] of prompts.entries()) {
    const { code, out } = await codex(i === 0 ? [prompt] : ['resume', '--last', prompt], seeded)
    if (code !== 0) console.error(`turn ${i + 1} exited ${code}\n${out.slice(-1200)}`)
  }
  await new Promise((r) => server.close(r))
  table(`${name} — prompts: ${prompts.map((p) => JSON.stringify(p)).join(', ')}`, requests)
  return requests
}

// `codex debug prompt-input` renders the session context without a model. It
// does NOT resolve skill mentions (#340 section 1), so it answers a catalog
// question and never an injection one.
//
// stderr and the exit code are read as well as stdout, because a config codex
// REFUSES renders nothing at all — and a skill that is absent from an empty
// render looks exactly like a skill codex chose not to list. One of the four
// rows below is that case, and without this it reads as a wrong answer.
function rendered(cfg) {
  const p = spawn('codex', ['debug', 'prompt-input', 'x'], { env: { ...process.env, CODEX_HOME: cfg }, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { err += c })
    p.on('exit', (code) => resolve({ out, err, code }))
  })
}

const CASES = {
  // The #360 control. Without it, an absent block proves nothing about the rig.
  async mention() {
    const dir = path.join(ROOT, 'mention')
    const seeded = seed(dir)
    await turns('mention', dir, seeded, ['$wayfinder hello', 'turn two, no mention', 'turn three'])
  },

  // The route the operator rejected on 2026-08-16, measured for its price and
  // for the question it left open: does a LISTED skill paste its body?
  async flip() {
    const dir = path.join(ROOT, 'flip')
    const seeded = seed(dir, { skillsRoot: flippedTree(ROOT) })
    await turns('flip', dir, seeded, ['chart a map for the new effort', '$wayfinder go', 'continue charting'])
  },

  // Curia's own file, in curia's own directory, patching nothing.
  async pointer() {
    const dir = path.join(ROOT, 'pointer')
    const seeded = seed(dir)
    writePointer(seeded.cfg)
    await turns('pointer', dir, seeded, ['$wayfinder hello', 'turn two, no mention'])
  },

  // Is there a supported lever in `config.toml` today? The control is what makes
  // the answer readable: an entry codex ignores and an entry codex never read
  // look the same from outside.
  async lever() {
    const dir = path.join(ROOT, 'lever')
    const { cfg } = seed(dir)
    const base = fs.readFileSync(path.join(cfg, 'config.toml'), 'utf8')

    console.log('\n### lever — can config.toml list a skill?\n')
    console.log('| config.toml entry | wayfinder listed | grilling listed | codex |')
    console.log('|---|---|---|---|')
    const rows = [
      ['(none)', ''],
      ['name = "grilling", enabled = false', '\n[[skills.config]]\nname = "grilling"\nenabled = false\n'],
      ['name = "wayfinder", enabled = true', '\n[[skills.config]]\nname = "wayfinder"\nenabled = true\n'],
      ['name = "wayfinder", enabled = true, allow_implicit_invocation = true', '\n[[skills.config]]\nname = "wayfinder"\nenabled = true\nallow_implicit_invocation = true\n'],
      ['name = "wayfinder", allow_implicit_invocation = true', '\n[[skills.config]]\nname = "wayfinder"\nallow_implicit_invocation = true\n'],
    ]
    for (const [label, extra] of rows) {
      fs.writeFileSync(path.join(cfg, 'config.toml'), base + extra)
      const { out, err, code } = await rendered(cfg)
      const refused = code !== 0
      const verdict = refused ? `refused: ${(/Error: .*/.exec(err)?.[0] ?? '').slice(0, 80)}` : 'rendered'
      const seen = (name) => (refused ? '—' : (out.includes(`- ${name}:`) ? 'yes' : 'no'))
      console.log(`| \`${label}\` | ${seen('wayfinder')} | ${seen('grilling')} | ${verdict} |`)
    }
  },
}

const which = process.argv[2]
if (which === 'all') for (const run of Object.values(CASES)) await run()
else if (CASES[which]) await CASES[which]()
else {
  console.error(`usage: node ${path.relative(REPO, SELF)} <${Object.keys(CASES).join('|')}|all>`)
  process.exit(2)
}
