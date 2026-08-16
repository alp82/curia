// Tests for src/messaging.mjs (#95): the per-turn messaging standard from the
// messaging-discipline decision (#89) — the helpers, and the lint that holds
// every reply path to the standard.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIGNALS, smallPrint, link, clampList, lintReply, chunkMessage, promptTitle, elapsedLabel,
  speakerName, failureProse, FailureLines, CHUNK_LIMIT, SPEAKER_NAME_LIMIT,
  FAILURE_PROSE_LIMIT, FAILURE_REPEAT_WINDOW_MS, CODE_BLOCK_LIMIT, fenceParts,
} from '../src/messaging.mjs'

describe('smallPrint', () => {
  test('prefixes every line with the -# marker', () => {
    assert.equal(smallPrint('one'), '-# one')
    assert.equal(smallPrint('one\ntwo'), '-# one\n-# two')
  })
})

describe('link', () => {
  test('wraps a url in <> so Discord skips the embed', () => {
    assert.equal(link('https://github.com/alp82/curia/pull/1'), '<https://github.com/alp82/curia/pull/1>')
  })
})

describe('clampList', () => {
  test('a list at or under the cap passes through untouched', () => {
    const lines = ['a', 'b', 'c']
    assert.deepEqual(clampList(lines, 3), lines)
  })

  test('a longer list keeps the head and says how many more, in small print', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']
    assert.deepEqual(clampList(lines, 2), ['a', 'b', '-# … 3 more'])
  })
})

describe('lintReply', () => {
  test('a conforming reply produces no violations', () => {
    const reply = [
      `${SIGNALS.work} dispatched o/r#42 → \`curia-42\` on **claude-sonnet-5** — watching for readiness`,
      `${SIGNALS.ticket} #85 **Fix the parser** \`grilling\``,
      `${SIGNALS.link} timeline ${link('https://example.test/t/42')}`,
      smallPrint('… 3 more'),
    ].join('\n')
    assert.deepEqual(lintReply(reply), [])
  })

  test('every signal in the set passes the lint', () => {
    assert.deepEqual(lintReply(Object.values(SIGNALS).join(' ')), [])
  })

  test('headings, blockquotes, and tables are violations', () => {
    assert.equal(lintReply('# heading').length, 1)
    assert.equal(lintReply('> quoted').length, 1)
    assert.equal(lintReply('| a | b |').length, 1)
  })

  test('emoji outside the signal set are violations', () => {
    assert.equal(lintReply('🚀 dispatched').length, 1)
    assert.equal(lintReply('🛑 cancelled').length, 1)
    assert.equal(lintReply('💤 idle ⏳ soon').length, 2)
  })

  test('small print is exempt from the heading check, not from the emoji check', () => {
    assert.deepEqual(lintReply(smallPrint('meta line')), [])
    assert.equal(lintReply(smallPrint('🚀 meta')).length, 1)
  })

  // #432: the code-block table is the one table form Discord renders (#414),
  // so the markdown rules read prose only.
  test('a table inside a fence passes, the same table outside it does not', () => {
    const rows = '| a | b |\n|---|---|\n| 1 | 2 |'
    assert.deepEqual(lintReply(`the shape:\n\`\`\`\n${rows}\n\`\`\``), [])
    assert.equal(lintReply(`the shape:\n${rows}`).length, 3)
  })

  test('a heading inside a fence passes, and prose after the fence is read again', () => {
    assert.deepEqual(lintReply('```\n# not a heading\n```'), [])
    assert.equal(lintReply('```\n# fine\n```\n\n# heading').length, 1)
  })

  test('an emoji outside the signal set is a violation inside a fence too', () => {
    assert.equal(lintReply('```\n🚀 launched\n```').length, 1)
  })

  test('a code block over the cap is a violation, one under it is not', () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => `row ${i} ${'x'.repeat(30)}`).join('\n')
    assert.deepEqual(lintReply(`\`\`\`\n${rows(20)}\n\`\`\``), [])
    const over = lintReply(`\`\`\`\n${rows(60)}\n\`\`\``)
    assert.equal(over.length, 1)
    assert.match(over[0], /code block of \d+ chars over the 1000 cap/)
  })

  test('the cap is per block, so two blocks under it pass', () => {
    const half = 'y'.repeat(CODE_BLOCK_LIMIT - 20)
    assert.deepEqual(lintReply(`\`\`\`\n${half}\n\`\`\`\n\nand\n\n\`\`\`\n${half}\n\`\`\``), [])
  })
})

// #432: a fence is a unit. The parts keep source order and lose nothing.
describe('fenceParts', () => {
  test('prose with no fence is one part', () => {
    assert.deepEqual(fenceParts('one\n\ntwo'), [{ code: false, text: 'one\n\ntwo' }])
  })

  test('a fence is its own part, with the prose on both sides', () => {
    const parts = fenceParts('before\n```js\nlet a = 1\n```\nafter')
    assert.deepEqual(parts.map((p) => p.code), [false, true, false])
    assert.equal(parts[1].text, '```js\nlet a = 1\n```')
    assert.equal(parts[1].open, '```js')
    assert.equal(parts[1].close, '```')
    assert.equal(parts[2].text, 'after')
  })

  test('a tilde fence and a longer marker both close on their own kind', () => {
    const parts = fenceParts('~~~~\nhas ``` inside\n~~~~\n')
    assert.equal(parts[0].code, true)
    assert.equal(parts[0].text, '~~~~\nhas ``` inside\n~~~~')
  })

  test('an unclosed fence runs to the end and reports no closing marker', () => {
    const parts = fenceParts('```\nno end')
    assert.equal(parts.length, 1)
    assert.equal(parts[0].close, null)
    assert.equal(parts[0].text, '```\nno end')
  })

  test('the parts rejoin into the original text', () => {
    const text = 'a\n\nb\n```\nc\n```\n\nd\n~~~\ne\n~~~\nf'
    assert.equal(fenceParts(text).map((p) => p.text).join('\n'), text)
  })
})

// #119: long composed messages become consecutive chunks instead of a silent
// clip at Discord's cap — the review gate lost its charting proposal to one.
describe('chunkMessage', () => {
  test('short text is one chunk, unchanged', () => {
    assert.deepEqual(chunkMessage('hello\n\nworld'), ['hello\n\nworld'])
  })

  test('splits at paragraph boundaries and loses nothing', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `paragraph ${i} ${'x'.repeat(300)}`)
    const text = paras.join('\n\n')
    const chunks = chunkMessage(text)
    assert.ok(chunks.length > 1)
    for (const c of chunks) assert.ok(c.length <= CHUNK_LIMIT, `chunk of ${c.length} over the limit`)
    // no paragraph is cut: every original paragraph appears whole in some chunk
    for (const p of paras) assert.ok(chunks.some((c) => c.includes(p)), 'paragraph lost or split')
  })

  test('a paragraph over the limit falls back to line splits', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${'y'.repeat(100)}`)
    const chunks = chunkMessage(lines.join('\n'))
    for (const c of chunks) assert.ok(c.length <= CHUNK_LIMIT)
    for (const l of lines) assert.ok(chunks.some((c) => c.includes(l)))
  })

  test('a single line over the limit is hard-sliced, still complete', () => {
    const text = 'z'.repeat(CHUNK_LIMIT * 2 + 10)
    const chunks = chunkMessage(text)
    for (const c of chunks) assert.ok(c.length <= CHUNK_LIMIT)
    assert.equal(chunks.join(''), text)
  })

  // #432, proved live in #414: a 34-row table in one fence split across two
  // messages, and both halves rendered as literal backticks.
  const fences = (chunk) => (chunk.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? []).length
  const table = (rows) => Array.from(
    { length: rows },
    (_, i) => `row ${String(i).padStart(2, '0')} | ${'col'.padEnd(12)} | value`,
  )

  test('every chunk closes the fences it opens', () => {
    const text = `${'prose '.repeat(200)}\n\n\`\`\`\n${table(60).join('\n')}\n\`\`\`\n\ntail`
    const chunks = chunkMessage(text)
    assert.ok(chunks.length > 1)
    for (const c of chunks) {
      assert.equal(fences(c) % 2, 0, `unbalanced fence in chunk: ${c.slice(0, 80)}`)
      assert.ok(c.length <= CHUNK_LIMIT, `chunk of ${c.length} over the limit`)
    }
  })

  test('a split block loses no row and keeps every row inside a fence', () => {
    const rows = table(60)
    const chunks = chunkMessage(`\`\`\`\n${rows.join('\n')}\n\`\`\``)
    assert.ok(chunks.length > 1)
    const body = chunks.flatMap((c) => c.split('\n').filter((l) => !/^(`{3,}|~{3,})/.test(l)))
    assert.deepEqual(body, rows)
    for (const c of chunks) {
      assert.match(c, /^```\n/)
      assert.match(c, /\n```$/)
    }
  })

  test('the info string is repeated on every reopened fence', () => {
    const chunks = chunkMessage(`\`\`\`diff\n${table(60).join('\n')}\n\`\`\``)
    assert.ok(chunks.length > 1)
    for (const c of chunks) assert.match(c, /^```diff\n/)
  })

  test('a block that fits moves whole into one chunk instead of straddling', () => {
    const block = `\`\`\`\n${table(12).join('\n')}\n\`\`\``
    assert.ok(block.length < CHUNK_LIMIT)
    const chunks = chunkMessage(`${'prose '.repeat(250)}\n\n${block}\n\nafter`)
    assert.ok(chunks.length > 1)
    assert.ok(chunks.some((c) => c.includes(block)), 'the block was split')
  })

  test('prose around a split block still reads as prose', () => {
    const chunks = chunkMessage(`intro\n\n\`\`\`\n${table(60).join('\n')}\n\`\`\`\n\noutro`)
    assert.ok(chunks[0].startsWith('intro'))
    assert.ok(chunks.at(-1).endsWith('outro'))
  })

  test('an unclosed fence stays unclosed at the end and nowhere else', () => {
    const chunks = chunkMessage(`\`\`\`\n${table(60).join('\n')}`)
    assert.ok(chunks.length > 1)
    for (const c of chunks.slice(0, -1)) assert.equal(fences(c) % 2, 0)
    assert.equal(fences(chunks.at(-1)) % 2, 1)
  })

  test('one code line longer than a whole chunk is sliced inside the fence', () => {
    const chunks = chunkMessage(`\`\`\`\n${'q'.repeat(CHUNK_LIMIT * 2)}\n\`\`\``)
    assert.ok(chunks.length > 1)
    for (const c of chunks) {
      assert.ok(c.length <= CHUNK_LIMIT)
      assert.equal(fences(c), 2)
    }
    assert.equal(chunks.map((c) => c.split('\n')[1]).join(''), 'q'.repeat(CHUNK_LIMIT * 2))
  })
})

// #118: the one-line handle on a prompt — never a mid-word cut, which is how
// the reminder produced "frontier re" (#108 item 13).
describe('promptTitle', () => {
  test('takes the first non-empty line and strips emphasis', () => {
    assert.equal(promptTitle('\n**Q2 — the one promise.**\n\nbody'), 'Q2 — the one promise.')
  })

  test('cuts at a word boundary with an ellipsis, never mid-word', () => {
    assert.equal(promptTitle('alpha bravo charlie delta echo', 20), 'alpha bravo charlie…')
    assert.equal(promptTitle('short enough', 20), 'short enough')
  })
})

describe('speakerName (#108 item 15, narrowed by #254)', () => {
  test('the session name, alone — builder and reviewer alike', () => {
    assert.equal(speakerName('curia-9'), 'curia-9')
    assert.equal(speakerName('curia-review-9'), 'curia-review-9')
  })

  test('a ticket title never reaches the label, however long', () => {
    const long = 'A very long ticket title that goes on and on about the landing page charting effort and more'
    assert.equal(speakerName('curia-121', long), 'curia-121')
  })

  test('no name ever truncates: every session name fits Discord\'s cap with room to spare', () => {
    // Four digits outlives this tracker, and the reviewer prefix is the longest
    // one curia mints. The old shape spent the whole budget on the title and
    // overspent it by one, so the longest names were REFUSED by Discord.
    for (const agent of ['curia-1', 'curia-9999', 'curia-review-1', 'curia-review-9999']) {
      const name = speakerName(agent)
      assert.ok(name.length <= SPEAKER_NAME_LIMIT, `${name} is ${name.length} chars`)
      assert.ok(!name.includes('…'), `${name} carries an ellipsis`)
    }
  })
})

describe('elapsedLabel', () => {
  test('minutes and hours read as waits', () => {
    const now = Date.now()
    assert.equal(elapsedLabel(new Date(now - 30_000).toISOString(), now), 'under a minute')
    assert.equal(elapsedLabel(new Date(now - 56 * 60_000).toISOString(), now), '56 min')
    assert.equal(elapsedLabel(new Date(now - 125 * 60_000).toISOString(), now), '2 h 05 min')
  })

  test('garbage input yields null, not NaN text', () => {
    assert.equal(elapsedLabel('not a date'), null)
  })
})

// The #81 stderr, as Node hands it over: the command echo curia built, then
// what git said about it. The whole of it went into the thread three times.
const PUSH_STDERR = [
  "Command failed: git -C /home/alp/curia/work/repos/alp82__curia/wt/81 -c credential.helper=!gh auth git-credential push https://github.com/alp82/curia.git abc1234:refs/heads/curia/81",
  "fatal: cannot change to '/home/alp/curia/work/repos/alp82__curia/wt/81': No such file or directory",
].join('\n')

describe('failureProse (#256)', () => {
  test('the #81 stderr becomes one sentence, and the daemon path is not in it', () => {
    const prose = failureProse(PUSH_STDERR)
    assert.equal(prose, 'the checkout on the box is gone')
    assert.ok(!/\/home\/alp/.test(prose), 'a daemon path reached the thread')
    assert.ok(!prose.includes('\n'), 'more than one line reached the thread')
  })

  test('one cause reads one way, whichever wording git chose', () => {
    assert.equal(failureProse('fatal: Authentication failed for \'https://github.com/o/r.git\''), 'GitHub refused the daemon login')
    assert.equal(failureProse('remote: Invalid username or password.'), 'GitHub refused the daemon login')
    assert.equal(failureProse('fatal: Updates were rejected because the remote contains work'), 'the branch on GitHub has moved on, so the push was refused')
    assert.equal(failureProse('fatal: unable to access: Could not resolve host: github.com'), 'the box could not reach GitHub')
    assert.equal(failureProse("can't find pane: curia-42"), 'the tmux session for this agent is gone')
  })

  test('the fatal line wins over the context lines above it', () => {
    const raw = 'remote: Support for password authentication was removed.\nfatal: Authentication failed'
    assert.equal(failureProse(raw), 'GitHub refused the daemon login')
  })

  test('an unrecognized failure still says what happened, in one bounded sentence', () => {
    const prose = failureProse('Command failed: gh pr create\nerror: something nobody has seen before')
    assert.equal(prose, 'something nobody has seen before')
    const long = failureProse(`error: ${'a reason '.repeat(40)}`)
    assert.ok(long.length <= FAILURE_PROSE_LIMIT + 1, `${long.length} chars reached the thread`)
    assert.ok(long.endsWith('…'))
  })

  test('a quoted daemon path in an unrecognized failure is named, not pasted', () => {
    assert.equal(
      failureProse("error: unable to write '/home/alp/curia/work/cfg/curia-42/settings.json'"),
      'unable to write a path on the box',
    )
  })

  test('nothing to translate says so rather than composing an empty line', () => {
    assert.equal(failureProse(''), 'the daemon reported no reason')
    assert.equal(failureProse(undefined), 'the daemon reported no reason')
  })

  test('the composed sentence passes the reply lint', () => {
    for (const raw of [PUSH_STDERR, 'fatal: Authentication failed', 'error: unheard of']) {
      assert.deepEqual(lintReply(failureProse(raw)), [])
    }
  })
})

describe('FailureLines (#256)', () => {
  const WINDOW = FAILURE_REPEAT_WINDOW_MS

  test('a retry loop inside the window says the failure once', () => {
    const f = new FailureLines()
    const t = Date.now()
    assert.equal(f.say('k', 'it failed', t), 'it failed')
    assert.equal(f.say('k', 'it failed', t + 30_000), null)
    assert.equal(f.say('k', 'it failed', t + 90_000), null)
  })

  test('a loop that outlasts the window says it again, with the count', () => {
    const f = new FailureLines()
    const t = Date.now()
    f.say('k', 'it failed', t)
    f.say('k', 'it failed', t + 4 * 60_000)
    const again = f.say('k', 'it failed', t + WINDOW + 60_000)
    assert.match(again, /^it failed \(the same failure, 3 times in 11 min\)$/)
  })

  test('a failure that returns after the window is a fresh burst, said in full', () => {
    const f = new FailureLines()
    const t = Date.now()
    f.say('k', 'it failed', t)
    assert.equal(f.say('k', 'it failed', t + WINDOW + 1000), 'it failed')
  })

  test('two different failures both speak', () => {
    const f = new FailureLines()
    const t = Date.now()
    assert.equal(f.say('k', 'the login was refused', t), 'the login was refused')
    assert.equal(f.say('k2', 'the checkout is gone', t + 1000), 'the checkout is gone')
  })

  test('a key nobody has raised in a long time is forgotten, not held forever', () => {
    const f = new FailureLines()
    const t = Date.now()
    f.say('old', 'it failed', t)
    f.say('new', 'it failed', t + WINDOW * 3)
    assert.deepEqual([...f.seen.keys()], ['new'])
  })
})
