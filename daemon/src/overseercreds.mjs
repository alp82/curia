// The overseer container's per-owner git routing (#327, installing the first
// half of #313, cut over to minted tokens by #392).
//
// The container holds one read-only token per resource owner. git picks between
// them by itself, with ONE CONFIG LINE PER OWNER and nothing else:
//
//     credential.https://github.com/<owner>.helper = <a helper that prints
//                                                     <tokens>/<owner>>
//
// Measured on a real `git ls-remote` in
// docs/live-checks/313-overseer-github-token.md: git prefix-matches the owner
// off the remote URL and never offers the other owner's token, so
// `credential.useHttpPath` is not needed and no shim is. That covers every
// clone and every fetch the checkout pass of #312 runs. `gh` is the other half,
// and it does need a shim (deploy/overseer/gh-shim.sh).
//
// THE HELPER NAMES A FILE, AND READS IT WHEN GIT ASKS. Until #392 it named an
// environment variable, which compose froze at container create. An installation
// token lives one hour, so the value has to be re-read rather than inherited:
// the daemon rewrites `<workspace_root>/overseer/tokens/<owner>` about every
// fifty minutes, the container mounts that tree read-only, and the next fetch
// gets the new token with nothing restarted. `~/.gitconfig` in this container
// still carries no secret — one PATH per owner, as it carried one name.
//
// THE OWNERS COME FROM THE WATCH LIST, not from the files. The config line needs
// the owner as it appears in a URL, and the watch list is the one source that
// has it.

import { overseerTokenFile, readOverseerToken } from './overseertoken.mjs'
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

// A path inside a `/bin/sh` word. The tokens tree comes from the config, so its
// spelling is the operator's rather than curia's.
function shq(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`
}

// The config VALUE: a `!`-prefixed shell helper, run by git with the operation
// as its first argument.
//
//   - `get` only. `store` and `erase` are the write half of the credential
//     protocol, and a read-only token has nothing to store.
//   - an EMPTY or MISSING file prints nothing, rather than an empty password.
//     git reads an empty password as a credential and stops asking other
//     helpers, so the empty case must look like "no answer" and not like "no
//     password". It is the live case: the daemon writes this file, and a mint
//     that has not landed yet leaves nothing there.
//   - the username is `x-access-token`, GitHub's own name for a token used as a
//     password. It is also what `gh auth git-credential` prints, so nothing
//     about git's view of the credential changed across the cutover.
//
// /bin/sh, because that is what git runs a helper with.
export function helperValueFor(file) {
  return `!f() { [ "$1" = get ] || exit 0; t="$(cat ${shq(file)} 2>/dev/null)"; [ -n "$t" ] || exit 0; printf 'username=x-access-token\\npassword=%s\\n' "$t"; }; f`
}

// What this container's git config must say, one entry per owner that has a
// token file. An owner with none gets NO LINE: without one, git asks no helper
// and the clone fails naming the repo, which is the honest failure. A line
// pointing at a file that is not there would instead make git ask, get nothing,
// and report the same failure one layer further from its cause.
//
// A file that holds something other than a token throws here, at the start of
// the turn, rather than reaching a fetch as a 401 in the middle of one.
export function credentialConfig(repos, dir) {
  const out = []
  for (const owner of ownersOf(repos)) {
    const file = overseerTokenFile(dir, owner)
    if (!file) continue
    if (!readOverseerToken(dir, owner)) continue
    out.push({ owner, file, name: helperKeyFor(owner), value: helperValueFor(file) })
  }
  return out
}

// The one sentence both callers say about an owner with no token: the container
// at start, and every turn since #361. ONE COMPOSER, so the boot log and the
// chat note cannot drift apart, and it names the SOURCE as well as the owner —
// which is the whole fix the reader has to make. Since #392 that source is a
// file the daemon writes, so the act it asks for is an app install rather than
// an edit of `daemon/.env.overseer`.
export function unroutedNote({ owner, file }) {
  if (!file) return `"${owner}" is not a GitHub account name, so no read of it can be routed`
  return `no token file at ${file}, so every read of ${owner}/* runs with no credential and reaches public repositories only. The daemon writes that file for each watched owner curia's GitHub App is installed on`
}

// Owners the watch list names and this container holds no token for. Said out
// loud at start, because the failure it predicts — a clone that cannot
// authenticate — happens inside a turn, hours later, where nothing names the
// missing file. Said again at the start of every turn (#361), because the watch
// list the operator changes between turns is what adds an owner to this list.
export function unroutedOwners(repos, dir) {
  const routed = new Set(credentialConfig(repos, dir).map((c) => c.owner))
  return ownersOf(repos)
    .filter((owner) => !routed.has(owner))
    .map((owner) => ({ owner, file: overseerTokenFile(dir, owner) }))
}

// Write the lines into the container's own global git config.
//
// `--replace-all` rather than `--add`: this runs on every container start AND at
// the start of every turn (#361), so it repeats constantly. Adding would leave a
// helper per run for one owner, and git would consult all of them.
//
// REPEATING IS THE POINT. #313 ran this once, from the watch list the container
// booted on, while the checkout pass beside it re-read that list per turn (#314)
// — so a repo added under a NEW owner was fetched with no credential until
// somebody recreated the container. One local process per owner, naming a file
// rather than a token, is cheap enough to pay every turn.
//
// AN OWNER DROPPED FROM THE WATCH LIST KEEPS ITS LINE, because removing it buys
// nothing: the line holds a PATH, the daemon sweeps the file behind it, and the
// checkout pass fetches watched repos only.
export async function installCredentialConfig(repos, { dir, exec = execFileP, gitEnv = {} } = {}) {
  const entries = credentialConfig(repos, dir)
  for (const { name, value } of entries) {
    await exec('git', ['config', '--global', '--replace-all', name, value], {
      timeout: 30_000,
      env: { ...process.env, ...gitEnv },
    })
  }
  return entries
}
