import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const skill = fs.readFileSync(new URL('../../skills/wayfinder/SKILL.md', import.meta.url), 'utf8')

test('the wayfinder ending records existing, new, and absent follow-up tickets', () => {
  assert.match(skill, /existing follow-up ticket[^.]*unblock/i)
  assert.match(skill, /new follow-up ticket[^.]*create/i)
  assert.match(skill, /ticket number and title/i)
  assert.match(skill, /resolution comment and the `report_result` summary/i)
  assert.match(skill, /no direct follow-up ticket/i)
})
