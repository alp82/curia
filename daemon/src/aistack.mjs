// The recurring aistack sync (#695, from the spec at #684 and the prototype at
// prototypes/aistack-machine/findings.md).
//
// The box is an aistack machine. Once the operator has registered it, this
// module publishes the box's rolling 30-day harness usage to the operator's
// stack, so the agents' token spend joins their measured layer.
//
// Five rules settle it, and each one keeps a wrong answer out.
//
//   1. THE CREDENTIAL DECIDES WHETHER CURIA SYNCS AT ALL. Registration is a
//      one-time operator ceremony: a device-code login on the box, and an
//      approval in a signed-in browser. It ends with a bearer token in
//      `<workspace_root>/home/.config/aistack/credentials.json`. That file is
//      the switch. It lives under curia's durable HOME, which is daemon-owned
//      and outside every checkout, so the token never reaches the repository.
//      No file, no sync, and no noise about it either.
//
//   2. THE ROOTS ARE BUILT PER RUN. Curia gives every agent its own config
//      directory under `<workspace_root>/cfg/<session>`, and it deletes that
//      directory when the session ends. So there is no fixed root to point the
//      command line interface at. Each run enumerates `cfg/*` and passes every
//      active claude directory as the comma-separated `CLAUDE_CONFIG_DIR` list
//      the CLI accepts. `CODEX_HOME` takes one directory only, so the run picks
//      the most recently written codex root and says so in the journal.
//
//   3. THE RUN RIDES THE DISPATCH TICK. Curia already has one clock, and #345
//      is about not growing a second one. A publish files no ticket, so it
//      belongs beside the liveness sweep and the credential refreshes in
//      `Dispatcher.#autoTick`. A local check interval bounds how often that tick
//      spends a process, and the stack's own `frequencyHours` bounds how often a
//      run actually publishes.
//
//   4. THE COMMAND IS PINNED. The stock aistack hook runs `@latest`, which can
//      change behavior on a box nobody touched. The version comes from
//      `aistack.cli_version` in `curia.yaml`, exactly like the harness pins in
//      the `sandbox:` block.
//
//   5. A SUCCESS SAYS NOTHING, AND A FAILURE NAMES THE REPAIR. Every run lands
//      in the journal. Only a failure reaches Discord, only when it is news, and
//      it carries the two commands that fix it. The alarm is edge-triggered off
//      the journal, so a deploy inherits what already stands and repeats
//      nothing.
//
// What a sync can never show is bounded twice, and both bounds are the measured
// layer's, not curia's: a torn-down config directory takes its transcripts with
// it, and `CODEX_HOME` aggregates one root per run.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CFG_DIR, configRootEnvFor } from './workspace.mjs'

// Rule 4. The npm package, its binary, and the runner that fetches it.
export const CLI_PACKAGE = '@use-aistack/cli'
export const CLI_RUNNER = 'npx'

// The version the prototype registered and published with. It is the default
// for `aistack.cli_version`, so a box whose config predates this section still
// runs a pinned command rather than `@latest`.
export const DEFAULT_CLI_VERSION = '0.7.2'

// Rule 3. How long a run stays fresh. The stack's own auto-sync frequency
// defaults to 24 hours and the CLI honors it, so this number bounds spawned
// processes rather than published snapshots.
export const DEFAULT_INTERVAL_HOURS = 1

// A scan reads every transcript under every active config directory, so it is
// slower than a probe and far faster than this. Ten minutes is a wedge rather
// than a busy box, and a wedged child has to actually die.
export const SYNC_TIMEOUT_MS = 10 * 60 * 1000

// Rule 1. Where the CLI keeps the bearer, relative to curia's HOME.
export const CREDENTIAL_REL = path.join('.config', 'aistack', 'credentials.json')

// Rule 1. Curia's own HOME, `home/` inside the workspace root (deploy/compose.yaml).
// It is derived from the configured root rather than read off `process.env.HOME`,
// because the daemon suite runs with a different HOME and the durable path is
// the thing this module is about.
export function homeFor(root) {
  return path.join(root, 'home')
}

export function credentialFile(root) {
  return path.join(homeFor(root), CREDENTIAL_REL)
}

// A registered box has a readable, non-empty credentials file. An empty file is
// not a registration: the CLI writes the whole JSON document at once, so a zero
// byte file is a half-finished login rather than a token.
export function hasCredential(root) {
  try {
    return fs.statSync(credentialFile(root)).size > 0
  } catch {
    return false
  }
}

// ---- the roots --------------------------------------------------------------

// Every config directory on the box, newest write first. The name is the
// session, and `at` is the directory's own mtime, which is what ranks the codex
// roots below.
function cfgEntries(root) {
  const dir = path.join(root, CFG_DIR)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const full = path.join(dir, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    out.push({ name, path: full, at: stat.mtimeMs })
  }
  return out.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
}

// Rule 2. Every claude root the CLI can scan, as absolute paths. A config
// directory counts when it holds a `projects/` directory, which is where the
// claude harness writes its transcripts. A directory without one is a codex,
// opencode, or pi session, or a claude session that has not written yet, and
// passing it would only make the list longer.
//
// The order is newest first, so a truncated list would keep the freshest work.
// Nothing truncates it today.
export function claudeRoots(root) {
  return cfgEntries(root)
    .filter((e) => {
      try {
        return fs.statSync(path.join(e.path, 'projects')).isDirectory()
      } catch {
        return false
      }
    })
    .map((e) => e.path)
}

// Rule 2. The one codex root this run scans, or null. `CODEX_HOME` names a
// single directory, so rollouts spread over many config directories cannot be
// aggregated in one run. The newest wins, because it is the run that is still
// going.
export function codexRoot(root) {
  for (const e of cfgEntries(root)) {
    try {
      if (fs.statSync(path.join(e.path, 'sessions')).isDirectory()) return e.path
    } catch { /* not a codex root */ }
  }
  return null
}

// The environment one run gets. `PATH` and the rest of the daemon's environment
// ride along, because `npx` needs a node on the path, and `HOME` is overridden
// so the CLI reads curia's credential and writes curia's log.
export function syncEnv(root, { env = process.env } = {}) {
  const claude = claudeRoots(root)
  const codex = codexRoot(root)
  // The variable names come from `workspace.mjs`, which is where a harness's
  // config root is decided for the agents themselves. A sync that named them
  // here would keep scanning the old variable the day one changes.
  return {
    ...env,
    HOME: homeFor(root),
    ...(claude.length ? { [configRootEnvFor('claude')]: claude.join(',') } : {}),
    ...(codex ? { [configRootEnvFor('codex')]: codex } : {}),
  }
}

// Rule 4. The pinned command, as one array. `-y` keeps `npx` from prompting on
// a box with no terminal, and `sync --auto` is the only sync path that runs
// without one.
export function syncArgs(version = DEFAULT_CLI_VERSION) {
  return ['-y', `${CLI_PACKAGE}@${version}`, 'sync', '--auto']
}

// ---- the run ----------------------------------------------------------------

// One invocation. It resolves with the output on exit 0 and rejects with a
// message naming what went wrong on anything else. The caller turns a rejection
// into an alarm, so nothing here writes or says anything.
export function runSync({
  root, version = DEFAULT_CLI_VERSION, bin = CLI_RUNNER,
  env = process.env, timeoutMs = SYNC_TIMEOUT_MS,
} = {}) {
  const child = spawn(bin, syncArgs(version), {
    cwd: homeFor(root),
    env: syncEnv(root, { env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => { if (stdout.length < 4000) stdout += c })
  child.stderr.on('data', (c) => { if (stderr.length < 4000) stderr += c })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
  timer.unref?.()

  return new Promise((resolve, reject) => {
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`${bin} did not run: ${e.message}`))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        return reject(new Error(`the sync ran past ${Math.round(timeoutMs / 60000)} minutes and was killed`))
      }
      if (signal) return reject(new Error(`${bin} was killed on ${signal}`))
      if (code !== 0) {
        const why = (stderr.trim() || stdout.trim() || '').split('\n').slice(-1)[0] ?? ''
        return reject(new Error(`${bin} exited ${code}${why ? `: ${why}` : ''}`))
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

// ---- the lines --------------------------------------------------------------
//
// CuriaBot's own voice under ADR-0013: these state mechanics, and each one names
// the act that ends it.

export function failedLine({ message, version = DEFAULT_CLI_VERSION, home }) {
  const login = `HOME=${home} ${CLI_RUNNER} -y ${CLI_PACKAGE}@${version} login`
  const optIn = `HOME=${home} ${CLI_RUNNER} -y ${CLI_PACKAGE}@${version} sync --auto on`
  return [
    `⚠️ the aistack sync failed: ${message}.`,
    'Your measured layer keeps its last reading and ages until this runs again.',
    `Read \`${path.join(home, '.config', 'aistack', 'sync.log')}\` on the box.`,
    `If the machine is gone from aistack.to/settings/machines, register it again with \`${login}\`, then grant the standing permission with \`${optIn}\`.`,
  ].join(' ')
}

export function recoveredLine({ published = null } = {}) {
  return published
    ? `✅ the aistack sync is publishing again: ${published}`
    : '✅ the aistack sync is publishing again.'
}

// ---- the sync ---------------------------------------------------------------

export class AistackSync {
  // `journal` writes one event. `announce` resolves true when the words reached
  // Discord, exactly as the journal backup's and the credential watch's do.
  // `standing` reads the alarm the reduction remembers, so a deploy inherits it.
  // `lastAt` reads the instant of the last attempt, for the same reason: a
  // deploy must not turn the check interval into a per-boot spawn.
  constructor({
    root, journal, announce, standing = () => null, lastAt = () => null,
    log = () => {}, now = () => Date.now(),
    version = DEFAULT_CLI_VERSION, intervalHours = DEFAULT_INTERVAL_HOURS,
    bin = CLI_RUNNER, env = process.env, run = runSync,
  }) {
    this.root = root
    this.journal = journal
    this.announce = announce
    this.standing = standing
    this.lastAt = lastAt
    this.log = log
    this.now = now
    this.version = version
    this.intervalMs = intervalHours * 60 * 60 * 1000
    this.bin = bin
    this.env = env
    this.run = run
    // The in-process half of rule 3. `lastAt` reads the journal, which only
    // records finished attempts, so a run still in flight is held here.
    this.busy = false
  }

  home() {
    return homeFor(this.root)
  }

  // What this run would do, without doing it. The reasons are the journal's
  // words too, so one vocabulary explains a skip on every surface.
  plan() {
    if (!hasCredential(this.root)) return { run: false, why: 'unregistered' }
    const claude = claudeRoots(this.root)
    const codex = codexRoot(this.root)
    if (!claude.length && !codex) return { run: false, why: 'no harness data', claude, codex }
    return { run: true, claude, codex }
  }

  // One pass, and whatever it makes curia say. It never throws: a sync that
  // cannot run is at worst an alarm, and an alarm must not take the tick with
  // it.
  async pass() {
    if (this.busy) return null
    const plan = this.plan()
    // Rule 1 and rule 2. An unregistered box and a box with nothing to scan are
    // both ordinary, so both stay silent and spend nothing.
    if (!plan.run) return null

    const now = this.now()
    const last = this.lastAt() ?? null
    if (last !== null && now - last < this.intervalMs) return null

    this.busy = true
    let result
    try {
      result = await this.run({
        root: this.root, version: this.version, bin: this.bin, env: this.env,
      })
    } catch (e) {
      await this.#alarm(e.message)
      return null
    } finally {
      this.busy = false
    }

    // Rule 5. The success itself says nothing. It speaks only when it repairs
    // an alarm the operator was told about.
    const published = publishedLink(result)
    const stood = this.standing() ?? null
    this.journal('aistack_sync', {
      claude_roots: plan.claude.length,
      codex_root: plan.codex ? path.basename(plan.codex) : null,
      version: this.version,
      published,
    })
    if (stood?.said) await this.#say(recoveredLine({ published }))
    return { published, claude_roots: plan.claude.length, codex_root: plan.codex }
  }

  // Rule 5. The alarm is said when it is news: a first failure, a failure whose
  // reason changed, or one the bridge was down for. Everything else is
  // journalled and stays quiet.
  async #alarm(message) {
    const entry = this.standing() ?? null
    const news = !entry || !entry.said || entry.message !== message
    this.log(`the aistack sync failed: ${message}`)
    if (!news) {
      this.journal('aistack_sync_failed', { message, version: this.version, said: entry.said ?? false })
      return
    }
    const said = await this.#say(failedLine({ message, version: this.version, home: this.home() }))
    this.journal('aistack_sync_failed', { message, version: this.version, said })
  }

  // The one place `said` is decided. A missing bridge and a failing send are the
  // same answer: the operator did not read it.
  async #say(text) {
    try {
      const res = await this.announce(text)
      if (res === false) this.log('the aistack alarm could not be said - there is no bridge yet, so it stands until there is')
      return res !== false
    } catch (e) {
      this.log(`the aistack alarm did not reach Discord (${e.message}) - it stands until it does`)
      return false
    }
  }
}

// The stack URL the CLI prints on a publish, or null when the run published
// nothing this time. The CLI's own line is `ok - published <url>`, and a run the
// stack's frequency held back prints no URL at all.
export function publishedLink(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  const m = /https:\/\/\S+/.exec(text)
  return m ? m[0] : null
}
