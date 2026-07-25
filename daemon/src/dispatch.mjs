// Dispatcher (#33 step 8): frontier → claim → worktree → tmux worker →
// lifecycle close, plus reconcile and the optional auto-dispatch loop.
//
// State posture (#9): the workers map is a disposable in-memory cache; GitHub
// claims + `tmux ls` + the journal are the three real sources, re-derived by
// reconcile(). Nothing authoritative lives here.
//
// Ordering invariant (intent priority 4): claim → prepare → spawn, and any
// prepare/spawn failure unclaims — never claim what cannot be spawned.
//
// Every external effect (gh, tmux, git, the attach surface) is reached through
// `this.deps`, which defaults to the real modules and can be overridden per
// instance. That seam is what makes start/onWorkerDone/reconcile unit-testable
// against fixtures instead of a live box.

import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleepFor } from 'node:timers/promises'
import {
  viewerLogin, repoMaps, mapFrontier, flatFrontier, fetchIssue, claim, unclaim,
  selectLane, frontierForRepo, commentIssue, closeIssue, setIssueBody, issueComments,
  parentNumberOf, hasLabel, findPullRequest, createPullRequest,
} from './github.mjs'
import { resolveModel, candidates, buildSpawnCmd, parseUsageLimit, Cooling } from './routing.mjs'
import { hasSession, listSessions, newSession, capturePane, killSession } from './tmux.mjs'
import {
  ensureBaseClone, createWorktree, removeWorktree, removeConfigDir, removeCredentials,
  seedConfigDir, writeHarness, writePrompt, basePathFor, worktreePathFor, cfgDirFor,
  branchFor, defaultBranchOf, commitsOnBranch, pushBranch, hasUnpushedWork,
} from './workspace.mjs'
import { resolveAndLand, summariseOutcome, nonCleanComment } from './resolve.mjs'
import { ensureTtyd, assertServe, serveOff } from './attach.mjs'

const READY_MARKER = /⏵⏵|bypass permissions/
const SESSION_RE = /^curia-(\d+)$/

// gh failure classification, shared by #resolveRepo and reconcile's getIssue:
// only an HTTP 404 is POSITIVE evidence the issue does not exist in a repo.
// Any other failure (rate limit, 5xx, network) is indeterminate and must
// never narrow a candidate set — with two watched repos both carrying #n, a
// transient failure on one would otherwise shrink the set to 1, skip the
// ambiguity refusal, and dispatch a bypassPermissions worker against the
// WRONG repo's issue with no human in the loop.
const ISSUE_ABSENT_RE = /HTTP 404|Not Found/i

// unref'd so a pending poll never holds the process open
const sleep = (ms) => sleepFor(ms, undefined, { ref: false })

const DEFAULT_DEPS = {
  viewerLogin, repoMaps, mapFrontier, flatFrontier, fetchIssue, claim, unclaim,
  hasSession, listSessions, newSession, capturePane, killSession,
  ensureBaseClone, createWorktree, removeWorktree, removeConfigDir, removeCredentials,
  seedConfigDir, writeHarness, writePrompt,
  ensureTtyd, assertServe, serveOff,
  // resolve + land (#41)
  commentIssue, closeIssue, setIssueBody, issueComments, findPullRequest, createPullRequest,
  defaultBranchOf, commitsOnBranch, pushBranch, hasUnpushedWork,
}

// How many trailing pane lines the usage-limit classifier is allowed to see.
const PANE_TAIL_LINES = 20

// The phrase parseUsageLimit keys on. Used here to detect the one input that
// can forge it.
const LIMIT_PHRASE = /usage limit reached/i

// The pane is UNTRUSTED TEXT. The backend template passes the ticket body as
// argv, so Claude Code renders attacker-controlled issue text into the very
// transcript this module scrapes — a ticket whose body contains
// "…usage limit reached" would otherwise kill a healthy session and cool the
// model for an hour.
//
// Two independent narrowings, because neither is sufficient alone:
//   1. classify only the pane TAIL — the model's most recent output and the
//      composer box, rather than the rendered user message above them. This
//      fails for a body short enough to still sit inside the tail.
//   2. refuse the signal outright when the ticket text ITSELF carries the
//      phrase (see promptCarriesLimitText). That is exact: the false positive
//      exists only when the prompt can forge it, and the safe failure
//      direction is to fall through to the ready-timeout path, which surfaces
//      to a human, rather than to kill a healthy worker.
export function paneTail(pane, lines = PANE_TAIL_LINES) {
  const rows = String(pane ?? '').split('\n')
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop()
  return rows.slice(-lines).join('\n')
}

export function textCarriesLimitPhrase(...parts) {
  return LIMIT_PHRASE.test(parts.filter(Boolean).join('\n'))
}

export class Dispatcher {
  // notify(ticket, msg) and confirm(ticket, prompt) → Promise<boolean> are
  // injected by index.mjs (bridge-guarded notify; approve-reject escalation
  // confirm with first-valid-confirm-wins + bounded TTL).
  constructor({ config, routing, store, notify, confirm, cancelEscalation, log = console.log, cooling, dataDir, daemonPort, previews, deps }) {
    this.config = config
    this.routing = routing
    this.store = store
    this.notify = notify
    this.confirm = confirm
    // index.mjs injects gate.cancel so voiding a confirm SETTLES it: the
    // pending resolver (if the confirm was opened after listen, mid-boot-
    // reconcile) is released and the Discord buttons get marked — a bare
    // store.cancel would leave the resolver hanging in `pending` forever.
    this.cancelEscalation = cancelEscalation ?? ((id, opts) => this.store.cancel(id, opts))
    this.log = log
    this.cooling = cooling ?? new Cooling()
    this.dataDir = dataDir
    this.daemonPort = daemonPort
    // Preview registry (#40) — optional so tests and any preview-less
    // deployment construct a Dispatcher unchanged. Every call site guards.
    this.previews = previews ?? null
    this.deps = { ...DEFAULT_DEPS, ...deps }
    this.root = config.dispatch.workspace_root
    this.workers = new Map() // session -> worker record (disposable cache)
    this.inFlight = new Set() // admission guard: sessions mid-start, pre-spawn
    this.mapLocks = new Map() // "repo#map" -> tail of that map's write chain (#41)
    this.exhaustionNotified = false
    this.autoTimer = null
    this.wakeTimer = null
  }

  // ---- frontier --------------------------------------------------------------

  // Shallow per-repo frontier (numbers/titles/labels); gh errors are surfaced
  // per repo, never thrown across the whole read.
  async frontier(repoFilter) {
    const out = []
    for (const entry of this.config.watch) {
      if (repoFilter && entry.repo !== repoFilter) continue
      try {
        out.push(await this.#repoFrontier(entry))
      } catch (e) {
        out.push({ repo: entry.repo, error: e.message })
      }
    }
    return out
  }

  async #repoFrontier(entry) {
    const mode = entry.mode ?? 'auto'
    const maps = mode === 'ready-for-agent' ? [] : await this.deps.repoMaps(entry.repo)
    const { lane, maps: activeMaps } = selectLane(maps, mode)
    const mapItems = {}
    let flatItems = []
    if (lane === 'map') {
      for (const m of activeMaps) mapItems[m] = await this.deps.mapFrontier(entry.repo, m)
    } else if (lane === 'flat') {
      flatItems = await this.deps.flatFrontier(entry.repo)
    }
    const numbers = frontierForRepo({ mode, maps, mapItems, flatItems })
    const index = new Map()
    for (const item of [...Object.values(mapItems).flat(), ...flatItems]) index.set(item.number, item)
    return {
      repo: entry.repo,
      lane,
      numbers,
      items: numbers.map((n) => {
        const i = index.get(n)
        return { number: n, title: i?.title ?? '', labels: (i?.labels ?? []).map((l) => l.name) }
      }),
    }
  }

  // ---- start -----------------------------------------------------------------

  async start(ticketArg, { repo, model, backend, by } = {}) {
    const n = String(ticketArg)
    const session = `curia-${n}`
    // Admission guard: synchronous check + insert BEFORE the first await, so a
    // second /start, POST /command, or auto-poll tick interleaving during the
    // gh round-trips is refused as "already starting".
    if (this.inFlight.has(session)) return `⏳ \`${session}\` is already starting`
    if (this.workers.has(session)) {
      // already-live anomaly, TRACKED case: plan step 8 / decision #18 name
      // "already live" as an anomaly where confirming IS the override — the
      // same offer the untracked-tmux case gets below, not a flat refusal.
      const w = this.workers.get(session)
      this.#confirmContinuation(
        n,
        `\`${session}\` is already running (${w.repo ?? '?'}#${w.ticket ?? n}, state **${w.state ?? '?'}**). Approve to tear it down and re-dispatch #${n}?`,
        async () => {
          this.workers.delete(session)
          await this.deps.killSession(session).catch(() => {})
          const resolved = await this.#resolveRepo(n, repo ?? w.repo)
          if (resolved.error) return resolved.error
          return this.#dispatch(resolved.repo, n, resolved.issue, { model, backend, by })
        },
        { replacing: true },
      )
      return `▶️ \`${session}\` is already running — confirm the re-dispatch in thread ticket-${n}, or \`/attach ${n}\` / \`/cancel ${n}\``
    }
    this.inFlight.add(session)
    try {
      if (await this.deps.hasSession(session)) {
        // already-live anomaly, UNTRACKED case: same override shape
        this.#confirmContinuation(n, `tmux session \`${session}\` is already live but untracked. Approve to tear it down and re-dispatch #${n}?`, async () => {
          await this.deps.killSession(session).catch(() => {})
          const resolved = await this.#resolveRepo(n, repo)
          if (resolved.error) return resolved.error
          return this.#dispatch(resolved.repo, n, resolved.issue, { model, backend, by })
        })
        return `⚠️ \`${session}\` is already live — confirm the respawn in thread ticket-${n}`
      }

      const resolved = await this.#resolveRepo(n, repo)
      if (resolved.error) return resolved.error
      const { repo: theRepo, issue } = resolved

      if (issue.state !== 'open') return `⛔ ${theRepo}#${n} is ${issue.state} — nothing to dispatch`
      const anomalies = []
      const assignees = (issue.assignees ?? []).map((a) => a.login)
      if (assignees.length) anomalies.push(`already assigned to ${assignees.join(', ')}`)
      const blockedBy = issue.issue_dependencies_summary?.blocked_by ?? 0
      if (blockedBy > 0) anomalies.push(`blocked by ${blockedBy} open issue(s)`)
      if (anomalies.length) {
        this.#confirmContinuation(n, `${theRepo}#${n} is ${anomalies.join(' and ')}. Approve to dispatch anyway?`, async () =>
          this.#dispatch(theRepo, n, issue, { model, backend, by }))
        return `⚠️ ${theRepo}#${n} is ${anomalies.join(' and ')} — confirm in thread ticket-${n}`
      }

      // #dispatch returns null only on exhaustion whose latched notify just
      // fired; the slash caller still deserves a reply.
      return (await this.#dispatch(theRepo, n, issue, { model, backend, by })) ?? this.#exhaustedReply()
    } finally {
      this.inFlight.delete(session)
    }
  }

  // Long-running confirms continue in the ticket thread so the slash reply
  // stays fast. The continuation re-takes the admission guard itself.
  // `replacing` is the already-live override: the continuation's own first act
  // is to drop the tracked worker, so the workers-map half of the guard would
  // otherwise refuse the very path it was asked to approve.
  #confirmContinuation(ticket, prompt, fn, { replacing = false } = {}) {
    this.confirm(ticket, prompt).then(async (ok) => {
      if (!ok) {
        this.notify(ticket, `🚫 not confirmed — nothing dispatched for #${ticket}`)
        return
      }
      const session = `curia-${ticket}`
      if (this.inFlight.has(session) || (!replacing && this.workers.has(session))) {
        this.notify(ticket, `⏳ \`${session}\` is already in flight — confirm ignored`)
        return
      }
      this.inFlight.add(session)
      try {
        const msg = await fn()
        if (msg) this.notify(ticket, msg)
      } catch (e) {
        this.notify(ticket, `⚠️ dispatch of #${ticket} failed after confirm: ${e.message}`)
      } finally {
        this.inFlight.delete(session)
      }
    }).catch((e) => this.log(`confirm continuation for #${ticket} failed:`, e.message))
  }

  // Resolve which watched repo a bare ticket number belongs to. A number
  // takeable in two watched repos is refused with the qualified owner/repo#n
  // forms (parseCommand accepts that form back). Every read that fails for
  // any reason OTHER than a positive 404 makes the bare-number form REFUSE
  // (ISSUE_ABSENT_RE above): a failed read is indeterminate, and silently
  // dropping the failed repo from the candidate set is how a transient gh
  // error used to turn the ambiguity refusal into a confident wrong answer.
  async #resolveRepo(n, explicitRepo) {
    if (explicitRepo) {
      if (!this.config.watch.some((w) => w.repo === explicitRepo)) {
        return { error: `⛔ \`${explicitRepo}\` is not on the watch list` }
      }
      try {
        return { repo: explicitRepo, issue: await this.deps.fetchIssue(explicitRepo, n) }
      } catch (e) {
        // no narrowing risk here (the repo is explicit), but "not found" must
        // still only be said on positive absence
        if (ISSUE_ABSENT_RE.test(e.message)) return { error: `⛔ ${explicitRepo}#${n} not found` }
        return { error: `⛔ could not read ${explicitRepo}#${n} (${e.message}) — try again` }
      }
    }
    const frontier = await this.frontier()
    const hits = frontier.filter((r) => !r.error && r.numbers.includes(Number(n))).map((r) => r.repo)
    if (hits.length > 1) {
      return { error: `⛔ #${n} is takeable in more than one watched repo — use the qualified form: ${hits.map((r) => `\`start ${r}#${n}\``).join(' or ')}` }
    }
    // A failed per-repo frontier read means #n may be takeable THERE too —
    // the ambiguity guard above cannot be trusted, so refuse rather than
    // proceed on the repos that happened to answer.
    const failed = frontier.filter((r) => r.error).map((r) => r.repo)
    if (failed.length) {
      return { error: `⛔ could not determine which repo owns #${n} — the frontier read failed for ${failed.map((r) => `\`${r}\``).join(', ')}; use the qualified form \`start owner/repo#${n}\` or retry` }
    }
    if (hits.length === 1) {
      return { repo: hits[0], issue: await this.deps.fetchIssue(hits[0], n) }
    }
    // not on the frontier anywhere — probe watched repos so the anomaly paths
    // (assigned / blocked / closed) can name their reason
    const existing = []
    for (const w of this.config.watch) {
      let issue = null
      try {
        issue = await this.deps.fetchIssue(w.repo, n)
      } catch (e) {
        // same classification as reconcile's getIssue: 404 ⇒ positively
        // absent here, keep probing; anything else ⇒ refuse, never narrow
        if (!ISSUE_ABSENT_RE.test(e.message)) {
          return { error: `⛔ could not determine which repo owns #${n} — reading \`${w.repo}\` failed (${e.message}); use the qualified form \`start ${w.repo}#${n}\` or retry` }
        }
      }
      if (issue && !issue.pull_request) existing.push({ repo: w.repo, issue })
    }
    if (!existing.length) return { error: `⛔ #${n} not found in any watched repo` }
    if (existing.length > 1) {
      return { error: `⛔ #${n} exists in more than one watched repo — use the qualified form: ${existing.map((x) => `\`start ${x.repo}#${n}\``).join(' or ')}` }
    }
    return existing[0]
  }

  // claim → prepare → spawn, in that order; any prepare/spawn failure unclaims.
  async #dispatch(repo, n, issue, { model, backend, by }) {
    const session = `curia-${n}`
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    const modelName = resolveModel(this.routing, labels, model)
    if (!this.routing.models[modelName]) {
      return `⛔ unknown model \`${modelName}\` — configured models: ${Object.keys(this.routing.models).join(', ')}`
    }
    const backendName = backend ?? this.routing.models[modelName].backend
    if (!this.routing.backends[backendName]) {
      return `⛔ unknown backend \`${backendName}\` — configured backends: ${Object.keys(this.routing.backends).join(', ')}`
    }
    const cands = candidates(this.routing, modelName, this.cooling)
    if (!cands.length) {
      // exhaustion BEFORE the claim — never claim what cannot be spawned.
      // Returns null when #exhausted's latched notify fired (so a confirm
      // continuation cannot echo it) and the reply sentinel when the latch
      // suppressed it (so the continuation is never silent).
      return this.#exhausted(n, repo)
    }

    const login = await this.deps.viewerLogin()
    await this.deps.claim(repo, n, login)
    this.store.logEvent('dispatch_claimed', { repo, ticket: n, worker: session, by: by ?? 'unknown' })

    const cfgDir = cfgDirFor(this.root, session)
    try {
      // every caller resolves the issue through #resolveRepo → fetchIssue, so
      // the body is always present
      const full = issue
      const base = await this.deps.ensureBaseClone(this.root, repo)
      const wtPath = await this.deps.createWorktree(base, n)
      this.deps.seedConfigDir(cfgDir, wtPath)
      this.deps.writeHarness(wtPath, session, n, this.daemonPort)
      const promptFile = this.deps.writePrompt(cfgDir, full, { repo, wtPath, mapNumber: await this.#mapNumberFor(repo, full) })
      fs.rmSync(path.join(this.dataDir, 'results', `${session}.json`), { force: true })

      const useModel = cands[0]
      const cmd = buildSpawnCmd(this.routing, backendName, useModel, promptFile)
      await this.deps.newSession({ name: session, cwd: wtPath, env: { CLAUDE_CONFIG_DIR: cfgDir }, shellCmd: cmd })
      this.store.logEvent('worker_spawned', { repo, ticket: n, worker: session, model: useModel, backend: backendName })

      const worker = {
        repo, ticket: n, title: full.title, session, wtPath, cfgDir, promptFile,
        model: useModel, requestedModel: modelName, backend: backendName,
        provider: this.routing.models[useModel].provider,
        spawnedAt: Date.now(), state: 'spawning', resultReceived: false,
        // this ticket's own text can forge the usage-limit signal ⇒ the
        // watchdog must not act on it (see paneTail)
        promptCarriesLimitText: textCarriesLimitPhrase(full.title, full.body),
      }
      this.workers.set(session, worker)
      this.#watchdog(worker).catch((e) => this.log(`watchdog ${session} failed:`, e.message))
      return `🚀 dispatched ${repo}#${n} → \`${session}\` on **${useModel}** — watching for readiness`
    } catch (e) {
      this.workers.delete(session)
      // seedConfigDir may already have copied the host OAuth credentials, and
      // no tmux session ever existed here, so no sweep would ever collect the
      // dir — remove it whole (no worker ran; there is nothing to post-mortem)
      this.deps.removeConfigDir(cfgDir)
      // W1 class, in the journal: dispatch_unclaimed is written ONLY when the
      // unclaim actually returned. #reconcileDeadClaims reads any post-epoch
      // dispatch_unclaimed as "epoch closed" and skips the ticket — so
      // recording a FAILED unclaim as done would leave the issue assigned to
      // the bot (filterTakeable drops it from every frontier) while disarming
      // the very mechanism built to release it. unclaim_failed is NOT matched
      // by closedAfterEpoch, so the next reconcile retries the release.
      let released = false
      try {
        await this.deps.unclaim(repo, n, login)
        released = true
        this.store.logEvent('dispatch_unclaimed', { repo, ticket: n, worker: session, reason: e.message })
      } catch (unclaimErr) {
        this.store.logEvent('unclaim_failed', { repo, ticket: n, worker: session, reason: e.message, error: unclaimErr.message })
      }
      return `⚠️ dispatch of ${repo}#${n} failed before the worker could run: ${e.message} — ${released ? 'claim released' : 'claim release FAILED: the issue is still assigned to the bot; reconcile will retry'}`
    }
  }

  // Which wayfinder map, if any, owns this ticket — so the standing orders can
  // name the map the worker must append its Decisions-so-far line to (#41).
  // Derived from the issue's own `parent_issue_url`, never stored: the same
  // lookup runs again at resolve time. A parent that is not labelled
  // `wayfinder:map` (an ordinary nested sub-issue) yields null, and so does any
  // failed read — the flat shape of the protocol is the safe default, because
  // it asks the worker for one thing less rather than one thing wrong.
  async #mapNumberFor(repo, issue) {
    const parent = parentNumberOf(issue)
    if (!parent) return null
    try {
      const parentIssue = await this.deps.fetchIssue(repo, parent)
      return hasLabel(parentIssue, 'wayfinder:map') ? parent : null
    } catch (e) {
      this.log(`could not read parent #${parent} of ${repo}#${issue.number} (${e.message}) — prompting without a map`)
      return null
    }
  }

  // Exactly ONE message per exhaustion event, never zero (decision #13, plan
  // step 8): the latch AND the notify both live here. Returns null when the
  // latched notify fired — so a confirm continuation cannot echo a second
  // message on top of it — and the reply SENTINEL when the latch suppressed
  // it, so the continuation still says something. The always-null shape
  // over-corrected: an operator would approve a tear-down-and-re-dispatch, the
  // live worker died, exhaustion landed inside a latched window, and nothing
  // was ever said in the thread. The direct /start reply path builds its own
  // reply string (see #exhaustedReply); a reply is not a notify.
  #exhausted(ticket, repo) {
    const reset = this.cooling.earliestReset()
    const when = reset ? reset.toISOString() : 'unknown'
    this.store.logEvent('dispatch_exhausted', { repo, ticket, earliest_reset: when })
    if (this.exhaustionNotified) return this.#exhaustedReply()
    this.exhaustionNotified = true
    this.notify(ticket, `🥶 every routing lane is cooling — no claim made. Earliest reset: ${when}`)
    const ms = Math.max(5_000, (reset?.getTime() ?? Date.now() + 3600_000) - Date.now())
    clearTimeout(this.wakeTimer)
    this.wakeTimer = setTimeout(() => {
      this.exhaustionNotified = false
      this.#autoTick().catch((e) => this.log('post-cooldown auto tick failed:', e.message))
    }, ms)
    this.wakeTimer.unref()
    return null
  }

  #exhaustedReply() {
    const reset = this.cooling.earliestReset()
    return `🥶 all routing lanes are cooling (earliest reset ${reset ? reset.toISOString() : 'unknown'}) — nothing claimed`
  }

  // ---- readiness watchdog ------------------------------------------------------

  // Poll the pane every 2 s up to ready_timeout_s. Composer marker ⇒ ready;
  // usage-limit reached text ⇒ cool + next candidate; timeout ⇒ record and
  // surface, keep claim + session for inspection (never guess keystrokes).
  async #watchdog(worker) {
    const deadline = Date.now() + this.config.dispatch.ready_timeout_s * 1000
    while (Date.now() < deadline) {
      await sleep(2000)
      if (this.workers.get(worker.session) !== worker) return // cancelled/replaced
      let pane = ''
      try {
        pane = await this.deps.capturePane(worker.session)
      } catch {
        // session died before readiness — leave it to worker_done/reconcile
      }
      // tail only — for BOTH classifiers: the pane carries untrusted ticket
      // text (see paneTail), and a rendered body spelling "bypass permissions"
      // must no more forge readiness than "usage limit reached" may forge a
      // cap hit. The composer marker is a bottom-of-pane signal anyway.
      const tail = paneTail(pane)
      const limit = parseUsageLimit(tail)
      if (limit && worker.promptCarriesLimitText) {
        // the ticket's own text can produce this match — refuse to cool a model
        // or kill a session on it; the ready-timeout path surfaces a genuine
        // hit to a human instead
        if (!worker.limitAmbiguityLogged) {
          worker.limitAmbiguityLogged = true
          this.store.logEvent('usage_limit_ignored_ambiguous', {
            repo: worker.repo, ticket: worker.ticket, worker: worker.session, scope: limit.scope,
          })
          this.log(`watchdog ${worker.session}: usage-limit text ignored — the ticket body carries the same phrase`)
        }
      } else if (limit) {
        await this.#handleLimit(worker, limit)
        return
      }
      if (READY_MARKER.test(tail)) {
        worker.state = 'ready'
        this.store.logEvent('worker_ready', { repo: worker.repo, ticket: worker.ticket, worker: worker.session, model: worker.model })
        this.notify(worker.ticket, `✅ \`${worker.session}\` is at the composer on **${worker.model}** — \`/attach ${worker.ticket}\` to watch`)
        return
      }
    }
    worker.state = 'failed'
    this.store.logEvent('worker_ready_timeout', { repo: worker.repo, ticket: worker.ticket, worker: worker.session, timeout_s: this.config.dispatch.ready_timeout_s })
    // If an ambiguous usage-limit signal was refused above, the operator must
    // hear about it HERE — this notify is the human surface the refusal leans
    // on, and "did not reach a composer" alone gives no reason to suspect a
    // cap hit.
    const ignored = worker.limitAmbiguityLogged
      ? ' (a usage-limit signal was seen but IGNORED because the ticket text itself carries the phrase — check the pane for a real cap hit)'
      : ''
    this.notify(worker.ticket, `⚠️ \`${worker.session}\` did not reach a composer within ${this.config.dispatch.ready_timeout_s}s${ignored} — session and claim kept for inspection (\`/attach ${worker.ticket}\`)`)
  }

  async #handleLimit(worker, limit) {
    // Unparseable reset ⇒ journalled conservative 1 h cooldown (stated deviation 2).
    const resetAt = limit.resetAt ?? new Date(Date.now() + 3600_000)
    if (!limit.resetAt) {
      this.store.logEvent('reset_unparseable', { worker: worker.session, scope: limit.scope, applied_cooldown_h: 1 })
    }
    if (limit.scope === 'model') {
      // Fable's own weekly sub-cap: cool only the model, provider stays warm.
      this.cooling.coolModel(worker.model, resetAt)
      this.store.logEvent('model_cooling', { model: worker.model, reset_at: resetAt.toISOString() })
    } else {
      this.cooling.coolProvider(worker.provider, resetAt)
      this.store.logEvent('provider_cooling', { provider: worker.provider, reset_at: resetAt.toISOString() })
    }
    await this.deps.killSession(worker.session).catch(() => {})

    const cands = candidates(this.routing, worker.requestedModel, this.cooling)
    if (cands.length) {
      const next = cands[0]
      try {
        const cmd = buildSpawnCmd(this.routing, worker.backend, next, worker.promptFile)
        await this.deps.newSession({ name: worker.session, cwd: worker.wtPath, env: { CLAUDE_CONFIG_DIR: worker.cfgDir }, shellCmd: cmd })
        worker.model = next
        worker.provider = this.routing.models[next].provider
        worker.spawnedAt = Date.now()
        worker.state = 'spawning'
        this.store.logEvent('worker_spawned', { repo: worker.repo, ticket: worker.ticket, worker: worker.session, model: next, retry_after_limit: true })
        this.notify(worker.ticket, `♻️ \`${worker.session}\` hit a ${limit.scope} usage limit — respawned on **${next}**`)
        this.#watchdog(worker).catch((e) => this.log(`watchdog ${worker.session} failed:`, e.message))
        return
      } catch (e) {
        // The old session is already dead. Letting this reject would strand the
        // GitHub claim in a worker record reconcile deliberately skips, making
        // it unrecoverable short of /cancel — so take the same
        // release path true exhaustion takes.
        this.log(`respawn of ${worker.session} on ${next} failed:`, e.message)
        const released = await this.#releaseClaim(worker, `respawn after ${limit.scope} usage limit failed: ${e.message}`)
        this.notify(worker.ticket, `⚠️ \`${worker.session}\` hit a ${limit.scope} usage limit and the respawn on **${next}** failed: ${e.message} — ${released ? 'claim released, ticket re-frontiered' : 'claim release FAILED: the issue is still assigned; reconcile will retry'}`)
        return
      }
    }
    // true exhaustion: release the claim, then exactly ONE message about the
    // exhaustion window — the latched notify, or the sentinel when the latch
    // already fired (this worker's session is already dead; silence here is
    // not acceptable). A FAILED release is a separate fact and gets its own
    // notify: both exhaustion messages say "no claim made"/"nothing claimed",
    // which is the opposite of the truth when the unclaim failed — the ticket
    // stays assigned, filterTakeable drops it from every frontier, and only
    // reconcile's unclaim_failed retry will recover it.
    const released = await this.#releaseClaim(worker, 'exhausted: all candidates cooling')
    const suppressed = this.#exhausted(worker.ticket, worker.repo)
    if (suppressed) this.notify(worker.ticket, suppressed)
    if (!released) this.notify(worker.ticket, `⚠️ \`${worker.session}\`: claim release FAILED: the issue is still assigned; reconcile will retry`)
  }

  // Drop the worker record and hand the ticket back to the frontier. Returns
  // whether the GitHub claim was actually released — dispatch_unclaimed is
  // journalled ONLY then (the W1-in-the-journal rule: a null login or a
  // failed `gh issue edit` leaves the issue assigned, and recording it as
  // unclaimed would make #reconcileDeadClaims treat the epoch as closed
  // forever). unclaim_failed is not matched by closedAfterEpoch, so the next
  // reconcile retries the release.
  // `keepCredentials` exists for exactly one caller: the non-clean report_result
  // path (#41), where the worker is STILL ALIVE — every other caller's session
  // is already dead. Deleting the per-worker credential copy under a live worker
  // kills its next model turn (#34's snapshot bound), and a `blocked` worker
  // still has a turn to end. The abandoned-credential sweep collects it once the
  // session is positively gone.
  async #releaseClaim(worker, reason, { keepCredentials = false } = {}) {
    this.workers.delete(worker.session)
    let released = false
    let failure = null
    const login = await this.deps.viewerLogin().catch((e) => { failure = e.message; return null })
    if (login) {
      try {
        await this.deps.unclaim(worker.repo, worker.ticket, login)
        released = true
      } catch (e) {
        failure = e.message
      }
    }
    // the session is dead and the record is being dropped, so nothing later
    // will collect the host OAuth credential copy — take it now; the rest of
    // the config dir (prompt.md) stays for post-mortem
    if (worker.cfgDir && !keepCredentials) this.deps.removeCredentials(worker.cfgDir)
    if (released) {
      this.store.logEvent('dispatch_unclaimed', { repo: worker.repo, ticket: worker.ticket, worker: worker.session, reason })
    } else {
      this.store.logEvent('unclaim_failed', { repo: worker.repo, ticket: worker.ticket, worker: worker.session, reason, error: failure ?? 'no viewer login' })
    }
    return released
  }

  // ---- lifecycle callbacks -----------------------------------------------------

  // report_result lands here. Marking the dispatch lifecycle is the old half;
  // the new half (#41) is the TICKET's own resolution — verified, repaired and
  // landed by resolve.mjs, or explicitly not-resolved on a non-clean status.
  // Returns the text the worker gets back as its tool result, so a failure the
  // daemon hit is visible to the one agent still able to react to it.
  async onResult(workerName, result = null) {
    const w = this.workers.get(workerName)
    if (w) w.resultReceived = true
    if (!result) return 'result recorded'

    // The ticket comes from the SPAWN BINDING (the worker record, else the
    // session name), never from `result.ticket` — that field is worker-supplied,
    // and this path closes issues and rewrites map bodies. A worker that names
    // someone else's ticket gets its own resolved and the disagreement
    // journalled.
    const m = workerName.match(SESSION_RE)
    const ticket = String(w?.ticket ?? (m ? m[1] : ''))
    if (!ticket) {
      this.store.logEvent('resolve_skipped', { worker: workerName, reason: 'no ticket is bound to this worker' })
      return 'result recorded — no curia ticket is bound to this worker, so nothing on the tracker was touched'
    }
    if (result.ticket != null && String(result.ticket) !== ticket) {
      this.store.logEvent('result_ticket_mismatch', { worker: workerName, bound: ticket, reported: String(result.ticket) })
      this.log(`WARNING: ${workerName} reported ticket ${result.ticket} but is bound to ${ticket} — acting on ${ticket}`)
    }
    const repo = w?.repo ?? this.#epochRepo(ticket)
    if (!repo) {
      this.store.logEvent('resolve_skipped', { worker: workerName, ticket, reason: 'no repo could be determined' })
      return `result recorded — curia could not tell which repo #${ticket} belongs to, so the ticket was left untouched`
    }

    try {
      return result.status === 'resolved'
        ? await this.#resolveTicket(workerName, repo, ticket, result, w)
        : await this.#noteNonClean(workerName, repo, ticket, result, w)
    } catch (e) {
      this.store.logEvent('resolve_failed', { repo, ticket, worker: workerName, status: result.status, error: e.message })
      this.notify(ticket, `⚠️ ${repo}#${ticket}: the result was recorded but curia's resolve step failed — ${e.message}`)
      return `result recorded — but curia's resolve step failed: ${e.message}`
    }
  }

  // The repo this ticket was last dispatched against, for a worker whose record
  // this process never held (reconcile-adopted, or a restart mid-flight).
  #epochRepo(ticket) {
    let repo = null
    for (const ev of this.#readJournal()) {
      if ((ev.type === 'dispatch_claimed' || ev.type === 'worker_spawned')
        && String(ev.ticket ?? '') === String(ticket) && ev.repo) repo = ev.repo
    }
    return repo
  }

  async #resolveTicket(workerName, repo, ticket, result, w) {
    const wtPath = w?.wtPath ?? worktreePathFor(this.root, repo, ticket)
    const login = await this.deps.viewerLogin().catch(() => null)
    const out = await resolveAndLand({
      repo, ticket, worker: workerName, result, login,
      wtPath: fs.existsSync(wtPath) ? wtPath : null,
      basePath: basePathFor(this.root, repo),
      branch: branchFor(ticket),
      // comments are judged against this dispatch, so a resolution comment left
      // by an EARLIER dispatch of the same ticket does not count as this one's
      epochTs: w?.spawnedAt ? new Date(w.spawnedAt).toISOString() : null,
      model: w?.model ?? null,
      deps: this.deps,
      journal: (type, data) => this.store.logEvent(type, data),
      withMapLock: (key, fn) => this.#withMapLock(key, fn),
      log: this.log,
    })
    this.store.logEvent('ticket_resolved', {
      repo, ticket, worker: workerName,
      comment: out.comment, close: out.close, map: out.map.state, land: out.land.state,
      pr: out.land.url ?? null, repaired: out.repaired,
    })
    const text = summariseOutcome(out)
    this.notify(ticket, `✅ ${repo}#${ticket} resolved — ${text}`)
    return text
  }

  // A non-clean result resolves NOTHING — and the ticket has to actually come
  // back. It did not before #41: report_result writes a `result` event, and
  // reconcile's closedAfterEpoch reads any post-epoch `result` as "this epoch is
  // closed", so the dead-claim pass skipped the ticket. It stayed assigned to
  // the bot, invisible to every frontier, until a human ran /cancel. So the
  // release happens here, explicitly, and the ticket says why it is back.
  //
  // Consequence worth naming: with auto_dispatch ON, a ticket that always ends
  // `blocked` now returns to the frontier every poll and collects one comment
  // per attempt. That loop already existed and burned quota silently; it is now
  // written on the ticket, which is the point.
  async #noteNonClean(workerName, repo, ticket, result, w) {
    const record = w ?? { repo, ticket, session: workerName }
    const released = await this.#releaseClaim(record, `worker reported ${result.status}`, { keepCredentials: true })
    let noted = false
    try {
      await this.deps.commentIssue(repo, ticket, nonCleanComment({ worker: workerName, result, released }))
      noted = true
    } catch (e) {
      this.log(`could not note the ${result.status} result on ${repo}#${ticket}: ${e.message}`)
    }
    this.store.logEvent('nonclean_noted', { repo, ticket, worker: workerName, status: result.status, released, noted })
    const tail = released
      ? 'claim released, ticket back on the frontier'
      : 'claim release FAILED — the ticket is still assigned; reconcile will retry'
    this.notify(ticket, `↩️ ${repo}#${ticket} NOT resolved (**${result.status}**) — ${tail}${noted ? ', reason noted on the ticket' : ', and the note could not be posted'}`)
    return `result recorded — nothing was resolved or pushed; ${tail}`
  }

  // Serialise this daemon's writes to one map body. GitHub has no conditional
  // issue update, so two workers appending Decisions-so-far lines concurrently
  // would read the same body and one line would vanish. This closes the
  // in-process race; the cross-process one (a human editing the same body) is
  // narrowed by reading inside the lock and verifying after, and survived by
  // journalling the line.
  #withMapLock(key, fn) {
    const prev = this.mapLocks.get(key) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    this.mapLocks.set(key, run.then(() => {}, () => {}))
    return run
  }

  // A preview outlives its worker unless someone withdraws it: `tailscale
  // serve --bg` config lives in tailscaled, not in this process. Every path
  // that ends a ticket goes through here.
  async #withdrawPreview(ticket, why) {
    if (!this.previews?.get(ticket)) return
    const r = await this.previews.withdraw(ticket).catch((e) => ({ ok: false, reason: e.message }))
    if (r.ok && r.withdrawn) this.log(`preview for ticket ${ticket} withdrawn (${why})`)
    else if (!r.ok) this.log(`WARNING: preview for ticket ${ticket} REMAINS PUBLISHED after ${why}: ${r.reason}`)
  }

  async onWorkerDone(workerName) {
    const w = this.workers.get(workerName)
    const m = workerName.match(SESSION_RE)
    const ticket = w?.ticket ?? (m ? m[1] : workerName)
    const resultsFile = path.join(this.dataDir, 'results', `${workerName}.json`)
    const hasResult = Boolean(w?.resultReceived) || fs.existsSync(resultsFile)
    // Both branches: a finished worker's dev server is dead either way, so the
    // rule would publish a dead port (or whatever binds it next) — the exact
    // thing publish() refuses to create in the first place.
    await this.#withdrawPreview(ticket, hasResult ? 'worker finished' : 'worker exited without a result')
    if (hasResult) {
      this.store.logEvent('lifecycle_closed', { worker: workerName, ticket, repo: w?.repo })
      await this.deps.killSession(workerName).catch(() => {})
      this.workers.delete(workerName)
      // worktree + branch + claim stay for review; the OAuth credential copy
      // does not
      this.deps.removeCredentials(w?.cfgDir ?? cfgDirFor(this.root, workerName))
      this.notify(ticket, `🏁 \`${workerName}\` finished with a recorded result — session closed; worktree, branch and claim kept for review`)
    } else {
      // result-less exit: the pane is the post-mortem evidence — keep it
      if (w) w.state = 'failed'
      this.store.logEvent('worker_abnormal_exit', { worker: workerName, ticket, repo: w?.repo })
      this.notify(ticket, `🚨 \`${workerName}\` stopped WITHOUT reporting a result — session kept for post-mortem (\`/attach ${ticket}\`)`)
    }
  }

  // ---- cancel --------------------------------------------------------------------

  cancel(n, { by } = {}) {
    const ticket = String(n)
    const session = `curia-${ticket}`
    // reads never confirm; destruction always does (reused escalation gate,
    // first-valid-confirm-wins)
    this.confirm(ticket, `Cancel \`${session}\`? This kills the session, removes the worktree and re-frontiers the ticket.`).then(async (ok) => {
      if (!ok) {
        this.notify(ticket, `🚫 cancel of \`${session}\` not confirmed — worker untouched`)
        return
      }
      const w = this.workers.get(session)
      await this.#withdrawPreview(ticket, 'ticket cancelled')
      await this.deps.killSession(session).catch(() => {})
      // The journal records what HAPPENED, not what was attempted (the W1
      // rule): dispatch_unclaimed only after the unclaim returned; a failed or
      // impossible unclaim journals unclaim_failed (which closedAfterEpoch
      // does not match, so reconcile retries the release); and the untracked
      // branch — whose own message says the GitHub claim was untouched —
      // writes no unclaim event at all.
      let released = false
      let failure = null
      if (w) {
        await this.deps.removeWorktree(basePathFor(this.root, w.repo), w.wtPath).catch((e) => this.log(`worktree removal for ${session} failed:`, e.message))
        const login = await this.deps.viewerLogin().catch((e) => { failure = e.message; return null })
        if (login) {
          try {
            await this.deps.unclaim(w.repo, ticket, login)
            released = true
          } catch (e) {
            failure = e.message
            this.log(`unclaim ${w.repo}#${ticket} failed:`, e.message)
          }
        }
      }
      this.deps.removeConfigDir(w?.cfgDir ?? cfgDirFor(this.root, session))
      this.workers.delete(session)
      if (w) {
        if (released) {
          this.store.logEvent('dispatch_unclaimed', { repo: w.repo, ticket, worker: session, reason: 'cancelled', by: by ?? 'unknown' })
        } else {
          this.store.logEvent('unclaim_failed', { repo: w.repo, ticket, worker: session, reason: 'cancelled', by: by ?? 'unknown', error: failure ?? 'no viewer login' })
        }
      }
      const tail = w
        ? (released ? ', worktree removed, ticket re-frontiered' : ', worktree removed — but the claim release FAILED: the issue is still assigned; reconcile will retry')
        : ' (was untracked; GitHub claim untouched)'
      this.notify(ticket, `🛑 \`${session}\` cancelled — session killed${tail}`)
    }).catch((e) => this.log(`cancel confirm for ${session} failed:`, e.message))
    return `🛑 confirm the cancellation of \`${session}\` in thread ticket-${ticket}`
  }

  // ---- status --------------------------------------------------------------------

  async status() {
    const live = (await this.deps.listSessions()).filter((s) => s.startsWith('curia-'))
    const workers = [...this.workers.values()].map((w) => ({
      session: w.session,
      repo: w.repo,
      ticket: w.ticket,
      title: w.title,
      model: w.model,
      state: w.state,
      uptime_s: w.spawnedAt ? Math.round((Date.now() - w.spawnedAt) / 1000) : null,
      result_received: w.resultReceived,
      tmux_live: live.includes(w.session),
    }))
    const untracked = live.filter((s) => !this.workers.has(s))
    return { workers, untracked }
  }

  // ---- reconcile -----------------------------------------------------------------

  // Three sources — GitHub, `tmux ls`, the journal — settled answer 7, with
  // every journal-as-current-state read EPOCH-SCOPED: judged only against
  // events after the ticket's latest dispatch_claimed/worker_spawned. Sweeps
  // and unclaims happen only on positive evidence from a successful gh call;
  // any gh failure skips that repo's reconciliation this pass.
  async reconcile({ boot = false } = {}) {
    this.store.logEvent('reconcile', { boot })
    const ctx = await this.#reconcileContext()

    if (ctx.login && ctx.sessions) {
      await this.#reconcileSessions(ctx)
      await this.#reconcileDeadClaims(ctx)
    } else if (!ctx.login) {
      // No confirmed viewer identity ⇒ NO positive evidence about who owns
      // what. Both passes below decide ownership by comparing assignees to
      // `login`; with a null login every live worker looks unowned and the
      // orphan sweep would kill its session AND `git worktree remove --force`
      // its uncommitted output — on nothing worse than a transient
      // `gh api user` failure. A failed identity read is a failed pass.
      this.store.logEvent('reconcile_identity_unknown', { boot })
      this.log('reconcile: no gh viewer identity this pass — skipping session adoption, orphan sweep and dead-claim release')
    } else {
      // Same rule for the tmux read: an indeterminate session list (wedged
      // server, foreign socket, tmux missing, the 5 s timeout) is NOT "no
      // sessions". Treating it as empty would make every open claim look dead
      // — unclaiming live workers and re-frontiering their tickets — and let
      // a re-dispatch force-remove a live worker's worktree. Skip both passes.
      this.store.logEvent('reconcile_sessions_indeterminate', { boot, error: ctx.sessionsError })
      this.log(`reconcile: tmux session list indeterminate this pass (${ctx.sessionsError}) — skipping session adoption, orphan sweep and dead-claim release`)
    }

    // The credential sweep needs only a DETERMINATE session list, not the
    // viewer identity: a cfg dir whose session is gone belongs to no live
    // worker whoever owns the ticket.
    if (ctx.sessions) this.#sweepAbandonedCredentials(ctx.sessions)

    // Preview sweep (#40) rides the same evidence rule: a determinate session
    // list is enough (a live session is a live ticket whoever owns it), and an
    // indeterminate one must NEVER reach the sweep — "no sessions" would read
    // as "no live tickets" and withdraw every preview currently being reviewed.
    // This is also the only pass that can see a rule left behind by a PREVIOUS
    // daemon process, since `tailscale serve --bg` config lives in tailscaled.
    if (ctx.sessions && this.previews) {
      const liveTickets = ctx.sessions.map((s) => s.match(SESSION_RE)?.[1]).filter(Boolean)
      await this.previews.sweep(liveTickets).catch((e) => this.log(`preview sweep failed: ${e.message}`))
    }

    if (boot) this.#voidBootConfirms()
    await this.#assertAttachSurface()
  }

  // Everything the passes share: the journal, the latest dispatch epoch per
  // ticket, the viewer identity, live curia sessions, and a per-pass issue
  // cache whose failures are remembered so one bad repo is skipped, not retried.
  async #reconcileContext() {
    const journal = this.#readJournal()

    // latest dispatch epoch per ticket (solo-PoC debt, acknowledged: keyed by
    // bare ticket number, so cross-repo number collisions share an epoch)
    const epochs = new Map() // ticket -> { idx, repo }
    journal.forEach((ev, idx) => {
      if ((ev.type === 'dispatch_claimed' || ev.type === 'worker_spawned') && ev.ticket != null) {
        epochs.set(String(ev.ticket), { idx, repo: ev.repo })
      }
    })

    const login = await this.deps.viewerLogin().catch(() => null)
    // sessions: array on positive evidence (a real listing, or a confirmed
    // "no server"); null when the read failed and the list is indeterminate
    let sessions = null
    let sessionsError = null
    try {
      sessions = (await this.deps.listSessions()).filter((s) => SESSION_RE.test(s))
    } catch (e) {
      sessionsError = e.message
    }
    const failedRepos = new Set()
    const issueCache = new Map()

    const ctx = { journal, epochs, login, sessions, sessionsError, failedRepos }
    ctx.getIssue = async (repo, n) => {
      const key = `${repo}#${n}`
      if (!issueCache.has(key)) {
        try {
          issueCache.set(key, await this.deps.fetchIssue(repo, n))
        } catch (e) {
          if (ISSUE_ABSENT_RE.test(e.message)) issueCache.set(key, null) // positively absent
          else throw e
        }
      }
      return issueCache.get(key)
    }
    ctx.skipRepo = (repo, e) => {
      if (!failedRepos.has(repo)) {
        failedRepos.add(repo)
        this.store.logEvent('reconcile_repo_skipped', { repo, error: e.message })
        this.log(`reconcile: skipping ${repo} this pass (${e.message})`)
      }
    }
    return ctx
  }

  // Live curia-<n> sessions: re-adopt the ones GitHub still says we own, sweep
  // the ones every candidate repo positively disowns.
  async #reconcileSessions({ journal, epochs, login, sessions, failedRepos, getIssue, skipRepo }) {
    for (const session of sessions) {
      if (this.workers.has(session) || this.inFlight.has(session)) continue
      const n = session.match(SESSION_RE)[1]
      const epoch = epochs.get(n)
      const reposToCheck = epoch?.repo ? [epoch.repo] : this.config.watch.map((w) => w.repo)
      let adopted = false
      let sawFailure = false
      const sweepRepo = epoch?.repo ?? null
      for (const repo of reposToCheck) {
        if (failedRepos.has(repo)) { sawFailure = true; continue }
        let issue
        try {
          issue = await getIssue(repo, n)
        } catch (e) {
          skipRepo(repo, e)
          sawFailure = true
          continue
        }
        if (issue && issue.state === 'open' && (issue.assignees ?? []).some((a) => a.login === login)) {
          const wtPath = worktreePathFor(this.root, repo, n)
          this.workers.set(session, {
            repo, ticket: n, title: issue.title, session,
            wtPath, cfgDir: cfgDirFor(this.root, session), promptFile: path.join(cfgDirFor(this.root, session), 'prompt.md'),
            model: null, requestedModel: null, backend: null, provider: null,
            spawnedAt: null, state: 'ready',
            resultReceived: fs.existsSync(path.join(this.dataDir, 'results', `${session}.json`)),
          })
          this.log(`reconcile: re-adopted live worker ${session} (${repo}#${n})`)
          adopted = true
          break
        }
      }
      if (adopted || sawFailure) continue

      // #41 guard, BEFORE the sweep: a live session that already reported a
      // result is a FINISHING worker, not an orphan. Its ticket is closed
      // (the worker resolved it) and its claim may already be released, so every
      // positive-evidence test above now reads "orphan" — on a session whose
      // worktree may still hold the only copy of the commits.
      const reported = journal.some((ev, i) => i > (epoch?.idx ?? -1)
        && (ev.type === 'result' || ev.type === 'ticket_resolved')
        && (ev.worker === session || String(ev.ticket ?? '') === n))
      if (reported) {
        this.store.logEvent('orphan_sweep_skipped', { worker: session, ticket: n, reason: 'reported a result after its dispatch' })
        this.log(`reconcile: not sweeping ${session} — it reported a result after its dispatch`)
        continue
      }

      // positive evidence from every candidate repo: closed / unassigned /
      // absent everywhere ⇒ orphan
      this.store.logEvent('orphan_swept', { worker: session, ticket: n })
      await this.deps.killSession(session).catch(() => {})
      if (sweepRepo) await this.#sweepWorktree(sweepRepo, n, session)
      this.deps.removeConfigDir(cfgDirFor(this.root, session))
      this.log(`reconcile: swept orphan ${session}`)
    }
  }

  // `git worktree remove --force` on an orphan used to be free: the worktree
  // held at most a local commit nothing depended on. Since #41 the daemon is
  // expected to push that branch and open a PR, so a sweep that fires before the
  // landing would destroy the only copy of real work. Unpushed ⇒ keep the
  // worktree (loudly); and "cannot tell" is not "nothing there" — an
  // indeterminate check keeps it too, the same evidence rule the rest of
  // reconcile runs on.
  async #sweepWorktree(repo, n, session) {
    const base = basePathFor(this.root, repo)
    const wt = worktreePathFor(this.root, repo, n)
    let unpushed = true
    let why = 'it holds commits that exist nowhere else'
    try {
      unpushed = await this.deps.hasUnpushedWork(wt, branchFor(n), await this.deps.defaultBranchOf(base))
    } catch (e) {
      why = `curia could not tell whether it holds unlanded commits (${e.message})`
    }
    if (unpushed) {
      this.store.logEvent('orphan_worktree_kept', { worker: session, ticket: n, repo, path: wt, reason: why })
      this.log(`reconcile: kept orphan worktree ${wt} — ${why}`)
      return
    }
    await this.deps.removeWorktree(base, wt).catch(() => {})
  }

  // Dead claims: journal-claimed (dispatch_claimed keeps manual claims safe),
  // still assigned, no live session, and no result/lifecycle_closed after the
  // latest epoch — stale results from earlier dispatches of the same ticket
  // never mask a dead claim.
  async #reconcileDeadClaims({ journal, epochs, login, sessions, failedRepos, getIssue, skipRepo }) {
    for (const [ticket, { idx, repo }] of epochs) {
      if (!repo || failedRepos.has(repo)) continue
      const session = `curia-${ticket}`
      if (sessions.includes(session) || this.workers.has(session) || this.inFlight.has(session)) continue
      const closedAfterEpoch = journal.some((ev, i) => i > idx
        && (ev.type === 'result' || ev.type === 'lifecycle_closed' || ev.type === 'dispatch_unclaimed')
        && (ev.worker === session || String(ev.ticket ?? '') === ticket))
      if (closedAfterEpoch) continue
      let issue
      try {
        issue = await getIssue(repo, ticket)
      } catch (e) {
        skipRepo(repo, e)
        continue
      }
      if (issue && issue.state === 'open' && (issue.assignees ?? []).some((a) => a.login === login)) {
        try {
          await this.deps.unclaim(repo, ticket, login)
          this.store.logEvent('dead_claim_released', { repo, ticket, worker: session })
          this.log(`reconcile: released dead claim ${repo}#${ticket}`)
        } catch (e) {
          skipRepo(repo, e)
        }
      }
    }
  }

  // Abandoned credential collection. Two terminal states deliberately keep the
  // whole workspace for post-mortem (onWorkerDone's abnormal-exit branch and
  // the watchdog's ready-timeout), so the per-worker copy of the host OAuth
  // refresh token used to persist until a human ran /cancel. Deleting eagerly
  // in those branches would break a session a human re-attaches and resumes —
  // so collect here instead, once the tmux session is positively gone:
  // credentials only, never the dir (prompt.md survives the post-mortem).
  // Runs only on a determinate session list (the W1/R1 rule: an indeterminate
  // read is a failed pass, not evidence of absence).
  #sweepAbandonedCredentials(sessions) {
    let dirs = []
    try {
      dirs = fs.readdirSync(path.join(this.root, 'cfg'))
    } catch {
      return // no cfg root yet — nothing was ever seeded
    }
    for (const dir of dirs) {
      if (!SESSION_RE.test(dir)) continue
      if (sessions.includes(dir) || this.workers.has(dir) || this.inFlight.has(dir)) continue
      const cfgDir = cfgDirFor(this.root, dir)
      if (!fs.existsSync(path.join(cfgDir, '.credentials.json'))) continue
      this.deps.removeCredentials(cfgDir)
      this.store.logEvent('credentials_swept', { worker: dir })
      this.log(`reconcile: swept the OAuth credential copy of dead ${dir} (workspace kept)`)
    }
  }

  // Boot only: void open overseer confirms — the resolver died with the old
  // process, so leaving them answerable-but-inert would be a lie. An on-demand
  // POST /reconcile must NOT void confirms whose resolver is live
  // (challenge.md correctness concern).
  #voidBootConfirms() {
    for (const r of this.store.openEscalations()) {
      if (r.worker !== 'overseer') continue
      this.cancelEscalation(r.id, { by: 'reconcile' })
      this.store.logEvent('confirm_voided', { id: r.id, ticket: r.ticket })
      this.notify(r.ticket, `♻️ confirm **${r.id}** was voided by a daemon restart — please re-issue the command`)
    }
  }

  // Asserted on every reconcile, never fatally — but the serve rule is only
  // asserted over a listener ensureTtyd VERIFIED as our hardened one. Every
  // loud-warning adopt branch returns verified:false; publishing that listener
  // would hand a writable no-origin-check terminal (or an operator's bare
  // shell on ttyd's default port) to every device on the tailnet. And because
  // `tailscale serve --bg` config persists in tailscaled across daemon
  // restarts, skipping assertServe alone does not withdraw a rule a previous
  // run asserted — so the unverified branch actively turns the rule off.
  async #assertAttachSurface() {
    const { serve_port: servePort, ttyd_port: ttydPort } = this.config.attach
    try {
      const { verified } = await this.deps.ensureTtyd({ ttydPort, log: this.log })
      if (!verified) {
        try {
          await this.deps.serveOff({ servePort, log: this.log })
          this.log(`reconcile: ttyd listener on port ${ttydPort} is UNVERIFIED — serve rule for :${servePort} withdrawn; /attach stays down until the listener is replaced (kill it and re-run reconcile)`)
        } catch (e) {
          this.log(`WARNING: ttyd listener on port ${ttydPort} is UNVERIFIED and withdrawing the serve rule failed (${e.message}) — if a rule for :${servePort} exists, the unverified listener REMAINS PUBLISHED tailnet-wide; run \`tailscale serve --https=${servePort} off\` by hand`)
        }
        return
      }
      await this.deps.assertServe({ servePort, ttydPort })
    } catch (e) {
      this.log(`reconcile: attach surface assertion failed (${e.message}) — /attach may be unavailable`)
    }
  }

  #readJournal() {
    const file = path.join(this.dataDir, 'events.jsonl')
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
      // Same classification rule as the tmux/gh reads: [] only on positive
      // absence (no journal was ever written — the normal first boot). Any
      // other failure is an INDETERMINATE journal, and the epoch map built
      // from it steers reconcile — so fail the pass, don't fabricate "no
      // events". (reconcile's caller already treats a throw as a failed pass.)
      if (e.code === 'ENOENT') return []
      throw new Error(`events journal is unreadable: ${e.message}`)
    }
    const events = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch { /* torn tail line — ignore */ }
    }
    return events
  }

  // ---- auto loop -----------------------------------------------------------------

  startAutoLoop() {
    if (!this.config.dispatch.auto_dispatch) return
    const ms = this.config.dispatch.poll_interval_s * 1000
    this.autoTimer = setInterval(() => {
      this.#autoTick().catch((e) => this.log('auto tick failed:', e.message))
    }, ms)
    this.autoTimer.unref()
    this.log(`auto-dispatch ON: polling every ${this.config.dispatch.poll_interval_s}s, max_concurrent=${this.config.dispatch.max_concurrent}`)
  }

  async #autoTick() {
    if (!this.config.dispatch.auto_dispatch) return
    const max = this.config.dispatch.max_concurrent
    const liveCount = () => this.workers.size + this.inFlight.size
    if (liveCount() >= max) return
    const frontier = await this.frontier()
    // map-lane candidates first, in watch order; flat lane after (unordered —
    // accepted consequence)
    const queue = []
    for (const lane of ['map', 'flat']) {
      for (const r of frontier) {
        if (r.error || r.lane !== lane) continue
        for (const num of r.numbers) queue.push({ repo: r.repo, num: String(num) })
      }
    }
    for (const { repo, num } of queue) {
      if (liveCount() >= max) break
      const session = `curia-${num}`
      if (this.workers.has(session) || this.inFlight.has(session)) continue
      if (await this.deps.hasSession(session)) continue // collision or leftover: skip, never churn
      const msg = await this.start(num, { repo, by: 'auto' })
      this.log(`[auto] ${msg}`)
    }
  }
}
