import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

import { Refusal } from './exit.mjs'
import { writeAtomically } from './atomic.mjs'

// The installation root the lifecycle interface acts on.
//
// The launcher exports `CURIA_ROOT` for the root it was installed for, so a
// nondefault root stays explicit in the launcher and never has to be typed.
// Without it, the default root follows the XDG base directory rules.
export function installationRoot(env) {
  if (env.CURIA_ROOT) return env.CURIA_ROOT
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'curia')
  return join(env.HOME ?? '', '.local', 'share', 'curia')
}

// The seven boundaries of an installation root, in the order the operator
// documentation lists them. Each is one directory, mode 0700, owned by the
// operator. Lifecycle commands act on them as whole units.
export const BOUNDARIES = Object.freeze(['config', 'secrets', 'state', 'work', 'versions', 'cache', 'run'])

const OWNER_ONLY_DIR = 0o700
const OWNER_ONLY_FILE = 0o600

// The one safe way into an installation root. Every lifecycle command calls it
// before it touches anything, and it refuses (exit 3, nothing changed) when:
//
//   - the command runs as root;
//   - the root is not an absolute path;
//   - the root, a boundary directory, or the installation record is a
//     symbolic link;
//   - the root or a boundary is owned by another user or is reachable by the
//     group or by others;
//   - the root is nonempty and holds no installation record.
//
// It returns the root's status so the caller decides what the operation may
// do: `absent` (nothing there), `empty` (an empty directory), or `installed`
// (a record is present, and it is returned). A record that is present but
// malformed is a failure, not a refusal, so a damaged installation never reads
// as a fresh one.
export function openRoot(root, { uid }) {
  if (uid === 0) {
    throw new Refusal('this command runs as root. Curia runs unprivileged: run it as the operator that owns the installation.')
  }
  if (!isAbsolute(root)) {
    throw new Refusal(`the installation root must be an absolute path, got ${root}. Set CURIA_ROOT to an absolute path or run the installed launcher.`)
  }

  const rootStat = ownerOnlyDirectory(root, { uid, what: 'the installation root' })
  if (rootStat === null) return { root, status: 'absent', record: null }

  for (const name of BOUNDARIES) {
    ownerOnlyDirectory(join(root, name), { uid, what: `${name}/ in the installation root` })
  }
  const record = readInstallationRecord(root)
  if (record) return { root, status: 'installed', record }

  if (readdirSync(root).length === 0) return { root, status: 'empty', record: null }
  throw new Refusal(`${root} is not empty and holds no installation record, so it is not a Curia installation. Choose an empty or absent directory, or move what is there out of the way.`)
}

// Creates the root and the seven boundaries with owner-only permissions. The
// modes are set explicitly, not through the umask. It is idempotent: it adds a
// missing boundary to an existing root and leaves the rest alone. It never
// widens or narrows a directory that exists, so a boundary with broad
// permissions is refused here as in `openRoot`.
export function ensureLayout(root, { uid }) {
  if (ownerOnlyDirectory(root, { uid, what: 'the installation root' }) === null) {
    mkdirSync(root, { recursive: true })
    chmodSync(root, OWNER_ONLY_DIR)
  }
  for (const name of BOUNDARIES) {
    const dir = join(root, name)
    if (ownerOnlyDirectory(dir, { uid, what: `${name}/ in the installation root` }) === null) {
      mkdirSync(dir, { mode: OWNER_ONLY_DIR })
      chmodSync(dir, OWNER_ONLY_DIR)
    }
  }
}

// The lstat of a directory that must be owned by `uid`, mode 0700, and not a
// symbolic link. Returns null when the path does not exist. Every other
// deviation is a refusal that names the path and the corrective action.
function ownerOnlyDirectory(path, { uid, what }) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  if (stat.isSymbolicLink()) {
    throw new Refusal(`${what} is a symbolic link: ${path}. Curia does not follow links there. Replace the link with a real directory.`)
  }
  if (!stat.isDirectory()) {
    throw new Refusal(`${what} is not a directory: ${path}. Move the file out of the way or choose another root.`)
  }
  if (stat.uid !== uid) {
    throw new Refusal(`${what} is owned by user ${stat.uid}, not by you (user ${uid}): ${path}. Run the command as the owner, or choose another root.`)
  }
  const mode = stat.mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Refusal(`${what} has mode ${octal(mode)}, which lets other users reach it: ${path}. Run 'chmod 0700 ${path}' and try again.`)
  }
  return stat
}

function octal(mode) {
  return `0${mode.toString(8).padStart(3, '0')}`
}

// The installation record: `state/installation.json`, the one file that says
// which version is active. It holds only the record format, a random
// installation ID, and the active version. The launcher reads the same file
// with `sed`, so its shape stays flat: one JSON object, one key per line,
// `activeVersion` a string.
export const RECORD_FORMAT = 1
const RECORD_KEYS = Object.freeze(['format', 'installationId', 'activeVersion'])

export function recordPath(root) {
  return join(root, 'state', 'installation.json')
}

export function createInstallationRecord(activeVersion) {
  return { format: RECORD_FORMAT, installationId: randomBytes(16).toString('hex'), activeVersion }
}

// Returns the record, or `null` when the root holds none. A record that is
// present but unreadable as a record is an error: a half-written or foreign
// file must not read as "no installation". A record that is a symbolic link
// is refused, because the file is security-sensitive and must live in state/.
export function readInstallationRecord(root) {
  const path = recordPath(root)
  let text
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Refusal(`the installation record ${path} is a symbolic link. Replace the link with the real file or remove it.`)
    }
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  let record
  try {
    record = JSON.parse(text)
  } catch {
    record = null
  }
  if (!isRecord(record)) {
    throw new Error(`${path} is not a Curia installation record`)
  }
  return record
}

function isRecord(record) {
  return record !== null
    && typeof record === 'object'
    && record.format === RECORD_FORMAT
    && typeof record.activeVersion === 'string'
    && typeof record.installationId === 'string'
}

// Writes the record atomically, owner-only. The record must hold exactly the
// three documented keys, so nothing operator-specific or generated slips in.
export function writeInstallationRecord(root, record) {
  const foreign = Object.keys(record).filter((k) => !RECORD_KEYS.includes(k))
  if (foreign.length > 0 || !isRecord(record)) {
    throw new Error(`the installation record holds only ${RECORD_KEYS.join(', ')}; refusing to write ${JSON.stringify(record)}${foreign.length ? ` (unexpected: ${foreign.join(', ')})` : ''}`)
  }
  const ordered = Object.fromEntries(RECORD_KEYS.map((k) => [k, record[k]]))
  writeAtomically(recordPath(root), JSON.stringify(ordered, null, 2) + '\n', { mode: OWNER_ONLY_FILE })
}

// The two paths the launcher needs from an installed version: the pinned Node
// runtime and the lifecycle interface's entry point. `versions/<version>/cli/`
// holds the unpacked `@curia-sh/cli` package (the tarball's `package/` directory).
export function versionPaths(root, version) {
  const dir = join(root, 'versions', version)
  return {
    dir,
    node: join(dir, 'node', 'bin', 'node'),
    cli: join(dir, 'cli', 'bin', 'curia.mjs'),
  }
}
