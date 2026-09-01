import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

// The installation record: `state/installation.json`, the one file that says
// which version is active. The launcher reads the same file with `sed`, so its
// shape stays flat: one JSON object, one key per line, `activeVersion` a string.
export const RECORD_FORMAT = 1

export function recordPath(root) {
  return join(root, 'state', 'installation.json')
}

// Returns the record, or `null` when the root holds none. A record that is
// present but unreadable as a record is an error: a half-written or foreign
// file must not read as "no installation".
export function readInstallationRecord(root) {
  let text
  try {
    text = readFileSync(recordPath(root), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  const record = JSON.parse(text)
  if (record.format !== RECORD_FORMAT || typeof record.activeVersion !== 'string' || typeof record.installationId !== 'string') {
    throw new Error(`${recordPath(root)} is not a Curia installation record`)
  }
  return record
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
