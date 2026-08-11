// The overseer's GitHub authority (#313, building ADR-0014's "its GitHub token
// is read-only").
//
// The overseer container holds a shell. That shell is the whole point of the
// move, and a read-only token is the control that replaces the `/command` seam:
// a standing order cannot hold a shell, and a shell cannot mint a token. So the
// container gets one FINE-GRAINED PAT PER RESOURCE OWNER, carrying Contents,
// Issues, Pull requests, Commit statuses and Metadata at READ, and nothing else.
// Agents keep the read-write tokens of #155, and they write through pull
// requests.
//
// THE SECOND ENV FILE IS THE BOUNDARY. There is one env file per container that
// holds secrets, and the pair reads as a pair: `daemon/.env.daemon` and
// `daemon/.env.overseer`. These keys live in the second one, and the overseer
// service loads that file and never the first.
//
// `.env.daemon` carries the agents' read-WRITE tokens and the Discord bot token,
// and compose cannot filter an env file: `env_file: ../daemon/.env.daemon` on
// the overseer service would hand every one of those values to a container with
// a shell, where `export` undoes the whole read-only posture in one command. A
// file the overseer may hold whole is the only form of that boundary a static
// compose file can express.
//
// THE DAEMON READS THIS FILE AND NEVER LOADS IT. `parseEnv` rather than
// `process.loadEnvFile`: a value here must never reach `process.env`, because a
// bare `GH_TOKEN` sitting in the daemon's environment would silently
// re-authenticate the daemon's own `gh` — the same trap #155 named when it chose
// a prefixed key. What the daemon does with what it reads is say it out loud at
// boot: one line per token, and a warning when a token cannot reach a watched
// repo or is about to die.
//
// THE EXPIRY IS A CALENDAR ITEM, not a detail. An organization can cap
// fine-grained PAT lifetime, and `getalfredo` caps it at 366 days — measured
// again for this ticket, and the refusal hits a PUBLIC repo read too, so a
// longer-lived token is not merely narrower there, it is refused outright. An
// expired token does not degrade to anything. It fails every call with a 401, so
// the boot warning is the whole defense.

import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { AGENT_TOKEN_KEY, ownerSlug, readGhToken } from './workspace.mjs'

export const OVERSEER_TOKEN_KEY = 'CURIA_OVERSEER_GH_TOKEN'

// Beside `daemon/.env.daemon`, and spelled the same way, because the two are one
// operator habit: an env file the deploy copies to the box and never commits.
export const OVERSEER_ENV_FILE = '.env.overseer'

export function overseerEnvPath(daemonRoot) {
  return path.join(daemonRoot, OVERSEER_ENV_FILE)
}

// `alp82/curia` → `CURIA_OVERSEER_GH_TOKEN_ALP82`, the agent key's shape one
// prefix over. One spelling rule for both, so an operator who has written one
// pair of keys has written the other.
export function overseerTokenKeyFor(repo) {
  const slug = ownerSlug(repo)
  return slug ? `${OVERSEER_TOKEN_KEY}_${slug}` : null
}

// The file, parsed, or an empty environment when it is not there. Absent is the
// pre-#313 state and stays legal: nothing reads these tokens until the overseer
// container exists, and the boot warning is what asks for them.
//
// A file that exists and cannot be read is a different thing from one that is
// missing, and it throws rather than reading as empty — an unreadable file would
// otherwise silence every warning below at the moment it matters most.
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

// The overseer's token for one repo, or null. Null means the container has no
// credential for that owner. Unlike an agent's null (#155), it is NOT a fallback
// to the host login: the container mounts no `~/.config/gh`, so the reach is
// simply whatever GitHub gives an anonymous caller.
export function overseerGhToken(repo, env) {
  const key = overseerTokenKeyFor(repo)
  return key ? readGhToken(env, key, `daemon/${OVERSEER_ENV_FILE}`) : null
}

// Every overseer token in the file, validated. A malformed value throws here, at
// boot, rather than reaching the container as a 401 in the middle of a turn.
export function assertOverseerTokens(env) {
  return Object.keys(env)
    .filter((k) => k.startsWith(`${OVERSEER_TOKEN_KEY}_`))
    .map((k) => ({ key: k, token: readGhToken(env, k, `daemon/${OVERSEER_ENV_FILE}`) }))
    .filter(({ token }) => token !== null)
}

// Keys that must never sit in this file, because the file is the boundary and
// every key in it reaches a container holding a shell. The daemon's own secrets
// are the ones an operator would copy in by hand while setting the file up, so
// they are the ones worth naming back.
//
// A WARNING, NOT A REFUSAL: #327 has still to decide how the model credential
// reaches the container, and a boot that refuses an unknown key would refuse
// that answer before it is written. What this catches is the real accident —
// `cp daemon/.env.daemon daemon/.env.overseer` — which hands the read-only
// container every read-write token on the box.
export function daemonOnlyKeys(env) {
  return Object.keys(env).filter((k) => k.startsWith(`${AGENT_TOKEN_KEY}_`) || k.startsWith('DISCORD_'))
}
