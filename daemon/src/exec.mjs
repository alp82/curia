// One promisified execFile for every child process the daemon spawns — it was
// copy-pasted into four modules before being centralised here.
//
// The point of centralising it is the DEFAULT TIMEOUT: without
// one, a single wedged `gh`/`git`/`tmux`/`tailscale` connection blocks boot
// reconcile forever, so `startAutoLoop()` never runs and every later
// `POST /reconcile` or `/attach` queues behind it. Callers that legitimately
// take longer (clone, fetch) pass their own `timeout`.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileRaw = promisify(execFile)

export const DEFAULT_TIMEOUT_MS = 30_000

export function execFileP(file, args, options = {}) {
  return execFileRaw(file, args, {
    timeout: DEFAULT_TIMEOUT_MS,
    killSignal: 'SIGKILL', // SIGTERM is ignorable; a wedged child must actually die
    ...options,
  })
}
