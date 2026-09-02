#!/usr/bin/env node
// Render the bootstrap release asset (#872).
//
//     node deploy/bootstrap/render.mjs --version 1.2.3 --out dist
//
// deploy/bootstrap/curia-install.sh is the script the operator runs. It is
// the same for every release: it selects the version from the signed
// stable-release index, so it pins no Curia version. The one line the release
// workflow changes is its own version, so a support question can name the
// bootstrap that ran. The asset keeps one fixed name, `curia-install.sh`,
// which is what lets the documented command download it from
// releases/latest/download without knowing a version.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isReleaseVersion, releaseAssets } from '../../cli/src/manifest.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
export const BOOTSTRAP_SOURCE = path.join(DIR, 'curia-install.sh')

// The script's last line. The script checks for it before it runs, so a file
// cut off by an interrupted download refuses instead of running half.
export const BOOTSTRAP_END = '# curia-install: end'

const VERSION_LINE = /^CURIA_BOOTSTRAP_VERSION='source'$/m

export function renderBootstrap({ version, out, source = BOOTSTRAP_SOURCE }) {
  if (!isReleaseVersion(version)) throw new Error(`--version must be a release version like 1.2.3, got ${version}`)
  const text = fs.readFileSync(source, 'utf8')
  if (!VERSION_LINE.test(text)) throw new Error(`${source} has no CURIA_BOOTSTRAP_VERSION='source' line to stamp`)
  if (!text.endsWith(`${BOOTSTRAP_END}\n`)) throw new Error(`${source} does not end with the completion marker`)
  const name = releaseAssets(version).bootstrap
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, name), text.replace(VERSION_LINE, `CURIA_BOOTSTRAP_VERSION='${version}'`), { mode: 0o755 })
  return { name }
}

function args(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--(version|out)$/.test(argv[i]) || argv[i + 1] === undefined) throw new Error('usage: render.mjs --version <version> --out <dir>')
    o[argv[i].slice(2)] = argv[i + 1]
  }
  for (const key of ['version', 'out']) if (!o[key]) throw new Error(`--${key} is required`)
  return o
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version, out } = args(process.argv.slice(2))
    const { name } = renderBootstrap({ version, out })
    process.stdout.write(`${name}  bootstrap ${version}\n`)
  } catch (e) {
    process.stderr.write(`render.mjs: ${e.message}\n`)
    process.exit(1)
  }
}
