#!/usr/bin/env node
// The build arguments of a release (#869, the agent image's at #891).
//
// One Node patch version runs every Curia image, and one Claude Code version
// runs the overseer and every claude agent. Both are pinned in
// config/curia.yaml under `sandbox:`, beside the agent image's other pins
// (codex, gh, playwright, ttyd), and the release workflow reads all of them
// from here so the images it publishes run the versions the suite ran on.
// The agent image is built from the same arguments the service used to build
// it on the source box (daemon/src/image.mjs). The source deployment's
// anchors in deploy/compose.yaml name the Node and Claude values, and
// daemon/test/releaseimages.test.mjs keeps them equal.
//
//     node deploy/bundle/pins.mjs        NODE_VERSION=... CLAUDE_VERSION=... CODEX_VERSION=... GH_VERSION=... PLAYWRIGHT_VERSION=... TTYD_VERSION=...
//
// Read by line rather than through a YAML reader, so the script needs no
// dependency tree on the runner before the images are built.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PINS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'curia.yaml')

const PINS = {
  NODE_VERSION: 'node_version',
  CLAUDE_VERSION: 'claude_version',
  CODEX_VERSION: 'codex_version',
  GH_VERSION: 'gh_version',
  PLAYWRIGHT_VERSION: 'playwright_version',
  TTYD_VERSION: 'ttyd_version',
}

export function releasePins(file = PINS_FILE) {
  const text = fs.readFileSync(file, 'utf8')
  const out = {}
  for (const [arg, key] of Object.entries(PINS)) {
    const m = new RegExp(`^  ${key}:\\s*([0-9]+\\.[0-9]+\\.[0-9]+)\\s*(?:#.*)?$`, 'm').exec(text)
    if (!m) throw new Error(`${file} pins no sandbox.${key}`)
    out[arg] = m[1]
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [arg, value] of Object.entries(releasePins())) process.stdout.write(`${arg}=${value}\n`)
}
