import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ConfigError, OPERATOR_CONFIG_KEYS, WATCH_MODES, initialOperatorConfig, operatorConfigPath,
  parseOperatorConfig, readOperatorConfig, renderOperatorConfig, writeOperatorConfig,
} from '../src/config.mjs'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'curia-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const refuses = (text, pattern) => {
  assert.throws(() => parseOperatorConfig(text, { file: 'config.yaml' }), (e) => {
    assert.ok(e instanceof ConfigError, `expected a ConfigError, got ${e.constructor.name}: ${e.message}`)
    assert.match(e.message, pattern)
    return true
  })
}

describe('the contract', () => {
  test('names the operator keys in documentation order and the watch modes', () => {
    assert.deepEqual(OPERATOR_CONFIG_KEYS, [
      'max_concurrent', 'auto_dispatch', 'poll_interval_s', 'prototype_variations', 'messages_per_send',
      'live_pane_cap', 'watch',
    ])
    assert.deepEqual(WATCH_MODES, ['auto', 'map', 'ready-for-agent'])
  })

  test('the first installation sets max_concurrent to 4 and nothing else', () => {
    assert.deepEqual(initialOperatorConfig(), { max_concurrent: 4 })
  })

  test('lives at config/config.yaml inside the installation root', () => {
    assert.equal(operatorConfigPath('/srv/curia'), '/srv/curia/config/config.yaml')
  })
})

describe('parseOperatorConfig', () => {
  test('reads every key of a hand-written file', () => {
    const config = parseOperatorConfig([
      '# a note the operator left',
      'max_concurrent: 6 # trailing note',
      'auto_dispatch: true',
      'poll_interval_s: 30',
      'prototype_variations: 3',
      'messages_per_send: 2',
      'live_pane_cap: 5',
      '',
      'watch:',
      '  - repo: alp82/curia',
      '    mode: map',
      '  - repo: "alp82/aistack"',
      '',
    ].join('\n'), { file: 'config.yaml' })
    assert.deepEqual(config, {
      max_concurrent: 6,
      auto_dispatch: true,
      poll_interval_s: 30,
      prototype_variations: 3,
      messages_per_send: 2,
      live_pane_cap: 5,
      watch: [{ repo: 'alp82/curia', mode: 'map' }, { repo: 'alp82/aistack', mode: 'auto' }],
    })
  })

  test('an empty file, or comments only, sets nothing', () => {
    assert.deepEqual(parseOperatorConfig('', { file: 'config.yaml' }), {})
    assert.deepEqual(parseOperatorConfig('# nothing yet\n\n', { file: 'config.yaml' }), {})
  })

  test('a key it does not know is refused by name, with the line', () => {
    refuses('max_concurrent: 4\nmax_agents: 9\n', /config\.yaml line 2: `max_agents` is not an operator configuration key/)
  })

  test('a key written twice is refused', () => {
    refuses('max_concurrent: 4\nmax_concurrent: 5\n', /line 2: `max_concurrent` appears twice/)
  })

  test('a line that is not key: value is refused with the line number', () => {
    refuses('max_concurrent: 4\nthis is not a setting\n', /line 2: expected `key: value`/)
    refuses('max_concurrent = 4\n', /line 1: expected `key: value`/)
  })

  test('yaml that the contract does not read is refused rather than guessed at', () => {
    refuses('watch: [{ repo: a/b }]\n', /line 1: `watch` must be a list written as `- repo: owner\/name` lines/)
    refuses('max_concurrent: &anchor 4\n', /line 1: `max_concurrent` must be a positive whole number/)
    refuses('\tmax_concurrent: 4\n', /line 1: tabs are not allowed/)
    refuses('max_concurrent: |\n  4\n', /line 1: `max_concurrent` must be a positive whole number/)
  })

  test('each value is checked against its rule, and the message names the key and the rule', () => {
    refuses('max_concurrent: 0\n', /`max_concurrent` must be a positive whole number \(got 0\)/)
    refuses('max_concurrent: 2.5\n', /`max_concurrent` must be a positive whole number \(got 2\.5\)/)
    refuses('max_concurrent: four\n', /`max_concurrent` must be a positive whole number \(got four\)/)
    refuses('auto_dispatch: yes\n', /`auto_dispatch` must be true or false \(got yes\)/)
    refuses('poll_interval_s: -1\n', /`poll_interval_s` must be a positive number \(got -1\)/)
    refuses('prototype_variations: 0\n', /`prototype_variations` must be a positive whole number/)
    refuses('messages_per_send: 5\n', /`messages_per_send` must be a whole number from 1 through 4 \(got 5\)/)
    refuses('live_pane_cap: 1.5\n', /`live_pane_cap` must be a positive whole number/)
  })

  test('the watch list is checked entry by entry', () => {
    refuses('watch:\n  - repo: not-a-repo\n', /line 2: `watch` entry 1: `repo` must be `owner\/name` \(got not-a-repo\)/)
    refuses('watch:\n  - mode: map\n', /line 2: `watch` entry 1 needs a `repo`/)
    refuses('watch:\n  - repo: a/b\n    mode: sometimes\n', /line 3: `watch` entry 1: `mode` must be one of auto, map, ready-for-agent \(got sometimes\)/)
    refuses('watch:\n  - repo: a/b\n    branch: main\n', /line 3: `watch` entry 1: `branch` is not a watch entry key/)
    refuses('watch:\n  - repo: a/b\n  - repo: a/b\n', /line 3: `watch` lists a\/b twice/)
    refuses('watch:\n', /line 1: `watch` must list at least one `- repo: owner\/name` entry/)
    refuses('watch: alp82/curia\n', /line 1: `watch` must be a list written as `- repo: owner\/name` lines/)
  })

  test('a scalar key that is given a list is refused', () => {
    refuses('max_concurrent:\n  - 4\n', /line 1: `max_concurrent` must be a positive whole number/)
  })
})

describe('renderOperatorConfig', () => {
  test('prints the keys in contract order under a header, and reads back the same', () => {
    const config = {
      watch: [{ repo: 'alp82/aistack', mode: 'auto' }, { repo: 'alp82/curia', mode: 'map' }],
      auto_dispatch: false,
      max_concurrent: 4,
    }
    const text = renderOperatorConfig(config)
    assert.match(text, /^# Curia operator configuration/)
    assert.equal(text.slice(text.indexOf('\nmax_concurrent')), [
      '',
      'max_concurrent: 4',
      'auto_dispatch: false',
      'watch:',
      '  - repo: alp82/aistack',
      '  - repo: alp82/curia',
      '    mode: map',
      '',
    ].join('\n'))
    assert.deepEqual(parseOperatorConfig(text, { file: 'config.yaml' }), {
      max_concurrent: 4,
      auto_dispatch: false,
      watch: [{ repo: 'alp82/aistack', mode: 'auto' }, { repo: 'alp82/curia', mode: 'map' }],
    })
  })

  test('the initial configuration renders to one setting', () => {
    const text = renderOperatorConfig(initialOperatorConfig())
    assert.deepEqual(text.split('\n').filter((l) => l && !l.startsWith('#')), ['max_concurrent: 4'])
  })

  test('refuses to render what it would refuse to read', () => {
    assert.throws(() => renderOperatorConfig({ max_concurrent: 0 }), ConfigError)
    assert.throws(() => renderOperatorConfig({ colour: 'blue' }), /`colour` is not an operator configuration key/)
  })
})

describe('readOperatorConfig and writeOperatorConfig', () => {
  test('a root without the file reads as null', () => {
    assert.equal(readOperatorConfig(join(dir, 'config', 'config.yaml')), null)
  })

  test('the write validates first, then lands atomically with owner-only mode', () => {
    mkdirSync(join(dir, 'config'))
    const path = join(dir, 'config', 'config.yaml')
    writeOperatorConfig(path, { max_concurrent: 4 })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(join(dir, 'config')), ['config.yaml'])
    assert.deepEqual(readOperatorConfig(path), { max_concurrent: 4 })
  })

  test('an invalid write changes nothing on disk', () => {
    mkdirSync(join(dir, 'config'))
    const path = join(dir, 'config', 'config.yaml')
    writeOperatorConfig(path, { max_concurrent: 4 })
    const before = readFileSync(path, 'utf8')
    assert.throws(() => writeOperatorConfig(path, { max_concurrent: 4, messages_per_send: 9 }), ConfigError)
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.deepEqual(readdirSync(join(dir, 'config')), ['config.yaml'])
  })

  test('a direct edit that breaks the file is reported with the path and the line', () => {
    mkdirSync(join(dir, 'config'))
    const path = join(dir, 'config', 'config.yaml')
    writeFileSync(path, 'max_concurrent: 4\nauto_dispatch: maybe\n')
    assert.throws(() => readOperatorConfig(path), (e) => {
      assert.ok(e instanceof ConfigError)
      assert.equal(e.message, `${path} line 2: \`auto_dispatch\` must be true or false (got maybe)`)
      return true
    })
  })

  test('a symbolic link at the file is refused', () => {
    mkdirSync(join(dir, 'config'))
    writeFileSync(join(dir, 'elsewhere.yaml'), 'max_concurrent: 4\n')
    symlinkSync(join(dir, 'elsewhere.yaml'), join(dir, 'config', 'config.yaml'))
    assert.throws(() => readOperatorConfig(join(dir, 'config', 'config.yaml')), /is a symbolic link/)
  })

  test('concurrent writers never leave a torn or half-written file', () => {
    mkdirSync(join(dir, 'config'))
    const path = join(dir, 'config', 'config.yaml')
    const script = join(dir, 'writer.mjs')
    writeFileSync(script, [
      `import { writeOperatorConfig } from ${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)}`,
      'const n = Number(process.argv[2])',
      'for (let i = 0; i < 25; i++) {',
      `  writeOperatorConfig(${JSON.stringify(path)}, { max_concurrent: n, watch: [{ repo: \`w\${n}/r\${i}\`, mode: 'auto' }] })`,
      '}',
      '',
    ].join('\n'))
    const writers = [1, 2, 3, 4, 5, 6].map((n) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, String(n)], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} exited ${code}: ${stderr}`))))
    }))
    return Promise.all(writers).then(() => {
      const config = readOperatorConfig(path)
      assert.ok([1, 2, 3, 4, 5, 6].includes(config.max_concurrent))
      assert.deepEqual(config.watch, [{ repo: `w${config.max_concurrent}/r24`, mode: 'auto' }], 'the file is one writer\'s last complete write')
      assert.deepEqual(readdirSync(join(dir, 'config')), ['config.yaml'], 'no temporary file survives')
      assert.equal(statSync(path).mode & 0o777, 0o600)
    })
  })
})
