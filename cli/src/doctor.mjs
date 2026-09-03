import { existsSync } from 'node:fs'

import { BOOTSTRAP_COMMAND } from './acquire.mjs'
import { EXIT } from './exit.mjs'
import { ConfigError, operatorConfigPath, readOperatorConfig } from './config.mjs'
import { composeProject, dockerRunner, serviceStates } from './compose.mjs'
import { APP_SERVE_PORT } from './install.mjs'
import { launcherPath } from './launcher.mjs'
import { SERVICES } from './layout.mjs'
import { releaseProbes, verifyInstalledRelease } from './manifest.mjs'
import { hostProbes, preflight } from './preflight.mjs'
import { openRoot, versionPaths } from './root.mjs'
import { SECRET_NAMES, credentialsInEnvironment, secretsStatus } from './secrets.mjs'

// `curia doctor` (#881, implementing #857): one read-only pass over every
// direct check an installed Curia has, in the order an operator would look.
//
//   host           the supported-host preflight, the same checks `curia
//                  install` and `curia update` run
//   installation   the root boundary, the record, the active version's
//                  files, and the launcher
//   configuration  `config/config.yaml` through the operator configuration
//                  contract
//   release        the retained artifacts of the active version, the
//                  installed files, and the publication provenance
//   secrets        the four secret files by presence, and the shell
//                  environment by key
//   containers     the state and health of the five services from Compose
//   service        the service answers on loopback
//   integrations   the four cards and the Test run's gate, as the running
//                  service verifies them on this read, and the operator it
//                  admits
//   app            the Curia app answers on loopback, and its tailnet address
//
// Every check is `{ name, status, observed, action }`, the shape the preflight
// and the release verification already use, with `status` one of `passed`,
// `warning`, `failed`, or `refused`. A failed or refused check carries one
// corrective action. The command reruns every applicable check on every
// invocation, keeps no history, and repairs nothing: it opens the root, reads
// files, asks Docker for `ps`, and sends two reads to the service and one to
// the app. It never escalates, retries in the background, or schedules
// anything. The exit code is `ok` when nothing failed, `failed` when a check
// failed or a host condition is refused, and `refused` only when the root
// boundary refuses before anything runs.
//
// Everything printed passes through `redactDiagnostic`, so a secret that
// reaches the doctor through an error message, a service answer, or a Docker
// message never reaches the terminal. The doctor reads no secret value
// itself: `secretsStatus` reports presence only.

export const DOCTOR_SECTIONS = Object.freeze(['host', 'installation', 'configuration', 'release', 'secrets', 'containers', 'service', 'integrations', 'app'])

// The service's own loopback listener (the `/ping` route the bundle's health
// check asks) and the Curia app's loopback port, `dashboard.port` in
// config/curia.yaml. daemon/test/preflightports.test.mjs keeps the app port
// equal to the shipped configuration.
export const SERVICE_PORT = 4271
export const APP_PORT = 4273

const READ_TIMEOUT_MS = 10_000
const BOOTSTRAP = BOOTSTRAP_COMMAND
const AGAIN = 'run curia doctor again'

const CARD_NAMES = Object.freeze({ github: 'GitHub', discord: 'Discord', tailscale: 'Tailscale', model: 'AI logins' })

export async function runDoctor(
  { env, stdout, uid, root },
  { hostProbes: host = hostProbes, releaseProbes: release = releaseProbes, docker = dockerRunner, fetch: fetchImpl = globalThis.fetch } = {},
) {
  // The root boundary first, like every lifecycle command. A refusal here is
  // the one refusal the doctor raises: it says nothing about the host until
  // it knows the root is the operator's own.
  const opened = openRoot(root, { uid })
  const report = reporter(stdout)

  report.section('host')
  const hostReport = await preflight({ uid, root }, host)
  report.checks(hostReport.checks)

  report.section('installation')
  report.checks([installationCheck({ opened, root, env })])
  if (opened.status !== 'installed') {
    report.note('the remaining checks need an installation.')
    return report.finish()
  }
  const version = opened.record.activeVersion

  report.section('configuration')
  report.checks([configurationCheck(root)])

  report.section('release')
  const releaseReport = await verifyInstalledRelease({ root, version, stdout: { write: () => true } }, release)
  report.checks(releaseReport.checks)

  report.section('secrets')
  report.checks([secretsCheck(root, uid), environmentCheck(env)])

  report.section('containers')
  const project = composeProject({ root, version })
  report.checks([await containersCheck(project, docker)])

  report.section('service')
  const read = reader(fetchImpl)
  const service = await serviceCheck(read, project)
  report.checks([service])

  report.section('integrations')
  let address = null
  if (service.status === 'passed') {
    const setup = await read.json(`http://127.0.0.1:${SERVICE_PORT}/setup`)
    const identity = await read.json(`http://127.0.0.1:${SERVICE_PORT}/identity`)
    const checks = integrationChecks(setup)
    report.checks([...checks.checks, operatorCheck(identity)])
    address = checks.address
  } else {
    report.note('integrations not checked: the service did not answer.')
  }

  report.section('app')
  report.checks([await appCheck(read, { project, address: address ?? hostReport.facts.tailscale?.certDomains?.[0] ?? null })])

  return report.finish()
}

// ---------------------------------------------------------------------------
// The checks. Each returns one result in the shared shape.

function passed(name, observed) { return { name, status: 'passed', observed, action: null } }
function warning(name, observed, action) { return { name, status: 'warning', observed, action } }
function failed(name, observed, action) { return { name, status: 'failed', observed, action } }

function installationCheck({ opened, root, env }) {
  if (opened.status !== 'installed') {
    return failed('installation', `${root} holds no installation.`, `Run the bootstrap: ${BOOTSTRAP}`)
  }
  const { activeVersion, installationId } = opened.record
  const paths = versionPaths(root, activeVersion)
  const missing = ['node', 'cli', 'manifest', 'package', 'bundleArchive', 'bundleChecksum', 'bundle'].filter((k) => !existsSync(paths[k]))
  if (missing.length > 0) {
    return failed('installation', `version ${activeVersion} is active, but ${paths.dir} lacks ${missing.map((k) => paths[k].slice(paths.dir.length + 1)).join(', ')}.`, `Run 'curia reinstall' to restore the version from the release, or the bootstrap: ${BOOTSTRAP}`)
  }
  const launcher = launcherPath(env)
  const seen = `version ${activeVersion} (installation ${installationId}) at ${root}`
  if (!existsSync(launcher)) {
    return warning('installation', `${seen}; the launcher ${launcher} is missing.`, `Run 'curia reinstall' from the installed version to write the launcher again.`)
  }
  return passed('installation', `${seen}; launcher ${launcher}`)
}

function configurationCheck(root) {
  const path = operatorConfigPath(root)
  let config
  try {
    config = readOperatorConfig(path)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    return failed('operator configuration', e.message, 'Fix that line or revert the file, then save any setting from the Curia app or restart the service.')
  }
  if (config === null) {
    return warning('operator configuration', `${path} is absent, so the shipped defaults apply.`, `Run 'curia reinstall' to write the initial configuration, or create the file.`)
  }
  const keys = Object.entries(config).map(([k, v]) => (k === 'watch' ? `watch: ${v.length} ${v.length === 1 ? 'repository' : 'repositories'}` : `${k}: ${v}`))
  return passed('operator configuration', `${path} is valid${keys.length ? ` (${keys.join(', ')})` : ''}`)
}

function secretsCheck(root, uid) {
  const status = secretsStatus(root, { uid })
  const of = (state) => SECRET_NAMES.filter((n) => status[n].state === state)
  const presence = [
    of('present').length ? `present: ${of('present').join(', ')}` : 'none present',
    of('absent').length ? `absent: ${of('absent').join(', ')}` : null,
  ].filter(Boolean).join('; ')
  const refused = of('refused')
  if (refused.length > 0) {
    return failed('secret files', `${refused.map((n) => status[n].why).join(' ')} ${presence}.`, `After the fix, ${AGAIN}.`)
  }
  return passed('secret files', presence)
}

function environmentCheck(env) {
  const keys = credentialsInEnvironment(env ?? {})
  if (keys.length === 0) return passed('environment', 'no credential key is set in this shell')
  return warning('environment', `${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} set in this shell. Curia reads a credential from its secret file only, and the service refuses to boot with one of these keys set.`, `Unset ${keys.length === 1 ? 'it' : 'them'}. The secret files are ${SECRET_NAMES.map((n) => `secrets/${n}`).join(', ')}.`)
}

function logsCommand(project, service) {
  return `docker compose --env-file ${project.envFile} -f ${project.file} logs ${service}`
}

async function containersCheck(project, docker) {
  if (!existsSync(project.envFile)) {
    return failed('containers', `${project.envFile} is missing, so the Compose project cannot be addressed.`, `Run 'curia reinstall' to write it and start the project again.`)
  }
  let states
  try {
    states = await serviceStates(project, { docker })
  } catch (e) {
    return failed('containers', oneLine(e.message), `Fix Docker access for this user, then ${AGAIN}.`)
  }
  const problems = []
  const starting = []
  for (const service of SERVICES) {
    const s = states.find((x) => x.service === service)
    if (!s) problems.push({ service, what: `${service} is not in the project` })
    else if (s.state === 'exited' || s.state === 'dead') problems.push({ service, what: `${service} exited with code ${s.exitCode ?? '?'}` })
    else if (s.health === 'unhealthy') problems.push({ service, what: `${service} is unhealthy` })
    else if (s.health !== 'healthy') starting.push(service)
  }
  if (problems.length > 0) {
    const all = [...problems.map((p) => p.what), ...starting.map((s) => `${s} is starting`)]
    return failed('containers', `${all.join('; ')}.`, `Read its log with '${logsCommand(project, problems[0].service)}', fix the cause, and ${problems[0].what.endsWith('in the project') ? "run 'curia reinstall'" : 'start the service again'}.`)
  }
  if (starting.length > 0) {
    return warning('containers', `${starting.map((s) => `${s} is starting`).join('; ')}; the rest are healthy.`, `Wait a minute and ${AGAIN}. A service still starting after four minutes is one to read the log of: '${logsCommand(project, starting[0])}'.`)
  }
  return passed('containers', `${SERVICES.join(', ')} healthy`)
}

async function serviceCheck(read, project) {
  const at = `127.0.0.1:${SERVICE_PORT}`
  const answer = await read.json(`http://${at}/ping`)
  if (answer.ok) return passed('service', `the service answers on ${at}`)
  return failed('service', `the service did not answer on ${at} (${answer.error}).`, `Read its log with '${logsCommand(project, 'daemon')}', fix the cause, and ${AGAIN}.`)
}

// The four cards and the gate, as the service verified them on this read.
// Nothing here comes from a file: a card is connected only because its
// verifier said so now.
function integrationChecks(setup) {
  if (!setup.ok) {
    return { checks: [failed('integrations', `the service did not answer GET /setup (${setup.error}).`, `Read its log and ${AGAIN}.`)], address: null }
  }
  const body = setup.body ?? {}
  const cards = Array.isArray(body.cards) ? body.cards : []
  const checks = []
  let address = null
  for (const key of Object.keys(CARD_NAMES)) {
    const name = CARD_NAMES[key]
    const card = cards.find((c) => c?.key === key)
    if (!card) { checks.push(failed(name, 'the service reported no such card.', `Update Curia, then ${AGAIN}.`)); continue }
    if (card.state === 'connected') {
      const footer = card.footer ?? {}
      checks.push(passed(name, [footer.primary, footer.secondary].filter(Boolean).join(' · ') || 'connected and verified'))
      if (key === 'tailscale') address = card.detail?.app_url ?? (card.detail?.address ? `https://${card.detail.address}:${APP_SERVE_PORT}/` : null)
    } else if (card.state === 'failed') {
      checks.push(failed(name, String(card.error?.failed ?? 'the verification did not pass.'), String(card.error?.action ?? 'Open the Curia app, select Setup, and select Try again.')))
    } else if (card.state === 'unavailable') {
      checks.push(warning(name, 'not available in this release.', 'Update Curia when a release adds it.'))
    } else {
      checks.push(warning(name, 'not connected yet.', `Open the Curia app, select Setup, and connect ${name}.`))
    }
  }
  const loop = body.full_loop ?? {}
  if (loop.ready) checks.push(passed('Test run', 'ready on this read: every card verified and handed its fact'))
  else checks.push(warning('Test run', String(loop.reason ?? 'not ready.'), 'Finish setup in the Curia app; Start Test run enables when every card is connected on one read.'))
  return { checks, address }
}

function operatorCheck(identity) {
  if (!identity.ok) return failed('admitted operator', `the service did not answer GET /identity (${identity.error}).`, `Read its log and ${AGAIN}.`)
  const allow = Array.isArray(identity.body?.allow) ? identity.body.allow.map(String) : []
  if (allow.length > 0) return passed('admitted operator', allow.join(', '))
  if (identity.body?.first_operator) {
    return warning('admitted operator', 'no operator confirmed; the app admits the first tailnet identity to Setup only.', 'Open the Curia app from your tailnet and select Confirm operator and verify on the Tailscale card.')
  }
  return warning('admitted operator', 'the service admits no login.', 'Confirm the operator on the Tailscale card of Setup.')
}

async function appCheck(read, { project, address }) {
  const at = `127.0.0.1:${APP_PORT}`
  const answer = await read.status(`http://${at}/`)
  const url = address ? (address.startsWith('https://') ? address : `https://${address}:${APP_SERVE_PORT}/`) : null
  if (answer.ok) return passed('Curia app', `the app answers on ${at}${url ? `; open it at ${url}` : ''}`)
  return failed('Curia app', `the app did not answer on ${at} (${answer.error}).`, `Read its log with '${logsCommand(project, 'dashboard')}', fix the cause, and ${AGAIN}.`)
}

// ---------------------------------------------------------------------------
// The two reads: a JSON route and a bare status. Both answer instead of
// throwing, and both scrub what comes back before it is used.

function reader(fetchImpl) {
  const get = (url) => fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
  return {
    async json(url) {
      try {
        const response = await get(url)
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        return { ok: true, body: scrubFacts(await response.json()) }
      } catch (e) {
        return { ok: false, error: oneLine(e.cause?.message ?? e.message) }
      }
    },
    async status(url) {
      try {
        const response = await get(url)
        if (response.status >= 500) return { ok: false, error: `HTTP ${response.status}` }
        return { ok: true, status: response.status }
      } catch (e) {
        return { ok: false, error: oneLine(e.cause?.message ?? e.message) }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Redaction. Two layers: values under a key that names a credential are
// dropped from every service answer before the doctor reads it, and every
// printed line loses any string shaped like a long-lived secret (a Discord
// bot token, a provider key, a GitHub token, a private key), a renewable or
// session token (a JWT, a bearer, a 64-hex agent or conversation token), or
// a one-turn value carried as `code=` or `token=`. A `sha256:` digest and the
// 32-hex installation ID are not secrets and stay.

const SECRET_KEY = /^(token|secret|password|pem|private_key|api_key|access_token|refresh_token|id_token|device_code|user_code|code|capability|authorization|bearer)$|(?:_|-)(token|secret|key|code|capability)$/i

export function scrubFacts(value) {
  if (Array.isArray(value)) return value.map(scrubFacts)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '[redacted]' : scrubFacts(v)
    return out
  }
  return value
}

const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]'],
  [/\b(Bearer|Bot|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{25,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]'],
  [/\b(?<!sha256:)[0-9a-f]{48,}\b/gi, '[redacted]'],
  [/\b(token|secret|password|code|key|capability|session_id|api_key)=([^\s&"']+)/gi, '$1=[redacted]'],
]

export function redactDiagnostic(text) {
  let out = String(text)
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

// ---------------------------------------------------------------------------
// The report: sections, one line per check in the preflight's format, and a
// summary that decides the exit code.

const STATUS_WORD = { passed: 'ok', warning: 'warning', failed: 'failed', refused: 'refused' }

function reporter(stdout) {
  const all = []
  let current = null
  let pending = []
  let notes = []
  let printed = 0
  const write = (text) => stdout.write(redactDiagnostic(text))
  const flush = () => {
    if (current === null) return
    write(`${printed > 0 ? '\n' : ''}${current}\n`)
    printed += 1
    if (pending.length > 0) {
      const width = Math.max(...pending.map((c) => c.name.length))
      for (const c of pending) {
        write(`${STATUS_WORD[c.status].padEnd(8)} ${c.name.padEnd(width)}  ${oneLine(c.observed)}\n`)
        if (c.action) write(`${''.padEnd(9 + width + 2)}${oneLine(c.action)}\n`)
      }
    }
    for (const note of notes) write(`${note}\n`)
    notes = []
    pending = []
  }
  return {
    section(name) { flush(); current = name },
    checks(results) { for (const c of results) { all.push(c); pending.push(c) } },
    note(text) { notes.push(text) },
    finish() {
      flush()
      const count = (status) => all.filter((c) => c.status === status).length
      const broken = count('failed') + count('refused')
      const warnings = count('warning')
      const summary = [`${count('passed')} checks passed`]
      if (warnings > 0) summary.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
      if (broken > 0) summary.push(`failed: ${broken} condition${broken === 1 ? '' : 's'}`)
      write(`\n${summary.join(', ')}.\n`)
      return broken > 0 ? EXIT.failed : EXIT.ok
    },
  }
}

function oneLine(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
}
