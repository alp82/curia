import { readFileSync } from 'node:fs'

import { EXIT } from './exit.mjs'
import { installationRoot, readInstallationRecord } from './root.mjs'
import { installCommand } from './install.mjs'
import { runDoctor } from './doctor.mjs'
import { updateCommand } from './update.mjs'
import { rollbackCommand } from './rollback.mjs'
import { uninstallCommand } from './uninstall.mjs'
import { purgeCommandRun } from './purge.mjs'

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
  install: { summary: 'Install Curia into the installation root and start it, joining the tailnet as --name <machine-name> (default curia) when the node is not logged in.', run: installCommand('install'), options: true },
  reinstall: { summary: 'Reinstall this version over a preserved installation root, keeping its identity, configuration, secrets, state, and work.', run: installCommand('reinstall') },
  update: { summary: 'Stage, verify, and switch to the latest stable release, or to an exact version (--prerelease for an exact prerelease).', run: updateCommand, options: true },
  rollback: { summary: 'Switch back to the one retained previous release, after it validates the current configuration.', run: rollbackCommand },
  doctor: { summary: 'Check the host, configuration, integrations, and services. Read-only.', run: runDoctor },
  uninstall: { summary: 'Stop Curia and remove the launcher, versions/, cache/, run/, the installation\'s containers, networks, volumes, and Serve routes; keep config/, secrets/, state/, and work/ for a reinstall.', run: uninstallCommand },
  purge: { summary: 'Remove the entire installation root, every Curia-labelled Docker resource, the unused release images, and the Serve routes, after one confirmation (type the root, or pass --confirm <root>).', run: purgeCommandRun, options: true },
  version: { summary: 'Print the lifecycle interface version and the active installed version.', run: version },
}
