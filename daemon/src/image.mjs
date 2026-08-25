// The shared agent image (#154, from the sandbox decision at #148): its tag,
// its build, the "is it already there" check the dispatch path (#156) asks
// before it runs a container, and the pin that keeps the box's nightly docker
// cleanup from deleting it overnight (#337, built by #350).
//
// The tag is a CONTENT ADDRESS, not a name someone bumps by hand. It carries
// the two CLI versions so a human reading `docker images` sees what an agent
// runs, and a hash over every build input so nothing else can drift silently:
//
//     curia-agent:2.1.220-0.146.0-1.18.18-0.84.2-3f8a1c2d
//                  ^claude ^codex  ^opencode ^pi    ^sha256(inputs)
//
// That is what makes "the daemon rebuilds the image when a CLI version bumps"
// a fact rather than a promise. A bump in config/curia.yaml names a tag that
// is not on the box, `docker image inspect` fails, and ensureAgentImage()
// builds it. The same holds for an edit to the Dockerfile itself, which a
// version-only tag would have missed — the case worth catching, since a
// Dockerfile edit is how the image changes most often.
//
// Nothing here reads the image at boot. The sandbox ships behind a per-harness
// switch that is off by default (#148), so the build belongs on the dispatch
// path of an agent that actually wants a container.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { execFileP } from './exec.mjs'
import { lastFrame, readable } from './logline.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Absolute, for the reason attach.mjs states: the daemon may be started from
// any cwd. The Dockerfile's own directory is also the build CONTEXT — the
// build COPYs nothing, so the context stays a directory holding one file
// instead of the whole repo the classic builder would otherwise upload.
export const DOCKERFILE = path.resolve(DIR, '..', '..', 'deploy', 'agent', 'Dockerfile')
export const BUILD_CONTEXT = path.dirname(DOCKERFILE)

export const DOCKER_BIN = process.env.DOCKER_BIN ?? 'docker'
export const BUILD_CMD = 'npm run build-agent-image --prefix daemon'

// A build pulls a base image, fetches gh, and installs four CLIs that are
// ~600 MB of native binary between them. Measured at ~4 minutes cold on the
// box; ten leaves room for a slow mirror without leaving a dispatch hanging
// on a wedged builder forever.
export const BUILD_TIMEOUT_MS = 10 * 60_000

// Every ARG the Dockerfile declares, in the order it declares them. Kept as
// one list because it is the contract between the two files: an ARG added
// there and missed here would build with the empty string and pin nothing.
const BUILD_ARGS = [
  'NODE_VERSION', 'CLAUDE_VERSION', 'CODEX_VERSION', 'OPENCODE_VERSION',
  'PI_VERSION', 'GH_VERSION', 'PLAYWRIGHT_VERSION', 'TTYD_VERSION', 'AGENT_UID',
]

// The pins as they are named in config/curia.yaml, mapped to the ARG each one
// feeds. `agent_uid` is the one that is not a version: it must match the host
// user owning the mounted clone, or the agent cannot write its own worktree.
// `node_version` is the one pin this file shares with deploy/compose.yaml: one
// Node patch version runs every curia image (#357, applied by #409). It rides
// the tag like the rest, so a bump here rebuilds the agent image, and the
// compose anchor rebuilds the other three.
export const SANDBOX_KEYS = {
  node_version: 'NODE_VERSION',
  claude_version: 'CLAUDE_VERSION',
  codex_version: 'CODEX_VERSION',
  opencode_version: 'OPENCODE_VERSION',
  pi_version: 'PI_VERSION',
  gh_version: 'GH_VERSION',
  playwright_version: 'PLAYWRIGHT_VERSION',
  ttyd_version: 'TTYD_VERSION',
  agent_uid: 'AGENT_UID',
}

export const DEFAULT_IMAGE = 'curia-agent'

// Docker tags accept [A-Za-z0-9_.-] and nothing else, so a version string with
// anything else in it (a `+build` suffix, a scoped prerelease) cannot ride the
// legible half of the tag. It still rides the hash, which is where correctness
// lives — the legible half is for the human reading `docker images`.
function tagSafe(s) {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, '_')
}

export function buildArgs(sandbox) {
  const args = {}
  for (const [key, arg] of Object.entries(SANDBOX_KEYS)) args[arg] = String(sandbox[key])
  return args
}

// The hash covers the Dockerfile bytes and every build arg. Reading the file
// on each call is deliberate: the daemon must notice an edit made by a `git
// pull` under a running process, and this runs once per dispatch, not per tick.
export function imageDigest(sandbox, dockerfile = DOCKERFILE) {
  const args = buildArgs(sandbox)
  const material = [
    fs.readFileSync(dockerfile, 'utf8'),
    ...BUILD_ARGS.map((a) => `${a}=${args[a] ?? ''}`),
  ].join('\n')
  return crypto.createHash('sha256').update(material).digest('hex')
}

export function agentImageRef(sandbox, dockerfile = DOCKERFILE) {
  const repo = sandbox.image ?? DEFAULT_IMAGE
  const digest = imageDigest(sandbox, dockerfile)
  const tag = [
    sandbox.claude_version,
    sandbox.codex_version,
    sandbox.opencode_version,
    sandbox.pi_version,
    digest.slice(0, 8),
  ].map(tagSafe).join('-')
  return { repo, tag, ref: `${repo}:${tag}`, digest, args: buildArgs(sandbox) }
}

// `docker image inspect` and nothing more: no pull, no registry. The image is
// built on the box it runs on, so a miss means "build it", never "fetch it".
export async function imageExists(ref, { exec = execFileP, docker = DOCKER_BIN } = {}) {
  try {
    await exec(docker, ['image', 'inspect', ref], { timeout: 15_000 })
    return true
  } catch (e) {
    // An absent image and an unreachable docker fail the same call, and they
    // want opposite answers: one is "build it", the other is "the daemon
    // cannot use docker at all". Only the first is a miss.
    if (/No such image|no such image/.test(`${e.stderr ?? ''}${e.message ?? ''}`)) return false
    throw dockerError(e)
  }
}

function dockerError(e) {
  const detail = (e.stderr ?? e.message ?? '').trim().split('\n')[0]
  if (e.code === 'ENOENT') {
    return new Error(`no \`${DOCKER_BIN}\` on PATH — the agent sandbox needs docker on this box`)
  }
  if (/permission denied.*docker\.sock/i.test(detail)) {
    return new Error(
      `docker refused the daemon user: ${detail}\n`
      + 'the user running curia must be in the `docker` group (`sudo usermod -aG docker <user>`, then restart the service)',
    )
  }
  return new Error(`docker failed: ${detail}`)
}

// Streamed, not buffered: a cold build prints minutes of apt and npm output,
// and a dispatch that shows nothing for four minutes reads as a hang.
export function buildAgentImage(ref, { onLine = () => {} } = {}) {
  const argv = ['build']
  for (const [arg, value] of Object.entries(ref.args)) argv.push('--build-arg', `${arg}=${value}`)
  argv.push('-t', ref.ref, '-f', DOCKERFILE, BUILD_CONTEXT)

  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_BIN, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    // #190: a build line is a TERMINAL line — buildkit colors it and apt
    // redraws it with carriage returns — and both make journalctl drop the
    // whole message. The redraw collapses here, while the line still has no
    // `[image <session>]` prefix in front of its first frame. A line that was
    // only a color reset says nothing once the color is gone, so it is not
    // emitted at all; that alone was 27 of the 64 lines lost during #185.
    const feed = (chunk) => {
      tail = (tail + chunk).split('\n').slice(-40).join('\n')
      for (const raw of String(chunk).split('\n')) {
        const line = readable(lastFrame(raw))
        if (line.trim()) onLine(line)
      }
    }
    // The tail rides a FAILED build's error to the operator, so it is cleaned
    // the same way. It stays raw until then, because a line split across two
    // chunks is only whole once both have arrived.
    const cleanTail = () => tail.split('\n').map((l) => readable(lastFrame(l))).join('\n').trim()
    child.stdout.setEncoding('utf8').on('data', feed)
    child.stderr.setEncoding('utf8').on('data', feed)

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`docker build exceeded ${BUILD_TIMEOUT_MS / 60_000} minutes and was killed`))
    }, BUILD_TIMEOUT_MS)

    child.once('error', (e) => { clearTimeout(timer); reject(dockerError(e)) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(ref)
      else reject(new Error(`docker build exited ${code}\n${cleanTail()}`))
    })
  })
}

// ---- the pin, and the tags it lets go ---------------------------------------------
//
// The box runs Coolify, and its forced nightly cleanup deletes every image no
// container references (#337). The label gate meant to spare an image is broken
// upstream — the inspect it runs exits 64 and the `|| docker rmi` branch always
// runs — so no label protects an image on that box. A REFERENCE does, and it is
// the only thing that survives both cleanup shapes and the next Coolify upgrade.
//
// So the daemon holds one: a container named `curia-agent-pin`, created against
// the live tag and never started. It costs the bytes of a container record and
// no process. It is checked on EVERY dispatch rather than after a build alone,
// so a pin someone removed heals at the next dispatch instead of at the next
// four-minute rebuild.
export const PIN_CONTAINER = 'curia-agent-pin'

// The image ref the pin container names, or null when there is no pin. Read
// from `.Config.Image`, which is the ref as it was given to `docker create` —
// the tag is a content address, so string equality is enough to tell "the pin
// is on the live image" from "the pin is on a tag we are replacing".
async function pinnedRef({ exec = execFileP, docker = DOCKER_BIN } = {}) {
  try {
    const { stdout } = await exec(docker, [
      'inspect', PIN_CONTAINER, '--format', '{{.Config.Image}}',
    ], { timeout: 15_000 })
    return stdout.trim() || null
  } catch (e) {
    if (/No such object|No such container/i.test(`${e.stderr ?? ''}${e.message ?? ''}`)) return null
    throw dockerError(e)
  }
}

// Make the pin name `ref`. Returns whether it had to create one, which is the
// only half worth a journal line.
export async function pinAgentImage(ref, { exec = execFileP, docker = DOCKER_BIN } = {}) {
  const seams = { exec, docker }
  const current = await pinnedRef(seams)
  if (current === ref) return { created: false }
  // A pin on a superseded tag is what holds that tag on disk, so it goes first
  // and the prune behind it can then remove the image itself.
  if (current !== null) {
    try {
      await exec(docker, ['rm', '--force', PIN_CONTAINER], { timeout: 30_000 })
    } catch (e) {
      if (!/No such container/i.test(`${e.stderr ?? ''}${e.message ?? ''}`)) throw dockerError(e)
    }
  }
  try {
    await exec(docker, ['create', '--name', PIN_CONTAINER, ref], { timeout: 60_000 })
  } catch (e) {
    // Two dispatches can reach this line together. The loser is told the name
    // is taken, and that is a success as long as the winner pinned the same
    // ref — which it did, since both resolved the same content address.
    const detail = `${e.stderr ?? ''}${e.message ?? ''}`
    if (/already in use/i.test(detail) && await pinnedRef(seams) === ref) return { created: false }
    throw dockerError(e)
  }
  return { created: true }
}

// Every other tag of the same repository, removed with plain `docker rmi`.
//
// Refusals are silenced by design: a tag a running agent still references
// refuses safely, and the next build comes back for it. Nothing here is worth
// failing a dispatch over — the agent has the image it asked for.
export async function pruneOtherTags(ref, { exec = execFileP, docker = DOCKER_BIN } = {}) {
  let stdout
  try {
    ({ stdout } = await exec(docker, [
      'images', ref.repo, '--format', '{{.Repository}}:{{.Tag}}',
    ], { timeout: 15_000 }))
  } catch {
    return []
  }
  const dead = [...new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))]
    .filter((tag) => tag !== ref.ref && !tag.endsWith(':<none>'))
  const removed = []
  for (const tag of dead) {
    try {
      await exec(docker, ['rmi', tag], { timeout: 60_000 })
      removed.push(tag)
    } catch { /* still referenced, or already gone: both are fine here */ }
  }
  return removed
}

// One build at a time per tag. Two dispatches landing together would otherwise
// each run a four-minute build of the same image, and the second would win a
// race it did not need to enter.
const inflight = new Map()

export async function ensureAgentImage(sandbox, {
  onLine, exec = execFileP, docker = DOCKER_BIN, build = buildAgentImage,
} = {}) {
  const seams = { exec, docker }
  const ref = agentImageRef(sandbox)
  const built = !(await imageExists(ref.ref, seams))

  if (built) {
    if (!inflight.has(ref.ref)) {
      const p = build(ref, { onLine }).finally(() => inflight.delete(ref.ref))
      inflight.set(ref.ref, p)
    }
    await inflight.get(ref.ref)
  }

  // The pin moves BEFORE the prune, so the tag it used to hold is free to go.
  // A pin that cannot be made is reported, never thrown: the image is on the
  // box and the agent can run: what the failure costs is one rebuild after the
  // next nightly cleanup, and a refused dispatch costs more than that.
  let pin
  try {
    pin = await pinAgentImage(ref.ref, seams)
  } catch (e) {
    pin = { created: false, error: e.message }
  }
  // The sweep runs when the live tag CHANGED, which the pin states better than
  // the build does: `npm run build-agent-image` ahead of a bump is the way to
  // keep the dispatch path warm, and it leaves the next dispatch nothing to
  // build and a superseded tag to remove. A dispatch that finds its pin already
  // on the live image changed nothing, and sweeps nothing.
  const pruned = built || pin.created ? await pruneOtherTags(ref, seams) : []

  return { ...ref, built, pin, pruned }
}
