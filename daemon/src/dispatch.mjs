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
  viewerLogin, repoMaps, mapFrontier, flatFrontier, fetchIssue, claim, unclaim, blockedByOf,
  selectLane, frontierForRepo, agentOnlyChainCount, commentIssue, closeIssue, setIssueBody, issueComments,
  parentNumberOf, hasLabel, findPullRequest, createPullRequest, setPullRequestBody,
  deleteRemoteBranch,
} from './github.mjs'
import { resolveModel, candidates, buildSpawnCmd, parseUsageLimit, carriesLimitPhrase, Cooling } from './routing.mjs'
import { hasSession, listSessions, newSession, capturePane, killSession } from './tmux.mjs'
import {
  ensureBaseClone, createWorktree, removeWorktree, removeConfigDir, removeCredentials,
  seedConfigDir, writeHarness, writePrompt, basePathFor, worktreePathFor, cfgDirFor,
  branchFor, defaultBranchOf, commitsOnBranch, pushBranch, hasUnpushedWork, workerEnv,
  untrustedProjectConfig,
} from './workspace.mjs'
import { resolveAndLand, summariseOutcome, nonCleanComment, landBranch, prLinkComment } from './resolve.mjs'
import { outstanding, stopReason, reviewGateText, classifyReviewAnswer, REVIEW_KIND } from './lifecycle.mjs'
import { CONFIRM_KIND } from './store.mjs'
import { ensureTtyd, assertServe, serveOff } from './attach.mjs'

const SESSION_RE = /^curia-(\d+)$/

// The tracker doc every watched repo is meant to carry (#57 step 3). The
// wayfinder skill reads it to learn how this repo expresses maps and tickets;
// without it the skill follows its own instruction to fall back to the
// local-markdown tracker, and the worker writes .scratch/ files instead of
// resolving on GitHub.
const TRACKER_DOC = 'docs/agents/issue-tracker.md'

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
  viewerLogin, repoMaps, mapFrontier, flatFrontier, fetchIssue, claim, unclaim, blockedByOf,
  hasSession, listSessions, newSession, capturePane, killSession,
  ensureBaseClone, createWorktree, removeWorktree, removeConfigDir, removeCredentials,
  seedConfigDir, writeHarness, writePrompt,
  ensureTtyd, assertServe, serveOff,
  // resolve + land (#41), merge-gated (#54)
  commentIssue, closeIssue, setIssueBody, issueComments, findPullRequest, createPullRequest,
  setPullRequestBody, deleteRemoteBranch,
  defaultBranchOf, commitsOnBranch, pushBranch, hasUnpushedWork,
}

// How many trailing pane lines the two pane classifiers are allowed to see.
const PANE_TAIL_LINES = 20

// The pane is UNTRUSTED TEXT. The backend template passes the ticket body as
// argv, so the agent CLI renders attacker-controlled issue text into the very
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
  return carriesLimitPhrase(parts.filter(Boolean).join('\n'))
}

// Workers name their ticket in whatever shape the model prefers — `66`, `#66`,
// `owner/repo#66`, or the full issue URL (#103). Reduce a reported id to
// {repo, number} so a semantically equal id is not journalled as a mismatch.
// The spawn binding stays the only authority over which ticket is acted on.
export function parseTicketRef(raw) {
  const s = String(raw).trim()
  const m = s.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[#?].*)?$/)
    ?? s.match(/^([^\s#]+\/[^\s#]+)#(\d+)$/)
  if (m) return { repo: m[1], number: m[2] }
  const n = s.match(/^#?(\d+)$/)
  return { repo: null, number: n ? n[1] : null }
}

export class Dispatcher {
  // notify(ticket, msg) is injected by index.mjs (bridge-guarded). The button
  // confirm seams (#94) too: openConfirm opens + renders a `confirm`
  // escalation and returns its record; lapseEscalation closes one as lapsed
  // (journal + message edit); confirmNote posts a line next to a record's
  // buttons; overseerNote journals a synthetic line for a thread's session.
  constructor({ config, routing, store, notify, openConfirm, lapseEscalation, confirmNote, overseerNote, askReview, cancelEscalation, threads, log = console.log, cooling, dataDir, daemonPort, previews, deps }) {
    this.config = config
    this.routing = routing
    this.store = store
    this.notify = notify
    this.openConfirm = openConfirm ?? (() => null)
    this.lapseEscalation = lapseEscalation ?? ((id, reason) => this.store.lapse?.(id, reason))
    this.confirmNote = confirmNote ?? (() => {})
    this.overseerNote = overseerNote ?? (() => {})
    // askReview(worker, ticket, promptText) → { text, status } — the review gate
    // (#54 item 2), injected by index.mjs on the same escalation machinery every
    // ask_human uses, so first-valid-wins, the ~30-min re-nudge, the MCP
    // keepalive and restart survival all come free. Absent in tests that never
    // reach the gate.
    this.askReview = askReview ?? (async () => ({ text: 'reject', status: 'answered' }))
    // index.mjs injects gate.cancel so voiding a confirm SETTLES it: the
    // pending resolver (if the confirm was opened after listen, mid-boot-
    // reconcile) is released and the Discord buttons get marked — a bare
    // store.cancel would leave the resolver hanging in `pending` forever.
    this.cancelEscalation = cancelEscalation ?? ((id, opts) => this.store.cancel(id, opts))
    // Ticket-thread bindings (#93), injected by index.mjs over the bridge and
    // the journal. bind(ticket, {threadId, title}) puts the label on (an
    // explicit thread, or a fresh one); release(ticket, reason) takes it off —
    // called on every terminal state. Inert by default so tests and a
    // bridgeless daemon run unchanged.
    this.threads = threads ?? { bind: async () => ({ ok: true }), release: async () => {} }
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
      agentOnly: await this.#agentOnlyCount(entry.repo, lane, mapItems, numbers),
      items: numbers.map((n) => {
        const i = index.get(n)
        return { number: n, title: i?.title ?? '', labels: (i?.labels ?? []).map((l) => l.name) }
      }),
    }
  }

  // The HITL-free chain count for the tickets view (#81). Map lane: fetch the
  // dependency edges of every open blocked child, then run the pure closure.
  // Flat lane: every ready-for-agent ticket is by definition agent-ready, so
  // the count is the takeable count. Fails soft to null — the tickets view
  // must render even when an edge read does not.
  async #agentOnlyCount(repo, lane, mapItems, numbers) {
    if (lane === 'flat') return numbers.length
    if (lane !== 'map') return 0
    try {
      const items = Object.values(mapItems).flat()
      const edges = {}
      for (const i of items) {
        if (i.state !== 'open' || i.pull_request) continue
        if ((i.issue_dependencies_summary?.blocked_by ?? 0) === 0) continue
        edges[i.number] = (await this.deps.blockedByOf(repo, i.number))
          .map((b) => ({ number: b.number, state: b.state }))
      }
      return agentOnlyChainCount({ items, edges })
    } catch (e) {
      this.log(`agent-only count for ${repo} failed (${e.message}) — omitting it`)
      return null
    }
  }

  // ---- next ------------------------------------------------------------------

  // Dispatch the next takeable ticket (#81): first map-lane ticket in watch
  // order, flat lane after — the same ordering the auto loop walks. A repo
  // filter narrows to that repo's frontier.
  async next(repoFilter, { by, threadId } = {}) {
    const rows = await this.frontier(repoFilter)
    if (!rows.length) return `❌ no watched repo matches \`${repoFilter}\``
    for (const lane of ['map', 'flat']) {
      for (const r of rows) {
        if (r.error || r.lane !== lane) continue
        for (const num of r.numbers) {
          const session = `curia-${num}`
          if (this.workers.has(session) || this.inFlight.has(session)) continue
          if (await this.deps.hasSession(session)) continue
          return (await this.start(String(num), { repo: r.repo, by, threadId })) ?? this.#exhaustedReply()
        }
      }
    }
    const failed = rows.filter((r) => r.error).map((r) => r.repo)
    if (failed.length) {
      return `❌ nothing takeable, and the frontier read failed for ${failed.map((r) => `\`${r}\``).join(', ')} — there may be more there`
    }
    return 'nothing takeable right now'
  }

  // ---- start -----------------------------------------------------------------

  // `reuse` is the resume contract (#81): inherit the surviving worktree
  // instead of recreating it — see #dispatch.
  async start(ticketArg, { repo, model, backend, by, reuse = false, threadId = null } = {}) {
    const n = String(ticketArg)
    const session = `curia-${n}`
    // Admission guard: synchronous check + insert BEFORE the first await, so a
    // second /start, POST /command, or auto-poll tick interleaving during the
    // gh round-trips is refused as "already starting".
    if (this.inFlight.has(session)) return `⚙️ \`${session}\` is already starting`
    // `start` never confirms (#89): every anomaly below refuses with the way
    // out, instead of parking a destructive override behind a confirm. The
    // teardown path is `cancel` — which carries its own guard.
    if (this.workers.has(session)) {
      const w = this.workers.get(session)
      return `▶️ \`${session}\` is already running (${w.repo ?? '?'}#${w.ticket ?? n}, state **${w.state ?? '?'}**) — \`cancel ${n}\` first, or \`attach ${n}\``
    }
    this.inFlight.add(session)
    try {
      if (await this.deps.hasSession(session)) {
        return `⚠️ tmux session \`${session}\` is already live but untracked — \`cancel ${n}\` tears it down, then start again`
      }

      const resolved = await this.#resolveRepo(n, repo)
      if (resolved.error) return resolved.error
      const { repo: theRepo, issue } = resolved

      if (issue.state !== 'open') return `❌ ${theRepo}#${n} is ${issue.state} — nothing to dispatch`
      const anomalies = []
      const assignees = (issue.assignees ?? []).map((a) => a.login)
      if (assignees.length) anomalies.push(`already assigned to ${assignees.join(', ')}`)
      const blockedBy = issue.issue_dependencies_summary?.blocked_by ?? 0
      if (blockedBy > 0) anomalies.push(`blocked by ${blockedBy} open issue(s)`)
      if (anomalies.length) {
        return `❌ ${theRepo}#${n} is ${anomalies.join(' and ')} — start never dispatches over an anomaly; clear it on GitHub, then start again`
      }

      // #dispatch returns null only on exhaustion whose latched notify just
      // fired; the slash caller still deserves a reply.
      return (await this.#dispatch(theRepo, n, issue, { model, backend, by, reuse, threadId })) ?? this.#exhaustedReply()
    } finally {
      this.inFlight.delete(session)
    }
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
        return { error: `❌ \`${explicitRepo}\` is not on the watch list` }
      }
      try {
        return { repo: explicitRepo, issue: await this.deps.fetchIssue(explicitRepo, n) }
      } catch (e) {
        // no narrowing risk here (the repo is explicit), but "not found" must
        // still only be said on positive absence
        if (ISSUE_ABSENT_RE.test(e.message)) return { error: `❌ ${explicitRepo}#${n} not found` }
        return { error: `❌ could not read ${explicitRepo}#${n} (${e.message}) — try again` }
      }
    }
    const frontier = await this.frontier()
    const hits = frontier.filter((r) => !r.error && r.numbers.includes(Number(n))).map((r) => r.repo)
    if (hits.length > 1) {
      return { error: `❌ #${n} is takeable in more than one watched repo — use the qualified form: ${hits.map((r) => `\`start ${r}#${n}\``).join(' or ')}` }
    }
    // A failed per-repo frontier read means #n may be takeable THERE too —
    // the ambiguity guard above cannot be trusted, so refuse rather than
    // proceed on the repos that happened to answer.
    const failed = frontier.filter((r) => r.error).map((r) => r.repo)
    if (failed.length) {
      return { error: `❌ could not determine which repo owns #${n} — the frontier read failed for ${failed.map((r) => `\`${r}\``).join(', ')}; use the qualified form \`start owner/repo#${n}\` or retry` }
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
          return { error: `❌ could not determine which repo owns #${n} — reading \`${w.repo}\` failed (${e.message}); use the qualified form \`start ${w.repo}#${n}\` or retry` }
        }
      }
      if (issue && !issue.pull_request) existing.push({ repo: w.repo, issue })
    }
    if (!existing.length) return { error: `❌ #${n} not found in any watched repo` }
    if (existing.length > 1) {
      return { error: `❌ #${n} exists in more than one watched repo — use the qualified form: ${existing.map((x) => `\`start ${x.repo}#${n}\``).join(' or ')}` }
    }
    return existing[0]
  }

  // claim → prepare → spawn, in that order; any prepare/spawn failure unclaims.
  // `reuse` (the resume contract, #81): a surviving worktree is inherited as it
  // stands — uncommitted files and local commits included — instead of being
  // recreated from origin; absent one, resume degrades to an ordinary dispatch.
  async #dispatch(repo, n, issue, { model, backend, by, reuse = false, threadId = null }) {
    const session = `curia-${n}`
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    const modelName = resolveModel(this.routing, labels, model)
    if (!this.routing.models[modelName]) {
      return `❌ unknown model \`${modelName}\` — configured models: ${Object.keys(this.routing.models).join(', ')}`
    }
    const cands = candidates(this.routing, modelName, this.cooling)
    if (!cands.length) {
      // exhaustion BEFORE the claim — never claim what cannot be spawned.
      // Returns null when #exhausted's latched notify fired (so a confirm
      // continuation cannot echo it) and the reply sentinel when the latch
      // suppressed it (so the continuation is never silent).
      return this.#exhausted(n, repo)
    }

    // The backend belongs to the model actually being SPAWNED, not the one that
    // was asked for. Those differ whenever the requested model is cooling and
    // the chain fell through to the next candidate — which under #39 can cross
    // providers, and so can cross backends. Reading it off `modelName` was
    // invisible while every model was a claude one; with a codex lane it would
    // seed a claude config dir and then spawn codex into it.
    const useModel = cands[0]
    const backendName = backend ?? this.routing.models[useModel].backend
    if (!this.routing.backends[backendName]) {
      return `❌ unknown backend \`${backendName}\` — configured backends: ${Object.keys(this.routing.backends).join(', ')}`
    }

    const login = await this.deps.viewerLogin()
    await this.deps.claim(repo, n, login)
    this.store.logEvent('dispatch_claimed', { repo, ticket: n, worker: session, by: by ?? 'unknown' })

    // The ticket label goes on at the claim (#93): `start` binds the thread it
    // ran in, an autonomous dispatch opens and binds a fresh one — so every
    // notify from here on lands in the labeled thread. Never fatal: with the
    // bridge down the first notify binds lazily instead.
    try {
      await this.threads.bind(n, { threadId, title: issue.title })
    } catch (e) {
      this.log(`thread bind for ${repo}#${n} failed (${e.message}) — the first notify will bind lazily`)
    }

    const cfgDir = cfgDirFor(this.root, session)
    try {
      // every caller resolves the issue through #resolveRepo → fetchIssue, so
      // the body is always present
      const full = issue
      const base = await this.deps.ensureBaseClone(this.root, repo)
      const surviving = worktreePathFor(this.root, repo, n)
      const wtPath = reuse && fs.existsSync(surviving)
        ? surviving
        : await this.deps.createWorktree(base, n)
      const mapNumber = await this.#mapNumberFor(repo, full)
      this.#assertTracker(repo, n, session, wtPath, mapNumber)
      this.#assertNoPlantedConfig(wtPath, backendName)
      this.deps.seedConfigDir(cfgDir, wtPath, this.config.skills, backendName)
      this.deps.writeHarness({
        wtPath, cfgDir, worker: session, ticket: n, daemonPort: this.daemonPort,
        backend: backendName, reasoningEffort: this.routing.models[useModel].reasoning_effort ?? null,
      })
      // The type label reaches the prompt (#49 decision 2): it was already
      // parsed above for model routing and thrown away, and it is the only thing
      // that stops a dispatched `wayfinder:grilling` worker from standing in for
      // the human's side of its own ticket.
      const promptFile = this.deps.writePrompt(cfgDir, full, {
        repo, wtPath, mapNumber, type: labels.find((l) => l.startsWith('wayfinder:')) ?? null,
      })
      fs.rmSync(path.join(this.dataDir, 'results', `${session}.json`), { force: true })

      const cmd = buildSpawnCmd(this.routing, backendName, useModel, promptFile)
      await this.deps.newSession({ name: session, cwd: wtPath, env: workerEnv(cfgDir, backendName), shellCmd: cmd })
      // The instance id (#94): what a button confirm binds to. Unique per
      // DISPATCH, not per ticket, so a confirm can never outlive the worker
      // the operator read about and hit its successor.
      const instance = `${session}@${Date.now()}`
      this.store.logEvent('worker_spawned', { repo, ticket: n, worker: session, instance, model: useModel, backend: backendName })

      const worker = {
        repo, ticket: n, title: full.title, session, instance, wtPath, cfgDir, promptFile,
        model: useModel, requestedModel: modelName, backend: backendName,
        provider: this.routing.models[useModel].provider,
        spawnedAt: Date.now(), state: 'spawning', resultReceived: false,
        // this ticket's own text can forge the usage-limit signal ⇒ the
        // watchdog must not act on it (see paneTail)
        promptCarriesLimitText: textCarriesLimitPhrase(full.title, full.body),
      }
      this.workers.set(session, worker)
      this.#watchdog(worker).catch((e) => this.log(`watchdog ${session} failed:`, e.message))
      return `⚙️ dispatched ${repo}#${n} → \`${session}\` on **${useModel}** — watching for readiness`
    } catch (e) {
      this.workers.delete(session)
      // No tmux session ever existed here, so no sweep would ever collect the
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
      // no worker ever ran, so the dispatch that put the label on is over
      await this.threads.release(n, 'dispatch-failed').catch(() => {})
      return `⚠️ dispatch of ${repo}#${n} failed before the worker could run: ${e.message} — ${released ? 'claim released' : 'claim release FAILED: the issue is still assigned to the bot; reconcile will retry'}`
    }
  }

  // The belt behind the prompt naming the tracker (#57 step 3, #49 decision 2).
  // Throws before the config dir is seeded, so the ordinary prepare-failure
  // path unclaims and tells the operator why.
  //
  // Only a MAP CHILD is refused: that is the ticket whose worker invokes the
  // wayfinder skill, and the one whose resolution the fallback would silently
  // send to `.scratch/` instead of GitHub. A plain ready-for-agent ticket
  // invokes no such skill, and #10 watches ANY plain repo through the flat
  // lane — refusing those for a missing doc would take that lane away. It gets
  // a journal line instead, so the absence is on the record either way.
  #assertTracker(repo, n, session, wtPath, mapNumber) {
    if (fs.existsSync(path.join(wtPath, TRACKER_DOC))) return
    if (mapNumber) {
      throw new Error(`${repo} has no ${TRACKER_DOC}, so a worker on map child #${n} would fall back to the local-markdown tracker and write .scratch/ files instead of resolving on GitHub — run \`/setup-matt-pocock-skills\` in ${repo} first`)
    }
    this.store.logEvent('tracker_doc_missing', { repo, ticket: n, worker: session })
  }

  // Refuse before the config dir is seeded, so the ordinary prepare-failure path
  // unclaims and tells the operator why. See untrustedProjectConfig: each lane
  // loads one repo-carried config file without a prompt (codex under its
  // hook-trust bypass flag, claude by merging settings.local.json over the
  // settings curia writes), and hooks in it would run with no model in the loop.
  #assertNoPlantedConfig(wtPath, backendName) {
    const planted = untrustedProjectConfig(wtPath, backendName)
    if (planted) {
      throw new Error(`${planted} is a config file curia did not write, and the ${backendName} lane loads it with no prompt — hooks in it would run unreviewed, with no model in the loop. Remove the file from the repo, or dispatch on another backend if only one lane loads it (\`/start <ticket> <model>\`)`)
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
    this.notify(ticket, `⚠️ every routing lane is cooling — no claim made. Earliest reset: ${when}`)
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
    return `⚠️ all routing lanes are cooling (earliest reset ${reset ? reset.toISOString() : 'unknown'}) — nothing claimed`
  }

  // ---- readiness watchdog ------------------------------------------------------

  // Poll the pane every 2 s up to ready_timeout_s. Composer marker ⇒ ready;
  // usage-limit reached text ⇒ cool + next candidate; timeout ⇒ record and
  // surface, keep claim + session for inspection (never guess keystrokes).
  async #watchdog(worker) {
    // Resolved once, and loudly: readiness that silently never matches is #33's
    // live-only defect, and its whole symptom was silence.
    const readyRe = this.routing.backends[worker.backend]?.readyRe
    if (!readyRe) {
      throw new Error(`no readiness marker for backend "${worker.backend}" on ${worker.session} — refusing to watch a pane against nothing`)
    }
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
      const limit = parseUsageLimit(tail, worker.provider)
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
      // Per backend (#39): the claude composer's `⏵⏵` marker never appears in a
      // codex pane, whose composer says `<model> <effort> · <cwd>`.
      if (readyRe.test(tail)) {
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
      // The whole point of a second provider (#13) is that a cap hit falls
      // ACROSS it, and a cross-provider fallback is also a cross-backend one:
      // the next model wants a different config dir, a different credential
      // arrangement and a different side-channel layout. Re-seed before
      // respawning rather than handing the new CLI the old lane's harness.
      // Same-backend fallbacks re-seed too — it is idempotent, and one path is
      // easier to trust than a branch that has to be right about when it matters.
      const nextBackend = this.routing.models[next].backend
      try {
        this.deps.seedConfigDir(worker.cfgDir, worker.wtPath, this.config.skills, nextBackend)
        this.deps.writeHarness({
          wtPath: worker.wtPath, cfgDir: worker.cfgDir, worker: worker.session,
          ticket: worker.ticket, daemonPort: this.daemonPort, backend: nextBackend,
          reasoningEffort: this.routing.models[next].reasoning_effort ?? null,
        })
        const cmd = buildSpawnCmd(this.routing, nextBackend, next, worker.promptFile)
        await this.deps.newSession({ name: worker.session, cwd: worker.wtPath, env: workerEnv(worker.cfgDir, nextBackend), shellCmd: cmd })
        worker.model = next
        worker.backend = nextBackend
        worker.provider = this.routing.models[next].provider
        worker.spawnedAt = Date.now()
        worker.state = 'spawning'
        this.store.logEvent('worker_spawned', { repo: worker.repo, ticket: worker.ticket, worker: worker.session, model: next, backend: nextBackend, retry_after_limit: true })
        this.notify(worker.ticket, `⚙️ \`${worker.session}\` hit a ${limit.scope} usage limit — respawned on **${next}**`)
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
        await this.threads.release(worker.ticket, 'respawn-failed').catch(() => {})
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
    await this.threads.release(worker.ticket, 'exhausted').catch(() => {})
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

  // ---- the merge-gated ending (#54) ---------------------------------------------

  // Which ticket and repo a worker-facing tool call belongs to. The ticket comes
  // from the SPAWN BINDING (the worker record, else the session name) and never
  // from the caller — the same rule onResult follows, and for the same reason:
  // these calls push branches and ask humans to approve things.
  #bindingFor(workerName) {
    const w = this.workers.get(workerName)
    const m = workerName.match(SESSION_RE)
    const ticket = String(w?.ticket ?? (m ? m[1] : ''))
    if (!ticket) return { error: `no curia ticket is bound to \`${workerName}\`` }
    const repo = w?.repo ?? this.#epochRepo(ticket)
    if (!repo) return { error: `curia cannot tell which repo #${ticket} belongs to` }
    const wtPath = w?.wtPath ?? worktreePathFor(this.root, repo, ticket)
    return { w, ticket, repo, wtPath, branch: branchFor(ticket), basePath: basePathFor(this.root, repo) }
  }

  // `open_pull_request` (#54 item 1). Landing left report_result because the
  // pull request is now what a human reviews BEFORE anything is resolved — so it
  // has to be openable in the middle of a ticket, and re-openable after every
  // rejection. The worker still never pushes: the containment boundary of #40/#41
  // is unchanged, only its timing.
  async openPullRequest(workerName, { summary = '' } = {}) {
    const b = this.#bindingFor(workerName)
    if (b.error) return `❌ ${b.error} — nothing was pushed`
    const { w, ticket, repo, wtPath, branch, basePath } = b
    if (!fs.existsSync(wtPath)) return `❌ the worktree ${wtPath} is gone — nothing was pushed`

    let title = w?.title
    if (!title) {
      title = await this.deps.fetchIssue(repo, ticket).then((i) => i.title).catch(() => `#${ticket}`)
    }
    let out
    try {
      out = await landBranch({
        repo, ticket, title, summary, worker: workerName, model: w?.model ?? null,
        wtPath, basePath, branch, deps: this.deps,
        journal: (type, data) => this.store.logEvent(type, data),
      })
    } catch (e) {
      this.store.logEvent('land_failed', { repo, ticket, worker: workerName, branch, error: e.message })
      this.notify(ticket, `⚠️ \`${workerName}\`: opening the pull request FAILED — ${e.message}`)
      return `❌ curia could not land \`${branch}\`: ${e.message}. Your commits are safe in the worktree; fix what you can and call this again.`
    }
    if (!out.ok) {
      return `❌ nothing to open a pull request from — \`${branch}\` carries no commits. Commit your work first.`
    }
    if (w) w.prUrl = out.url
    await this.deps.commentIssue(repo, ticket, prLinkComment({
      branch, commits: out.commits, url: out.url, state: out.state,
    })).catch((e) => this.log(`pull-request comment on ${repo}#${ticket} failed: ${e.message}`))
    this.notify(ticket, `🔗 \`${workerName}\` ${out.state === 'updated' ? 'updated' : 'opened'} <${out.url}> (${out.commits} commit${out.commits === 1 ? '' : 's'} on \`${branch}\`)`)
    return `${out.state === 'updated' ? 'updated' : 'opened'} ${out.url} — ${out.commits} commit${out.commits === 1 ? '' : 's'} pushed on \`${branch}\`. Next: request_review.`
  }

  // `request_review` (#54 item 2, #48's gate). One gate, and it never branches on
  // ticket type: only the LINKS differ, and every one of them is composed here
  // from curia's own records rather than from anything the worker says — the
  // preview from the registry that allocated it, the pull request from GitHub,
  // the ticket from the spawn binding. #40 recorded the alternative as a live
  // limit: a worker can hand ask_human any `preview_url` string it likes.
  async requestReview(workerName, { summary = '', charting = '' } = {}) {
    const b = this.#bindingFor(workerName)
    if (b.error) return { ok: false, text: `❌ ${b.error} — no review was requested` }
    const { w, ticket, repo, branch } = b

    const title = w?.title ?? `#${ticket}`
    const links = [`Ticket: https://github.com/${repo}/issues/${ticket}`]
    let pr = null
    try {
      pr = await this.deps.findPullRequest(repo, branch)
    } catch (e) {
      this.log(`review gate for ${repo}#${ticket}: pull-request read failed (${e.message})`)
    }
    if (pr) links.push(`Pull request (**${pr.state}**): ${pr.url}`)
    else if (w?.prUrl) links.push(`Pull request: ${w.prUrl} (curia could not re-read its state just now)`)
    else links.push('_No pull request — this ticket produced no code._')
    const preview = this.previews?.get(ticket)
    if (preview?.url) links.push(`Preview: ${preview.url}`)

    const { text, truncated } = reviewGateText({ repo, ticket, title, summary, charting, links })
    this.store.logEvent('review_requested', {
      repo, ticket, worker: workerName, pr: pr?.url ?? w?.prUrl ?? null,
      preview: preview?.url ?? null, truncated,
    })
    if (w) w.state = 'awaiting-review'
    const { text: answer, status } = await this.askReview(workerName, ticket, text)
    if (w && w.state === 'awaiting-review') w.state = 'ready'

    if (status !== 'answered') {
      this.store.logEvent('review_answered', { repo, ticket, worker: workerName, approved: false, status })
      return { ok: true, aborted: true, text: `${answer}\n\n(the review gate was ${status}, not answered — do not merge and do not resolve anything)` }
    }
    const { approved, feedback } = classifyReviewAnswer(answer)
    this.store.logEvent('review_answered', { repo, ticket, worker: workerName, approved, via: 'gate' })
    if (approved) {
      return {
        ok: true,
        approved: true,
        text: `APPROVED by the human. Now, in order: merge the pull request (\`gh pr merge <url> --repo ${repo} --squash --delete-branch\`), then resolve the ticket, then report_result.${truncated ? '\n(note: your gate text was too long for one Discord message and was cut — keep the next one shorter)' : ''}`,
      }
    }
    return {
      ok: true,
      approved: false,
      text: [
        'NOT approved. The human said:',
        feedback || '(nothing beyond the rejection itself — ask them what to change with ask_human)',
        '',
        'Do not merge and do not resolve. Make the changes, commit, call open_pull_request again, then',
        'request_review again.',
      ].join('\n'),
    }
  }

  // What the journal says has happened SINCE this ticket's latest dispatch. The
  // epoch scoping is the same rule reconcile runs on: a pull request or an
  // approval from an earlier dispatch of the same ticket is not this worker's.
  #epochScan(ticket, workerName) {
    const journal = this.#readJournal()
    let epochIdx = -1
    journal.forEach((ev, i) => {
      if ((ev.type === 'dispatch_claimed' || ev.type === 'worker_spawned') && String(ev.ticket ?? '') === ticket) epochIdx = i
    })
    const mine = (ev) => ev.worker === workerName || String(ev.ticket ?? '') === ticket
    const since = (pred) => journal.some((ev, i) => i > epochIdx && pred(ev))
    return {
      prOpened: since((ev) => ['pr_opened', 'pr_reused', 'land_repaired'].includes(ev.type) && mine(ev)),
      reviewApproved: since((ev) => ev.type === 'review_answered' && ev.approved === true && mine(ev)),
      blocks: journal.filter((ev, i) => i > epochIdx && ev.type === 'stop_blocked' && ev.worker === workerName).length,
    }
  }

  // Everything the Stop-hook checklist is judged against. Cheap on purpose: the
  // hook fires at the end of EVERY turn, so this reads the journal and local git
  // and reaches GitHub only once a review has been approved (to ask whether the
  // merge happened).
  //
  // Every read fails OPEN — an indeterminate answer drops that item from the
  // checklist rather than adding it. Trapping a worker in a stop-block loop on a
  // failed `git log` is worse than letting one unfinished ticket through to the
  // repair path.
  async #endingState(workerName) {
    const b = this.#bindingFor(workerName)
    if (b.error) return { error: b.error }
    const { w, ticket, repo, wtPath, branch, basePath } = b
    const state = {
      ticket,
      repo,
      hasResult: Boolean(w?.resultReceived) || fs.existsSync(path.join(this.dataDir, 'results', `${workerName}.json`)),
      ...this.#epochScan(ticket, workerName),
      hasCommits: false,
      prState: null,
    }
    try {
      const commits = await this.deps.commitsOnBranch(wtPath, await this.deps.defaultBranchOf(basePath))
      state.hasCommits = commits.length > 0
    } catch (e) {
      this.log(`stop hook ${workerName}: could not read commits on ${branch} (${e.message}) — not asking for a pull request`)
    }
    if (state.reviewApproved && state.prOpened) {
      try {
        state.prState = (await this.deps.findPullRequest(repo, branch))?.state ?? null
      } catch (e) {
        this.log(`stop hook ${workerName}: could not read the pull request for ${branch} (${e.message}) — not asking for a merge`)
      }
    }
    return state
  }

  // The Stop hook's answer (#54 item 4). Returns what index.mjs puts on the wire:
  //   { decision: 'block', reason }  — hold the worker at the ending
  //   { allow: true, terminal: bool } — let it stop; `terminal` says whether the
  //                                     dispatch lifecycle should now close
  //
  // #47 stays FIRST and unchanged: a turn that ends with an escalation still open
  // is a worker blocked on a human, not a worker that finished — and blocking
  // THAT stop would spin a worker whose next move is not its own to make.
  async onStopHook(workerName, { stopHookActive = false } = {}) {
    const block = await this.#humanBlockEvidence(workerName)
    if (block.blocked) {
      this.#recordHumanBlock(workerName, block.open)
      return { allow: true, terminal: false }
    }

    const state = await this.#endingState(workerName)
    if (state.error) return { allow: true, terminal: true }
    const items = outstanding(state)
    if (!items.length) return { allow: true, terminal: true }

    const budget = this.config.dispatch.stop_nudge_budget
    const attempt = state.blocks + 1
    if (attempt > budget) {
      // The one thing worse than an unfinished ticket is a worker looping on
      // quota unattended (#48). Past the budget the stop is allowed and the
      // lifecycle closes on the evidence it actually has: report_result present
      // ⇒ verify and repair; absent ⇒ the abnormal-exit branch, which keeps the
      // pane and says so.
      this.store.logEvent('stop_budget_exhausted', {
        worker: workerName, ticket: state.ticket, repo: state.repo, blocks: state.blocks, outstanding: items,
      })
      this.notify(state.ticket, `⚠️ \`${workerName}\` stopped with ${items.length} step(s) of the ending outstanding after ${state.blocks} nudge(s) — curia is no longer holding it:\n${items.map((t) => `• ${t}`).join('\n')}`)
      return { allow: true, terminal: true }
    }
    this.store.logEvent('stop_blocked', {
      worker: workerName, ticket: state.ticket, repo: state.repo, attempt, outstanding: items, stop_hook_active: stopHookActive,
    })
    this.log(`stop hook ${workerName}: blocking stop ${attempt}/${budget} — ${items.join('; ')}`)
    return { decision: 'block', reason: stopReason(items, { attempt, budget }) }
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
    if (result.ticket != null) {
      const ref = parseTicketRef(result.ticket)
      const boundRepo = w?.repo ?? null
      const sameTicket = ref.number === ticket
        && (!ref.repo || !boundRepo || ref.repo.toLowerCase() === boundRepo.toLowerCase())
      if (!sameTicket) {
        this.store.logEvent('result_ticket_mismatch', { worker: workerName, bound: ticket, reported: String(result.ticket) })
        this.log(`WARNING: ${workerName} reported ticket ${result.ticket} but is bound to ${ticket} — acting on ${ticket}`)
      }
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
    // The gate is the one thing the Stop hook structurally CANNOT enforce: a
    // recorded result ends the checklist, so a worker that goes straight from the
    // work to comment-close-report_result never gets held. Nothing here can
    // un-resolve that ticket — but the daemon can refuse to call it reviewed, and
    // this is the record a human reads afterwards. Sibling of the unmerged
    // warning in resolve.mjs, for the same reason: say it, do not hide it.
    if (!this.#epochScan(ticket, workerName).reviewApproved) {
      this.store.logEvent('resolved_unreviewed', { repo, ticket, worker: workerName })
      out.warnings.push('NO approved review gate for this dispatch — this ticket was resolved without anyone approving it')
    }
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

  // Open escalations bound to THIS worker. The binding is the spawn binding —
  // the MCP URL and the Stop hook carry the same `worker=curia-<n>` — so an
  // overseer confirm on the same ticket is correctly not one of these: a
  // confirm is a question to a human about the worker, not a call the worker
  // is sitting in.
  #openEscalationsFor(workerName) {
    return this.store.openEscalations().filter((r) => r.worker === workerName)
  }

  // #47's evidence, in one place because two callers need it: the Stop hook's
  // decision and the terminal path. An open escalation bound to this worker means
  // it is blocked in a human call; the ONE thing that outranks that is positive
  // evidence the session is gone (killed between the hook's curl and this check),
  // because then the call can never resume. An indeterminate tmux read is not
  // evidence, and its safe direction is the block.
  async #humanBlockEvidence(workerName) {
    const open = this.#openEscalationsFor(workerName)
    if (!open.length) return { blocked: false, gone: false, open }
    let gone = false
    try {
      gone = !(await this.deps.hasSession(workerName))
    } catch (e) {
      this.log(`worker_done ${workerName}: session presence indeterminate (${e.message}) — treating the open escalation as a live block`)
    }
    return { blocked: !gone, gone, open }
  }

  #recordHumanBlock(workerName, open) {
    const w = this.workers.get(workerName)
    const reviewing = open.some((r) => r.kind === REVIEW_KIND)
    if (w) w.state = reviewing ? 'awaiting-review' : 'blocked'
    const ticket = w?.ticket ?? workerName.match(SESSION_RE)?.[1] ?? workerName
    this.store.logEvent('worker_blocked_on_human', {
      worker: workerName, ticket, repo: w?.repo,
      escalations: open.map((r) => r.id), awaiting_review: reviewing,
    })
    this.log(`worker_done ${workerName}: turn ended with ${open.map((r) => r.id).join(', ')} still open — ${reviewing ? 'awaiting review' : 'blocked on a human'}, not gone`)
  }

  async onWorkerDone(workerName) {
    const w = this.workers.get(workerName)
    const m = workerName.match(SESSION_RE)
    const ticket = w?.ticket ?? (m ? m[1] : workerName)
    const resultsFile = path.join(this.dataDir, 'results', `${workerName}.json`)
    const hasResult = Boolean(w?.resultReceived) || fs.existsSync(resultsFile)

    // #47: the Stop hook fires when a TURN ends, which is not the same as a
    // worker ending. #35 caught the difference live — a worker that pushes
    // ask_human onto a background MCP task ends its turn while the call is
    // still pending, and every terminal act below then ran on a healthy blocked
    // worker: the preview was withdrawn out from under the human mid-review,
    // the record was marked failed, and the thread was told it had stopped
    // without a result.
    //
    // The daemon already held the evidence and did not consult it: an OPEN
    // escalation bound to this worker means it is blocked in `ask_human`,
    // exactly where #11 promises it stays. This is decided BEFORE the result
    // branch, because the question here is "is this worker still there", not
    // "did it finish" — and the result branch kills the session, which would
    // strand a question a human is still being asked. Nothing terminal happens;
    // the Stop that follows the answer is judged on its own, with no open
    // escalation left to defer on.
    const { blocked, open } = await this.#humanBlockEvidence(workerName)
    if (blocked) {
      this.#recordHumanBlock(workerName, open)
      return
    }
    if (open.length) {
      // Positively gone with calls still open: the exit is abnormal after all and
      // the escalations must not keep asking — a human answering into a dead
      // worker gets a ✅ for an answer nothing will ever read.
      for (const r of open) {
        this.cancelEscalation(r.id, { by: 'worker-death' })
        this.store.logEvent('escalation_orphaned', { id: r.id, worker: workerName, ticket })
      }
      this.notify(ticket, `⚠️ \`${workerName}\` is gone while ${open.length} escalation(s) were still open — ${open.map((r) => `**${r.id}**`).join(', ')} cancelled: nothing is waiting for an answer any more`)
    }

    // Both branches: a finished worker's dev server is dead either way, so the
    // rule would publish a dead port (or whatever binds it next) — the exact
    // thing publish() refuses to create in the first place.
    await this.#withdrawPreview(ticket, hasResult ? 'worker finished' : 'worker exited without a result')
    if (hasResult) {
      this.store.logEvent('lifecycle_closed', { worker: workerName, ticket, repo: w?.repo })
      await this.deps.killSession(workerName).catch(() => {})
      this.workers.delete(workerName)
      // the OAuth credential copy never survives (a pre-#53 leftover collector)
      this.deps.removeCredentials(w?.cfgDir ?? cfgDirFor(this.root, workerName))
      // #54 item 7: the merge — not the result — is what ends the lease. Review
      // already happened, so "kept for review" no longer means anything; what
      // decides now is whether the code is in.
      const lease = await this.#endWorkspaceLease(workerName, ticket, w?.repo ?? this.#epochRepo(ticket))
      this.notify(ticket, `✅ \`${workerName}\` finished with a recorded result — session closed; ${lease}`)
      this.lapseConfirmsFor(workerName, `\`${workerName}\` finished`)
      // terminal state ⇒ the ticket label comes off the thread (#93)
      await this.threads.release(ticket, 'finished').catch(() => {})
    } else {
      // result-less exit: the pane is the post-mortem evidence — keep it
      if (w) w.state = 'failed'
      this.store.logEvent('worker_abnormal_exit', { worker: workerName, ticket, repo: w?.repo })
      this.notify(ticket, `⚠️ \`${workerName}\` stopped WITHOUT reporting a result — session kept for post-mortem (\`/attach ${ticket}\`)`)
      // the worker the confirm described has exited, whatever the pane holds (#94)
      this.lapseConfirmsFor(workerName, `\`${workerName}\` stopped without a result`)
    }
  }

  // Merge ends the workspace lease (#54 item 7), replacing "worktree, branch and
  // claim kept for review" — the review is over by now.
  //
  // Every branch here fails towards KEEPING the workspace. A worktree is the only
  // copy of anything not pushed, so "merged" has to be positively established:
  // an unreadable pull-request state, an unreadable git log, an unmerged pull
  // request and a missing repo all keep it, loudly. The remote branch is deleted
  // as a REPAIR only — the worker's own `gh pr merge --delete-branch` is what
  // normally does it.
  async #endWorkspaceLease(workerName, ticket, repo) {
    if (!repo) return 'worktree kept — curia could not tell which repo this ticket belongs to'
    const branch = branchFor(ticket)
    const basePath = basePathFor(this.root, repo)
    const wtPath = worktreePathFor(this.root, repo, ticket)

    let pr
    try {
      pr = await this.deps.findPullRequest(repo, branch)
    } catch (e) {
      this.store.logEvent('lease_kept', { repo, ticket, worker: workerName, branch, reason: `pull-request state unreadable: ${e.message}` })
      return `worktree and branch kept — curia could not read the pull-request state (${e.message})`
    }

    if (pr && pr.state !== 'MERGED') {
      this.store.logEvent('lease_kept', { repo, ticket, worker: workerName, branch, reason: `pull request is ${pr.state}` })
      return `⚠️ worktree and branch KEPT — ${pr.url} is **${pr.state}**, not merged`
    }
    if (!pr) {
      // No pull request at all: fine for a ticket that produced no code, and a
      // defect for one that did (resolveAndLand would have repaired it, so this
      // is the indeterminate case).
      let commits = null
      try {
        commits = await this.deps.commitsOnBranch(wtPath, await this.deps.defaultBranchOf(basePath))
      } catch { /* indeterminate ⇒ keep */ }
      if (commits === null || commits.length) {
        this.store.logEvent('lease_kept', { repo, ticket, worker: workerName, branch, reason: 'no pull request, and the branch may hold commits' })
        return '⚠️ worktree and branch KEPT — there is no pull request and curia cannot rule out unlanded commits'
      }
    }

    let removed = false
    try {
      await this.deps.removeWorktree(basePath, wtPath)
      removed = true
    } catch (e) {
      this.log(`lease end for ${repo}#${ticket}: worktree removal failed (${e.message})`)
    }
    let branchNote = ''
    if (pr) {
      try {
        const { absent } = await this.deps.deleteRemoteBranch(repo, branch)
        branchNote = absent ? `, remote \`${branch}\` already gone` : `, remote \`${branch}\` deleted`
      } catch (e) {
        branchNote = `, remote \`${branch}\` still there (${e.message})`
      }
    }
    this.store.logEvent('lease_released', { repo, ticket, worker: workerName, branch, merged: Boolean(pr), worktree_removed: removed })
    return `${pr ? `${pr.url} is merged` : 'no code was produced'} — ${removed ? 'worktree removed' : 'worktree removal FAILED'}${branchNote}`
  }

  // ---- cancel --------------------------------------------------------------------
  //
  // Two paths since #94, per #89's discipline: slash and REST cancel execute AT
  // ONCE (a typed /cancel is its own confirmation); the overseer's interpreted
  // cancel never executes — requestCancel* opens a `confirm` escalation with
  // ✅/❌ buttons and the model's turn ends. The executing path is button →
  // gate.answer → onConfirmAnswered, never through the model.

  async cancel(n, { by } = {}) {
    const ticket = String(n)
    const session = `curia-${ticket}`
    if (!this.workers.has(session) && !(await this.deps.hasSession(session).catch(() => false))) {
      return `nothing to cancel — no live worker on #${ticket}`
    }
    return this.#teardown(ticket, { by })
  }

  // The bulk verb (#81), immediate like the single one: the same teardown,
  // worker by worker. Sessions this process does not track are cancelled too —
  // `cancel all` means all.
  async cancelAll({ by } = {}) {
    const listed = await this.#liveTargets()
    if (listed.error) return listed.error
    const { targets, rows } = listed
    if (!targets.length) return 'no live workers to cancel'
    for (const t of targets) {
      await this.#teardown(t.ticket, { by }).catch((e) => this.log(`cancel of ${t.session} failed:`, e.message))
    }
    return `⚰️ cancelled ${targets.length} worker(s):\n${rows.join('\n')}`
  }

  // Every live curia session as a confirm target: tracked ones carry their
  // instance id, untracked ones a sentinel the executing path re-checks
  // against tmux. An indeterminate session list refuses — "all" must never
  // silently narrow to the tracked set.
  async #liveTargets() {
    let live = []
    try {
      live = (await this.deps.listSessions()).filter((s) => SESSION_RE.test(s))
    } catch (e) {
      return { error: `❌ cancel all refused — the tmux session list is indeterminate (${e.message}); retry, or cancel tickets one by one` }
    }
    const sessions = [...new Set([...this.workers.keys(), ...live])].sort()
    const targets = sessions.map((s) => this.#targetFor(s))
    const rows = targets.map((t) => (t.state ? `• \`${t.session}\` ${t.repo}#${t.ticket} — **${t.state}**` : `• \`${t.session}\` — untracked`))
    return { targets, rows }
  }

  #targetFor(session) {
    const ticket = session.match(SESSION_RE)?.[1] ?? session
    const w = this.workers.get(session)
    return w
      ? { session, ticket, repo: w.repo, state: w.state, instance: w.instance }
      : { session, ticket, repo: null, state: null, instance: `${session}@untracked` }
  }

  // The interpreted cancel (#94): open the confirm, execute nothing. The
  // confirm is INSTANCE-bound and lapses when its worker exits; no expiry
  // clock. A newer confirm on the same instance supersedes the older
  // (store.open).
  async requestCancel(n, { threadId = null } = {}) {
    const ticket = String(n)
    const session = `curia-${ticket}`
    let target = null
    if (this.workers.has(session)) target = this.#targetFor(session)
    else if (await this.deps.hasSession(session).catch(() => false)) target = this.#targetFor(session)
    if (!target) return `nothing to cancel — no live worker on #${ticket}`
    const desc = target.state ? `(${target.repo}#${ticket}, **${target.state}**)` : '(untracked)'
    const record = this.openConfirm({
      ticket,
      prompt: `Cancel \`${session}\` ${desc}? This kills the session, removes the worktree and re-frontiers the ticket.`,
      action: { verb: 'cancel', targets: [target] },
      originThreadId: threadId,
    })
    if (!record) return '⚠️ could not open the confirm — nothing was cancelled'
    return `⚙️ posted confirm **${record.id}** with ✅/❌ buttons in the ticket thread — nothing happens until ✅, and it lapses if the worker exits first`
  }

  async requestCancelAll({ threadId = null } = {}) {
    const listed = await this.#liveTargets()
    if (listed.error) return listed.error
    const { targets, rows } = listed
    if (!targets.length) return 'no live workers to cancel'
    const record = this.openConfirm({
      ticket: 'all',
      prompt: `Cancel ALL ${targets.length} worker(s)? Each session is killed, its worktree removed and its ticket re-frontiered:\n${rows.join('\n')}`,
      action: { verb: 'cancel', targets },
      originThreadId: threadId,
    })
    if (!record) return '⚠️ could not open the confirm — nothing was cancelled'
    return `⚙️ posted confirm **${record.id}** for ${targets.length} worker(s) — nothing happens until ✅:\n${rows.join('\n')}`
  }

  // The executing path (#94): button → daemon. gate.answer calls this after
  // the record closed (first-valid-wins already decided who spoke). Approve
  // tears down every target whose instance is STILL the live one; a target
  // whose worker exited or was replaced since the confirm was posted is
  // skipped, never guessed at.
  async onConfirmAnswered(record) {
    const { verb, targets = [] } = record.action ?? {}
    if (verb !== 'cancel') {
      this.log(`confirm ${record.id} carries unknown verb "${verb}" — nothing executed`)
      return
    }
    const name = targets.length === 1 ? `\`${targets[0].session}\`` : `${targets.length} worker(s)`
    if (record.answer !== 'approve') {
      this.confirmNote(record, `❌ not confirmed — ${name} untouched`)
      this.#noteOrigin(record, `confirm ${record.id} declined — ${name} untouched`)
      return
    }
    const done = []
    const skipped = []
    for (const t of targets) {
      if (!(await this.#instanceLive(t))) {
        skipped.push(t.session)
        continue
      }
      try {
        await this.#teardown(t.ticket, { by: record.answered_by })
        done.push(t.session)
      } catch (e) {
        this.log(`confirmed cancel of ${t.session} failed:`, e.message)
        skipped.push(t.session)
      }
    }
    if (skipped.length) {
      this.confirmNote(record, `⚰️ skipped ${skipped.map((s) => `\`${s}\``).join(', ')} — gone, replaced, or the teardown failed (see the log)`)
    }
    this.#noteOrigin(record, `confirm ${record.id} approved — cancelled ${done.length ? done.join(', ') : 'nothing'}${skipped.length ? `; skipped ${skipped.join(', ')} (gone or replaced)` : ''}`)
  }

  async #instanceLive(t) {
    const w = this.workers.get(t.session)
    if (w) return w.instance === t.instance
    if (!String(t.instance).endsWith('@untracked')) return false
    return this.deps.hasSession(t.session).catch(() => false)
  }

  #noteOrigin(record, text) {
    if (record.origin_thread_id) this.overseerNote(record.origin_thread_id, text)
  }

  // Confirms lapse the moment their worker exits (#89): every exit path calls
  // this with the dying session, so a stale confirm can never hit a successor
  // worker. Session-name match suffices — an open confirm can only describe
  // the current instance, because the previous exit lapsed the previous one.
  lapseConfirmsFor(session, why) {
    for (const r of this.store.openEscalations()) {
      if (r.kind !== CONFIRM_KIND) continue
      if (!(r.action?.targets ?? []).some((t) => t.session === session)) continue
      this.lapseEscalation(r.id, why)
      this.store.logEvent('confirm_lapsed', { id: r.id, session, reason: why })
      this.#noteOrigin(r, `confirm ${r.id} lapsed — ${why}; nothing was executed`)
    }
  }

  // The teardown a confirmed cancel runs — shared verbatim by cancel and
  // cancelAll, so the bulk verb can never drift from the single one.
  async #teardown(ticket, { by } = {}) {
    const session = `curia-${ticket}`
    const w = this.workers.get(session)
    await this.#withdrawPreview(ticket, 'ticket cancelled')
    await this.deps.killSession(session).catch(() => {})
    // The other half of #47: this is the one path that KNOWS the worker is
    // gone. A worker cancelled while blocked leaves its ask_human asking —
    // the record stays open, the thread keeps nudging every ~30 min, and an
    // answer would settle a resolver whose worker no longer exists. Cancel
    // them here, where the death is certain.
    for (const r of this.#openEscalationsFor(session)) {
      this.cancelEscalation(r.id, { by: 'cancel' })
      this.store.logEvent('escalation_orphaned', { id: r.id, worker: session, ticket })
    }
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
    // status's recent-cancelled view reads this event; the unclaim events
    // above cannot carry it because an untracked cancel writes none.
    this.store.logEvent('worker_cancelled', { repo: w?.repo, ticket, worker: session, by: by ?? 'unknown', tracked: Boolean(w) })
    const tail = w
      ? (released ? ', worktree removed, ticket re-frontiered' : ', worktree removed — but the claim release FAILED: the issue is still assigned; reconcile will retry')
      : ' (was untracked; GitHub claim untouched)'
    const msg = `⚰️ \`${session}\` cancelled — session killed${tail}`
    this.notify(ticket, msg)
    // the worker is positively gone ⇒ any OTHER open confirm on it lapses (#94)
    this.lapseConfirmsFor(session, `\`${session}\` was cancelled`)
    // terminal state ⇒ the ticket label comes off the thread (#93)
    await this.threads.release(ticket, 'cancelled').catch(() => {})
    return msg
  }

  // ---- resume --------------------------------------------------------------------

  // The resume contract (#81): a fresh worker on the ticket, inheriting the
  // surviving worktree, never the conversation. A live worker is refused flat —
  // resume means "the worker is gone", and the teardown-and-redispatch offer
  // already lives on `start`.
  async resume(n, { repo, model, backend, by, threadId } = {}) {
    const ticket = String(n)
    const session = `curia-${ticket}`
    if (this.workers.has(session) || this.inFlight.has(session) || await this.deps.hasSession(session).catch(() => false)) {
      return `▶️ \`${session}\` is already running — \`cancel ${ticket}\` first, or \`attach ${ticket}\``
    }
    return this.start(ticket, { repo, model, backend, by, reuse: true, threadId })
  }

  // Bulk resume (#81): every surviving worktree without a live worker, behind
  // ONE confirm carrying count and list. A closed ticket in the list refuses at
  // dispatch and says so in its own thread.
  async resumeAll({ by } = {}) {
    let targets
    try {
      targets = await this.#resumable()
    } catch (e) {
      return `❌ resume all refused — the tmux session list is indeterminate (${e.message}); retry, or resume tickets one by one`
    }
    if (!targets.length) return 'nothing to resume — no surviving worktree without a live worker'
    const rows = targets.map((t) => `• ${t.repo}#${t.ticket}`)
    // resume is not destructive, so the bulk verb runs at once (#89: only
    // interpreted destructive actions confirm); the dispatches continue in
    // their ticket threads so this reply stays fast
    ;(async () => {
      for (const t of targets) {
        const msg = await this.resume(t.ticket, { repo: t.repo, by }).catch((e) => `⚠️ resume of ${t.repo}#${t.ticket} failed: ${e.message}`)
        if (msg) this.notify(t.ticket, msg)
      }
    })().catch((e) => this.log('resume all failed:', e.message))
    return `▶️ resuming ${targets.length} ticket(s):\n${rows.join('\n')}`
  }

  // Surviving worktrees with no live worker, across the watch list. Throws on
  // an indeterminate session list — "no sessions" would make every worktree
  // look resumable and re-dispatch live workers' tickets.
  async #resumable() {
    const live = new Set((await this.deps.listSessions()).filter((s) => SESSION_RE.test(s)))
    const out = []
    for (const entry of this.config.watch) {
      const wtRoot = path.dirname(worktreePathFor(this.root, entry.repo, '0'))
      let dirs = []
      try {
        dirs = fs.readdirSync(wtRoot)
      } catch {
        continue // repo never dispatched — no worktrees to resume
      }
      for (const d of dirs.sort((a, b) => Number(a) - Number(b))) {
        if (!/^\d+$/.test(d)) continue
        const session = `curia-${d}`
        if (live.has(session) || this.workers.has(session) || this.inFlight.has(session)) continue
        out.push({ repo: entry.repo, ticket: d })
      }
    }
    return out
  }

  // ---- status --------------------------------------------------------------------

  async status() {
    const live = (await this.deps.listSessions()).filter((s) => s.startsWith('curia-'))
    // #54 item 9: *awaiting review* is read off the open escalation record, not
    // off the worker record, so it is also right for a worker this process
    // adopted at reconcile and whose in-memory state is a guess.
    const open = this.store.openEscalations()
    const reviewing = new Set(open
      .filter((r) => r.kind === REVIEW_KIND)
      .map((r) => r.worker))
    const workers = [...this.workers.values()].map((w) => ({
      session: w.session,
      repo: w.repo,
      ticket: w.ticket,
      title: w.title,
      model: w.model,
      state: reviewing.has(w.session) ? 'awaiting-review' : w.state,
      uptime_s: w.spawnedAt ? Math.round((Date.now() - w.spawnedAt) / 1000) : null,
      result_received: w.resultReceived,
      tmux_live: live.includes(w.session),
      // where a waiting worker waits (#81's grown status): the open escalation
      // records bound to it — id and kind, enough to name the thread and ask
      waiting_on: open.filter((r) => r.worker === w.session).map((r) => ({ id: r.id, kind: r.kind })),
    }))
    const untracked = live.filter((s) => !this.workers.has(s))
    return { workers, untracked, recent: this.#recentOutcomes() }
  }

  // Recent cancelled and finished (#81's grown status), newest last, capped per
  // kind. Journal-derived like everything else here — an unreadable journal
  // costs the recents, never the whole status.
  #recentOutcomes(cap = 5) {
    let journal = []
    try {
      journal = this.#readJournal()
    } catch {
      return []
    }
    const of = (kinds) => journal
      .filter((ev) => kinds[ev.type])
      .map((ev) => ({ kind: kinds[ev.type], repo: ev.repo ?? null, ticket: String(ev.ticket ?? '') }))
      .slice(-cap)
    return [...of({ worker_cancelled: 'cancelled' }), ...of({ lifecycle_closed: 'finished' })]
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

    // Ticket-label sweep (#93): a bound ticket with no live session, no
    // tracked worker and no in-flight start hit its terminal state while this
    // process was not looking (a restart) — take the label off now. Same
    // evidence rule as every sweep: only a determinate session list. An open
    // escalation on the ticket keeps the label — a human is still being asked
    // there (awaiting review across a reboot), and its traffic must keep
    // landing in the labeled thread.
    if (ctx.sessions && typeof this.store.boundTickets === 'function') {
      const asked = new Set(this.store.openEscalations().map((r) => String(r.ticket)))
      for (const ticket of this.store.boundTickets()) {
        const session = `curia-${ticket}`
        if (ctx.sessions.includes(session) || this.workers.has(session) || this.inFlight.has(session)) continue
        if (asked.has(String(ticket))) continue
        await this.threads.release(ticket, 'reconcile')
          .catch((e) => this.log(`reconcile: thread release for #${ticket} failed (${e.message})`))
      }
    }

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
    // The timeline surface (#74) rides the same posture: asserted every
    // reconcile, never fatally, withdrawn when it cannot be verified. The
    // object owns its own verify-or-withdraw logic; this catch only keeps a
    // tailscale failure from failing the whole pass.
    if (this.timeline) {
      await this.timeline.assert().catch((e) => this.log(`reconcile: timeline surface assertion failed (${e.message}) — the timeline may be unavailable`))
    }
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
            // a FRESH instance id: any confirm bound before the restart lapses
            // at boot rather than matching an adopted worker it never described
            repo, ticket: n, title: issue.title, session, instance: `${session}@adopted-${Date.now()}`,
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
      // Fail-soft like its two siblings above (found live on #74): the rm can
      // race the just-killed agent's final transcript writes into ENOTEMPTY,
      // and an uncaught throw here aborts the whole pass — including the
      // attach/timeline surface asserts that run at its end. Leftovers are
      // rubble, not risk (#53: a config dir holds no credential of its own);
      // the next pass retries.
      try {
        this.deps.removeConfigDir(cfgDirFor(this.root, session))
      } catch (e) {
        this.log(`reconcile: could not remove the config dir of swept orphan ${session} (${e.message}) — leftovers stay for the next pass`)
      }
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
        // #54 item 5: open + assigned + no live session + no result is ALSO the
        // shape of *awaiting review* — a worker whose box rebooted while a human
        // sat on the gate. An open pull request from `curia/<n>` says the work is
        // real and waiting on a person, so the claim is not dead and re-dispatch
        // is not the answer. An unreadable pull-request state is indeterminate
        // and keeps the claim too, the same rule the rest of reconcile runs on.
        let pr
        try {
          pr = await this.deps.findPullRequest(repo, branchFor(ticket))
        } catch (e) {
          skipRepo(repo, e)
          continue
        }
        if (pr && pr.state === 'OPEN') {
          this.store.logEvent('dead_claim_kept_awaiting_review', { repo, ticket, worker: session, pr: pr.url })
          this.log(`reconcile: keeping the claim on ${repo}#${ticket} — ${pr.url} is open and awaiting review`)
          continue
        }
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

  // Abandoned credential collection — a pre-#53 leftover collector now.
  // Workers no longer hold a credential of their own (workerEnv shares the
  // host store), so a fresh cfg dir has nothing to collect and this is a no-op
  // for it. It still runs because cfg dirs seeded before #53 hold a real host
  // refresh token on disk, and the two terminal states that deliberately keep
  // the whole workspace for post-mortem (onWorkerDone's abnormal-exit branch
  // and the watchdog's ready-timeout) would otherwise leave one there until a
  // human ran /cancel. Deleting eagerly in those branches would break a session
  // a human re-attaches and resumes — so collect here instead, once the tmux
  // session is positively gone: credentials only, never the dir (prompt.md
  // survives the post-mortem). Unlink-only, so it can never reach through to
  // the shared host file.
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

  // Boot only. A restart mints fresh instance ids at adopt (#94), so no open
  // confirm can name a live instance any more — lapse them, message edited,
  // rather than leaving buttons whose targets can no longer be matched.
  // Legacy pre-#94 overseer approve-reject confirms lost their resolver with
  // the old process and are voided as before. An on-demand POST /reconcile
  // must NOT touch confirms — their instances are still matchable live.
  #voidBootConfirms() {
    for (const r of this.store.openEscalations()) {
      if (r.kind === CONFIRM_KIND) {
        this.lapseEscalation(r.id, 'the daemon restarted, and worker instances do not match across a restart')
        this.store.logEvent('confirm_lapsed', { id: r.id, reason: 'boot' })
        this.#noteOrigin(r, `confirm ${r.id} lapsed — the daemon restarted; re-issue the command if you still want it`)
        continue
      }
      if (r.worker !== 'overseer') continue
      this.cancelEscalation(r.id, { by: 'reconcile' })
      this.store.logEvent('confirm_voided', { id: r.id, ticket: r.ticket })
      this.notify(r.ticket, `⚠️ confirm **${r.id}** was voided by a daemon restart — please re-issue the command`)
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
    const { serve_port: servePort, ttyd_port: ttydPort, index } = this.config.attach
    try {
      const { verified } = await this.deps.ensureTtyd({ ttydPort, index, log: this.log })
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
