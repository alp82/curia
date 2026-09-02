import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { EXIT, Refusal, UsageError } from './exit.mjs'
import { acquireProbes, acquireRelease } from './acquire.mjs'
import { operatorConfigPath } from './config.mjs'
import { launcherPath } from './launcher.mjs'
import { withLifecycleLock } from './lock.mjs'
import { releaseProbes } from './manifest.mjs'
import { hostProbes, preflight } from './preflight.mjs'
import { openRoot, versionPaths } from './root.mjs'
import { StableIndexError, fetchStableIndex, pinnedPublicKey, releaseNotesUrl, renderSelection, selectRelease, selectionFromArgs, stableProbes } from './stable.mjs'
import { isCompleteStage, placeVersion, verifyRetained } from './stage.mjs'
import { switchRelease } from './switch.mjs'
import { dockerRunner } from './compose.mjs'

// `curia update` (#883, implementing #854): from the signed stable-release
// index to a verified, validated target release staged beside the active
// one, as one linear sequence of named steps.
//
//   preflight  the root boundary (`openRoot`, which must find an installation)
//              and the host preflight. Nothing on disk changes.
//   select     the stable-release index is downloaded and proven against the
//              pinned key, and one version is selected from it: the stable
//              release by default, an exact version when asked, an exact
//              prerelease only with `--prerelease`. A withdrawn version is
//              never selected. When the selected version is the active one,
//              there is nothing to do and the command stops here, ok.
//   acquire    under the lifecycle lock from here to the end: every artifact
//              of the target (package, pinned runtime, bundle, checksum,
//              manifest) is downloaded into cache/update/ and proven, the
//              bootstrap's own steps in this package's code (acquire.mjs). A
//              target already complete under versions/<target>/ is verified
//              and reused instead, so a rerun downloads nothing.
//   stage      the target passes the release door (`verifyStagedRelease`)
//              and lands read-only as versions/<target>/ through one rename,
//              beside the active version, which does not change.
//   validate   the target release validates the current operator
//              configuration with its own reader (`readOperatorConfig` of
//              the staged package), so a configuration the target refuses
//              stops the update before anything switches.
//   switch     the core services (service, app, overseer) are recreated
//              from the target's bundle while tmux, ttyd, and the live agent
//              containers keep running; every service reports healthy, the
//              service and the app report the target version, and the live
//              sessions are re-adopted; then the record names the target
//              and the release that was active is kept as the one rollback
//              release, every other version removed. A failure switches
//              the core services back once and leaves the record alone.
//              The sequence is `switchRelease` in switch.mjs, which `curia
//              rollback` shares.
//
// Discovery is the same `fetchStableIndex` and `selectRelease` the service's
// daily check and the Curia app use. A failed discovery refuses before the
// lock, so it never touches the running installation. The command never
// rewrites the launcher: it reads the record, and the record is what the
// switch writes.

export const UPDATE_STEPS = Object.freeze(['preflight', 'select', 'acquire', 'stage', 'validate', 'switch'])

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// The command's seam. `context` is what `runCli` hands a command. `deps` are
// the boundaries a test replaces: the host probes, the stable-index probe
// and the pinned key, the acquisition probes, the release probes, the
// target's configuration validator, the Docker runner, the loopback `fetch`,
// and the clock the waits use.
export async function runUpdate(
  { env, args = [], stdout, uid, gid, root },
  { hostProbes: host = hostProbes, stableProbes: stable = stableProbes, publicKey = pinnedPublicKey(), acquireProbes: acquire = acquireProbes, releaseProbes: release = releaseProbes, validateTarget = validateWithTarget, docker = dockerRunner, fetch: fetchImpl = globalThis.fetch, sleep, now } = {},
) {
  let selection
  try {
    selection = selectionFromArgs(args)
  } catch (e) {
    if (e instanceof StableIndexError) throw new UsageError(e.message)
    throw e
  }
  const launcher = launcherPath(env)
  const steps = sequence({ stdout, launcher, args })
  const say = (text) => stdout.write(`${text}\n`)

  try {
    // 1. preflight
    steps.begin('preflight')
    const opened = openRoot(root, { uid })
    if (opened.status !== 'installed') {
      throw new Refusal(`${root} holds no installation, so there is nothing to update. Run the bootstrap to install Curia there.`)
    }
    const record = opened.record
    const active = record.activeVersion
    const hostReport = await preflight({ uid, root, stdout }, host)
    if (!hostReport.ok) throw hostReport.refusal
    const dockerGid = hostReport.facts.docker.group.gid

    // 2. select
    steps.begin('select')
    const fetched = await fetchStableIndex({ stdout, publicKey }, stable)
    if (!fetched.ok) throw new Refusal(`${fetched.error} The running installation is not affected.`)
    const { index } = fetched
    if (index.withdrawn.includes(active)) {
      say(`warning: the active version ${active} is withdrawn. The release notes at ${releaseNotesUrl(active)} say why.`)
    }
    const { version: target, selection: how } = selectRelease(index, selection)
    stdout.write(renderSelection({ version: target, selection: how }))
    if (target === active) {
      say(`${active} is the active version. Nothing to update.`)
      return EXIT.ok
    }
    say(`updating ${active} to ${target} (release notes: ${releaseNotesUrl(target)})`)

    return await withLifecycleLock(root, async () => {
      // 3. acquire
      steps.begin('acquire')
      const paths = versionPaths(root, target)
      let stage = null
      if (isCompleteStage(paths.dir)) {
        say(`${target} is already staged under ${paths.dir}; verifying the retained artifacts`)
        await verifyRetained({ version: target, dir: paths.dir, stdout }, release)
      } else {
        stage = join(root, 'cache', 'update', `${target}.${process.pid}`)
        rmSync(stage, { recursive: true, force: true })
        mkdirSync(stage, { recursive: true, mode: 0o700 })
        try {
          await acquireRelease({ version: target, stage, stdout }, acquire)
        } catch (e) {
          rmSync(stage, { recursive: true, force: true })
          throw e
        }
      }

      // 4. stage
      steps.begin('stage')
      if (stage) {
        try {
          await placeVersion({ root, version: target, stage, stdout }, release)
        } finally {
          rmSync(stage, { recursive: true, force: true })
        }
      } else {
        say(`${target} is staged under ${paths.dir}`)
      }

      // 5. validate
      steps.begin('validate')
      await validateTarget({ root, version: target, dir: paths.dir })
      say(`${target} accepts the current operator configuration at ${operatorConfigPath(root)}`)

      // 6. switch
      steps.begin('switch')
      await switchRelease(
        { root, from: active, to: target, record, environment: { uid, gid, dockerGid, installationId: record.installationId }, stdout },
        { docker, fetch: fetchImpl, sleep, now },
      )
      say('')
      say(`Curia ${target} is running. Open the Curia app as before; nothing in integration setup has to be repeated.`)
      say(`If ${target} misbehaves, 'curia rollback' switches back to ${active}.`)
      return EXIT.ok
    })
  } catch (e) {
    throw steps.wrap(e)
  }
}

// The target validates the current operator configuration with its own
// reader: the staged package's `src/config.mjs`, imported from
// versions/<target>/. A target that refuses the file fails the update here,
// with the contract's own sentence; a target that carries no reader cannot
// validate and fails too. Nothing is written.
async function validateWithTarget({ root, version, dir }) {
  const reader = join(dir, 'cli', 'src', 'config.mjs')
  if (!existsSync(reader)) {
    throw new Error(`${version} carries no operator configuration reader (cli/src/config.mjs), so it cannot validate the current configuration. Choose a version that does.`)
  }
  const target = await import(pathToFileURL(reader).href)
  if (typeof target.readOperatorConfig !== 'function') {
    throw new Error(`${version}'s configuration reader has no readOperatorConfig, so it cannot validate the current configuration. Choose a version that does.`)
  }
  try {
    target.readOperatorConfig(operatorConfigPath(root))
  } catch (e) {
    if (e?.name !== 'ConfigError') throw e
    throw new Error(`${version} refuses the current operator configuration: ${e.message}. Fix the file, or choose another version. The active version is unchanged.`)
  }
}

// The step sequence: prints each header, remembers the current step, and
// turns an error into one that names the step and the command that reruns
// it.
function sequence({ stdout, launcher, args }) {
  let current = null
  const command = [launcher, 'update', ...args].join(' ')
  return {
    begin(name) {
      current = name
      stdout.write(`[${UPDATE_STEPS.indexOf(name) + 1}/${UPDATE_STEPS.length}] ${name}\n`)
    },
    wrap(e) {
      if (current === null) return e
      if (e instanceof Refusal) return new Refusal(`${current}: ${e.message}`)
      const wrapped = new Error(`${current} failed: ${e.message}\nRun '${command}' to run ${current} again; the completed steps are kept.`)
      wrapped.cause = e
      return wrapped
    },
  }
}

// Used by the command table.
export function updateCommand(context, deps) {
  return runUpdate(context, deps)
}
