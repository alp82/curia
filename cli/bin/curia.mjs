#!/usr/bin/env node

// The lifecycle interface's process entry. The installed launcher runs this
// file on the pinned runtime under versions/<active>/node with CURIA_ROOT set.
// `npm install -g @curia-sh/cli` links it as `curia` too, which is how the
// package is invoked before an installation exists.

import { endQuietlyOnClosedOutput, runCli } from '../src/cli.mjs'
import { EXIT } from '../src/exit.mjs'

// What the run has settled on so far. It stays null while a command is
// running, so a reader that closes mid-operation is told the work did not
// finish. `endQuietlyOnClosedOutput` explains both codes.
let outcome = null

endQuietlyOnClosedOutput({
  stdout: process.stdout,
  stderr: process.stderr,
  status: () => (outcome === null ? EXIT.failed : outcome),
})

outcome = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
})
process.exitCode = outcome
