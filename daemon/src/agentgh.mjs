// The agent's minted GitHub credential (#389, building ADR-0018).
//
// Until this file existed an agent got a fine-grained PAT as `GH_TOKEN` in its
// container environment (#155). A PAT lives a year, so a value handed over at
// spawn stayed good for the whole ticket. An installation token lives ONE HOUR
// and dies inside a long resolve, so the value cannot ride the environment any
// more: the daemon writes a file and rewrites it, and the env carries only the
// PATH to it.
//
// ONE FILE, BOTH TOOLS. `gh` reads a token from `GH_TOKEN` or from its own
// `hosts.yml`, and git reaches GitHub through `gh auth git-credential` already
// (workspace.mjs sets that helper on every clone). So the file is gh's own
// `hosts.yml`, in a per-agent config dir named by `GH_CONFIG_DIR`. The existing
// credential-helper path then keeps working with NO shim, which matters because
// the agent image build COPYs nothing (image.mjs) and a shim file is not free.
//
// THE MIGRATION TRAP, and it is the whole reason this file writes two files
// rather than one. Measured against gh 2.97.0 inside a real agent container:
//
//   - A `hosts.yml` in the pre-multi-account shape makes gh run its own config
//     MIGRATION on the next command. The migration calls `GET /user` to learn
//     the login. An installation token answers that 403, and gh then refuses
//     outright with `failed to migrate config: cowardly refusing to continue`.
//     A PAT survives it, which is why nothing before this ticket met it.
//   - The migration also REWRITES the file, so the daemon-owned file stopped
//     being daemon-owned the moment an agent ran one gh command.
//   - `config.yml` carrying `version: "1"` plus a `users:` block in `hosts.yml`
//     is what gh reads as already migrated. It then makes NO API call at all,
//     and it leaves both files untouched. Proved with a fake `ghs_` token: gh
//     printed the credential and never went near the network, so a real minted
//     token behaves the same way.
//
// The username is `x-access-token`, which is exactly what git gets today: with
// `GH_TOKEN` in the environment, `gh auth git-credential` prints that same name
// and makes no API call either. So nothing about git's view of the credential
// changes across this cutover.
//
// THE FILE IS DAEMON-OWNED, like the agent identity token of #159. It differs
// from that one in where it sits, and the difference is forced: #159's token is
// checked BY the daemon, so it lives beside the results dir where no container
// can read it. This one is used BY the agent, so it has to be inside the config
// dir the container mounts. That mount is per agent, so an agent still holds its
// own credential and no other's.

import fs from 'node:fs'
import path from 'node:path'

// The directory inside the config dir, and the value `GH_CONFIG_DIR` carries.
// One name, because the daemon writes it at a host path and the container reads
// it at a guest path, and the two must never drift.
export const GH_DIR = 'gh'

export const HOSTS_FILE = 'hosts.yml'
export const CONFIG_FILE = 'config.yml'

// The one host curia reaches. GitHub Enterprise is not in curia's watch list and
// nothing else in the daemon knows another host.
export const GH_HOST = 'github.com'

// What git is told the user is. GitHub documents this name for an installation
// token, and gh already prints it for a token read out of `GH_TOKEN`.
export const GH_USER = 'x-access-token'

// A GitHub token as GitHub writes one — `ghs_…` for an installation token,
// `github_pat_…` for the PAT this replaces: word characters and nothing else.
// Asserted rather than escaped, because the value lands in a YAML scalar and a
// stray quote or newline there would make gh read a different file than the one
// curia meant to write.
const TOKEN_RE = /^[A-Za-z0-9_]+$/

export function ghConfigDirFor(cfgDir) {
  return path.join(cfgDir, GH_DIR)
}

// The `version: "1"` marker that says the config is already migrated. gh reads
// it before anything else, and without it the migration described above runs.
export function configYaml() {
  return 'version: "1"\n'
}

// Both shapes of the same token, and both are needed. gh reads the token off
// the TOP-LEVEL `oauth_token`, and it reads the `users:` block to decide the
// config needs no migration. A file with only one of them either yields no
// credential at all or runs the migration.
export function hostsYaml(token) {
  return [
    `${GH_HOST}:`,
    '    git_protocol: https',
    `    user: ${GH_USER}`,
    `    oauth_token: ${token}`,
    '    users:',
    `        ${GH_USER}:`,
    `            oauth_token: ${token}`,
    '',
  ].join('\n')
}

// Write the credential, replacing whatever the last refresh left.
//
// Both files land through a rename, so an agent's `gh` never reads a half-written
// one: the daemon rewrites this file about every fifty minutes under a live
// agent, and a torn read would be a 401 nobody could place.
export function writeGhCredentials(cfgDir, token) {
  const value = String(token ?? '').trim()
  if (!TOKEN_RE.test(value)) {
    throw new Error(`refusing to write the GitHub credential of ${path.basename(cfgDir)}: a GitHub token is word characters only`)
  }
  const dir = ghConfigDirFor(cfgDir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  replace(path.join(dir, CONFIG_FILE), configYaml())
  replace(path.join(dir, HOSTS_FILE), hostsYaml(value))
  return dir
}

function replace(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  // writeFileSync applies the mode only when it CREATES the file, and a refresh
  // finds one already there (the same note as sandbox.mjs's env file).
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

// The token this config dir currently carries, or null. Read back rather than
// remembered, because the refresh has to be able to tell an armed agent from one
// whose file a failed pass never wrote.
export function readGhCredentials(cfgDir) {
  try {
    const text = fs.readFileSync(path.join(ghConfigDirFor(cfgDir), HOSTS_FILE), 'utf8')
    const token = text.match(/^\s*oauth_token:\s*(\S+)\s*$/m)?.[1] ?? null
    return token && TOKEN_RE.test(token) ? token : null
  } catch {
    return null
  }
}

// The teardown. `removeConfigDir` already takes this whole directory with the
// rest, so this exists for the paths that KEEP the config dir for a post-mortem
// — the same two states that made #159's token outlive its agent.
export function forgetGhCredentials(cfgDir) {
  fs.rmSync(ghConfigDirFor(cfgDir), { recursive: true, force: true })
}
