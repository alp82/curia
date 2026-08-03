// The shared worker image (#154, from the sandbox decision at #148): its tag,
// its build, and the "is it already there" check the dispatch path (#156) asks
// before it runs a container.
//
// The tag is a CONTENT ADDRESS, not a name someone bumps by hand. It carries
// the two CLI versions so a human reading `docker images` sees what a worker
// runs, and a hash over every build input so nothing else can drift silently:
//
//     curia-worker:2.1.220-0.146.0-3f8a1c2d
//                  ^claude ^codex  ^sha256(Dockerfile + all build args)
//
// That is what makes "the daemon rebuilds the image when a CLI version bumps"
// a fact rather than a promise. A bump in config/curia.yaml names a tag that
// is not on the box, `docker image inspect` fails, and ensureWorkerImage()
// builds it. The same holds for an edit to the Dockerfile itself, which a
// version-only tag would have missed — the case worth catching, since a
// Dockerfile edit is how the image changes most often.
//
// Nothing here reads the image at boot. The sandbox ships behind a per-backend
// switch that is off by default (#148), so the build belongs on the dispatch
// path of a worker that actually wants a container.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { execFileP } from './exec.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Absolute, for the reason attach.mjs states: the daemon may be started from
// any cwd. The Dockerfile's own directory is also the build CONTEXT — the
// build COPYs nothing, so the context stays a directory holding one file
// instead of the whole repo the classic builder would otherwise upload.
export const DOCKERFILE = path.resolve(DIR, '..', '..', 'deploy', 'worker', 'Dockerfile')
export const BUILD_CONTEXT = path.dirname(DOCKERFILE)

export const DOCKER_BIN = process.env.DOCKER_BIN ?? 'docker'
export const BUILD_CMD = 'npm run build-worker-image --prefix daemon'

// A build pulls a base image, fetches gh, and installs two CLIs that are
// ~600 MB of native binary between them. Measured at ~4 minutes cold on the
// box; ten leaves room for a slow mirror without leaving a dispatch hanging
// on a wedged builder forever.
export const BUILD_TIMEOUT_MS = 10 * 60_000

// Every ARG the Dockerfile declares, in the order it declares them. Kept as
// one list because it is the contract between the two files: an ARG added
// there and missed here would build with the empty string and pin nothing.
const BUILD_ARGS = ['CLAUDE_VERSION', 'CODEX_VERSION', 'GH_VERSION', 'PLAYWRIGHT_VERSION', 'AGENT_UID']

// The pins as they are named in config/curia.yaml, mapped to the ARG each one
// feeds. `agent_uid` is the one that is not a version: it must match the host
// user owning the mounted clone, or the worker cannot write its own worktree.
export const SANDBOX_KEYS = {
  claude_version: 'CLAUDE_VERSION',
  codex_version: 'CODEX_VERSION',
  gh_version: 'GH_VERSION',
  playwright_version: 'PLAYWRIGHT_VERSION',
  agent_uid: 'AGENT_UID',
}

export const DEFAULT_IMAGE = 'curia-worker'

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

export function workerImageRef(sandbox, dockerfile = DOCKERFILE) {
  const repo = sandbox.image ?? DEFAULT_IMAGE
  const digest = imageDigest(sandbox, dockerfile)
  const tag = `${tagSafe(sandbox.claude_version)}-${tagSafe(sandbox.codex_version)}-${digest.slice(0, 8)}`
  return { repo, tag, ref: `${repo}:${tag}`, digest, args: buildArgs(sandbox) }
}

// `docker image inspect` and nothing more: no pull, no registry. The image is
// built on the box it runs on, so a miss means "build it", never "fetch it".
export async function imageExists(ref) {
  try {
    await execFileP(DOCKER_BIN, ['image', 'inspect', ref], { timeout: 15_000 })
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
    return new Error(`no \`${DOCKER_BIN}\` on PATH — the worker sandbox needs docker on this box`)
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
export function buildWorkerImage(ref, { onLine = () => {} } = {}) {
  const argv = ['build']
  for (const [arg, value] of Object.entries(ref.args)) argv.push('--build-arg', `${arg}=${value}`)
  argv.push('-t', ref.ref, '-f', DOCKERFILE, BUILD_CONTEXT)

  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_BIN, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const feed = (chunk) => {
      tail = (tail + chunk).split('\n').slice(-40).join('\n')
      for (const line of String(chunk).split('\n')) if (line.trim()) onLine(line)
    }
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
      else reject(new Error(`docker build exited ${code}\n${tail.trim()}`))
    })
  })
}

// One build at a time per tag. Two dispatches landing together would otherwise
// each run a four-minute build of the same image, and the second would win a
// race it did not need to enter.
const inflight = new Map()

export async function ensureWorkerImage(sandbox, { onLine } = {}) {
  const ref = workerImageRef(sandbox)
  if (await imageExists(ref.ref)) return { ...ref, built: false }

  if (!inflight.has(ref.ref)) {
    const p = buildWorkerImage(ref, { onLine }).finally(() => inflight.delete(ref.ref))
    inflight.set(ref.ref, p)
  }
  await inflight.get(ref.ref)
  return { ...ref, built: true }
}
