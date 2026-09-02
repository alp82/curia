import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { EXIT, Refusal, UsageError } from './exit.mjs'
import { dockerRunner } from './compose.mjs'
import { launcherPath } from './launcher.mjs'
import { withLifecycleLock } from './lock.mjs'
import { removeInstallationResources, removeReleaseImages } from './resources.mjs'
import { openRoot, recordPath } from './root.mjs'
import { namedSteps } from './steps.mjs'
import { readTailscaleRecord, tailscaleRunner, withdrawServeRoutes } from './tailscale.mjs'
import { externalChecklist, purgeCommand } from './uninstall.mjs'

// `curia purge` (#887, implementing #855): the confirmed purge. It removes
// every local trace of one installation after one explicit confirmation, as
// six named steps.
//
//   preflight  the root boundary (`openRoot`, which must find an
//              installation), then the warning: the exact root and what
//              goes with it. Nothing changes.
//   confirm    the one confirmation. On a terminal the operator types the
//              exact installation root; without one, `--confirm <root>` on
//              the command line says the same thing. Anything else stops the
//              command with nothing changed. There is no second question, no
//              scan for unpublished work, and no salvage.
//   docker     under the lifecycle lock from here to the end: every
//              container, network, and volume that carries this
//              installation's label, the same teardown as uninstall.
//   routes     the Tailscale Serve routes Curia created, the same as uninstall.
//   images     the release images nothing on the host uses any more, the
//              agent image among them (#891). Found by their five exact
//              repositories, never by a name prefix, and removed only when
//              Docker lists no container over them and accepts the removal
//              without force. An image another installation runs stays.
//   root       the launcher when it names this root, then the installation
//              root itself, last, with the installation record as the last
//              file inside it, so a rerun over a half-removed root still
//              finds the installation.
//
// The installation ID and the external identifiers are read before anything
// is removed, because the files that hold them go with the root. Every step
// reads before it removes, so a rerun over a partial purge finishes it. The
// bootstrap's `--purge` runs this command from a temporary stage with
// `CURIA_ROOT` only: no launcher, no stage, and possibly a root whose `run/`
// is already gone, so the lock's directory is created when it is missing.

export const PURGE_STEPS = Object.freeze(['preflight', 'confirm', 'docker', 'routes', 'images', 'root'])

export const CONFIRM_OPTION = '--confirm'
const PROMPT = 'Type the installation root to confirm, or anything else to stop: '

// The command's seam. `context` is what `runCli` hands a command. `deps` are
// the boundaries a test replaces: the Docker runner, the `tailscale` runner,
// the question on the terminal, and whether there is a terminal to ask on.
export async function runPurge(
  { env, args = [], stdout, uid, root },
  { docker = dockerRunner, tailscale = tailscaleRunner, prompt = askOnTerminal, isTerminal = () => Boolean(process.stdin.isTTY) } = {},
) {
  const confirmed = confirmationFromArgs(args)
  const launcher = launcherPath(env)
  const bootstrap = purgeCommand({ env, root })
  const steps = namedSteps({
    steps: PURGE_STEPS,
    stdout,
    rerun: (step) => (existsSync(launcher)
      ? `Run '${launcher} purge' to run ${step} again; the completed steps are kept.`
      : `Fix the cause, then run 'curia purge' again from the bootstrap (${bootstrap}); the completed steps are kept.`),
  })
  const say = (text) => stdout.write(`${text}\n`)

  try {
    // 1. preflight
    steps.begin('preflight')
    const opened = openRoot(root, { uid })
    if (opened.status !== 'installed') {
      throw new Refusal(`${root} holds no installation, so there is nothing to purge. Nothing changed.`)
    }
    const { installationId, activeVersion } = opened.record
    const external = externalChecklist(root, { uid })
    const recordedRoutes = readTailscaleRecord(join(root, 'state')).serve
    say(`This purges the Curia installation at ${root} (installation ${installationId}, version ${activeVersion}).`)
    say('It deletes, with no way back:')
    say('  - your configuration (config/), credentials (secrets/), history (state/), and unfinished work (work/)')
    say('  - the installed versions, caches, and runtime files (versions/, cache/, run/) and the launcher')
    say("  - the installation's containers, networks, and volumes, and the release images nothing else uses")
    say('  - the Tailscale Serve routes Curia created')
    say('It does not delete the GitHub App, the Discord bot and channel, the Tailscale node, or any model-provider login; those stay yours to remove.')

    // 2. confirm
    steps.begin('confirm')
    if (confirmed !== null) {
      if (confirmed !== root) throw new Refusal(`${CONFIRM_OPTION} names ${confirmed}, not the installation root ${root}. Nothing changed.`)
    } else if (!isTerminal()) {
      throw new Refusal(`no terminal to confirm on. Run 'curia purge ${CONFIRM_OPTION} ${root}' to confirm without a prompt. Nothing changed.`)
    } else if ((await prompt(PROMPT)) !== root) {
      throw new Refusal('the answer did not match the installation root. Nothing changed.')
    }
    say(`confirmed: purging ${root}`)

    // The lock lives under run/, which a partial purge or the bootstrap's
    // stage case may find missing.
    const runDir = join(root, 'run')
    if (!existsSync(runDir)) mkdirSync(runDir, { mode: 0o700 })

    return await withLifecycleLock(root, async () => {
      // 3. docker
      steps.begin('docker')
      const removed = await removeInstallationResources(installationId, { docker, stdout })
      const count = removed.containers.length + removed.networks.length + removed.volumes.length
      say(count === 0
        ? `no container, network, or volume carries the label of installation ${installationId}`
        : `removed every container, network, and volume of installation ${installationId}`)

      // 4. routes
      steps.begin('routes')
      const routes = await withdrawServeRoutes({ stateDir: join(root, 'state'), stdout }, { tailscale })
      if (routes.recorded.length === 0) say('no Serve route is recorded for this installation')
      else if (routes.withdrawn.length === 0 && routes.absent.length > 0 && !routes.unreachable) say('no recorded Serve route is standing; nothing to withdraw')

      // 5. images
      steps.begin('images')
      const images = await removeReleaseImages({ docker, stdout })
      if (images.found.length === 0) say('no release image is on this host')
      else say(`release images: ${images.removed.length} removed, ${images.kept.length} kept`)

      // 6. root
      steps.begin('root')
      const launcherFate = removeLauncher(launcher, root)
      say(launcherFate === 'removed' ? `removed the launcher ${launcher}`
        : launcherFate === 'foreign' ? `kept the launcher ${launcher}: it belongs to another installation root`
          : `no launcher at ${launcher}`)
      removeRoot(root)
      say(`removed ${root}`)

      say('')
      say(`Curia is purged. The installation root ${root} is removed.`)
      say(`  removed:   the root with config/, secrets/, state/, and work/, the launcher, the installation's containers, networks, and volumes, and ${images.removed.length === 1 ? '1 release image' : `${images.removed.length} release images`}`)
      if (images.kept.length > 0) say(`  kept:      ${images.kept.length === 1 ? '1 release image' : `${images.kept.length} release images`} still in use on this host (listed under [5/6] images)`)
      say(`  reinstall: a later install starts a new installation with a new ID; the removed one cannot come back`)
      say('')
      say('External resources Curia never deletes. Deleting the local secret files revokes nothing: each credential stays valid until you remove it where it was issued.')
      for (const line of external) say(`  ${line}`)
      for (const route of recordedRoutes) {
        const withdrawn = routes.withdrawn.some((r) => r.https === route.https && r.target === route.target)
        const absent = routes.absent.some((r) => r.https === route.https && r.target === route.target) && !routes.unreachable
        say(`  Serve route https://:${route.https} -> ${route.target}: ${withdrawn ? 'withdrawn' : absent ? 'was not standing' : `still recorded when the root was removed; run 'tailscale serve --https=${route.https} off' on the node`}`)
      }
      say('  Model-provider logins (Anthropic, OpenAI): revoke them in each provider\'s account settings if you won\'t reinstall; only the local copies were deleted.')
      return EXIT.ok
    })
  } catch (e) {
    throw steps.wrap(e)
  }
}

// `--confirm <root>` or `--confirm=<root>`; anything else on the line is a
// usage error before the command runs.
export function confirmationFromArgs(args) {
  let value = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === CONFIRM_OPTION) {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new UsageError(`${CONFIRM_OPTION} needs the installation root as its value`)
      value = args[++i]
    } else if (arg.startsWith(`${CONFIRM_OPTION}=`)) {
      value = arg.slice(CONFIRM_OPTION.length + 1)
      if (value === '') throw new UsageError(`${CONFIRM_OPTION} needs the installation root as its value`)
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`)
    } else {
      throw new UsageError(`unexpected argument: ${arg}`)
    }
  }
  return value
}

// The question on the operator's terminal, answered once.
function askOnTerminal(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

// Removes the launcher when it names this root. A launcher of another root
// is another installation's and stays. The same rule as uninstall.
function removeLauncher(launcher, root) {
  let text
  try {
    text = readFileSync(launcher, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return 'absent'
    throw e
  }
  if (!text.includes(`CURIA_ROOT='${root}'`)) return 'foreign'
  unlinkSync(launcher)
  return 'removed'
}

// Removes the root with the installation record last: everything beside
// `state/` first, then everything in `state/` beside the record, then the
// record with the rest. A failure anywhere before the end leaves a root that
// `openRoot` still recognizes, so the rerun is a purge and not a refusal of
// an unknown directory.
function removeRoot(root) {
  const record = recordPath(root)
  const stateDir = join(root, 'state')
  for (const entry of readdirSync(root)) {
    if (entry === 'state') continue
    rmSync(join(root, entry), { recursive: true, force: true })
  }
  if (existsSync(stateDir)) {
    for (const entry of readdirSync(stateDir)) {
      const file = join(stateDir, entry)
      if (file === record) continue
      rmSync(file, { recursive: true, force: true })
    }
  }
  rmSync(root, { recursive: true, force: true })
}

// Used by the command table.
export function purgeCommandRun(context, deps) {
  return runPurge(context, deps)
}
