// The release workflow and the stable-index workflow as text (#871). The
// publication order, the permissions each job holds, the gate each step runs,
// and the trigger shape are facts the YAML states; these tests read them the
// way GitHub will, so a change that reorders publication or widens a job
// fails here before it reaches a release.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import YAML from 'yaml'

import { RELEASE_IMAGES } from '../../cli/src/bundle.mjs'
import { RELEASE_WORKFLOW } from '../../cli/src/manifest.mjs'
import { STABLE_INDEX_PATH } from '../../cli/src/stable.mjs'
import { PUBLICATION_ORDER } from '../../deploy/release/publish.mjs'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const yaml = (file) => YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const release = yaml(RELEASE_WORKFLOW)
const index = yaml('.github/workflows/stable-index.yml')

const runs = (job) => job.steps.filter((s) => typeof s.run === 'string').map((s) => s.run)
const usesOf = (job) => job.steps.filter((s) => s.uses).map((s) => s.uses)

describe('the release workflow', () => {
  test('is the one workflow the manifest names as the signer, and there is no second release workflow', () => {
    assert.equal(RELEASE_WORKFLOW, '.github/workflows/release.yml')
    const files = fs.readdirSync(path.join(root, '.github', 'workflows')).sort()
    assert.deepEqual(files, ['ci.yml', 'pull-request-title.yml', 'release.yml', 'stable-index.yml'])
  })

  test('runs on pushes to main and on dispatch, never on a tag, and serializes publications', () => {
    assert.deepEqual(release.on, { push: { branches: ['main'] }, workflow_dispatch: null })
    assert.deepEqual(release.concurrency, { group: 'release', 'cancel-in-progress': false })
    assert.deepEqual(release.permissions, { contents: 'read' })
  })

  test('Release Please drafts the release with the app token and bumps cli/package.json alongside daemon', () => {
    const job = release.jobs['release-please']
    assert.equal(job.if, "github.event_name == 'push'")
    const mint = job.steps.find((s) => s.id === 'app-token')
    const rp = job.steps.find((s) => String(s.uses).startsWith('googleapis/release-please-action@'))
    assert.ok(mint.uses.startsWith('actions/create-github-app-token@'))
    assert.equal(rp.with.token, '${{ steps.app-token.outputs.token }}')
    assert.equal(rp.with['config-file'], 'release-please-config.json')
    const config = JSON.parse(fs.readFileSync(path.join(root, 'release-please-config.json'), 'utf8'))
    assert.equal(config.draft, true, 'the release is a draft until every asset is attached')
    assert.deepEqual(config.packages.daemon['extra-files'], [{ type: 'json', path: '/cli/package.json', jsonpath: '$.version' }])
  })

  test('publishes in dependency order: images, then the bundle onto the draft, then the release, then the package', () => {
    assert.deepEqual(PUBLICATION_ORDER, ['images', 'assets', 'release', 'package'])
    const { pins, images, bundle, publish } = release.jobs
    assert.deepEqual(pins.needs, 'release-please')
    assert.deepEqual(images.needs, 'pins')
    assert.deepEqual(bundle.needs, ['pins', 'images'])
    assert.deepEqual(publish.needs, ['pins', 'bundle'])
    assert.equal(publish.if, "needs.pins.outputs.release == 'true'")
    const steps = runs(publish)
    const releaseStep = steps.findIndex((r) => /publish\.mjs release/.test(r))
    const packageStep = steps.findIndex((r) => /publish\.mjs package/.test(r))
    const verifyStep = steps.findIndex((r) => /publish\.mjs verify/.test(r))
    assert.ok(releaseStep >= 0 && packageStep > releaseStep && verifyStep > packageStep, 'release, then package, then verify')
    assert.ok(runs(bundle).some((r) => /publish\.mjs assets/.test(r)), 'the bundle job attaches through the gate')
  })

  test('every image is planned through the gate before it is built, and the build and attestation run only on a plan to build', () => {
    const job = release.jobs.images
    assert.deepEqual(job.strategy.matrix.service, Object.keys(RELEASE_IMAGES))
    assert.deepEqual(job.strategy.matrix.service, ['daemon', 'tmux', 'dashboard', 'overseer', 'agent'])
    const plan = job.steps.find((s) => s.id === 'plan')
    assert.match(plan.run, /publish\.mjs image/)
    assert.equal(plan.env.GH_TOKEN, '${{ github.token }}')
    const login = job.steps.findIndex((s) => String(s.uses).startsWith('docker/login-action@'))
    assert.ok(login < job.steps.indexOf(plan), 'the registry is logged in before the plan asks it')
    const build = job.steps.find((s) => s.id === 'build')
    const attest = job.steps.find((s) => String(s.uses).startsWith('actions/attest-build-provenance@'))
    assert.equal(build.if, "steps.plan.outputs.build == 'true'")
    assert.equal(attest.if, "steps.plan.outputs.build == 'true'")
    assert.equal(build.with.target, 'release')
    assert.equal(build.with.provenance, false)
    assert.equal(build.with.sbom, false)
    assert.equal(attest.with['push-to-registry'], true)
    const record = job.steps.find((s) => s.name === 'Record the digest')
    assert.equal(record.env.DIGEST, "${{ steps.plan.outputs.build == 'true' && steps.build.outputs.digest || steps.plan.outputs.digest }}")
  })

  test('every image is built from its own Dockerfile with every pin the agent image declares, and the digest set names all five', () => {
    const { pins, images, bundle } = release.jobs
    const build = images.steps.find((s) => s.id === 'build')
    assert.equal(build.with.file, 'deploy/${{ matrix.service }}/Dockerfile')
    // The agent image's build arguments are the pins in config/curia.yaml,
    // the same inputs the service used to build it on the host. Every image
    // gets the same set; an argument a Dockerfile does not declare is unused.
    const args = Object.fromEntries(String(build.with['build-args']).trim().split('\n').map((l) => l.split('=')))
    assert.deepEqual(Object.keys(args), ['NODE_VERSION', 'CLAUDE_VERSION', 'CODEX_VERSION', 'GH_VERSION', 'PLAYWRIGHT_VERSION', 'TTYD_VERSION'])
    for (const [arg, value] of Object.entries(args)) {
      const output = arg.replace('_VERSION', '').toLowerCase()
      assert.equal(value, `\${{ needs.pins.outputs.${output} }}`, `${arg} comes from the pins job`)
      assert.equal(pins.outputs[output], `\${{ steps.pins.outputs.${arg} }}`, `the pins job exposes ${arg}`)
    }
    const digests = bundle.steps.find((s) => s.name === 'Write the digest set')
    assert.match(digests.run, /\["daemon", "tmux", "dashboard", "overseer", "agent"\]/)
  })

  test('each job holds only the permissions it needs, and the point of no return sits in the release environment', () => {
    const { 'release-please': rp, pins, images, bundle, publish } = release.jobs
    assert.equal(rp.permissions, undefined)
    assert.equal(pins.permissions, undefined)
    assert.deepEqual(images.permissions, { contents: 'read', packages: 'write', 'id-token': 'write', attestations: 'write' })
    assert.deepEqual(bundle.permissions, { contents: 'write' })
    assert.deepEqual(publish.permissions, { contents: 'write', 'id-token': 'write' })
    assert.equal(publish.environment, 'release')
    for (const job of Object.values(release.jobs)) {
      for (const step of job.steps) assert.ok(!step.env || !('NODE_AUTH_TOKEN' in step.env), 'no npm token: trusted publishing signs the package')
    }
  })

  test('the bundle job proves the key and attaches assets only on a release, and rehearsals publish nothing', () => {
    const bundle = release.jobs.bundle
    const key = bundle.steps.find((s) => /publish\.mjs key/.test(s.run ?? ''))
    const assets = bundle.steps.find((s) => /publish\.mjs assets/.test(s.run ?? ''))
    assert.equal(key.if, "needs.pins.outputs.release == 'true'")
    assert.equal(key.env.CURIA_STABLE_INDEX_KEY, '${{ secrets.CURIA_STABLE_INDEX_KEY }}')
    assert.equal(assets.if, "needs.pins.outputs.release == 'true'")
    const prove = bundle.steps.find((s) => s.name === 'Prove the bundle')
    for (const file of ['bundlecompose', 'bundlerelease', 'releaseimages', 'releasepublish', 'releaseworkflow', 'bootstrap']) {
      assert.match(prove.run, new RegExp(`daemon/test/${file}\\.test\\.mjs`), `the bundle job runs ${file}`)
    }
    // Compose reads its env file by path, so a process substitution leaves
    // every variable unset and the proof fails on the first `:?` expansion.
    assert.doesNotMatch(prove.run, /--env-file\s+<\(/, 'the compose proof writes a real env file')
    assert.match(prove.run, /--env-file\s+"\$RUNNER_TEMP\/bundle\.env"/, 'the compose proof reads the env file it wrote')
    for (const name of ['CURIA_ROOT', 'CURIA_UID', 'CURIA_GID', 'DOCKER_GID', 'CURIA_INSTALLATION_ID']) {
      assert.match(prove.run, new RegExp(`${name}=`), `the compose proof supplies ${name}`)
    }
  })

  test('the bundle job renders the bootstrap with the release version, keeps it with the bundle, and attaches it through the gate', () => {
    const bundle = release.jobs.bundle
    const steps = bundle.steps
    const render = steps.find((s) => /bootstrap\/render\.mjs/.test(s.run ?? ''))
    assert.ok(render, 'the bootstrap is rendered')
    assert.match(render.run, /--version "\$VERSION" --out dist/)
    assert.equal(render.env.VERSION, '${{ needs.pins.outputs.version }}')
    const prove = steps.findIndex((s) => s.name === 'Prove the bundle')
    const upload = steps.find((s) => String(s.uses).startsWith('actions/upload-artifact@'))
    const assets = steps.findIndex((s) => /publish\.mjs assets/.test(s.run ?? ''))
    assert.ok(steps.indexOf(render) < prove && prove < assets, 'rendered, then proven, then attached')
    assert.match(upload.with.path, /dist\/curia-install\.sh/)
  })

  test('every action is pinned to a full commit', () => {
    for (const workflow of [release, index]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const uses of usesOf(job)) assert.match(uses, /@[0-9a-f]{40}( #|$)/, `${uses} is not pinned to a commit`)
      }
    }
  })
})

describe('the stable-index workflow', () => {
  test('is dispatched by hand with one action and one version, and shares the release gate', () => {
    const inputs = index.on.workflow_dispatch.inputs
    assert.deepEqual(inputs.action.options, ['promote', 'withdraw'])
    assert.equal(inputs.action.required, true)
    assert.equal(inputs.version.required, true)
    assert.deepEqual(index.concurrency, { group: 'release', 'cancel-in-progress': false })
    assert.deepEqual(index.permissions, { contents: 'read' })
    assert.equal(index.jobs.index.environment, 'release')
  })

  test('verifies the published release before a promotion, signs with the secret, and commits only the index', () => {
    const job = index.jobs.index
    const verify = job.steps.find((s) => /publish\.mjs verify/.test(s.run ?? ''))
    assert.equal(verify.if, "inputs.action == 'promote'")
    const update = job.steps.find((s) => /index\.mjs "\$ACTION" "\$VERSION"/.test(s.run ?? ''))
    assert.equal(update.env.CURIA_STABLE_INDEX_KEY, '${{ secrets.CURIA_STABLE_INDEX_KEY }}')
    const commit = job.steps.find((s) => /git push/.test(s.run ?? ''))
    assert.match(commit.run, new RegExp(`git add ${STABLE_INDEX_PATH.replace('.', '\\.')}`))
    assert.match(commit.run, /git diff --cached --quiet/)
    assert.match(commit.run, /chore\(release\): promote/)
    assert.match(commit.run, /chore\(release\): withdraw/)
    assert.ok(!/docker|npm publish|gh release/.test(runs(job).join('\n')), 'a promotion touches no artifact')
    const checkout = job.steps.find((s) => String(s.uses).startsWith('actions/checkout@'))
    assert.equal(checkout.with.ref, 'main')
    assert.equal(checkout.with.token, '${{ steps.app-token.outputs.token }}')
  })
})
