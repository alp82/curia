// The one gate every thread rename goes through (#199). Discord holds a
// hidden, name-specific budget of 2 renames per thread per 10 minutes —
// hidden meaning the x-ratelimit-* headers still show 7 remaining on the
// visible bucket at the moment the 429 lands (scope "shared",
// retry_after ≈ 597 s, measured in docs/live-checks/199). So no client can
// see this budget before spending it, and the gate accounts for it itself.
//
// Three rules, in the order they earn their keep:
//
//  1. LATEST WINS. The gate holds one desired name per thread, never a queue.
//     A rename that cannot happen now is not dropped and not replayed stale —
//     whatever the desired name is WHEN A SLOT FREES is what lands. That is
//     the reconcile the ticket demands: a hit budget makes the name late,
//     never wrong.
//  2. RESERVE. A rename may declare it needs a way back (`reserve`) — the
//     glyph that says "answer me" must be clearable, so it spends a slot only
//     while a second slot stays free for the clear. It is worse to leave ⏳ on
//     an answered ticket than to be late adding it (#126's lesson), so the
//     asymmetry points exactly one way: adding waits, clearing spends the
//     last slot.
//  3. REFUND. The slot is spent before the PATCH and refunded when the apply
//     reports it did nothing (name already right, thread gone) — only real
//     PATCHes count against a budget only real PATCHes consume.
//
// The ledger dies with the process. A restart therefore starts optimistic,
// and the one rename that may hit the real 429 rides discord.js's own
// retry-after wait — late again, and the serialized chain re-checks desired
// after it, so even that path converges on the right name.

export const RENAME_LIMIT = 2
export const RENAME_WINDOW_MS = 600_000

export class ThreadRenamer {
  // apply(threadId, name) -> true when a real PATCH went out; false when the
  // name was already right or the thread is gone. Throws are logged and the
  // spend kept — an error leaves Discord's ledger unknown, and over-counting
  // is the direction that never 429s.
  // `timers` is the injection seam for tests — production never overrides it.
  constructor({ apply, log = console.log, now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout } }) {
    this.apply = apply
    this.log = log
    this.now = now
    this.timers = timers
    this.threads = new Map() // threadId -> { spends, desired, applied, timer, chain }
  }

  #thread(id) {
    let s = this.threads.get(id)
    if (!s) {
      s = { spends: [], desired: null, applied: null, timer: null, chain: Promise.resolve() }
      this.threads.set(id, s)
    }
    return s
  }

  // The name this gate currently intends for a thread — the pending desired
  // if one exists, else null. Every glyph SWAP reads its base here first and
  // falls back to the actual Discord name: the actual name lags whenever a
  // rename is deferred or still in flight, and a swap computed on the lagging
  // name resurrects the very glyph the gate already replaced. That was the
  // stuck-🎫/stuck-🔎 bug on finished tickets — a status flag racing the
  // release, each basing its swap on a name the other had already changed.
  desired(threadId) {
    return this.threads.get(threadId)?.desired?.name ?? null
  }

  // Record the desired name and drain. Returns the chain so callers that need
  // the attempt to have happened (tests, teardown paths) can await it; the
  // chain never rejects.
  set(threadId, name, { reserve = false } = {}) {
    const s = this.#thread(threadId)
    s.desired = { name, reserve }
    s.chain = s.chain.then(() => this.#step(threadId, s)).catch((e) => {
      this.log(`thread rename for ${threadId} failed: ${e.message}`)
    })
    return s.chain
  }

  async #step(threadId, s) {
    const d = s.desired
    if (!d || d.name === s.applied) return
    const cutoff = this.now() - RENAME_WINDOW_MS
    s.spends = s.spends.filter((t) => t > cutoff)
    const free = RENAME_LIMIT - s.spends.length
    const need = d.reserve ? 2 : 1
    if (free < need) return this.#defer(threadId, s, need - free)
    if (s.timer) { this.timers.clear(s.timer); s.timer = null }
    s.spends.push(this.now())
    try {
      if (!(await this.apply(threadId, d.name))) s.spends.pop()
      s.applied = d.name
    } catch (e) {
      this.log(`thread rename for ${threadId} failed: ${e.message}`)
    }
  }

  // Wake when enough of the oldest spends have left the window, and apply
  // whatever is desired THEN. One timer per thread: a fresh set() re-steps on
  // its own, and the step either lands or schedules a better wake-up.
  #defer(threadId, s, deficit) {
    if (s.timer) this.timers.clear(s.timer)
    const wake = s.spends[deficit - 1] + RENAME_WINDOW_MS - this.now()
    s.timer = this.timers.set(() => {
      s.timer = null
      s.chain = s.chain.then(() => this.#step(threadId, s)).catch((e) => {
        this.log(`thread rename for ${threadId} failed: ${e.message}`)
      })
    }, Math.max(wake, 0) + 50)
    s.timer?.unref?.()
  }

  stop() {
    for (const s of this.threads.values()) {
      if (s.timer) { this.timers.clear(s.timer); s.timer = null }
    }
  }
}
