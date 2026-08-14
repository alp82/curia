// The overseer container's per-owner git routing (#327, installing the first
// half of #313).
//
// The container holds one read-only token per resource owner. git picks between
// them by itself, with ONE CONFIG LINE PER OWNER and nothing else:
//
//     credential.https://github.com/<owner>.helper = <a helper that prints
//                                                     CURIA_OVERSEER_GH_TOKEN_<OWNER>>
//
// Measured on a real `git ls-remote` in
// docs/live-checks/313-overseer-github-token.md: git prefix-matches the owner
// off the remote URL and never offers the other owner's token, so
// `credential.useHttpPath` is not needed and no shim is. That covers every
// clone and every fetch the checkout pass of #312 runs. `gh` is the other half,
// and it does need a shim (deploy/overseer/gh-shim.sh).
//
// THE TOKEN NEVER LANDS ON DISK. The helper stored in the config file names the
// ENVIRONMENT VARIABLE, and the variable is read when git runs the helper. So
// `~/.gitconfig` in this container carries one variable name per owner and no
// secret, and a token rotated in `daemon/.env.overseer` takes effect on the next
// container start with nothing to rewrite.
//
// THE OWNERS COME FROM THE WATCH LIST, not from the environment keys. A key is
// the SLUG — `CURIA_OVERSEER_GH_TOKEN_GETALFREDO` — and a slug does not spell
// the owner back: it is uppercased and folded. The config line needs the owner
// as it appears in a URL, so the watch list is the one source that has it.

import { ownerSlug, readGhToken } from './workspace.mjs'
import { OVERSEER_ENV_FILE, overseerTokenKeyFor } from './overseertoken.mjs'
import { execFileP } from './exec.mjs'

// Every owner in the watch list, once, in the order the list names them.
export function ownersOf(repos) {
  const seen = new Set()
  const owners = []
  for (const repo of repos) {
    const owner = String(repo ?? '').split('/')[0]
    if (!owner || seen.has(owner)) continue
    seen.add(owner)
    owners.push(owner)
  }
  return owners
}

// The config KEY git matches on. The URL half is the owner prefix of the remote,
// which is what makes one line cover every repo of that owner.
export function helperKeyFor(owner) {
  return `credential.https://github.com/${owner}.helper`
}

// The config VALUE: a `!`-prefixed shell helper, run by git with the operation
// as its first argument.
//
//   - `get` only. `store` and `erase` are the write half of the credential
//     protocol, and a read-only token has nothing to store.
//   - an EMPTY variable prints nothing, rather than an empty password. git reads
//     an empty password as a credential and stops asking other helpers, so the
//     empty case must look like "no answer" and not like "no password".
//   - the username is `x-access-token`, GitHub's own name for a token used as a
//     password. Any value works; a fixed one keeps two owners' helpers identical
//     but for the variable.
//
// /bin/sh, because that is what git runs a helper with.
export function helperValueFor(key) {
  return `!f() { [ "$1" = get ] || exit 0; [ -n "\${${key}}" ] || exit 0; printf 'username=x-access-token\\npassword=%s\\n' "\${${key}}"; }; f`
}

// What this container's git config must say, one entry per owner that has a
// token. An owner with no token gets NO LINE: without one, git asks no helper
// and the clone fails naming the repo, which is the honest failure. A line
// pointing at an unset variable would instead make git ask, get nothing, and
// report the same failure one layer further from its cause.
//
// A malformed token throws here, at start, rather than reaching a fetch as a
// 401 in the middle of a turn — the same rule the daemon's boot check runs.
export function credentialConfig(repos, env) {
  const out = []
  for (const owner of ownersOf(repos)) {
    const key = overseerTokenKeyFor(`${owner}/x`)
    if (!key) continue
    const token = readGhToken(env, key, `daemon/${OVERSEER_ENV_FILE}`)
    if (!token) continue
    out.push({ owner, key, name: helperKeyFor(owner), value: helperValueFor(key) })
  }
  return out
}

// Owners the watch list names and this container holds no token for. Said out
// loud at start, because the failure it predicts — a clone that cannot
// authenticate — happens inside a turn, hours later, where nothing names the
// missing key.
export function unroutedOwners(repos, env) {
  const routed = new Set(credentialConfig(repos, env).map((c) => c.owner))
  return ownersOf(repos)
    .filter((owner) => !routed.has(owner))
    .map((owner) => ({ owner, key: `CURIA_OVERSEER_GH_TOKEN_${ownerSlug(`${owner}/x`)}` }))
}

// Write the lines into the container's own global git config.
//
// `--replace-all` rather than `--add`: this runs on every container start, and
// the config file may survive a restart. Adding would leave two helpers for one
// owner, and git would consult both — harmless today, and one more place for a
// stale variable name to hide tomorrow.
export async function installCredentialConfig(repos, { env = process.env, exec = execFileP, gitEnv = {} } = {}) {
  const entries = credentialConfig(repos, env)
  for (const { name, value } of entries) {
    await exec('git', ['config', '--global', '--replace-all', name, value], {
      timeout: 30_000,
      env: { ...process.env, ...gitEnv },
    })
  }
  return entries
}
