import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { APP_VERSION, compareAppVersions, parseAppVersion } from '../src/appversion.mjs'

describe('Curia application versions', () => {
  test('reads a complete semantic version from the daemon manifest', () => {
    assert.equal(parseAppVersion('{"version":"2.4.0-beta.2+box.7"}'), '2.4.0-beta.2+box.7')
    assert.equal(APP_VERSION, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version)
  })

  test('refuses partial, prefixed, and malformed versions', () => {
    for (const version of ['2.4', 'v2.4.0', '02.4.0', 'latest', '']) {
      assert.throws(
        () => parseAppVersion(JSON.stringify({ version }), 'the target manifest'),
        /the target manifest must contain a semantic version/,
      )
    }
  })

  test('orders stable and prerelease versions by SemVer precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0', '1.1.0', '2.0.0']
    for (let i = 1; i < ordered.length; i += 1) {
      assert.equal(compareAppVersions(ordered[i - 1], ordered[i]), -1)
      assert.equal(compareAppVersions(ordered[i], ordered[i - 1]), 1)
    }
    assert.equal(compareAppVersions('1.0.0+one', '1.0.0+two'), 0)
    assert.equal(compareAppVersions('100000000000000000000.0.0', '99999999999999999999.0.0'), 1)
  })
})
