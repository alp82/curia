import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, statSync, readdirSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  installationRoot,
  openRoot,
  ensureLayout,
  BOUNDARIES,
  createInstallationRecord,
  writeInstallationRecord,
  readInstallationRecord,
  recordPath,
} from '../src/root.mjs'
import { Refusal } from '../src/exit.mjs'

const me = process.getuid()

let home
let root

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'curia-root-'))
  root = join(home, 'curia')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function refuses(fn, pattern) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof Refusal, `expected a Refusal, got ${e.name}: ${e.message}`)
    assert.match(e.message, pattern)
    return true
  })
}

describe('installationRoot', () => {
  test('CURIA_ROOT wins, then XDG_DATA_HOME, then ~/.local/share', () => {
    assert.equal(installationRoot({ CURIA_ROOT: '/srv/curia', XDG_DATA_HOME: '/x', HOME: '/h' }), '/srv/curia')
    assert.equal(installationRoot({ XDG_DATA_HOME: '/x', HOME: '/h' }), '/x/curia')
    assert.equal(installationRoot({ HOME: '/h' }), '/h/.local/share/curia')
  })
})

describe('openRoot', () => {
  test('an absent root is reported as absent', () => {
    assert.deepEqual(openRoot(root, { uid: me }), { root, status: 'absent', record: null })
  })

  test('an empty directory is reported as empty', () => {
    mkdirSync(root, { mode: 0o700 })
    assert.deepEqual(openRoot(root, { uid: me }), { root, status: 'empty', record: null })
  })

  test('a root with an installation record is reported as installed with that record', () => {
    ensureLayout(root, { uid: me })
    const record = createInstallationRecord('1.2.3')
    writeInstallationRecord(root, record)
    assert.deepEqual(openRoot(root, { uid: me }), { root, status: 'installed', record })
  })

  test('refuses root execution before it looks at the filesystem', () => {
    refuses(() => openRoot(root, { uid: 0 }), /runs as root/)
    assert.equal(readdirSync(home).length, 0)
  })

  test('refuses a relative root', () => {
    refuses(() => openRoot('curia', { uid: me }), /absolute path/)
  })

  test('refuses a root owned by another user', () => {
    mkdirSync(root, { mode: 0o700 })
    refuses(() => openRoot(root, { uid: me + 1 }), /owned by user \d+, not by you/)
  })

  test('refuses a root that group or other users can reach', () => {
    mkdirSync(root, { mode: 0o750 })
    refuses(() => openRoot(root, { uid: me }), /mode 0750/)
  })

  test('refuses a root that is a symbolic link', () => {
    mkdirSync(join(home, 'real'), { mode: 0o700 })
    symlinkSync(join(home, 'real'), root)
    refuses(() => openRoot(root, { uid: me }), /symbolic link/)
  })

  test('refuses a boundary directory that is a symbolic link', () => {
    ensureLayout(root, { uid: me })
    writeInstallationRecord(root, createInstallationRecord('1.2.3'))
    rmSync(join(root, 'secrets'), { recursive: true })
    mkdirSync(join(home, 'elsewhere'), { mode: 0o700 })
    symlinkSync(join(home, 'elsewhere'), join(root, 'secrets'))
    refuses(() => openRoot(root, { uid: me }), /secrets.*symbolic link/)
  })

  test('refuses a boundary directory with broad permissions', () => {
    ensureLayout(root, { uid: me })
    writeInstallationRecord(root, createInstallationRecord('1.2.3'))
    chmodSync(join(root, 'config'), 0o755)
    refuses(() => openRoot(root, { uid: me }), /config.*mode 0755/)
  })

  test('refuses a record that is a symbolic link', () => {
    ensureLayout(root, { uid: me })
    writeFileSync(join(home, 'record.json'), '{}')
    symlinkSync(join(home, 'record.json'), recordPath(root))
    refuses(() => openRoot(root, { uid: me }), /installation\.json.*symbolic link/)
  })

  test('refuses an unknown nonempty root', () => {
    mkdirSync(root, { mode: 0o700 })
    writeFileSync(join(root, 'notes.txt'), 'hello')
    refuses(() => openRoot(root, { uid: me }), /not a Curia installation/)
  })

  test('refuses a root that is a file', () => {
    writeFileSync(root, 'x')
    refuses(() => openRoot(root, { uid: me }), /not a directory/)
  })

  test('a malformed record is a failure, not a refusal and not an empty root', () => {
    ensureLayout(root, { uid: me })
    writeFileSync(recordPath(root), '{"format": 1}', { mode: 0o600 })
    assert.throws(() => openRoot(root, { uid: me }), (e) => !(e instanceof Refusal) && /not a Curia installation record/.test(e.message))
  })
})

describe('ensureLayout', () => {
  test('creates the root and the seven boundaries with mode 0700', () => {
    ensureLayout(root, { uid: me })
    assert.equal(statSync(root).mode & 0o777, 0o700)
    assert.deepEqual(BOUNDARIES, ['config', 'secrets', 'state', 'work', 'versions', 'cache', 'run'])
    for (const name of BOUNDARIES) {
      assert.equal(statSync(join(root, name)).mode & 0o777, 0o700, `${name} is 0700`)
    }
    assert.deepEqual(readdirSync(root).sort(), [...BOUNDARIES].sort())
  })

  test('creates the root under missing parents without widening them past the process umask', () => {
    root = join(home, 'a', 'b', 'curia')
    ensureLayout(root, { uid: me })
    assert.equal(statSync(root).mode & 0o777, 0o700)
    assert.ok((statSync(join(home, 'a')).mode & 0o022) === 0)
  })

  test('is idempotent and adds a missing boundary to an existing root', () => {
    ensureLayout(root, { uid: me })
    rmSync(join(root, 'cache'), { recursive: true })
    ensureLayout(root, { uid: me })
    assert.equal(statSync(join(root, 'cache')).mode & 0o777, 0o700)
  })

  test('does not repair a boundary with broad permissions', () => {
    ensureLayout(root, { uid: me })
    chmodSync(join(root, 'work'), 0o755)
    refuses(() => ensureLayout(root, { uid: me }), /work.*mode 0755/)
    assert.equal(statSync(join(root, 'work')).mode & 0o777, 0o755)
  })
})

describe('the installation record', () => {
  test('createInstallationRecord holds only the format, a random id, and the active version', () => {
    const a = createInstallationRecord('1.2.3')
    const b = createInstallationRecord('1.2.3')
    assert.deepEqual(Object.keys(a).sort(), ['activeVersion', 'format', 'installationId'])
    assert.equal(a.format, 1)
    assert.equal(a.activeVersion, '1.2.3')
    assert.match(a.installationId, /^[0-9a-f]{32}$/)
    assert.notEqual(a.installationId, b.installationId)
  })

  test('writeInstallationRecord writes an owner-only file the launcher can parse', () => {
    ensureLayout(root, { uid: me })
    writeInstallationRecord(root, createInstallationRecord('1.2.3'))
    assert.equal(statSync(recordPath(root)).mode & 0o777, 0o600)
    const text = readFileSync(recordPath(root), 'utf8')
    assert.match(text, /^  "activeVersion": "1\.2\.3",?$/m)
    assert.equal(readInstallationRecord(root).activeVersion, '1.2.3')
  })

  test('writeInstallationRecord rejects a record with a foreign key', () => {
    ensureLayout(root, { uid: me })
    assert.throws(() => writeInstallationRecord(root, { ...createInstallationRecord('1.2.3'), operator: 'alp' }), /operator/)
  })
})
