// The spawn prompt is the ONLY place the resolve protocol is stated (#41), and
// it is also the only control on a bypassPermissions worker's tracker authority
// — the disabled push URL is a speed bump, not a control (see workspace.mjs).
// So the standing orders get pinned like an interface.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writePrompt, branchFor } from '../src/workspace.mjs'

const ISSUE = { number: 42, title: 'Close the loop', body: 'the question' }

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-prompt-test-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function write(opts) {
  const file = writePrompt(tmp, ISSUE, { repo: 'o/r', wtPath: '/w/42', ...opts })
  return fs.readFileSync(file, 'utf8')
}

describe('standing orders: the resolve protocol', () => {
  test('a map ticket is told to comment, close, and append ONE line to its own map', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /gh issue comment 42 --repo o\/r/)
    assert.match(p, /gh issue close 42 --repo o\/r/)
    assert.match(p, /Decisions so far` section of the parent map o\/r#1/)
    assert.match(p, /- \[Close the loop\]\(https:\/\/github\.com\/o\/r\/issues\/42\)/)
    assert.match(p, /re-read\n\s*and confirm your line is there/, 'the lost-update risk is named, not assumed away')
  })

  test('a ticket with no map is told there is no pointer to append', () => {
    const p = write({ mapNumber: null })
    assert.match(p, /no parent map/)
    assert.ok(!/Decisions so far/.test(p))
    assert.match(p, /gh issue close 42 --repo o\/r/, 'the rest of the protocol is unchanged')
  })

  test('the tracker authority is bounded, and the claim is left alone', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /Touch NOTHING else on the tracker/)
    assert.match(p, /no other issue, no labels, no other section of the map/)
    assert.match(p, /Leave the assignee alone/)
  })

  test('pushing and opening a PR stay the daemon\'s job', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, new RegExp(`current branch \\(\`${branchFor(42)}\`\\)`))
    assert.match(p, /NEVER push, and never open a\n\s*pull request/)
    assert.match(p, /curia pushes the branch and opens the PR itself/)
  })

  test('report_result is still exactly once, and blocked never fakes a resolution', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /`report_result` tool on the `curia` MCP server exactly once/)
    assert.match(p, /do NOT comment-and-close a ticket\n\s*you did not actually resolve/)
    assert.match(p, /ask_human/)
  })

  test('the ticket body and the worktree boundary survive the rewrite', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /^# o\/r#42: Close the loop/)
    assert.match(p, /the question/)
    assert.match(p, /Work ONLY inside this worktree: \/w\/42/)
  })
})
