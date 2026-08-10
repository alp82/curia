// Tests for the thread lifecycle and label binding (#93, per the #89
// discipline): the journalled ticket↔thread map in the store, the bridge's
// display-only label helpers, the thread context through the command seam,
// and the dispatcher's bind-at-claim / release-on-terminal-state calls.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EscalationStore } from '../src/store.mjs'
import { DiscordBridge } from '../src/bridge.mjs'
import { CommandRouter } from '../src/commands.mjs'
import { Dispatcher } from '../src/dispatch.mjs'
import { TEST_PINS, containerDeps, seedConfigDirStub, withTestCredential } from './fixtures/sandbox.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-threads-test-'))

// ---- the journalled binding (store.mjs) -------------------------------------

describe('EscalationStore ticket-thread bindings', () => {
  test('bind journals, both lookups answer, and boundTickets lists the ticket', () => {
    const store = new EscalationStore(tmp())
    const r = store.bindTicketThread('85', 't-1')
    assert.equal(r.ok, true)
    assert.equal(store.threadForTicket('85'), 't-1')
    assert.equal(store.threadForTicket(85), 't-1', 'numeric and string tickets are the same key')
    assert.equal(store.ticketForThread('t-1'), '85')
    assert.deepEqual(store.boundTickets(), ['85'])
  })

  test('rebinding the same pair is an ok no-op with no second journal line', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('85', 't-1')
    assert.equal(store.bindTicketThread('85', 't-1').ok, true)
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(lines.filter((l) => l.type === 'thread_bound').length, 1)
  })

  test('a double-bind refuses and names the holder, both directions', () => {
    const store = new EscalationStore(tmp())
    store.bindTicketThread('85', 't-1')
    // the ticket already lives on a thread
    const byTicket = store.bindTicketThread('85', 't-2')
    assert.deepEqual(byTicket, { ok: false, reason: 'ticket-bound', threadId: 't-1' })
    // the thread already carries a label
    const byThread = store.bindTicketThread('86', 't-1')
    assert.deepEqual(byThread, { ok: false, reason: 'thread-bound', ticket: '85' })
    assert.equal(store.threadForTicket('85'), 't-1', 'the refused bind changed nothing')
  })

  test('release journals once, clears both lookups, and is idempotent', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('85', 't-1')
    assert.equal(store.releaseTicketThread('85', 'finished'), 't-1')
    assert.equal(store.threadForTicket('85'), undefined)
    assert.equal(store.ticketForThread('t-1'), undefined)
    assert.equal(store.releaseTicketThread('85', 'finished'), null, 'nothing bound ⇒ no event')
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(lines.filter((l) => l.type === 'thread_released').length, 1)
    // a released thread is bindable again
    assert.equal(store.bindTicketThread('86', 't-1').ok, true)
  })

  test('the journal is the truth: a restart replays live bindings and released ones stay off', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('85', 't-1')
    store.bindTicketThread('86', 't-2')
    store.releaseTicketThread('85', 'cancelled')
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.threadForTicket('85'), undefined)
    assert.equal(reborn.threadForTicket('86'), 't-2')
    assert.deepEqual(reborn.boundTickets(), ['86'])
  })

  test('lastThreadForTicket survives a release and a restart (#140)', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('85', 't-1')
    store.releaseTicketThread('85', 'reconcile')
    assert.equal(store.threadForTicket('85'), undefined)
    assert.equal(store.lastThreadForTicket('85'), 't-1', 'the release does not erase the journal history')
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.lastThreadForTicket('85'), 't-1')
    assert.equal(reborn.lastThreadForTicket(85), 't-1', 'numeric and string tickets are the same key')
    // a later rebind moves the pointer
    store.bindTicketThread('85', 't-9')
    assert.equal(store.lastThreadForTicket('85'), 't-9')
  })

  test('lastTicketForThread answers the same way round, released or not (#257)', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('147', 't-1')
    assert.equal(store.lastTicketForThread('t-1'), '147')
    store.releaseTicketThread('147', 'finished')
    assert.equal(store.ticketForThread('t-1'), undefined, 'the live binding is gone')
    assert.equal(store.lastTicketForThread('t-1'), '147', 'the thread is still curia\'s to settle')
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.lastTicketForThread('t-1'), '147')
    assert.equal(reborn.lastTicketForThread('t-never'), undefined, 'a thread curia never labeled')
  })

  // #197. #140 keeps a binding through a cancel so a `resume` lands back in the
  // ticket's own history. A fresh dispatch typed in ANOTHER thread is not a
  // resume, and before this it was refused silently — the agent went on
  // reporting into a thread nobody had open.
  test('a rebind moves a live binding and names the thread it left', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('169', 't-old')
    const r = store.rebindTicketThread('169', 't-new', 'dispatched-from-another-thread')
    assert.deepEqual(r, { ok: true, threadId: 't-new', moved: true, from: 't-old' })
    assert.equal(store.threadForTicket('169'), 't-new')
    assert.equal(store.ticketForThread('t-old'), undefined, 'the old thread is free again')
    assert.equal(store.ticketForThread('t-new'), '169')
  })

  test('a rebind to the thread already bound is a no-op, not a pair of events', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('169', 't-1')
    const before = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').length
    assert.deepEqual(store.rebindTicketThread('169', 't-1'), { ok: true, threadId: 't-1', moved: false })
    assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').length, before)
  })

  test('a rebind refuses a thread that already carries another ticket (#93 holds)', () => {
    const store = new EscalationStore(tmp())
    store.bindTicketThread('169', 't-1')
    store.bindTicketThread('117', 't-2')
    assert.deepEqual(store.rebindTicketThread('169', 't-2'), { ok: false, reason: 'thread-bound', ticket: '117' })
    assert.equal(store.threadForTicket('169'), 't-1', 'the refused move changes nothing')
  })

  test('an unbound ticket rebinds cleanly, with nothing to leave', () => {
    const store = new EscalationStore(tmp())
    const r = store.rebindTicketThread('169', 't-new')
    assert.deepEqual(r, { ok: true, threadId: 't-new', moved: true, from: null })
  })

  test('a rebind replays across a restart, and the old thread stays the history', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('169', 't-old')
    store.rebindTicketThread('169', 't-new')
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.threadForTicket('169'), 't-new')
    assert.equal(reborn.ticketForThread('t-old'), undefined)
    assert.equal(reborn.lastThreadForTicket('169'), 't-new', '#140 backstop follows the move')
  })

  // #235: the journal's own dispatch lines are the repo index, so the label's
  // lazy path outlives the dispatcher's in-memory record.
  test('repoForTicket reads the journal dispatch lines, last wins, and survives a restart', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    assert.equal(store.repoForTicket('85'), undefined, 'never dispatched ⇒ no repo')
    store.logEvent('dispatch_claimed', { repo: 'alp82/curia', ticket: '85', agent: 'curia-85' })
    assert.equal(store.repoForTicket('85'), 'alp82/curia')
    assert.equal(store.repoForTicket(85), 'alp82/curia', 'numeric and string tickets are the same key')
    // agent_spawned indexes too — a map dispatch never writes dispatch_claimed (#221)
    store.logEvent('agent_spawned', { repo: 'alp82/aistack', ticket: '90', agent: 'curia-90' })
    assert.equal(store.repoForTicket('90'), 'alp82/aistack')
    // the same number dispatched from another repo moves the pointer
    store.logEvent('dispatch_claimed', { repo: 'getalfredo/landing-page', ticket: '85', agent: 'curia-85' })
    assert.equal(store.repoForTicket('85'), 'getalfredo/landing-page')
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.repoForTicket('85'), 'getalfredo/landing-page')
    assert.equal(reborn.repoForTicket('90'), 'alp82/aistack')
  })
})

// ---- the display-only label (bridge.mjs) ------------------------------------

describe('DiscordBridge label helpers', () => {
  test('labelName renders the 🎫 rename, with and without a type, capped at 100', () => {
    assert.equal(DiscordBridge.labelName('85'), '🎫 85')
    assert.equal(DiscordBridge.labelName('85', 'grilling'), '🎫 85 · grilling')
    assert.equal(DiscordBridge.labelName('85', 'x'.repeat(200)).length, 100)
  })

  // #235: one number space serves four watched repos, so the label carries the
  // repo as its own field, after the number. Short name, no owner prefix — the
  // operator ruled the form.
  test('labelName puts the repo between the number and the type, short name only', () => {
    assert.equal(DiscordBridge.labelName('85', 'grilling', 'alp82/curia'), '🎫 85 · curia · grilling')
    assert.equal(DiscordBridge.labelName('85', '', 'alp82/curia'), '🎫 85 · curia')
    assert.equal(DiscordBridge.labelName('85', 'task', 'getalfredo/landing-page'), '🎫 85 · landing-page · task')
    assert.equal(DiscordBridge.labelName('85', 'task', ''), '🎫 85 · task', 'no record ⇒ the two-field form')
  })

  test('the glyph swaps keep the repo field — they replace the signal only', () => {
    assert.equal(DiscordBridge.doneName('🎫 85 · curia · grilling'), '✅ 85 · curia · grilling')
    assert.equal(DiscordBridge.cancelledName('⏳ 85 · curia · task'), '⚰️ 85 · curia · task')
  })

  test('doneName swaps the ticket signal for the checkmark and keeps the rest', () => {
    assert.equal(DiscordBridge.doneName('🎫 85 · grilling'), '✅ 85 · grilling')
    assert.equal(DiscordBridge.doneName('🎫 85'), '✅ 85')
    assert.equal(DiscordBridge.doneName(DiscordBridge.labelName('85', 'task')), '✅ 85 · task')
    assert.equal(DiscordBridge.doneName('deploy talk'), 'deploy talk')
  })

  test('done and cancel swap ANY live glyph (#199) — a ticket can end mid-question', () => {
    assert.equal(DiscordBridge.doneName('⏳ 85 · task'), '✅ 85 · task')
    assert.equal(DiscordBridge.doneName('🔎 85 · task'), '✅ 85 · task')
    assert.equal(DiscordBridge.cancelledName('⏳ 85 · task'), '⚰️ 85 · task')
    assert.equal(DiscordBridge.cancelledName('🔎 85'), '⚰️ 85')
    assert.equal(DiscordBridge.cancelledName('✅ 85 · task'), '✅ 85 · task', 'terminal glyphs are not live — left alone')
  })

  test('threadLink composes from the ids the daemon already holds', () => {
    assert.equal(DiscordBridge.threadLink('G1', 'T9'), 'https://discord.com/channels/G1/T9')
  })
})

// ---- cross-thread breadcrumbs (#108 item 10) --------------------------------

describe('DiscordBridge cross-thread breadcrumbs', () => {
  let store, bridge, created, sentTo

  const makeThread = (id, name) => ({
    id, name, sent: [],
    send: async (text) => { sentTo.push({ id, text }) },
    setName: async () => {},
    delete: async () => { deleted.push(id); threads.delete(id) },
  })

  let threads, deleted, held

  // The #277 clock. The bridge holds a 🎫 clear rather than sending it, so the
  // tests own when that window runs out — `fireHeld` is "two minutes passed".
  // It awaits the callback's promise, which is why flagTicket returns one.
  const fireHeld = async () => {
    const due = held.filter((h) => h.live)
    held = []
    for (const h of due) await h.fn()
  }

  beforeEach(() => {
    store = new EscalationStore(tmp())
    created = []
    sentTo = []
    deleted = []
    threads = new Map()
    held = []
    bridge = new DiscordBridge({
      token: 'x', allowedUsers: [], dataDir: tmp(),
      handlers: {}, log: () => {},
      timers: {
        set: (fn) => { const h = { fn, live: true }; held.push(h); return h },
        clear: (h) => { if (h) h.live = false },
      },
      bindings: {
        get: (t) => store.threadForTicket(t),
        bind: (t, id) => store.bindTicketThread(t, id),
        release: (t, r) => store.releaseTicketThread(t, r),
        last: (t) => store.lastThreadForTicket(t),
        ticketOf: (id) => store.ticketForThread(id),
        lastTicketOf: (id) => store.lastTicketForThread(id),
      },
    })
    bridge.guild = { id: 'G' }
    bridge.channel = {
      id: 'C',
      threads: {
        create: async ({ name }) => {
          const t = makeThread(`fresh-${created.length + 1}`, name)
          created.push(t)
          threads.set(t.id, t)
          return t
        },
        fetchActive: async () => ({ threads: new Map(threads) }),
      },
    }
    bridge.client = { channels: { fetch: async (id) => threads.get(id) ?? null } }
    bridge.registerThread = (t) => threads.set(t.id, t)
  })

  test('a dispatch from an already-bound thread opens a fresh thread and breadcrumbs both ways', async () => {
    const origin = makeThread('t-origin', '🎫 106 · charting')
    bridge.registerThread(origin)
    store.bindTicketThread('106', 't-origin')

    const r = await bridge.bindTicket('107', { threadId: 't-origin', type: 'research' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(store.threadForTicket('107'), created[0].id)
    assert.equal(created[0].name, '🎫 107 · research', 'the type names the fresh thread')
    // the new thread opens by naming the thread that sent it
    const inFresh = sentTo.find((s) => s.id === created[0].id)
    assert.match(inFresh.text, /dispatched from “🎫 106 · charting”/)
    assert.match(inFresh.text, /discord\.com\/channels\/G\/t-origin/)
    // and the origin learns where the work went
    const inOrigin = sentTo.find((s) => s.id === 't-origin')
    assert.match(inOrigin.text, /🎫 107 · research/)
    assert.match(inOrigin.text, new RegExp(`discord\\.com/channels/G/${created[0].id}`))
  })

  test('an autonomous dispatch (no issuing thread) opens a fresh thread with no breadcrumb', async () => {
    const r = await bridge.bindTicket('108', { type: 'prototype' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(created[0].name, '🎫 108 · prototype')
    assert.equal(sentTo.length, 0)
  })

  test('an untyped ticket names its thread with the number alone', async () => {
    const r = await bridge.bindTicket('115', {})
    assert.equal(r.ok, true)
    assert.equal(created[0].name, '🎫 115')
  })

  // ---- the repo field on the label (#235) ------------------------------------

  test('the dispatch hands the repo over and the fresh thread carries it', async () => {
    const r = await bridge.bindTicket('107', { type: 'research', repo: 'alp82/curia' })
    assert.equal(r.ok, true)
    assert.equal(created[0].name, '🎫 107 · curia · research')
  })

  test('a bind without a repo reads the journal record instead of dropping the field', async () => {
    bridge.bindings.repoOf = (t) => (String(t) === '128' ? 'alp82/aistack' : undefined)
    const r = await bridge.bindTicket('128', { type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(created[0].name, '🎫 128 · aistack · task')
  })

  test('the lazy path (ensureThread) carries the repo from the record too', async () => {
    bridge.bindings.repoOf = () => 'alp82/curia'
    const t = await bridge.ensureThread('130')
    assert.equal(t.name, '🎫 130 · curia')
    assert.equal(store.threadForTicket('130'), t.id)
  })

  test('ensureThread for a ticket with no record keeps the bare-number name', async () => {
    const t = await bridge.ensureThread('131')
    assert.equal(t.name, '🎫 131')
  })

  test('a bind onto an unbound issuing thread stays in place and takes the label as its name', async () => {
    const origin = makeThread('t-conv', 'deploy talk')
    const renames = []
    origin.setName = async (n) => { renames.push(n) }
    bridge.registerThread(origin)
    const r = await bridge.bindTicket('109', { threadId: 't-conv', type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 0)
    assert.equal(sentTo.length, 0)
    assert.equal(store.threadForTicket('109'), 't-conv')
    assert.deepEqual(renames, ['🎫 109 · task'], 'the old conversation name is replaced, not kept')
  })

  test('a ticket already bound elsewhere refuses as before — no thread churn', async () => {
    store.bindTicketThread('110', 't-elsewhere')
    const r = await bridge.bindTicket('110', { threadId: 't-other', type: 'task' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'ticket-bound')
    assert.equal(created.length, 0)
  })

  // ---- the dispatch backstop (#140) ------------------------------------------

  test('an unbound ticket goes back to the journal-last thread when it still exists', async () => {
    const old = makeThread('t-old', 'Run the map')
    bridge.registerThread(old)
    store.bindTicketThread('111', 't-old')
    store.releaseTicketThread('111', 'reconcile') // the pre-#140 sweep struck
    const renames = []
    old.setName = async (n) => { renames.push(n) }

    const r = await bridge.bindTicket('111', { type: 'research' })
    assert.equal(r.ok, true)
    assert.equal(r.threadId, 't-old', 'the old thread is rebound, not replaced')
    assert.equal(created.length, 0, 'no fresh thread')
    assert.equal(store.threadForTicket('111'), 't-old')
    assert.deepEqual(renames, ['🎫 111 · research'], 'the label goes back on')
  })

  test('a revived thread that finished once goes from ✅ back to 🎫', async () => {
    const old = makeThread('t-done', '✅ 116 · task')
    const renames = []
    old.setName = async (n) => { renames.push(n) }
    bridge.registerThread(old)
    store.bindTicketThread('116', 't-done')
    store.releaseTicketThread('116', 'finished')

    const r = await bridge.bindTicket('116', { type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(r.threadId, 't-done')
    assert.deepEqual(renames, ['🎫 116 · task'], 'reopened work reads as open again')
  })

  test('the backstop unarchives a revived thread', async () => {
    const old = makeThread('t-old', '🎫 112 · sleepy')
    old.archived = true
    const unarchived = []
    old.setArchived = async (v) => { unarchived.push(v) }
    bridge.registerThread(old)
    store.bindTicketThread('112', 't-old')
    store.releaseTicketThread('112', 'reconcile')

    const r = await bridge.bindTicket('112', { type: 'grilling' })
    assert.equal(r.ok, true)
    assert.deepEqual(unarchived, [false])
  })

  test('a journal-last thread gone from Discord falls back to a fresh one', async () => {
    store.bindTicketThread('113', 't-deleted') // never registered ⇒ fetch misses
    store.releaseTicketThread('113', 'reconcile')
    const r = await bridge.bindTicket('113', { type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(store.threadForTicket('113'), created[0].id)
  })

  test('a journal-last thread re-bound to another ticket is not taken back', async () => {
    const old = makeThread('t-taken', '🎫 200 · new owner')
    bridge.registerThread(old)
    store.bindTicketThread('114', 't-taken')
    store.releaseTicketThread('114', 'reconcile')
    store.bindTicketThread('200', 't-taken') // another ticket moved in

    const r = await bridge.bindTicket('114', { type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1, 'a fresh thread instead')
    assert.equal(store.threadForTicket('114'), created[0].id)
    assert.equal(store.threadForTicket('200'), 't-taken', 'the squatter keeps its thread')
  })

  // ---- release keeps the name and changes the signal --------------------------

  test('release swaps 🎫 for ✅ and keeps the ticket and its type', async () => {
    const t = makeThread('t-fin', '🎫 117 · grilling')
    const renames = []
    t.setName = async (n) => { renames.push(n) }
    bridge.registerThread(t)
    store.bindTicketThread('117', 't-fin')

    await bridge.releaseTicket('117', 'finished')
    assert.deepEqual(renames, ['✅ 117 · grilling'])
    assert.equal(store.threadForTicket('117'), undefined, 'the journal releases either way')
  })

  test('release leaves an unlabeled thread alone and survives a deleted one', async () => {
    const t = makeThread('t-plain', 'deploy talk')
    const renames = []
    t.setName = async (n) => { renames.push(n) }
    bridge.registerThread(t)
    store.bindTicketThread('118', 't-plain')
    await bridge.releaseTicket('118', 'finished')
    assert.deepEqual(renames, [])

    store.bindTicketThread('119', 't-gone') // never registered ⇒ fetch misses
    await bridge.releaseTicket('119', 'finished')
    assert.equal(store.threadForTicket('119'), undefined)
  })

  test('release clears a waiting glyph too — never a stale ⏳ on a finished ticket (#199)', async () => {
    const t = makeThread('t-wait', '⏳ 120 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n) }
    bridge.registerThread(t)
    store.bindTicketThread('120', 't-wait')
    await bridge.releaseTicket('120', 'finished')
    assert.deepEqual(renames, ['✅ 120 · task'])
  })

  // ---- the state glyph on the thread name (#199) -----------------------------

  test('flagTicket swaps 🎫 for the state glyph and back, keeping the rest of the name', async () => {
    const t = makeThread('t-flag', '🎫 121 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('121', 't-flag')

    await bridge.flagTicket('121', 'waiting')
    assert.deepEqual(renames, ['⏳ 121 · task'], 'the ON direction never waits')
    await bridge.flagTicket('121', 'working')
    await bridge.flagTicket('121', 'working') // repeat: nothing to send
    await fireHeld()
    assert.deepEqual(renames, ['⏳ 121 · task', '🎫 121 · task'])
  })

  test('flagTicket renders awaiting-review as 🔎', async () => {
    const t = makeThread('t-rev', '🎫 122 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('122', 't-rev')
    await bridge.flagTicket('122', 'awaiting-review')
    assert.deepEqual(renames, ['🔎 122 · task'])
  })

  test('flagTicket leaves terminal, hand-edited and unbound names alone', async () => {
    const done = makeThread('t-done2', '✅ 123 · task')
    const plain = makeThread('t-plain2', 'deploy talk')
    const renames = []
    done.setName = async (n) => { renames.push(n) }
    plain.setName = async (n) => { renames.push(n) }
    bridge.registerThread(done)
    bridge.registerThread(plain)
    store.bindTicketThread('123', 't-done2')
    store.bindTicketThread('124', 't-plain2')

    await bridge.flagTicket('123', 'waiting')
    await bridge.flagTicket('124', 'waiting')
    await bridge.flagTicket('125', 'waiting') // never bound
    assert.deepEqual(renames, [])
  })

  // ---- the held clear (#277) -------------------------------------------------
  //
  // Discord answers every rename with a system line, and the clear back to 🎫
  // is the half nobody reads: it lands a moment after the operator answered,
  // so its only reader is the person who just left the thread. Holding it lets
  // the next question cancel it, and a grilling asks many questions.

  test('a question inside the window cancels the held clear — the pair costs one rename, not three (#277)', async () => {
    const t = makeThread('t-grill', '🎫 140 · grilling')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('140', 't-grill')

    await bridge.flagTicket('140', 'waiting') // question 1
    await bridge.flagTicket('140', 'working') // answered — held, not sent
    await bridge.flagTicket('140', 'waiting') // question 2, inside the window
    await bridge.flagTicket('140', 'working')
    await bridge.flagTicket('140', 'waiting') // question 3
    await fireHeld() // nothing is due: every hold was replaced by a later flag

    assert.deepEqual(renames, ['⏳ 140 · grilling'], 'the glyph never moved off ⏳')
    assert.equal(t.name, '⏳ 140 · grilling')
  })

  test('a held clear lands once the window runs out, and only once', async () => {
    const t = makeThread('t-hold', '🎫 141 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('141', 't-hold')

    await bridge.flagTicket('141', 'waiting')
    await bridge.flagTicket('141', 'working')
    assert.deepEqual(renames, ['⏳ 141 · task'], 'the clear is not out yet')
    await fireHeld()
    assert.deepEqual(renames, ['⏳ 141 · task', '🎫 141 · task'])
    await fireHeld()
    assert.deepEqual(renames, ['⏳ 141 · task', '🎫 141 · task'], 'the hold fires once')
  })

  test('a review gate holds its clear the same way — 🔎 survives a rejection that asks again', async () => {
    const t = makeThread('t-gate', '🎫 142 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('142', 't-gate')

    await bridge.flagTicket('142', 'awaiting-review')
    await bridge.flagTicket('142', 'working') // rejected, back to work — held
    await bridge.flagTicket('142', 'awaiting-review') // second gate round
    await fireHeld()
    assert.deepEqual(renames, ['🔎 142 · task'])
  })

  test('a release drops the held clear — the thread ends ✅ and no 🎫 follows it', async () => {
    const t = makeThread('t-end', '🎫 143 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('143', 't-end')

    await bridge.flagTicket('143', 'waiting')
    await bridge.flagTicket('143', 'working') // held
    await bridge.releaseTicket('143', 'finished')
    await fireHeld()
    assert.deepEqual(renames, ['⏳ 143 · task', '✅ 143 · task'])
  })

  test('a cancel drops the held clear too — the binding survives, the ⚰️ stands', async () => {
    const t = makeThread('t-dead', '🎫 144 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('144', 't-dead')

    await bridge.flagTicket('144', 'waiting')
    await bridge.flagTicket('144', 'working') // held
    await bridge.cancelTicket('144')
    await fireHeld()
    assert.deepEqual(renames, ['⏳ 144 · task', '⚰️ 144 · task'])
    assert.equal(store.threadForTicket('144'), 't-dead', 'a cancel keeps the binding (#140)')
  })

  test('stop() drops every held clear', async () => {
    const t = makeThread('t-stop', '🎫 145 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('145', 't-stop')
    bridge.client.destroy = async () => {}

    await bridge.flagTicket('145', 'waiting')
    await bridge.flagTicket('145', 'working')
    await bridge.stop()
    assert.equal(bridge.flagClears.size, 0)
    await fireHeld()
    assert.deepEqual(renames, ['⏳ 145 · task'])
  })

  // ---- the rename race on a finishing ticket ---------------------------------
  // A status flag and the release both swap the signal glyph, and each used to
  // base its swap on the name Discord SHOWS — a name that lags whenever a
  // rename sits deferred under #199's budget. The loser of the race then put
  // its glyph on top of the winner's: a finished thread stuck on 🎫 or 🔎.
  // Both callers base on the renamer's pending name now.

  test('a stale flag cannot displace a pending ✅ — the finished ticket never goes back to 🔎', async () => {
    const t = makeThread('t-late', '🎫 132 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('132', 't-late')
    await bridge.flagTicket('132', 'waiting') // spend 1 — reserve keeps the second slot
    await bridge.flagTicket('132', 'working')
    await fireHeld() // spend 2 — the budget is out
    assert.deepEqual(renames, ['⏳ 132 · task', '🎫 132 · task'])
    // park a flag past its binding guard, inside the fetch, while release runs
    let resume
    const realFetch = bridge.client.channels.fetch
    bridge.client.channels.fetch = (id) => new Promise((res) => { resume = () => res(realFetch(id)) })
    const stale = bridge.flagTicket('132', 'awaiting-review')
    bridge.client.channels.fetch = realFetch
    await bridge.releaseTicket('132', 'finished')
    assert.equal(bridge.renamer.desired('t-late'), '✅ 132 · task', 'the ✅ waits for a slot but it IS the intent')
    resume(); await stale
    assert.equal(bridge.renamer.desired('t-late'), '✅ 132 · task', 'the race loser dissolved on the terminal name')
  })

  test('a release whose 🎫 label is still deferred ends ✅, not stuck on the late label', async () => {
    const t = makeThread('t-conv', 'deploy talk')
    t.setName = async (n) => { t.name = n }
    bridge.registerThread(t)
    // burn the budget so the bind's label rename defers
    await bridge.renamer.set('t-conv', 'deploy chat')
    await bridge.renamer.set('t-conv', 'deploy talk')
    const r = await bridge.bindTicket('133', { threadId: 't-conv', type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(t.name, 'deploy talk', 'the label is deferred — Discord still shows the old name')
    assert.equal(bridge.renamer.desired('t-conv'), '🎫 133 · task')
    await bridge.releaseTicket('133', 'finished')
    assert.equal(bridge.renamer.desired('t-conv'), '✅ 133 · task',
      'the swap read the pending label, not the unlabeled shown name')
  })

  // ---- one live thread per ticket (#257) --------------------------------------
  // Seven tickets in the history own more than one thread. Two causes: the lazy
  // path opened a thread where the dispatch path would have gone back to the
  // ticket's own, and two callers for one unbound ticket each opened one.

  test('the lazy path goes back to the ticket\'s last thread instead of opening a second', async () => {
    const old = makeThread('t-147', '✅ 147 · curia · task')
    bridge.registerThread(old)
    store.bindTicketThread('147', 't-147')
    store.releaseTicketThread('147', 'finished')

    const t = await bridge.ensureThread('147')
    assert.equal(t.id, 't-147', 'the ticket speaks where its history is')
    assert.equal(created.length, 0, 'no second thread')
    assert.equal(store.threadForTicket('147'), 't-147', 'and it is bound again')
  })

  test('the lazy revive leaves the name alone — a late line adds no glyph back', async () => {
    const old = makeThread('t-148', '✅ 148 · curia · grilling')
    const renames = []
    old.setName = async (n) => { renames.push(n) }
    bridge.registerThread(old)
    store.bindTicketThread('148', 't-148')
    store.releaseTicketThread('148', 'finished')

    await bridge.ensureThread('148')
    assert.deepEqual(renames, [], 'the ending stands, and the type field is not dropped')
  })

  test('a dispatch after a lazy revive still relabels — reopened work reads as open', async () => {
    const old = makeThread('t-149', '✅ 149 · task')
    const renames = []
    old.setName = async (n) => { renames.push(n) }
    bridge.registerThread(old)
    store.bindTicketThread('149', 't-149')
    store.releaseTicketThread('149', 'finished')

    await bridge.ensureThread('149')
    const r = await bridge.bindTicket('149', { type: 'task' })
    assert.equal(r.threadId, 't-149')
    assert.deepEqual(renames, ['🎫 149 · task'])
  })

  test('three callers racing one unbound ticket open ONE thread (the 600 ms triple)', async () => {
    const [a, b, c] = await Promise.all([
      bridge.ensureThread('173'), bridge.ensureThread('173'), bridge.ensureThread('173'),
    ])
    assert.equal(created.length, 1, 'one create, not three')
    assert.equal(a.id, b.id)
    assert.equal(b.id, c.id)
    assert.equal(store.threadForTicket('173'), a.id)
  })

  test('a dispatch and a lazy open racing one ticket share the thread too', async () => {
    const [t, r] = await Promise.all([bridge.ensureThread('174'), bridge.bindTicket('174', { type: 'task' })])
    assert.equal(created.length, 1)
    assert.equal(r.ok, true)
    assert.equal(r.threadId, t.id)
  })

  test('a create that loses the bind race deletes its twin rather than leaving it in the list', async () => {
    const winner = makeThread('t-winner', '🎫 175')
    bridge.registerThread(winner)
    // a bind that lands between this path's read and its own bind — the shape a
    // second daemon process or the REST seam can still produce
    let first = true
    const realBind = bridge.bindings.bind
    bridge.bindings.bind = (ticket, id) => {
      if (first) { first = false; store.bindTicketThread('175', 't-winner') }
      return realBind(ticket, id)
    }
    const t = await bridge.ensureThread('175')
    assert.equal(t.id, 't-winner', 'the winner carries the traffic')
    assert.deepEqual(deleted, [created[0].id], 'the empty twin is gone')
  })

  // ---- the ending always leaves the name in its final state (#257) -------------

  test('a second release settles the name the first one dropped', async () => {
    const t = makeThread('t-81', '🔎 81 · curia · task')
    const renames = []
    t.setName = async (n) => { renames.push(n); t.name = n }
    bridge.registerThread(t)
    store.bindTicketThread('81', 't-81')
    // the first release drops the binding without renaming — a thread fetch
    // that failed, or a rename the budget deferred and the process then lost
    const realFetch = bridge.client.channels.fetch
    bridge.client.channels.fetch = async () => null
    await bridge.releaseTicket('81', 'reconcile')
    bridge.client.channels.fetch = realFetch
    assert.deepEqual(renames, [], 'nothing landed, and the binding is gone')

    await bridge.releaseTicket('81', 'finished')
    assert.deepEqual(renames, ['✅ 81 · curia · task'], 'the ending gets its name after all')
  })

  test('a release never renames a thread another ticket has taken over', async () => {
    const t = makeThread('t-shared', '🎫 300 · task')
    const renames = []
    t.setName = async (n) => { renames.push(n) }
    bridge.registerThread(t)
    store.bindTicketThread('299', 't-shared')
    store.releaseTicketThread('299', 'finished')
    store.bindTicketThread('300', 't-shared') // the thread moved on

    await bridge.releaseTicket('299', 'finished')
    assert.deepEqual(renames, [], 'the name is 300\'s business now')
  })

  test('the boot pass settles a ✅ the last process owed but never sent', async () => {
    const stuck = makeThread('t-stuck', '🔎 81 · curia · task')
    const live = makeThread('t-live', '⏳ 82 · task')
    const stranger = makeThread('t-stranger', '🎫 not a curia thread')
    const done = makeThread('t-done3', '✅ 83 · task')
    for (const t of [stuck, live, stranger, done]) {
      bridge.registerThread(t)
      t.setName = async (n) => { t.renamed = n }
    }
    store.bindTicketThread('81', 't-stuck')
    store.releaseTicketThread('81', 'finished') // ended, rename lost with the process
    store.bindTicketThread('82', 't-live') // still running
    store.bindTicketThread('83', 't-done3')
    store.releaseTicketThread('83', 'finished')

    assert.equal(await bridge.settleEndedThreads(), 1)
    assert.equal(stuck.renamed, '✅ 81 · curia · task', 'the ending finally reads as one')
    assert.equal(live.renamed, undefined, 'a live ticket keeps its glyph')
    assert.equal(stranger.renamed, undefined, 'a thread curia never labeled is not curia\'s to rename')
    assert.equal(done.renamed, undefined, 'nothing to do')
  })

  test('the boot pass leaves a cancelled thread alone — #140 keeps its binding', async () => {
    const cancelled = makeThread('t-dead', '⚰️ 84 · task')
    bridge.registerThread(cancelled)
    cancelled.setName = async (n) => { cancelled.renamed = n }
    store.bindTicketThread('84', 't-dead')

    assert.equal(await bridge.settleEndedThreads(), 0)
    assert.equal(cancelled.renamed, undefined)
  })
})

// ---- the thread context through the router (commands.mjs) --------------------

describe('CommandRouter thread context (#93)', () => {
  const WATCH = { watch: [{ repo: 'o/r' }], }
  test('start, next and resume carry the issuing thread to the dispatcher', async () => {
    const got = []
    const dispatcher = {
      config: WATCH,
      routing: { harnesses: {} },
      start: async (t, opts) => { got.push(['start', t, opts.threadId]); return 'ok' },
      next: async (r, opts) => { got.push(['next', r, opts.threadId]); return 'ok' },
      resume: async (t, opts) => { got.push(['resume', t, opts.threadId]); return 'ok' },
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    await router.handle('start 85', 'u1', { threadId: 't-9' })
    await router.handle('next', 'u1', { threadId: 't-9' })
    await router.handle('resume 85', 'u1', { threadId: 't-9' })
    await router.handle('start 85', 'u1') // no context — REST, top-level slash
    assert.deepEqual(got, [
      ['start', '85', 't-9'], ['next', undefined, 't-9'], ['resume', '85', 't-9'], ['start', '85', null],
    ])
  })
})

// ---- bind at claim, release on terminal states (dispatch.mjs) ----------------

const OPEN_ISSUE = {
  number: 42, title: 'a ticket', body: 'body text', state: 'open',
  assignees: [], labels: [],
}

let dir
let binds
let releases
let cancels
let escalations
let restoreCredential // #195: the model credential the container env file needs

beforeEach(() => {
  dir = tmp()
  fs.mkdirSync(path.join(dir, 'data', 'results'), { recursive: true })
  binds = []
  releases = []
  cancels = []
  escalations = []
  restoreCredential = withTestCredential()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  restoreCredential()
})

async function waitFor(cond, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!cond()) throw new Error('waitFor: condition not reached in time')
}

function makeDispatcher(deps = {}, { confirm = async () => true, bound = [] } = {}) {
  const root = path.join(dir, 'work')
  return new Dispatcher({
    config: {
      watch: [{ repo: 'o/r', mode: 'auto' }],
      dispatch: {
        auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
        workspace_root: root, ready_timeout_s: 1, confirm_ttl_h: 4, stop_nudge_budget: 3,
      },
      attach: { ttyd_port: 7681, serve_port: 8443 },
      identity: { allow: ['tester@example.com'], proxy_port: 7682 },
      skills: null,
      // #195: every dispatch prepares a container, so every Dispatcher needs pins
      sandbox: TEST_PINS,
    },
    routing: {
      defaults: { untyped: 'sonnet' },
      models: { sonnet: { provider: 'anthropic', harness: 'claude' } },
      fallbacks: {},
      harnesses: { claude: { template: 'claude "$(cat {prompt_file})"', readyRe: /⏵⏵/ } },
    },
    store: {
      logEvent: (type, data) => ({ type, ...data }),
      openEscalations: () => escalations,
      cancel: () => ({ ok: true }),
      boundTickets: () => bound,
      // #208: no test here queues an operator note, so nothing ever expires
      expireAgentNotes: () => 0,
    },
    notify: () => {},
    confirm,
    threads: {
      bind: async (ticket, opts) => { binds.push({ ticket, ...opts }); return { ok: true } },
      release: async (ticket, reason) => { releases.push({ ticket, reason }) },
      cancelled: async (ticket) => { cancels.push(ticket) },
    },
    log: () => {},
    dataDir: path.join(dir, 'data'),
    daemonPort: 4271,
    deps: {
      viewerLogin: async () => 'me',
      repoMaps: async () => [], mapFrontier: async () => [], flatFrontier: async () => [],
      blockedByOf: async () => [],
      fetchIssue: async () => ({ ...OPEN_ISSUE }),
      claim: async () => {}, unclaim: async () => {},
      hasSession: async () => false, listSessions: async () => [],
      newSession: async () => {}, capturePane: async () => '', killSession: async () => {},
      ...containerDeps(),
      removeWorkspace: async () => {}, removeConfigDir: () => {}, removeCredentials: () => {},
      seedConfigDir: seedConfigDirStub(), writeConnectionSettings: () => {},
      writePrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
      probeTtyd: async () => ({ verified: true }), assertServe: async () => {}, serveOff: async () => {},
      commentIssue: async () => {}, closeIssue: async () => {}, setIssueBody: async () => {},
      issueComments: async () => [], findPullRequest: async () => null,
      createPullRequest: async () => 'url', setPullRequestBody: async () => {},
      deleteRemoteBranch: async () => ({ deleted: true }),
      defaultBranchOf: async () => 'main', commitsOnBranch: async () => [],
      pushBranch: async () => 'abc', hasUnpushedWork: async () => false,
      ...deps,
    },
  })
}

describe('Dispatcher thread binding (#93)', () => {
  test('start binds the thread it ran in, at the claim, with the ticket type', async () => {
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:grilling' }] }),
    })
    assert.match(await d.start('42', { repo: 'o/r', threadId: 't-7' }), /dispatched/)
    assert.deepEqual(binds, [{ ticket: '42', threadId: 't-7', type: 'grilling', repo: 'o/r' }])
  })

  test('an untyped ticket binds with an empty type — the number names the thread', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r', threadId: 't-7' })
    assert.deepEqual(binds, [{ ticket: '42', threadId: 't-7', type: '', repo: 'o/r' }])
  })

  test('a dispatch with no issuing thread asks for a fresh bound thread (threadId null)', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r', by: 'auto' })
    assert.deepEqual(binds, [{ ticket: '42', threadId: null, type: '', repo: 'o/r' }])
  })

  test('a prepare failure keeps the label — a claim release is not ticket-terminal (#140)', async () => {
    const d = makeDispatcher({ createPrivateClone: async () => { throw new Error('disk full') } })
    assert.match(await d.start('42', { repo: 'o/r', threadId: 't-7' }), /failed before the agent could run/)
    assert.deepEqual(releases, [], 'the retry belongs in the same thread')
  })

  test('a confirmed cancel keeps the label — the ticket goes back to the frontier (#140)', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    assert.match(await d.cancel('42', { by: 'test' }), /cancelled/)
    assert.deepEqual(releases, [], 'a later dispatch belongs in the thread its history lives in')
  })

  test('a cancel renames the thread so the list shows it, with no message opened (#200)', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    await d.cancel('42', { by: 'test' })
    assert.deepEqual(cancels, ['42'], 'the binding stays and the signal changes: 🎫 → ⚰️')
  })

  test('a rename that fails does not fail the cancel (#200)', async () => {
    const d = makeDispatcher()
    d.threads.cancelled = async () => { throw new Error('discord is down') }
    await d.start('42', { repo: 'o/r' })
    assert.match(await d.cancel('42', { by: 'test' }), /cancelled/, 'the agent is dead either way')
  })

  test('a finished agent (result recorded) releases the label; an abnormal exit keeps it', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    fs.writeFileSync(path.join(dir, 'data', 'results', 'curia-42.json'), '{}')
    await d.onAgentDone('curia-42')
    assert.deepEqual(releases, [{ ticket: '42', reason: 'finished' }])

    releases.length = 0
    await d.start('43', { repo: 'o/r' })
    await d.onAgentDone('curia-43') // no results file ⇒ abnormal exit, pane kept
    assert.deepEqual(releases, [], 'post-mortem traffic still belongs in the labeled thread')
  })

  test('reconcile releases a binding only when the issue is positively closed (#140)', async () => {
    const d = makeDispatcher(
      { fetchIssue: async (repo, n) => ({ ...OPEN_ISSUE, number: Number(n), state: String(n) === '42' ? 'closed' : 'open' }) },
      { bound: ['42', '44'] },
    )
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [{ ticket: '42', reason: 'reconcile' }],
      'the closed ticket loses its label; the open one keeps it for the resumed agent')
  })

  test('reconcile keeps the binding of a dead agent on an open ticket, even with no escalation (#140)', async () => {
    const d = makeDispatcher({}, { bound: ['42'] }) // fetchIssue default: state open
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [], 'agent death is not a ticket-terminal state')
  })

  test('reconcile keeps the label of a closed ticket while a human is still being asked', async () => {
    const d = makeDispatcher(
      { fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed' }) },
      { bound: ['43'] },
    )
    escalations.push({ id: 'esc-1', agent: 'curia-43', ticket: '43', status: 'open', kind: 'review-gate' })
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [], 'the open escalation traffic must keep landing in the labeled thread')
  })

  test('reconcile releases a binding whose issue is positively absent everywhere', async () => {
    const d = makeDispatcher(
      { fetchIssue: async () => { throw new Error('gh: Not Found (HTTP 404)') } },
      { bound: ['42'] },
    )
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [{ ticket: '42', reason: 'reconcile' }])
  })

  test('reconcile keeps every binding when the issue read fails', async () => {
    const d = makeDispatcher(
      { fetchIssue: async () => { throw new Error('network is down') } },
      { bound: ['42'] },
    )
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [], 'an unreadable issue is not evidence — the next pass retries')
  })

  test('reconcile with an indeterminate session list releases nothing', async () => {
    const d = makeDispatcher({ listSessions: async () => { throw new Error('tmux wedged') } }, { bound: ['42'] })
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [])
  })
})
