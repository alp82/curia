// What a harness does when the daemon dies UNDER it (#341).
//
// #194 measured the channel that never comes up. This measures the channel that
// breaks after readiness: the daemon exits while an agent works, and the
// supervisor respawns it seconds later, which is what every deploy and every
// `POST /restart` does to a live agent.
//
// The stand-in is faithful where it matters. It serves `POST /mcp?agent=&ticket=`
// with a stateless `StreamableHTTPServerTransport` and the `x-curia-agent-token`
// header, exactly as `daemon/src/index.mjs` does, and the agent reaches it with
// the `.mcp.json` and the settings `daemon/src/workspace.mjs` writes. What it is
// NOT is the live daemon on the box: no Discord, no journal, no keepalive.
//
// Two cases:
//   drop     the daemon dies while it holds a blocking `ask_human`, and is back
//            5 s later. Measures what the agent is told, and how long it waits.
//   refused  the daemon dies with no call in flight and stays down 20 s while
//            the agent retries. Measures whether the tools come back by
//            themselves.
//
// Run:  node docs/research/tool-channel-mid-session.probe.mjs <drop|refused> [scratch-dir]
// Needs the `claude` binary and a model credential in `CLAUDE_CODE_OAUTH_TOKEN`.
// The numbers it prints are the timelines in tool-channel-mid-session.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)

// The MCP SDK is the daemon's dependency and this file lives outside its
// package, so it is resolved from `daemon/package.json` rather than imported by
// name. Run `npm ci` in `daemon/` first.
const dep = createRequire(path.join(SELF, '../../../daemon/package.json'))
const load = async (spec) => import(pathToFileURL(dep.resolve(spec)).href)
const { McpServer } = await load('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = await load('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = await load('zod')
const PORT = Number(process.env.PROBE_PORT ?? 9010)
const TOKEN = 'probe-token'
const TOKEN_HEADER = 'x-curia-agent-token'
const AGENT = 'curia-341'

// ---- the stand-in daemon ---------------------------------------------------

function log(dir, entry) {
  fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`)
}

// The daemon dies once, under the tool this case names, and the flag file is
// what keeps the respawned process from dying again.
function maybeDie(dir, tool, dieUnder, afterMs) {
  const flag = path.join(dir, 'died')
  if (tool !== dieUnder || fs.existsSync(flag)) return
  fs.writeFileSync(flag, String(Date.now()))
  setTimeout(() => {
    log(dir, { ev: 'daemon_dies', while_holding: tool })
    process.exit(1)
  }, afterMs)
}

function buildMcpServer(dir, dieUnder, afterMs) {
  const s = new McpServer({ name: 'curia', version: '0.0.1' })
  s.tool('notify', 'Fire-and-forget status line.', { message: z.string() }, async ({ message }) => {
    log(dir, { ev: 'tool', tool: 'notify', message })
    maybeDie(dir, 'notify', dieUnder, afterMs)
    return { content: [{ type: 'text', text: `noted: ${message}` }] }
  })
  s.tool('ask_human', 'Blocking question to a human.', { prompt: z.string() }, async ({ prompt }) => {
    log(dir, { ev: 'tool', tool: 'ask_human', prompt })
    maybeDie(dir, 'ask_human', dieUnder, afterMs)
    // Blocks the way the real one does: an answer takes as long as a human takes.
    await new Promise((r) => setTimeout(r, 300_000))
    return { content: [{ type: 'text', text: 'the human said: go ahead' }] }
  })
  return s
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { return {} }
}

function serve(dir, dieUnder, afterMs) {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (url.pathname !== '/mcp') { res.writeHead(404).end('{}'); return }
    const body = await readBody(req)
    log(dir, {
      ev: 'request', method: req.method, rpc: body?.method ?? null, id: body?.id ?? null,
      tool: body?.params?.name ?? null, token_ok: req.headers[TOKEN_HEADER] === TOKEN,
    })
    if (req.method !== 'POST') { res.writeHead(405).end('{}'); return }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close() })
    const mcp = buildMcpServer(dir, dieUnder, afterMs)
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }).listen(PORT, '127.0.0.1', () => log(dir, { ev: 'listening', port: PORT }))
}

// ---- the agent's side ------------------------------------------------------

// The files `daemon/src/workspace.mjs` writes for a claude agent, with this
// probe's URL in them.
function seed(dir) {
  const ws = path.join(dir, 'ws')
  const cfg = path.join(dir, 'cfg')
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true })
  fs.mkdirSync(cfg, { recursive: true })
  fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({
    mcpServers: {
      curia: {
        type: 'http',
        url: `http://127.0.0.1:${PORT}/mcp?agent=${AGENT}&ticket=341`,
        headers: { [TOKEN_HEADER]: TOKEN },
      },
    },
  }, null, 2))
  fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), JSON.stringify({
    enableAllProjectMcpServers: true,
    permissions: { defaultMode: 'bypassPermissions' },
  }, null, 2))
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    disableClaudeAiConnectors: true,
    allowedMcpServers: [{ serverName: 'curia' }],
  }, null, 2))
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, installMethod: 'native', autoUpdates: false, numStartups: 1,
    projects: { [ws]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }, null, 2))
  return { ws, cfg }
}

const PROMPTS = {
  drop: [
    'You have the curia MCP tools. Follow these steps in order and do not stop early.',
    '1. Call notify with message "one".',
    '2. Call ask_human with prompt "blocking".',
    '3. Whatever happened in step 2, including an error, call notify with message "two".',
    '4. Call notify with message "three".',
    'Then report, for each call, whether it succeeded or failed, and quote any error verbatim.',
  ].join('\n'),
  refused: [
    'You have the curia MCP tools. Follow these steps in order and do not stop early.',
    '1. Call notify with message "one".',
    '2. Call notify with message "two". If that call fails, call it again at once with the',
    '   same message. Keep calling it until it succeeds. Do not stop before it succeeds or',
    '   before 25 attempts. Do not use the bash tool. Do not ask anybody anything.',
    'Then report how many attempts step 2 took, and quote the first error verbatim.',
  ].join('\n'),
}

const CASES = {
  drop: { dieUnder: 'ask_human', dieAfterMs: 3000, downMs: 5000 },
  refused: { dieUnder: 'notify', dieAfterMs: 1000, downMs: 20_000 },
}

async function main() {
  const which = process.argv[2]
  const kase = CASES[which]
  if (!kase) {
    console.error(`usage: node ${path.basename(SELF)} <${Object.keys(CASES).join('|')}> [scratch-dir]`)
    process.exit(2)
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error('no CLAUDE_CODE_OAUTH_TOKEN — this probe runs a real headless agent and needs a credential')
    process.exit(2)
  }
  const dir = process.argv[3] || path.join(os.tmpdir(), `curia-channel-probe-${which}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const { ws, cfg } = seed(dir)

  // The supervisor the box has: `restart: on-failure`, one respawn after the
  // outage this case asks for.
  let stop = false
  let daemon = null
  const supervise = async () => {
    while (!stop) {
      await new Promise((done) => {
        daemon = spawn(process.execPath, [SELF], {
          env: {
            ...process.env,
            PROBE_ROLE: 'server', PROBE_DIR: dir,
            PROBE_DIE_UNDER: kase.dieUnder, PROBE_DIE_AFTER_MS: String(kase.dieAfterMs),
          },
          stdio: 'inherit',
        })
        daemon.on('exit', done)
      })
      if (stop) return
      console.log(`[${new Date().toISOString()}] daemon down for ${kase.downMs / 1000}s`)
      await new Promise((r) => setTimeout(r, kase.downMs))
    }
  }
  supervise()
  await new Promise((r) => setTimeout(r, 2000))

  const started = Date.now()
  const agent = spawn('claude', [
    '-p', PROMPTS[which], '--model', 'haiku',
    '--permission-mode', 'bypassPermissions', '--output-format', 'json',
  ], {
    cwd: ws,
    // stdin is closed rather than inherited. `claude -p` waits three seconds for
    // piped input, and an inherited terminal never closes it at all.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: process.env.HOME, PATH: process.env.PATH, TERM: 'xterm',
      CLAUDE_CONFIG_DIR: cfg,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      // What the daemon sets, so the client's own idle timer cannot be what
      // ends the call (#34).
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '86400000',
    },
  })
  let out = ''
  agent.stdout.on('data', (b) => { out += b })
  agent.stderr.pipe(process.stderr)
  await new Promise((done) => agent.on('exit', done))
  // The stand-in outlives this process otherwise, and the next run of the probe
  // then meets its own port held by the last one.
  stop = true
  daemon?.kill()

  console.log(`\n=== ${which}: the timeline ===`)
  const journal = path.join(dir, 'log.jsonl')
  if (!fs.existsSync(journal)) {
    console.log(`no requests reached the stand-in. Check that port ${PORT} was free.`)
  }
  for (const line of fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').trim().split('\n') : []) {
    const e = JSON.parse(line)
    console.log(`${e.ts}  pid ${e.pid}  ${e.ev}${e.rpc ? ` ${e.rpc}` : ''}${e.tool ? ` ${e.tool}` : ''}`)
  }
  console.log(`\n=== ${which}: what the agent reported (${Math.round((Date.now() - started) / 1000)}s) ===`)
  try {
    console.log(JSON.parse(out).result)
  } catch {
    console.log(out)
  }
  process.exit(0)
}

// One file, two roles: the supervisor respawns this same script as the daemon.
if (process.env.PROBE_ROLE === 'server') {
  serve(process.env.PROBE_DIR, process.env.PROBE_DIE_UNDER, Number(process.env.PROBE_DIE_AFTER_MS))
} else {
  await main()
}
