// The compose file, read the way compose reads it (#473).
//
// Several suites pin lines of `deploy/compose.yaml`: the ttyd argv (#260), the
// overseer service (#327), the Node anchor (#357). Those lines carry
// `${CURIA_REPO_ROOT:-...}` now, and a raw `YAML.parse` hands back the variable
// rather than the path — so a test that compared strings would pin the spelling
// of an interpolation instead of the mount it produces.
//
// This resolves the interpolation first, against an env the caller states. With
// no env it yields the DEFAULTS, which is what a box that says nothing runs.
// That makes every such test evidence about this box, and `withEnv` makes the
// same test evidence about a box that answered differently.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const COMPOSE_FILE = path.join(REPO, 'deploy', 'compose.yaml')

// The three forms this file uses. `${NAME:-default}` takes the default when the
// variable is unset or empty, `${NAME:?message}` refuses, and a bare `${NAME}`
// is the empty string — compose's own rules.
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?(?::\?([^}]*))?\}/g

export function interpolate(text, env = {}) {
  return text.replace(VAR, (_all, name, fallback, refusal) => {
    const value = env[name]
    if (value !== undefined && value !== '') return value
    if (fallback !== undefined) return fallback
    if (refusal !== undefined) throw new Error(`compose refuses: ${name} is unset (${refusal})`)
    return ''
  })
}

// Walk the parsed tree rather than the text: interpolating the raw file first
// would let a value containing a `:` or a `#` change the YAML's own shape.
function resolve(node, env) {
  if (typeof node === 'string') return interpolate(node, env)
  if (Array.isArray(node)) return node.map((v) => resolve(v, env))
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(v, env)]))
  }
  return node
}

// `DOCKER_GID` has no default on purpose — it is the host's docker group id, and
// a guess would be a group that grants nothing or too much. Every caller here
// needs a value only so the refusal does not fire.
export const TEST_ENV = { DOCKER_GID: '998' }

export function composeConfig(env = {}) {
  return composeConfigOf(COMPOSE_FILE, { ...TEST_ENV, ...env })
}

// The Compose shape of an installed Curia (#867), which the bundle (#869)
// packages. Its variables have no defaults, so a caller states them all.
export const BUNDLE_COMPOSE_FILE = path.join(REPO, 'deploy', 'bundle', 'compose.yaml')

export function composeConfigOf(file, env = {}) {
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'))
  return resolve(raw, env)
}

// The two roots as a box that has told compose nothing runs them. Written out
// rather than derived, so a test that uses them fails when the defaults move
// instead of following the move in silence.
export const DEFAULT_REPO_ROOT = '/home/alp/curia'
export const DEFAULT_WORKSPACE_ROOT = '/home/alp/curia-work'
export const DEFAULT_HOME = `${DEFAULT_WORKSPACE_ROOT}/home`
