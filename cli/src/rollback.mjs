import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT, Refusal } from './exit.mjs'
import { dockerRunner } from './compose.mjs'
import { operatorConfigPath } from './config.mjs'
import { launcherPath } from './launcher.mjs'
import { withLifecycleLock } from './lock.mjs'
import { hostProbes, preflight } from './preflight.mjs'
import { openRoot, versionPaths } from './root.mjs'
import { IncompatibleRelease, isCompleteStage, validateWithRelease } from './stage.mjs'
import { namedSteps } from './steps.mjs'
import { switchRelease } from './switch.mjs'

// `curia rollback` (#885, implementing #854): the switch of `curia update`
// with the versions swapped, from the active release to the one rollback
// release, as four named steps.
//
//   preflight  the root boundary (`openRoot`, which must find an
//              installation) and the host preflight. Nothing changes.
//   select     under the lifecycle lock from here to the end: the rollback
//              release is the one complete release under versions/ that is
//              not the active one. Curia keeps exactly one after a
//              successful switch, so none means there was no update to roll
//              back, and two means a failed update left its staged target
//              beside the rollback release, and the operator says which one
//              goes. Both are refusals; nothing is guessed.
//   validate   the rollback release validates the current operator
//              configuration with its own reader (`validateWithRelease`,
//              the door `curia update` validates through). A configuration
//              the rollback release refuses is the blocking incompatibility
//              the contract names: the rollback is refused, exit `refused`,
//              and the running release is not touched.
//   switch     `switchRelease`, the same door as the update's `switch`
//              step: the core services are recreated from the rollback
//              release's bundle while tmux, ttyd, and the agent containers
//              keep running, every service must be healthy, the service and
//              the app must report the rollback release, and every live
//              session must be adopted back; then the record names the
//              rollback release and the release that was active is kept as
//              the new rollback release. A failure switches back once to
//              the release that was running and leaves the record alone.
//
// `config/`, `secrets/`, `state/`, and `work/` are never read for writing
// here: the record is the one file the rollback changes, and the switch
// changes it only after acceptance.

export const ROLLBACK_STEPS = Object.freeze(['preflight', 'select', 'validate', 'switch'])

// The command's seam. `context` is what `runCli` hands a command. `deps` are
// the boundaries a test replaces: the host probes, the rollback release's
// configuration validator, the Docker runner, the loopback `fetch`, and the
// clock the waits use.
export async function runRollback(
  { env, args = [], stdout, uid, gid, root },
  { hostProbes: host = hostProbes, validateTarget = validateWithRelease, docker = dockerRunner, fetch: fetchImpl = globalThis.fetch, sleep, now } = {},
) {
  const command = [launcherPath(env), 'rollback', ...args].join(' ')
  const steps = namedSteps({ steps: ROLLBACK_STEPS, stdout, rerun: (step) => `Run '${command}' to run ${step} again; the completed steps are kept.` })
  const say = (text) => stdout.write(`${text}\n`)

  try {
    // 1. preflight
    steps.begin('preflight')
    const opened = openRoot(root, { uid })
    if (opened.status !== 'installed') {
      throw new Refusal(`${root} holds no installation, so there is nothing to roll back. Run the bootstrap to install Curia there.`)
    }
    const record = opened.record
    const active = record.activeVersion
    const hostReport = await preflight({ uid, root, stdout }, host)
    if (!hostReport.ok) throw hostReport.refusal
    const dockerGid = hostReport.facts.docker.group.gid

    return await withLifecycleLock(root, async () => {
      // 2. select
      steps.begin('select')
      const { version: previous, candidates } = rollbackRelease(root, active)
      if (previous === null) {
        if (candidates.length === 0) {
          throw new Refusal(`versions/ holds no release beside the active one, ${active}, so there is nothing to roll back to. Curia keeps the release you updated from after a successful 'curia update', and only that one.`)
        }
        throw new Refusal(`versions/ holds ${candidates.length === 2 ? 'two' : candidates.length} releases beside the active one, ${active}: ${candidates.join(' and ')}. One of them is the release you updated from and the other is the staged target of an update that did not switch. Finish the update with 'curia update', or remove the staged release you don't want from ${join(root, 'versions')}, then run 'curia rollback' again.`)
      }
      say(`rolling back from ${active} to ${previous}`)

      // 3. validate
      steps.begin('validate')
      try {
        await validateTarget({ root, version: previous, dir: versionPaths(root, previous).dir })
      } catch (e) {
        if (!(e instanceof IncompatibleRelease)) throw e
        const action = e.reason === 'configuration'
          ? `Fix the file so that both releases accept it, or stay on ${active}.`
          : `${previous} is older than the operator configuration contract, so Curia cannot prove it reads this installation.`
        throw new Refusal(`${e.message} ${action} The active version is unchanged.`)
      }
      say(`${previous} accepts the current operator configuration at ${operatorConfigPath(root)}`)

      // 4. switch
      steps.begin('switch')
      await switchRelease(
        { root, from: active, to: previous, record, environment: { uid, gid, dockerGid, installationId: record.installationId }, stdout },
        { docker, fetch: fetchImpl, sleep, now },
      )
      say('')
      say(`Curia ${previous} is running. Open the Curia app as before; nothing in integration setup has to be repeated.`)
      say(`${active} is now the rollback release: 'curia rollback' switches forward to it, and 'curia update' replaces it.`)
      return EXIT.ok
    })
  } catch (e) {
    throw steps.wrap(e)
  }
}

// The rollback release under `root`: the one complete release under
// versions/ that is not `active`. Returns `{ version, candidates }`, with
// `version` null when there is none or more than one. A dot directory is a
// staging leftover and never a candidate; an incomplete directory is not one
// either (the switch removes both).
export function rollbackRelease(root, active, { complete = isCompleteStage } = {}) {
  const candidates = readdirSync(join(root, 'versions'))
    .filter((name) => !name.startsWith('.') && name !== active && complete(join(root, 'versions', name)))
    .sort()
  return { version: candidates.length === 1 ? candidates[0] : null, candidates }
}

// Used by the command table.
export function rollbackCommand(context, deps) {
  return runRollback(context, deps)
}
