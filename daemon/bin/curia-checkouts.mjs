#!/usr/bin/env node
// The turn-start pass over the overseer's checkouts (#312), as a command.
//
// The overseer container runs this before the model runs, once per turn:
//
//   node daemon/bin/curia-checkouts.mjs > checkouts.json
//
// It reads the watch list, clones what is missing, deletes the clone of a repo
// nobody watches, and fetches every ref of the rest in parallel. It prints one
// JSON object on stdout — the verdict per repo, which #314 turns into the lines
// the model reads about which checkout is fresh and which is stale. Progress
// goes to stderr, so a caller can read stdout alone.
//
// A COMMAND RATHER THAN A DAEMON ROUTE, because ADR-0014 makes this a turn-
// scoped act and the turn belongs to the container. The daemon asserts nothing
// about this tree. #327 decides how the container reaches this file and the
// config, the way `deploy/compose.yaml` already mounts `daemon/src` into the
// dashboard.
//
// EXIT CODES. 0 when the pass ran, WHATEVER any single repo did — a repo whose
// fetch failed is a verdict, not a crash, and the turn goes ahead reading the
// rest. 1 only when the pass itself could not run: no config, no watch list, an
// unwritable root. Then there are no checkouts at all, and the caller has a
// stdout that says so once instead of per repo.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCuriaConfig } from '../src/config.mjs'
import { syncCheckouts } from '../src/checkouts.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.CURIA_CONFIG ?? path.resolve(DIR, '..', '..', 'config', 'curia.yaml')

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1] ?? null
}

const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a)

try {
  // `checkPaths: false`: those rules ask about the daemon's own filesystem —
  // the skills root, the attach index — and this container mounts none of them.
  // The watch list and `workspace_root` are the only keys read here.
  const cfg = loadCuriaConfig(CONFIG, { checkPaths: false })
  const repos = (arg('repos') ?? '').trim()
    ? arg('repos').split(',').map((r) => r.trim()).filter(Boolean)
    : cfg.watch.map((w) => w.repo)
  const root = arg('root') ?? cfg.dispatch.workspace_root

  if (!repos.length) throw new Error(`${CONFIG} names no watched repo, so there is nothing to check out`)

  log(`fetching ${repos.length} checkout${repos.length === 1 ? '' : 's'} under ${root}`)
  const result = await syncCheckouts(root, repos)

  for (const r of result.repos) {
    if (r.ok) log(`  ${r.repo}: ${r.cloned ? 'cloned, ' : ''}${r.branch} at ${r.head.slice(0, 8)}`)
    else log(`  ${r.repo}: FAILED — ${r.error}${r.staleSince ? ` (last good fetch ${r.staleSince})` : ' (no checkout)'}`)
  }
  for (const name of result.removed) log(`  removed ${name}: no longer watched`)

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (e) {
  log(`the checkout pass could not run: ${e.message}`)
  process.stdout.write(`${JSON.stringify({ error: e.message, repos: [] }, null, 2)}\n`)
  process.exit(1)
}
