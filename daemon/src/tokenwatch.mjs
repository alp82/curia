// The credential watch (#380).
//
// The daemon has measured what its GitHub credential reaches since #155, once
// per watched repo. That reading went to `log()`, at boot, where nobody reads
// it. A repo curia cannot reach takes every agent it dispatches there with it,
// so the one fact the operator must act on was the one written where they never
// look.
//
// #345 refused a scheduler and named this need a WATCH rather than a clock:
// one event, at its own instant, stated where the operator reads. That is what
// this file is. It files no ticket and it dispatches nothing, so the refusal
// stands — it is a daemon-internal timer beside the Serve assert and the
// render retry.
//
// Four rules settle it, and each one keeps a wrong answer out.
//
//   1. TWO SURFACES, ONE MEASUREMENT. A plain line in #curia states the event
//      at its instant, and the dashboard's Needs-you list holds the standing
//      item until the reading clears. One journal event feeds both, so Discord
//      and the console can never state different numbers. An escalation record
//      was put up and turned down: an escalation has an agent and an answer,
//      and this has neither.
//
//   2. SAID ONCE, NOT AT EVERY PASS. The journal remembers what was already
//      said, so a deploy repeats nothing and a restart inherits the warning.
//      Without this the line would be re-said every six hours, which is how a
//      warning teaches its reader to skip it.
//
//   3. THE READING KEYS ON THE REPO. The same installation covers one repo and
//      misses another, because the grant lives on GitHub rather than on the box.
//
//   4. A LINE THAT DID NOT REACH DISCORD IS NOT SAID. The boot probe can run
//      before the bridge is up, and the bridge can be down for hours. So the
//      event carries `said`, and an unsaid reading is re-announced by the next
//      pass and by `flush()` at bridge start. The journal still holds it, so
//      the console shows it either way.
//
// THE EXPIRY HALF IS GONE (#466). This watch used to read a second fact per
// repo: how many days were left on the PAT that reached it, said once at each
// step of a ladder. #389, #390 and #392 cut every holder over to the GitHub App
// (#338, ADR-0018), and #466 retired the last PAT with it. An installation token
// lives one hour, the daemon refreshes it, and GitHub states no expiry header
// for one at all — measured on the box. So there is no expiry left to read
// anywhere in curia, and a ladder nothing can climb is not kept for a holder
// that might come back.
//
// WHAT REPLACED THE REACH PROBE. A PAT was measured by reading the repo with it,
// and that read had a hole: every fine-grained PAT reads public repositories, so
// a public repo left off the token answered 200. A minted token has the same
// hole and it is wider — an installation token reads every public repository on
// GitHub, including one on an owner the app was never installed on. So the
// question is put to the installation instead: which repositories does it cover?
// That answers for private and public alike, and it is one call per owner.

// Six hours, so a reading gets four chances a day to be seen. One mint and one
// HTTP request per watched owner, which is what makes this cheap enough to
// state as an interval. Arming a timer per instant was put up and turned down:
// it cannot see a grant an operator narrowed by hand, and that is the failure
// that arrives with no warning at all.
export const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000

// Rule 3.
export function warningKey({ holder, key, repo }) {
  return `${holder}:${key}:${repo}`
}

// Rule 2 and rule 4, in one predicate. `entry` is the last `token_warned` this
// key has, out of the reduction, or null.
export function shouldSay(entry, reading) {
  if (!entry) return true
  if (!entry.said) return true // rule 4: it was measured, not said
  if (entry.fault !== reading.fault) return true
  return entry.message !== reading.message
}

// One probe answer becomes one reading, or null when the credential is well.
// The caller hands over what it measured plus who holds it.
//
// `unmeasured` is the third answer and it is not a fault: GitHub being slow or
// down says nothing about the grant. It reads as null here, so nothing is said
// — and `keysOf` below is what stops it being read as good news either.
//
// `fix` is the act that ends the warning, and the caller writes it because the
// caller knows which credential it measured.
export function readingOf({ holder, key, repo, refusal, fix, ok, unmeasured, message }) {
  if (unmeasured || ok) return null
  return { fault: 'unreachable', holder, key, repo, refusal, fix, message: message ?? 'GitHub gave no reason' }
}

// One reading per key, whatever the pass measured twice. The FIRST one wins,
// because two readings on one key are the same measurement of the same grant.
export function dedupe(readings) {
  const seen = new Set()
  const out = []
  for (const r of readings) {
    if (!r) continue
    const k = warningKey(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

// The key one probe answer holds, whatever it measured. A pass clears a
// standing warning by NOT re-measuring it, so an answer that measured nothing
// must still protect its own key — otherwise one slow GitHub call posts a ✅ for
// a repo the app still cannot reach.
export function keysOf({ holder, key, repo }) {
  return [warningKey({ holder, key, repo })]
}

// ---- the lines --------------------------------------------------------------
//
// CuriaBot's own voice: these state mechanics, which is the half ADR-0013 gives
// the bot. Every one of them names the act that ends it, because a warning the
// reader cannot act on is a log line with an emoji on it.

export function warningLine(r) {
  return `${'⚠️'} curia cannot reach ${r.repo} (${r.message}). ${r.refusal}. ${r.fix}`
}

// One line, because there is one fault left. A warning the journal kept from
// before #466 clears through here too, and it reads right: whatever curia could
// not reach, it reaches now.
export function clearedLine(entry) {
  return `${'✅'} curia reaches ${entry.repo} again.`
}

// ---- the watch --------------------------------------------------------------

export class TokenWatch {
  // `probe` returns every reading this pass measured, one per repo per holder,
  // in the shape `readingOf` takes. `entries` and `entryFor` read the reduction's
  // reduction. `announce` resolves true when the words reached Discord.
  constructor({ probe, entries, entryFor, journal, announce, log = () => {}, intervalMs = PROBE_INTERVAL_MS }) {
    this.probe = probe
    this.entries = entries
    this.entryFor = entryFor
    this.journal = journal
    this.announce = announce
    this.log = log
    this.intervalMs = intervalMs
    this.timer = null
  }

  // One measurement, and whatever it makes curia say. It never throws: a
  // network failure is a fact about the network rather than about the grant,
  // which is the rule the boot probe has held since #155.
  async pass() {
    let answers
    try {
      answers = await this.probe()
    } catch (e) {
      this.log(`the credential watch could not probe (${e.message}) — not treating that as a bad token`)
      return
    }
    const readings = dedupe(answers.map((a) => readingOf(a)).filter(Boolean))
    const standing = new Set(readings.map((r) => warningKey(r)))
    // An answer curia could not take says nothing in either direction, so its
    // keys stand exactly as they were.
    for (const a of answers) {
      if (!a.unmeasured) continue
      for (const k of keysOf(a)) standing.add(k)
    }

    // The clear comes FIRST, so an operator who repaired an installation
    // overnight reads the ✅ above whatever else this pass says. It is journalled whether or not
    // the words landed: the console must not keep showing a warning curia has
    // measured away, and a lost ✅ costs nothing a warning does not.
    for (const entry of this.entries()) {
      if (standing.has(warningKey(entry))) continue
      await this.#say(clearedLine(entry))
      this.journal('token_cleared', {
        holder: entry.holder, key: entry.key, repo: entry.repo, fault: entry.fault,
      })
    }

    for (const r of readings) {
      const entry = this.entryFor(warningKey(r))
      if (!shouldSay(entry, r)) continue
      const said = await this.#say(warningLine(r))
      this.journal('token_warned', { ...r, said })
    }
  }

  // Rule 4, without a second measurement: the bridge has just come up, and the
  // reduction already holds every reading this process took. Nothing is
  // re-probed, so a bridge that flaps costs GitHub nothing.
  async flush() {
    for (const entry of this.entries()) {
      if (entry.said) continue
      const said = await this.#say(warningLine(entry))
      if (said) this.journal('token_warned', { ...entry, said: true })
    }
  }

  start() {
    this.stop()
    this.timer = setInterval(() => { this.pass().catch(() => {}) }, this.intervalMs)
    this.timer.unref?.()
    return this.timer
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // The one place `said` is decided. A missing bridge and a failing send are
  // the same answer to the ladder: the operator did not read it.
  //
  // A landed line is NOT logged. The probe writes its own plain line for every
  // reading it takes, and this text carries Discord markup, so logging it would
  // put the same fact in the boot output twice and in two vocabularies.
  async #say(text) {
    try {
      const res = await this.announce(text)
      if (res === false) this.log('a credential warning could not be said — there is no bridge yet, so it stands until there is')
      return res !== false
    } catch (e) {
      this.log(`the credential warning did not reach Discord (${e.message}) — it stands until it does`)
      return false
    }
  }
}
