// The turn crosses the boundary (#314).
//
// The cases below drive BOTH halves for real, with no container and no model:
// a node http server runs the container's own handler, the daemon's client
// posts turns to it, and the daemon's `/overseer/mcp` route is stood up from
// the same function index.mjs wires. The one thing faked is the model — the
// SDK query is injected, and in the end-to-end case its fake reaches back
// through a real MCP client, which is what proves a verb call crosses the
// boundary and lands on `/command`.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  TURN_PATH, TURN_EVENTS, OVERSEER_MCP_PATH, OVERSEER_CONTAINER_MODEL, CONTAINER_MAX_TURNS,
  turnRoute, refuseTurn, checkoutNote, credentialPass, overseerConfigDirFor, overseerHomeFor,
  modelCredentialEnv, overseerProcessEnv,
} from '../src/overseerturn.mjs'
import { AnthropicCredentialStore, anthropicStoreFile } from '../src/credentials.mjs'
import { unroutedNote } from '../src/overseercreds.mjs'
import { overseerTokensRootFor, writeOverseerToken } from '../src/overseertoken.mjs'
import { OverseerClient, OverseerTurns, buildVerbMcpServer, serveVerbMcp } from '../src/overseerclient.mjs'
import { Reduction } from '../src/reduction.mjs'
import { overseerHandler } from '../src/overseerservice.mjs'
import { VERB_TOOLS, VERB_SPECS, canonicalFor } from '../src/overseerverbs.mjs'
import { TOKEN_HEADER } from '../src/agenttoken.mjs'
import { journalEvents } from './fixtures/journal.mjs'

const quiet = () => {}

function tmpRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `curia-${name}-`))
  return dir
}

function cfgFor(root, repos = ['alp82/curia']) {
  return { dispatch: { workspace_root: root }, watch: repos.map((repo) => ({ repo })) }
}

const okSync = (repos) => async () => ({
  root: 'wherever', at: '2026-08-16T10:00:00.000Z', removed: [],
  repos: repos.map((repo) => ({ repo, ok: true, fetchedAt: '2026-08-16T10:00:00.000Z' })),
})

// A model that says one thing and calls nothing.
function sayingModel(text, { sessionId = 'sess-1', onOptions = () => {} } = {}) {
  return async function* query({ options }) {
    onOptions(options)
    yield { type: 'system', subtype: 'init', session_id: sessionId }
    yield { type: 'result', subtype: 'success', result: text, num_turns: 1, total_cost_usd: 0.01 }
  }
}

// A running container: the real handler, on a real port. `creds` is stubbed by
// default because the real pass writes the RUNNER's global git config (#361),
// and a test that does not ask about routing must not touch it.
async function startContainer({ cfg, queryFn, sync, creds = async () => [], log = quiet }) {
  const server = http.createServer(overseerHandler({ log, turn: turnRoute({ loadCfg: () => cfg, log, queryFn, sync, creds }) }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, stop: () => new Promise((r) => server.close(r)) }
}

// The daemon's own `/overseer/mcp` route, stood up exactly as index.mjs does.
async function startDaemonSeam(turns, { log = quiet } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://daemon.invalid')
    if (url.pathname !== OVERSEER_MCP_PATH) {
      res.writeHead(404); return res.end()
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    await serveVerbMcp({
      turns,
      id: url.searchParams.get('turn') ?? '',
      presented: req.headers[TOKEN_HEADER],
      log,
      refuse: (error) => {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error }))
      },
      serve: async (mcp) => {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => { transport.close() })
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
      },
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, stop: () => new Promise((r) => server.close(r)) }
}

// A reduction double: the conversation state the daemon keeps (ADR-0015).
function storeDouble({ sessions = {}, notes = [], conversations = ['console-1'] } = {}) {
  return {
    bound: [],
    // The pending-turn journal (#388): the client brackets every turn with
    // these two, and the boot reads whatever is left between them.
    turns: [],
    overseerSession: (key) => sessions[key],
    bindOverseerSession(key, id) { sessions[key] = id; this.bound.push([key, id]) },
    takeOverseerNotes: () => notes.splice(0, notes.length),
    hasConsoleConversation: (key) => conversations.includes(key),
    beginOverseerTurn(ev) { this.turns.push({ type: 'started', ...ev }) },
    endOverseerTurn(ev) { this.turns.push({ type: 'ended', ...ev }) },
  }
}

describe('the verb catalogue serves both transports (#314)', () => {
  test('one catalogue, eight verbs, in one order', () => {
    assert.deepEqual(VERB_TOOLS, ['tickets', 'next', 'status', 'start', 'map', 'cancel', 'resume', 'attach'])
    for (const spec of VERB_SPECS) {
      assert.ok(spec.description.length > 40, `${spec.verb} needs a description the model can act on`)
      assert.equal(typeof spec.args, 'object')
    }
  })

  test('the contract survived the cutover: #315 deleted a file and not a rule', () => {
    assert.equal(canonicalFor('start', { ticket: '314', repo: 'curia' }), 'start curia#314')
  })

  test('the HTTP transport publishes the same eight, with the same schemas', async () => {
    const posted = []
    const mcp = buildVerbMcpServer(async (text) => { posted.push(text); return `ran ${text}` })
    const client = new Client({ name: 'test', version: '0' })
    const [clientSide, serverSide] = (await import('@modelcontextprotocol/sdk/inMemory.js'))
      .InMemoryTransport.createLinkedPair()
    await Promise.all([mcp.connect(serverSide), client.connect(clientSide)])

    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name), VERB_TOOLS)

    const out = await client.callTool({ name: 'start', arguments: { ticket: '314' } })
    assert.equal(out.content[0].text, 'ran start 314')
    assert.deepEqual(posted, ['start 314'])

    // #255: a sentence in `ticket` never reaches the router. The transport
    // refuses it, which is the failure the daemon narrates as "refused before
    // the router" rather than as a command line nothing ran.
    const refused = await client.callTool({ name: 'start', arguments: { ticket: 'work on the map please' } })
    assert.equal(refused.isError, true)
    assert.deepEqual(posted, ['start 314'])
    await client.close()
  })
})

describe('the per-turn secret (#314)', () => {
  test('it opens one turn, and nothing else', () => {
    const turns = new OverseerTurns()
    const turn = turns.begin({ key: 'console-1', command: async () => 'ok' })
    assert.equal(turns.claim(turn.id, turn.token), turn)
    assert.equal(turns.claim(turn.id, 'not the secret'), null)
    assert.equal(turns.claim(turn.id, undefined), null)
    assert.equal(turns.claim('no such turn', turn.token), null)
    turns.end(turn.id)
    assert.equal(turns.claim(turn.id, turn.token), null, 'a turn that ended opens nothing')
    assert.equal(turns.size, 0)
  })

  test('a verb call is narrated, counted, and posted as interpreted', async () => {
    const turns = new OverseerTurns()
    const said = []
    const seen = []
    const turn = turns.begin({
      key: '999', routeThreadId: 'thread-9',
      narrate: async (t) => { said.push(t) },
      command: async (text, ctx) => { seen.push([text, ctx]); return 'the confirm was posted' },
    })
    const reply = await turn.command('cancel 314')
    assert.equal(reply, 'the confirm was posted')
    assert.deepEqual(said, ['cancel 314'])
    // #94: interpreted text routes a destructive verb through the ✅/❌ confirm.
    // #388: the conversation key rides along, so the command event the daemon
    // journals for this crossing can be counted against this turn after the
    // process holding the tally is gone.
    assert.deepEqual(seen, [['cancel 314', { threadId: 'thread-9', interpreted: true, overseerKey: '999' }]])
    assert.equal(turn.crossed.get('cancel'), 1)
  })

  test('a status line that throws never costs the effect', async () => {
    const turns = new OverseerTurns()
    const turn = turns.begin({
      key: '1', narrate: async () => { throw new Error('discord is down') }, command: async () => 'done',
    })
    assert.equal(await turn.command('status'), 'done')
    assert.equal(turn.crossed.get('status'), 1)
  })
})

describe('the container half: POST /turn (#314)', () => {
  test('it refuses a turn it cannot run, before the stream opens', async () => {
    assert.match(refuseTurn({}), /`key`/)
    assert.match(refuseTurn({ key: 'console-1' }), /`prompt`/)
    assert.match(refuseTurn({ key: 'console-1', prompt: 'hi' }), /mcp\.url/)
    assert.equal(refuseTurn({ key: 'console-1', prompt: 'hi', mcp: { url: 'http://x/mcp' } }), null)

    const root = tmpRoot('turn-refuse')
    const c = await startContainer({ cfg: cfgFor(root), queryFn: sayingModel('never'), sync: okSync([]) })
    const res = await fetch(`http://127.0.0.1:${c.port}${TURN_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'console-1' }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /`prompt`/)
    await c.stop()
  })

  test('it answers no route it does not have', async () => {
    const root = tmpRoot('turn-404')
    const c = await startContainer({ cfg: cfgFor(root), queryFn: sayingModel('never'), sync: okSync([]) })
    const res = await fetch(`http://127.0.0.1:${c.port}/whatever`)
    assert.equal(res.status, 404)
    const ping = await fetch(`http://127.0.0.1:${c.port}/ping`)
    assert.equal(ping.status, 200)
    await c.stop()
  })

  test('the model runs with the shell posture, this turn\'s verdict, and the seam it was handed', async () => {
    const root = tmpRoot('turn-options')
    let options = null
    const c = await startContainer({
      cfg: cfgFor(root, ['alp82/curia', 'getalfredo/site']),
      queryFn: sayingModel('done', { onOptions: (o) => { options = o } }),
      sync: async () => ({
        root: 'x', at: '2026-08-16T10:00:00.000Z', removed: [],
        repos: [
          { repo: 'alp82/curia', ok: true, fetchedAt: '2026-08-16T10:00:00.000Z' },
          { repo: 'getalfredo/site', ok: false, error: 'fatal: could not read from remote', staleSince: '2026-08-16T06:00:00.000Z' },
        ],
      }),
    })
    const res = await fetch(`http://127.0.0.1:${c.port}${TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: '4242', prompt: 'what changed on 314?', resume: 'sess-earlier',
        mcp: { url: 'http://host.docker.internal:4271/overseer/mcp?turn=abc', headers: { [TOKEN_HEADER]: 'secret' } },
      }),
    })
    assert.equal(res.status, 200)
    await res.text()

    // ADR-0014's model, and the container's own two directories.
    assert.equal(options.model, OVERSEER_CONTAINER_MODEL)
    assert.equal(options.cwd, overseerHomeFor(root))
    assert.equal(options.resume, 'sess-earlier')
    assert.equal(options.maxTurns, CONTAINER_MAX_TURNS)
    assert.equal(options.env.CLAUDE_CONFIG_DIR, overseerConfigDirFor(root))
    // The host credential store is the first thing the boundary denies.
    assert.equal(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined)
    // SDK 0.3.220 defers MCP schemas behind ToolSearch, which this turn
    // disallows — without this flag the model holds no verb at all (2026-08-16).
    assert.equal(options.env.ENABLE_TOOL_SEARCH, '0')

    // #328's one call for the text, #328's one call for the list.
    assert.match(options.systemPrompt, /You hold a shell, and it reads/)
    assert.match(options.systemPrompt, /alp82__curia/)
    assert.ok(!options.systemPrompt.includes('You have no shell'))
    // #314's own line: the verdict the checkout pass returned.
    assert.match(options.systemPrompt, /getalfredo\/site is STALE/)
    assert.match(options.systemPrompt, /last good fetch was .* ago/)
    assert.ok(options.allowedTools.includes('Bash'))
    assert.ok(options.allowedTools.includes('mcp__curia__start'))
    assert.ok(!options.disallowedTools.includes('Bash'))
    assert.ok(options.disallowedTools.includes('Write'))

    // The seam the daemon handed it, unchanged.
    assert.deepEqual(options.mcpServers.curia, {
      type: 'http',
      url: 'http://host.docker.internal:4271/overseer/mcp?turn=abc',
      headers: { [TOKEN_HEADER]: 'secret' },
    })
    // The seed ran: no first-run dialog, and the home the turn runs in exists.
    assert.ok(fs.existsSync(path.join(overseerConfigDirFor(root), '.claude.json')))
    assert.ok(fs.existsSync(overseerHomeFor(root)))
    await c.stop()
  })

  test('the watch list is read per turn, and a broken reload keeps the last good one', async () => {
    const root = tmpRoot('turn-cfg')
    const seen = []
    let broken = false
    const server = http.createServer(overseerHandler({
      log: quiet,
      turn: turnRoute({
        loadCfg: () => {
          if (broken) throw new Error('curia.yaml: bad indentation')
          return cfgFor(root, ['alp82/curia'])
        },
        log: quiet,
        queryFn: sayingModel('ok'),
        creds: async () => [],
        sync: async (_root, repos) => {
          seen.push(repos)
          return { root: 'x', at: 'now', removed: [], repos: repos.map((repo) => ({ repo, ok: true })) }
        },
      }),
    }))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const post = () => fetch(`http://127.0.0.1:${port}${TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'console-1', prompt: 'hi', mcp: { url: 'http://x/mcp' } }),
    })
    await (await post()).text()
    broken = true
    const body = await (await post()).text()
    assert.match(body, /the config did not reload/)
    assert.deepEqual(seen, [['alp82/curia'], ['alp82/curia']], 'the last good config still names the watch list')
    await new Promise((r) => server.close(r))
  })

  test('a model that dies ends the stream with the reason, never with silence', async () => {
    const root = tmpRoot('turn-dead')
    const c = await startContainer({
      cfg: cfgFor(root),
      sync: okSync(['alp82/curia']),
      // eslint-disable-next-line require-yield
      queryFn: async function* () { throw new Error('the model refused the credential') },
    })
    const res = await fetch(`http://127.0.0.1:${c.port}${TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'console-1', prompt: 'hi', mcp: { url: 'http://x/mcp' } }),
    })
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l))
    const end = events.at(-1)
    assert.equal(end.event, TURN_EVENTS.end)
    assert.equal(end.ok, false)
    assert.match(end.why, /refused the credential/)
    await c.stop()
  })

  test('the one-line checkout note names what is stale and what was pruned', () => {
    assert.equal(checkoutNote({ repos: [{ repo: 'a/b', ok: true }] }), 'checkouts: 1/1 fetched')
    assert.equal(
      checkoutNote({ repos: [{ repo: 'a/b', ok: true }, { repo: 'c/d', ok: false }], removed: ['e__f'] }),
      'checkouts: 1/2 fetched · stale: c/d · pruned: e__f',
    )
  })
})

// The git routing, re-read per turn (#361). The real `install` writes the
// runner's own global git config, so every case below injects its own.
// The model credential is re-read per turn (#648). #726 removes the environment
// fallback, so the store is the only source.
describe('the model credential is a file the daemon rewrites (#648)', () => {
  const OAT = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const OAT2 = 'sk-ant-oat01-bbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  test('the store supplies the credential', () => {
    const root = tmpRoot('turn-cred')
    new AnthropicCredentialStore({ workspaceRoot: root }).adopt(OAT)
    const { env, note } = modelCredentialEnv(root)
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAT)
    assert.equal(note, null)
  })

  test('an empty store requires re-authentication', () => {
    const root = tmpRoot('turn-cred-none')
    const { env, note } = modelCredentialEnv(root)
    assert.deepEqual(env, {})
    assert.match(note, /no anthropic credential/)
    assert.match(note, /reauth anthropic/)
  })

  test('legacy model variables are removed from the inherited environment', () => {
    const env = overseerProcessEnv({
      PATH: '/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'the-frozen-seed',
      ANTHROPIC_API_KEY: 'the-metered-key',
    })
    assert.deepEqual(env, { PATH: '/bin' })
  })

  test('A REWRITTEN FILE REACHES THE NEXT TURN WITH NOTHING RESTARTED', async () => {
    // The whole point of the relocation, and the one thing the env file could
    // never do. Two turns against one running container, and the daemon
    // replaces the credential between them.
    const root = tmpRoot('turn-cred-reread')
    const store = new AnthropicCredentialStore({ workspaceRoot: root })
    store.adopt(OAT)
    const seen = []
    const c = await startContainer({
      cfg: cfgFor(root, []),
      queryFn: sayingModel('ok', { onOptions: (o) => seen.push(o.env.CLAUDE_CODE_OAUTH_TOKEN) }),
      sync: okSync([]),
    })
    const turn = async () => {
      const res = await fetch(`http://127.0.0.1:${c.port}${TURN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'k', prompt: 'hi', mcp: { url: 'http://x/mcp' } }),
      })
      await res.text()
    }
    await turn()
    store.adopt(OAT2)
    await turn()
    assert.deepEqual(seen, [OAT, OAT2], 'the second turn read the file the daemon had just rewritten')
    assert.ok(fs.existsSync(anthropicStoreFile(root)))
    await c.stop()
  })
})

describe('the git routing follows the watch list (#361)', () => {
  // The tokens tree the daemon writes and the container mounts read-only (#392).
  const tokens = (() => {
    const dir = tmpRoot('turn-tokens')
    writeOverseerToken(dir, 'alp82', 'tok_alp82')
    return dir
  })()

  test('a routed watch list produces no note at all', async () => {
    const seen = []
    const notes = await credentialPass(['alp82/curia'], tokens, {
      install: async (repos) => { seen.push(repos) },
    })
    assert.deepEqual(notes, [])
    assert.deepEqual(seen, [['alp82/curia']], 'the pass writes the routing for the repos it was handed')
  })

  test('an owner with no token is named with the FILE the daemon writes', async () => {
    const [note, ...rest] = await credentialPass(['alp82/curia', 'newperson/bar'], tokens, {
      install: async () => {},
    })
    assert.equal(rest.length, 0, 'one note per unrouted owner, and alp82 is routed')
    assert.match(note, new RegExp(path.join(tokens, 'newperson')), 'the note names the file that is missing')
    assert.match(note, /newperson\/\*/)
    assert.doesNotMatch(note, /\.env\.overseer/, 'the source moved with #392, and the sentence follows it')
    // One composer, so this sentence cannot drift from the container's boot log.
    assert.ok(note.endsWith(unroutedNote({ owner: 'newperson', file: path.join(tokens, 'newperson') })))
  })

  test('a routing that will not install leaves the last good one and says so', async () => {
    const notes = await credentialPass(['alp82/curia'], tokens, {
      install: async () => { throw new Error('git config: could not lock config file\nand more') },
      unrouted: () => { throw new Error('unreachable: a failed install answers before this') },
    })
    assert.equal(notes.length, 1)
    assert.match(notes[0], /could not lock config file/)
    assert.ok(!notes[0].includes('and more'), 'one line, not a stack')
    assert.match(notes[0], /last good pass/)
  })

  test('the turn re-routes on the watch list of THAT turn, and streams what it cannot route', async (t) => {
    const root = tmpRoot('turn-creds')
    const seen = []
    let watched = ['alp82/curia']
    const server = http.createServer(overseerHandler({
      log: quiet,
      turn: turnRoute({
        loadCfg: () => cfgFor(root, watched),
        log: quiet,
        queryFn: sayingModel('ok'),
        sync: okSync(watched),
        creds: async (repos, dir) => {
          seen.push({ repos, dir })
          return repos.includes('newperson/bar') ? [`⚠️ no token file at ${path.join(dir, 'newperson')}`] : []
        },
      }),
    }))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    // Closed on the way out however this test ends. A listener left open by a
    // failed assertion holds the event loop, and the runner then reports a file
    // that hangs instead of the assertion that broke.
    t.after(() => new Promise((r) => server.close(r)))
    const port = server.address().port
    const post = () => fetch(`http://127.0.0.1:${port}${TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'console-1', prompt: 'hi', mcp: { url: 'http://x/mcp' } }),
    })
    const first = await (await post()).text()
    assert.ok(!/no token file/.test(first), 'nothing to say while every owner is routed')

    // The operator adds a repo of an owner this container holds no token for.
    // No restart, no recreate: the next turn is what re-routes.
    watched = ['alp82/curia', 'newperson/bar']
    const second = await (await post()).text()
    assert.deepEqual(seen.map((s) => s.repos), [['alp82/curia'], ['alp82/curia', 'newperson/bar']],
      'the second turn routes the watch list as it stands NOW, not as the container booted')
    assert.deepEqual(seen.map((s) => s.dir), Array(2).fill(overseerTokensRootFor(root)),
      'the routing reads the tokens tree the daemon writes (#392)')
    const notes = second.trim().split('\n').map((l) => JSON.parse(l))
      .filter((e) => e.event === TURN_EVENTS.note).map((e) => e.text)
    assert.ok(notes.some((n) => /no token file/.test(n)), 'the operator reads the cause, not only a failed fetch')
    assert.ok(notes.some((n) => /checkouts:/.test(n)), 'the checkout verdict still lands beside it')
  })
})

describe('the daemon half: OverseerClient (#314)', () => {
  test('it posts the turn, binds the session, says the answer once', async () => {
    const root = tmpRoot('client-turn')
    const c = await startContainer({
      cfg: cfgFor(root), sync: okSync(['alp82/curia']),
      queryFn: sayingModel('two tickets are takeable', { sessionId: 'sess-42' }),
    })
    const reduction = storeDouble()
    const client = new OverseerClient({
      reduction, command: async () => 'unused', workspaceRoot: root, port: c.port, daemonPort: 4271, log: quiet,
    })
    const said = []
    const status = []
    const out = await client.runTurn('console-1', 'what is takeable?', {
      say: (t) => said.push(t), status: (t) => status.push(t),
    })
    assert.equal(out.ok, true)
    assert.deepEqual(said, ['two tickets are takeable'])
    assert.deepEqual(reduction.bound, [['console-1', 'sess-42']])
    assert.equal(out.sessionId, 'sess-42')
    assert.ok(status.some((s) => /checkouts: 1\/1 fetched/.test(s)), 'the checkout pass reaches the status line while the turn runs')
    // ADR-0015: the container holds no conversation, so the daemon sends the
    // resume id and the model reads its own words back.
    assert.equal(client.configDir, overseerConfigDirFor(root))
    // #388: the turn is bracketed in the journal, message and all, so a restart
    // between these two lines can find it and send the message again.
    assert.deepEqual(reduction.turns.map((t) => t.type), ['started', 'ended'])
    assert.equal(reduction.turns[0].prompt, 'what is takeable?')
    assert.equal(reduction.turns[0].replay, false)
    assert.deepEqual(
      { ok: reduction.turns[1].ok, crossings: reduction.turns[1].crossings },
      { ok: true, crossings: 0 },
    )
    await c.stop()
  })

  test('one turn at a time per conversation', async () => {
    const root = tmpRoot('client-busy')
    let release
    const held = new Promise((r) => { release = r })
    const c = await startContainer({
      cfg: cfgFor(root),
      sync: okSync([]),
      queryFn: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's' }
        await held
        yield { type: 'result', subtype: 'success', result: 'late', num_turns: 1 }
      },
    })
    const client = new OverseerClient({
      reduction: storeDouble(), command: async () => '', workspaceRoot: root, port: c.port, daemonPort: 4271, log: quiet,
    })
    const first = client.runTurn('console-1', 'one', { say: () => {}, status: () => {} })
    const said = []
    const second = await client.runTurn('console-1', 'two', { say: (t) => said.push(t), status: () => {} })
    assert.equal(second.busy, true)
    assert.match(said[0], /one turn at a time/)
    release()
    assert.equal((await first).ok, true)
    await c.stop()
  })

  test('a container that is not there is a failure the operator reads', async () => {
    const root = tmpRoot('client-down')
    const client = new OverseerClient({
      reduction: storeDouble(), command: async () => '', workspaceRoot: root,
      // Nothing listens here: the container is down, or the deploy is mid-flight.
      port: 1, daemonPort: 4271, log: quiet,
    })
    const said = []
    const out = await client.runTurn('console-1', 'hello', { say: (t) => said.push(t), status: () => {} })
    assert.equal(out.ok, false)
    assert.equal(said.length, 1)
    assert.match(said[0], /the overseer container did not answer/)
  })

  test('a browser turn on a deleted conversation mints nothing', async () => {
    const root = tmpRoot('client-deleted')
    const client = new OverseerClient({
      reduction: storeDouble({ conversations: [] }), command: async () => '', workspaceRoot: root, port: 1, daemonPort: 4271, log: quiet,
    })
    await assert.rejects(() => client.browserTurn('console-7', 'hi'), /its number is spent/)
  })

  test('a call the transport refused reads as refused, not as silence', async () => {
    const root = tmpRoot('client-refused')
    const c = await startContainer({
      cfg: cfgFor(root),
      sync: okSync([]),
      // The model asks for a verb, and the result comes back without the daemon
      // ever narrating one — which is what a schema refusal looks like (#275).
      queryFn: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's' }
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__curia__start' }] } }
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }
        yield { type: 'result', subtype: 'success', result: 'I could not start it', num_turns: 2 }
      },
    })
    const client = new OverseerClient({
      reduction: storeDouble(), command: async () => '', workspaceRoot: root, port: c.port, daemonPort: 4271, log: quiet,
    })
    const status = []
    const out = await client.runTurn('console-1', 'start it', { say: () => {}, status: (t) => status.push(t) })
    assert.equal(out.ok, true)
    assert.equal(out.toolCalls, 1)
    assert.match(status.at(-1), /`start` refused before the router/)
    await c.stop()
  })
})

// #678. The overseer runs on the anthropic credential and takes a turn whenever
// the operator speaks, so a failed turn is the earliest thing on the box that
// can know the credential died — the detector's own schedule is ten minutes
// wide. The turn supplies the TIMING; the detector still supplies the VERDICT.
describe('a failed overseer turn re-checks the anthropic credential (#678)', () => {
  // The container, faked at the fetch seam, so all four failure shapes in
  // `#hop` can be produced without four containers. `body` is what
  // `turnEvents` iterates: NDJSON lines, or a throw for a stream that died.
  const hop = ({ status = 200, lines = null, throws = null }) => async () => {
    if (throws) throw new Error(throws)
    return {
      ok: status < 400,
      status,
      text: async () => 'detail',
      body: (async function* () { for (const l of lines ?? []) yield `${JSON.stringify(l)}\n` })(),
    }
  }
  const clientWith = (fetchImpl, onModelCallFailed) => new OverseerClient({
    reduction: storeDouble(),
    command: async () => '',
    workspaceRoot: tmpRoot('client-678'),
    port: 4999,
    daemonPort: 4271,
    log: quiet,
    fetchImpl,
    onModelCallFailed,
  })
  const ended = (ok, why = null) => [
    { event: 'session', id: 's-678' },
    { event: 'end', ok, why, tool_calls: 0 },
  ]

  test('all four failure shapes ask, and none of them classifies anything itself', async () => {
    const shapes = [
      ['the container refused the turn', hop({ status: 503 })],
      ['the stream died', hop({ throws: 'socket hang up' })],
      ['the stream closed with no end event', hop({ lines: [{ event: 'session', id: 's' }] })],
      ['the turn ended not ok', hop({ lines: ended(false, 'the model refused') })],
    ]
    for (const [what, fetchImpl] of shapes) {
      const asked = []
      const client = clientWith(fetchImpl, async () => { asked.push('asked'); return null })
      const out = await client.runTurn('console-1', 'hello', { say: () => {}, status: () => {} })
      assert.equal(out.ok, false, what)
      assert.deepEqual(asked, ['asked'], `${what} asks the detector exactly once`)
    }
  })

  test('a turn that succeeded asks nothing', async () => {
    const asked = []
    const client = clientWith(hop({ lines: ended(true) }), async () => { asked.push('asked'); return null })
    const out = await client.runTurn('console-1', 'hello', { say: () => {}, status: () => {} })
    assert.equal(out.ok, true)
    assert.deepEqual(asked, [], 'nothing failed, so nothing is asked')
  })

  // Structurally excluded rather than filtered: the busy branch returns before
  // a turn is ever registered, so there is no failed model call to report.
  test('a busy conversation asks nothing — no turn ever ran', async () => {
    const asked = []
    let release
    const held = new Promise((r) => { release = r })
    const client = clientWith(async () => { await held; return hop({ lines: ended(true) })() },
      async () => { asked.push('asked'); return null })
    const first = client.runTurn('console-1', 'one', { say: () => {}, status: () => {} })
    const second = await client.runTurn('console-1', 'two', { say: () => {}, status: () => {} })
    assert.equal(second.busy, true)
    assert.deepEqual(asked, [])
    release()
    await first
  })

  test('a clean check leaves the failure line exactly as it was', async () => {
    const said = []
    const client = clientWith(hop({ lines: ended(false, 'max_turns') }), async () => null)
    const out = await client.runTurn('console-1', 'hello', { say: (t) => said.push(t), status: () => {} })
    assert.equal(out.ok, false)
    assert.equal(said.length, 1)
    assert.match(said[0], /session ended without an answer \(max_turns\)/)
    assert.doesNotMatch(said[0], /anthropic/i, 'a turn that failed for its own reasons says nothing about credentials')
  })

  test('a held lane puts a pointer on the line — no link of its own, and not the hold’s why', async () => {
    const said = []
    const client = clientWith(
      hop({ lines: ended(false, 'the model refused') }),
      async () => ({ provider: 'anthropic', why: 'Anthropic rejected the static credential with HTTP 401 authentication_error' }),
    )
    const out = await client.runTurn('console-1', 'hello', { say: (t) => said.push(t), status: () => {} })

    assert.equal(out.ok, false)
    assert.equal(said.length, 1, 'still one message in the answer slot')
    assert.match(said[0], /session ended without an answer/, 'the turn’s own failure still leads')
    assert.match(said[0], /`anthropic` lane is held/, 'the lane is named from the hold, not from a literal here')
    assert.match(said[0], /#curia/)
    assert.match(said[0], /dashboard/)
    // One login, one link, said where the alarm was said (#676).
    assert.doesNotMatch(said[0], /http/, 'the pointer carries no link of its own')
    assert.doesNotMatch(said[0], /401|authentication_error/, 'and never repeats the hold’s own account of the fault')
  })

  // The Chat screen reads the same strings back out of `browserTurn`, which is
  // why the line is composed in `runTurn` and not in either door.
  test('the Chat screen reads the same pointer the thread does', async () => {
    const client = clientWith(
      hop({ lines: ended(false, 'the model refused') }),
      async () => ({ provider: 'anthropic', why: 'irrelevant here' }),
    )
    await assert.rejects(
      () => client.browserTurn('console-1', 'hello'),
      /`anthropic` lane is held/,
    )
  })

  // A pointer one turn late is the failure this ticket exists to remove, so the
  // check is awaited before the line is composed rather than fired alongside it.
  test('the check is awaited before the line is composed', async () => {
    const order = []
    const client = clientWith(hop({ lines: ended(false, 'the model refused') }), async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push('checked')
      return { provider: 'anthropic', why: 'dead' }
    })
    await client.runTurn('console-1', 'hello', {
      say: () => { order.push('said') },
      status: () => {},
    })
    assert.deepEqual(order, ['checked', 'said'])
  })

  // The detector is one more thing that can be down, and a turn that already
  // failed must not fail twice. The operator still gets the turn's own failure.
  test('a check that throws costs the operator nothing', async () => {
    const said = []
    const client = clientWith(hop({ lines: ended(false, 'the model refused') }), async () => {
      throw new Error('the probe is unreachable')
    })
    const out = await client.runTurn('console-1', 'hello', { say: (t) => said.push(t), status: () => {} })
    assert.equal(out.ok, false)
    assert.match(said[0], /session ended without an answer/)
  })

  test('a client wired to nothing behaves exactly as it did before', async () => {
    const said = []
    const client = clientWith(hop({ lines: ended(false, 'the model refused') }), undefined)
    const out = await client.runTurn('console-1', 'hello', { say: (t) => said.push(t), status: () => {} })
    assert.equal(out.ok, false)
    assert.match(said[0], /session ended without an answer/)
  })
})

describe('the whole crossing: a verb reaches /command from inside the container (#314)', () => {
  let daemon, container, turns, posted, client, reduction

  before(async () => {
    turns = new OverseerTurns()
    daemon = await startDaemonSeam(turns)
    posted = []
    reduction = storeDouble()
    const root = tmpRoot('crossing')

    // The fake model IS an MCP client: it takes the url and the header the
    // daemon put in the turn request, and calls the verb over them.
    const queryFn = async function* ({ options }) {
      yield { type: 'system', subtype: 'init', session_id: 'sess-cross' }
      const url = new URL(options.mcpServers.curia.url)
      const mcp = new Client({ name: 'overseer-model', version: '0' })
      await mcp.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: options.mcpServers.curia.headers },
      }))
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__curia__cancel' }] } }
      const out = await mcp.callTool({ name: 'cancel', arguments: { ticket: '314' } })
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: out.content }] } }
      await mcp.close()
      yield { type: 'result', subtype: 'success', result: `the confirm is posted: ${out.content[0].text}`, num_turns: 2 }
    }

    container = await startContainer({ cfg: cfgFor(root), sync: okSync([]), queryFn })
    client = new OverseerClient({
      reduction,
      command: async (text, ctx) => { posted.push([text, ctx]); return '✅/❌ posted in #curia' },
      workspaceRoot: root,
      port: container.port,
      daemonPort: daemon.port,
      daemonHost: '127.0.0.1',
      turns,
      log: quiet,
    })
  })

  after(async () => {
    await container.stop()
    await daemon.stop()
  })

  test('the effect crosses /command, and the confirm survives the boundary', async () => {
    const said = []
    const status = []
    const out = await client.runTurn('4242', 'cancel 314', {
      say: (t) => said.push(t), status: (t) => status.push(t),
    })
    assert.equal(out.ok, true)
    // The daemon executed the effect, from text the DAEMON composed.
    assert.deepEqual(posted, [['cancel 314', { threadId: '4242', interpreted: true, overseerKey: '4242' }]])
    assert.match(said[0], /the confirm is posted: ✅\/❌ posted in #curia/)
    // The status line grew live, from the seam rather than from the stream.
    assert.ok(status.some((s) => s.includes('`cancel 314`')))
    // No "refused before the router" line: this call reached the handler.
    assert.ok(!status.some((s) => s.includes('refused before the router')))
    assert.equal(turns.size, 0, 'the turn secret dies with the turn')
  })

  test('the same call with the wrong secret reaches no router at all', async () => {
    const turn = turns.begin({ key: '1', command: async () => 'never' })
    const res = await fetch(`http://127.0.0.1:${daemon.port}${OVERSEER_MCP_PATH}?turn=${turn.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [TOKEN_HEADER]: 'a'.repeat(64) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 403)
    assert.match((await res.json()).error, /no live curia overseer turn/)
    turns.end(turn.id)
  })
})

// ---- the cutover (#315) -----------------------------------------------------
//
// The in-daemon host is gone, and the client above answers BOTH surfaces. What
// moved here with the cutover is the conversation behavior the host's suite
// pinned and the client must keep: the confirm notes that drain into the next
// prompt exactly once, and a one-turn lock that is per conversation rather
// than global.

describe('the cutover: the client keeps the host\'s conversation behavior (#315)', () => {
  test('pending confirm notes prefix the next prompt and drain exactly once (#94)', async () => {
    const root = tmpRoot('client-notes')
    const prompts = []
    const c = await startContainer({
      cfg: cfgFor(root), sync: okSync([]),
      queryFn: async function* ({ prompt }) {
        prompts.push(prompt)
        yield { type: 'system', subtype: 'init', session_id: 's' }
        yield { type: 'result', subtype: 'success', result: 'noted', num_turns: 1 }
      },
    })
    const reduction = storeDouble({ notes: ['confirm esc-1 approved'] })
    const client = new OverseerClient({
      reduction, command: async () => '', workspaceRoot: root, port: c.port, daemonPort: 4271, log: quiet,
    })
    const io = { say: () => {}, status: () => {} }
    await client.runTurn('console-1', 'first message', io)
    assert.equal(prompts[0], '[curia: confirm esc-1 approved]\n\nfirst message')
    await client.runTurn('console-1', 'second message', io)
    assert.equal(prompts[1], 'second message', 'the note was drained by the first turn')
    await c.stop()
  })

  test('the one-turn lock is per conversation: a second conversation answers while the first runs', async () => {
    const root = tmpRoot('client-two-convos')
    let release
    const held = new Promise((r) => { release = r })
    let n = 0
    const c = await startContainer({
      cfg: cfgFor(root), sync: okSync([]),
      queryFn: async function* () {
        const mine = ++n
        yield { type: 'system', subtype: 'init', session_id: `sess-c${mine}` }
        if (mine === 1) await held
        yield { type: 'result', subtype: 'success', result: 'done', num_turns: 1 }
      },
    })
    const client = new OverseerClient({
      reduction: storeDouble({ conversations: ['console-1', 'console-2'] }),
      command: async () => '', workspaceRoot: root, port: c.port, daemonPort: 4271, log: quiet,
    })
    const slow = client.browserTurn('console-1', 'slow one')
    const out = await client.browserTurn('console-2', 'the other conversation')
    assert.equal(out.ok, true, 'the second conversation did not wait on the first')
    release()
    assert.equal((await slow).ok, true)
    await c.stop()
  })
})

// ---- the conversation state the daemon keeps (moved here by #315) -----------
//
// These drove the REAL reduction from overseer.test.mjs until the cutover deleted
// that file with the host. The state outlived the host — ADR-0015 keeps every
// conversation in the daemon — so its tests live with the boundary suite now.

describe('Reduction overseer sessions', () => {
  test('bindOverseerSession appends a journal line and reduces last-write-wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-reduction-'))
    const reduction = new Reduction(dir)
    reduction.bindOverseerSession('thread-1', 'sess-1')
    reduction.bindOverseerSession('thread-1', 'sess-2')
    reduction.bindOverseerSession('thread-9', 'sess-9')
    assert.equal(reduction.overseerSession('thread-1'), 'sess-2')
    assert.equal(reduction.overseerSession('thread-9'), 'sess-9')
    const replayed = new Reduction(dir)
    assert.equal(replayed.overseerSession('thread-1'), 'sess-2')
    const lines = journalEvents(dir)
    assert.equal(lines.filter((l) => l.type === 'overseer_session').length, 3)
  })
})

// The register of browser conversations (#333, ADR-0016). It is journalled for
// the reason the resume handle above is: a restart must not forget which
// conversations the operator has. It carries one fact the resume handle does
// not — which numbers are SPENT — and that fact has to outlive a delete.
describe('Reduction browser conversations (#333)', () => {
  test('a mint is journalled, and the list comes back after a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-reduction-'))
    const reduction = new Reduction(dir)
    assert.equal(reduction.openConsoleConversation(), 'console-1')
    assert.equal(reduction.openConsoleConversation(), 'console-2')
    assert.deepEqual(reduction.consoleConversationList().map((c) => c.key), ['console-2', 'console-1'], 'newest first — the order the picker draws')
    const replayed = new Reduction(dir)
    assert.deepEqual(replayed.consoleConversationList().map((c) => c.key), ['console-2', 'console-1'])
    assert.ok(replayed.hasConsoleConversation('console-1'))
  })

  test('a deleted number stays spent across a restart — the whole point of counting up', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-reduction-'))
    const reduction = new Reduction(dir)
    reduction.openConsoleConversation()
    reduction.openConsoleConversation()
    assert.equal(reduction.deleteConsoleConversation('console-2'), true)
    assert.equal(reduction.openConsoleConversation(), 'console-3', 'not console-2 again')
    // And the same after a boot replay: the spent set is a reduction over the
    // journal, so it cannot be lost with the process that minted it.
    const replayed = new Reduction(dir)
    assert.equal(replayed.hasConsoleConversation('console-2'), false)
    assert.equal(replayed.openConsoleConversation(), 'console-4')
  })

  test('the delete takes the resume handle and the waiting notes with it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-reduction-'))
    const reduction = new Reduction(dir)
    const key = reduction.openConsoleConversation()
    reduction.bindOverseerSession(key, 'sess-c1')
    reduction.addOverseerNote(key, 'confirm esc-1 approved')
    reduction.deleteConsoleConversation(key)
    assert.equal(reduction.overseerSession(key), undefined)
    assert.deepEqual(reduction.takeOverseerNotes(key), [])
    // The replay must reach the same state, not the state the bind wrote: the
    // delete event comes after it, so the reduction has to undo it in order.
    const replayed = new Reduction(dir)
    assert.equal(replayed.overseerSession(key), undefined)
  })

  test('deleting what is not there is refused rather than journalled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-reduction-'))
    const reduction = new Reduction(dir)
    assert.equal(reduction.deleteConsoleConversation('console-9'), false)
    assert.deepEqual(journalEvents(dir), [], 'nothing was written')
  })
})
