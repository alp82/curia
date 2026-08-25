// The container seams every Dispatcher test needs (#195).
//
// Before #195 a dispatch could run a bare tmux pane, so a test could build a
// Dispatcher with no `sandbox:` config and no docker seams at all. That path is
// gone: every dispatch now prepares a container, so every test that dispatches
// has to answer for the image, the side channel and the published ports.
//
// One fixture rather than a copy per file — the answers are the same everywhere
// and a drifting copy is a test that passes for the wrong reason.

import fs from 'node:fs'
import path from 'node:path'

// The pins a test config carries. Versions match `config/curia.yaml`, but
// nothing here reaches docker: `ensureAgentImage` is stubbed below, so these
// only have to satisfy the config validator and the tag derivation.
export const TEST_PINS = {
  image: 'curia-agent',
  node_version: '24.19.0',
  claude_version: '2.1.220',
  codex_version: '0.146.0',
  opencode_version: '1.18.23',
  pi_version: '0.84.3',
  gh_version: '2.97.0',
  playwright_version: '1.62.1',
  ttyd_version: '1.7.7',
  agent_uid: 1000,
  ports: { from: 9000, to: 9299 },
}

// The workspace a dispatch gets: a real directory carrying the tracker doc,
// because that is what every watched repo has (the doc-less case is a
// deliberate override, #57), with the `.git` directory a real clone owns.
export function fakePrivateClone(root, repo, n) {
  const wt = path.join(root, 'repos', repo.replace('/', '__'), 'wt', String(n))
  fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
  return wt
}

// Everything #prepareContainer reaches through `deps`. Spread into a test's own
// deps object, ahead of its overrides.
export function containerDeps() {
  return {
    createPrivateClone: async (r, repo, n) => fakePrivateClone(r, repo, n),
    ensureAgentImage: async () => ({ ref: 'curia-agent:test', built: false }),
    assertSideChannel: async () => '10.0.1.1',
    allocatePorts: async () => [9000, 9001, 9002],
    containerPorts: async () => [],
    stopContainer: async () => true,
    listContainers: async () => [],
  }
}

// `seedConfigDir` is stubbed out in most suites, and #prepareContainer then
// writes the container env file into a directory nothing created. So the stub
// has to make the directory even when it seeds nothing into it.
export function seedConfigDirStub() {
  return (cfgDir) => { fs.mkdirSync(cfgDir, { recursive: true }) }
}

// #648 MOVED THE MODEL CREDENTIAL OFF THE ENVIRONMENT, so this no longer arms a
// dispatch: a claude spawn needs the anthropic STORE, which the dispatcher takes
// as an injected dependency (`workingAnthropicStore` in fixtures/credentials.mjs).
//
// What it is still worth doing is the opposite of what it was for. `sk-test` is
// set here so the suite proves an `ANTHROPIC_API_KEY` on the developer's box
// reaches NOTHING — the map settled subscription-only, and a test that silently
// passed because a real key was lying around would be no test at all.
export function withTestCredential() {
  const had = Object.hasOwn(process.env, 'ANTHROPIC_API_KEY')
  const old = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  return () => {
    if (had) process.env.ANTHROPIC_API_KEY = old
    else delete process.env.ANTHROPIC_API_KEY
  }
}

// The `sandbox:` block a hand-written test curia.yaml must carry since #195.
// The default container port range (9000-9299) is clear of the ephemeral ports
// `freePorts()` hands out, so a real-boot fixture can splice this in unchanged.
export function sandboxYaml() {
  return [
    'sandbox:',
    `  image: ${TEST_PINS.image}`,
    `  node_version: "${TEST_PINS.node_version}"`,
    `  claude_version: "${TEST_PINS.claude_version}"`,
    `  codex_version: "${TEST_PINS.codex_version}"`,
    `  opencode_version: "${TEST_PINS.opencode_version}"`,
    `  pi_version: "${TEST_PINS.pi_version}"`,
    `  gh_version: "${TEST_PINS.gh_version}"`,
    `  playwright_version: "${TEST_PINS.playwright_version}"`,
    `  ttyd_version: "${TEST_PINS.ttyd_version}"`,
    `  agent_uid: ${TEST_PINS.agent_uid}`,
  ]
}
