// The turn crosses the boundary (#314) — the protocol, and the CONTAINER half
// of it. The daemon half is `overseerclient.mjs`.
//
// One operator message is still one turn, and a turn is still one SDK
// `query()`. What changed is where that query runs. ADR-0014 moved the model
// into its own container, so a message now crosses two hops in opposite
// directions:
//
//   1. The daemon POSTs the turn to the container, at `127.0.0.1:<overseer
//      port>`, which is what compose publishes.
//   2. The model's verb tools reach BACK to the daemon, at
//      `host.docker.internal:<daemon port>/overseer/mcp`, the same path every
//      agent container takes for its side channel (#156, #188).
//
// WHY THE VERBS TAKE THE MCP SIDE CHANNEL. See `overseerverbs.mjs`: a route
// that took canonical text would hand the container the whole router, and a
// tool call hands it the verb catalogue with validated arguments. The daemon composes
// the canonical text on its own side, so `/command` still receives text the
// daemon wrote. Every effect crosses that seam, the daemon executes it, and the
// ✅/❌ confirm on `cancel` survives untouched.
//
// THE CONTAINER HOLDS NO CONVERSATION. ADR-0015: the container is not the
// conversation. The resume id lives in the daemon journal, travels here in the
// request, and the session id this turn states travels back. So a container
// restart loses no conversation, and two turns on two threads run here at once
// with nothing shared between them.
//
// THE RESPONSE IS A STREAM, not one JSON object at the end. A turn takes
// seconds to minutes, and three things must reach the operator while it runs:
// the session id (the Chat screen finds the transcript by it, #332), the
// checkout verdict, and the fact that a tool result came back. NDJSON, one
// event per line, is the whole encoding — the daemon reads it as it arrives.
//
// WHAT DOES NOT STREAM IS THE NARRATION OF A VERB. The daemon narrates that
// from its own MCP handler, as the call lands, because that is where the
// canonical text is composed. The status line therefore grows live without this
// stream carrying a word of it.

import fs from 'node:fs'
import path from 'node:path'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { seedConfigDir, agentEnv, cfgDirFor } from './workspace.mjs'
import { buildSystemPrompt, toolsFor, checkoutReport } from './overseerprompt.mjs'
import { syncCheckouts } from './checkouts.mjs'
import { installCredentialConfig, unroutedOwners, unroutedNote } from './overseercreds.mjs'
import { CLAUDE_CREDENTIAL_FILE, readClaudeCredentialToken } from './credentials.mjs'
import { pathsOf } from './paths.mjs'
import { SIGNALS } from './messaging.mjs'

// The route the daemon POSTs a turn to, on the container.
export const TURN_PATH = '/turn'

// The route the container's model reaches the verbs on, on the daemon. It is
// not an agent route: no `?agent=`, no minted-per-agent token file, and the
// per-turn secret that opens it lives in memory for the length of one turn
// (see `overseerclient.mjs`).
export const OVERSEER_MCP_PATH = '/overseer/mcp'

// The MCP server name the container publishes the verbs under. It must match
// the `mcp__curia__` prefix the allowed list carries, or the model holds no
// tools at all — the same one-constant rule workspace.mjs states for an agent.
export const MCP_SERVER_NAME = 'curia'

// Sonnet 5, as ADR-0014 decides. Haiku answered the in-daemon host's mapping
// from prose to the verbs, and this posture reads code and diffs.
export const OVERSEER_CONTAINER_MODEL = 'claude-sonnet-5'

// The in-daemon host capped a turn at 12 assistant turns, and that was sized
// for a model whose every turn was one verb call. A shell reads: list a
// directory, grep it, open two files, then answer. 12 would cut that answer
// off mid-read.
export const CONTAINER_MAX_TURNS = 40

// ---- where the container keeps its own two directories ---------------------
//
// ADR-0015 puts the config dir at `<workspace_root>/cfg/curia-overseer`, and
// compose mounts it at that identical path on both sides — which is what lets
// the Chat screen read a transcript this container wrote. This is the ONLY
// overseer config dir now. The in-daemon host held its own under
// `daemon/data/overseer/config`, and #315 deleted that host. Nothing reads the
// old tree any more, and the cutover copied no history (ADR-0016), so whatever
// a box still carries there is dead paper.
export const OVERSEER_SESSION = 'curia-overseer'

export function overseerConfigDirFor(workspaceRoot) {
  return cfgDirFor(workspaceRoot, OVERSEER_SESSION)
}

// The cwd every turn runs in, and it never moves: `resume` is keyed by cwd
// (#82), and the transcript of a session lands under a slug of it. It sits
// INSIDE the config dir because that tree is the one this container mounts
// read-write at a stable host path — a container-local home would be a new
// project directory after every deploy.
//
// No checkout is here, and the standing orders say the shell does not write
// inside one, so this is where a `>` lands when the model reaches for it.
export function overseerHomeFor(workspaceRoot) {
  return path.join(overseerConfigDirFor(workspaceRoot), 'home')
}

// ---- the events, one line of JSON each -------------------------------------
//
// Named rather than positional, and every one carries `event`, so an unknown
// line from a newer container is skipped by an older daemon instead of read as
// something else.
export const TURN_EVENTS = {
  note: 'note', // a line for the status message
  session: 'session', // the SDK session id this turn stated
  verb: 'verb', // the model asked for a verb tool
  verbResult: 'verb_result', // that call's result came back
  answer: 'answer', // the turn's one answer message
  end: 'end', // the turn is over, ok or not
}

function shortToolError(content, max = 160) {
  const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content : []
  const text = blocks
    .map((block) => typeof block === 'string' ? block : block?.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .trim()
  if (!text) return null
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

const MAX_BODY = 1024 * 1024

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('the turn body is too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// One line per repo verdict, for the status message the operator watches. The
// prompt gets the full text (checkoutReport); this is the one-line version.
export function checkoutNote({ repos = [], removed = [] } = {}) {
  const bad = repos.filter((r) => !r.ok)
  const parts = [`checkouts: ${repos.length - bad.length}/${repos.length} fetched`]
  if (bad.length) parts.push(`stale: ${bad.map((r) => r.repo).join(', ')}`)
  if (removed.length) parts.push(`pruned: ${removed.join(', ')}`)
  return parts.join(' · ')
}

// The per-owner git routing, re-run at the start of every turn (#361).
//
// THE WATCH LIST IS READ PER TURN AND THE ROUTING WAS NOT. #314 made the config
// live for the checkout pass below. The credential lines stayed on the list the
// container booted on, so a repo added under an owner that had no line was
// cloned with no token until somebody recreated the container. This closes that
// half, and #392 closed the other one: the token is a file the daemon writes
// into a read-only mount, so a brand new owner needs no edit of an env file and
// no recreate of this service. Watching its repo is an ordinary save.
//
// IT NEVER REFUSES THE TURN, for the reason a failed fetch does not: a chat that
// will not answer is no way to fix a broken config. A throw leaves the lines the
// last good pass wrote — `--replace-all` removes nothing it does not rewrite —
// and says so in a note.
//
// It returns notes rather than emitting them, so the caller owns the stream and
// the suite can read the sentences without one.
export async function credentialPass(repos, dir, {
  install = installCredentialConfig, unrouted = unroutedOwners,
} = {}) {
  try {
    await install(repos, { dir })
  } catch (e) {
    const why = String(e.message ?? e).split('\n')[0]
    return [`${SIGNALS.warn} the git credentials did not reload (${why}). This turn runs on the routing of the last good pass`]
  }
  return unrouted(repos, dir).map((o) => `${SIGNALS.warn} ${unroutedNote(o)}`)
}

// The model credential, re-read PER TURN (#648).
//
// IT USED TO ARRIVE FROM `daemon/.env.overseer`, which compose hands a container
// at CREATE — the same trap #392 took the GitHub tokens out of, and the one
// #361 logged as a pain: a value this container could not re-read, so replacing
// it meant recreating the service. The overseer dying on a stale credential is a
// worse outage than an agent dying, because the overseer is how the operator
// finds out anything is wrong at all.
//
// So it is a FILE the daemon writes and this container reads per turn, beside
// the checkout pass and the credential pass the turn already runs. A turn in
// flight when the credential changes fails; the next one is correct.
//
// THE FILE IS THIS CONTAINER'S OWN COPY (#867), `.credentials.json` in the
// overseer's config directory, the same shape every claude agent gets. It used
// to be the store itself behind a read-only mount of `credentials/`. Under an
// installation root the store is one file in `secrets/`, and a container that
// holds a shell gets no mount of that boundary. The daemon writes the copy when
// it prepares a pane and heals it on every tick.
//
// NOT OVER THE LOOPBACK TURN BODY. A secret riding the request would put it in
// one more place — the daemon's memory, the wire, and whatever logs either side.
//
// THE COPY IS THE ONLY SOURCE (#726). An absent copy needs `reauth anthropic`.
// A frozen environment token has unknown age and validity, so using it would
// restore the second source that the provider store replaced.
export function modelCredentialEnv(configDir) {
  const token = readClaudeCredentialToken(configDir)
  if (token) return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, note: null }
  return {
    env: {},
    note: `${SIGNALS.warn} there is no anthropic credential for this turn: ${path.join(configDir, CLAUDE_CREDENTIAL_FILE)} holds none. Run reauth anthropic`,
  }
}

// Never let a caller's environment restore a retired credential path. The
// adopted store value is added after this copy at the query boundary.
export function overseerProcessEnv(env = process.env) {
  const clean = { ...env }
  delete clean.CLAUDE_CODE_OAUTH_TOKEN
  delete clean.ANTHROPIC_API_KEY
  return clean
}

// THE TURN, inside the container.
//
// `cfg` is the loaded curia.yaml: the workspace root is where the checkouts and
// the config dir live, and the watch list is which repos get fetched. Both are
// read PER TURN, because the settings screen rewrites the watch list and a turn
// must not name a repo nobody watches any more.
//
// Everything injectable is injected: the suite drives this handler with no
// container, no model and no network.
function runOneTurn({
  cfg, body, emit, log = console.log,
  queryFn = sdkQuery, sync = syncCheckouts, creds = credentialPass, now = () => new Date(),
}) {
  const root = cfg.dispatch.workspace_root
  const paths = pathsOf(cfg)
  const repos = cfg.watch.map((w) => w.repo)
  const configDir = overseerConfigDirFor(root)
  const home = overseerHomeFor(root)
  return (async () => {
    const t0 = now().getTime()
    let sessionId = null
    let toolCalls = 0
    let answer = null
    let result = null
    let thrown = null
    try {
      // The agent seed (workspace.mjs), once per turn rather than once per
      // process: it is idempotent, and a config dir a deploy replaced would
      // otherwise stay unseeded until the container was restarted again.
      fs.mkdirSync(home, { recursive: true })
      seedConfigDir(configDir, home, null, 'claude', { sweep: false })

      // The git routing, before the fetch that needs it (#361). Every note it
      // returns names an owner the watch list added and this container holds no
      // token for, which is the cause of the clone failure the verdict below
      // would otherwise report without a reason.
      for (const text of await creds(repos, paths.overseerTokens)) {
        log(text)
        emit(TURN_EVENTS.note, { text })
      }

      // ADR-0014's one fetch per turn, before the model runs, in parallel. It
      // never refuses the turn: a repo it could not reach comes back as a
      // verdict, and the prompt states the age of its last good fetch.
      const checkouts = await sync(root, repos, { now, base: paths.overseerRepos })
      emit(TURN_EVENTS.note, { text: checkoutNote(checkouts) })

      // The model credential, the copy the daemon writes (#648, #867). Read here
      // rather than at the `query` call so its note reaches the operator in the
      // same stream as the checkout verdict.
      const credential = modelCredentialEnv(configDir)
      if (credential.note) {
        log(credential.note)
        emit(TURN_EVENTS.note, { text: credential.note })
      }

      // The standing orders and the tool list are ONE call each (#328), and the
      // verdict text is composed beside them (#314).
      const systemPrompt = [
        buildSystemPrompt({ shell: true, checkoutsRoot: paths.overseerRepos, repos }),
        checkoutReport(checkouts, { now }),
      ].join('\n\n')
      const { allowed, disallowed } = toolsFor({ shell: true })

      const q = queryFn({
        prompt: body.prompt,
        options: {
          cwd: home,
          // `sandboxed: true` drops CLAUDE_SECURESTORAGE_CONFIG_DIR: the host
          // credential store is the first thing this boundary denies. The model
          // credential comes from the daemon's own store instead, read above and
          // applied below (#648); it used to come from `daemon/.env.overseer`,
          // which compose froze at container create (ADR-0014, #313).
          //
          // ENABLE_TOOL_SEARCH=0, or the model holds no verb at all. SDK
          // 0.3.220 defers every MCP tool schema behind its ToolSearch tool by
          // default, and this turn DISALLOWS ToolSearch (overseerprompt.mjs,
          // the #83 gap) — so the deferral leaves the verbs both unloadable
          // and unnamed, and the model truthfully reports it holds no `start`.
          // Measured live on 2026-08-16: with this flag the init message
          // states the server `connected` and lists the verbs; without it the
          // server stays `pending` and the tool list is empty.
          // The inherited environment is scrubbed before the store credential
          // goes last. No legacy model variable can become a fallback (#726).
          env: {
            ...overseerProcessEnv(),
            ENABLE_TOOL_SEARCH: '0',
            ...agentEnv(configDir, 'claude', { sandboxed: true }),
            ...credential.env,
          },
          model: body.model || OVERSEER_CONTAINER_MODEL,
          resume: body.resume || undefined,
          systemPrompt,
          mcpServers: {
            [MCP_SERVER_NAME]: { type: 'http', url: body.mcp.url, headers: body.mcp.headers ?? {} },
          },
          allowedTools: allowed,
          disallowedTools: disallowed,
          maxTurns: Number(body.max_turns) || CONTAINER_MAX_TURNS,
        },
      })

      // The tool_use id → verb map is what makes a result attributable. #275
      // states why the daemon needs both halves: a call the MCP layer refused
      // reaches no handler, so the daemon narrated nothing for it, and the
      // operator must read the refusal rather than silence.
      const calls = new Map()
      const curiaPrefix = `mcp__${MCP_SERVER_NAME}__`
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          sessionId = msg.session_id
          emit(TURN_EVENTS.session, { id: sessionId })
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type !== 'tool_use') continue
            toolCalls += 1
            const tool = String(block.name ?? '')
            const curia = tool.startsWith(curiaPrefix)
            const name = curia ? tool.slice(curiaPrefix.length) : tool
            calls.set(block.id, { name, curia })
            emit(TURN_EVENTS.verb, { name })
          }
        }
        if (msg.type === 'user') {
          const content = msg.message?.content
          for (const block of Array.isArray(content) ? content : []) {
            if (block.type !== 'tool_result') continue
            const call = calls.get(block.tool_use_id)
            if (call === undefined) continue
            calls.delete(block.tool_use_id)
            // Local read tools never cross the command router. Their successful
            // results are progress for the model, not router refusals for the
            // operator. Only Curia tool results participate in this protocol.
            if (!call.curia) continue
            const error = block.is_error === true
            const detail = error ? shortToolError(block.content) : null
            emit(TURN_EVENTS.verbResult, {
              name: call.name,
              error,
              ...(detail ? { detail } : {}),
            })
          }
        }
        if (msg.type === 'result') result = msg
      }
    } catch (e) {
      thrown = e
    }
    const secs = ((now().getTime() - t0) / 1000).toFixed(1)
    if (thrown || !result || result.subtype !== 'success') {
      const why = thrown?.message ?? result?.subtype ?? 'no result message'
      log(`turn key=${body.key} failed in ${secs}s (${why}) tool_calls=${toolCalls}`)
      emit(TURN_EVENTS.end, { ok: false, why, tool_calls: toolCalls, secs, session_id: sessionId })
      return
    }
    answer = result.result || '(empty answer)'
    log(`turn key=${body.key} done in ${secs}s — ${result.num_turns} turns, $${result.total_cost_usd?.toFixed(4) ?? '?'}`)
    emit(TURN_EVENTS.answer, { text: answer })
    emit(TURN_EVENTS.end, { ok: true, tool_calls: toolCalls, secs, session_id: sessionId })
  })()
}

// What a turn request must carry. A refusal here is a 400 with the reason,
// before the stream opens: once the head is written, every failure is an `end`
// event instead, and a caller that read half a stream cannot tell a bad request
// from a dead model.
export function refuseTurn(body) {
  if (!body || typeof body !== 'object') return 'the turn body must be a JSON object'
  if (!body.key || typeof body.key !== 'string') return '`key` is the conversation key, and it is required'
  if (!body.prompt || typeof body.prompt !== 'string') return '`prompt` is the operator message, and it is required'
  if (!body.mcp?.url || typeof body.mcp.url !== 'string') {
    return '`mcp.url` is where the verb tools live, and a turn with no seam can execute nothing'
  }
  return null
}

// The container's `/turn` route. It streams NDJSON and it never throws: a
// failure after the head is an `end` event, because the head is already sent.
//
// THE CONFIG IS READ PER TURN, not once at start. The settings screen rewrites
// the watch list, this container mounts that file read-only, and a turn must
// fetch the repos that are watched NOW. A reload that fails falls back to the
// last good config and says so in the status line — the operator cannot fix a
// broken config through a chat that refuses to answer.
//
// EVERYTHING THE CONFIG FEEDS IS READ PER TURN WITH IT (#361). That is the
// checkout pass and, since this ticket, the per-owner git routing. A rule read
// per turn beside one held from boot is the shape that made a watch-list change
// half arrive.
export function turnRoute({
  loadCfg, log = console.log, queryFn = sdkQuery,
  sync = syncCheckouts, creds = credentialPass, now = () => new Date(),
}) {
  let lastGood = null
  return async (req, res) => {
    let body
    try {
      body = await readJsonBody(req)
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: `the turn body did not parse: ${e.message}` }))
    }
    const refusal = refuseTurn(body)
    if (refusal) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: refusal }))
    }
    let cfg = null
    let cfgNote = null
    try {
      cfg = loadCfg()
      lastGood = cfg
    } catch (e) {
      cfg = lastGood
      cfgNote = `${SIGNALS.warn} the config did not reload (${String(e.message ?? e).split('\n')[0]}) — this turn reads the last good one`
      log(cfgNote)
    }
    if (!cfg) {
      res.writeHead(500, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'the overseer container cannot read its config, so it can run no turn' }))
    }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      // Nothing between here and the daemon buffers on purpose, and a proxy
      // that did would hold every event to the end of the turn.
      'cache-control': 'no-store',
    })
    const emit = (event, detail = {}) => {
      if (res.writableEnded) return
      res.write(`${JSON.stringify({ event, ...detail })}\n`)
    }
    log(`turn key=${body.key} resume=${body.resume ?? 'fresh'} model=${body.model || OVERSEER_CONTAINER_MODEL}`)
    if (cfgNote) emit(TURN_EVENTS.note, { text: cfgNote })
    try {
      await runOneTurn({ cfg, body, emit, log, queryFn, sync, creds, now })
    } catch (e) {
      // runOneTurn catches its own model failures; this is the seed, the checkout
      // root or the config itself failing, which is not a turn failure the
      // model can be asked about.
      log(`turn key=${body.key} could not start: ${e.message}`)
      emit(TURN_EVENTS.end, { ok: false, why: `the turn could not start: ${e.message}`, tool_calls: 0 })
    }
    res.end()
  }
}
