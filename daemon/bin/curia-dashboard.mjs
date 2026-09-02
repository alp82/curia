#!/usr/bin/env node
// The dashboard sidecar's process (#263). Compose runs this; the daemon never
// spawns it, and it survives every daemon restart — which is the whole reason
// the where-it-lives decision (#249) put the console beside the daemon rather
// than inside it.
//
// It holds no secret. Its container mounts the config directory and the code,
// and nothing else: no `.env`, no journal, no GitHub credential, no tmux
// socket. Everything it draws crosses one loopback read of `GET /overview`.
//
// Fail-closed at boot, in this order:
//   1. read the config (the `dashboard:` block and the identity allowlist)
//   2. bind the loopback listener, or die — a port this process cannot own is
//      not a surface it may publish
//   3. check the page stamp, resolve the tailnet names, assert the Serve rule
//      — and withdraw it instead if any of those fails
// Step 3 then repeats on a slow tick, so the surface heals after a tailscaled
// restart underneath it rather than staying dark until someone notices.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DashboardSurface, loadDashboardConfig, daemonPort } from '../src/dashboard.mjs'
import { serveOff } from '../src/attach.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.CURIA_CONFIG ?? path.resolve(DIR, '..', '..', 'config', 'curia.yaml')

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

const { dashboard, allow, timelinePort, terminalPort } = loadDashboardConfig(CONFIG)

// Under an installation root (#877) the allowlist is the operator confirmed
// through integration setup, which the daemon keeps in `state/tailscale.json`.
// This container mounts nothing of the root, so it asks the daemon, and
// `identity.allow` in the shipped curia.yaml admits nobody here: that list is
// the source deployment's.
const underRoot = Boolean(process.env.CURIA_ROOT)

const surface = new DashboardSurface({
  port: dashboard.port,
  servePort: dashboard.serve_port,
  index: dashboard.index,
  pollIntervalS: dashboard.poll_interval_s,
  allow: underRoot ? [] : allow,
  identitySource: underRoot ? 'daemon' : 'config',
  // And the settings screen's two files (#880): this container mounts
  // nothing of the root, so under one it reads them and lands a save
  // through the service's `/settings` instead of its own filesystem.
  settingsSource: underRoot ? 'daemon' : 'files',
  daemonPort: daemonPort(),
  // The chat (#267) is the daemon's timeline surface, served under this
  // address. Both containers share the host network, so the port is the same
  // number the daemon binds.
  timelinePort,
  terminalPort,
  // The two files the settings screen writes (#265). `routing.yaml` sits beside
  // `curia.yaml` by construction — the daemon reads both out of one directory
  // (CURIA_CONFIG_DIR), so naming a second path here would be a second way to
  // say where the config lives, free to disagree with the daemon's.
  curiaFile: CONFIG,
  routingFile: path.resolve(path.dirname(CONFIG), 'routing.yaml'),
  log,
})

const { verified, error } = await surface.start()
if (!verified) {
  // The rule persists in tailscaled across restarts, so a previous run's rule
  // would keep publishing whatever took the port. Withdraw before dying.
  await serveOff({ servePort: dashboard.serve_port, log }).catch((e) => {
    log(`WARNING: withdrawing the dashboard serve rule failed too (${e.message}) — if a rule for :${dashboard.serve_port} exists it REMAINS PUBLISHED tailnet-wide`)
  })
  log(`the dashboard cannot bind 127.0.0.1:${dashboard.port} (${error}) — exiting; the supervisor will try again`)
  process.exit(1)
}

const first = await surface.assert()
if (first.verified) log(`dashboard published on https://<this box>:${dashboard.serve_port}/ — identity check in front, ${surface.allow.size} login(s) admitted${underRoot ? ' (from the operator confirmed in setup)' : ''}`)
surface.startAssertLoop()

// A clean stop withdraws its own rule. A crash does not, and does not need to:
// the rule then points at a dead loopback port, which answers nobody rather
// than exposing anything, and the next boot re-asserts or withdraws it.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} — withdrawing the dashboard serve rule and stopping`)
    surface.stop()
    serveOff({ servePort: dashboard.serve_port, log })
      .catch((e) => log(`withdrawing the serve rule failed: ${e.message}`))
      .finally(() => process.exit(0))
  })
}
