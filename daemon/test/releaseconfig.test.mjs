import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import YAML from 'yaml'

const daemon = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const root = path.dirname(daemon)
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const yaml = (file) => YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'))

describe('automatic release configuration', () => {
  test('the release manifest starts at the application version', () => {
    const pkg = json('daemon/package.json')
    const lock = json('daemon/package-lock.json')
    const manifest = json('.release-please-manifest.json')
    assert.equal(manifest.daemon, pkg.version)
    assert.equal(lock.version, pkg.version)
    assert.equal(lock.packages[''].version, pkg.version)
  })

  test('Release Please owns the daemon Node package from a fixed boundary', () => {
    const config = json('release-please-config.json')
    assert.equal(config['release-type'], 'node')
    assert.deepEqual(config.packages, { daemon: {} })
    assert.match(config['bootstrap-sha'], /^[0-9a-f]{40}$/)
    assert.equal(config['include-component-in-tag'], false)
  })

  test('the release workflow mints an app token and passes it to Release Please', () => {
    const workflow = yaml('.github/workflows/release-please.yml')
    const steps = workflow.jobs['release-please'].steps
    const mint = steps.find((step) => step.id === 'app-token')
    const release = steps.find((step) => String(step.uses).startsWith('googleapis/release-please-action@'))
    assert.ok(mint.uses.startsWith('actions/create-github-app-token@'))
    assert.equal(mint.with['permission-contents'], 'write')
    assert.equal(mint.with['permission-pull-requests'], 'write')
    assert.equal(release.with.token, '${{ steps.app-token.outputs.token }}')
    assert.equal(release.with['config-file'], 'release-please-config.json')
    assert.equal(release.with['manifest-file'], '.release-please-manifest.json')
  })

  test('the title workflow exposes one stable required-check name', () => {
    const workflow = yaml('.github/workflows/pull-request-title.yml')
    assert.equal(workflow.jobs.title.name, 'Conventional release title')
    assert.equal(workflow.jobs.title.steps.at(-1).env.PR_TITLE, '${{ github.event.pull_request.title }}')
  })
})
