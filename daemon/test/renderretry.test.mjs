// The bounded render retry (#261). The schedule lives in its own module for one
// reason: the timers that drive it sit in index.mjs, where nothing can wait 15
// minutes for them, so the ARITHMETIC is what gets pinned here — the offsets,
// the restart math, and the point at which the daemon stops trying.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { RENDER_RETRY_MS, remainingRenderRetries } from '../src/renderretry.mjs'

const OPENED = '2026-08-10T12:00:00Z'
const at = (min) => Date.parse(OPENED) + min * 60_000

describe('the render retry the escalation owns', () => {
  test('the schedule is 1m, 5m, 15m — three tries, then never again', () => {
    assert.deepEqual(RENDER_RETRY_MS, [60_000, 300_000, 900_000])
  })

  test('a fresh escalation arms all three, measured from esc_open', () => {
    assert.deepEqual(remainingRenderRetries(OPENED, at(0)), [60_000, 300_000, 900_000])
  })

  test('a restart re-arms the rest of the window, not a fresh one', () => {
    // Six minutes of downtime cost the 1m and 5m tries. The 15m one is still
    // ahead, and it stays 15 minutes after esc_open — a daemon that restarts
    // every minute must not retry forever.
    assert.deepEqual(remainingRenderRetries(OPENED, at(6)), [9 * 60_000])
  })

  test('past the last offset the window is over and nothing is armed', () => {
    assert.deepEqual(remainingRenderRetries(OPENED, at(15)), [])
    assert.deepEqual(remainingRenderRetries(OPENED, at(600)), [])
  })

  test('a record with no readable open time arms nothing', () => {
    assert.deepEqual(remainingRenderRetries(undefined, at(0)), [])
    assert.deepEqual(remainingRenderRetries('not a date', at(0)), [])
  })
})
