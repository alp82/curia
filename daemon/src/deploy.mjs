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
const TERMINAL = new Set(['landed', 'rolled-back', 'lockout', 'merge-refused'])

const short = (sha) => String(sha).slice(0, 7)

// The sibling's `docker run` argv, pure for the test that pins it. The
// container is detached (it must outlive the caller), auto-removed (its log
// lives in deploy.log, not in docker), and named — the fixed name is the
// concurrency guard: a second deploy while one is in flight fails the run
// with a name conflict instead of racing it.
export function helperRunArgs({ repoRoot, dataDir, home, uid, gid, workRoot }) {
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
    // the workspace, so the script can pre-create the overseer's bind-mount
    // sources as uid 1000 — dockerd creates a missing source as root, and the
    // overseer then cannot write its own trees (alp82/curia#474).
    //
    // It also carries HOME, which is `home/` inside this tree since #473: the
    // `gh` auth that git's credential helper runs on and the git identity ride
    // in with it, where they used to be two mounts out of the operator's home.
    '-v', `${workRoot}:${workRoot}`,
    'curia-daemon',
    // The sibling's own `git merge` rewrites self-deploy.sh in the checkout
    // while bash is executing it, and bash reads scripts incrementally — so
    // the copy in the container's own /tmp is the one that runs.
    'bash', '-c', `cp ${repoRoot}/deploy/self-deploy.sh /tmp/self-deploy.sh && exec bash /tmp/self-deploy.sh "$@"`, 'self-deploy',
  ]
}

export class SelfDeploy {
  // `home` is curia's own HOME, and compose is what states it: `home/` inside
  // the workspace root (#473). The fallback repeats that rule for a run outside
  // compose, where nothing sets HOME — it names no box's home directory.
  constructor({ repoRoot, dataDir, workRoot, reduction, log = console.log, exec = execFileP, port = 4271, home = process.env.HOME ?? path.join(workRoot, 'home'), dockerSocket = '/var/run/docker.sock' }) {
    this.repoRoot = repoRoot
    this.dataDir = dataDir
    this.workRoot = workRoot
    this.reduction = reduction
    this.log = log
    this.exec = exec
    this.port = port
    this.home = home
    this.dockerSocket = dockerSocket
    this.markerPath = path.join(dataDir, 'deploy.json')
    this.logPath = path.join(dataDir, 'deploy.log')
    // The last resolved outcome, kept for the dashboard (#562): the marker is
    // deleted the moment it is announced, and a Discord line scrolls away, so
    // this file is the one place "what did the last deploy do, and why" stays
    // readable after the fact.
    this.lastPath = path.join(dataDir, 'deploy-last.json')
    // Set by index.mjs. run() needs it for the one outcome that never restarts
    // the daemon (merge-refused): no successor boots, so no boot-time
    // resolvePending() would ever announce it.
    this.announce = null
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
    const lines = status.split('\n').filter((l) => l.trim())
    const entries = lines.map((l) => ({ code: l.slice(0, 2), file: l.slice(3).trim() }))
    // Lockfile churn heals itself. The start-time `npm install` runs against
    // the repo mount, and an npm version drift rewrites package-lock.json
    // (deploy/daemon/Dockerfile) — the daemon wrote that diff, so the daemon
    // may discard it. The guard against a real dependency edit: discard only
    // an unstaged lockfile whose sibling package.json is clean. An intentional
    // change stages the lockfile or dirties package.json with it.
    const dirty = new Set(entries.map((e) => e.file))
    const churn = entries
      .filter((e) => e.code === ' M' && path.basename(e.file) === 'package-lock.json')
      .filter((e) => !dirty.has(path.posix.join(path.posix.dirname(e.file), 'package.json')))
      .map((e) => e.file)
    if (churn.length) {
      await this.#git('checkout', '--', ...churn)
      this.reduction.journal('deploy_lockfile_churn_discarded', { files: churn })
    }
    const files = entries.map((e) => e.file).filter((f) => !churn.includes(f))
    if (files.length) {
      const named = files.slice(0, 5).join(', ')
      const rest = files.length > 5 ? `, and ${files.length - 5} more` : ''
      return [
        `❌ the checkout at ${this.repoRoot} has uncommitted changes to ${named}${rest} — a fast-forward would refuse them, and the rollback would discard them.`,
        'Commit or discard them over ssh. The dashboard writes `config/*.local.yaml`, which git does not track, so a settings save is never what this is.',
      ].join('\n')
    }
    // The discard note rides on whichever reply follows, so the operator sees
    // what the preflight threw away and why it was safe to.
    let note = churn.length
      ? `♻️ discarded npm lockfile churn in ${churn.join(', ')} — the start-time \`npm install\` rewrote it, package.json is clean.\n`
      : ''
    await this.#git('fetch', 'origin', 'main')
    const prev = (await this.#git('rev-parse', 'HEAD')).stdout.trim()
    const next = (await this.#git('rev-parse', 'origin/main')).stdout.trim()
    if (prev === next) return `${note}✅ already at ${short(prev)} — origin/main holds nothing new`
    try {
      await this.#git('merge-base', '--is-ancestor', 'HEAD', 'origin/main')
    } catch {
      return `❌ the checkout at ${this.repoRoot} has commits origin/main does not (HEAD ${short(prev)}) — that needs hands, not a fast-forward. Fix it over ssh.`
    }
    // The untracked collision (#562). The tracked-only status check above is
    // right about untracked files in general — the dashboard's own overrides
    // live in them — but an untracked file AT A PATH THE INCOMING RANGE ADDS
    // makes the sibling's `git merge --ff-only` refuse ("untracked working
    // tree files would be overwritten"), and the sibling reads that as a
    // failed deploy. The 4897a82 rollout hit exactly this: a live check run on
    // the box left files that a later commit added to the tree.
    //
    // The fix follows the lockfile-churn rule: a copy byte-identical to what
    // origin/main brings is safe to discard, and is, with a journal line. A
    // copy that DIFFERS is somebody's work, so the deploy refuses by name
    // instead of handing the collision to the sibling.
    const untracked = (await this.#git('ls-files', '--others', '--exclude-standard')).stdout.split('\n').filter(Boolean)
    if (untracked.length) {
      const added = new Set((await this.#git('diff', '--name-only', '--diff-filter=A', 'HEAD', 'origin/main')).stdout.split('\n').filter(Boolean))
      const dupes = []
      const diverged = []
      for (const f of untracked.filter((u) => added.has(u))) {
        let incoming = null
        try {
          incoming = (await this.#git('rev-parse', `origin/main:${f}`)).stdout.trim()
        } catch {
          incoming = null
        }
        let local = null
        try {
          local = (await this.#git('hash-object', '--no-filters', '--', f)).stdout.trim()
        } catch {
          local = null
        }
        if (incoming && local && incoming === local) dupes.push(f)
        else diverged.push(f)
      }
      if (diverged.length) {
        return [
          `❌ the checkout at ${this.repoRoot} has untracked files that ${short(next)} adds as tracked, with DIFFERENT content: ${diverged.join(', ')}.`,
          'The merge would refuse to overwrite them and the deploy would roll back for nothing. Move or remove them over ssh — or commit the box’s versions, if they are the ones you want.',
        ].join('\n')
      }
      if (dupes.length) {
        for (const f of dupes) fs.rmSync(path.join(this.repoRoot, f), { force: true })
        this.reduction.journal('deploy_untracked_dup_discarded', { files: dupes })
        note += `♻️ removed untracked ${dupes.join(', ')} — byte-identical copies of files this deploy adds as tracked, so the merge keeps the same bytes.\n`
      }
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
        uid: process.getuid?.() ?? 1000, gid, workRoot: this.workRoot,
      }),
      // script argv: prev next repoRoot markerFile logFile port workRoot
      prev, next, this.repoRoot, this.markerPath, this.logPath, String(this.port), this.workRoot,
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
    // Watch for the one terminal state that never restarts the daemon:
    // merge-refused happens before the sibling recreates anything, so THIS
    // process is the survivor and no boot-time resolvePending() will run. On
    // every other outcome the recreate kills this process mid-poll and the
    // successor announces — the poll below simply dies with it.
    this.resolvePending({ announce: this.announce ?? undefined })
      .catch((e) => this.log(`deploy watch failed: ${e.message}`))
    return [
      `${note}🚀 deploy handed off: ${short(prev)} → ${short(next)}. The daemon restarts now.`,
      `The sibling health-checks the successor and rolls back to ${short(prev)} if it does not come up — either way the outcome lands here.`,
    ].join('\n')
  }

  // The surviving daemon's half, called once at boot: wait for the sibling to
  // write a terminal state, then say what happened. Announce failures only
  // log — the journal line is the record, the channel line is a courtesy.
  // The default sleep unrefs its timer: run()'s post-hand-off watch must never
  // be what keeps this process alive.
  async resolvePending({ announce, pollMs = 5_000, timeoutMs = 5 * 60_000, sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() }) } = {}) {
    let marker = this.readMarker()
    if (!marker) return null
    const deadline = Date.now() + timeoutMs
    while (!TERMINAL.has(marker.state) && Date.now() < deadline) {
      await sleep(pollMs)
      marker = this.readMarker() ?? marker
    }
    const { state, prev, next } = marker
    const reason = marker.reason || null
    let text
    if (state === 'landed') {
      this.reduction.journal('deploy_landed', { prev, next })
      text = `🚀 deploy landed: ${short(prev)} → ${short(next)} — the health check passed`
    } else if (state === 'merge-refused') {
      // Nothing was recreated: the sibling refused the fast-forward before it
      // touched a container, so the running daemon never stopped. The excerpt
      // carries git's own words — "untracked working tree files would be
      // overwritten" reads very differently from a crash-looping successor.
      this.reduction.journal('deploy_merge_refused', { prev, next, reason })
      text = `❌ deploy refused: git could not fast-forward to ${short(next)} — nothing was recreated, ${short(prev)} never stopped.\n${this.logExcerpt() || 'See daemon/data/deploy.log.'}`
    } else if (state === 'rolled-back') {
      this.reduction.journal('deploy_rolled_back', { prev, next, reason })
      text = `⚠️ deploy ROLLED BACK: ${reason ?? `${short(next)} failed its health check`} — running ${short(prev)} again. See daemon/data/deploy.log.`
    } else if (state === 'lockout') {
      // A daemon that can say this survived, so the word is one notch too
      // dark — but the sibling gave up, and that deserves the loud spelling.
      this.reduction.journal('deploy_rolled_back', { prev, next, reason: 'lockout: the rollback health check failed too' })
      text = `🛑 deploy failed AND the rollback health check failed (${short(prev)} → ${short(next)}) — the box needs eyes. See daemon/data/deploy.log.`
    } else {
      this.reduction.journal('deploy_unresolved', { prev, next, state })
      text = `⚠️ deploy outcome unknown: the sibling never wrote a result (last state **${state}**, ${short(prev)} → ${short(next)}). See daemon/data/deploy.log.`
    }
    // The dashboard's record (#562), written before the marker goes away.
    try {
      const last = JSON.stringify({
        state, prev, next, reason, by: marker.by ?? null, ts: marker.ts ?? null,
        resolved_at: new Date().toISOString(), text, log: this.logExcerpt(),
      }, null, 2)
      const temporary = `${this.lastPath}.tmp`
      fs.writeFileSync(temporary, last)
      fs.renameSync(temporary, this.lastPath)
    } catch (e) {
      this.log(`could not write ${this.lastPath}: ${e.message}`)
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

  // The story of the LAST attempt, out of deploy.log — the `[self-deploy ...]`
  // narration plus error lines, never the docker build noise between them.
  // Scan in bounded chunks so a long rollback build cannot push the first
  // failure out of the excerpt.
  logExcerpt({ chunkBytes = 64 * 1024, maxLines = 30 } = {}) {
    let fd
    try {
      fd = fs.openSync(this.logPath, 'r')
    } catch {
      return ''
    }
    const kept = []
    const deployStart = /\[self-deploy .*\] deploy [0-9a-f]{7,} -> [0-9a-f]{7,}/
    const errorLine = /\b(?:error|fatal|fail(?:ed|ure)?|cannot|denied|invalid|missing|not found|no such file|required|undefined|refused|aborting|not allowed|must be|unable to)\b/i
    const readLine = (line) => {
      if (deployStart.test(line)) kept.length = 0
      if (kept.length < maxLines && (/\[self-deploy /.test(line) || errorLine.test(line) || /^\t\S/.test(line))) kept.push(line)
    }
    let carry = ''
    const buffer = Buffer.alloc(chunkBytes)
    try {
      let position = 0
      for (;;) {
        const count = fs.readSync(fd, buffer, 0, buffer.length, position)
        if (!count) break
        position += count
        const lines = (carry + buffer.subarray(0, count).toString('utf8')).split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) readLine(line)
      }
      if (carry) readLine(carry)
    } finally {
      fs.closeSync(fd)
    }
    return kept.join('\n')
  }

  // What the dashboard draws (#562): the in-flight marker if one stands, and
  // the last resolved outcome. Memory-and-two-small-files cheap, so it rides
  // `GET /overview` on every poll.
  status() {
    const marker = this.readMarker()
    let last = null
    let lastError = null
    try {
      last = JSON.parse(fs.readFileSync(this.lastPath, 'utf8'))
    } catch (e) {
      last = null
      if (e.code !== 'ENOENT') lastError = `the last deploy verdict is unreadable: ${e.message}`
    }
    return {
      in_flight: marker && !TERMINAL.has(marker.state) ? marker : null,
      last,
      verdict_read_error: lastError,
    }
  }
}
