// The preflight's port list is the bundle's port list (#868).
//
// cli/src/preflight.mjs names the loopback ports and the sandbox range it
// tests before an installation, and config/curia.yaml is where the service
// binds them. The lifecycle interface has no dependencies and does not read
// the shipped configuration, so the two are written twice. This test is what
// keeps them one fact.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

import { REQUIRED_PORTS, SANDBOX_PORTS } from '../../cli/src/preflight.mjs'
import { APP_SERVE_PORT } from '../../cli/src/install.mjs'

const curia = parse(readFileSync(fileURLToPath(new URL('../../config/curia.yaml', import.meta.url)), 'utf8'))

describe('the preflight ports mirror config/curia.yaml', () => {
  test('the five required loopback ports are the ones the services bind', () => {
    const bound = [curia.timeline.port, curia.dashboard.port, curia.overseer.port, curia.attach.ttyd_port, curia.identity.proxy_port].sort()
    assert.deepEqual(REQUIRED_PORTS.map((p) => p.port).sort(), bound)
  })

  test('the app address curia install reports uses the Curia app Serve port', () => {
    assert.equal(APP_SERVE_PORT, curia.dashboard.serve_port)
  })

  test('the sandbox range is the one agents publish into', () => {
    assert.equal(SANDBOX_PORTS.from, curia.sandbox.port_from)
    assert.equal(SANDBOX_PORTS.to, curia.sandbox.port_to)
  })
})
