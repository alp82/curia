// The daemon's own minted GitHub credential (#390, building ADR-0018).
//
// The daemon reaches GitHub as a `gh` child process, and until this file existed
// every one of those children ran with no token at all. A child with no token
// inherits `~/.config/gh`, so the frontier reads, the claims, the pull requests
// and the branch pushes were all the OPERATOR's own login. That is the last of
// ADR-0018's four hand-made secrets, and it is the one that makes the gate
// impossible: GitHub refuses a self-approval, so an agent's pull request
// authored by the operator can never be approved by the operator.
//
// What replaces it is one token per resource owner, minted from the app key.
// Nearly every call the daemon makes names a repo, and a repo names an owner, so
// the token is chosen by the repo the call is about. `agentgh.mjs` does the same
// job for an agent one layer out.
//
// `GH_TOKEN` IN THE CHILD, not a config dir. #389 writes a `gh` config dir for
// an agent because a container mounts a directory and cannot be handed a live
// value. The daemon spawns its own children, so it has no such boundary — and
// `gh` reads `GH_TOKEN` before it reads any config file, which also steps around
// the config MIGRATION that #389 measured. An environment is not argv, so
// nothing here lands in `ps`.
//
// NEVER `process.env`. A bare `GH_TOKEN` in the daemon's own environment would
// re-authenticate every child at once — the deploy sibling's git, and a dev
// session started from this process tree — and those two keep the host login on
// purpose. So the value is built per call and handed to one child.
//
// TWO CALLS KEEP THE HOST LOGIN, and both are the settings screen's repo picker:
// `viewerLogin()` and `gh api user/repos`. Neither names a repo, both ask an
// account-wide question, and an installation token answers neither. Every other
// daemon call names a repo and takes a minted token.

// A GitHub token as GitHub writes one — `ghs_…` for an installation token,
// `github_pat_…` for the PAT this replaces. The 2026 installation tokens carry
// `.` and `-` beside the word characters (proven live on 2026-08-16: a real
// mint came back 390 chars with both). Asserted rather than escaped, because
// the value goes into a child's environment, and a token carrying a newline or
// a quote there is a second variable.
const TOKEN_RE = /^[A-Za-z0-9_.-]+$/

export const TOKEN_ENV_KEY = 'GH_TOKEN'

// `alp82/curia` → `alp82`. Null for anything that is not `owner/name`, which is
// how a call with no repo says it has no owner and wants the host login.
export function ownerOf(repo) {
  const owner = String(repo ?? '').split('/')[0].trim()
  return owner && owner !== String(repo ?? '').trim() ? owner : null
}

// Where the token comes from. index.mjs wires the app minter in at boot; the
// default answers null, which is the host login and is what a box with no app
// keeps. One function, so nothing else in the daemon has to hold a minter.
let source = null

export function setDaemonTokenSource(fn) {
  source = typeof fn === 'function' ? fn : null
}

// The token for one repo's owner, or null.
//
// NULL IS THE FALLBACK SIGNAL, never a refusal — the same rule #389 wrote for
// the agents. A box with no app, an owner the app is not installed on, and a
// GitHub that could not be reached all read the same here, and the call then
// runs on the host login exactly as it did before this ticket. Refusing instead
// would take a working credential out ahead of its replacement, which is the one
// thing ADR-0018 says not to do. The SOURCE is what says so out loud: it names
// the owner in the log, and it is the only place that can, because it is the
// only place that knows why the mint failed.
export async function daemonGhToken(repo) {
  const owner = ownerOf(repo)
  if (!owner || !source) return null
  const token = await source(owner)
  if (token === null || token === undefined || token === '') return null
  const value = String(token).trim()
  if (!TOKEN_RE.test(value)) {
    throw new Error(`refusing to run a gh call for ${owner} with that token: a GitHub token is letters, digits, underscore, dot and dash only`)
  }
  return value
}

// The environment one `gh` or `git` child runs with. The base is returned
// UNCHANGED when there is no token, so a fallback child inherits exactly what
// the daemon's own process holds and nothing is added to it.
export async function daemonGhEnv(repo, base = process.env) {
  const token = await daemonGhToken(repo)
  return token ? { ...base, [TOKEN_ENV_KEY]: token } : base
}
