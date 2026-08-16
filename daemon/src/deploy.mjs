// The self-deploy verb (#270). While the operator travels, no dev box runs
// `bin/deploy.sh`, so curia must apply its own merged code.
//
// It refuses two shapes before it orders anything: a checkout with commits
// origin/main does not have, and a checkout with uncommitted changes to a
// tracked file (#292). Both would land in the sibling's `git merge --ff-only`,
// and the sibling reads a failed merge as a failed deploy and rolls back over
// the very edit that caused it.
//
// The daemon cannot recreate its own container: `docker compose up` run from
// inside it dies with the container it recreates, half-way through. So the
// verb only ORDERS the deploy. The daemon fetches, refuses anything that is
// not a fast-forward, writes a marker file, journals the order, and starts a
// detached sibling container (`curia-deploy`, on the daemon's own image) that
// runs deploy/self-deploy.sh from the repo mount. The sibling survives the
// daemon's death: it merges, rebuilds, recreates `daemon dashboard`, and
// health-checks the successor. On a failed health check it resets the checkout
// to the previous ref and recreates again — that is the lockout story: a
// deploy that ships a crash-looping daemon rolls itself back with no ssh in
// the loop, because code runs from the repo mount and the previous ref is a
// known-good tree.
//
// The outcome is announced by whichever daemon survives: resolvePending()
// polls the marker at boot until the sibling writes a terminal state, then
// journals it, announces it in the channel, and deletes the marker.
//
// Who may call it: the typed surfaces only — the Discord slash verb (gated by
// DISCORD_ALLOWED_USERS) and POST /command (loopback, CSRF-gated). The
// overseer composes no `deploy`, and an interpreted one is refused here: per
// the #89 discipline an interpreted destructive verb needs a button confirm,
// and this verb has none.

import fs from 'node:fs'
import path from 'node:path'
import { execFileP } from './exec.mjs'

// Terminal marker states the sibling can write. Everything else means the
// deploy is still in flight (daemon: handed-off; sibling: deploying,
// rolling-back).
const TERMINAL = new Set(['landed', 'rolled-back', 'lockout'])

const short = (sha) => String(sha).slice(0, 7)

// The sibling's `docker run` argv, pure for the test that pins it. The
// container is detached (it must outlive the caller), auto-removed (its log
// lives in deploy.log, not in docker), and named — the fixed name is the
// concurrency guard: a second deploy while one is in flight fails the run
// with a name conflict instead of racing it.
export function helperRunArgs({ repoRoot, dataDir, home, uid, gid }) {
  return [
    'run', '-d', '--rm', '--name', 'curia-deploy',
    // host network: the health check curls the daemon on host loopback
    '--network', 'host',
    '--user', `${uid}:${uid}`, '--group-add', String(gid),
    '-e', `HOME=${home}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    // same-path principle: the checkout and the data dir mount where they live
    '-v', `${repoRoot}:${repoRoot}`,
    '-v', `${dataDir}:${dataDir}`,
    // git over https via gh's credential helper, same mounts the daemon has
    '-v', `${home}/.config/gh:${home}/.config/gh`,
    '-v', `${home}/.gitconfig:${home}/.gitconfig:ro`,
    'curia-daemon',
    // The sibling's own `git merge` rewrites self-deploy.sh in the checkout
    // while bash is executing it, and bash reads scripts incrementally — so
    // the copy in the container's own /tmp is the one that runs.
    'bash', '-c', `cp ${repoRoot}/deploy/self-deploy.sh /tmp/self-deploy.sh && exec bash /tmp/self-deploy.sh "$@"`, 'self-deploy',
  ]
}

export class SelfDeploy {
  constructor({ repoRoot, dataDir, reduction, log = console.log, exec = execFileP, port = 4271, home = process.env.HOME ?? '/home/alp', dockerSocket = '/var/run/docker.sock' }) {
    this.repoRoot = repoRoot
    this.dataDir = dataDir
    this.reduction = reduction
    this.log = log
    this.exec = exec
    this.port = port
    this.home = home
    this.dockerSocket = dockerSocket
    this.markerPath = path.join(dataDir, 'deploy.json')
    this.logPath = path.join(dataDir, 'deploy.log')
  }

  readMarker() {
    try {
      return JSON.parse(fs.readFileSync(this.markerPath, 'utf8'))
    } catch {
      return null
    }
  }

  #git(...args) {
    return this.exec('git', args, { cwd: this.repoRoot, timeout: 60_000 })
  }

  // The daemon's half: preflight, order, hand off. Everything after the
  // `docker run` returns happens without this process.
  async run({ by, interpreted = false } = {}) {
    if (interpreted) {
      return '❌ deploy is typed-only — it restarts the daemon, and an interpreted verb with no button confirm must not. Type `/deploy` yourself.'
    }
    const pending = this.readMarker()
    if (pending && !TERMINAL.has(pending.state)) {
      return `⚙️ a deploy is already in flight (${short(pending.prev)} → ${short(pending.next)}, state **${pending.state}**) — its outcome lands in the channel`
    }
    // The tree, before anything else (#292). A modified tracked file makes the
    // sibling's `git merge --ff-only` refuse the moment an incoming commit
    // touches the same file — and the sibling reads that refusal as a failed
    // deploy and runs `git reset --hard`, which discards the edit and says
    // nothing. So the check belongs here, where it can still name the files.
    // Untracked files are none of its business: the dashboard's own settings
    // live in ignored ones.
    // Every porcelain line is a two-character status, a space, then the path —
    // and the status of a modified-but-unstaged file starts with a space, so
    // the lines are cut one by one rather than trimmed as one string.
    const status = (await this.#git('status', '--porcelain', '--untracked-files=no')).stdout
    const files = status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
    if (files.length) {
      const named = files.slice(0, 5).join(', ')
      const rest = files.length > 5 ? `, and ${files.length - 5} more` : ''
      return [
        `❌ the checkout at ${this.repoRoot} has uncommitted changes to ${named}${rest} — a fast-forward would refuse them, and the rollback would discard them.`,
        'Commit or discard them over ssh. The dashboard writes `config/*.local.yaml`, which git does not track, so a settings save is never what this is.',
      ].join('\n')
    }
    await this.#git('fetch', 'origin', 'main')
    const prev = (await this.#git('rev-parse', 'HEAD')).stdout.trim()
    const next = (await this.#git('rev-parse', 'origin/main')).stdout.trim()
    if (prev === next) return `✅ already at ${short(prev)} — origin/main holds nothing new`
    try {
      await this.#git('merge-base', '--is-ancestor', 'HEAD', 'origin/main')
    } catch {
      return `❌ the checkout at ${this.repoRoot} has commits origin/main does not (HEAD ${short(prev)}) — that needs hands, not a fast-forward. Fix it over ssh.`
    }
    // The socket's group is what lets the sibling talk to host dockerd — the
    // same group_add the compose file gives this container. No socket, no
    // self-deploy: the dev box runs the daemon bare and deploys with
    // bin/deploy.sh.
    let gid
    try {
      gid = fs.statSync(this.dockerSocket).gid
    } catch {
      return '❌ no docker socket — this daemon cannot deploy itself; use bin/deploy.sh'
    }
    fs.writeFileSync(this.markerPath, JSON.stringify({
      state: 'handed-off', prev, next, by, ts: new Date().toISOString(),
    }, null, 2))
    this.reduction.journal('deploy_requested', { by, prev, next })
    const args = [
      ...helperRunArgs({
        repoRoot: this.repoRoot, dataDir: this.dataDir, home: this.home,
        uid: process.getuid?.() ?? 1000, gid,
      }),
      // script argv: prev next repoRoot markerFile logFile port
      prev, next, this.repoRoot, this.markerPath, this.logPath, String(this.port),
    ]
    try {
      await this.exec('docker', args, { timeout: 60_000 })
    } catch (e) {
      // The order failed before anything changed — clear the marker so the
      // next attempt is not refused as in-flight.
      fs.rmSync(this.markerPath, { force: true })
      if (/is already in use/.test(e.message)) return '⚙️ a deploy is already in flight — the `curia-deploy` container is still running'
      throw e
    }
    return [
      `🚀 deploy handed off: ${short(prev)} → ${short(next)}. The daemon restarts now.`,
      `The sibling health-checks the successor and rolls back to ${short(prev)} if it does not come up — either way the outcome lands here.`,
    ].join('\n')
  }

  // The surviving daemon's half, called once at boot: wait for the sibling to
  // write a terminal state, then say what happened. Announce failures only
  // log — the journal line is the record, the channel line is a courtesy.
  async resolvePending({ announce, pollMs = 5_000, timeoutMs = 5 * 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    let marker = this.readMarker()
    if (!marker) return null
    const deadline = Date.now() + timeoutMs
    while (!TERMINAL.has(marker.state) && Date.now() < deadline) {
      await sleep(pollMs)
      marker = this.readMarker() ?? marker
    }
    const { state, prev, next } = marker
    let text
    if (state === 'landed') {
      this.reduction.journal('deploy_landed', { prev, next })
      text = `🚀 deploy landed: ${short(prev)} → ${short(next)} — the health check passed`
    } else if (state === 'rolled-back') {
      this.reduction.journal('deploy_rolled_back', { prev, next, reason: marker.reason ?? null })
      text = `⚠️ deploy ROLLED BACK: ${short(next)} failed its health check — running ${short(prev)} again. See daemon/data/deploy.log.`
    } else if (state === 'lockout') {
      // A daemon that can say this survived, so the word is one notch too
      // dark — but the sibling gave up, and that deserves the loud spelling.
      this.reduction.journal('deploy_rolled_back', { prev, next, reason: 'lockout: the rollback health check failed too' })
      text = `🛑 deploy failed AND the rollback health check failed (${short(prev)} → ${short(next)}) — the box needs eyes. See daemon/data/deploy.log.`
    } else {
      this.reduction.journal('deploy_unresolved', { prev, next, state })
      text = `⚠️ deploy outcome unknown: the sibling never wrote a result (last state **${state}**, ${short(prev)} → ${short(next)}). See daemon/data/deploy.log.`
    }
    fs.rmSync(this.markerPath, { force: true })
    this.log(text)
    try {
      await announce?.(text)
    } catch (e) {
      this.log(`deploy outcome announcement failed: ${e.message}`)
    }
    return state
  }
}
