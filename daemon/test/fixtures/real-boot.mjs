// Waiting on a real daemon boot (#212).
//
// A boot either listens or dies. A wait that polls only the port turns a child
// that refused to boot into ten silent seconds and then a `before`-hook
// timeout, and node reports every test under that hook as `cancelled`. That
// word reads exactly like `skipped`, and a cancelled test proves nothing — so
// the count folds into a baseline an agent learns to ignore, which is how a
// whole real-boot suite goes unrun without anybody noticing.
//
// So the wait watches the CHILD as well as the port. The moment the child
// exits, the failure is its own output, said out loud and named as a boot that
// never happened.

import net from 'node:net'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The phrase every real-boot failure carries, so one grep finds all of them.
const NO_DAEMON = 'the real-boot fixture never got a daemon'

const AND_SO = 'Nothing under this hook ran against a live daemon. A cancelled test here is a boot that FAILED, never a test that was skipped.'

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.once('error', reject)
  })
}

// Collects everything the daemon child says and notices when it dies.
// `close`, not `exit`: it fires once the stdio streams are drained, so the log
// is whole before a failure message reads it.
export function watchDaemon(child) {
  let log = ''
  let end = null
  child.stdout.on('data', (c) => { log += c })
  child.stderr.on('data', (c) => { log += c })
  child.once('close', (code, signal) => { end = { code, signal } })
  return { log: () => log, end: () => end }
}

function report(headline, log) {
  return [headline, AND_SO, 'The child said:', log.trim() || '(nothing at all)'].join('\n')
}

// Polls `ready` until it answers truthily. Fails at once if the child dies
// first, and gives up loudly if neither happens in time. `what` completes the
// sentence "the child never reached ..." — say "the /state route", not "ready".
export async function waitForBoot(watch, ready, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await ready()) return
    const end = watch.end()
    if (end) {
      const how = end.signal ? `on ${end.signal}` : `with code ${end.code}`
      throw new Error(report(`${NO_DAEMON}: the child exited ${how} before it reached ${what}.`, watch.log()))
    }
    if (Date.now() > deadline) {
      throw new Error(report(`${NO_DAEMON}: ${timeoutMs} ms passed, the child never reached ${what}, and it is still running.`, watch.log()))
    }
    await sleep(50)
  }
}
