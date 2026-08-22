import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Journal } from '../src/journal.mjs'
import {
  DEFAULT_AFTER, formatReport, isCommandShaped, parseCurrentCommand, readRows, scanRows,
} from '../bin/mine-misrouted-turns.mjs'

const dirs = []

function journal(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-misrouted-'))
  dirs.push(dir)
  const file = path.join(dir, 'events.db')
  const journal = new Journal(file)
  for (const event of events) journal.append(JSON.stringify(event))
  journal.close()
  return file
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the production journal scan (#549)', () => {
  test('the standalone parser stays aligned with the command router', async (context) => {
    let parseCommand
    try {
      ;({ parseCommand } = await import('../src/commands.mjs'))
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') return context.skip('the daemon dependencies are not installed')
      throw error
    }
    const commands = [
      'tickets', 'tickets curia', 'next 2', 'status', 'status now', 'deploy',
      'start 7', 'start curia#7 model=opus', 'start #7', 'map 7',
      'map 7 change the route', 'map curia chart a new map', 'map',
      'cancel 7', 'cancel all', 'cancel curia#7', 'resume 7 model=opus',
      'resume all model=opus', 'attach chat-2', 'attach all',
      'review 7 model=opus', 'review chat-2', 'unknown', '',
    ]
    for (const command of commands) {
      assert.deepEqual(parseCurrentCommand(command), parseCommand(command), command)
    }
  })

  test('the standalone note test stays aligned with the bridge', async (context) => {
    let commandShaped
    try {
      ;({ COMMAND_SHAPED: commandShaped } = await import('../src/bridge.mjs'))
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') return context.skip('the daemon dependencies are not installed')
      throw error
    }
    const notes = [
      'cancel', 'cancel 7', 'Cancel #7!', 'start alp82/curia#7 model=opus',
      'map 7', 'map 7 change this', 'status of the tests?', 'please stop', '',
    ]
    for (const note of notes) assert.equal(isCommandShaped(note), commandShaped.test(note), note)
  })

  test('the standalone parser covers accepted and refused command shapes', () => {
    for (const command of [
      'tickets', 'tickets curia', 'next', 'status', 'deploy', 'start 7',
      'start curia#7 model=opus', 'map 7', 'map 7 change the route',
      'map curia chart a new map', 'cancel 7', 'cancel all',
      'resume 7 model=opus', 'attach chat-2', 'review 7 model=opus',
    ]) {
      assert.notEqual(parseCurrentCommand(command), null, command)
    }
    for (const command of [
      'next 2', 'status now', 'start #7', 'map', 'cancel curia#7',
      'resume all model=opus', 'attach all', 'review chat-2', 'unknown', '',
    ]) {
      assert.equal(parseCurrentCommand(command), null, command)
    }
  })

  test('the standalone note test covers the bridge command shapes', () => {
    for (const note of ['cancel', 'cancel 7', 'Cancel #7!', 'start alp82/curia#7 model=opus', 'map 7']) {
      assert.equal(isCommandShaped(note), true, note)
    }
    for (const note of ['map 7 change this', 'status of the tests?', 'please stop', '']) {
      assert.equal(isCommandShaped(note), false, note)
    }
  })

  test('the scan lists the three requested event classes', () => {
    const file = journal([
      { ts: '2026-08-01T23:00:00.000Z', type: 'command', canonical: 'cancel curia#1', by: 'operator' },
      { ts: '2026-08-04T21:00:00.000Z', type: 'command', canonical: 'start curia#1 -- update the map', by: 'operator' },
      { ts: '2026-08-06T10:00:00.000Z', type: 'command', canonical: 'map 147 add one ticket', by: 'overseer' },
      { ts: '2026-08-12T10:00:00.000Z', type: 'command', canonical: 'cancel curia#2', by: 'operator' },
      { ts: '2026-08-12T10:01:00.000Z', type: 'command', canonical: 'status', by: 'operator' },
      { ts: '2026-08-12T10:02:00.000Z', type: 'overseer_turn_started', key: 'thread-1', thread_id: 'thread-1', prompt: 'status' },
      { ts: '2026-08-12T10:03:00.000Z', type: 'overseer_session', thread_id: 'thread-1', session_id: 'session-1' },
      { ts: '2026-08-12T10:04:00.000Z', type: 'overseer_turn_started', key: 'thread-1', thread_id: 'thread-1', prompt: 'cancel 2' },
      { ts: '2026-08-12T10:05:00.000Z', type: 'agent_note', agent: 'curia-2', by: 'operator', text: 'cancel 2' },
      { ts: '2026-08-12T10:06:00.000Z', type: 'agent_note', agent: 'curia-2', by: 'operator', text: 'please cancel after tests' },
      { ts: '2026-08-12T10:07:00.000Z', type: 'agent_note', agent: 'curia-2', by: 'operator', text: 'status', handoff_for: 'esc-1' },
      { ts: '2026-08-12T10:08:00.000Z', type: 'agent_note_refused', agent: 'curia-3', by: 'operator' },
    ])

    const result = scanRows(readRows(file))
    assert.deepEqual(result.refusedCommands.map((event) => event.canonical), [
      'map 147 add one ticket', 'cancel curia#2',
    ])
    assert.deepEqual(result.typedVerbThreads.map((event) => event.prompt), ['status'])
    assert.deepEqual(result.commandShapedNotes.map((event) => event.text), ['cancel 2'])
    assert.equal(result.unavailable.commandReplies, 4)
    assert.equal(result.unavailable.refusedNoteTexts, 1)
  })

  test('an old session does not become a newly opened thread', () => {
    const file = journal([
      { ts: '2026-08-01T22:00:00.000Z', type: 'overseer_session', thread_id: 'thread-old', session_id: 'session-old' },
      { ts: '2026-08-12T10:00:00.000Z', type: 'overseer_turn_started', key: 'thread-old', thread_id: 'thread-old', prompt: 'status' },
    ])
    assert.deepEqual(scanRows(readRows(file)).typedVerbThreads, [])
  })

  test('the database bytes do not change', () => {
    const file = journal([
      { ts: '2026-08-12T10:00:00.000Z', type: 'command', canonical: 'status', by: 'operator' },
    ])
    const before = fs.readFileSync(file)
    readRows(file)
    assert.deepEqual(fs.readFileSync(file), before)
  })

  test('the report is ready to paste into the ticket', () => {
    const report = formatReport({
      after: DEFAULT_AFTER,
      scanned: 0,
      lastEvent: null,
      refusedCommands: [],
      typedVerbThreads: [],
      commandShapedNotes: [],
      unavailable: { commandReplies: 0, earlyThreadPrompts: 0, refusedNoteTexts: 0 },
    })
    assert.match(report, /### Refused commands\n\n```jsonl\n<none>\n```/)
    assert.match(report, /### Data limits/)
  })
})
