import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

// The one way a lifecycle command writes a critical file: the installation
// record, operator configuration, a secret. The content goes to a fresh
// temporary file beside the target, is fsynced, and is renamed over the target
// in one step. A reader sees the old file or the new one, never a partial one,
// and a crash leaves at most a temporary file that the next write ignores.
//
// The mode is set on the temporary file at creation, so the target never
// spends a moment with broader permissions than requested. Because rename
// replaces the directory entry, a symbolic link sitting at the target is
// replaced by the file rather than followed. The directory is fsynced after the
// rename so the new entry is durable too.
export function writeAtomically(path, content, { mode }) {
  const dir = dirname(path)
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let fd
  try {
    fd = openSync(temp, 'wx', mode)
    writeSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (e) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch {}
    throw e
  }
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}
