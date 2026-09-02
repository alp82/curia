import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { BOOTSTRAP_COMMAND } from './acquire.mjs'
import { EXIT, Refusal } from './exit.mjs'
import { dockerRunner } from './compose.mjs'
import { launcherPath } from './launcher.mjs'
import { lockPath, withLifecycleLock } from './lock.mjs'
import { removeInstallationResources } from './resources.mjs'
import { installationRoot, openRoot } from './root.mjs'
import { readSecret } from './secrets.mjs'
import { namedSteps } from './steps.mjs'
import { tailscaleRunner, withdrawServeRoutes } from './tailscale.mjs'

// `curia uninstall` (#886, implementing #855): the ordinary uninstall. It
// removes Curia's runnable footprint from the host and keeps the
// installation, as four named steps.
//
//   preflight  the root boundary (`openRoot`, which must find an
//              installation). Nothing changes.
//   docker     under the lifecycle lock from here to the end: every
//              container, network, and volume that carries this
//              installation's label is stopped and removed. That is the
//              five services of the Compose project, its network and tmux
//              socket volume, and every agent container and agent cache
//              volume the service created. Nothing without the label is
//              read or touched, and the release images stay for purge.
//   routes     the Tailscale Serve routes Curia created, as
//              `state/tailscale.json` records them, are turned off. No
//              other route, and nothing else of the node.
//   files      the contents of versions/, cache/, and run/ are removed, and
//              then the launcher, when it is this installation's.
//
// What stays is the installation: `config/`, `secrets/`, `state/`, and
// `work/`, with the installation record and its ID. Nothing here reads a
// session, drains one, changes a claim, or judges what under `work/` is
// worth keeping: the preserved directories are the recovery mechanism, and
// the bootstrap's `curia install` over the root is the reinstall.
//
// Every step reads what is there before it removes it, so a rerun over a
// partial cleanup does the rest and a rerun over a finished one does
// nothing. There is no persisted operation record and no repair mode. A
// failed step names itself and the command that reruns it.

export const UNINSTALL_STEPS = Object.freeze(['preflight', 'docker', 'routes', 'files'])

// The directories whose contents go, in the order they are removed. The
// directories themselves stay, so the root keeps its seven boundaries and the
// lock has a place to live on a rerun.
export const REMOVED_BOUNDARIES = Object.freeze(['versions', 'cache', 'run'])
export const PRESERVED_BOUNDARIES = Object.freeze(['config', 'secrets', 'state', 'work'])

// The command's seam. `context` is what `runCli` hands a command. `deps` are
// the boundaries a test replaces: the Docker runner and the `tailscale`
// runner.
export async function runUninstall(
  { env, stdout, uid, root },
  { docker = dockerRunner, tailscale = tailscaleRunner } = {},
) {
  const launcher = launcherPath(env)
  const steps = namedSteps({
    steps: UNINSTALL_STEPS,
    stdout,
    rerun: (step) => (existsSync(launcher)
      ? `Run '${launcher} uninstall' to run ${step} again; the completed steps are kept.`
      : `Fix the cause, then run 'curia uninstall' again from the bootstrap's reinstall (${reinstallCommand({ env, root })}), or remove the rest by hand: ${REMOVED_BOUNDARIES.map((b) => join(root, b)).join(', ')}.`),
  })
  const say = (text) => stdout.write(`${text}\n`)

  try {
    // 1. preflight
    steps.begin('preflight')
    const opened = openRoot(root, { uid })
    if (opened.status !== 'installed') {
      throw new Refusal(`${root} holds no installation, so there is nothing to uninstall. Nothing changed.`)
    }
    const { installationId, activeVersion } = opened.record
    say(`uninstalling Curia ${activeVersion} from ${root} (installation ${installationId}); config/, secrets/, state/, and work/ are kept`)

    return await withLifecycleLock(root, async () => {
      // 2. docker
      steps.begin('docker')
      const removed = await removeInstallationResources(installationId, { docker, stdout })
      const count = removed.containers.length + removed.networks.length + removed.volumes.length
      say(count === 0
        ? `no container, network, or volume carries the label of installation ${installationId}`
        : `removed every container, network, and volume of installation ${installationId}; the release images are kept for 'curia purge'`)

      // 3. routes
      steps.begin('routes')
      const routes = await withdrawServeRoutes({ stateDir: join(root, 'state'), stdout }, { tailscale })
      if (routes.recorded.length === 0) say('no Serve route is recorded for this installation')
      else if (routes.withdrawn.length === 0 && routes.stale.length === 0) say(`no recorded Serve route is standing; nothing to withdraw`)

      // 4. files
      steps.begin('files')
      const lock = lockPath(root)
      for (const name of REMOVED_BOUNDARIES) {
        const dir = join(root, name)
        if (!existsSync(dir)) continue
        for (const entry of readdirSync(dir)) {
          const file = join(dir, entry)
          if (file === lock) continue
          rmSync(file, { recursive: true, force: true })
        }
        say(`emptied ${dir}`)
      }
      const launcherFate = removeLauncher(launcher, root)
      say(launcherFate === 'removed' ? `removed the launcher ${launcher}`
        : launcherFate === 'foreign' ? `kept the launcher ${launcher}: it belongs to another installation root`
          : `no launcher at ${launcher}`)

      say('')
      say(`Curia is uninstalled. The installation at ${root} is preserved.`)
      say(`  kept:      ${PRESERVED_BOUNDARIES.map((b) => `${b}/`).join(', ')} (installation ${installationId}: configuration, secrets, history, and resumable work)`)
      say(`  removed:   the launcher, ${REMOVED_BOUNDARIES.map((b) => `${b}/`).join(', ')}, and the installation's containers, networks, volumes, and Serve routes`)
      say(`  images:    kept; 'curia purge' removes them`)
      say(`  reinstall: ${reinstallCommand({ env, root })}`)
      say(`  purge:     ${purgeCommand({ env, root })}`)
      const external = externalChecklist(root, { uid })
      if (external.length > 0) {
        say('')
        say("External resources Curia never deletes. Remove them yourself if you won't reinstall:")
        for (const line of external) say(`  ${line}`)
      }
      return EXIT.ok
    })
  } catch (e) {
    throw steps.wrap(e)
  }
}

// The bootstrap installs over a preserved root and recognizes the record, so
// the reinstall command is the install command, with the root named when it
// is not the default one.
export function reinstallCommand({ env, root }) {
  return `${BOOTSTRAP_COMMAND}${rootOption({ env, root })}`
}

export function purgeCommand({ env, root }) {
  return `${BOOTSTRAP_COMMAND} --purge${rootOption({ env, root })}`
}

function rootOption({ env, root }) {
  const byDefault = installationRoot({ HOME: env.HOME, XDG_DATA_HOME: env.XDG_DATA_HOME })
  return root === byDefault ? '' : ` --root ${root}`
}

// Removes the launcher when it names this root. A launcher of another root
// is another installation's and stays.
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

// The external resources Curia knows the identifiers of, from the files it
// keeps. Identifiers only, never a token or a key, and a file that cannot be
// read contributes nothing: the checklist is a courtesy, not a check.
export function externalChecklist(root, { uid }) {
  const lines = []
  const github = parse(() => readSecret(root, 'github-app.json', { uid }))
  if (github?.id) lines.push(`GitHub App ${github.id} and its installations: https://github.com/settings/apps`)
  const discord = parse(() => readFileSync(join(root, 'state', 'discord.json'), 'utf8'))
  if (discord?.guild_id) lines.push(`Discord bot, server ${discord.guild_id}${discord.channel ? `, channel ${discord.channel}` : ''}: https://discord.com/developers/applications`)
  const tailscale = parse(() => readFileSync(join(root, 'state', 'tailscale.json'), 'utf8'))
  if (tailscale?.machine_name) lines.push(`Tailscale node ${tailscale.machine_name}: https://login.tailscale.com/admin/machines`)
  return lines
}

function parse(read) {
  try {
    const text = read()
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

// Used by the command table.
export function uninstallCommand(context, deps) {
  return runUninstall(context, deps)
}
