#!/usr/bin/env node
// Build the shared worker image (#154) from the pins in config/curia.yaml.
//
//     npm run build-worker-image --prefix daemon
//
// The daemon builds this itself on the dispatch path when the tag is missing
// (#156), so nobody has to remember to run this. It exists for the two cases
// where waiting for a dispatch is the wrong shape:
//
//   - the first build on a box, which takes minutes and should not be the
//     thing a ticket waits behind;
//   - checking a Dockerfile edit before it reaches a worker.
//
// It prints the tag it built. That tag is a content address (see image.mjs),
// so the same config and the same Dockerfile always name the same image, and
// running this twice is a no-op the second time.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCuriaConfig } from '../src/config.mjs'
import { BUILD_CONTEXT, DOCKERFILE, buildWorkerImage, imageExists, workerImageRef } from '../src/image.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.CURIA_CONFIG ?? path.resolve(DIR, '..', '..', 'config', 'curia.yaml')

function die(msg) {
  console.error(`build-worker-image: ${msg}`)
  process.exit(1)
}

let cfg
try {
  cfg = loadCuriaConfig(CONFIG)
} catch (e) {
  die(e.message)
}

if (!cfg.sandbox) {
  die(`${CONFIG} has no \`sandbox\` section — the image pins live there, and there is no default for them`)
}

const ref = workerImageRef(cfg.sandbox)

console.log(`image       ${ref.ref}`)
console.log(`dockerfile  ${DOCKERFILE}`)
console.log(`context     ${BUILD_CONTEXT}`)
for (const [arg, value] of Object.entries(ref.args)) console.log(`  ${arg.padEnd(20)}${value}`)

// `--force` is for the one case a content address cannot express: a build
// input that is not in the hash. Debian's apt mirror and npm both serve
// moving targets, so the same Dockerfile can produce a different image a
// month later, and sometimes that rebuild is exactly what is wanted.
const force = process.argv.includes('--force')

try {
  if (!force && await imageExists(ref.ref)) {
    console.log('\nalready built — nothing to do (use --force to rebuild it anyway)')
    process.exit(0)
  }
  console.log('')
  await buildWorkerImage(ref, { onLine: (line) => console.log(line) })
} catch (e) {
  die(e.message)
}

console.log(`\nbuilt ${ref.ref}`)
