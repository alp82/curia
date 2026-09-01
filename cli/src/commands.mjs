import { readFileSync } from 'node:fs'

import { EXIT, Refusal } from './exit.mjs'
import { installationRoot, openRoot, readInstallationRecord } from './root.mjs'

export const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// One lifecycle command. `run(context)` gets `{ env, args, stdout, stderr, uid, root }`
// and returns an exit code, throws a `Refusal` to exit `refused` without a
// change, or throws any other error to exit `failed`. Commands print on their
// own streams and never call `process.exit`, which keeps every one of them
// callable from a test.
//
// Every lifecycle command enters its root through `openRoot` first, so the
// boundary refusals (root execution, foreign ownership, broad permissions,
// symbolic links, an unknown nonempty root) come before anything the command
// itself does. `version` is read-only and skips the boundary on purpose: it
// reports the root even when a lifecycle command would refuse it.
//
// The seven lifecycle commands are seams the follow-up tickets fill in. Each
// stub refuses with the same message so an operator who runs a released
// package that lacks a command learns that fact instead of a stack trace.
function notYet(name) {
  return async ({ root, uid }) => {
    openRoot(root, { uid })
    throw new Refusal(`not available in version ${packageVersion}. This release ships the launcher and command vocabulary only. Watch https://github.com/alp82/curia/issues/863 for the release that adds ${name}.`)
  }
}

async function version({ env, stdout }) {
  stdout.write(`curia ${packageVersion}\n`)
  const root = installationRoot(env)
  const record = readInstallationRecord(root)
  stdout.write(`active version: ${record ? record.activeVersion : 'none (no installation record)'}\n`)
  stdout.write(`installation root: ${root}\n`)
  return EXIT.ok
}

// Order matters: `curia help` lists the commands in lifecycle order.
export const commands = {
  install: { summary: 'Install Curia into the installation root and start it.', run: notYet('install') },
  reinstall: { summary: 'Reinstall the active version over a preserved installation root.', run: notYet('reinstall') },
  update: { summary: 'Stage, verify, and switch to the latest stable release, or to an exact version.', run: notYet('update') },
  rollback: { summary: 'Switch back to the one retained previous release.', run: notYet('rollback') },
  doctor: { summary: 'Check the host, configuration, integrations, and services. Read-only.', run: notYet('doctor') },
  uninstall: { summary: 'Remove the runnable system and keep config/, secrets/, state/, and work/.', run: notYet('uninstall') },
  purge: { summary: 'Remove the entire installation root and every Curia-labelled Docker resource, after confirmation.', run: notYet('purge') },
  version: { summary: 'Print the lifecycle interface version and the active installed version.', run: version },
}
