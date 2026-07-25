// Pin for residual 5: ensureTtyd's spawn branch must not return
// verified-by-hope. spawn() with a missing TTYD_BIN emits an 'error' event
// the code deliberately swallows (an unhandled 'error' on a detached child is
// fatal in node), so a returned spawn() call proves nothing — yet `verified`
// authorises publishing the port tailnet-wide. The fix re-probes the port and
// returns verified:false when no listener ever comes up.
//
// This lives in its own file because TTYD_BIN is read at module load: the env
// var must be set BEFORE attach.mjs is imported, and attach.test.mjs already
// imports it with the real default (node --test runs each file in its own
// process, so the override cannot leak).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

process.env.TTYD_BIN = '/nonexistent/ttyd-for-this-pin'
const { ensureTtyd } = await import('../src/attach.mjs')

test('a spawn that never produces a listener returns verified:false, loudly', async () => {
  // find a free port, then release it so ensureTtyd takes the spawn branch
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  await new Promise((resolve) => srv.close(resolve))

  const logs = []
  const res = await ensureTtyd({ ttydPort: port, log: (m) => logs.push(String(m)) })

  assert.deepEqual(res, { verified: false }, 'no live listener ⇒ no publish authority — and no unread `spawned` flag in the shape')
  assert.ok(logs.some((m) => /no listener came up/.test(m)), 'the degradation is logged loudly')
})
