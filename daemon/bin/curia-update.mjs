// Runs in the detached updater on the active release's immutable daemon image.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readUpdateRun, writeUpdateRun } from '../src/appupdate.mjs'
import { readInstallationRecord } from '../../cli/src/root.mjs'

export async function runAppUpdate({ root, execute, now = () => new Date().toISOString() }) {
  const initial = readUpdateRun(root)
  if (!initial || initial.status !== 'starting') throw new Error('No pending update request.')
  let run = { ...initial, status: 'running' }
  const save = (patch) => { run = { ...run, ...patch }; writeUpdateRun(root, run) }
  save({})
  // Only lifecycle step names are shown in the browser. Full diagnostics stay
  // in the owner-only log, never in a browser response.
  const log = fs.openSync(path.join(root, 'state', 'update.log'), 'w', 0o600)
  let line = ''
  const stdout = { write(text) {
    fs.writeSync(log, String(text))
    line += String(text)
    const lines = line.split('\n'); line = lines.pop()
    for (const text of lines) {
      const step = /^\[\d+\/\d+\] (preflight|select|acquire|stage|validate|switch)$/.exec(text)
      if (step) save({ step: step[1] })
    }
    return true
  } }
  try {
    if (readInstallationRecord(root)?.activeVersion !== run.from) throw new Error('The installed version changed before the update started.')
    await execute({ run, stdout })
    if (readInstallationRecord(root)?.activeVersion !== run.to) throw new Error('The target version did not become active.')
    save({ status: 'succeeded', finished_at: now() })
  } catch (error) {
    stdout.write(`${error.message}\n`)
    save({ status: 'failed', finished_at: now(), error: `Update failed during ${run.step ?? 'startup'}. The installed version is ${readInstallationRecord(root)?.activeVersion ?? 'unknown'}. Details are in state/update.log. Retry after resolving the error.` })
  } finally { fs.closeSync(log) }
  return run
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.CURIA_ROOT
  const run = await runAppUpdate({ root, execute: async ({ run, stdout }) => {
    const { runUpdate } = await import(pathToFileURL(path.join(root, 'versions', run.from, 'cli', 'src', 'update.mjs')).href)
    const code = await runUpdate({ root, env: process.env, args: [run.to], uid: process.getuid(), gid: process.getgid(), stdout })
    if (code !== 0) throw new Error(`Update exited with code ${code}.`)
  } })
  process.exitCode = run.status === 'succeeded' ? 0 : 1
}
