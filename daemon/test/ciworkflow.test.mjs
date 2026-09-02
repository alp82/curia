// The CI workflow as text, the way releaseworkflow.test.mjs reads the
// release workflow. The trigger, the order of the two suites, and the
// action pins are facts the YAML states; a change that drops a suite, runs
// the suites concurrently, or unpins an action fails here first.
//
// The workflow exists because the 0.7.0 publication (run 33636124347)
// failed in the bundle job on 20 cli tests that spawned the real
// `tailscale`, and nothing had run the suites on the pull request.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import YAML from 'yaml'

import { RELEASE_WORKFLOW } from '../../cli/src/manifest.mjs'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const yaml = (file) => YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const ci = yaml('.github/workflows/ci.yml')
const release = yaml(RELEASE_WORKFLOW)

const runs = (job) => job.steps.filter((s) => typeof s.run === 'string').map((s) => s.run.trim())
const usesOf = (job) => job.steps.filter((s) => s.uses).map((s) => s.uses)
const action = (uses) => String(uses).split('@')[0]

describe('the CI workflow', () => {
  test('runs on every pull request and on every push to main, and holds read permission only', () => {
    assert.deepEqual(ci.on, { pull_request: null, push: { branches: ['main'] } })
    assert.deepEqual(ci.permissions, { contents: 'read' })
    assert.deepEqual(Object.keys(ci.jobs), ['test'])
    assert.equal(ci.jobs.test['runs-on'], 'ubuntu-latest')
    assert.equal(ci.jobs.test.strategy, undefined, 'one job, no matrix: the suites contend for ports')
  })

  test('sets up the pinned Node the way the release workflow reads it', () => {
    const job = ci.jobs.test
    const pins = job.steps.find((s) => s.id === 'pins')
    const releasePins = release.jobs.pins.steps.find((s) => s.id === 'pins')
    assert.equal(pins.run, releasePins.run, 'the same reading of config/curia.yaml')
    const node = job.steps.find((s) => String(s.uses).startsWith('actions/setup-node@'))
    assert.equal(node.with['node-version'], '${{ steps.pins.outputs.NODE_VERSION }}')
    assert.ok(job.steps.indexOf(pins) < job.steps.indexOf(node), 'the pins are read before Node is set up')
  })

  test('installs the daemon, then runs the cli suite, then the daemon suite, one after the other', () => {
    const steps = runs(ci.jobs.test)
    const install = steps.findIndex((r) => /^npm ci --prefix daemon\b/.test(r))
    const cli = steps.findIndex((r) => r === 'npm test --prefix cli')
    const daemon = steps.findIndex((r) => r === 'npm test --prefix daemon')
    assert.ok(install >= 0 && cli > install && daemon > cli, `install, then cli, then daemon; got ${JSON.stringify(steps)}`)
    for (const step of ci.jobs.test.steps) {
      assert.ok(!/&\s*$|&\s*\n/.test(step.run ?? ''), 'no step backgrounds a suite')
    }
  })

  test('every action is pinned to the full commit the release workflow pins', () => {
    const releasePins = new Map()
    for (const job of Object.values(release.jobs)) for (const uses of usesOf(job)) releasePins.set(action(uses), uses)
    for (const uses of usesOf(ci.jobs.test)) {
      assert.match(uses, /@[0-9a-f]{40}( #|$)/, `${uses} is not pinned to a commit`)
      assert.equal(uses, releasePins.get(action(uses)), `${action(uses)} moves together with the release workflow`)
    }
  })
})
