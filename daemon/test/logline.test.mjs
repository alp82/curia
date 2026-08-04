// journalctl rendering of a daemon log line (#190).
//
// The ticket accused the em dash, and the em dash is innocent: journalctl's
// `shall_print` calls `utf8_is_printable`, which rejects CONTROL code points
// and passes every valid UTF-8 character above them. Measured on the box —
// the warning it named printed in full at both boots, while 64 `docker build`
// lines carrying ANSI color and carriage-return redraws printed as
// `[NNNB blob data]`.
//
// So the oracle here is utf8_is_printable itself, applied to the output: no
// input may leave a control character behind. The named cases below say WHICH
// inputs, and the oracle says the rule holds for all of them.
//
// Every code point is named by number: a test about invisible characters must
// not contain any.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { lastFrame, readable } from '../src/logline.mjs'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CR = String.fromCharCode(0x0d)
const TAB = String.fromCharCode(0x09)
const NL = String.fromCharCode(0x0a)

// systemd's unichar_is_control: C0 except tab and newline, then DEL and C1.
function printable(text) {
  return [...text].every((ch) => {
    const cp = ch.codePointAt(0)
    if (cp === 0x09 || cp === 0x0a) return true
    return cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f)
  })
}

// The two shapes the box actually held, quoted from `journalctl -o json`.
const REAL_ANSI = `[image curia-179] ${ESC}[91m+ apt-get update`
// As the stream reader sees it (no prefix yet), and as the log would hold it.
const REAL_CR_RAW = `(Reading database ... 5%${CR}(Reading database ... 50%${CR}(Reading database ... 6096 files and directories currently installed.)`
const REAL_CR = `[image curia-179] ${REAL_CR_RAW}`

describe('readable', () => {
  test('leaves the daemon prose alone, em dash and all', () => {
    const warning = 'WARNING: no container-facing listener (docker’s default bridge network states no gateway address — a sandboxed worker cannot reach ask_human or the Stop hook)'
    assert.equal(readable(warning), warning)
    assert.ok(printable(warning), 'the accused line was printable all along')
  })

  test('drops ANSI color and keeps the words', () => {
    assert.equal(readable(REAL_ANSI), '[image curia-179] + apt-get update')
  })

  test('a color reset alone leaves an empty line, not a blob', () => {
    assert.equal(readable(`[image curia-179] ${ESC}[0m`), '[image curia-179] ')
  })

  test('drops an OSC title sequence, either terminator', () => {
    assert.equal(readable(`a${ESC}]0;a title${BEL}b`), 'ab')
    assert.equal(readable(`a${ESC}]0;a title${ESC}\\b`), 'ab')
  })

  test('keeps tab and newline, which journalctl prints', () => {
    assert.equal(readable(`a${TAB}b${NL}c`), `a${TAB}b${NL}c`)
  })

  test('strips a carriage return it cannot collapse, so the line still prints', () => {
    assert.ok(printable(readable(REAL_CR)))
    assert.ok(readable(REAL_CR).startsWith('[image curia-179] '), 'the prefix survives')
  })

  test('strips a bare control character that no sequence explains', () => {
    for (const cp of [0x00, 0x01, 0x08, 0x0b, 0x1f, 0x7f, 0x9f]) {
      assert.equal(readable(`a${String.fromCharCode(cp)}b`), 'ab', `code point ${cp}`)
    }
  })

  test('output is printable for every input that was not', () => {
    const inputs = [
      REAL_ANSI,
      REAL_CR,
      `${ESC}[91m${ESC}[1m${CR}mixed${ESC}[0m${String.fromCharCode(0x00)}`,
      `${ESC}[?25l cursor hidden ${ESC}[?25h`,
      `${ESC}`, // a truncated escape, split across two stream chunks
      `${ESC}[`,
      String.fromCharCode(0x9b) + '[31m', // C1 CSI, the single-byte form
    ]
    for (const input of inputs) {
      assert.ok(!printable(input) || input === '', `fixture ${JSON.stringify(input)} should be unprintable`)
      assert.ok(printable(readable(input)), `readable() left a control char in ${JSON.stringify(input)}`)
    }
  })
})

describe('lastFrame', () => {
  test('collapses a redraw to the frame left on screen', () => {
    assert.equal(
      lastFrame(REAL_CR_RAW),
      '(Reading database ... 6096 files and directories currently installed.)',
    )
  })

  test('a trailing carriage return keeps the frame before it', () => {
    assert.equal(lastFrame(`done${CR}`), 'done')
    assert.equal(lastFrame(CR), '')
  })

  test('a line with no carriage return is untouched', () => {
    assert.equal(lastFrame('+ apt-get update'), '+ apt-get update')
    assert.equal(lastFrame(''), '')
  })

  test('runs BEFORE the log prefix, which is why the prefix survives', () => {
    // The daemon writes `[image <session>] ${line}`. Collapsing after that
    // would drop the prefix with the first frame, so the log would stop
    // saying whose build it is.
    const emitted = `[image curia-179] ${readable(lastFrame(REAL_CR_RAW))}`
    assert.equal(
      emitted,
      '[image curia-179] (Reading database ... 6096 files and directories currently installed.)',
    )
    assert.ok(printable(emitted))
  })
})
