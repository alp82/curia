import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

import { EXIT, Refusal, UsageError } from './exit.mjs'
import { BOOTSTRAP_COMMAND } from './acquire.mjs'
import { writeAtomically } from './atomic.mjs'
import { composeProject, dockerRunner, startProject, waitForHealth, writeComposeEnvironment } from './compose.mjs'
import { initialOperatorConfig, operatorConfigPath, writeOperatorConfig } from './config.mjs'
import { launcherPath, renderLauncher } from './launcher.mjs'
import { serviceLayout } from './layout.mjs'
import { withLifecycleLock } from './lock.mjs'
import { releaseProbes } from './manifest.mjs'
import { hostProbes, preflight } from './preflight.mjs'
import { createInstallationRecord, ensureLayout, openRoot, versionPaths, writeInstallationRecord } from './root.mjs'
import { isCompleteStage, placeVersion, stagedVersion, verifyRetained } from './stage.mjs'
import { DEFAULT_NODE_NAME, MAGICDNS_LABEL_RE, joinTailnet } from './tailnet.mjs'
import { tailscaleRunner } from './tailscale.mjs'

// `curia install` and `curia reinstall` (#873, implementing #851, #854, #857,
// and #862; the tailnet step from the #891 rehearsal): from a verified stage
// to a healthy packaged Curia and a reachable app, as one linear sequence of
// seven named steps.
//
//   preflight  the root boundary (`openRoot`) and the host preflight. Nothing
//              on disk changes. A refusal here creates no root.
//   root       the root and its seven boundaries exist, the lifecycle lock is
//              held from here to the end, the installation record names the
//              version, and a fresh root gets the initial operator
//              configuration. A recognized root keeps its installation ID,
//              config/, secrets/, state/, and work/: that is a reinstall.
//   tailnet    the node is logged in to the tailnet under the name `--name`
//              asked for (default `curia`), or joined now: the login link
//              is printed on the terminal and the step waits for the
//              approval. Then the operator may use Tailscale Serve and the
//              tailnet issues the node's certificate. This comes before the
//              stage so nothing is downloaded onto a host that cannot be
//              reached. `curia reinstall` runs it inspect-only: it logs
//              nothing in. The step is `joinTailnet` in tailnet.mjs.
//   stage      the staged artifacts are verified against the release manifest
//              and land under versions/<version>/ as one complete version,
//              read-only, replacing that directory if it was there.
//   activate   the record names the version and the launcher is written.
//              Any other directory under versions/ is removed, so one release
//              is installed.
//   start      the Compose environment and the mount sources exist, the
//              five images are pulled by digest (the four the bundle names
//              through Compose, the agent image from the release
//              manifest), and the project is up.
//   health     every declared service reports healthy.
//
// Every step is idempotent by inspection, not by a persisted operation record:
// a rerun repeats the cheap steps, finds the expensive ones done, and so lands
// at the step that failed. A failure names the current step and the command
// that reruns it. There is no operation engine, no repair mode, and no retry
// loop beyond the health wait.
//
// The stage comes from the bootstrap as CURIA_STAGE, holding `node/`, `cli/`,
// `cli.tgz`, `bundle.tar.gz`, and `bundle.tar.gz.sha256`. The bootstrap removes
// it when this command returns, so the stage is copied, never moved. Without
// CURIA_STAGE, which is how the installed launcher reruns the command, the
// version already under versions/<version>/ is verified and reused.
//
// The version installed is always this interface's own version: the bootstrap
// runs the staged package, and the launcher runs the installed one. Installing
// another version is `curia update` (#883), which stages through the same
// `placeVersion` in stage.mjs.

export const INSTALL_STEPS = Object.freeze(['preflight', 'root', 'tailnet', 'stage', 'activate', 'start', 'health'])

// The Tailscale Serve port of the Curia app, `dashboard.serve_port` in
// config/curia.yaml. daemon/test/preflightports.test.mjs keeps them equal.
export const APP_SERVE_PORT = 8445

export const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// The command's seam. `context` is what `runCli` hands a command plus `gid`
// and `mode` (`install` or `reinstall`); `args` holds `[--name <label>]`
// for an install and nothing else. `deps` are the boundaries a test
// replaces: the host probes, the release probes, the Docker runner, the
// `tailscale` runner, and the clock the waits use.
export async function runInstall(
  { env, args = [], stdout, uid, gid, root, mode = 'install' },
  { hostProbes: host = hostProbes, releaseProbes: release = releaseProbes, docker = dockerRunner, tailscale = tailscaleRunner, sleep, now } = {},
) {
  const name = nameFromArgs(args)
  const version = packageVersion
  const launcher = launcherPath(env)
  const steps = sequence({ stdout, launcher, mode })
  const say = (text) => stdout.write(`${text}\n`)

  try {
    // 1. preflight
    steps.begin('preflight')
    const opened = openRoot(root, { uid })
    const hostReport = await preflight({ uid, root, stdout }, host)
    if (!hostReport.ok) throw hostReport.refusal
    const dockerGid = hostReport.facts.docker.group.gid

    // 2. root
    steps.begin('root')
    if (mode === 'reinstall' && opened.status !== 'installed') {
      throw new Refusal(`${root} holds no installation, so there is nothing to reinstall. Run the bootstrap to install Curia there.`)
    }
    const reinstalling = opened.status === 'installed'
    say(reinstalling ? `reinstalling ${version} over the installation at ${root} (installation ${opened.record.installationId})` : `creating the installation root at ${root}`)
    ensureLayout(root, { uid })

    return await withLifecycleLock(root, async () => {
      const record = opened.record ?? createInstallationRecord(version)
      if (!opened.record) writeInstallationRecord(root, record)
      const configPath = operatorConfigPath(root)
      if (!existsSync(configPath)) {
        writeOperatorConfig(configPath, initialOperatorConfig())
        say(`wrote the initial operator configuration to ${configPath}`)
      } else {
        say(`keeping ${configPath}`)
      }

      // 3. tailnet
      steps.begin('tailnet')
      const node = await joinTailnet({ name, mode: mode === 'install' ? 'join' : 'inspect', user: operatorUser(env), stdout }, { tailscale, sleep, now })
      const appHost = node.address

      // 4. stage
      steps.begin('stage')
      const paths = versionPaths(root, version)
      const stage = env.CURIA_STAGE
      if (stage) {
        if (!isCompleteStage(stage)) {
          throw new Refusal(`the stage ${stage} is incomplete. Run the bootstrap again; it downloads a complete stage.`)
        }
        const staged = stagedVersion(stage)
        if (staged !== version) {
          throw new Refusal(`the stage holds @curia-sh/cli ${staged}, but this lifecycle interface is ${version}, and an installation is always its own version. Run the bootstrap again so it installs one version end to end.`)
        }
        await placeVersion({ root, version, stage, stdout }, release)
      } else if (isCompleteStage(paths.dir)) {
        say(`${version} is already installed under ${paths.dir}; verifying the retained artifacts`)
        await verifyRetained({ version, dir: paths.dir, stdout }, release)
      } else {
        throw new Refusal(`no release to install: CURIA_STAGE is not set and ${paths.dir} holds no complete version. Run the bootstrap: ${BOOTSTRAP_COMMAND}`)
      }

      // 5. activate
      steps.begin('activate')
      writeInstallationRecord(root, { ...record, activeVersion: version })
      mkdirSync(dirname(launcher), { recursive: true })
      writeAtomically(launcher, renderLauncher({ root }), { mode: 0o755 })
      for (const other of readdirSync(join(root, 'versions'))) {
        if (other !== version) rmSync(join(root, 'versions', other), { recursive: true, force: true })
      }
      say(`${version} is the active version; the launcher is ${launcher}`)

      // 6. start
      steps.begin('start')
      const project = composeProject({ root, version })
      writeComposeEnvironment(project, { uid, gid, dockerGid, installationId: record.installationId })
      const layout = serviceLayout(root)
      for (const dir of [layout.home, layout.overseerRepos, layout.overseerTokens, layout.overseerConfigDir]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        chmodSync(dir, 0o700)
      }
      await startProject(project, { docker, stdout })

      // 7. health
      steps.begin('health')
      await waitForHealth(project, { docker, sleep, now, stdout })

      const app = `https://${appHost}:${APP_SERVE_PORT}/`
      say('')
      say(`Curia ${version} is installed and running.`)
      say(`  installation root: ${root}`)
      say(`  launcher:          ${launcher}`)
      say(`  node name:         ${node.name}`)
      say(`  Curia app:         ${app}`)
      say('')
      say(`Next: open the Curia app at ${app} from a device on your tailnet and start integration setup. It connects GitHub, Discord, Tailscale, and one AI login, then starts the Test run.`)
      return EXIT.ok
    })
  } catch (e) {
    throw steps.wrap(e)
  }
}

// The step sequence: prints each header, remembers the current step, and
// turns an error into one that names the step and the command that reruns
// it. Before the launcher exists the rerun is the bootstrap.
function sequence({ stdout, launcher, mode }) {
  let current = null
  let index = 0
  return {
    begin(name) {
      current = name
      index = INSTALL_STEPS.indexOf(name) + 1
      stdout.write(`[${index}/${INSTALL_STEPS.length}] ${name}\n`)
    },
    wrap(e) {
      if (current === null) return e
      if (e instanceof Refusal) return new Refusal(`${current}: ${e.message}`)
      const rerun = existsSync(launcher)
        ? `Run '${launcher} ${mode}' to run ${current} again; the completed steps are kept.`
        : `Fix the cause and run the bootstrap again; it resumes at ${current}.`
      const wrapped = new Error(`${current} failed: ${e.message}\n${rerun}`)
      wrapped.cause = e
      return wrapped
    },
  }
}

// The one option: `--name <label>` or `--name=<label>`, the machine name the
// node joins the tailnet under, which must be a MagicDNS label. Anything
// else on the command line is a usage error before anything runs.
export const NAME_OPTION = '--name'

export function nameFromArgs(args) {
  let name = DEFAULT_NODE_NAME
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === NAME_OPTION || arg.startsWith(`${NAME_OPTION}=`)) {
      let value
      if (arg === NAME_OPTION) {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new UsageError(`${NAME_OPTION} needs the machine name as its value`)
        value = args[++i]
      } else {
        value = arg.slice(NAME_OPTION.length + 1)
      }
      if (!MAGICDNS_LABEL_RE.test(value)) {
        throw new UsageError(`${value} is not a machine name. Use lowercase letters, digits, and hyphens, up to 63 characters, not starting or ending with a hyphen, such as curia.`)
      }
      name = value
      continue
    }
    if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`)
    throw new UsageError(`unexpected argument: ${arg}`)
  }
  return name
}

// The user the corrective `sudo tailscale set --operator=<user>` names: the
// operator running this command.
function operatorUser(env) {
  return env.USER || userInfo().username
}

// Used by the command table: the two commands are one sequence with one
// difference, whether a root that holds no installation is acceptable.
export function installCommand(mode) {
  return (context, deps) => runInstall({ ...context, mode }, deps)
}
