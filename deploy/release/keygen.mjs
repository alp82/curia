#!/usr/bin/env node
// The stable-index signing key, made once (#871).
//
//     node deploy/release/keygen.mjs [--rotate]
//
// Generates one Ed25519 pair. The public key is written to
// `cli/stable-index.pub`, which ships inside `@curia-sh/cli`, so commit it.
// The private key goes to the repository secret `CURIA_STABLE_INDEX_KEY`
// through `gh secret set`, over stdin, and is never written to disk or
// printed. Run it from the repository root with `gh` logged in as someone
// who administers alp82/curia.
//
// An existing public key is kept unless `--rotate` is given. A rotation is a
// new key in the next published version: an installed version verifies the
// index against the key it carries, so keep signing with the old key until
// every installation you care about runs a version that pins the new one.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { generateStableIndexKeys, STABLE_INDEX_KEY_FILE } from '../../cli/src/stable.mjs'
import { RELEASE_REPOSITORY } from '../../cli/src/manifest.mjs'

const SECRET = 'CURIA_STABLE_INDEX_KEY'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const file = path.join(root, 'cli', STABLE_INDEX_KEY_FILE)
const rotate = process.argv.includes('--rotate')

if (fs.existsSync(file) && !rotate) {
  process.stderr.write(`keygen.mjs: ${file} exists. Pass --rotate to replace it with a new key.\n`)
  process.exit(3)
}

const keys = generateStableIndexKeys()
const set = spawnSync('gh', ['secret', 'set', SECRET, '--repo', RELEASE_REPOSITORY], { input: keys.privateKey, encoding: 'utf8' })
if (set.status !== 0) {
  process.stderr.write(`keygen.mjs: gh secret set failed, and nothing was written:\n${set.stderr}`)
  process.exit(1)
}
fs.writeFileSync(file, keys.publicKey)
process.stdout.write(`stable-index key ${keys.fingerprint}: the secret ${SECRET} is set on ${RELEASE_REPOSITORY}, and the public key is at ${path.relative(root, file)}. Commit that file.\n`)
