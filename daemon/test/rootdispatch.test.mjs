// A dispatch under an installation root seeds the agent container from the
// root's secret files (#891, rehearsal of #863).
//
// The rehearsal signed in to OpenAI, the reauth lane wrote
// `secrets/codex-auth.json`, the model card verified it, and the first
// dispatch refused: the codex seed still read `$HOME/.codex/auth.json`, which
// under a root is `cache/home/.codex/auth.json` and never exists. Every
// long-lived credential a spawn consumes has to come from `cfg.paths`, the
// same source the reauth lanes write and the setup cards verify.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Dispatcher } from '../src/dispatch.mjs'
import { AnthropicCredentialStore, CLAUDE_CREDENTIAL_FILE } from '../src/credentials.mjs'
import { servicePaths } from '../src/paths.mjs'
import { cfgDirFor } from '../src/workspace.mjs'
import { ensureLayout } from '../../cli/src/root.mjs'
import { writeSecret } from '../../cli/src/secrets.mjs'
import { journalDouble } from './fixtures/journal.mjs'
import { TEST_PINS } from './fixtures/sandbox.mjs'
import { TEST_ANTHROPIC_TOKEN } from './fixtures/credentials.mjs'

const ROUTING = {
  defaults: { untyped: 'sonnet', research: 'gpt' },
  models: {
    sonnet: { provider: 'anthropic', harness: 'claude' },
    gpt: { provider: 'openai', harness: 'codex', id: 'gpt-5.5' },
  },
  fallbacks: {},
  harnesses: {
    claude: {
      template: 'claude --model {model} "$(cat {prompt_file})"',
      ready: '⏵⏵|bypass permissions', toolChannelGraceS: 15, readyRe: /⏵⏵|bypass permissions/,
    },
    codex: {
      template: 'codex --model {model} "$(cat {prompt_file})"',
      ready: '·\\s[~/]', toolChannelGraceS: 15, readyRe: /·\s[~/]/,
    },
  },
}

const ISSUE = { number: 42, title: 'a ticket', body: 'body text', state: 'open', assignees: [], labels: [] }

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
const CODEX_AUTH = JSON.stringify({
  tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'r' },
})

let tmp
let root
let paths
let savedHome

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-rootdispatch-'))
  root = path.join(tmp, 'install')
  ensureLayout(root, { uid: process.getuid() })
  paths = servicePaths({ root })
  // HOME is the root's `cache/home`, the way the service container runs, and
  // it holds no `.codex` and no `.claude`: a seed that falls back to the home
  // finds nothing there.
  savedHome = process.env.HOME
  process.env.HOME = paths.home
})
afterEach(() => {
  process.env.HOME = savedHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeDispatcher({ labels = [], anthropic }) {
  const double = journalDouble(path.join(tmp, 'data'))
  const d = new Dispatcher({
    config: {
      watch: [{ repo: 'o/r', mode: 'auto' }],
      dispatch: {
        auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
        workspace_root: paths.workspaceRoot, ready_timeout_s: 1, stop_nudge_budget: 3, claim_login: 'me',
      },
      attach: { ttyd_port: 7681, serve_port: 8443 },
      identity: { allow: ['a@b.c'], proxy_port: 7682 },
      skills: null,
      sandbox: TEST_PINS,
      paths,
    },
    routing: ROUTING,
    reduction: {
      journal: (type, data) => { double.journal(type, data) },
      questions: double.questions, openEscalations: () => [], answeredExchangeFor: () => [], cancel: () => ({ ok: true }), expireAgentNotes: () => 0,
    },
    notify: () => {},
    log: () => {},
    dataDir: paths.state,
    daemonPort: 4271,
    minter: {
      tokenFor: async () => 'ghs_test',
      botIdentity: async () => ({ name: 'curia-sh[bot]', email: '1+curia-sh[bot]@users.noreply.github.com' }),
    },
    anthropic,
    deps: {
      fetchIssue: async () => ({ ...ISSUE, labels: labels.map((name) => ({ name })) }),
      claim: async () => {},
      unclaim: async () => {},
      hasSession: async () => false,
      listSessions: async () => [],
      newSession: async () => {},
      capturePane: async () => '',
      killSession: async () => {},
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
        return wt
      },
      removeWorkspace: async () => {},
      removeConfigDir: () => {},
      removeCredentials: () => {},
      probeTtyd: async () => ({ verified: true }),
      assertServe: async () => {},
      serveOff: async () => {},
      defaultBranchOf: async () => 'main',
      hasUnpushedCommits: async () => false,
      hasUncommittedChanges: async () => false,
      salvageLocalOnlyWork: async () => ({ salvaged: false, branch: null, sha: null }),
      findPullRequest: async () => null,
      ensureAgentImage: async () => ({ ref: 'curia-agent:test', built: false }),
      assertSideChannel: async () => '10.0.1.1',
      stopContainer: async () => true,
      listContainers: async () => [],
      allocatePorts: async () => [9000, 9001, 9002],
      containerPorts: async () => [],
      setGitIdentity: async () => {},
    },
  })
  d.identityProxy = { listening: true }
  return { d }
}

describe('a dispatch under an installation root seeds the container from secrets/ (#891)', () => {
  test('a codex spawn copies secrets/codex-auth.json into the config dir, with no cache/home/.codex', async () => {
    writeSecret(root, 'codex-auth.json', CODEX_AUTH)
    assert.equal(fs.existsSync(path.join(paths.home, '.codex')), false)
    const { d } = makeDispatcher({ labels: ['wayfinder:research'], anthropic: null })

    const said = await d.start('42', { repo: 'o/r', by: 'test' })

    assert.doesNotMatch(said, /failed before the agent could run/, 'the dispatch must not refuse over a credential the root holds')
    const copy = path.join(cfgDirFor(paths.workspaceRoot, 'curia-42', 'codex'), 'auth.json')
    assert.equal(fs.readFileSync(copy, 'utf8'), CODEX_AUTH)
    assert.equal(fs.lstatSync(copy).isSymbolicLink(), false)
    assert.equal(fs.lstatSync(copy).mode & 0o777, 0o400)
  })

  test('a codex spawn with no secret names the root file it looked at', async () => {
    const { d } = makeDispatcher({ labels: ['wayfinder:research'], anthropic: null })

    const said = await d.start('42', { repo: 'o/r', by: 'test' })

    assert.match(said, /failed before the agent could run/)
    assert.ok(said.includes(`${paths.codexAuth} does not exist`), said)
    assert.doesNotMatch(said, /cache\/home/)
  })

  test('a claude spawn writes the copy from secrets/anthropic.json, with no cache/home/.claude', async () => {
    const anthropic = new AnthropicCredentialStore({ file: paths.anthropicStore })
    anthropic.adopt(TEST_ANTHROPIC_TOKEN)
    assert.equal(fs.existsSync(path.join(paths.home, '.claude')), false)
    const { d } = makeDispatcher({ anthropic })

    const said = await d.start('42', { repo: 'o/r', by: 'test' })

    assert.doesNotMatch(said, /failed before the agent could run/, 'the dispatch must not refuse over a credential the root holds')
    const copy = path.join(cfgDirFor(paths.workspaceRoot, 'curia-42', 'claude'), CLAUDE_CREDENTIAL_FILE)
    assert.equal(JSON.parse(fs.readFileSync(copy, 'utf8')).claudeAiOauth.accessToken, TEST_ANTHROPIC_TOKEN)
  })
})
