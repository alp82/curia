// One durable tool identity per overseer conversation (#701, ADR-0024).
//
// The seams under test are the ones a pane actually meets: the token store the
// daemon mints from, the pure route a verb call lands on, and the `/overseer/mcp`
// handler that joins them. The MCP transport is the in-memory pair the turn
// tests use, so a tool call here is a real tool call.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  carryOverseerTranscript, claudeProjectSlug, conversationHomeFor,
  conversationMcpUrl, conversationTokenFile, conversationTokenMatches,
  conversationTokensDir, ensureConversationToken, isOverseerKey, overseerRoute,
  readConversationToken, revokeConversationToken, sweepConversationTokens,
  writeConversationConnection, OVERSEER_CONVERSATION_PARAM,
} from '../src/overseeridentity.mjs'
import { serveConversationMcp } from '../src/overseerclient.mjs'
import { TOKEN_HEADER } from '../src/agenttoken.mjs'

const SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `curia-${name}-`))
}

// The route as a pane meets it: authenticate, then call one verb and read what
// the seam was handed. `posted` is what the router would have received.
async function callVerb({ dataDir, key, presented, name = 'status', args = {} }) {
  const posted = []
  let refusal = null
  let served = null
  await serveConversationMcp({
    dataDir,
    key,
    presented,
    log: () => {},
    command: async (text, ctx) => { posted.push([text, ctx]); return `ran ${text}` },
    refuse: (error) => { refusal = error },
    serve: async (mcp, route) => { served = { mcp, route } },
  })
  if (refusal) return { refusal, posted }
  const client = new Client({ name: 'test', version: '0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([served.mcp.connect(serverSide), client.connect(clientSide)])
  const out = await client.callTool({ name, arguments: args })
  await client.close()
  return { refusal: null, posted, out, route: served.route }
}

describe('the conversation token (#701)', () => {
  test('the daemon mints one token per conversation and reads the same one back', () => {
    const data = tmpDir('conversation-token')

    const first = ensureConversationToken(data, 'console-4')
    const again = ensureConversationToken(data, 'console-4')
    const other = ensureConversationToken(data, '981234567890')

    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(again, first, 'a conversation keeps the identity it was minted')
    assert.notEqual(other, first, 'two conversations never share one identity')
    assert.equal(readConversationToken(data, 'console-4'), first)
    assert.equal(fs.statSync(conversationTokenFile(data, 'console-4')).mode & 0o777, 0o600)
  })

  test('a restart reads the token off disk, so a rehydrated pane keeps its identity', () => {
    const data = tmpDir('conversation-token-restart')
    const before = ensureConversationToken(data, 'console-7')

    // A restart is a new process reading the same directory. Nothing else is
    // carried over, which is the whole point of the file.
    const after = ensureConversationToken(data, 'console-7')

    assert.equal(after, before)
    assert.equal(conversationTokenMatches(data, 'console-7', before), true)
  })

  test('validation fails closed on every miss', () => {
    const data = tmpDir('conversation-token-closed')
    const token = ensureConversationToken(data, 'console-1')

    assert.equal(conversationTokenMatches(data, 'console-1', token), true)
    assert.equal(conversationTokenMatches(data, 'console-1', 'not the secret'), false)
    assert.equal(conversationTokenMatches(data, 'console-1', undefined), false)
    assert.equal(conversationTokenMatches(data, 'console-2', token), false, 'one conversation cannot present another\'s name')
    assert.equal(conversationTokenMatches(data, '../etc/passwd', token), false)
    assert.throws(() => ensureConversationToken(data, 'ticket-701'), /not an overseer conversation key/)
  })

  test('a deleted conversation loses its token, and a sweep clears what nothing addresses', () => {
    const data = tmpDir('conversation-token-revoke')
    const token = ensureConversationToken(data, 'console-3')
    ensureConversationToken(data, 'console-9')
    ensureConversationToken(data, '981234567890')

    revokeConversationToken(data, 'console-3')
    assert.equal(conversationTokenMatches(data, 'console-3', token), false)
    assert.equal(readConversationToken(data, 'console-3'), null)

    const swept = sweepConversationTokens(data, ['981234567890'])
    assert.deepEqual(swept, ['console-9'])
    assert.deepEqual(fs.readdirSync(conversationTokensDir(data)), ['981234567890'])
  })
})

describe('the durable route (#701)', () => {
  test('a key names its own destination, and nothing else is a key', () => {
    assert.deepEqual(overseerRoute('981234567890'), {
      key: '981234567890', surface: 'discord', routeThreadId: '981234567890', role: 'overseer',
    })
    assert.deepEqual(overseerRoute('console-2'), {
      key: 'console-2', surface: 'console', routeThreadId: null, role: 'overseer',
    })
    assert.throws(() => overseerRoute('ticket-701'), /conversation key/)
    assert.equal(isOverseerKey('console-2'), true)
    assert.equal(isOverseerKey('681'), true)
    assert.equal(isOverseerKey('../981234567890'), false)
  })

  test('a Discord conversation routes its verb call to its own thread', async () => {
    const data = tmpDir('route-discord')
    const token = ensureConversationToken(data, '981234567890')

    const { posted, out, route } = await callVerb({
      dataDir: data, key: '981234567890', presented: token, name: 'cancel', args: { ticket: '701' },
    })

    assert.equal(out.content[0].text, 'ran cancel 701')
    assert.deepEqual(posted, [['cancel 701', {
      threadId: '981234567890', interpreted: true, overseerKey: '981234567890',
    }]])
    assert.equal(route.routeThreadId, '981234567890')
  })

  test('a browser conversation routes its verb call to no thread', async () => {
    const data = tmpDir('route-console')
    const token = ensureConversationToken(data, 'console-5')

    const { posted } = await callVerb({ dataDir: data, key: 'console-5', presented: token })

    assert.deepEqual(posted, [['status', { threadId: null, interpreted: true, overseerKey: 'console-5' }]])
  })

  test('pane-supplied destination text never changes the route', async () => {
    const data = tmpDir('route-forged')
    const token = ensureConversationToken(data, 'console-6')

    // Everything a pane can put in a tool call, aimed at another destination.
    // The arguments the catalogue admits reach the canonical text; the route
    // comes from the conversation the token proves.
    const { posted } = await callVerb({
      dataDir: data,
      key: 'console-6',
      presented: token,
      name: 'start',
      args: { ticket: '701', repo: 'curia', threadId: '981234567890', overseerKey: 'console-1', key: '42' },
    })

    assert.deepEqual(posted, [['start curia#701', {
      threadId: null, interpreted: true, overseerKey: 'console-6',
    }]])
  })

  test('a pane that names another conversation is refused, and posts nothing', async () => {
    const data = tmpDir('route-crossed')
    const mine = ensureConversationToken(data, 'console-6')
    ensureConversationToken(data, 'console-8')

    const crossed = await callVerb({ dataDir: data, key: 'console-8', presented: mine })
    assert.match(crossed.refusal, /no curia overseer conversation "console-8" holds that token/)
    assert.deepEqual(crossed.posted, [])

    const bare = await callVerb({ dataDir: data, key: 'console-6', presented: undefined })
    assert.match(bare.refusal, /holds that token/)

    const unknown = await callVerb({ dataDir: data, key: 'ticket-701', presented: mine })
    assert.match(unknown.refusal, /holds that token/)
  })

  test('the token opens the verb catalogue and widens nothing', async () => {
    const data = tmpDir('route-authority')
    const token = ensureConversationToken(data, 'console-6')

    const { posted } = await callVerb({
      dataDir: data, key: 'console-6', presented: token, name: 'start', args: { ticket: 'deploy the box' },
    })

    assert.deepEqual(posted, [], 'a sentence in `ticket` is refused before the router, exactly as on a turn')
  })
})

describe('the pane\'s connection settings (#701)', () => {
  test('the daemon writes the token where the pane reads it, and nowhere else', () => {
    const home = path.join(tmpDir('pane-connection'), SESSION)
    const url = conversationMcpUrl({
      host: 'host.docker.internal', port: 8177, key: 'console-4', mcpPath: '/overseer/mcp',
    })

    const file = writeConversationConnection({
      home, url, token: 'a'.repeat(64), serverName: 'curia', header: TOKEN_HEADER,
    })

    assert.equal(url, `http://host.docker.internal:8177/overseer/mcp?${OVERSEER_CONVERSATION_PARAM}=console-4`)
    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(written.mcpServers.curia, {
      type: 'http', url, headers: { [TOKEN_HEADER]: 'a'.repeat(64) },
    })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
    assert.equal(settings.enableAllProjectMcpServers, true)
  })

  test('each conversation gets its own project directory, named by its session id', () => {
    assert.equal(conversationHomeFor('/cfg/home', SESSION), path.join('/cfg/home', SESSION))
    assert.throws(() => conversationHomeFor('/cfg/home', 'console-4'), /session id/)
  })

  test('a conversation bound before #701 carries its transcript into that directory', () => {
    const configDir = tmpDir('carry-transcript')
    const shared = path.join(configDir, 'projects', claudeProjectSlug('/work/cfg/curia-overseer/home'))
    fs.mkdirSync(shared, { recursive: true })
    fs.writeFileSync(path.join(shared, `${SESSION}.jsonl`), '{"type":"user"}\n')
    const home = `/work/cfg/curia-overseer/home/${SESSION}`

    const carried = carryOverseerTranscript({ configDir, sessionId: SESSION, home })

    assert.equal(carried, path.join(configDir, 'projects', claudeProjectSlug(home), `${SESSION}.jsonl`))
    assert.equal(fs.readFileSync(carried, 'utf8'), '{"type":"user"}\n')
    assert.equal(fs.existsSync(path.join(shared, `${SESSION}.jsonl`)), true, 'a copy, so a reader mid-scan loses nothing')
    assert.equal(carryOverseerTranscript({ configDir, sessionId: SESSION, home }), null, 'it carries once')
    assert.equal(carryOverseerTranscript({ configDir, sessionId: 'not-a-session', home }), null)
  })
})
