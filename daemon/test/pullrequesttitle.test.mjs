import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  pullRequestTitle,
  validReleasePullRequestTitle,
} from '../src/pullrequesttitle.mjs'

describe('pull-request release titles', () => {
  test('release levels map to Conventional Commit titles', () => {
    assert.equal(pullRequestTitle('repair deploy', 'alp82/curia#1', 'patch'), 'fix: repair deploy (alp82/curia#1)')
    assert.equal(pullRequestTitle('add deploy gate', 'alp82/curia#2', 'minor'), 'feat: add deploy gate (alp82/curia#2)')
    assert.equal(pullRequestTitle('replace config', 'alp82/curia#3', 'major'), 'feat!: replace config (alp82/curia#3)')
  })

  test('a missing release level preserves other watched repositories', () => {
    assert.equal(pullRequestTitle('research notes', 'o/r#4'), 'research notes (o/r#4)')
  })

  test('the repository check accepts change and Release Please titles', () => {
    for (const title of [
      'fix: repair deploy',
      'feat(daemon): add deploy gate',
      'feat(config)!: replace the settings format',
      'feat!: replace the settings format',
      'chore(main): release curia-daemon 0.3.0',
      'chore(main): release 0.3.0',
    ]) assert.equal(validReleasePullRequestTitle(title), true, title)
  })

  test('the repository check rejects titles that cannot select a bump', () => {
    for (const title of [
      'repair deploy',
      'docs: explain deploys',
      'chore: update dependencies',
      'feat add deploy gate',
      'chore(main): release curia-daemon next',
    ]) assert.equal(validReleasePullRequestTitle(title), false, title)
  })
})
