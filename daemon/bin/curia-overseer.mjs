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
//      report, and the live answer is the one beside the config re-read. The
//      lines name a token FILE the daemon writes (#392), so a container that
//      boots before the first mint routes nothing and the next turn routes it.
//   2. Says what this container holds: which owners are routed, which are not,
//      and whether the mounted model credential exists. Without this report,
//      those failures surface later inside a turn that names no missing file.
//   3. Serves the two routes: `GET /ping`, the health check the daemon reads,
//      and `POST /turn`, one operator message (#314).
//
// A TURN IS ONE REQUEST, and this process holds no conversation between them.
// The daemon sends the resume id with the message and takes the session id
// back, so a restart here loses nothing (ADR-0015). The config is re-read per
// turn from the mounted `config/curia.yaml`, because the settings screen
// rewrites the watch list and a turn must fetch what is watched NOW.
//
// NOTHING THIS CONTAINER HOLDS FROM ITS OWN BOOT IS A LIMIT ANY MORE (#361,
// finished by #392). The watch list feeds the checkout pass and the git routing,
// and both run per turn. The tokens themselves are files the daemon rewrites, in
// a tree mounted read-only, so a repo watched under a brand new owner is routed
// at the next message. Nothing here needs this service recreated.
//
// The environment carries no model credential (#726). The daemon writes the
// provider store, and this container reads that store through a read-only mount.

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCuriaConfig } from '../src/config.mjs'
import { checkoutsRootFor } from '../src/checkouts.mjs'
import { installCredentialConfig, unroutedOwners, unroutedNote } from '../src/overseercreds.mjs'
import { overseerTokensRootFor } from '../src/overseertoken.mjs'
import { AnthropicCredentialStore, anthropicStoreFile } from '../src/credentials.mjs'
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

// The tokens tree, at the same path on both sides of its read-only mount. It is
// read HERE only for the boot report: a turn re-reads it, and the daemon writes
// it, so a failure at this instant is news rather than a refusal.
const tokensRoot = overseerTokensRootFor(cfg.dispatch.workspace_root)
try {
  const routed = await installCredentialConfig(repos, { dir: tokensRoot })
  for (const { owner, file } of routed) log(`git routes ${owner}/* through ${file}`)
  for (const o of unroutedOwners(repos, tokensRoot)) log(`WARNING: ${unroutedNote(o)}`)
} catch (e) {
  log(`WARNING: the git credentials did not install (${String(e.message ?? e).split('\n')[0]}) — the first turn writes them again`)
}

// The boot report reads the same mounted store that every turn reads. An absent
// record is actionable without handing the container another secret source.
if (!new AnthropicCredentialStore({ workspaceRoot: cfg.dispatch.workspace_root }).read()) {
  log(`WARNING: no anthropic credential at ${anthropicStoreFile(cfg.dispatch.workspace_root)}. Run reauth anthropic, or no turn can run a model`)
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
