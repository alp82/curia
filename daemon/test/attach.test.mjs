// Pins for the attach surface hardening. The ttyd command lives in
// deploy/compose.yaml since #260 — these tests hold its security-relevant
// flags in place there, because nothing else would notice -O (origin check)
// silently disappearing.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeConfig, DEFAULT_REPO_ROOT } from './fixtures/compose.mjs'
import {
  probeTtyd, WRAPPER_PATH, validSessionName,
  attachUrl, atlasTerminalUrl, serveOff, DEFAULT_INDEX, CHROME_BASENAME, indexRefusal, readIndexStamp,
  stampMeta, sha256, isChatHandle, nextChatHandle,
  isConsoleKey, nextConsoleKey, consoleSession, consoleKeyForSession, sessionForConsoleKey,
} from '../src/attach.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// Resolved the way compose resolves it, not raw: the paths in this argv are
// `${CURIA_REPO_ROOT:-...}` since #473, and the pins below are about the file
// ttyd serves rather than the spelling of a variable.
const COMPOSE = composeConfig()
const TTYD_CMD = COMPOSE.services.ttyd.command

describe('the compose ttyd command (hardening pins, #260)', () => {
  test('-O (--check-origin) is present — cross-origin WebSocket upgrades must be refused', () => {
    assert.ok(TTYD_CMD.includes('-O'))
  })

  test('binds loopback only, on the health-checked port', () => {
    assert.equal(TTYD_CMD[TTYD_CMD.indexOf('-i') + 1], '127.0.0.1')
    assert.equal(TTYD_CMD[TTYD_CMD.indexOf('-p') + 1], '7681')
  })

  test('serves the whitelisting wrapper by absolute path, as the last element', () => {
    assert.ok(TTYD_CMD.includes('-a'), '-a makes ?arg= pick the session — the wrapper whitelist is why that is safe')
    assert.equal(TTYD_CMD.at(-1), `${DEFAULT_REPO_ROOT}/daemon/bin/curia-attach.sh`)
  })

  test('#69: the renderer is dom — ttyd\'s default webgl renders a BLANK terminal in Vivaldi and Firefox', () => {
    assert.equal(TTYD_CMD[TTYD_CMD.indexOf('-t') + 1], 'rendererType=dom')
  })

  test('#70: the owned index is served — no flag can add the viewport meta ttyd 1.7.7 omits', () => {
    assert.equal(TTYD_CMD[TTYD_CMD.indexOf('-I') + 1], `${DEFAULT_REPO_ROOT}/daemon/assets/attach-index.html`)
  })

  test('ttyd is writable and the terminal stays inside the identity proxy: loopback, never a published port', () => {
    assert.ok(TTYD_CMD.includes('-W'))
  })

  test('the tmux server parks a keeper session on the shared socket, and every client names the same socket', () => {
    const tmuxCmd = COMPOSE.services.tmux.command
    assert.deepEqual(tmuxCmd.slice(0, 3), ['tmux', '-S', '/run/curia-tmux/default'])
    assert.ok(tmuxCmd.includes('keeper'))
    assert.equal(COMPOSE.services.daemon.environment.CURIA_TMUX_SOCKET, '/run/curia-tmux/default')
    assert.equal(COMPOSE.services.ttyd.environment.CURIA_TMUX_SOCKET, '/run/curia-tmux/default')
  })

  test('the deploy rule outranks the restart flags: tmux survives a daemon recreate', () => {
    assert.equal(COMPOSE.services.tmux.restart, 'unless-stopped')
    assert.equal(COMPOSE.services.daemon.restart, 'on-failure')
  })

  test('the committed index was built from the ttyd the image pins — it embeds that ttyd\'s whole client bundle', () => {
    const dockerfile = fs.readFileSync(path.join(REPO, 'deploy', 'tmux', 'Dockerfile'), 'utf8')
    const pin = /ARG TTYD_VERSION=(\S+)/.exec(dockerfile)?.[1]
    assert.ok(pin, 'deploy/tmux/Dockerfile must pin TTYD_VERSION')
    const stamp = readIndexStamp(DEFAULT_INDEX)
    assert.ok(stamp?.ttyd, 'the shipped index must carry its stamp')
    assert.ok(stamp.ttyd === pin || stamp.ttyd.startsWith(`${pin}-`),
      `the index was built for ttyd ${stamp.ttyd} but deploy/tmux/Dockerfile pins ${pin} — rebuild one of them`)
  })
})

describe('the built index asset (#70)', () => {
  let tmp
  const write = (stamp, chrome) => {
    tmp = tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'curia-attach-'))
    const dir = fs.mkdtempSync(path.join(tmp, 'a-'))
    const index = path.join(dir, 'attach-index.html')
    fs.writeFileSync(index, `<!DOCTYPE html><html><head>${stamp ?? ''}</head><body></body></html>`)
    if (chrome !== null) fs.writeFileSync(path.join(dir, CHROME_BASENAME), chrome ?? 'chrome')
    return index
  }
  const stampFor = (ttyd, chrome) => stampMeta({ ttyd, chrome: sha256(chrome) })

  test('#714: the shipped index carries the touch key row, shown on a coarse pointer only', () => {
    // The embedded terminal in Atlas Chat is this page in an iframe. A phone
    // gets its Esc, Tab and arrows from here, and a desktop gets no second
    // row, so Atlas draws none of its own.
    const built = fs.readFileSync(DEFAULT_INDEX, 'utf8')
    assert.match(built, /pointer:fine/)
    assert.match(fs.readFileSync(path.join(path.dirname(DEFAULT_INDEX), CHROME_BASENAME), 'utf8'), /function coarse\(\)/)
  })

  test('the shipped asset is a real built index, and the daemon accepts it', () => {
    // Not a mock: this is the file ttyd is actually spawned with. If the
    // committed asset ever goes stale against the committed chrome source,
    // this fails in CI instead of blanking a terminal on a phone.
    const stamp = readIndexStamp(DEFAULT_INDEX)
    assert.ok(stamp?.ttyd, 'the shipped index must carry its stamp')
    assert.equal(stamp.chrome, sha256(fs.readFileSync(path.join(path.dirname(DEFAULT_INDEX), CHROME_BASENAME))),
      'the committed index was built from a different attach-chrome.html — run `npm run build-attach-index`')
    assert.equal(indexRefusal({ indexFile: DEFAULT_INDEX, log: () => {} }), null)
  })

  test('the shipped asset carries the viewport meta and the key-bar', () => {
    const head = fs.readFileSync(DEFAULT_INDEX, 'utf8').slice(0, 8192)
    assert.match(head, /<meta name="viewport" content="width=device-width/, 'ttyd 1.7.7 ships none and no flag can add one')
    assert.match(fs.readFileSync(DEFAULT_INDEX, 'utf8'), /id="curia-keybar"/, 'spike #32\'s key-bar, lost twice already')
  })

  test('an absent index refuses, naming the build command', () => {
    assert.match(indexRefusal({ indexFile: '/nope/attach-index.html', log: () => {} }), /does not exist.*build-attach-index/s)
  })

  test('an unstamped page refuses — it was not built by us', () => {
    assert.match(indexRefusal({ indexFile: write(null), log: () => {} }), /carries no curia-attach-index stamp/)
  })

  test('an index built from a different chrome source refuses — the reviewed diff is not the served one', () => {
    const f = write(stampFor('1.7.7', 'old chrome'), 'edited chrome')
    assert.match(indexRefusal({ indexFile: f, log: () => {} }), /built from a different attach-chrome\.html/)
  })

  test('A FAILED READ IS NOT EVIDENCE: no chrome source beside a custom index does not take attach down', () => {
    const logs = []
    const f = write(stampFor('1.7.7', 'chrome'), null)
    assert.equal(indexRefusal({ indexFile: f, log: (m) => logs.push(m) }), null)
    assert.ok(logs.some((m) => /NOT treating that as a mismatch/.test(m)))
  })
})

describe('probeTtyd (#260 — the health-check that replaced the spawn)', () => {
  test('a stale index refuses BEFORE the port is probed or anything is published', async () => {
    const logs = []
    const res = await probeTtyd({ ttydPort: 1, index: '/nope/attach-index.html', log: (m) => logs.push(String(m)) })
    assert.deepEqual(res, { verified: false }, 'the caller must not publish a surface nobody agreed to')
    assert.ok(logs.some((m) => /refusing to publish the attach surface/.test(m)))
  })

  test('a dead port refuses loudly, naming the compose service — the caller must withdraw, not publish', async () => {
    // find a free port, then release it: nothing listens there
    const srv = net.createServer()
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = srv.address().port
    await new Promise((resolve) => srv.close(resolve))
    const logs = []
    const res = await probeTtyd({ ttydPort: port, log: (m) => logs.push(String(m)) })
    assert.deepEqual(res, { verified: false })
    assert.ok(logs.some((m) => /compose ttyd service/.test(m)), 'the refusal must point at the service to fix')
  })

  test('a live listener with the agreed index verifies', async () => {
    const srv = net.createServer(() => {})
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
    try {
      const res = await probeTtyd({ ttydPort: srv.address().port, log: () => {} })
      assert.deepEqual(res, { verified: true })
    } finally {
      srv.close()
    }
  })
})

describe('serveOff withdrawal classification (residual 1)', () => {
  // Verified live on this host: with no rule asserted, `tailscale serve
  // --https=<port> off` exits 1 with "error: failed to remove web serve:
  // handler does not exist" — the COMMON case, since no rule is asserted on
  // a clean box. That is positive absence: the withdrawal's goal state
  // already holds. It must never surface as "withdrawal failed", or the
  // REMAINS PUBLISHED warning fires on every clean boot and trains the
  // operator to ignore the one time it is real.
  test('"handler does not exist" is positive absence — resolves and logs, never rejects', async () => {
    const logs = []
    const err = Object.assign(
      new Error('Command failed: tailscale serve --https=8443 off\nerror: failed to remove web serve: handler does not exist'),
      { stderr: 'error: failed to remove web serve: handler does not exist\n', code: 1 },
    )
    await serveOff({ servePort: 8443, log: (m) => logs.push(String(m)), exec: async () => { throw err } })
    assert.ok(logs.some((m) => /no serve rule to withdraw/.test(m)), 'positive absence is stated, not alarmed about')
  })

  test('any other failure still rejects — the REMAINS PUBLISHED path must stay reachable', async () => {
    await assert.rejects(
      () => serveOff({ servePort: 8443, log: () => {}, exec: async () => { throw new Error('tailscale: connect: connection refused') } }),
      /connection refused/,
    )
  })
})

describe('session-name gate', () => {
  test('validSessionName matches the wrapper regex', () => {
    assert.ok(validSessionName('curia-42'))
    assert.ok(!validSessionName('curia-42; rm -rf /'))
    assert.ok(!validSessionName('other-42'))
  })

  test('the wrapper path the compose command serves is the one in this repo', () => {
    assert.ok(path.isAbsolute(WRAPPER_PATH))
    assert.equal(path.relative(REPO, WRAPPER_PATH), path.join('daemon', 'bin', 'curia-attach.sh'))
  })

  test('attachUrl refuses an invalid session name', () => {
    assert.throws(() => attachUrl('host.ts.net', 8443, '42; x'))
    assert.equal(attachUrl('host.ts.net', 8443, '42'), 'https://host.ts.net:8443/?arg=curia-42')
  })

  // #241: an agent no issue answers for is named by a chat handle, and the
  // wrapper whitelist has to take it as it stands — session names were never
  // numeric-only, which is what makes this a widening of use, not of trust.
  test('a chat handle is a valid session name and reaches attach', () => {
    assert.ok(validSessionName('curia-chat-1'))
    assert.ok(isChatHandle('chat-1'))
    assert.ok(!isChatHandle('chat'))
    assert.ok(!isChatHandle('chat-1; rm -rf /'))
    assert.equal(attachUrl('host.ts.net', 8443, 'chat-2'), 'https://host.ts.net:8443/?arg=curia-chat-2')
  })

  test('Atlas owns the same-origin terminal route', () => {
    assert.equal(
      atlasTerminalUrl('host.ts.net', 9443, 'curia-42'),
      'https://host.ts.net:9443/terminal/?arg=curia-42',
    )
    assert.throws(() => atlasTerminalUrl('host.ts.net', 9443, '42; x'))
  })
})

describe('chat handles enumerate (#241)', () => {
  test('the first free index wins, and gaps are reused', () => {
    assert.equal(nextChatHandle([]), 'chat-1')
    assert.equal(nextChatHandle(['curia-chat-1']), 'chat-2')
    assert.equal(nextChatHandle(['curia-chat-1', 'curia-chat-2']), 'chat-3')
    // chat-1 ended; its index comes back rather than counting up forever
    assert.equal(nextChatHandle(['curia-chat-2', 'curia-chat-3']), 'chat-1')
  })

  test('numbered and reviewer sessions are not chat handles', () => {
    assert.equal(nextChatHandle(['curia-147', 'curia-review-42', 'other-chat-1']), 'chat-1')
  })
})

// #333, building ADR-0016. The second enumerated handle space on this box, and
// the one rule that matters is how it DIFFERS from the first: a chat handle
// takes the lowest free index because an agent is torn down whole, and a
// conversation number only goes up because a conversation is memory.
describe('console keys enumerate upward (#333)', () => {
  test('numbers only go up, and a deleted one is spent', () => {
    assert.equal(nextConsoleKey([]), 'console-1')
    assert.equal(nextConsoleKey(['console-1']), 'console-2')
    // console-1 was deleted. Its number does NOT come back: reusing it would
    // point a new conversation at the deleted one's journalled memory.
    assert.equal(nextConsoleKey(['console-1', 'console-2']), 'console-3')
    assert.equal(nextConsoleKey(['console-3']), 'console-4', 'a gap below the high mark is not filled')
  })

  test('a chat handle is not a console key, and neither takes the other\'s name', () => {
    assert.ok(isChatHandle('chat-1'))
    assert.ok(!isConsoleKey('chat-1'))
    assert.ok(isConsoleKey('console-1'))
    assert.ok(!isChatHandle('console-1'))
    // ADR-0016 rules `chat-<n>` unavailable to a conversation because it
    // already names a ticketless agent. A counter fed the wrong space must
    // therefore see nothing in it.
    assert.equal(nextConsoleKey(['chat-9', 'curia-chat-9']), 'console-1')
    assert.equal(nextChatHandle(['curia-console-9']), 'chat-1')
  })

  test('the session name and the key are each other, both ways', () => {
    assert.equal(consoleSession(3), 'curia-console-3')
    assert.equal(sessionForConsoleKey('console-3'), 'curia-console-3')
    assert.equal(consoleKeyForSession('curia-console-3'), 'console-3')
    assert.ok(validSessionName(consoleSession(3)), 'the timeline admits nothing else')
  })

  test('every other session name yields no console key', () => {
    for (const s of ['curia-147', 'curia-chat-2', 'curia-review-42', 'curia-console', 'curia-console-x', 'console-3']) {
      assert.equal(consoleKeyForSession(s), null, s)
    }
  })
})
