#!/usr/bin/env node

// The lifecycle interface's process entry. The installed launcher runs this
// file on the pinned runtime under versions/<active>/node with CURIA_ROOT set.
// `npm install -g @curia-sh/cli` links it as `curia` too, which is how the
// package is invoked before an installation exists.

import { runCli } from '../src/cli.mjs'

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
})
