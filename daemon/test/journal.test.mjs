// The journal: the write path, the columns, the epoch stamp, the migration and
// the pre-#184 spelling.
//
// The journal is a `node:sqlite` database since #407 (ADR-0017). `body` holds
// the line curia serialized, byte for byte, so a query regenerates the file it
// replaced. The columns beside it are extracted copies, and they exist so the
// operator can type SQL against them (#320).
//
// The #184 half: every line written before that rename says `worker` where curia
// now says `agent`, and `backend` where it now says `harness`. `body` is never
// rewritten, so the translation happens at the two edges — the columns on the
// way in, and the rebuild on the way out. These tests use the real shapes off
// the deployment box's own journal.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Reduction } from '../src/reduction.mjs'
import { normalizeEvent, columnsFor, openJournal, JOURNAL, JOURNAL_FILE } from '../src/journal.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'curia-journal-'))
}

describe('the pre-#184 journal reads as one vocabulary', () => {
  test('a legacy type is translated, and only the word that moved', () => {
    assert.equal(normalizeEvent({ type: 'worker_spawned' }).type, 'agent_spawned')
    assert.equal(normalizeEvent({ type: 'worker_ready_timeout' }).type, 'agent_ready_timeout')
    // The one legacy type whose word is not the prefix.
    assert.equal(normalizeEvent({ type: 'escalation_worker_died' }).type, 'escalation_agent_died')
    // Nothing else is touched: `notify` and `reconcile` were always spelled
    // this way and must not acquire a translation nobody asked for.
    assert.equal(normalizeEvent({ type: 'notify' }).type, 'notify')
    assert.equal(normalizeEvent({ type: 'dispatch_claimed' }).type, 'dispatch_claimed')
  })

  test('the legacy fields move, and the old keys do not survive beside them', () => {
    // Verbatim off the box: docs/live-checks/194-tool-channel.md, line 47.
    const ev = normalizeEvent({
      type: 'worker_spawned', worker: 'curia-170', model: 'opus', backend: 'claude', sandbox: 'docker',
    })
    assert.deepEqual(ev, {
      type: 'agent_spawned', agent: 'curia-170', model: 'opus', harness: 'claude', sandbox: 'docker',
    })
    assert.equal('worker' in ev, false)
    assert.equal('backend' in ev, false)
  })

  test('a line already in the new spelling passes through untouched', () => {
    const ev = { type: 'agent_ready', agent: 'curia-9', harness: 'codex', ticket: '9' }
    assert.deepEqual(normalizeEvent(ev), ev)
  })

  test('a new-spelling key wins over a legacy one on the same line', () => {
    const ev = normalizeEvent({ type: 'agent_ready', worker: 'stale', agent: 'curia-3' })
    assert.equal(ev.agent, 'curia-3')
  })

  test('the input event is not mutated — the caller keeps its own line', () => {
    const raw = { type: 'worker_died', worker: 'curia-4' }
    normalizeEvent(raw)
    assert.deepEqual(raw, { type: 'worker_died', worker: 'curia-4' })
  })

  // The reducer is a pure reduction over the journal (ADR-0001), so a legacy
  // line has to rebuild the same in-memory state a fresh one does. This is the
  // whole reason the file is left alone.
  test('a legacy note queue replays onto the agent it was queued for', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', type: 'worker_note', worker: 'curia-5', text: 'look at the tail' }),
      '',
    ].join('\n'))
    const reduction = new Reduction(dir)
    assert.deepEqual(reduction.takeAgentNotes('curia-5').map((n) => n.text), ['look at the tail'])
  })

  test('a legacy escalation replays with its agent, and the died mark still lands', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({
        ts: '2026-08-01T10:00:00Z', type: 'esc_open', id: 'esc-1', worker: 'curia-6',
        ticket: '6', kind: 'free-text', prompt: 'which one?',
      }),
      JSON.stringify({ ts: '2026-08-01T10:05:00Z', type: 'escalation_worker_died', id: 'esc-1', worker: 'curia-6' }),
      '',
    ].join('\n'))
    const [open] = new Reduction(dir).openEscalations()
    assert.equal(open.agent, 'curia-6')
    assert.equal(open.agent_died, true)
  })

  // #261 deleted the 30-minute tick, but 243 `esc_nudge` lines sit in the real
  // journal and the file is never rewritten. The replay has to walk straight
  // past them and rebuild the record whole.
  test('an escalation carrying the dead nudge events still replays', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({
        ts: '2026-08-01T10:00:00Z', type: 'esc_open', id: 'esc-1', agent: 'curia-7',
        ticket: '7', kind: 'free-text', prompt: 'which one?',
      }),
      JSON.stringify({ ts: '2026-08-01T10:30:00Z', type: 'esc_nudge', id: 'esc-1' }),
      JSON.stringify({ ts: '2026-08-01T11:00:00Z', type: 'esc_nudge', id: 'esc-1' }),
      '',
    ].join('\n'))
    const [open] = new Reduction(dir).openEscalations()
    assert.equal(open.prompt, 'which one?')
    assert.equal(open.status, 'open')
    assert.equal('nudges' in open, false, 'the counter nothing read is gone from the record')
  })
})

// Read the columns back the way the operator does: a query, not a field.
function rows(dir, sql = 'select id, ts, type, ticket, agent, repo, epoch, body from events order by id') {
  const journal = openJournal(dir)
  try {
    return journal.db.prepare(sql).all()
  } finally {
    journal.close()
  }
}

function seed(dir, events) {
  fs.writeFileSync(path.join(dir, JOURNAL_FILE), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

describe('the write path is an insert (#407)', () => {
  test('one journalled event is one row, and body is the line curia serialized', () => {
    const dir = tmpdir()
    const reduction = new Reduction(dir)
    const rec = reduction.journal('agent_spawned', { repo: 'o/r', ticket: 321, agent: 'curia-321' })

    const [row] = rows(dir)
    assert.equal(row.body, JSON.stringify(rec), 'the row keeps the line byte for byte')
    assert.deepEqual(JSON.parse(row.body), rec)
  })

  test('the columns come out of normalizeEvent, so a legacy line is queryable in today s spelling', () => {
    const dir = tmpdir()
    seed(dir, [{ ts: '2026-08-01T10:00:00Z', type: 'worker_spawned', worker: 'curia-170', backend: 'claude', ticket: '170' }])
    new Reduction(dir)

    const [row] = rows(dir)
    assert.equal(row.type, 'agent_spawned')
    assert.equal(row.agent, 'curia-170')
    assert.match(row.body, /"worker":"curia-170"/, 'and the line itself still says worker')
  })

  test('the ticket is TEXT, never a REAL — a number bound raw lands as "321.0"', () => {
    const dir = tmpdir()
    new Reduction(dir).journal('dispatch_claimed', { repo: 'o/r', ticket: 321, agent: 'curia-321' })

    const journal = openJournal(dir)
    try {
      assert.equal(journal.db.prepare('select ticket from events').get().ticket, '321')
      assert.equal(journal.db.prepare("select typeof(ticket) as t from events").get().t, 'text')
      // The two forms the daemon README tells the operator to type.
      assert.equal(journal.db.prepare("select count(*) as n from events where ticket='321'").get().n, 1)
      assert.equal(journal.db.prepare('select count(*) as n from events where ticket=321').get().n, 1)
    } finally {
      journal.close()
    }
  })

  test('an event that names no ticket, agent or repo leaves those columns null', () => {
    const dir = tmpdir()
    new Reduction(dir).journal('bridge_health', { up: true })

    const [row] = rows(dir)
    assert.equal(row.ticket, null)
    assert.equal(row.agent, null)
    assert.equal(row.repo, null)
    assert.equal(row.epoch, 0, 'a row with no ticket belongs to no dispatch')
  })

  test('columnsFor leaves the line alone and stringifies every column', () => {
    const line = JSON.stringify({ ts: '2026-08-01T10:00:00Z', type: 'notify', ticket: 42, agent: 'curia-42', repo: 'o/r' })
    const c = columnsFor(line)
    assert.equal(c.body, line)
    assert.equal(c.ticket, '42')
    assert.equal(typeof c.ticket, 'string')
  })
})

describe('the epoch stamp is a property of the table (#321)', () => {
  test('a dispatch row opens the epoch and carries its own id; later rows join it', () => {
    const dir = tmpdir()
    const reduction = new Reduction(dir)
    reduction.journal('dispatch_claimed', { repo: 'o/r', ticket: '7', agent: 'curia-7' })
    reduction.journal('agent_ready', { repo: 'o/r', ticket: '7', agent: 'curia-7' })
    reduction.journal('result', { repo: 'o/r', ticket: '7', agent: 'curia-7' })

    const all = rows(dir)
    assert.equal(all[0].epoch, all[0].id, 'the opening row carries its own id')
    assert.equal(all[1].epoch, all[0].id)
    assert.equal(all[2].epoch, all[0].id)
  })

  test('a second dispatch opens a second epoch, and the first one keeps its rows', () => {
    const dir = tmpdir()
    const reduction = new Reduction(dir)
    reduction.journal('dispatch_claimed', { repo: 'o/r', ticket: '7', agent: 'curia-7' })
    reduction.journal('result', { repo: 'o/r', ticket: '7', agent: 'curia-7' })
    reduction.journal('agent_spawned', { repo: 'o/r', ticket: '7', agent: 'curia-7' })
    reduction.journal('agent_ready', { repo: 'o/r', ticket: '7', agent: 'curia-7' })

    const all = rows(dir)
    assert.equal(all[1].epoch, all[0].id)
    assert.equal(all[2].epoch, all[2].id, 'the respawn is itself a boundary')
    assert.equal(all[3].epoch, all[2].id)
  })

  test('a row written before its ticket was ever dispatched belongs to no epoch', () => {
    const dir = tmpdir()
    new Reduction(dir).journal('thread_bound', { ticket: '7', thread_id: 't-1' })
    assert.equal(rows(dir)[0].epoch, 0)
  })

  test('a migrated row gets the same stamp a live one does', () => {
    const dir = tmpdir()
    seed(dir, [
      { ts: '2026-08-01T10:00:00Z', type: 'dispatch_claimed', repo: 'o/r', ticket: '7', agent: 'curia-7' },
      { ts: '2026-08-01T10:01:00Z', type: 'agent_ready', repo: 'o/r', ticket: '7', agent: 'curia-7' },
    ])
    new Reduction(dir)

    const all = rows(dir)
    assert.equal(all[0].epoch, all[0].id)
    assert.equal(all[1].epoch, all[0].id)
  })
})

describe('the migration to the database (#323)', () => {
  test('the daemon converts at its first boot, and the row count matches the line count', () => {
    const dir = tmpdir()
    const events = Array.from({ length: 250 }, (_, i) => ({
      ts: '2026-08-01T10:00:00Z', type: 'notify', ticket: String(i), message: `line ${i}`,
    }))
    seed(dir, events)

    new Reduction(dir)
    assert.equal(rows(dir).length, 250)
  })

  test('the lines come back byte for byte, so one query regenerates the file', () => {
    const dir = tmpdir()
    const events = [
      { ts: '2026-08-01T10:00:00Z', type: 'worker_spawned', worker: 'curia-1', ticket: '1' },
      { ts: '2026-08-01T10:01:00Z', type: 'notify', ticket: '1', message: 'a line with a — dash and an "é"' },
    ]
    seed(dir, events)
    new Reduction(dir)

    const regenerated = rows(dir).map((r) => r.body).join('\n') + '\n'
    assert.equal(regenerated, fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8'))
  })

  test('the journal file stays on disk, unrenamed and undeleted — it is the rollback floor', () => {
    const dir = tmpdir()
    seed(dir, [{ ts: '2026-08-01T10:00:00Z', type: 'notify', message: 'hi' }])
    const before = fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8')

    const reduction = new Reduction(dir)
    reduction.journal('notify', { message: 'after the migration' })

    assert.equal(fs.existsSync(path.join(dir, JOURNAL_FILE)), true)
    assert.equal(fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8'), before,
      'the daemon never writes the file again')
  })

  test('the half-built database is not left behind', () => {
    const dir = tmpdir()
    seed(dir, [{ ts: '2026-08-01T10:00:00Z', type: 'notify', message: 'hi' }])
    new Reduction(dir)
    assert.equal(fs.existsSync(path.join(dir, `${JOURNAL}.migrating`)), false)
  })

  test('a blank line is skipped, exactly as the old boot pass skipped it', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, JOURNAL_FILE), [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', type: 'notify', message: 'one' }),
      '',
      '   ',
      JSON.stringify({ ts: '2026-08-01T10:01:00Z', type: 'notify', message: 'two' }),
      '',
    ].join('\n'))

    new Reduction(dir)
    assert.equal(rows(dir).length, 2)
  })

  test('a line that is not JSON stops the boot, and no database is left in place', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, JOURNAL_FILE), [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', type: 'notify', message: 'one' }),
      '{ this is not json',
      '',
    ].join('\n'))

    assert.throws(() => new Reduction(dir), /did not convert/)
    assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false,
      'a conversion that fails converts again on the next boot')
  })

  test('the second boot converts nothing — the file is read once, ever', () => {
    const dir = tmpdir()
    seed(dir, [{ ts: '2026-08-01T10:00:00Z', type: 'notify', message: 'one' }])
    new Reduction(dir).journal('notify', { message: 'two' })

    // A second daemon on the same directory: the file still holds one line and
    // the journal holds two, so a re-conversion would be visible at once.
    const reborn = new Reduction(dir)
    assert.equal(reborn.journalEvents().length, 2)
    assert.equal(rows(dir).length, 2)
  })

  test('a directory with no journal file at all boots on an empty journal', () => {
    const dir = tmpdir()
    const reduction = new Reduction(dir)
    assert.deepEqual(reduction.journalEvents(), [])
    assert.equal(fs.existsSync(path.join(dir, JOURNAL_FILE)), false, 'and none is created')
  })
})

describe('the boot rebuild reads the journal page by page (#322)', () => {
  test('a history longer than one page rebuilds whole, in write order', () => {
    const dir = tmpdir()
    // Two and a half pages, so the paging loop runs more than once.
    const events = Array.from({ length: 2500 }, (_, i) => ({
      ts: '2026-08-01T10:00:00Z', type: 'agent_note', id: `note-${i + 1}`, agent: 'curia-9', text: `note ${i + 1}`,
    }))
    seed(dir, events)

    const reborn = new Reduction(dir)
    const notes = reborn.takeAgentNotes('curia-9')
    assert.equal(notes.length, 2500)
    assert.equal(notes[0].text, 'note 1')
    assert.equal(notes.at(-1).text, 'note 2500')
  })

  test('the rebuild reads body, so it is the last reader that runs the #184 translation', () => {
    const dir = tmpdir()
    seed(dir, [{ ts: '2026-08-01T10:00:00Z', type: 'worker_note', worker: 'curia-5', text: 'look at the tail' }])
    const events = new Reduction(dir).journalEvents()
    assert.equal(events[0].type, 'agent_note')
    assert.equal(events[0].agent, 'curia-5')
  })
})

describe('the migration accepts exactly what the old boot pass accepted', () => {
  for (const [name, line] of [
    ['a bare number', '123'],
    ['a bare string', '"a line"'],
    ['null', 'null'],
    ['an array', '[{"type":"notify"}]'],
  ]) {
    test(`${name} stops the boot, and no database is left in place`, () => {
      const dir = tmpdir()
      fs.writeFileSync(path.join(dir, JOURNAL_FILE), `${line}\n`)
      assert.throws(() => new Reduction(dir), /did not convert/)
      assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false)
    })
  }
})

// The credential warnings still standing (#380). A reduction rather than a
// re-read, for the two reasons the coolings (#377) are one: the ladder must not
// re-say at every boot what it already said, and the Needs-you item has to
// survive the deploy that happens between the warning and the operator acting
// on it.
describe('the credential warnings survive the restart (#380)', () => {
  const dir = () => tmpdir()
  const warn = (over = {}) => ({
    holder: 'agent', key: 'GH_TOKEN_ALP82', repo: 'alp82/curia', fault: 'expiring',
    days: 3, step: 3, said: true, where: 'daemon/.env.daemon', refusal: 'r', ...over,
  })

  test('a warning is read back after a boot, with what it said', () => {
    const d = dir()
    new Reduction(d).journal('token_warned', warn())
    const [w] = new Reduction(d).standingTokenWarnings()
    assert.equal(w.key, 'GH_TOKEN_ALP82')
    assert.equal(w.step, 3)
    assert.equal(w.said, true)
  })

  test('a tighter step replaces the entry rather than adding a second', () => {
    const d = dir()
    const reduction = new Reduction(d)
    reduction.journal('token_warned', warn({ days: 10, step: 14 }))
    reduction.journal('token_warned', warn({ days: 2, step: 3 }))
    const back = new Reduction(d).standingTokenWarnings()
    assert.equal(back.length, 1)
    assert.equal(back[0].step, 3)
  })

  test('the expiry keys on the TOKEN, so a long watch list cannot repeat it', () => {
    const d = dir()
    const reduction = new Reduction(d)
    reduction.journal('token_warned', warn({ repo: 'alp82/curia' }))
    reduction.journal('token_warned', warn({ repo: 'alp82/aistack' }))
    assert.equal(new Reduction(d).standingTokenWarnings().length, 1)
  })

  test('a reach failure keys on the token AND the repo', () => {
    const d = dir()
    const reduction = new Reduction(d)
    const reach = { ...warn(), fault: 'unreachable', message: 'HTTP 404' }
    reduction.journal('token_warned', { ...reach, repo: 'alp82/curia' })
    reduction.journal('token_warned', { ...reach, repo: 'alp82/aistack' })
    assert.equal(new Reduction(d).standingTokenWarnings().length, 2)
  })

  test('a clear removes it, and a restart does not hand it back', () => {
    const d = dir()
    const reduction = new Reduction(d)
    reduction.journal('token_warned', warn())
    reduction.journal('token_cleared', { holder: 'agent', key: 'GH_TOKEN_ALP82', repo: 'alp82/curia', fault: 'expiring' })
    assert.deepEqual(new Reduction(d).standingTokenWarnings(), [])
  })

  test('one key is read on its own, which is what the ladder asks', () => {
    const d = dir()
    const reduction = new Reduction(d)
    reduction.journal('token_warned', warn())
    assert.equal(reduction.tokenWarning('agent:GH_TOKEN_ALP82').step, 3)
    assert.equal(reduction.tokenWarning('agent:GH_TOKEN_NOBODY'), null)
  })
})
