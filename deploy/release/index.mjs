#!/usr/bin/env node
// The stable-release index command (#871).
//
//     node deploy/release/index.mjs promote <version>
//     node deploy/release/index.mjs withdraw <version>
//     node deploy/release/index.mjs show
//
// Run from the repository root. `promote` names the version as the stable
// release; `withdraw` marks a version known-bad, and clears the stable
// release when it was the one withdrawn. Both read `release/stable.json`,
// refuse to build on an index that does not verify against the public key
// the package pins at `cli/stable-index.pub`, apply the one transition from
// `cli/src/stable.mjs`, sign the result with the Ed25519 private key in
// `CURIA_STABLE_INDEX_KEY`, and write the file. Neither one touches an
// artifact: a promotion or a withdrawal is selection metadata and nothing
// else. `.github/workflows/stable-index.yml` runs this and commits the file.
//
// Exit codes follow the lifecycle interface: 0 done, 1 failed, 2 usage,
// 3 refused with nothing written. The private key is never printed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  STABLE_INDEX_PATH, STABLE_INDEX_KEY_FILE, StableIndexError,
  createStableIndex, renderStableIndex, verifyStableIndex, signStableIndex, promote, withdraw, pinnedPublicKey,
} from '../../cli/src/stable.mjs'
import { Refusal, EXIT } from '../../cli/src/exit.mjs'
import { checkSigningKey, PublicationError } from './publish.mjs'

const USAGE = 'usage: index.mjs promote <version> | withdraw <version> | show\n'

function now() {
  const given = process.env.CURIA_STABLE_INDEX_NOW
  return (given ? new Date(given) : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// The index on disk, verified, or an empty one when the file does not exist.
function readIndex(root, publicKey) {
  const file = path.join(root, STABLE_INDEX_PATH)
  if (!fs.existsSync(file)) return { file, index: createStableIndex({ updated: now() }), existed: false }
  return { file, index: verifyStableIndex(fs.readFileSync(file, 'utf8'), { publicKey }), existed: true }
}

function summary(index) {
  const withdrawn = index.withdrawn.length ? `withdrawn ${index.withdrawn.join(', ')}` : 'nothing withdrawn'
  return `stable-release index: sequence ${index.sequence}, stable ${index.stable ?? 'none'}, ${withdrawn}\n`
}

async function main(argv, { root, stdout, stderr }) {
  const [command, version, ...extra] = argv
  const publicKeyFile = path.join(root, 'cli', STABLE_INDEX_KEY_FILE)
  const publicKey = pinnedPublicKey(publicKeyFile)

  if (command === 'show') {
    if (version !== undefined) { stderr.write(USAGE); return EXIT.usage }
    const { index, existed } = readIndex(root, publicKey)
    stdout.write(existed ? summary(index) : `stable-release index: ${STABLE_INDEX_PATH} does not exist yet\n`)
    return EXIT.ok
  }
  if ((command !== 'promote' && command !== 'withdraw') || version === undefined || extra.length) {
    stderr.write(USAGE)
    return EXIT.usage
  }

  // The secret is checked against the pinned key before the index is read,
  // so a wrong secret refuses before anything could be written.
  checkSigningKey({ privateKey: process.env.CURIA_STABLE_INDEX_KEY ?? '', publicKeyFile, stdout })
  const { file, index } = readIndex(root, publicKey)
  const updated = now()
  const next = command === 'promote' ? promote(index, version, { updated }) : withdraw(index, version, { updated })

  if (renderStableIndex(next) === renderStableIndex(index)) {
    stdout.write(command === 'promote' ? `${version} is already the stable release; nothing to change\n` : `${version} is already withdrawn; nothing to change\n`)
    return EXIT.ok
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, signStableIndex(next, process.env.CURIA_STABLE_INDEX_KEY))
  if (command === 'promote') {
    stdout.write(`promoted ${version} as the stable release (sequence ${next.sequence})\n`)
  } else {
    const cleared = index.stable === version ? '. It was the stable release, so no stable release is recommended until the next promotion' : ''
    stdout.write(`withdrew ${version} (sequence ${next.sequence})${cleared}\n`)
  }
  stdout.write(summary(next))
  return EXIT.ok
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { root: process.cwd(), stdout: process.stdout, stderr: process.stderr })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`index.mjs: ${e.message}\n`)
      process.exit(e instanceof Refusal || e instanceof StableIndexError || e instanceof PublicationError ? EXIT.refused : EXIT.failed)
    })
}
