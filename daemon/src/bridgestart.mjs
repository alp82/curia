// The bridge's start, from the token on disk (#891, on the #876 card).
//
// The bridge used to read the token once, at boot. On a fresh installation
// the daemon boots before the operator has pasted a token, so the first
// connection of the Discord card verified over REST while no bridge ran, and
// the only way to get one was a restart of the service. The live rehearsal
// paid for that with an escalation nobody saw for an hour.
//
// This module owns the decision and the bridge. `ensure()` reads the token
// and the settings fresh, starts a bridge when there is a token, an allowed
// operator, and no bridge, and does nothing while one runs or starts. The
// daemon calls it at boot, when the card connects, and on every Discord
// read, so the bridge is running within seconds of the token landing and no
// caller has to know whether it already did. A start that fails retries on
// the boot's ladder (5 s, 10 s, ... 60 s), re-reading the token on every
// rung, so a replaced token is picked up and a removed one ends the ladder.
//
// `create(token, settings)` is the one seam: the daemon hands in the
// `DiscordBridge` constructor with its handlers, and a test hands in a fake.
// `onStarted(bridge)` is told once per successful start, `onFailed(error)`
// once per failed attempt.

export class BridgeStarter {
  constructor({
    token, settings, create, onStarted = () => {}, onFailed = () => {}, log = () => {},
    setTimer = setTimeout, delay = (attempt) => Math.min(60_000, 5_000 * attempt),
    tokenSentence = () => 'no DISCORD_BOT_TOKEN',
    gateSentence = () => 'DISCORD_ALLOWED_USERS is empty',
  }) {
    this.token = token
    this.settings = settings
    this.create = create
    this.onStarted = onStarted
    this.onFailed = onFailed
    this.log = log
    this.setTimer = setTimer
    this.delay = delay
    this.tokenSentence = tokenSentence
    this.gateSentence = gateSentence
    // The live bridge, or null. Set only after `start()` resolved.
    this.bridge = null
    // True from the first attempt until a start resolves or the ladder ends.
    this.launching = false
    this.attempt = null
    this.said = null
  }

  // What the Discord card says about the bridge: its health while it runs,
  // `starting` while a login is in flight, null when none exists.
  state() {
    if (this.bridge) return this.bridge.health?.state ?? 'up'
    return this.launching ? 'starting' : null
  }

  // The decision, synchronous; the start itself runs in the background.
  ensure() {
    if (this.bridge) return { started: false, reason: 'running' }
    if (this.launching) return { started: false, reason: 'starting' }
    const reason = this.#refusal()
    if (reason) return { started: false, reason }
    this.said = null
    this.#launch(1)
    return { started: true, reason: 'starting' }
  }

  // The wedge watchdog's move: throw the live bridge away and build a fresh
  // one, because a destroyed discord.js Client does not log back in.
  relaunch() {
    const dead = this.bridge
    this.bridge = null
    dead?.stop().catch(() => {})
    return this.ensure()
  }

  // The attempt in flight, for a caller that wants to answer after the
  // login settled one way or the other. Never rejects.
  settled() {
    return this.attempt ?? Promise.resolve()
  }

  // Why no bridge starts now, said once per reason, never with the token.
  #refusal() {
    const token = this.token()
    let reason = null
    let line = null
    if (!token) {
      reason = 'no-token'
      line = `${this.tokenSentence()} — running without the bridge (REST-only)`
    } else if (!(this.settings().allowed_users ?? []).length) {
      reason = 'no-operator'
      line = `${this.gateSentence()} — refusing to start the bridge without an auth gate`
    }
    if (reason && this.said !== reason) {
      this.said = reason
      this.log(line)
    }
    return reason
  }

  #launch(attempt) {
    this.launching = true
    this.attempt = (async () => {
      const token = this.token()
      const settings = token ? this.settings() : null
      if (!token || !(settings.allowed_users ?? []).length) {
        // The ladder ends: what it would retry with is gone.
        this.launching = false
        this.#refusal()
        return
      }
      const b = this.create(token, settings)
      try {
        await b.start()
      } catch (e) {
        const wait = this.delay(attempt)
        this.log(`bridge start attempt ${attempt} failed: ${e.message} — retrying in ${wait / 1000}s (escalations remain REST-answerable)`)
        b.stop().catch(() => {})
        this.onFailed(e)
        this.setTimer(() => this.#launch(attempt + 1), wait).unref?.()
        return
      }
      this.bridge = b
      this.launching = false
      this.onStarted(b)
    })().catch((e) => {
      this.launching = false
      this.log(`[bridge] the start did not settle: ${e.message}`)
    })
    return this.attempt
  }
}
