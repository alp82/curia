#!/usr/bin/env node
// The overseer container's process (#327, building ADR-0015's compose service).
//
//   docker compose up -d --build --no-deps daemon dashboard overseer
//
// It does three things at start, then listens:
//
//   1. Writes the per-owner git credential config (#313), so every clone and
//      fetch the checkout pass of #312 runs reaches GitHub as the right owner's
//      read-only token. THE TURN WRITES IT AGAIN (#361): this pass is the boot
//      report, and the live answer is the one beside the config re-read.
//   2. Says out loud what this container holds — which owners are routed, which
//      are not, and whether a model credential arrived. Every one of those
//      failures otherwise surfaces hours later, inside a turn, where nothing
//      names the missing key.
//   3. Serves the two routes: `GET /ping`, the health check the daemon reads,
//      and `POST /turn`, one operator message (#314).
//
// A TURN IS ONE REQUEST, and this process holds no conversation between them.
// The daemon sends the resume id with the message and takes the session id
// back, so a restart here loses nothing (ADR-0015). The config is re-read per
// turn from the mounted `config/curia.yaml`, because the settings screen
// rewrites the watch list and a turn must fetch what is watched NOW.
//
// NOTHING THIS CONTAINER READS FROM THE CONFIG IS HELD FROM BOOT (#361). The
// watch list feeds two things, the checkout pass and the git routing above, and
// both run per turn. What a turn cannot pick up is `daemon/.env.overseer`:
// compose hands an env file over at container CREATE, so a token for an owner
// this container never held needs that file edited and this service recreated.
//
// The environment comes from `daemon/.env.overseer`, which compose hands over
// whole, and NEVER from `daemon/.env.daemon` — that file carries the agents'
// read-write tokens and the Discord bot token, and a shell in this container
// exports whatever it is given (#313).

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCuriaConfig } from '../src/config.mjs'
import { checkoutsRootFor } from '../src/checkouts.mjs'
import { installCredentialConfig, unroutedOwners, unroutedNote } from '../src/overseercreds.mjs'
import { readOverseer, overseerHandler, PING_PATH } from '../src/overseerservice.mjs'
import { turnRoute, TURN_PATH, overseerConfigDirFor, overseerHomeFor } from '../src/overseerturn.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.CURIA_CONFIG ?? path.resolve(DIR, '..', '..', 'config', 'curia.yaml')

const log = (...a) => console.log(`[${new Date().toISOString()}] overseer:`, ...a)

// `checkPaths: false`, the same call the checkout pass makes: those rules ask
// about the DAEMON's filesystem — the attach index, the skills root — and this
// container mounts none of them.
const loadCfg = () => loadCuriaConfig(CONFIG, { checkPaths: false })
const cfg = loadCfg()
const repos = cfg.watch.map((w) => w.repo)
const { port } = readOverseer(cfg, (msg) => { throw new Error(`bad config ${CONFIG}: ${msg}`) })

// The same path on both sides of the mount, so the Chat screen reads the
// transcript off the directory this container writes it to (ADR-0015).
const configDir = overseerConfigDirFor(cfg.dispatch.workspace_root)

const routed = await installCredentialConfig(repos, { env: process.env })
for (const { owner, key } of routed) log(`git routes ${owner}/* through ${key}`)
for (const o of unroutedOwners(repos, process.env)) log(`WARNING: ${unroutedNote(o)}`)

// The model credential is the one host secret that enters this container
// (ADR-0014), and it rides the same env file the tokens do. Absent, the turn
// #314 lands would fail at its first call with an authentication error that
// names no file.
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  log('WARNING: no CLAUDE_CODE_OAUTH_TOKEN and no ANTHROPIC_API_KEY — add one to daemon/.env.overseer, or no turn can run a model')
}

log(`checkouts at ${checkoutsRootFor(cfg.dispatch.workspace_root)}, config dir at ${configDir}, turns run in ${overseerHomeFor(cfg.dispatch.workspace_root)}`)

// 0.0.0.0 inside the container, published as `127.0.0.1:<port>:<port>` by
// compose. The container is on the bridge network, so this listener is reachable
// from the box's loopback and from nowhere else — not from the tailnet, and not
// from another container.
const bind = process.env.CURIA_OVERSEER_BIND ?? '0.0.0.0'
const server = http.createServer(overseerHandler({ log, turn: turnRoute({ loadCfg, log }) }))
// A turn is minutes of silence on an open socket while a model reads, and
// node's 5-minute default header timeout would cut the reply off (#34 measured
// the same shape on the agent side channel). The daemon is the only caller.
server.headersTimeout = 0
server.requestTimeout = 0
server.timeout = 0
server.listen(port, bind, () => {
  log(`listening on ${bind}:${port} — ${PING_PATH} is the health check the daemon reads, ${TURN_PATH} is one operator message`)
})
