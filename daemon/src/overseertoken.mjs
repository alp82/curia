// The overseer's minted read-only token (#392, building ADR-0018 on top of
// #313's read set).
//
// The overseer container holds a shell. That shell is the whole point of the
// move, and a READ-ONLY credential is the control that replaces the `/command`
// seam: a standing order cannot hold a shell, and a shell cannot mint a token.
// #313 bought that control with one fine-grained PAT per resource owner, in a
// second env file. This file is what replaced it.
//
// THE DAEMON MINTS, AND THE CONTAINER READS A FILE. `READ_PERMISSIONS` is the
// same set #313 wrote by hand — contents, issues, pull_requests, statuses and
// metadata, all read — and the daemon scopes it down from the one app key
// (ADR-0018). There is no endpoint the container can call: a shell that can
// mint is the capability ADR-0014 removed, and that is the whole boundary here.
//
// ONE FILE PER OWNER, named by the owner in lower case, in a tree the container
// mounts READ-ONLY and that holds nothing else. Both tools read the file at the
// moment they need it: git through the helper line `overseercreds.mjs` writes,
// and `gh` through `deploy/overseer/gh-shim.sh`. So a token the daemon rewrites
// takes effect on the next call, with no restart of anything.
//
// AN INSTALLATION TOKEN LIVES ONE HOUR, and the overseer is a long-lived
// service. A value handed to the container at start would die inside the first
// afternoon, which is why the environment cannot carry it any more.
//
// IT ALSO REMOVES THE LAST THING A TURN CANNOT RE-READ (#361). Compose hands an
// env file to a container at CREATE, so an owner this container never held used
// to need `daemon/.env.overseer` edited AND the service recreated. A file the
// daemon writes needs neither: watching a repo of a brand new owner is an
// ordinary save, and the next turn routes it.
//
// WHAT IS LEFT IN `.env.overseer` IS THE MODEL CREDENTIAL, which is the one host
// secret ADR-0014 lets into that container. The file stays, and it stops being a
// token file. The daemon still reads it without loading it, for the two warnings
// below.

import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { AGENT_TOKEN_KEY } from './workspace.mjs'

// ---- the second env file ----------------------------------------------------
//
// Beside `daemon/.env.daemon`, and spelled the same way, because the two are one
// operator habit: an env file the deploy copies to the box and never commits.

export const OVERSEER_ENV_FILE = '.env.overseer'

// What #313 put in that file, and what nothing reads any more. Named here so
// the boot can ask for its deletion by key.
export const RETIRED_TOKEN_KEY = 'CURIA_OVERSEER_GH_TOKEN'

export function overseerEnvPath(daemonRoot) {
  return path.join(daemonRoot, OVERSEER_ENV_FILE)
}

// The file, parsed, or an empty environment when it is not there. Absent is
// legal: a box that has not set up a model credential yet is a box whose
// overseer cannot run a turn, and the container says so at its own start.
//
// A file that exists and cannot be read is a different thing from one that is
// missing, and it throws rather than reading as empty — an unreadable file would
// otherwise silence the warnings below at the moment they matter most.
//
// `parseEnv` rather than `process.loadEnvFile`: a value here must never reach
// `process.env`, because a bare `GH_TOKEN` sitting in the daemon's environment
// would silently re-authenticate the daemon's own `gh`.
export function loadOverseerEnv(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw e
  }
  return parseEnv(raw)
}

// Keys that must never sit in this file, because the container gets every key in
// it and that container holds a shell. The daemon's own secrets are the ones an
// operator would copy in by hand while setting the file up, so they are the ones
// worth naming back. What this catches is the real accident —
// `cp daemon/.env.daemon daemon/.env.overseer` — which hands the read-only
// container every read-write token on the box.
export function daemonOnlyKeys(env) {
  return Object.keys(env).filter((k) => k.startsWith(`${AGENT_TOKEN_KEY}_`) || k.startsWith('DISCORD_'))
}

// #313's keys, still in the file after this cutover. Nothing reads them, so each
// one is a live read-only PAT that no longer has a job. The boot names them and
// asks for two acts: delete the key, and revoke the token on GitHub.
export function retiredTokenKeys(env) {
  return Object.keys(env).filter((k) => k.startsWith(`${RETIRED_TOKEN_KEY}_`))
}

// ---- the token files --------------------------------------------------------

// The tree, beside the checkouts and under the same workspace root, so the
// overseer's host state is one place. It holds one file per owner and nothing
// else, which is what lets compose mount it read-only into the container.
export function overseerTokensRootFor(workspaceRoot) {
  return path.join(workspaceRoot, 'overseer', 'tokens')
}

// A GitHub account name: alphanumerics and hyphens, and it starts with an
// alphanumeric. Asserted rather than escaped, because the value becomes a FILE
// NAME on both sides — the daemon writes it, and the shim builds it from an
// owner it read off a command line. `..` must never name a path here.
export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

// A GitHub token as GitHub writes one — `ghs_…` for an installation token.
// The 2026 installation tokens carry `.` and `-` beside the word characters
// (proven live on 2026-08-16). The same rule `agentgh.mjs` states, for the
// same reason — a stray quote or newline would make a reader read something
// other than what curia meant to write.
const TOKEN_RE = /^[A-Za-z0-9_.-]+$/

// The file one owner's token lives in, or null when the owner is not a name
// GitHub could issue. LOWER CASE, because GitHub logins are unique without
// regard to case, and the shim has to build this name from whatever spelling a
// command line carried.
export function overseerTokenFile(dir, owner) {
  const name = String(owner ?? '').trim()
  if (!OWNER_RE.test(name)) return null
  return path.join(dir, name.toLowerCase())
}

// Write one owner's token, replacing whatever the last refresh left.
//
// Through a rename, so the container's git and `gh` never read a half-written
// file: the daemon rewrites about every fifty minutes, and a torn read would be
// a 401 nobody could place.
export function writeOverseerToken(dir, owner, token) {
  const file = overseerTokenFile(dir, owner)
  if (!file) throw new Error(`refusing to write an overseer token for "${owner}": a GitHub account name is alphanumerics and hyphens`)
  const value = String(token ?? '').trim()
  if (!TOKEN_RE.test(value)) throw new Error(`refusing to write the overseer token for ${owner}: a GitHub token is letters, digits, underscore, dot and dash only`)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${value}\n`, { mode: 0o600 })
    // writeFileSync applies the mode only when it CREATES the file, and a
    // refresh finds one already there (the same note as agentgh.mjs).
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw new Error(`cannot write ${file}: permission denied — docker creates a missing bind-mount source as root, and every curia container runs as uid 1000. Run \`mkdir -p ${dir}\` on the box as that user, or \`sudo chown -R 1000:1000 ${dir}\``)
    }
    throw e
  }
  return file
}

// One owner's token, or null when this tree holds none for it. Read back rather
// than remembered: the daemon writes these files and the container reads them,
// and the file is the only thing both sides can see.
//
// A file that holds something other than a token THROWS, naming the file. It is
// the same rule #313 held on the env value, and for the same reason: a bad
// credential must fail where it can be read, and not as a 401 in the middle of
// a turn.
export function readOverseerToken(dir, owner) {
  const file = overseerTokenFile(dir, owner)
  if (!file) return null
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  const value = raw.trim()
  if (!value) return null
  if (!TOKEN_RE.test(value)) throw new Error(`${file} does not hold a GitHub token: a token is letters, digits, underscore, dot and dash only`)
  return value
}

// Every token file for an owner the watch list no longer names, removed.
//
// #361 let an owner dropped from the watch list KEEP its git config line,
// because the line held a variable name and nothing else. This tree holds live
// tokens, so the same reasoning inverts: a credential nobody watches is a
// credential nobody is refreshing either, and it must not sit here going stale.
export function sweepOverseerTokens(dir, owners) {
  const keep = new Set()
  for (const owner of owners) {
    const file = overseerTokenFile(dir, owner)
    if (file) keep.add(path.basename(file))
  }
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const removed = []
  for (const name of entries) {
    if (keep.has(name)) continue
    fs.rmSync(path.join(dir, name), { force: true })
    removed.push(name)
  }
  return removed
}
