import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { Refusal } from './exit.mjs'

// The lifecycle-operation lock: `run/lifecycle.lock` inside the installation
// root. One lifecycle operation runs at a time per installation. The lock file
// is created exclusively and holds the owning process id, so a second `curia`
// invocation refuses with that id instead of racing an install, update, or
// uninstall that is half done.
//
// `run/` is restart-disposable, and a crash can leave the file behind. A lock
// whose process no longer exists is taken over: the stale file is moved aside
// first, so two takers cannot both unlink a fresh lock a third process just
// created, and the exclusive create decides who wins.
export function lockPath(root) {
  return join(root, 'run', 'lifecycle.lock')
}

export async function withLifecycleLock(root, operation) {
  const path = lockPath(root)
  acquire(path)
  try {
    return await operation()
  } finally {
    try { unlinkSync(path) } catch {}
  }
}

function acquire(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const holder = holderOf(path)
      if (holder !== null) {
        throw new Refusal(`another lifecycle operation is running: process ${holder} holds ${path}. Wait for it to finish, then run the command again.`)
      }
      // Stale: no live process owns it. Move it aside, then try the create again.
      try { renameSync(path, `${path}.stale.${process.pid}`) } catch {}
      try { unlinkSync(`${path}.stale.${process.pid}`) } catch {}
      continue
    }
    try {
      writeSync(fd, `${process.pid}\n`)
    } finally {
      closeSync(fd)
    }
    return
  }
  throw new Refusal(`another lifecycle operation is running and holds ${path}. Wait for it to finish, then run the command again.`)
}

// The live process named in the lock file, or null when the file names none.
function holderOf(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  const pid = Number.parseInt(text, 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (e) {
    // EPERM means the process exists and belongs to someone else: it's alive.
    return e.code === 'EPERM' ? pid : null
  }
}
