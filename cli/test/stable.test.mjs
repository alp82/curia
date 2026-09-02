import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { Writable } from 'node:stream'

import {
  STABLE_INDEX_FORMAT, STABLE_INDEX_PATH, STABLE_INDEX_URL, STABLE_INDEX_KEY_FILE,
  StableIndexError, isPrerelease, releaseNotesUrl,
  createStableIndex, renderStableIndex, parseStableIndex,
  generateStableIndexKeys, keyFingerprint, signStableIndex, verifyStableIndex,
  promote, withdraw, selectRelease, selectionFromArgs,
  fetchStableIndex, renderSelection,
} from '../src/stable.mjs'
import { Refusal } from '../src/exit.mjs'

const NOW = '2026-09-02T10:00:00Z'
const LATER = '2026-09-03T10:00:00Z'

const keys = generateStableIndexKeys()
const otherKeys = generateStableIndexKeys()

function refuses(fn, pattern) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof Refusal, `expected a Refusal, got ${e.name}: ${e.message}`)
    assert.match(e.message, pattern)
    return true
  })
}

function rejects(fn, pattern) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof StableIndexError, `expected a StableIndexError, got ${e.name}: ${e.message}`)
    assert.match(e.message, pattern)
    return true
  })
}

function signed(index, { privateKey = keys.privateKey } = {}) {
  return signStableIndex(index, privateKey)
}

function sink() {
  const chunks = []
  const stream = new Writable({ write(chunk, _e, cb) { chunks.push(String(chunk)); cb() } })
  stream.text = () => chunks.join('')
  return stream
}

describe('the contract', () => {
  test('one format, one file in the repository, one URL, one pinned key file', () => {
    assert.equal(STABLE_INDEX_FORMAT, 1)
    assert.equal(STABLE_INDEX_PATH, 'release/stable.json')
    assert.equal(STABLE_INDEX_URL, 'https://raw.githubusercontent.com/alp82/curia/main/release/stable.json')
    assert.equal(STABLE_INDEX_KEY_FILE, 'stable-index.pub')
  })

  test('a prerelease is a version with a hyphenated suffix', () => {
    assert.equal(isPrerelease('1.2.3'), false)
    assert.equal(isPrerelease('1.2.3-rc.1'), true)
    assert.equal(isPrerelease('1.2.3-rehearsal.abc1234'), true)
    assert.equal(isPrerelease('not a version'), false)
  })

  test('release notes live on the GitHub release of the tag', () => {
    assert.equal(releaseNotesUrl('1.2.3'), 'https://github.com/alp82/curia/releases/tag/v1.2.3')
  })
})

describe('the index', () => {
  test('starts empty: no stable release, nothing withdrawn, sequence zero', () => {
    const index = createStableIndex({ updated: NOW })
    assert.deepEqual(index, { format: 1, sequence: 0, updated: NOW, stable: null, withdrawn: [] })
  })

  test('renders in contract order with one trailing newline, and parses back to the same thing', () => {
    const index = createStableIndex({ sequence: 3, updated: NOW, stable: '1.2.3', withdrawn: ['1.2.2', '1.1.0'] })
    const text = renderStableIndex(index)
    assert.equal(text, [
      '{',
      '  "format": 1,',
      '  "sequence": 3,',
      `  "updated": "${NOW}",`,
      '  "stable": "1.2.3",',
      '  "withdrawn": [',
      '    "1.1.0",',
      '    "1.2.2"',
      '  ]',
      '}',
      '',
    ].join('\n'))
    assert.deepEqual(parseStableIndex(text), { ...index, withdrawn: ['1.1.0', '1.2.2'] })
  })

  test('refuses a stable release that is a prerelease, withdrawn, or not a version', () => {
    rejects(() => createStableIndex({ updated: NOW, stable: '1.2.3-rc.1' }), /stable must not be a prerelease/)
    rejects(() => createStableIndex({ updated: NOW, stable: '1.2.3', withdrawn: ['1.2.3'] }), /stable 1\.2\.3 is withdrawn/)
    rejects(() => createStableIndex({ updated: NOW, stable: 'v1.2.3' }), /stable must be a release version/)
  })

  test('refuses a malformed sequence, timestamp, withdrawn list, or a key outside the contract', () => {
    rejects(() => createStableIndex({ sequence: -1, updated: NOW }), /sequence must be a nonnegative integer/)
    rejects(() => createStableIndex({ sequence: 1.5, updated: NOW }), /sequence must be a nonnegative integer/)
    rejects(() => createStableIndex({ updated: 'yesterday' }), /updated must be an ISO 8601 UTC timestamp/)
    rejects(() => createStableIndex({ updated: NOW, withdrawn: ['nope'] }), /withdrawn\[0\] must be a release version/)
    rejects(() => createStableIndex({ updated: NOW, withdrawn: '1.2.3' }), /withdrawn must be an array/)
    rejects(() => parseStableIndex('{"format":1,"sequence":0,"updated":"2026-09-02T10:00:00Z","stable":null,"withdrawn":[],"notes":"x"}'), /notes is not part of the index/)
    rejects(() => parseStableIndex('{"format":2}'), /format must be 1/)
    rejects(() => parseStableIndex('not json'), /not JSON/)
  })
})

describe('signing', () => {
  test('a generated key pair is Ed25519 with a fingerprint the signature names', () => {
    assert.match(keys.publicKey, /^-----BEGIN PUBLIC KEY-----\n/)
    assert.match(keys.privateKey, /^-----BEGIN PRIVATE KEY-----\n/)
    assert.equal(createPrivateKey(keys.privateKey).asymmetricKeyType, 'ed25519')
    assert.equal(createPublicKey(keys.publicKey).asymmetricKeyType, 'ed25519')
    assert.match(keys.fingerprint, /^[0-9a-f]{16}$/)
    assert.equal(keyFingerprint(keys.publicKey), keys.fingerprint)
    assert.notEqual(keys.fingerprint, otherKeys.fingerprint)
  })

  test('a signed index verifies with the matching public key and comes back as the index', () => {
    const index = createStableIndex({ sequence: 1, updated: NOW, stable: '1.2.3' })
    const text = signed(index)
    const envelope = JSON.parse(text)
    assert.deepEqual(Object.keys(envelope), ['index', 'signature'])
    assert.deepEqual(envelope.signature.algorithm, 'ed25519')
    assert.equal(envelope.signature.key, keys.fingerprint)
    assert.match(envelope.signature.value, /^[A-Za-z0-9+/]+=*$/)
    assert.deepEqual(verifyStableIndex(text, { publicKey: keys.publicKey }), index)
  })

  test('signing is deterministic, so the same index signed twice is the same file', () => {
    const index = createStableIndex({ sequence: 1, updated: NOW, stable: '1.2.3' })
    assert.equal(signed(index), signed(index))
  })

  test('another key, a changed byte, or a stripped signature fails closed', () => {
    const index = createStableIndex({ sequence: 1, updated: NOW, stable: '1.2.3' })
    const text = signed(index)
    rejects(() => verifyStableIndex(text, { publicKey: otherKeys.publicKey }), new RegExp(`signed with key ${keys.fingerprint}, and this version pins key ${otherKeys.fingerprint}`))
    const tampered = text.replace('"stable": "1.2.3"', '"stable": "1.2.4"')
    assert.notEqual(tampered, text)
    rejects(() => verifyStableIndex(tampered, { publicKey: keys.publicKey }), /signature does not verify/)
    const envelope = JSON.parse(text)
    delete envelope.signature
    rejects(() => verifyStableIndex(JSON.stringify(envelope), { publicKey: keys.publicKey }), /signature is missing/)
    rejects(() => verifyStableIndex(JSON.stringify({ ...JSON.parse(text), signature: { algorithm: 'rsa', key: keys.fingerprint, value: 'AAAA' } }), { publicKey: keys.publicKey }), /signature.algorithm must be ed25519/)
    rejects(() => verifyStableIndex(text, { publicKey: null }), /no stable-index public key is pinned/)
    rejects(() => verifyStableIndex('[]', { publicKey: keys.publicKey }), /must be a JSON object/)
  })

  test('the signed bytes are the canonical index, so a reordered but equal index still verifies', () => {
    const index = createStableIndex({ sequence: 1, updated: NOW, stable: '1.2.3', withdrawn: ['1.0.0'] })
    const envelope = JSON.parse(signed(index))
    const reordered = JSON.stringify({ signature: envelope.signature, index: { withdrawn: ['1.0.0'], stable: '1.2.3', updated: NOW, sequence: 1, format: 1 } })
    assert.deepEqual(verifyStableIndex(reordered, { publicKey: keys.publicKey }), index)
  })
})

describe('promotion', () => {
  const empty = createStableIndex({ updated: NOW })

  test('names the version as the stable release and advances the sequence and the timestamp', () => {
    const next = promote(empty, '1.2.3', { updated: LATER })
    assert.deepEqual(next, { format: 1, sequence: 1, updated: LATER, stable: '1.2.3', withdrawn: [] })
    assert.deepEqual(empty, { format: 1, sequence: 0, updated: NOW, stable: null, withdrawn: [] }, 'the input is not changed')
  })

  test('replaces the previous stable release without touching the withdrawn list', () => {
    const before = createStableIndex({ sequence: 4, updated: NOW, stable: '1.2.3', withdrawn: ['1.1.0'] })
    assert.deepEqual(promote(before, '1.3.0', { updated: LATER }), { format: 1, sequence: 5, updated: LATER, stable: '1.3.0', withdrawn: ['1.1.0'] })
  })

  test('promoting the current stable release changes nothing', () => {
    const before = createStableIndex({ sequence: 4, updated: NOW, stable: '1.2.3' })
    assert.deepEqual(promote(before, '1.2.3', { updated: LATER }), before)
  })

  test('refuses a prerelease, a withdrawn version, and a malformed version', () => {
    refuses(() => promote(empty, '1.3.0-rc.1', { updated: LATER }), /1\.3\.0-rc\.1 is a prerelease, and a prerelease is never the stable release/)
    const withdrawn = createStableIndex({ updated: NOW, withdrawn: ['1.2.3'] })
    refuses(() => promote(withdrawn, '1.2.3', { updated: LATER }), /1\.2\.3 is withdrawn/)
    refuses(() => promote(empty, 'v1.2.3', { updated: LATER }), /not a release version/)
  })
})

describe('withdrawal', () => {
  test('adds the version to the withdrawn list, sorted, and keeps the stable release', () => {
    const before = createStableIndex({ sequence: 4, updated: NOW, stable: '1.2.3', withdrawn: ['1.2.0'] })
    const next = withdraw(before, '1.1.0', { updated: LATER })
    assert.deepEqual(next, { format: 1, sequence: 5, updated: LATER, stable: '1.2.3', withdrawn: ['1.1.0', '1.2.0'] })
  })

  test('withdrawing the stable release leaves no stable release, so automatic selection stops', () => {
    const before = createStableIndex({ sequence: 4, updated: NOW, stable: '1.2.3' })
    const next = withdraw(before, '1.2.3', { updated: LATER })
    assert.deepEqual(next, { format: 1, sequence: 5, updated: LATER, stable: null, withdrawn: ['1.2.3'] })
  })

  test('withdrawing a withdrawn version changes nothing', () => {
    const before = createStableIndex({ sequence: 4, updated: NOW, withdrawn: ['1.2.3'] })
    assert.deepEqual(withdraw(before, '1.2.3', { updated: LATER }), before)
  })

  test('a prerelease can be withdrawn too, and a malformed version is refused', () => {
    const before = createStableIndex({ sequence: 0, updated: NOW })
    assert.deepEqual(withdraw(before, '1.3.0-rc.1', { updated: LATER }).withdrawn, ['1.3.0-rc.1'])
    refuses(() => withdraw(before, 'latest', { updated: LATER }), /not a release version/)
  })
})

describe('selection', () => {
  const index = createStableIndex({ sequence: 7, updated: NOW, stable: '1.2.3', withdrawn: ['1.2.2', '1.3.0-rc.1'] })

  test('with nothing requested, selects the stable release', () => {
    assert.deepEqual(selectRelease(index, {}), { version: '1.2.3', selection: 'stable' })
    assert.deepEqual(selectRelease(index), { version: '1.2.3', selection: 'stable' })
  })

  test('with no stable release named, refuses and says so', () => {
    refuses(() => selectRelease(createStableIndex({ updated: NOW }), {}), /no stable release is recommended right now/)
  })

  test('an exact version is selected as requested, whether or not it is the stable one', () => {
    assert.deepEqual(selectRelease(index, { requested: '1.2.3' }), { version: '1.2.3', selection: 'exact' })
    assert.deepEqual(selectRelease(index, { requested: '1.2.4' }), { version: '1.2.4', selection: 'exact' })
    assert.deepEqual(selectRelease(index, { requested: '1.0.0' }), { version: '1.0.0', selection: 'exact' })
  })

  test('a withdrawn version is refused, exact or not, with the release notes to read', () => {
    refuses(() => selectRelease(index, { requested: '1.2.2' }), /1\.2\.2 is withdrawn.*releases\/tag\/v1\.2\.2/)
    refuses(() => selectRelease(index, { requested: '1.3.0-rc.1', prerelease: true }), /1\.3\.0-rc\.1 is withdrawn/)
  })

  test('a prerelease is never selected without the explicit prerelease request', () => {
    refuses(() => selectRelease(index, { requested: '1.3.0-rc.2' }), /1\.3\.0-rc\.2 is a prerelease.*--prerelease/)
    assert.deepEqual(selectRelease(index, { requested: '1.3.0-rc.2', prerelease: true }), { version: '1.3.0-rc.2', selection: 'prerelease' })
  })

  test('the prerelease request needs an exact version, and never selects the stable release', () => {
    refuses(() => selectRelease(index, { prerelease: true }), /--prerelease needs an exact version/)
    refuses(() => selectRelease(index, { requested: '1.2.4', prerelease: true }), /1\.2\.4 is not a prerelease/)
  })

  test('a malformed request is refused before anything is looked up', () => {
    refuses(() => selectRelease(index, { requested: 'latest' }), /latest is not a release version/)
    refuses(() => selectRelease(index, { requested: 'v1.2.3' }), /v1\.2\.3 is not a release version/)
  })

  test('the command-line shape is one optional version and one optional --prerelease flag', () => {
    assert.deepEqual(selectionFromArgs([]), { requested: null, prerelease: false })
    assert.deepEqual(selectionFromArgs(['1.2.3']), { requested: '1.2.3', prerelease: false })
    assert.deepEqual(selectionFromArgs(['--prerelease', '1.3.0-rc.1']), { requested: '1.3.0-rc.1', prerelease: true })
    assert.deepEqual(selectionFromArgs(['1.3.0-rc.1', '--prerelease']), { requested: '1.3.0-rc.1', prerelease: true })
    rejects(() => selectionFromArgs(['--force']), /unknown option: --force/)
    rejects(() => selectionFromArgs(['1.2.3', '1.2.4']), /one version at most/)
  })

  test('renders the selection as one line an operator can read', () => {
    assert.equal(renderSelection({ version: '1.2.3', selection: 'stable' }), 'selected 1.2.3, the stable release\n')
    assert.equal(renderSelection({ version: '1.2.4', selection: 'exact' }), 'selected 1.2.4, the exact version requested\n')
    assert.equal(renderSelection({ version: '1.3.0-rc.2', selection: 'prerelease' }), 'selected 1.3.0-rc.2, the exact prerelease requested\n')
  })
})

describe('fetching', () => {
  const index = createStableIndex({ sequence: 2, updated: NOW, stable: '1.2.3' })

  test('downloads the index through the probe, verifies it against the pinned key, and returns it', async () => {
    const probes = { stableIndex: async () => signed(index) }
    const out = sink()
    const result = await fetchStableIndex({ stdout: out, publicKey: keys.publicKey }, probes)
    assert.deepEqual(result, { ok: true, index, error: null })
    assert.equal(out.text(), 'stable-release index: sequence 2, stable 1.2.3, nothing withdrawn\n')
  })

  test('an index that does not download, does not verify, or is unsigned is a failed fetch with the reason, never an index', async () => {
    const out = sink()
    const missing = await fetchStableIndex({ stdout: out, publicKey: keys.publicKey }, { stableIndex: async () => null })
    assert.equal(missing.ok, false)
    assert.equal(missing.index, null)
    assert.match(missing.error, /could not be downloaded from https:\/\/raw\.githubusercontent\.com/)
    const forged = await fetchStableIndex({ stdout: out, publicKey: keys.publicKey }, { stableIndex: async () => signed(index, { privateKey: otherKeys.privateKey }) })
    assert.equal(forged.ok, false)
    assert.match(forged.error, /signed with key/)
    const bare = await fetchStableIndex({ stdout: out, publicKey: keys.publicKey }, { stableIndex: async () => renderStableIndex(index) })
    assert.equal(bare.ok, false)
    assert.match(bare.error, /signature is missing/)
    assert.match(out.text(), /stable-release index: failed/)
  })

  test('with a withdrawn list, the summary line names it', async () => {
    const withdrawn = createStableIndex({ sequence: 3, updated: NOW, stable: '1.2.3', withdrawn: ['1.2.2', '1.2.1'] })
    const out = sink()
    await fetchStableIndex({ stdout: out, publicKey: keys.publicKey }, { stableIndex: async () => signed(withdrawn) })
    assert.equal(out.text(), 'stable-release index: sequence 3, stable 1.2.3, withdrawn 1.2.1, 1.2.2\n')
  })
})
