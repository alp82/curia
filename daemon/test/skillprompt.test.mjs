import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writePrompt } from '../src/workspace.mjs'

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-skill-prompt-'))
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const issue = {
  number: 91,
  title: 'Skill run: to-tickets on o/r#42',
  body: 'durable run record',
}

describe('ticketless skill prompt', () => {
  test('Claude receives the exact slash invocation before prose', () => {
    const file = writePrompt(dir, issue, {
      repo: 'o/r', wtPath: '/workspace', harness: 'claude',
      skill: 'to-tickets', skillTarget: 'o/r#42', prototypeVariations: 5,
    })
    const prompt = fs.readFileSync(file, 'utf8')
    const memory = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')
    assert.match(prompt, /^\/to-tickets o\/r#42\n/)
    assert.match(prompt, /TICKETLESS SKILL RUN/)
    assert.match(memory, /Before gate approval, the record issue is the only tracker issue you may write/)
    assert.match(memory, /Put every proposed tracker title, label, and native edge in `tracker_writes`/)
  })

  test('Codex receives the exact catalog invocation before prose', () => {
    const file = writePrompt(dir, issue, {
      repo: 'o/r', wtPath: '/workspace', harness: 'codex',
      skill: 'to-spec', skillTarget: 'o/r#42', prototypeVariations: 5,
    })
    assert.match(fs.readFileSync(file, 'utf8'), /^\$to-spec o\/r#42\n/)
  })
})
