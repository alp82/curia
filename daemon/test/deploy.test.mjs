// The self-deploy verb (#270). The daemon's half is fully mockable — exec and
// the docker socket are injected — so these tests pin the preflight refusals,
// the hand-off argv, the marker contract, and the boot-time resolution. The
// sibling script cannot run here (it needs compose and a box), so its test is
// the same kind attach.test.mjs uses on the ttyd argv: pin the text to the
// deploy rule.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SelfDeploy, helperRunArgs } from '../src/deploy.mjs'
import { parseCommand } from '../src/commands.mjs'
import { expandCommand } from '../src/bridge.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(DIR, '..', '..', 'deploy', 'self-deploy.sh')

const PREV = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)

function fakeStore() {
  const events = []
  return { events, journal: (type, data) => events.push({ type, ...data }) }
}

// A git/docker double: answers rev-parse from `shas`, throws where the
// scenario says so, and records every docker invocation. `dirty` is what
// `git status --porcelain` prints — the clean tree is the empty string.
function fakeExec({ head = PREV, origin = NEXT, ffOk = true, dockerError = null, dirty = '', untracked = '', added = '', blobIds = {}, ghAuthOk = true } = {}) {
  const docker = []
  const git = []
  const gh = []
  const exec = async (file, args, options = {}) => {
    if (file === 'gh') {
      gh.push({ args, options })
      if (!ghAuthOk) throw new Error('not logged into any GitHub hosts')
      return { stdout: '' }
    }
    if (file === 'git') {
      git.push(args)
      const verb = args[0]
      if (verb === 'status') return { stdout: dirty }
      if (verb === 'checkout') return { stdout: '' }
      if (verb === 'fetch') return { stdout: '' }
      if (verb === 'rev-parse') {
        if (args[1].includes(':')) {
          const f = args[1].split(':').slice(1).join(':')
          return { stdout: `${blobIds[f]?.incoming ?? 'incoming-blob'}\n` }
        }
        return { stdout: `${args[1] === 'HEAD' ? head : origin}\n` }
      }
      if (verb === 'ls-files') return { stdout: untracked }
      if (verb === 'diff') return { stdout: added }
      if (verb === 'hash-object') {
        const f = args.at(-1)
        return { stdout: `${blobIds[f]?.local ?? 'local-blob'}\n` }
      }
      if (verb === 'merge-base') {
        if (!ffOk) throw new Error('exit 1')
        return { stdout: '' }
      }
    }
    if (file === 'docker') {
      docker.push(args)
      if (dockerError) throw new Error(dockerError)
      return { stdout: 'containerid\n' }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
  }
  return { exec, docker, git, gh }
}

function build(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-deploy-'))
  // any stat-able file works as the socket double — only its gid is read
  const sock = path.join(dataDir, 'docker.sock')
  fs.writeFileSync(sock, '')
  const reduction = fakeStore()
  const { exec, docker, git, gh } = fakeExec(opts)
  const deploy = new SelfDeploy({
    repoRoot: opts.repoRoot ?? '/home/alp/curia', dataDir, workRoot: '/home/alp/curia-work', reduction, exec,
    log: () => {}, port: 4271, home: '/home/alp/curia-work/home',
    parkOverseerPanes: opts.parkOverseerPanes,
    env: {
      PATH: '/usr/bin', GH_TOKEN: 'minted', GITHUB_TOKEN: 'fallback',
      GH_CONFIG_DIR: '/wrong/gh', XDG_CONFIG_HOME: '/wrong/xdg',
    },
    dockerSocket: sock,
  })
  return { deploy, reduction, docker, git, gh, dataDir }
}

describe('parse and expansion', () => {
  test('deploy parses bare and refuses arguments', () => {
    assert.deepEqual(parseCommand('deploy'), { verb: 'deploy' })
    assert.equal(parseCommand('deploy now'), null)
  })

  test('the slash verb expands to the bare canonical text', () => {
    const i = { commandName: 'deploy', options: { getString: () => null } }
    assert.equal(expandCommand(i), 'deploy')
  })
})

describe('the daemon half: preflight and hand-off', () => {
  test('the preflight checks the active host login from curia home', async () => {
    const { deploy, gh, docker } = build()
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /deploy handed off/)
    assert.equal(gh.length, 1)
    assert.deepEqual(gh[0].args, ['auth', 'status', '--hostname', 'github.com', '--active'])
    assert.equal(gh[0].options.env.HOME, '/home/alp/curia-work/home')
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
      assert.equal(Object.hasOwn(gh[0].options.env, key), false, key)
    }
    assert.equal(docker.length, 1)
  })

  test('a missing or invalid host login refuses the deploy before git runs', async () => {
    const { deploy, git, docker } = build({ ghAuthOk: false })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /deploy refused: gh could not verify curia's GitHub login/)
    assert.match(reply, /HOME=\/home\/alp\/curia-work\/home gh auth status/)
    assert.equal(git.length, 0)
    assert.equal(docker.length, 0)
    assert.equal(deploy.readMarker(), null)
  })

  test('an up-to-date checkout deploys nothing', async () => {
    const { deploy, reduction, docker } = build({ head: PREV, origin: PREV })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /already at a{7}/)
    assert.equal(docker.length, 0)
    assert.equal(reduction.events.length, 0)
    assert.equal(deploy.readMarker(), null)
  })

  // #292: the box's config files are tracked, so a hand edit to one of them
  // used to reach the sibling's `git merge --ff-only`, which refuses it — and
  // the sibling reads that as a failed deploy and rolls back over the edit.
  test('a dirty tracked file is refused by name, before anything is ordered', async () => {
    const { deploy, reduction, docker } = build({ dirty: ' M config/curia.yaml\n M daemon/src/index.mjs\n' })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /uncommitted changes to config\/curia\.yaml, daemon\/src\/index\.mjs/)
    // and it says where a settings save actually goes, so the operator does not
    // read this refusal as the dashboard's doing
    assert.match(reply, /config\/\*\.local\.yaml/)
    assert.equal(docker.length, 0)
    assert.equal(reduction.events.length, 0)
    assert.equal(deploy.readMarker(), null)
  })

  // The start-time `npm install` runs against the repo mount, and an npm
  // version drift rewrites package-lock.json (deploy/daemon/Dockerfile). The
  // daemon wrote that diff, so the preflight discards it and deploys — no ssh.
  test('unstaged lockfile churn with a clean package.json is discarded, and the deploy proceeds', async () => {
    const { deploy, reduction, docker, git } = build({ dirty: ' M daemon/package-lock.json\n' })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /discarded npm lockfile churn in daemon\/package-lock\.json/)
    assert.match(reply, /deploy handed off/)
    assert.deepEqual(git.find((args) => args[0] === 'checkout'), ['checkout', '--', 'daemon/package-lock.json'])
    assert.equal(reduction.events[0].type, 'deploy_lockfile_churn_discarded')
    assert.deepEqual(reduction.events[0].files, ['daemon/package-lock.json'])
    assert.equal(docker.length, 1)
  })

  // A lockfile that moved with its package.json is a dependency edit, not
  // churn — and a staged lockfile was put there by a hand. Both keep the
  // refusal.
  test('a lockfile is not discarded when package.json is dirty or when it is staged', async () => {
    for (const dirty of [' M daemon/package.json\n M daemon/package-lock.json\n', 'M  daemon/package-lock.json\n']) {
      const { deploy, docker, git } = build({ dirty })
      const reply = await deploy.run({ by: 'u1' })
      assert.match(reply, /uncommitted changes/)
      assert.equal(git.find((args) => args[0] === 'checkout'), undefined)
      assert.equal(docker.length, 0)
    }
  })

  test('the check asks about tracked files only', async () => {
    // The dashboard's own override files are untracked by design (#292), so a
    // check that counted them would refuse every deploy on a box that has ever
    // saved from the settings screen.
    const { deploy, git, docker } = build()
    await deploy.run({ by: 'u1' })
    const status = git.find((args) => args[0] === 'status')
    assert.ok(status.includes('--untracked-files=no'), status.join(' '))
    assert.equal(docker.length, 1)
  })

  test('a diverged checkout is refused, not force-pushed over', async () => {
    const { deploy, docker } = build({ ffOk: false })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /commits origin\/main does not/)
    assert.equal(docker.length, 0)
  })

  // #562: the 4897a82 rollout. A live check left untracked files on the box at
  // paths a later commit added as tracked, the sibling's merge refused them,
  // and the rollback announced a health-check failure that never happened.
  // The preflight catches the collision now, on the churn rule: identical
  // bytes are curia's to discard, different bytes are somebody's work.
  test('an untracked file identical to what the deploy adds is removed, and the deploy proceeds', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-repo-'))
    fs.mkdirSync(path.join(repoRoot, 'docs'))
    fs.writeFileSync(path.join(repoRoot, 'docs/check.sh'), 'same bytes\n')
    const { deploy, reduction, docker, git } = build({
      repoRoot,
      untracked: 'docs/check.sh\n',
      added: 'docs/check.sh\nsome/other-new-file.mjs\n',
      blobIds: { 'docs/check.sh': { incoming: 'same-blob', local: 'same-blob' } },
    })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /removed untracked docs\/check\.sh/)
    assert.match(reply, /deploy handed off/)
    assert.equal(fs.existsSync(path.join(repoRoot, 'docs/check.sh')), false)
    assert.equal(reduction.events[0].type, 'deploy_untracked_dup_discarded')
    assert.deepEqual(reduction.events[0].files, ['docs/check.sh'])
    assert.equal(deployGitComparesBlobIds(git), true)
    assert.equal(docker.length, 1)
  })

  test('an untracked file that DIFFERS from what the deploy adds is refused by name', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-repo-'))
    fs.mkdirSync(path.join(repoRoot, 'docs'))
    fs.writeFileSync(path.join(repoRoot, 'docs/check.sh'), 'the box edition\n')
    const { deploy, reduction, docker } = build({
      repoRoot,
      untracked: 'docs/check.sh\n',
      added: 'docs/check.sh\n',
      blobIds: { 'docs/check.sh': { incoming: 'incoming-blob', local: 'local-blob' } },
    })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /untracked files that b{7} adds as tracked, with DIFFERENT content: docs\/check\.sh/)
    assert.equal(fs.existsSync(path.join(repoRoot, 'docs/check.sh')), true)
    assert.equal(docker.length, 0)
    assert.equal(reduction.events.length, 0)
    assert.equal(deploy.readMarker(), null)
  })

  test('different invalid UTF-8 bytes are not discarded as an identical copy', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-repo-'))
    fs.mkdirSync(path.join(repoRoot, 'docs'))
    fs.writeFileSync(path.join(repoRoot, 'docs/check.bin'), Buffer.from([0x80]))
    const { deploy, docker } = build({
      repoRoot,
      untracked: 'docs/check.bin\n',
      added: 'docs/check.bin\n',
      blobIds: { 'docs/check.bin': { incoming: 'incoming-blob', local: 'local-blob' } },
    })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /DIFFERENT content: docs\/check\.bin/)
    assert.deepEqual(fs.readFileSync(path.join(repoRoot, 'docs/check.bin')), Buffer.from([0x80]))
    assert.equal(docker.length, 0)
  })

  test('an untracked file the deploy does not touch stays none of its business', async () => {
    const { deploy, docker } = build({ untracked: 'config/curia.local.yaml\n', added: 'daemon/src/new.mjs\n' })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /deploy handed off/)
    assert.equal(docker.length, 1)
  })

  test('an interpreted deploy is refused — no confirm exists for it', async () => {
    const { deploy, docker } = build()
    const reply = await deploy.run({ by: 'overseer', interpreted: true })
    assert.match(reply, /typed-only/)
    assert.equal(docker.length, 0)
  })

  test('the hand-off writes the marker, journals, and starts the sibling', async () => {
    const { deploy, reduction, docker } = build()
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /deploy handed off: a{7} → b{7}/)
    const marker = deploy.readMarker()
    assert.equal(marker.state, 'handed-off')
    assert.equal(marker.prev, PREV)
    assert.equal(marker.next, NEXT)
    assert.deepEqual(reduction.events, [{ type: 'deploy_requested', by: 'u1', prev: PREV, next: NEXT }])
    assert.equal(docker.length, 1)
    const args = docker[0]
    // detached, auto-removed, and named — the name is the concurrency guard
    for (const flag of ['-d', '--rm']) assert.ok(args.includes(flag), flag)
    assert.equal(args[args.indexOf('--name') + 1], 'curia-deploy')
    // host network, or the health check cannot see the daemon's loopback port
    assert.equal(args[args.indexOf('--network') + 1], 'host')
    assert.ok(args.includes('curia-daemon'))
    // the script runs from a container-local copy: the sibling's own merge
    // rewrites the checkout copy mid-run
    assert.ok(args.some((a) => a.includes('cp /home/alp/curia/deploy/self-deploy.sh /tmp/')))
    // script argv: prev next repoRoot markerFile logFile port workRoot
    assert.deepEqual(args.slice(-7), [PREV, NEXT, '/home/alp/curia', deploy.markerPath, deploy.logPath, '4271', '/home/alp/curia-work'])
  })

  test('the hand-off parks overseer panes before compose recreates their container', async () => {
    const calls = []
    const { deploy, docker } = build({ parkOverseerPanes: async () => calls.push('parked') })

    const reply = await deploy.run({ by: 'u1' })

    assert.match(reply, /deploy handed off/)
    assert.deepEqual(calls, ['parked'])
    assert.equal(docker.length, 1)
  })

  test('a second deploy while one is in flight is refused by the marker', async () => {
    const { deploy, docker } = build()
    await deploy.run({ by: 'u1' })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /already in flight/)
    assert.equal(docker.length, 1)
  })

  test('a name conflict on the sibling reads as in-flight and clears the marker', async () => {
    const { deploy } = build({ dockerError: 'Conflict. The container name "/curia-deploy" is already in use' })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /already in flight/)
    // the order never left, so the next attempt must not be refused
    assert.equal(deploy.readMarker(), null)
  })
})

describe('the surviving daemon half: resolution', () => {
  const resolve = (deploy, { sleep } = {}) => {
    const said = []
    const p = deploy.resolvePending({
      announce: async (text) => said.push(text),
      pollMs: 1, timeoutMs: 20,
      sleep: sleep ?? (() => Promise.resolve()),
    })
    return { said, p }
  }
  const writeMarker = (deploy, state, extra = {}) =>
    fs.writeFileSync(deploy.markerPath, JSON.stringify({ state, prev: PREV, next: NEXT, ...extra }))

  test('no marker means no deploy to resolve', async () => {
    const { deploy } = build()
    assert.equal(await deploy.resolvePending({ announce: async () => {} }), null)
  })

  test('landed: journalled, announced, marker cleared', async () => {
    const { deploy, reduction } = build()
    writeMarker(deploy, 'landed')
    const { said, p } = resolve(deploy)
    assert.equal(await p, 'landed')
    assert.deepEqual(reduction.events, [{ type: 'deploy_landed', prev: PREV, next: NEXT }])
    assert.match(said[0], /deploy landed/)
    assert.equal(deploy.readMarker(), null)
  })

  test('the poll waits out a sibling still working', async () => {
    const { deploy, reduction } = build()
    writeMarker(deploy, 'rolling-back')
    let polls = 0
    const { said, p } = resolve(deploy, {
      sleep: async () => {
        if (++polls === 2) writeMarker(deploy, 'rolled-back', { reason: 'health check failed' })
      },
    })
    assert.equal(await p, 'rolled-back')
    assert.equal(reduction.events[0].type, 'deploy_rolled_back')
    assert.equal(reduction.events[0].reason, 'health check failed')
    assert.match(said[0], /ROLLED BACK/)
  })

  // #562: a refused merge recreated nothing, so the announcement must not read
  // like a rollback — and the running daemon is the one that says it.
  test('merge-refused: announced as a refusal, never as a failed health check', async () => {
    const { deploy, reduction } = build()
    writeMarker(deploy, 'merge-refused', { reason: 'git merge --ff-only refused the fast-forward' })
    const { said, p } = resolve(deploy)
    assert.equal(await p, 'merge-refused')
    assert.equal(reduction.events[0].type, 'deploy_merge_refused')
    assert.match(said[0], /deploy refused/)
    assert.match(said[0], /nothing was recreated/)
    assert.doesNotMatch(said[0], /health check/)
    assert.equal(deploy.readMarker(), null)
  })

  test('a rollback announces the sibling\'s own reason', async () => {
    const { deploy } = build()
    writeMarker(deploy, 'rolled-back', { reason: 'docker compose could not recreate the services' })
    const { said, p } = resolve(deploy)
    assert.equal(await p, 'rolled-back')
    assert.match(said[0], /docker compose could not recreate the services/)
  })

  // The dashboard's record (#562): the marker dies with the announcement, so
  // the outcome is persisted where GET /overview can keep serving it.
  test('every resolution writes deploy-last.json, and status() serves it', async () => {
    const { deploy } = build()
    writeMarker(deploy, 'rolled-back', { reason: 'the new daemon failed its health check', by: 'u1' })
    const { p } = resolve(deploy)
    await p
    const last = JSON.parse(fs.readFileSync(deploy.lastPath, 'utf8'))
    assert.equal(last.state, 'rolled-back')
    assert.equal(last.prev, PREV)
    assert.equal(last.reason, 'the new daemon failed its health check')
    assert.ok(last.resolved_at)
    const status = deploy.status()
    assert.equal(status.in_flight, null)
    assert.equal(status.last.state, 'rolled-back')
  })

  test('status() carries a non-terminal marker as in-flight', async () => {
    const { deploy } = build()
    writeMarker(deploy, 'deploying')
    assert.equal(deploy.status().in_flight.state, 'deploying')
  })

  test('status() names an unreadable last verdict', () => {
    const { deploy } = build()
    fs.writeFileSync(deploy.lastPath, '{not json')
    const status = deploy.status()
    assert.equal(status.last, null)
    assert.match(status.verdict_read_error, /last deploy verdict is unreadable/)
  })

  // The excerpt keeps the sibling's narration and the error lines, and drops
  // the docker build noise between them.
  test('logExcerpt reads the last attempt and keeps only the story', () => {
    const { deploy } = build()
    fs.writeFileSync(deploy.logPath, [
      '[self-deploy 2026-08-18T00:00:00Z] deploy 1111111 -> 2222222',
      '[self-deploy 2026-08-18T00:01:00Z] landed 2222222',
      '[self-deploy 2026-08-19T19:20:09Z] deploy aaaaaaa -> bbbbbbb',
      'error: The following untracked working tree files would be overwritten by merge:',
      '\tdocs/live-checks/461-rollout-copy.sh',
      'Please move or remove them before you merge.',
      "validating compose.yaml: services.daemon additional properties 'bogus' not allowed",
      'unable to prepare context: path "/missing" not found',
      '#30 [daemon stage-3 8/9] RUN mkdir -p /run/curia-tmux',
      '#30 CACHED',
      `#31 ${'build noise '.repeat(7_000)}`,
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      'curl: (7) Failed to connect to 127.0.0.1 port 4271',
      '[self-deploy 2026-08-19T19:21:00Z] rolled back to aaaaaaa',
    ].join('\n'))
    const out = deploy.logExcerpt()
    assert.match(out, /deploy aaaaaaa -> bbbbbbb/)
    assert.match(out, /would be overwritten/)
    assert.match(out, /461-rollout-copy\.sh/)
    assert.match(out, /additional properties 'bogus' not allowed/)
    assert.match(out, /unable to prepare context/)
    assert.match(out, /Cannot connect to the Docker daemon/)
    assert.match(out, /curl: \(7\)/)
    assert.doesNotMatch(out, /stage-3/)
    assert.doesNotMatch(out, /landed 2222222/)
  })

  test('a sibling that never answers resolves as unknown', async () => {
    const { deploy, reduction } = build()
    writeMarker(deploy, 'handed-off')
    const { said, p } = resolve(deploy)
    assert.equal(await p, 'handed-off')
    assert.equal(reduction.events[0].type, 'deploy_unresolved')
    assert.match(said[0], /outcome unknown/)
    assert.equal(deploy.readMarker(), null)
  })
})

function deployGitComparesBlobIds(git) {
  return git.some((args) => args[0] === 'hash-object')
    && git.some((args) => args[0] === 'rev-parse' && args[1].includes(':'))
    && !git.some((args) => args[0] === 'show')
}

describe('the sibling script holds the deploy rule', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8')
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

  test('every compose up names its targets, forced, with --no-deps', () => {
    const ups = code.split('\n').filter((l) => /compose .*up/.test(l))
    assert.ok(ups.length >= 1)
    // --force-recreate: a code-only deploy changes no image layer, and
    // without it compose leaves the old daemon running (the #270 drill
    // caught exactly that)
    // #327 added the overseer: recreating it kills no agent, and ADR-0015 makes
    // the routine deploy name all three.
    for (const l of ups) assert.match(l, /up -d --build --force-recreate --no-deps daemon dashboard overseer$/)
  })

  // alp82/curia#474: dockerd creates a missing bind-mount source as root:root,
  // and the overseer (uid 1000) then cannot write its own trees. The sibling
  // creates both sources before every compose up — the rollback one included.
  test('the overseer bind-mount sources are created before every compose up', () => {
    const lines = code.split('\n')
    const mkdir = lines.findIndex((l) => /mkdir -p "\$WORK\/cfg\/curia-overseer" "\$WORK\/overseer\/repos"/.test(l))
    const up = lines.findIndex((l) => /compose .*up/.test(l))
    assert.ok(mkdir !== -1, 'the pre-create line is missing')
    assert.ok(mkdir < up, 'the pre-create must run before the compose up')
  })

  test('the script never touches tmux or ttyd', () => {
    assert.doesNotMatch(code, /tmux|ttyd/)
  })

  test('both failure paths return to the previous ref', () => {
    assert.match(code, /git -C "\$REPO" reset --hard "\$PREV"/)
    assert.match(code, /mark lockout/)
  })

  // #562: a refused merge changed nothing, so it must exit before any compose
  // up — the old rollback-recreate restarted a daemon nothing was wrong with —
  // and it must write its own marker state, not read as a failed health check.
  test('a refused merge marks merge-refused and exits before any recreate', () => {
    const lines = code.split('\n')
    const refuse = lines.findIndex((l) => /mark merge-refused/.test(l))
    const firstCall = lines.findIndex((l) => /^\s*if recreate\b/.test(l))
    assert.ok(refuse !== -1, 'the merge-refused marker is missing')
    assert.ok(firstCall !== -1 && refuse < firstCall, 'merge-refused must be marked before the first recreate call')
  })

  test('each rollback carries the reason the sibling measured', () => {
    assert.match(code, /REASON="the new daemon failed its health check"/)
    assert.match(code, /REASON="docker compose could not recreate the services"/)
    assert.match(code, /mark rolled-back "\$REASON"/)
  })
})

describe('helperRunArgs', () => {
  test('mounts what the sibling needs and nothing writable it does not', () => {
    const args = helperRunArgs({ repoRoot: '/r', dataDir: '/r/daemon/data', home: '/w/home', uid: 1000, gid: 998, workRoot: '/w' })
    const mounts = args.filter((a, i) => args[i - 1] === '-v')
    assert.deepEqual(mounts, [
      '/var/run/docker.sock:/var/run/docker.sock',
      '/r:/r',
      '/r/daemon/data:/r/daemon/data',
      '/w:/w',
    ])
    assert.equal(args[args.indexOf('--group-add') + 1], '998')
  })

  // #473: the sibling used to take two mounts out of the operator's home for
  // the `gh` auth and the git identity. HOME is inside the workspace now, so
  // the tree it already mounts carries both, and no mount here names a home.
  test('it reaches the gh auth and the git identity through the workspace mount', () => {
    const args = helperRunArgs({ repoRoot: '/r', dataDir: '/r/daemon/data', home: '/w/home', uid: 1000, gid: 998, workRoot: '/w' })
    assert.equal(args[args.indexOf('-e') + 1], 'HOME=/w/home')
    const mounts = args.filter((a, i) => args[i - 1] === '-v')
    assert.ok(mounts.some((m) => m.startsWith('/w:')), 'the workspace mount is what carries HOME')
    for (const m of mounts) {
      assert.ok(!m.includes('/.config/gh'), `${m} takes the auth out of a home directory`)
      assert.ok(!m.includes('/.gitconfig'), `${m} takes the git identity out of a home directory`)
    }
  })
})
