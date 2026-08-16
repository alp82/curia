// The credential watch (#380).
//
// The daemon has probed every watched repo's GitHub token since #155, and it
// learned two things per repo: whether the token reaches it, and how many days
// are left on the token. Both went to `log()`, at boot, where nobody reads
// them. A token that dies takes every agent's first `gh` call with it, so the
// one fact the operator must act on was the one written where they never look.
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
//   2. A STEP LADDER, NOT A REPEAT. The line is said once at each step the
//      reading crosses — 14 days, 7, 3, 1, and expired. The journal remembers
//      what was already said, so a deploy repeats nothing and a restart
//      inherits the ladder. Without this the warning would be re-said on every
//      boot, which is how a warning teaches its reader to skip it.
//
//   3. THE EXPIRY KEYS ON THE TOKEN, THE REACH KEYS ON THE REPO. One token
//      covers every repo of an owner, so an expiry warned per repo would say
//      one fact as many times as the watch list is long (ADR-0013). Reach is
//      the other way round: the same token reads one repo and fails another,
//      because the repository list lives on GitHub.
//
//   4. A LINE THAT DID NOT REACH DISCORD IS NOT SAID. The boot probe can run
//      before the bridge is up, and the bridge can be down for hours. So the
//      event carries `said`, and an unsaid reading is re-announced by the next
//      pass and by `flush()` at bridge start. The journal still holds it, so
//      the console shows it either way.
//
// What this does NOT survive is stated rather than hidden. The expiry half is a
// PAT-only fact and it dies holder by holder as #389, #390 and #392 cut over to
// the GitHub App (#338, ADR-0018): a minted installation token lives one hour
// and the daemon refreshes it, so its expiry is nothing an operator can act on
// and curia must never warn about one. No branch in the code says so, because
// after a cutover the probe finds no PAT to read. The REACH half survives for
// every holder and for the installation itself — a repo watched but left off
// the installation answers 404 exactly as a PAT missing it does.

import { tokenExpiryDays } from './github.mjs'

// The ladder. Descending, and 0 is the expired step rather than a day count.
// Kept as a list because the rule is "the tightest step the reading has
// crossed", and a list states that where four comparisons would hide it.
export const TOKEN_STEPS = [14, 7, 3, 1, 0]

// The widest step is also the threshold: a reading above it is healthy and
// says nothing. One name for one thing — the old `TOKEN_EXPIRY_WARN_DAYS` in
// index.mjs was this number.
export const TOKEN_EXPIRY_WARN_DAYS = TOKEN_STEPS[0]

// Six hours, so a one-day step gets four chances to be seen rather than one.
// One HTTP request per repo per holder, which is what makes this cheap enough
// to state as an interval instead of arming a timer per instant. Arming the
// next step instant was put up and turned down: it cannot see a token revoked
// by hand, and a revoked token is the failure that arrives with no warning at
// all.
export const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000

// The tightest step a day count has crossed, or null when the reading is
// healthy. `days` is already floored by `tokenExpiryDays`, and a token with no
// expiry at all reads null there and never reaches this.
export function expiryStep(days) {
  if (days === null || days === undefined) return null
  // The steps descend, so the last one the reading is still inside is the
  // tightest one it has crossed.
  let crossed = null
  for (const step of TOKEN_STEPS) {
    if (days > step) break
    crossed = step
  }
  return crossed
}

// Rule 3. The expiry is a property of the TOKEN and the reach is a property of
// the pair, so they cannot share a key.
export function warningKey({ fault, holder, key, repo }) {
  return fault === 'expiring' ? `${holder}:${key}` : `${holder}:${key}:${repo}`
}

// Rule 2 and rule 4, in one predicate. `entry` is the last `token_warned` this
// key has, out of the reduction, or null.
export function shouldSay(entry, reading) {
  if (!entry) return true
  if (!entry.said) return true // rule 4: it was measured, not said
  if (entry.fault !== reading.fault) return true
  if (reading.fault === 'expiring') return reading.step < entry.step
  return entry.message !== reading.message
}

// One probe answer becomes one reading, or null when the credential is well.
// The caller hands over what `probeRepoToken` returned plus who holds it.
//
// `unmeasured` is the third answer and it is not a fault: GitHub being slow or
// down says nothing about the token. It reads as null here, so nothing is said
// — and `keysOf` below is what stops it being read as good news either.
export function readingOf({ holder, key, repo, where, refusal, ok, unmeasured, message, expiresAt }) {
  if (unmeasured) return null
  if (!ok) {
    return { fault: 'unreachable', holder, key, repo, where, refusal, message: message ?? 'HTTP error' }
  }
  const days = tokenExpiryDays(expiresAt)
  const step = expiryStep(days)
  if (step === null) return null
  return { fault: 'expiring', holder, key, repo, where, refusal, days, expires_at: expiresAt ?? null, step }
}

// Rule 3 again, at the point it bites: the probe answers once per repo, and a
// token that covers four repos would otherwise carry four identical expiry
// readings into the pass. The FIRST one per token wins, because they are the
// same measurement of the same token.
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

// Both keys one probe answer could ever hold, whatever it measured. A pass
// clears a standing warning by NOT re-measuring it, so an answer that measured
// nothing must still protect its own keys — otherwise one slow GitHub call
// posts a ✅ for a token that is still dying.
export function keysOf({ holder, key, repo }) {
  return [`${holder}:${key}`, `${holder}:${key}:${repo}`]
}

// An instant a phone can read, as a DATE rather than a clock time: an expiry is
// days away, so `discordTime`'s time-of-day form would state the least useful
// half of it. `:R` beside it answers the question the operator actually has.
export function expiryInstant(raw) {
  const t = Date.parse(String(raw ?? '').replace(' UTC', 'Z').replace(' ', 'T'))
  if (Number.isNaN(t)) return null
  const s = Math.floor(t / 1000)
  return `<t:${s}:D> (<t:${s}:R>)`
}

// ---- the lines --------------------------------------------------------------
//
// CuriaBot's own voice: these state mechanics, which is the half ADR-0013 gives
// the bot. Every one of them names the act that ends it, because a warning the
// reader cannot act on is a log line with an emoji on it.

export function warningLine(r) {
  if (r.fault === 'unreachable') {
    return `${'⚠️'} \`${r.key}\` cannot reach ${r.repo} (${r.message}). ${r.refusal}. The repository list lives on GitHub, so add ${r.repo} to the token there, or mint a new one into \`${r.where}\`.`
  }
  const when = expiryInstant(r.expires_at)
  const head = r.days <= 0
    ? `\`${r.key}\` has EXPIRED${when ? `, on ${when}` : ''}.`
    : `\`${r.key}\` expires in ${r.days} day${r.days === 1 ? '' : 's'}${when ? `, on ${when}` : ''}.`
  return `${'⚠️'} ${head} ${r.refusal}. Mint a new token and put it in \`${r.where}\`.`
}

export function clearedLine(entry) {
  if (entry.fault === 'unreachable') return `${'✅'} \`${entry.key}\` reaches ${entry.repo} again.`
  return `${'✅'} \`${entry.key}\` is renewed. It is more than ${TOKEN_EXPIRY_WARN_DAYS} days from expiry.`
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
  // network failure is a fact about the network rather than about the token,
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

    // The clear comes FIRST, so an operator who minted a token overnight reads
    // the ✅ above whatever else this pass says. It is journalled whether or not
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
