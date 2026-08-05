// Dispatcher (#33 step 8): frontier → claim → worktree → tmux agent →
// lifecycle close, plus reconcile and the optional auto-dispatch loop.
//
// State posture (#9): the agents map is a disposable in-memory cache; GitHub
// claims + `tmux ls` + the journal are the three real sources, re-derived by
// reconcile(). Nothing authoritative lives here.
//
// Ordering invariant (intent priority 4): claim → prepare → spawn, and any
// prepare/spawn failure unclaims — never claim what cannot be spawned.
//
// Every external effect (gh, tmux, git, the attach surface) is reached through
// `this.deps`, which defaults to the real modules and can be overridden per
// instance. That seam is what makes start/onAgentDone/reconcile unit-testable
// against fixtures instead of a live box.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as sleepFor } from 'node:timers/promises'
import {
  viewerLogin, repoMaps, mapFrontier, flatFrontier, fetchIssue, claim, unclaim, blockedByOf,
  selectLane, frontierForRepo, agentOnlyChainCount, commentIssue, closeIssue, setIssueBody, issueComments,
  parentNumberOf, hasLabel, findPullRequest, createPullRequest, setPullRequestBody,
  deleteRemoteBranch,
} from './github.mjs'
import {
  resolveModel, candidates, buildSpawnCmd, spawnModelId, parseUsageLimit, parseCreditGate,
  carriesLimitPhrase, resolveReviewer, Cooling, SAME_PROVIDER_STAMP,
} from './routing.mjs'
import { hasSession, listSessions, newSession, capturePane, killSession } from './tmux.mjs'
import {
  ensureBaseClone, createWorktree, createPrivateClone, isPrivateClone, removeWorktree,
  removeConfigDir, removeCredentials, createReviewCheckout, reviewPathFor, writeReviewPrompt,
  seedConfigDir, writeConnectionSettings, writePrompt, basePathFor, worktreePathFor, cfgDirFor,
  branchFor, defaultBranchOf, commitsOnBranch, pushBranch, hasUnpushedWork, agentEnv,
  untrustedProjectConfig,
} from './workspace.mjs'
import { ensureAgentImage } from './image.mjs'
import { transcriptReset } from './usage.mjs'
import { mintAgentToken, forgetAgentToken, sweepAgentTokens } from './agenttoken.mjs'
import {
  GUEST_WT, GUEST_CFG, GUEST_DAEMON_HOST, ENV_FILE, PORTS_PER_AGENT,
  allocatePorts, containerPorts, dockerRunCmd, listContainers, modelCredential, stopContainer,
  writeEnvFile,
} from './sandbox.mjs'
import {
  resolveAndLand, summariseOutcome, nonCleanComment, landBranch, prLinkComment, chartingComment,
  verdictComment, judgementComment, verdictNote,
} from './resolve.mjs'
import { outstanding, stopReason, reviewGateText, classifyReviewAnswer, REVIEW_KIND, dutyLines } from './lifecycle.mjs'
import { CONFIRM_KIND, normalizeEvent } from './store.mjs'
import { ensureTtyd, assertServe, serveOff } from './attach.mjs'

const SESSION_RE = /^curia-(\d+)$/

// The cross-check reviewer's session name (#164, ADR-0010). Distinct from
// `curia-<n>` by construction, and that is the point rather than a detail:
// `curia-<n>` is the BUILDER's identity on every surface curia has — the tmux
// session, the config dir, the agent token, the attach wrapper's whitelist, the
// status line — so a second agent on the same ticket needs a name of its own or
// it takes the builder's place on all of them at once.
//
// SESSION_RE does not match it, which is what keeps the ticket passes
// (adoption, the orphan sweep, dead claims) blind to reviewers: a reviewer holds
// no claim, so every one of those passes would reason about it wrongly. The
// passes that must see it — containers, credentials, tokens — are given the
// wider list explicitly.
const REVIEW_SESSION_RE = /^curia-review-(\d+)$/
export const reviewSessionFor = (n) => `curia-review-${n}`

// The label that makes a dispatch a CHARTING one (#160): `start curia#<map>` on
// the map's own issue spawns an agent that updates the map, not one that
// resolves a ticket under it. Everything that branches on it reads this
// constant, and the journal records the answer per spawn so a restarted daemon
// still knows which kind of agent it adopted.
const MAP_LABEL = 'wayfinder:map'

// The tracker doc every watched repo is meant to carry (#57 step 3). The
// wayfinder skill reads it to learn how this repo expresses maps and tickets;
// without it the skill follows its own instruction to fall back to the
// local-markdown tracker, and the agent writes .scratch/ files instead of
// resolving on GitHub.
const TRACKER_DOC = 'docs/agents/issue-tracker.md'

// gh failure classification, shared by #resolveRepo and reconcile's getIssue:
// only an HTTP 404 is POSITIVE evidence the issue does not exist in a repo.
// Any other failure (rate limit, 5xx, network) is indeterminate and must
// never narrow a candidate set — with two watched repos both carrying #n, a
// transient failure on one would otherwise shrink the set to 1, skip the
// ambiguity refusal, and dispatch a bypassPermissions agent against the
// WRONG repo's issue with no human in the loop.
const ISSUE_ABSENT_RE = /HTTP 404|Not Found/i

// unref'd so a pending poll never holds the process open
const sleep = (ms) => sleepFor(ms, undefined, { ref: false })

const DEFAULT_DEPS = {
  viewerLogin, repoMaps, mapFrontier, flatFrontier, fetchIssue, claim, unclaim, blockedByOf,
  hasSession, listSessions, newSession, capturePane, killSession,
  ensureBaseClone, createWorktree, createPrivateClone, removeWorktree, removeConfigDir, removeCredentials,
  createReviewCheckout, writeReviewPrompt,
  seedConfigDir, writeConnectionSettings, writePrompt,
  ensureTtyd, assertServe, serveOff,
  // the agent sandbox (#156)
  ensureAgentImage, stopContainer, listContainers, allocatePorts, containerPorts,
  // #188: the daemon owns the container-facing listener, so index.mjs supplies
  // this one. The default REFUSES, which only a caller running a sandboxed
  // harness can ever reach — and a sandboxed dispatch with nothing checking the
  // side channel is the fault this ticket exists to end.
  assertSideChannel: async () => {
    throw new Error('nothing is wired to check the container side channel, so curia cannot tell whether an agent could reach it')
  },
  // the per-agent token on the loopback surface (#159)
  mintAgentToken, forgetAgentToken, sweepAgentTokens,
  // resolve + land (#41), merge-gated (#54)
  commentIssue, closeIssue, setIssueBody, issueComments, findPullRequest, createPullRequest,
  setPullRequestBody, deleteRemoteBranch,
  defaultBranchOf, commitsOnBranch, pushBranch, hasUnpushedWork,
}

// How many trailing pane lines the two pane classifiers are allowed to see.
const PANE_TAIL_LINES = 20

// The pane is UNTRUSTED TEXT. The harness template passes the ticket body as
// argv, so the harness renders attacker-controlled issue text into the very
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
//      to a human, rather than to kill a healthy agent.
export function paneTail(pane, lines = PANE_TAIL_LINES) {
  const rows = String(pane ?? '').split('\n')
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop()
  return rows.slice(-lines).join('\n')
}

export function textCarriesLimitPhrase(...parts) {
  return carriesLimitPhrase(parts.filter(Boolean).join('\n'))
}

// The exit marker the spawn wrapper echoes when the harness command ends
// (#169). A NONCE per spawn, not a fixed string, for the same reason the
// limit parse needs promptCarriesLimitText: the pane renders attacker-
// controlled ticket text, and a fixed marker would let a body spell out
// "the agent exited" and stop a healthy agent's watchdog. Nothing outside
// this process knows the nonce, so the line can only come from the wrapper.
// Quote-free by construction — tmux.newSession asserts that again.
export function newExitMarker() {
  return `curia-exit-${crypto.randomBytes(6).toString('hex')}`
}

// The status the marker line carries, or null while the command still runs.
export function parseExitMarker(tail, marker) {
  if (!marker) return null
  const m = new RegExp(`${marker} (\\d+)`).exec(String(tail ?? ''))
  return m ? Number(m[1]) : null
}

// The last few pane lines above the exit marker — what the operator needs to
// see, quoted into the notify so the CAUSE arrives with the failure instead of
// waiting behind an `/attach`. The text is untrusted (see paneTail), so strip
// backticks: the message wraps it in a code fence, and a body carrying one
// would otherwise break out of it. Bounded in both lines and characters.
const EXCERPT_LINES = 4
const EXCERPT_CHARS = 400
export function paneExcerpt(tail, marker) {
  let rows = String(tail ?? '').split('\n')
  if (marker) {
    const at = rows.findIndex((r) => r.includes(marker))
    if (at >= 0) rows = rows.slice(0, at)
  }
  const kept = rows.map((r) => r.replace(/`/g, "'").trimEnd()).filter((r) => r.trim())
  return kept.slice(-EXCERPT_LINES).join('\n').slice(-EXCERPT_CHARS)
}

// Agents name their ticket in whatever shape the model prefers — `66`, `#66`,
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
  constructor({ config, routing, store, notify, openConfirm, lapseEscalation, confirmNote, overseerNote, askReview, cancelEscalation, threads, log = console.log, cooling, dataDir, daemonPort, previews, attachLinks, channelName, deps }) {
    this.config = config
    this.routing = routing
    this.store = store
    this.notify = notify
    this.openConfirm = openConfirm ?? (() => null)
    this.lapseEscalation = lapseEscalation ?? ((id, reason) => this.store.lapse?.(id, reason))
    this.confirmNote = confirmNote ?? (() => {})
    this.overseerNote = overseerNote ?? (() => {})
    // askReview(agent, ticket, promptText) → { text, status } — the review gate
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
    this.threads = threads ?? { bind: async () => ({ ok: true }), release: async () => {}, cancelled: async () => {} }
    this.log = log
    this.cooling = cooling ?? new Cooling()
    this.dataDir = dataDir
    this.daemonPort = daemonPort
    // Preview registry (#40) — optional so tests and any preview-less
    // deployment construct a Dispatcher unchanged. Every call site guards.
    this.previews = previews ?? null
    // attachLinks(ticket) → [{label, url}, …] link buttons (#118
    // item 7): the ready message hands out both links by default, so nobody
    // types /attach to see what just started. Optional; absent, the ready
    // message falls back to naming the verb.
    this.attachLinks = attachLinks ?? null
    // The command channel's own name (#218). A confirm typed outside any thread
    // renders in that channel, and the reply has to name it.
    this.channelName = channelName ?? 'curia'
    this.deps = { ...DEFAULT_DEPS, ...deps }
    this.root = config.dispatch.workspace_root
    this.agents = new Map() // session -> agent record (disposable cache)
    this.inFlight = new Set() // admission guard: sessions mid-start, pre-spawn
    // Teardowns this dispatcher ordered (#138). killSession is wrapped so
    // EVERY ordered kill — cancel, finish, limit respawn, orphan sweep —
    // registers before the tmux call, and the liveness sweep can tell an
    // expected absence from a death. newSession is wrapped for the inverse:
    // a fresh spawn under the same name is a new life, and a stale entry here
    // would blind the sweep to that successor's real death forever.
    this.orderedKills = new Set()
    const realKill = this.deps.killSession
    const realSpawn = this.deps.newSession
    // Killing the pane usually takes the container with it (the `docker run`
    // client forwards the signal), but a client killed outright leaves it
    // running — see stopContainer. Every ordered teardown goes through here —
    // cancel, finish, the limit respawn, the orphan sweep — so one removal
    // covers all four, and a box running no containers pays one idempotent
    // "no such container" per kill.
    this.deps.killSession = async (name) => {
      this.orderedKills.add(name)
      if (this.config.sandbox) {
        await this.deps.stopContainer(name).catch((e) => this.log(`container teardown for ${name} failed:`, e.message))
      }
      return realKill(name)
    }
    this.deps.newSession = (opts) => { this.orderedKills.delete(opts.name); return realSpawn(opts) }
    // Captured cross-check verdicts (#164), ticket -> record. A cache like the
    // agents map: `data/verdicts/<ticket>.json` is what survives a restart, and
    // verdictFor() reads it back. The return path (#165) takes it from here.
    this.verdicts = new Map()
    // Builders parked at the gate waiting for a verdict (#165), ticket ->
    // { agent, resolve }. Process-scoped on purpose: the thing waiting is a live
    // MCP call, and a daemon restart kills the call before it kills this map.
    this.reviewWaits = new Map()
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
    // Map membership rides every item (#120): the tickets view groups by map,
    // and the overseer resolves "the <topic> map" against these headers instead
    // of flattening a map-shaped request to repo granularity (#108 item 9).
    const index = new Map()
    for (const [m, items] of Object.entries(mapItems)) {
      for (const item of items) index.set(item.number, { item, map: Number(m) })
    }
    for (const item of flatItems) index.set(item.number, { item, map: null })
    const mapTitle = new Map(maps.map((m) => [m.number, m.title]))
    return {
      repo: entry.repo,
      lane,
      numbers,
      agentOnly: await this.#agentOnlyCount(entry.repo, lane, mapItems, numbers),
      items: numbers.map((n) => {
        const e = index.get(n)
        return {
          number: n,
          title: e?.item?.title ?? '',
          labels: (e?.item?.labels ?? []).map((l) => l.name),
          map: e?.map ?? null,
          mapTitle: e?.map != null ? mapTitle.get(e.map) ?? '' : '',
        }
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
          if (this.agents.has(session) || this.inFlight.has(session)) continue
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
  async start(ticketArg, { repo, model, instruction = null, by, reuse = false, threadId = null } = {}) {
    const n = String(ticketArg)
    const session = `curia-${n}`
    // Admission guard: synchronous check + insert BEFORE the first await, so a
    // second /start, POST /command, or auto-poll tick interleaving during the
    // gh round-trips is refused as "already starting".
    if (this.inFlight.has(session)) return `⚙️ \`${session}\` is already starting`
    // `start` never confirms (#89): every anomaly below refuses with the way
    // out, instead of parking a destructive override behind a confirm. The
    // teardown path is `cancel` — which carries its own guard.
    if (this.agents.has(session)) {
      const w = this.agents.get(session)
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
      // An instruction rides a MAP dispatch and nothing else (#160/#149). A
      // ticket agent's brief is its ticket body, which a human wrote and other
      // sessions can read — an operator sentence that only exists in one spawn
      // prompt would steer the work with no durable record of it. Refuse rather
      // than drop it silently, and name where the sentence does belong.
      //
      // `!reuse` scopes it to an instruction a human actually typed. A resume
      // carries the previous dispatch's instruction forward from the journal,
      // and a map that has lost its label since then must degrade to an ordinary
      // dispatch — not refuse a verb the operator typed no instruction on. The
      // stale sentence is dropped rather than used: writePrompt renders one only
      // on a charting dispatch.
      if (instruction && !reuse && !hasLabel(issue, MAP_LABEL)) {
        return `❌ ${theRepo}#${n} is not a \`${MAP_LABEL}\` issue, and an instruction rides a map dispatch only — put it in the ticket body, or send it as a note in the ticket's thread once the agent is up`
      }
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
      return (await this.#dispatch(theRepo, n, issue, { model, instruction, by, reuse, threadId })) ?? this.#exhaustedReply()
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
  async #dispatch(repo, n, issue, { model, instruction = null, by, reuse = false, threadId = null }) {
    const session = `curia-${n}`
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    // The type label, read once and used twice: it names the thread (#93) and
    // it reaches the agent prompt (#49 decision 2). One read, so the thread a
    // human reads and the prompt the agent reads can never say different kinds.
    const typeLabel = labels.find((l) => l.startsWith('wayfinder:')) ?? null
    // A map dispatch (#160). `wayfinder:map` is a type label like any other for
    // ROUTING — resolveModel reads `defaults.map` off the same loop — and unlike
    // any other for everything downstream of it: the prompt, the ending, the
    // tools curia will answer, and what report_result does.
    const charting = typeLabel === MAP_LABEL
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

    // The harness belongs to the model actually being SPAWNED, not the one that
    // was asked for. Those differ whenever the requested model is cooling and
    // the chain fell through to the next candidate — which under #39 can cross
    // providers, and so can cross harnesses. Reading it off `modelName` was
    // invisible while every model was a claude one; with a codex harness it would
    // seed a claude config dir and then spawn codex into it.
    //
    // Nothing overrides it any more (#177). An operator pin could only ever
    // agree with this line or contradict it, and a contradiction spawned
    // `codex --model opus` — not a model. The fallback chain is why the pin
    // could not be judged at parse time either: the model spawned here is not
    // always the model typed. `review` reads its harness the same way.
    const useModel = cands[0]
    const harnessName = this.routing.models[useModel].harness
    if (!this.routing.harnesses[harnessName]) {
      return `❌ unknown harness \`${harnessName}\` — configured harnesses: ${Object.keys(this.routing.harnesses).join(', ')}`
    }

    const login = await this.deps.viewerLogin()
    // The claim on a MAP is not a claim on a ticket — nothing takes a map off a
    // frontier, because a map is never on one. What it buys is the serialisation
    // the map body needs: `start`'s own "already assigned" anomaly refuses a
    // second charting agent on the same map, and #withMapLock cannot help here
    // because the agent, not the daemon, does the writing.
    await this.deps.claim(repo, n, login)
    this.store.logEvent('dispatch_claimed', { repo, ticket: n, agent: session, by: by ?? 'unknown', kind: charting ? 'charting' : 'ticket' })

    // The ticket label goes on at the claim (#93): `start` binds the thread it
    // ran in, an autonomous dispatch opens and binds a fresh one — so every
    // notify from here on lands in the labeled thread. Never fatal: with the
    // bridge down the first notify binds lazily instead.
    try {
      await this.threads.bind(n, { threadId, type: typeLabel?.slice('wayfinder:'.length) ?? '' })
    } catch (e) {
      this.log(`thread bind for ${repo}#${n} failed (${e.message}) — the first notify will bind lazily`)
    }

    const cfgDir = cfgDirFor(this.root, session)
    try {
      // every caller resolves the issue through #resolveRepo → fetchIssue, so
      // the body is always present
      const full = issue
      // Two workspace shapes since #156, picked by the harness's sandbox mode:
      // a worktree cut from the shared base clone for a bare pane, a private
      // blobless clone for a container. A container cannot use a worktree — its
      // `.git` is a file pointing into a base clone the container cannot see.
      const sandbox = this.#sandboxFor(harnessName)
      const surviving = worktreePathFor(this.root, repo, n)
      const inherited = reuse && fs.existsSync(surviving)
      let wtPath
      if (sandbox) {
        if (inherited && !isPrivateClone(surviving)) {
          throw new Error(`${surviving} is a worktree of the shared base clone, and a container cannot use one — this ticket was last dispatched on the bare path. \`cancel ${n}\` first (that removes the worktree), or dispatch it on a harness with \`sandbox: none\``)
        }
        wtPath = inherited ? surviving : await this.deps.createPrivateClone(this.root, repo, n)
      } else {
        const base = await this.deps.ensureBaseClone(this.root, repo)
        wtPath = inherited ? surviving : await this.deps.createWorktree(base, n)
      }
      const view = this.#viewFor(sandbox, wtPath, cfgDir)
      // A charting agent's map is the issue in hand. Naming it as the map (and
      // not asking #mapNumberFor for a parent) is what puts the `/wayfinder`
      // line on the prompt and arms #assertTracker: a charting agent without
      // the tracker doc is exactly the agent that would chart into `.scratch/`.
      const mapNumber = charting ? Number(n) : await this.#mapNumberFor(repo, full)
      this.#assertTracker(repo, n, session, wtPath, mapNumber)
      this.#assertNoPlantedConfig(wtPath, harnessName)
      this.#armAgent({ session, ticket: n, harness: harnessName, model: useModel, wtPath, cfgDir, view, sandbox })
      // #157: the prompt NAMES the published ports, so they are allocated before
      // it is written and handed to the container after. The allocation is a
      // bind probe and a set lookup — nothing is held until `docker run`, so a
      // failure between here and the spawn leaks no port.
      const ports = sandbox ? await this.#allocatePorts(sandbox) : null
      // The type label reaches the prompt (#49 decision 2): it is the only thing
      // that stops a dispatched `wayfinder:grilling` agent from standing in for
      // the human's side of its own ticket.
      const promptFile = this.deps.writePrompt(cfgDir, full, {
        repo, wtPath: view.wt, mapNumber, type: typeLabel, charting, instruction, ports,
      })
      fs.rmSync(path.join(this.dataDir, 'results', `${session}.json`), { force: true })

      const plan = await this.#spawnPlan({
        session, ticket: n, repo, harness: harnessName, model: useModel,
        wtPath, cfgDir, promptFile, view, sandbox, ports,
      })
      const container = plan.container
      const exitMarker = newExitMarker()
      await this.deps.newSession({ name: session, cwd: wtPath, env: plan.env, shellCmd: plan.shellCmd, exitMarker })
      // The instance id (#94): what a button confirm binds to. Unique per
      // DISPATCH, not per ticket, so a confirm can never outlive the agent
      // the operator read about and hit its successor.
      const instance = `${session}@${Date.now()}`
      this.store.logEvent('agent_spawned', {
        repo, ticket: n, agent: session, instance, model: useModel, harness: harnessName,
        kind: charting ? 'charting' : 'ticket', instruction: charting ? instruction : null,
        // The journal is the state home for what a restart cannot re-derive
        // from tmux: which image this agent runs and which ports it published.
        ...(container ? { sandbox: 'docker', image: container.image, ports: container.ports } : {}),
      })

      const agent = {
        repo, ticket: n, title: full.title, session, instance, wtPath, cfgDir, promptFile,
        model: useModel, requestedModel: modelName, harness: harnessName,
        provider: this.routing.models[useModel].provider,
        // #156: null for a bare pane, the published loopback ports for a
        // container. #157 hands them to `publish_preview` as its port bound.
        ports: container?.ports ?? null,
        sandbox: container ? 'docker' : null,
        // which view the prompt on disk was written in (#156) — a respawn that
        // crosses the sandbox boundary has to write it again
        promptView: view.wt,
        spawnedAt: Date.now(), state: 'spawning', resultReceived: false,
        // #160: which ending this agent is held to, and what the operator
        // asked for. Journalled beside it (agent_spawned above) so a daemon
        // restart re-derives both — see #epochCharting.
        charting, instruction: charting ? instruction : null,
        // this spawn's exit marker (#169) — the watchdog's fail-fast signal
        exitMarker,
        // this ticket's own text can forge the usage-limit signal ⇒ the
        // watchdog must not act on it (see paneTail)
        promptCarriesLimitText: textCarriesLimitPhrase(full.title, full.body),
      }
      this.agents.set(session, agent)
      this.#watchdog(agent).catch((e) => this.log(`watchdog ${session} failed:`, e.message))
      if (charting) {
        return `⚙️ charting agent on map ${repo}#${n} → \`${session}\` on **${useModel}**${instruction ? '' : ' — no instruction rode this dispatch, so it will ask what should change'} — watching for readiness`
      }
      return `⚙️ dispatched ${repo}#${n} → \`${session}\` on **${useModel}** — watching for readiness`
    } catch (e) {
      this.agents.delete(session)
      // No tmux session ever existed here, so no sweep would ever collect the
      // dir — remove it whole (no agent ran; there is nothing to post-mortem)
      this.deps.removeConfigDir(cfgDir)
      this.deps.forgetAgentToken(this.dataDir, session)
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
        this.store.logEvent('dispatch_unclaimed', { repo, ticket: n, agent: session, reason: e.message })
      } catch (unclaimErr) {
        this.store.logEvent('unclaim_failed', { repo, ticket: n, agent: session, reason: e.message, error: unclaimErr.message })
      }
      // The binding stays (#140): a failed dispatch is a claim release, not a
      // ticket-terminal state — the retry's traffic belongs in the same thread.
      return `⚠️ dispatch of ${repo}#${n} failed before the agent could run: ${e.message} — ${released ? 'claim released' : 'claim release FAILED: the issue is still assigned to the bot; reconcile will retry'}`
    }
  }

  // The sandbox settings for a harness, or null when it runs the bare pane
  // (#156). The switch is per harness and ships off (#148's rollout: claude
  // first, codex after the soak at #158), so this is what every sandbox branch
  // in this file keys on.
  #sandboxFor(harness) {
    if (this.routing.harnesses?.[harness]?.sandbox !== 'docker') return null
    if (!this.config.sandbox) {
      throw new Error(`harness "${harness}" is set to \`sandbox: docker\`, but config/curia.yaml carries no \`sandbox:\` section — there is no image to run`)
    }
    return this.config.sandbox
  }

  // What the AGENT calls its two directories, and how it reaches the daemon
  // (#156). Identical to the host paths outside a container; the mount points
  // and the docker host gateway inside one.
  #viewFor(sandbox, wtPath, cfgDir) {
    return sandbox
      ? { wt: GUEST_WT, cfg: GUEST_CFG, daemonHost: GUEST_DAEMON_HOST }
      : { wt: wtPath, cfg: cfgDir, daemonHost: '127.0.0.1' }
  }

  // Seed the config dir and write the connection settings, in the agent's own view of the
  // paths. Shared by the first dispatch and by the cross-harness respawn a
  // usage limit forces — those two used to differ by omission, and a sandbox
  // mode that changes with the harness is exactly where that costs.
  #armAgent({ session, ticket, harness, model, wtPath, cfgDir, view, sandbox = null }) {
    this.deps.seedConfigDir(cfgDir, view.wt, this.config.skills, harness, { sandboxed: Boolean(sandbox) })
    // A FRESH secret per arm (#159), minted before the connection settings that carry it.
    // The cross-harness respawn arms again, so the pane a usage limit killed
    // stops being able to speak for this name the moment its successor is armed.
    const token = this.deps.mintAgentToken(this.dataDir, session)
    this.deps.writeConnectionSettings({
      wtPath: view.wt, hostWtPath: wtPath, cfgDir, agent: session, ticket,
      daemonPort: this.daemonPort, daemonHost: view.daemonHost, token,
      harness, reasoningEffort: this.routing.models[model].reasoning_effort ?? null,
    })
  }

  // What tmux is asked to run, and in what environment. A sandboxed harness
  // gets a `docker run` line and an EMPTY pane environment: the container
  // carries its own through `--env-file`, and a pane env would put every value
  // of it in `ps` — the cost #155 measured and asked this ticket not to repeat.
  async #spawnPlan({ session, ticket, repo, harness, model, wtPath, cfgDir, promptFile, view, sandbox, ports }) {
    const harnessCmd = buildSpawnCmd(this.routing, harness, model, path.join(view.cfg, path.basename(promptFile)))
    if (!sandbox) {
      return { container: null, shellCmd: harnessCmd, env: agentEnv(cfgDir, harness, { repo }) }
    }
    const container = await this.#prepareContainer({
      session, ticket, repo, harness, wtPath, cfgDir, spawnCmd: harnessCmd, sandbox, ports,
    })
    return { container, shellCmd: container.shellCmd, env: {} }
  }

  // Ports already handed to LIVE agents, so two dispatches landing together
  // cannot publish the same host port. Everything else on the box is caught by
  // the bind probe inside allocatePorts.
  #allocatePorts(sandbox) {
    const taken = [...this.agents.values()].flatMap((w) => w.ports ?? [])
    return this.deps.allocatePorts(sandbox.ports, { count: PORTS_PER_AGENT, taken })
  }

  // Everything a container needs before the pane can start it: the image and
  // the environment file. The ports arrive already allocated, because the prompt
  // names them and is written first (#157). Every step here can fail, and all of
  // them run inside #dispatch's try — so a failure unclaims the ticket rather
  // than leaving it assigned to an agent that never ran.
  async #prepareContainer({ session, ticket, repo, harness, wtPath, cfgDir, spawnCmd, sandbox, ports }) {
    // Built on demand rather than at boot: the tag is a content address, so a
    // pinned version bump or a Dockerfile edit names an image the box does not
    // have, and this is the first place that matters (#154).
    //
    // A cold build takes about four minutes, and it runs INSIDE the dispatch —
    // so the thread is told, once, rather than going quiet between the claim
    // and the spawn. `npm run build-agent-image` ahead of a bump keeps the
    // dispatch path warm.
    let said = false
    const image = await this.deps.ensureAgentImage(sandbox, {
      onLine: (line) => {
        if (!said) {
          said = true
          this.notify(ticket, `🧱 building the agent image — the first dispatch after a pin or Dockerfile change waits for it (about four minutes)`)
        }
        this.log(`[image ${session}] ${line}`)
      },
    })
    if (image.built) {
      this.store.logEvent('agent_image_built', { agent: session, ticket, image: image.ref })
      this.log(`built the agent image ${image.ref} for ${session}`)
    }
    // The side channel, before the agent rather than after it (#188). This is
    // the LAST thing checked and the first thing an agent needs: `ask_human`,
    // the Stop hook and every curia tool ride it, so a container started without
    // it runs blind — it claims the ticket, edits its worktree, and cannot say
    // one word to anyone. `curia-179` did exactly that.
    //
    // It sits after the image because the probe is a container and needs one,
    // and because a box whose image has to build first would otherwise be
    // refused on a fault the build might outlast. Failing here unclaims the
    // ticket through #dispatch's own catch, so the refusal costs nothing.
    try {
      const gateway = await this.deps.assertSideChannel(image.ref)
      this.store.logEvent('side_channel_ready', { agent: session, ticket, gateway })
    } catch (e) {
      throw new Error(`refusing to start a sandboxed agent for #${ticket}: ${e.message}. An agent in a container with no side channel cannot reach ask_human, the Stop hook, or any curia tool`)
    }
    const envFile = writeEnvFile(path.join(cfgDir, ENV_FILE), {
      ...agentEnv(GUEST_CFG, harness, { repo, sandboxed: true }),
      ...modelCredential(harness),
      // The container's own HOME. `--user <uid>` bypasses the image's USER, and
      // git and both CLIs write there; an unset HOME lands them in `/`, which
      // the agent cannot write.
      HOME: '/home/agent',
      TERM: 'xterm-256color',
    })
    const shellCmd = dockerRunCmd({
      name: session, ticket, image: image.ref, cfgDir, wtPath, envFile, spawnCmd, ports, sandbox,
    })
    return { image: image.ref, ports, shellCmd }
  }

  // The belt behind the prompt naming the tracker (#57 step 3, #49 decision 2).
  // Throws before the config dir is seeded, so the ordinary prepare-failure
  // path unclaims and tells the operator why.
  //
  // Only work THROUGH A MAP is refused: a map child, or since #160 a charting
  // agent on the map itself. Those are the agents that invoke the wayfinder
  // skill, and whose writes the fallback would silently send to `.scratch/`
  // instead of GitHub. A plain ready-for-agent ticket invokes no such skill,
  // and #10 watches ANY plain repo through the flat lane — refusing those for a
  // missing doc would take that lane away. It gets a journal line instead, so
  // the absence is on the record either way.
  #assertTracker(repo, n, session, wtPath, mapNumber) {
    if (fs.existsSync(path.join(wtPath, TRACKER_DOC))) return
    if (mapNumber) {
      const what = String(mapNumber) === String(n) ? `map #${n}` : `map child #${n}`
      throw new Error(`${repo} has no ${TRACKER_DOC}, so an agent on ${what} would fall back to the local-markdown tracker and write .scratch/ files instead of resolving on GitHub — run \`/setup-matt-pocock-skills\` in ${repo} first`)
    }
    this.store.logEvent('tracker_doc_missing', { repo, ticket: n, agent: session })
  }

  // Refuse before the config dir is seeded, so the ordinary prepare-failure path
  // unclaims and tells the operator why. See untrustedProjectConfig: each harness
  // loads one repo-carried config file without a prompt (codex under its
  // hook-trust bypass flag, claude by merging settings.local.json over the
  // settings curia writes), and hooks in it would run with no model in the loop.
  //
  // #174: the dispatch is not the only spawn. The check is per HARNESS — one
  // repo file exposes one harness — so it clears only the lane it ran against,
  // and #respawnOn changes that lane. It runs there too, against the NEXT
  // harness, which is what closes the hole: a claude dispatch in a repo carrying
  // `.codex/hooks.json` passes here, and the cap-hit fallback to the codex lane
  // would otherwise spawn codex over that file under its hook-trust bypass.
  // `where` only picks the way out, because the two paths offer different ones:
  // at dispatch the operator can name another harness, and on a fallback they
  // cannot — the lane they came from is the cooling one.
  #assertNoPlantedConfig(wtPath, harnessName, where = 'dispatch') {
    const planted = untrustedProjectConfig(wtPath, harnessName)
    if (!planted) return
    const wayOut = where === 'respawn'
      ? 'The harness this agent was dispatched on does not load it, and the fallback harness does. Remove the file from the repo, or dispatch the ticket again once a harness that does not load it is warm'
      : 'Remove the file from the repo, or dispatch on another harness if only one harness loads it (`/start <ticket> <model>`)'
    throw new Error(`${planted} is a config file curia did not write, and the ${harnessName} harness loads it with no prompt — hooks in it would run unreviewed, with no model in the loop. ${wayOut}`)
  }

  // Which wayfinder map, if any, owns this ticket — so the standing orders can
  // name the map the agent must append its Decisions-so-far line to (#41).
  // Derived from the issue's own `parent_issue_url`, never stored: the same
  // lookup runs again at resolve time. A parent that is not labelled
  // `wayfinder:map` (an ordinary nested sub-issue) yields null, and so does any
  // failed read — the flat shape of the protocol is the safe default, because
  // it asks the agent for one thing less rather than one thing wrong.
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
  // live agent died, exhaustion landed inside a latched window, and nothing
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

  // ---- the cross-check (#164, ADR-0010) -----------------------------------------

  // Spawn a reviewer on the other provider and let it read the diff.
  //
  // This is the ENGINE half. ADR-0010 puts the press on the review gate as a
  // third button, and that button is #165's; what is here is the daemon-side
  // entry point behind it — `review <n>` on the command seam — so the engine can
  // be proven before the surface exists.
  //
  // It claims nothing. The builder holds the ticket's only claim, and it is
  // still alive: a cross-check adds a second agent, it does not replace the
  // first. Both count against `max_concurrent`, which is the cost ADR-0010
  // names.
  async crossCheck(n, { repo, model, by } = {}) {
    const ticket = String(n)
    const session = reviewSessionFor(ticket)
    const builderSession = `curia-${ticket}`
    // Same synchronous admission guard `start` uses, and for the same reason: a
    // second press landing during the gh round-trips below would otherwise
    // prepare a second checkout over the first one's directory.
    if (this.inFlight.has(session)) return `⚙️ \`${session}\` is already starting`
    if (this.agents.has(session)) {
      return `🔎 \`${session}\` is already reading #${ticket} — \`cancel ${ticket}\` tears it down with the builder`
    }
    this.inFlight.add(session)
    try {
      if (await this.deps.hasSession(session)) {
        return `⚠️ tmux session \`${session}\` is already live but untracked — \`cancel ${ticket}\` tears it down, then ask again`
      }
      const builder = this.agents.get(builderSession)
      const theRepo = repo ?? builder?.repo ?? this.#epochRepo(ticket)
      if (!theRepo) return `❌ curia cannot tell which repo #${ticket} belongs to — nothing was spawned`

      // What the builder ran on decides which provider is the other one, so a
      // cross-check with no answer here is not a cross-check at all. The record
      // answers while the builder lives; the journal answers after a restart.
      const builderModel = builder?.model ?? this.#epochSpawn(this.#readJournal(), builderSession)?.model ?? null
      if (!builderModel) {
        return `❌ curia has no record of what #${ticket} was built on, so it cannot tell which provider is the other one — nothing was spawned`
      }

      let issue
      try {
        issue = await this.deps.fetchIssue(theRepo, ticket)
      } catch (e) {
        return `❌ could not read ${theRepo}#${ticket} (${e.message}) — nothing was spawned`
      }
      const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))

      let useModel
      let sameProvider
      try {
        // `model=` on the command beats the label, which beats the table — the
        // same precedence resolveModel gives a dispatch.
        ;({ model: useModel, sameProvider } = model
          ? { model, sameProvider: this.routing.models[model]?.provider === this.routing.models[builderModel].provider }
          : resolveReviewer(this.routing, { builderModel, labels, cooling: this.cooling }))
      } catch (e) {
        return `❌ no cross-check for ${theRepo}#${ticket}: ${e.message}`
      }
      if (!this.routing.models[useModel]) {
        return `❌ unknown model \`${useModel}\` — configured models: ${Object.keys(this.routing.models).join(', ')}`
      }

      // The reviewer reads the PUSHED tip, so work that exists only in the
      // builder's worktree would make the verdict a reading of a different diff
      // than the one the operator is looking at. Refuse rather than review the
      // wrong thing — and refuse on "cannot tell" too, the evidence rule the
      // rest of this file runs on.
      const guard = await this.#assertBuilderPushed(theRepo, ticket, builder)
      if (guard) return guard

      const harnessName = this.routing.models[useModel].harness
      if (!this.routing.harnesses[harnessName]) {
        return `❌ unknown harness \`${harnessName}\` — configured harnesses: ${Object.keys(this.routing.harnesses).join(', ')}`
      }
      return await this.#spawnReviewer({
        session, ticket, repo: theRepo, issue, model: useModel, builderModel,
        harnessName, sameProvider, by,
      })
    } finally {
      this.inFlight.delete(session)
    }
  }

  // Does the builder hold commits that origin has never seen? Returns a refusal
  // string, or null when the pushed tip is the whole story. A builder whose
  // workspace is gone (a restart, a finished agent) states nothing either way,
  // and origin is then the only tip there is.
  async #assertBuilderPushed(repo, ticket, builder) {
    const wtPath = builder?.wtPath ?? worktreePathFor(this.root, repo, ticket)
    if (!fs.existsSync(wtPath)) return null
    try {
      const unpushed = await this.deps.hasUnpushedWork(wtPath, branchFor(ticket), await this.deps.defaultBranchOf(wtPath))
      if (!unpushed) return null
      return `❌ #${ticket} holds commits that are on no remote, and a reviewer reads the PUSHED tip — the verdict would be about a different diff than the pull request shows. Have the builder call \`open_pull_request\`, then ask again.`
    } catch (e) {
      return `❌ curia could not tell whether #${ticket} holds unpushed commits (${e.message}), so it cannot promise the reviewer reads the diff the pull request shows — retry, or have the builder call \`open_pull_request\` first`
    }
  }

  // Prepare and spawn the reviewer. Every step can fail, and all of them run
  // inside one try — a failure here removes the checkout and the config dir it
  // made and leaves the builder untouched, because the cross-check owns nothing
  // the ticket depends on.
  async #spawnReviewer({ session, ticket, repo, issue, model, builderModel, harnessName, sameProvider, by }) {
    const cfgDir = cfgDirFor(this.root, session)
    let checkout = null
    try {
      const sandbox = this.#sandboxFor(harnessName)
      checkout = await this.deps.createReviewCheckout(this.root, repo, ticket, { sandbox: Boolean(sandbox) })
      const view = this.#viewFor(sandbox, checkout.path, cfgDir)
      this.#assertNoPlantedConfig(checkout.path, harnessName)
      this.#armAgent({ session, ticket, harness: harnessName, model, wtPath: checkout.path, cfgDir, view, sandbox })
      // No published ports: a reviewer starts no dev server, and
      // `publish_preview` is one of the four tools curia refuses it. Three
      // ports per reviewer would be three ports a builder could not have.
      const promptFile = this.deps.writeReviewPrompt(cfgDir, issue, {
        repo, wtPath: view.wt, branch: checkout.branch, baseBranch: checkout.baseBranch,
        sha: checkout.sha, model: spawnModelId(this.routing, model),
        builderModel: spawnModelId(this.routing, builderModel),
      })
      fs.rmSync(path.join(this.dataDir, 'results', `${session}.json`), { force: true })

      const plan = await this.#spawnPlan({
        session, ticket, repo, harness: harnessName, model,
        wtPath: checkout.path, cfgDir, promptFile, view, sandbox, ports: [],
      })
      const exitMarker = newExitMarker()
      await this.deps.newSession({ name: session, cwd: checkout.path, env: plan.env, shellCmd: plan.shellCmd, exitMarker })

      // `reviewer_spawned` carries everything a restarted daemon needs to adopt
      // this session and still capture its verdict — the journal is the state
      // home for exactly what tmux cannot re-derive (#reconcileReviewers).
      this.store.logEvent('reviewer_spawned', {
        repo, ticket, agent: session, builder: `curia-${ticket}`, model, harness: harnessName,
        builder_model: builderModel, same_provider: sameProvider, sha: checkout.sha,
        checkout: checkout.path, base_branch: checkout.baseBranch, by: by ?? 'unknown',
        ...(plan.container ? { sandbox: 'docker', image: plan.container.image } : {}),
      })
      // `agent_spawned` too, and deliberately: the status line, the timeline and
      // every surface that draws an agent read that event. A reviewer with its
      // own status line in the ticket thread is what ADR-0010 asks for, and this
      // is the one event that gives it one.
      this.store.logEvent('agent_spawned', {
        repo, ticket, agent: session, model, harness: harnessName, kind: 'reviewer',
      })

      const agent = {
        repo, ticket, title: issue.title, session, instance: `${session}@${Date.now()}`,
        wtPath: checkout.path, cfgDir, promptFile,
        model, requestedModel: model, harness: harnessName,
        provider: this.routing.models[model].provider,
        ports: null, sandbox: plan.container ? 'docker' : null,
        promptView: view.wt,
        spawnedAt: Date.now(), state: 'spawning', resultReceived: false,
        // What makes every refusal and every terminal branch below read this as
        // a reviewer rather than as a ticket agent.
        reviewer: true, builderModel, sameProvider, sha: checkout.sha, baseBranch: checkout.baseBranch,
        exitMarker,
        promptCarriesLimitText: textCarriesLimitPhrase(issue.title, issue.body),
      }
      this.agents.set(session, agent)
      this.#watchdog(agent).catch((e) => this.log(`watchdog ${session} failed:`, e.message))
      const named = spawnModelId(this.routing, model)
      const note = sameProvider ? ` — **${SAME_PROVIDER_STAMP}**, so this is the weaker check` : ''
      return `🔎 cross-checking ${repo}#${ticket} → \`${session}\` on **${named}**${note} — it reads \`${checkout.sha.slice(0, 12)}\` and writes nothing`
    } catch (e) {
      this.agents.delete(session)
      this.deps.removeConfigDir(cfgDir)
      this.deps.forgetAgentToken(this.dataDir, session)
      if (checkout) await this.#removeReviewCheckout(repo, ticket, checkout.path)
      this.store.logEvent('reviewer_spawn_failed', { repo, ticket, agent: session, error: e.message })
      return `⚠️ the cross-check of ${repo}#${ticket} could not start: ${e.message} — the builder is untouched`
    }
  }

  // Is this agent the cross-check reviewer? The NAME is the authority, not the
  // record: a daemon restart empties the agents map, and a reviewer whose record
  // is missing must still be refused every write tool rather than falling
  // through to the builder's path with the builder's ticket in hand.
  #isReviewer(agentName) {
    return REVIEW_SESSION_RE.test(String(agentName ?? ''))
  }

  // The refusal a reviewer gets for every tool but `notify` and `report_result`.
  // Returns null for anyone else, so a caller can put one line in front of a
  // tool and change nothing for a builder. index.mjs uses it for `ask_human`
  // and `publish_preview`; the two that push and gate check it themselves.
  toolRefusal(agentName, tool) {
    if (!this.#isReviewer(agentName)) return null
    const w = this.agents.get(agentName)
    const ticket = w?.ticket ?? String(agentName).match(REVIEW_SESSION_RE)?.[1] ?? '?'
    const where = w?.repo ? `${w.repo}#${ticket}` : `#${ticket}`
    this.store.logEvent('reviewer_tool_refused', { repo: w?.repo, ticket, agent: agentName, tool })
    return `❌ \`${agentName}\` is the CROSS-CHECK REVIEWER on ${where}, and \`${tool}\` is not yours. A reviewer writes nothing: no tracker write, no push, no merge, no gate, no preview, no question. Read the diff, the ticket and the checkout, run the tests, then call report_result with your verdict — a doubt you cannot settle belongs IN the verdict.`
  }

  // The reviewer session live on a ticket, if any (#164). The attach reply and
  // the return path (#165) ask this rather than guessing at the name.
  reviewerSession(ticket) {
    const session = reviewSessionFor(ticket)
    return this.agents.has(session) ? session : null
  }

  // The captured verdict for a ticket. Memory first, then the artifact on disk,
  // so a restart between the reviewer's last word and the return path costs
  // nothing.
  verdictFor(ticket) {
    const held = this.verdicts.get(String(ticket))
    if (held) return held
    try {
      return JSON.parse(fs.readFileSync(this.#verdictFile(ticket), 'utf8'))
    } catch {
      return null
    }
  }

  #verdictFile(ticket) {
    return path.join(this.dataDir, 'verdicts', `${ticket}.json`)
  }

  // What the reviewer's `report_result` produces: one artifact the daemon holds,
  // ready for the return path (#165). Nothing is posted to the tracker here —
  // ADR-0010 puts the pull-request comment on the return path, beside the
  // builder's judgement of the same text.
  //
  // The same-provider stamp is written HERE, at the top of the verdict, and by
  // curia rather than by the reviewer: which provider a model ran on is curia's
  // own record of what it spawned, and a reviewer's account of it would be one
  // more thing to trust.
  async #captureVerdict(agentName, result, w) {
    const journal = this.#readJournal()
    let spawn = null
    for (const ev of journal) {
      if (ev.type === 'reviewer_spawned' && ev.agent === agentName) spawn = ev
    }
    const ticket = String(w?.ticket ?? spawn?.ticket ?? String(agentName).match(REVIEW_SESSION_RE)?.[1] ?? '')
    const repo = w?.repo ?? spawn?.repo ?? null
    if (!ticket) {
      this.store.logEvent('verdict_skipped', { agent: agentName, reason: 'no ticket is bound to this reviewer' })
      return 'result recorded — curia could not tell which ticket this reviewer was reading, so no verdict was captured'
    }
    const sameProvider = w?.sameProvider ?? Boolean(spawn?.same_provider)
    const text = String(result.summary ?? '').trim()
    const verdict = {
      repo,
      ticket,
      agent: agentName,
      model: w?.model ?? spawn?.model ?? null,
      builder_model: w?.builderModel ?? spawn?.builder_model ?? null,
      same_provider: sameProvider,
      sha: w?.sha ?? spawn?.sha ?? null,
      status: result.status,
      // The stamp rides IN the text, because the text is what a human and the
      // builder read. The flag beside it is for the daemon.
      verdict: sameProvider ? `**${SAME_PROVIDER_STAMP}**\n\n${text}` : text,
      details: result.details ?? null,
      at: new Date().toISOString(),
    }
    let held = true
    try {
      fs.mkdirSync(path.dirname(this.#verdictFile(ticket)), { recursive: true })
      fs.writeFileSync(this.#verdictFile(ticket), JSON.stringify(verdict, null, 2))
    } catch (e) {
      held = false
      this.log(`could not write the verdict for ${repo}#${ticket}: ${e.message}`)
    }
    this.verdicts.set(ticket, verdict)
    this.store.logEvent('verdict_captured', {
      repo, ticket, agent: agentName, model: verdict.model, status: result.status,
      same_provider: sameProvider, chars: verdict.verdict.length, on_disk: held,
    })
    const named = spawnModelId(this.routing, verdict.model ?? '')
    const stamp = sameProvider ? ` (**${SAME_PROVIDER_STAMP}**)` : ''
    this.notify(ticket, `🔎 cross-check verdict on ${repo ?? ''}#${ticket} from \`${agentName}\` on **${named}**${stamp} — curia is holding it${held ? '' : ' in memory only: the artifact could NOT be written'}`)
    // The return path (#165). It runs INSIDE the reviewer's own tool call, so a
    // failure in it must never fail the capture: the verdict is already held,
    // and a reviewer told its work failed would be told a lie about the one
    // thing it did. Every step inside reports itself on the surfaces instead.
    try {
      await this.#deliverVerdict(verdict)
    } catch (e) {
      this.store.logEvent('verdict_delivery_failed', { repo, ticket, agent: agentName, error: e.message })
      this.notify(ticket, `⚠️ the verdict on #${ticket} is captured, but curia's return path failed — ${e.message}. The builder may still be waiting at the gate.`)
    }
    return `verdict captured${held ? '' : ' in memory only — writing the artifact FAILED'}. curia has posted it on the pull request and handed it to the builder, which judges it and puts it to a human. You push nothing, resolve nothing and answer nothing further — your work here is done, so stop.`
  }

  // ---- readiness watchdog ------------------------------------------------------

  // Poll the pane every 2 s up to ready_timeout_s. Composer marker ⇒ ready;
  // usage-limit reached text ⇒ cool + next candidate; exit marker ⇒ the harness
  // command is already dead, so stop waiting for it; timeout ⇒ record and
  // surface, keep claim + session for inspection (never guess keystrokes).
  async #watchdog(agent) {
    // Resolved once, and loudly: readiness that silently never matches is #33's
    // live-only defect, and its whole symptom was silence.
    const readyRe = this.routing.harnesses[agent.harness]?.readyRe
    if (!readyRe) {
      throw new Error(`no readiness marker for harness "${agent.harness}" on ${agent.session} — refusing to watch a pane against nothing`)
    }
    const deadline = Date.now() + this.config.dispatch.ready_timeout_s * 1000
    while (Date.now() < deadline) {
      await sleep(2000)
      if (this.agents.get(agent.session) !== agent) return // cancelled/replaced
      let pane = ''
      try {
        pane = await this.deps.capturePane(agent.session)
      } catch {
        // session died before readiness — leave it to agent_done/reconcile
      }
      // tail only — for BOTH classifiers: the pane carries untrusted ticket
      // text (see paneTail), and a rendered body spelling "bypass permissions"
      // must no more forge readiness than "usage limit reached" may forge a
      // cap hit. The composer marker is a bottom-of-pane signal anyway.
      const tail = paneTail(pane)
      // The credit-gate parse rides beside the limit parse (#126): the dialog
      // holds the pane while the status footer still renders under it, so
      // checking it HERE — before the ready marker — is what stops a modal-
      // blocked spawn from reading as a healthy agent (#108 item 12).
      const limit = parseUsageLimit(tail, agent.provider) ?? parseCreditGate(tail, agent.provider)
      if (limit && agent.promptCarriesLimitText) {
        // the ticket's own text can produce this match — refuse to cool a model
        // or kill a session on it; the ready-timeout path surfaces a genuine
        // hit to a human instead
        if (!agent.limitAmbiguityLogged) {
          agent.limitAmbiguityLogged = true
          this.store.logEvent('usage_limit_ignored_ambiguous', {
            repo: agent.repo, ticket: agent.ticket, agent: agent.session, scope: limit.scope,
          })
          this.log(`watchdog ${agent.session}: usage-limit text ignored — the ticket body carries the same phrase`)
        }
      } else if (limit) {
        await this.#handleLimit(agent, limit)
        return
      }
      // The command EXITED before it ever drew a composer (#169): a missing
      // binary, a rejected flag, an instant crash. Checked before the ready
      // marker, because a dead command is not ready whatever else the pane
      // still shows. Nothing is retried here — a spawn that dies on its own
      // command line dies the same way every time, and re-running it would
      // only burn the claim. Report, and keep the session for inspection.
      const status = parseExitMarker(tail, agent.exitMarker)
      if (status !== null) {
        this.#watchdogGaveUp(agent, {
          event: 'agent_exited_early',
          data: { status, elapsed_s: Math.round((Date.now() - agent.spawnedAt) / 1000) },
          headline: `the **${agent.harness}** command exited with status ${status} before reaching a composer`,
          excerpt: paneExcerpt(tail, agent.exitMarker),
        })
        return
      }
      // Per harness (#39): the claude composer's `⏵⏵` marker never appears in a
      // codex pane, whose composer says `<model> <effort> · <cwd>`.
      if (readyRe.test(tail)) {
        agent.state = 'ready'
        // The anchor the tool-channel grace window is measured from (#194).
        agent.readyAt = Date.now()
        this.store.logEvent('agent_ready', { repo: agent.repo, ticket: agent.ticket, agent: agent.session, model: agent.model })
        // #118 item 7 / #108 item 22: both links land with readiness as
        // buttons — /attach stays as the retrieve-later verb. Fail-soft: a
        // link that cannot compose right now (surface still asserting) falls
        // back to naming the verb.
        const links = this.attachLinks
          ? await Promise.resolve(this.attachLinks(agent.ticket)).catch(() => null)
          : null
        // The MODEL, not the routing label (#179). `agent.model` is the key in
        // `routing.yaml`, so this message said `gpt` about a `gpt-5.6-sol`
        // agent. There is no transcript yet, so the name the CLI was asked for
        // is the best evidence there is.
        const named = spawnModelId(this.routing, agent.model)
        this.notify(agent.ticket, `✅ \`${agent.session}\` is at the composer on **${named}**${links ? '' : ` — \`/attach ${agent.ticket}\` to watch`}`, links ? { links } : {})
        // At the composer is not the same as able to speak (#194). The readiness
        // watch ends here and the tool-channel watch starts, on the same agent
        // record and with the marker as its anchor.
        this.#watchToolChannel(agent).catch((e) => this.log(`tool-channel watch ${agent.session} failed:`, e.message))
        return
      }
    }
    this.#watchdogGaveUp(agent, {
      event: 'agent_ready_timeout',
      data: { timeout_s: this.config.dispatch.ready_timeout_s },
      headline: `did not reach a composer within ${this.config.dispatch.ready_timeout_s}s`,
    })
  }

  // The one way out of #watchdog that keeps the session and the claim: the
  // agent failed, a human decides what happens next. Both callers land here so
  // the journal event and the message stay in step — and so the ignored-limit
  // note cannot go missing on one path (see below).
  #watchdogGaveUp(agent, { event, data, headline, excerpt = '' }) {
    agent.state = 'failed'
    this.store.logEvent(event, { repo: agent.repo, ticket: agent.ticket, agent: agent.session, ...data })
    // If an ambiguous usage-limit signal was refused above, the operator must
    // hear about it HERE — this notify is the human surface the refusal leans
    // on, and the failure headline alone gives no reason to suspect a cap hit.
    const ignored = agent.limitAmbiguityLogged
      ? ' (a usage-limit signal was seen but IGNORED because the ticket text itself carries the phrase — check the pane for a real cap hit)'
      : ''
    // The pane excerpt is what turns "it failed" into "it failed BECAUSE": the
    // `codex: command not found` line #169 hid behind a bare timeout was in the
    // pane the whole time. Fenced, and stripped of backticks by paneExcerpt.
    const why = excerpt ? `\n\`\`\`\n${excerpt}\n\`\`\`` : ''
    this.notify(agent.ticket, `⚠️ \`${agent.session}\` ${headline}${ignored} — session and claim kept for inspection (\`/attach ${agent.ticket}\`)${why}`)
  }

  // ---- the tool channel (#194) -------------------------------------------------

  // Every curia tool call an agent makes arrives as `POST /mcp?agent=<name>`,
  // and the client's startup handshake is the first of them. The daemon owns
  // that route, so it already holds the evidence that an agent HAS a tool
  // channel — it just recorded none of it (#189). This stamp is the whole
  // detector: one per agent, the first time its name lands on the route.
  //
  // Called from index.mjs AFTER the #159 token gate, so a request that could not
  // prove whose it is never counts as that agent speaking.
  onMcpCall(agentName) {
    const w = this.agents.get(agentName)
    if (!w || w.mcpSeenAt) return
    w.mcpSeenAt = Date.now()
    this.store.logEvent('agent_mcp_first', {
      repo: w.repo, ticket: w.ticket, agent: agentName, harness: w.harness, model: w.model,
      // The two numbers the grace window is tuned against. An agent that has not
      // reached its composer yet states null for the second, and that null is
      // itself a reading: it says the handshake ran ahead of the marker.
      since_spawn_ms: w.spawnedAt ? w.mcpSeenAt - w.spawnedAt : null,
      since_ready_ms: w.readyAt ? w.mcpSeenAt - w.readyAt : null,
      state: w.state,
    })
  }

  // The grace window, opened at the composer marker and closed by the first
  // `/mcp` request. Measured on the claude harness (#194, docs/live-checks/194):
  // the handshake lands about 3 s after spawn and about 2.5 s AHEAD of the
  // marker, so an agent that is still silent a window later has no tool channel
  // and is not merely slow.
  //
  // Polled rather than timed, so a cancel, a death or a respawn ends the watch
  // at the next second instead of firing into a record that has moved on.
  async #watchToolChannel(agent) {
    const graceS = this.routing.harnesses[agent.harness]?.toolChannelGraceS
    if (!graceS) {
      // config validation makes this unreachable; silence here would be the
      // #33 failure again, so say it rather than watching against nothing
      this.log(`no tool_channel_grace_s for harness "${agent.harness}" — ${agent.session} is not watched for a tool channel`)
      return
    }
    // The watch is over the moment the record it holds stops being the live
    // one: a cancel or a finish drops it, a respawn re-arms it, and an agent
    // already marked failed (an early exit, a ready timeout, a result-less
    // stop) must not be respawned by this path on top of that.
    const stale = () => this.agents.get(agent.session) !== agent
      || Boolean(agent.mcpSeenAt) || agent.state === 'failed'
    const deadline = agent.readyAt + graceS * 1000
    while (Date.now() < deadline) {
      if (stale()) return
      await sleep(1000)
    }
    if (stale()) return
    await this.#muteAgent(agent, { graceS, found: 'grace window' })
  }

  // An agent with no tool channel cannot report a result, ask a question, open
  // a pull request or end its turn on curia's terms. Every surface above it
  // reads it as an agent that is thinking (#185 fault 3), which is the whole
  // fault this ticket closes.
  //
  // Respawn ONCE, on the SAME model. The model is not what failed — the
  // client's one-shot MCP connect is — so walking the fallback chain would cool
  // a lane over a fault that has nothing to do with quota. Detection lands
  // seconds after spawn, so there is no work to throw away.
  //
  // A second mute agent is REFUSED and unclaimed, deliberately the same
  // behavior #188 gives a failed side-channel probe: the operator meets one
  // behavior for "curia could not give this agent a way to speak", not two.
  // Nothing here retries without a bound — that is #126's burnt spawn.
  async #muteAgent(agent, { graceS, found }) {
    const attempt = (agent.muteRespawns ?? 0) + 1
    const model = agent.model
    this.store.logEvent('agent_mute', {
      repo: agent.repo, ticket: agent.ticket, agent: agent.session,
      harness: agent.harness, model, grace_s: graceS ?? null, found, attempt,
    })
    this.log(`${agent.session} reached its composer and sent no /mcp request (${found}) — attempt ${attempt}`)
    await this.deps.killSession(agent.session).catch(() => {})

    if (attempt === 1) {
      agent.muteRespawns = attempt
      try {
        await this.#respawnOn(agent, model, { retry_after_mute: true })
        this.notify(agent.ticket, `⚙️ \`${agent.session}\` reached its composer with **no curia tools** — its MCP client never connected, so nothing it did could have reached anyone. Respawned once on the same model (**${model}**); the model is not what failed.`)
        return
      } catch (e) {
        this.log(`mute respawn of ${agent.session} on ${model} failed:`, e.message)
        const released = await this.#releaseClaim(agent, `respawn after a mute agent failed: ${e.message}`)
        this.notify(agent.ticket, `⚠️ \`${agent.session}\` had no curia tools and the respawn on **${model}** failed: ${e.message} — ${this.#releaseTail(agent, released)}`)
        return
      }
    }

    const released = await this.#releaseClaim(agent, 'no tool channel, twice')
    this.notify(agent.ticket, `🚫 \`${agent.session}\` reached its composer with **no curia tools** twice — refusing to dispatch #${agent.ticket} again on this fault — ${this.#releaseTail(agent, released)}. The MCP client connects once at startup and never retries, so the side channel has to be up BEFORE the agent (\`/state\`, then the daemon log for the last \`side_channel_ready\`).`)
  }

  // The backstop at the far end (#194). The Stop hook rides curl, not MCP
  // (`workspace.mjs`), so it reaches the daemon on a transport that works when
  // the tool channel does not — and an agent arriving here having never sent an
  // `/mcp` request is provably mute, whatever the grace window was tuned to.
  //
  // This is a backstop for a MISTUNED window, not a second mechanism: it cannot
  // catch a channel lost mid-session, because such an agent already has a
  // request on record.
  //
  // `spawnedAt` is the guard that makes the silence mean something. An agent
  // adopted after a daemon restart carries null there and no stamp either, and
  // its silence belongs to the restart rather than to the agent.
  #muteAtStop(agentName) {
    const w = this.agents.get(agentName)
    return Boolean(w && w.spawnedAt && !w.mcpSeenAt)
  }

  // When does this cooling end? Two harnesses state it in two places, so both are
  // read, best evidence first (#175):
  //
  //   pane        the claude harness puts an epoch on the reached-text itself,
  //               and parseUsageLimit has already taken it.
  //   transcript  the codex harness states none in the pane and states one in its
  //               transcript, beside the numbers the status bars read.
  //   the floor   neither stated one ⇒ the conservative hour, journalled
  //               (stated deviation 2). An agent capped before its first turn
  //               has written no transcript yet, and this is that case.
  #resetFor(agent, limit) {
    if (limit.resetAt) return { at: limit.resetAt, source: 'pane' }
    // The cap is ACCOUNT-level, so the reset belongs to the PROVIDER and not to
    // the agent that ran into it. Every live agent on this provider reads the
    // same account, and the one that just spawned is the one least likely to
    // have written a reading — so its siblings are asked too, and the latest
    // stated reset wins for the reason spentReset takes the latest slot.
    let best = null
    const read = new Set()
    for (const w of [agent, ...this.agents.values()]) {
      if (w.provider !== agent.provider || !w.harness || !w.cfgDir || read.has(w.cfgDir)) continue
      read.add(w.cfgDir)
      const at = transcriptReset(w.harness, w.cfgDir)
      if (at && (!best || at > best)) best = at
    }
    if (best) return { at: best, source: 'transcript' }
    return { at: new Date(Date.now() + 3600_000), source: 'floor' }
  }

  async #handleLimit(agent, limit) {
    const { at: resetAt, source } = this.#resetFor(agent, limit)
    if (source === 'floor') {
      this.store.logEvent('reset_unparseable', { agent: agent.session, scope: limit.scope, applied_cooldown_h: 1 })
    }
    if (limit.scope === 'model') {
      // Fable's own weekly sub-cap: cool only the model, provider stays warm.
      this.cooling.coolModel(agent.model, resetAt)
      this.store.logEvent('model_cooling', { model: agent.model, reset_at: resetAt.toISOString(), reset_source: source })
    } else {
      this.cooling.coolProvider(agent.provider, resetAt)
      this.store.logEvent('provider_cooling', { provider: agent.provider, reset_at: resetAt.toISOString(), reset_source: source })
    }
    await this.deps.killSession(agent.session).catch(() => {})

    const cands = candidates(this.routing, agent.requestedModel, this.cooling)
    if (cands.length) {
      const next = cands[0]
      try {
        await this.#respawnOn(agent, next, { retry_after_limit: true })
        this.notify(agent.ticket, `⚙️ \`${agent.session}\` hit ${limit.reason ? `the ${limit.reason}` : `a ${limit.scope} usage limit`} — respawned on **${next}**`)
        return
      } catch (e) {
        // The old session is already dead. Letting this reject would strand the
        // GitHub claim in an agent record reconcile deliberately skips, making
        // it unrecoverable short of /cancel — so take the same
        // release path true exhaustion takes.
        this.log(`respawn of ${agent.session} on ${next} failed:`, e.message)
        const released = await this.#releaseClaim(agent, `respawn after ${limit.scope} usage limit failed: ${e.message}`)
        this.notify(agent.ticket, `⚠️ \`${agent.session}\` hit ${limit.reason ? `the ${limit.reason}` : `a ${limit.scope} usage limit`} and the respawn on **${next}** failed: ${e.message} — ${this.#releaseTail(agent, released)}`)
        // the binding stays (#140): a claim release is not a ticket-terminal state
        return
      }
    }
    // true exhaustion: release the claim, then exactly ONE message about the
    // exhaustion window — the latched notify, or the sentinel when the latch
    // already fired (this agent's session is already dead; silence here is
    // not acceptable). A FAILED release is a separate fact and gets its own
    // notify: both exhaustion messages say "no claim made"/"nothing claimed",
    // which is the opposite of the truth when the unclaim failed — the ticket
    // stays assigned, filterTakeable drops it from every frontier, and only
    // reconcile's unclaim_failed retry will recover it.
    const released = await this.#releaseClaim(agent, 'exhausted: all candidates cooling')
    const suppressed = this.#exhausted(agent.ticket, agent.repo)
    if (suppressed) this.notify(agent.ticket, suppressed)
    if (!released) this.notify(agent.ticket, `⚠️ \`${agent.session}\`: claim release FAILED: the issue is still assigned; reconcile will retry`)
    // the binding stays (#140): exhaustion re-frontiers the ticket, it does not end it
  }

  // Respawn a live agent's session, in one place. Two callers with two
  // reasons and identical mechanics: a cap hit falls DOWN the chain (#13), a
  // mute agent respawns on the SAME model (#194). The mechanics are what a
  // second copy would get subtly wrong, so there is only one.
  //
  // The caller kills the old session first and handles every failure: this
  // throws, and there is no session left to fall back to.
  //
  // Re-seeding is unconditional. The next model may sit on another harness,
  // which wants a different config dir, a different credential arrangement and
  // a different side-channel layout — and a same-harness respawn re-seeds too,
  // because one path is easier to trust than a branch that has to be right
  // about when it matters.
  async #respawnOn(agent, next, journalData = {}) {
    const nextHarness = this.routing.models[next].harness
    // #174: the planted-config refusal is per harness, and this is where the
    // harness moves. It runs BEFORE #reshapeWorkspace and #armAgent, so a
    // refusal costs the workspace and the config dir nothing — the same
    // ordering the dispatch path keeps.
    //
    // Unconditional, for the reason the re-seed below is: a same-harness
    // respawn tests a worktree the agent has been writing in since the dispatch
    // check ran, and one path is easier to trust than a branch that has to be
    // right about when it matters.
    //
    // The throw lands in the caller's catch, which is the failed-respawn path
    // both callers already own: the old session is dead, so the claim is
    // released, the ticket is re-frontiered and the workspace survives for a
    // human. Falling FURTHER down the chain to a clean lane was refused
    // deliberately — that routes around a planted file with nobody told.
    this.#assertNoPlantedConfig(agent.wtPath, nextHarness, 'respawn')
    // The two harnesses need not agree about the sandbox (#148's rollout puts
    // claude in a container first and codex after the soak), so a fallback
    // across providers can also cross the boundary. Everything the agent reads
    // names its paths — the prompt, the connection settings, the config dir — so the whole
    // arming runs again in the NEW view, and the workspace itself may have to
    // change shape.
    const sandbox = this.#sandboxFor(nextHarness)
    await this.#reshapeWorkspace(agent, sandbox)
    const view = this.#viewFor(sandbox, agent.wtPath, agent.cfgDir)
    // #157: the ports belong to the AGENT, not to one container. A same-shape
    // respawn keeps its prompt (#rewritePrompt writes only when the view
    // moved), so fresh numbers here would leave that prompt naming ports
    // nothing publishes. The caller's kill is an ordered teardown, which removes
    // the container before tmux (see the killSession wrapper), so the old
    // bindings are already released.
    // #164: a reviewer publishes nothing — it starts no dev server and
    // `publish_preview` is refused for it — so a respawn must not allocate three
    // host ports a builder could have had.
    const ports = agent.reviewer ? [] : (sandbox ? (agent.ports ?? await this.#allocatePorts(sandbox)) : null)
    this.#armAgent({
      session: agent.session, ticket: agent.ticket, harness: nextHarness,
      model: next, wtPath: agent.wtPath, cfgDir: agent.cfgDir, view, sandbox,
    })
    await this.#rewritePrompt(agent, view, ports)
    const plan = await this.#spawnPlan({
      session: agent.session, ticket: agent.ticket, repo: agent.repo,
      harness: nextHarness, model: next, wtPath: agent.wtPath, cfgDir: agent.cfgDir,
      promptFile: agent.promptFile, view, sandbox, ports,
    })
    // A fresh marker per spawn: the old session is dead, and reusing its nonce
    // would let the previous life's exit line — still on screen for a moment —
    // read as the successor's death.
    const exitMarker = newExitMarker()
    await this.deps.newSession({ name: agent.session, cwd: agent.wtPath, env: plan.env, shellCmd: plan.shellCmd, exitMarker })
    agent.ports = plan.container?.ports ?? null
    agent.sandbox = plan.container ? 'docker' : null
    agent.exitMarker = exitMarker
    agent.model = next
    agent.harness = nextHarness
    agent.provider = this.routing.models[next].provider
    agent.spawnedAt = Date.now()
    agent.state = 'spawning'
    // A respawn is a NEW client process, so what the last one proved about its
    // tool channel says nothing about this one (#194). Clearing these is what
    // makes the second window a real second reading rather than an echo.
    agent.mcpSeenAt = null
    agent.readyAt = null
    this.store.logEvent('agent_spawned', {
      repo: agent.repo, ticket: agent.ticket, agent: agent.session,
      model: next, harness: nextHarness, ...journalData,
    })
    this.#watchdog(agent).catch((e) => this.log(`watchdog ${agent.session} failed:`, e.message))
  }

  // A container cannot use a worktree cut from the shared base clone: its
  // `.git` is a file pointing into a base the container never sees. So a
  // respawn that crosses INTO the sandbox has to replace the workspace with a
  // private clone — and it may only do that when the old one holds nothing.
  //
  // Unpushed work refuses the reshape, and "cannot tell" refuses it too: the
  // same evidence rule the orphan sweep runs on, for the same reason. The
  // caller's catch then releases the claim, so the ticket is re-frontiered and
  // the next dispatch prepares the right shape from the start — the workspace
  // survives for a human either way.
  //
  // The other direction needs nothing: a private clone is an ordinary
  // repository, and the bare path drives it exactly as it drives a worktree.
  async #reshapeWorkspace(agent, sandbox) {
    // #164: a review checkout is a detached HEAD at a PUSHED sha, so it holds
    // nothing that exists nowhere else — a shape change is a re-create, not a
    // refusal. The refusal below exists to protect a builder's unlanded commits,
    // and a reviewer has none by construction.
    if (agent.reviewer) {
      if (Boolean(sandbox) === isPrivateClone(agent.wtPath)) return
      await this.#removeReviewCheckout(agent.repo, agent.ticket, agent.wtPath)
      const made = await this.deps.createReviewCheckout(this.root, agent.repo, agent.ticket, { sandbox: Boolean(sandbox) })
      agent.wtPath = made.path
      agent.sha = made.sha
      agent.baseBranch = made.baseBranch
      return
    }
    if (!sandbox || isPrivateClone(agent.wtPath)) return
    let unpushed = true
    let why = 'it holds commits that exist nowhere else'
    try {
      const base = basePathFor(this.root, agent.repo)
      unpushed = await this.deps.hasUnpushedWork(agent.wtPath, branchFor(agent.ticket), await this.deps.defaultBranchOf(base))
    } catch (e) {
      why = `curia could not tell whether it holds unlanded commits (${e.message})`
    }
    if (unpushed) {
      throw new Error(`the fallback harness runs in a container, and this ticket's workspace is a worktree of the shared base clone that a container cannot mount — ${why}, so curia will not replace it`)
    }
    await this.deps.removeWorktree(basePathFor(this.root, agent.repo), agent.wtPath)
    agent.wtPath = await this.deps.createPrivateClone(this.root, agent.repo, agent.ticket)
  }

  // The prompt names the worktree twice, in the agent's own view of it, and
  // since #157 it names the published ports too — so a respawn that crossed the
  // sandbox boundary has to write it again. The view is what says the boundary
  // was crossed: it moves in exactly the two directions that change both facts.
  // The issue is re-read rather than remembered: the body is what the prompt
  // carries, and the agent record keeps only the title.
  async #rewritePrompt(agent, view, ports = null) {
    if (view.wt === agent.promptView) return
    // #164: a reviewer respawned down the fallback chain must be handed the
    // REVIEWER's prompt again. Writing the builder's here would give an agent
    // with no claim and no branch a full set of ticket standing orders.
    if (agent.reviewer) {
      const reviewed = await this.deps.fetchIssue(agent.repo, agent.ticket)
      agent.promptFile = this.deps.writeReviewPrompt(agent.cfgDir, reviewed, {
        repo: agent.repo,
        wtPath: view.wt,
        branch: branchFor(agent.ticket),
        baseBranch: agent.baseBranch,
        sha: agent.sha,
        model: spawnModelId(this.routing, agent.model),
        builderModel: spawnModelId(this.routing, agent.builderModel),
      })
      agent.promptView = view.wt
      return
    }
    const issue = await this.deps.fetchIssue(agent.repo, agent.ticket)
    const mapNumber = await this.#mapNumberFor(agent.repo, issue)
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    agent.promptFile = this.deps.writePrompt(agent.cfgDir, issue, {
      repo: agent.repo,
      wtPath: view.wt,
      mapNumber,
      type: labels.find((l) => l.startsWith('wayfinder:')) ?? null,
      ports,
    })
    agent.promptView = view.wt
  }

  // Drop the agent record and hand the ticket back to the frontier. Returns
  // whether the GitHub claim was actually released — dispatch_unclaimed is
  // journalled ONLY then (the W1-in-the-journal rule: a null login or a
  // failed `gh issue edit` leaves the issue assigned, and recording it as
  // unclaimed would make #reconcileDeadClaims treat the epoch as closed
  // forever). unclaim_failed is not matched by closedAfterEpoch, so the next
  // reconcile retries the release.
  // `keepCredentials` exists for exactly one caller: the non-clean report_result
  // path (#41), where the agent is STILL ALIVE — every other caller's session
  // is already dead. Deleting the per-agent credential copy under a live agent
  // kills its next model turn (#34's snapshot bound), and a `blocked` agent
  // still has a turn to end. The abandoned-credential sweep collects it once the
  // session is positively gone.
  async #releaseClaim(agent, reason, { keepCredentials = false } = {}) {
    this.agents.delete(agent.session)
    // #164: a reviewer holds NO claim — the builder holds the ticket's only one,
    // and it is still working. Unclaiming here would release a live agent's
    // ticket back onto the frontier over a fault in the second agent, which is
    // the one way a cross-check could damage the thing it exists to check. This
    // is the choke point for every path that ends an agent badly, so the guard
    // lives here rather than in each of them.
    if (agent.reviewer) {
      if (!keepCredentials) this.deps.removeCredentials(agent.cfgDir ?? cfgDirFor(this.root, agent.session))
      await this.#removeReviewCheckout(agent.repo, agent.ticket, agent.wtPath)
      this.store.logEvent('reviewer_ended', { repo: agent.repo, ticket: agent.ticket, agent: agent.session, reason })
      // #165: this is the choke point for every bad ending, and a builder parked
      // at the gate is waiting on THIS agent. Ending it without settling the
      // wait would park the builder forever on a second agent that is gone.
      this.#endReviewWait(agent.ticket, `the reviewer ended — ${reason}`)
      return true
    }
    let released = false
    let failure = null
    const login = await this.deps.viewerLogin().catch((e) => { failure = e.message; return null })
    if (login) {
      try {
        await this.deps.unclaim(agent.repo, agent.ticket, login)
        released = true
      } catch (e) {
        failure = e.message
      }
    }
    // the session is dead and the record is being dropped, so nothing later
    // will collect the host OAuth credential copy — take it now; the rest of
    // the config dir (prompt.md) stays for post-mortem
    if (agent.cfgDir && !keepCredentials) this.deps.removeCredentials(agent.cfgDir)
    if (released) {
      this.store.logEvent('dispatch_unclaimed', { repo: agent.repo, ticket: agent.ticket, agent: agent.session, reason })
    } else {
      this.store.logEvent('unclaim_failed', { repo: agent.repo, ticket: agent.ticket, agent: agent.session, reason, error: failure ?? 'no viewer login' })
    }
    return released
  }

  // What a failure message says about the claim after #releaseClaim ran. Two
  // agents can sit on one ticket since #164, and only one of them has a claim to
  // say anything about — so the sentence is chosen where the fact is known,
  // rather than repeated at four call sites that would each have to remember.
  #releaseTail(agent, released) {
    if (agent.reviewer) return 'the cross-check ends with no verdict; the builder and its claim are untouched'
    return released
      ? 'claim released, ticket re-frontiered'
      : 'claim release FAILED: the issue is still assigned; reconcile will retry'
  }

  // ---- the merge-gated ending (#54) ---------------------------------------------

  // Which ticket and repo an agent-facing tool call belongs to. The ticket comes
  // from the SPAWN BINDING (the agent record, else the session name) and never
  // from the caller — the same rule onResult follows, and for the same reason:
  // these calls push branches and ask humans to approve things.
  #bindingFor(agentName) {
    const w = this.agents.get(agentName)
    const m = agentName.match(SESSION_RE)
    const ticket = String(w?.ticket ?? (m ? m[1] : ''))
    if (!ticket) return { error: `no curia ticket is bound to \`${agentName}\`` }
    const repo = w?.repo ?? this.#epochRepo(ticket)
    if (!repo) return { error: `curia cannot tell which repo #${ticket} belongs to` }
    const wtPath = w?.wtPath ?? worktreePathFor(this.root, repo, ticket)
    return { w, ticket, repo, wtPath, branch: branchFor(ticket), basePath: basePathFor(this.root, repo) }
  }

  // `open_pull_request` (#54 item 1). Landing left report_result because the
  // pull request is now what a human reviews BEFORE anything is resolved — so it
  // has to be openable in the middle of a ticket, and re-openable after every
  // rejection. The agent still never pushes: the containment boundary of #40/#41
  // is unchanged, only its timing.
  async openPullRequest(agentName, { summary = '' } = {}) {
    // #164, and FIRST: this call pushes. A reviewer that has misread its own
    // kind must not be one tool call away from putting a branch on the remote,
    // for the same reason a charting agent must not — and here the branch it
    // would push is the BUILDER's.
    const refused = this.toolRefusal(agentName, 'open_pull_request')
    if (refused) return `${refused} Nothing was pushed.`
    const b = this.#bindingFor(agentName)
    if (b.error) return `❌ ${b.error} — nothing was pushed`
    const { w, ticket, repo, wtPath, branch, basePath } = b
    // #160: a map dispatch produces tracker writes, not code. Refused rather
    // than left to the prompt, because this call PUSHES — and a charting agent
    // that has misread its own kind must not be one tool call away from putting
    // a branch on the remote.
    if (this.#epochCharting(ticket, agentName).charting) {
      this.store.logEvent('charting_tool_refused', { repo, ticket, agent: agentName, tool: 'open_pull_request' })
      return `❌ \`${agentName}\` is a CHARTING agent on map ${repo}#${ticket}. A map dispatch opens no pull request: your work is the map itself, and it is already written. Update the map, then call report_result.`
    }
    if (!fs.existsSync(wtPath)) return `❌ the worktree ${wtPath} is gone — nothing was pushed`

    let title = w?.title
    if (!title) {
      title = await this.deps.fetchIssue(repo, ticket).then((i) => i.title).catch(() => `#${ticket}`)
    }
    let out
    try {
      out = await landBranch({
        repo, ticket, title, summary, agent: agentName, model: w?.model ?? null,
        wtPath, basePath, branch, deps: this.deps,
        journal: (type, data) => this.store.logEvent(type, data),
      })
    } catch (e) {
      this.store.logEvent('land_failed', { repo, ticket, agent: agentName, branch, error: e.message })
      this.notify(ticket, `⚠️ \`${agentName}\`: opening the pull request FAILED — ${e.message}`)
      return `❌ curia could not land \`${branch}\`: ${e.message}. Your commits are safe in the worktree; fix what you can and call this again.`
    }
    if (!out.ok) {
      return `❌ nothing to open a pull request from — \`${branch}\` carries no commits. Commit your work first.`
    }
    if (w) w.prUrl = out.url
    await this.deps.commentIssue(repo, ticket, prLinkComment({
      branch, commits: out.commits, url: out.url, state: out.state,
    })).catch((e) => this.log(`pull-request comment on ${repo}#${ticket} failed: ${e.message}`))
    this.notify(ticket, `🔗 \`${agentName}\` ${out.state === 'updated' ? 'updated' : 'opened'} <${out.url}> (${out.commits} commit${out.commits === 1 ? '' : 's'} on \`${branch}\`)`)
    return `${out.state === 'updated' ? 'updated' : 'opened'} ${out.url} — ${out.commits} commit${out.commits === 1 ? '' : 's'} pushed on \`${branch}\`. Next: request_review.`
  }

  // `request_review` (#54 item 2, #48's gate). One gate, and it never branches on
  // ticket type: only the LINKS differ, and every one of them is composed here
  // from curia's own records rather than from anything the agent says — the
  // preview from the registry that allocated it, the pull request from GitHub,
  // the ticket from the spawn binding. #40 recorded the alternative as a live
  // limit: an agent can hand ask_human any `preview_url` string it likes.
  async requestReview(agentName, { summary = '', charting = '' } = {}) {
    // #164: the reviewer is what a gate ASKS ABOUT, never what opens one. A
    // reviewer at the gate would put its own reading in front of the operator as
    // if it were the work, on a ticket it is not building.
    const refused = this.toolRefusal(agentName, 'request_review')
    if (refused) return { ok: false, text: refused }
    const b = this.#bindingFor(agentName)
    if (b.error) return { ok: false, text: `❌ ${b.error} — no review was requested` }
    const { w, ticket, repo, branch } = b
    // #160/#149: no review gate on a map dispatch. The gate exists to put a
    // human in front of a DIFF before it merges; a charting agent has no diff,
    // and the operator who dispatched it is the check. Opening one here would
    // block the agent on a question with nothing to look at.
    if (this.#epochCharting(ticket, agentName).charting) {
      this.store.logEvent('charting_tool_refused', { repo, ticket, agent: agentName, tool: 'request_review' })
      return {
        ok: false,
        text: `❌ \`${agentName}\` is a CHARTING agent on map ${repo}#${ticket}, and a map dispatch has no review gate — there is no pull request to show and nothing to merge. The operator who dispatched you is the check. Finish the map edits and call report_result; ask_human is how you reach them with a question.`,
      }
    }

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

    const { text } = reviewGateText({ repo, ticket, title, summary, charting, links })
    this.store.logEvent('review_requested', {
      repo, ticket, agent: agentName, pr: pr?.url ?? w?.prUrl ?? null,
      preview: preview?.url ?? null,
    })
    if (w) w.state = 'awaiting-review'
    const { text: answer, status } = await this.askReview(agentName, ticket, text)
    if (w && w.state === 'awaiting-review') w.state = 'ready'

    if (status !== 'answered') {
      this.store.logEvent('review_answered', { repo, ticket, agent: agentName, approved: false, status })
      return { ok: true, aborted: true, text: `${answer}\n\n(the review gate was ${status}, not answered — do not merge and do not resolve anything)` }
    }
    const { approved, crossCheck, feedback } = classifyReviewAnswer(answer)
    this.store.logEvent('review_answered', {
      repo, ticket, agent: agentName, approved, via: 'gate',
      ...(crossCheck ? { outcome: 'cross-check' } : {}),
    })
    // #165, ADR-0010: the third button. The gate had two answers and now has
    // three, and this one answers NOTHING — nothing merges, nothing is rejected,
    // and the round ends where it started. What it does is put a second model on
    // the diff and hold the builder here until that model has read it.
    if (crossCheck) return await this.#runCrossCheck(agentName, { repo, ticket, w })
    if (approved) {
      return {
        ok: true,
        approved: true,
        text: `APPROVED by the human. Now, in order: merge the pull request (\`gh pr merge <url> --repo ${repo} --squash --delete-branch\`), then resolve the ticket, then report_result.`,
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

  // ---- the cross-check press and the way back (#165, ADR-0010) -----------------

  // The press, from inside the gate call the operator answered.
  //
  // The builder does not return here. It stays inside `request_review` until the
  // verdict lands, and that is what ADR-0010's "the builder stays idle and keeps
  // its own slot" buys: a parked agent is nearly free (ADR-0005), it holds its
  // claim, its worktree and its whole context, and nothing has to wake it up.
  // The alternative — return now, let the turn end, wake it later — has no way
  // to wake it: an operator note rides a TOOL RESULT, and a stopped agent makes
  // no tool calls. So the note rides this one.
  async #runCrossCheck(agentName, { repo, ticket, w }) {
    if (w) w.state = 'cross-checking'
    this.store.logEvent('cross_check_requested', { repo, ticket, agent: agentName })
    // `crossCheck` never throws — every failure comes back as a line and leaves
    // the builder untouched. What decides here is the RECORD, not that line: a
    // reviewer in the agents map is the thing that can produce a verdict, and
    // parking on anything less would park on a sentence.
    const spawned = await this.crossCheck(ticket, { repo, by: 'review gate' })
    if (!this.agents.has(reviewSessionFor(ticket))) {
      if (w) w.state = 'ready'
      this.store.logEvent('cross_check_returned', { repo, ticket, agent: agentName, ok: false, why: 'not spawned' })
      return {
        ok: true,
        approved: false,
        crossCheck: true,
        text: [
          'CROSS-CHECK — the operator pressed the third button, and curia could not start the reviewer:',
          spawned,
          '',
          'Nothing was approved and nothing was rejected. Fix what the line names if it is yours to fix,',
          'then call request_review again. The button is there on every round.',
        ].join('\n'),
      }
    }
    this.notify(ticket, `⏸️ \`${agentName}\` is idle at the gate while the cross-check reads — it holds its claim, its worktree and its slot, and it wakes when the verdict lands`)
    const out = await this.#awaitVerdict(ticket, agentName)
    if (w) w.state = 'ready'
    this.store.logEvent('cross_check_returned', { repo, ticket, agent: agentName, ok: out.ok, why: out.why ?? null })
    if (!out.ok) {
      return {
        ok: true,
        approved: false,
        crossCheck: true,
        text: [
          `CROSS-CHECK ENDED WITH NO VERDICT — ${out.why}.`,
          '',
          'Nothing was approved and nothing was rejected, and there is nothing for you to judge. Call',
          'request_review again when you are ready. The operator can press the button again.',
        ].join('\n'),
      }
    }
    // The verdict itself is NOT in this text. It is already on the note queue,
    // and the drain appends it to this very tool result — so the builder reads
    // the duty and the findings in one turn, and the durable record of what it
    // was handed is the journalled note rather than this string.
    return {
      ok: true,
      approved: false,
      crossCheck: true,
      text: [
        'CROSS-CHECK — the operator pressed the third button, so this gate was neither approved nor',
        `rejected. \`${out.verdict.agent}\` read your diff on **${spawnModelId(this.routing, out.verdict.model ?? '')}**,`,
        'and its verdict rides in this same tool result as a note. Read it, then:',
        '',
        ...dutyLines(),
      ].join('\n'),
    }
  }

  // Park the builder until this ticket's verdict lands. One waiter per ticket:
  // a second press cannot exist while the first is parked, because the builder
  // that would press is the one inside this call.
  #awaitVerdict(ticket, agentName) {
    const key = String(ticket)
    this.#endReviewWait(key, 'a newer cross-check replaced it')
    return new Promise((resolve) => {
      this.reviewWaits.set(key, { agent: agentName, resolve })
    })
  }

  #settleReviewWait(ticket, outcome) {
    const wait = this.reviewWaits.get(String(ticket))
    if (!wait) return false
    this.reviewWaits.delete(String(ticket))
    wait.resolve(outcome)
    return true
  }

  // Every way a cross-check can end WITHOUT a verdict goes through here: the
  // reviewer died, its respawn failed, it was cancelled, it exhausted the
  // fallback chain. Missing one of them would leave the builder parked forever
  // on a second agent that is already gone — the one failure a cross-check must
  // never cause, because the builder holds the ticket's only claim.
  #endReviewWait(ticket, why) {
    return this.#settleReviewWait(ticket, { ok: false, why })
  }

  // What the daemon does the moment a verdict lands (ADR-0010's return path).
  // Three acts, in this order, and each one is independent of the others:
  //
  //   1. the pull-request comment — the durable record, per ADR-0001. It is
  //      posted whether or not any builder is still alive to read the verdict.
  //   2. the note queue — how the verdict reaches the BUILDER.
  //   3. the parked gate call — woken, so the note drains onto its result.
  //
  // The comment goes first because it is the one act that outlives everything
  // here. A builder that is gone, a park that timed out with the daemon: the
  // verdict is still on the pull request, and the operator can read it.
  async #deliverVerdict(verdict) {
    const ticket = String(verdict.ticket)
    const builder = `curia-${ticket}`
    const posted = await this.#commentOnPullRequest(verdict.repo, ticket, verdictComment(verdict))
    this.store.logEvent('verdict_commented', {
      repo: verdict.repo, ticket, agent: verdict.agent, ok: posted.ok, why: posted.why ?? null,
    })
    if (!posted.ok) {
      this.notify(ticket, `⚠️ the cross-check verdict could NOT be posted on the pull request — ${posted.why}. curia still holds it, and the builder still gets it.`)
    }
    const w = this.agents.get(builder)
    if (!w) {
      this.store.logEvent('verdict_undelivered', { repo: verdict.repo, ticket, agent: builder, reason: 'no builder is running' })
      this.notify(ticket, `📭 the verdict on #${ticket} has nowhere to go — \`${builder}\` is not running. It is on the pull request, and \`resume ${ticket}\` puts an agent back on the ticket.`)
      return
    }
    // #208's rule, and the caller is what marks the note: these words are for
    // THIS builder. A successor must not read a verdict about a diff it did not
    // write.
    this.store.queueAgentNote?.(builder, verdictNote(verdict), {
      instance: w.instance ?? null, label: 'cross-check verdict',
    })
    this.#settleReviewWait(ticket, { ok: true, verdict })
  }

  // The builder's judgement, as the second comment (ADR-0010). The daemon holds
  // both texts already: it spawned the reviewer, and the judgement IS the
  // escalation prompt of the plain question the duty asks for. So no agent write
  // bound widens — the agent asks a question, and curia records what it asked.
  //
  // The FIRST question after a verdict is the judgement, and there is only one:
  // `judged` on the artifact closes it, and a later cross-check on the same
  // ticket writes a fresh artifact that opens it again.
  //
  // The mark goes on BEFORE the comment, deliberately. Two questions can
  // interleave across the gh round-trip below, and of the two failures — no
  // comment, or the same judgement posted twice — the silent one is the safer,
  // because the operator is told when it happens and the text is in the thread
  // either way.
  async noteJudgement(agentName, prompt) {
    const m = String(agentName ?? '').match(SESSION_RE)
    if (!m) return false
    const ticket = m[1]
    const verdict = this.verdictFor(ticket)
    if (!verdict || verdict.judged) return false
    verdict.judged = true
    this.verdicts.set(ticket, verdict)
    try {
      fs.writeFileSync(this.#verdictFile(ticket), JSON.stringify(verdict, null, 2))
    } catch (e) {
      this.log(`could not mark the verdict for #${ticket} judged: ${e.message}`)
    }
    const posted = await this.#commentOnPullRequest(verdict.repo, ticket, judgementComment(agentName, prompt))
    this.store.logEvent('judgement_commented', {
      repo: verdict.repo, ticket, agent: agentName, ok: posted.ok, why: posted.why ?? null,
    })
    if (!posted.ok) {
      this.notify(ticket, `⚠️ \`${agentName}\`'s judgement of the cross-check could NOT be posted on the pull request — ${posted.why}. The question itself is in this thread.`)
    }
    return posted.ok
  }

  // A comment on the pull request this ticket's branch opened. GitHub gives a
  // pull request and an issue one number space and one comment endpoint, so this
  // is `commentIssue` against the PR's number — the same seam, no new authority.
  // Every failure is a returned reason, never a throw: nothing here is worth
  // failing a verdict over.
  async #commentOnPullRequest(repo, ticket, body) {
    if (!repo) return { ok: false, why: 'curia cannot tell which repo this ticket belongs to' }
    let pr = null
    try {
      pr = await this.deps.findPullRequest(repo, branchFor(ticket))
    } catch (e) {
      return { ok: false, why: `the pull-request read failed (${e.message})` }
    }
    if (!pr) return { ok: false, why: `no pull request is open for \`${branchFor(ticket)}\`` }
    try {
      await this.deps.commentIssue(repo, pr.number, body)
      return { ok: true, url: pr.url }
    } catch (e) {
      return { ok: false, why: `the comment failed (${e.message})` }
    }
  }

  // What the journal says has happened SINCE this ticket's latest dispatch. The
  // epoch scoping is the same rule reconcile runs on: a pull request or an
  // approval from an earlier dispatch of the same ticket is not this agent's.
  #epochScan(ticket, agentName) {
    const journal = this.#readJournal()
    let epochIdx = -1
    journal.forEach((ev, i) => {
      if ((ev.type === 'dispatch_claimed' || ev.type === 'agent_spawned') && String(ev.ticket ?? '') === ticket) epochIdx = i
    })
    const mine = (ev) => ev.agent === agentName || String(ev.ticket ?? '') === ticket
    const since = (pred) => journal.some((ev, i) => i > epochIdx && pred(ev))
    return {
      prOpened: since((ev) => ['pr_opened', 'pr_reused', 'land_repaired'].includes(ev.type) && mine(ev)),
      reviewApproved: since((ev) => ev.type === 'review_answered' && ev.approved === true && mine(ev)),
      blocks: journal.filter((ev, i) => i > epochIdx && ev.type === 'stop_blocked' && ev.agent === agentName).length,
    }
  }

  // Everything the Stop-hook checklist is judged against. Cheap on purpose: the
  // hook fires at the end of EVERY turn, so this reads the journal and local git
  // and reaches GitHub only once a review has been approved (to ask whether the
  // merge happened).
  //
  // Every read fails OPEN — an indeterminate answer drops that item from the
  // checklist rather than adding it. Trapping an agent in a stop-block loop on a
  // failed `git log` is worse than letting one unfinished ticket through to the
  // repair path.
  async #endingState(agentName) {
    // #164: a reviewer's ending is one call, and none of the reads below say
    // anything true about it — the commits are the builder's, the pull request is
    // the builder's, and the review gate is the builder's. Answered from the
    // name, so it holds after a restart too.
    if (this.#isReviewer(agentName)) {
      const w = this.agents.get(agentName)
      const ticket = String(w?.ticket ?? String(agentName).match(REVIEW_SESSION_RE)?.[1] ?? '')
      return {
        reviewer: true,
        ticket,
        repo: w?.repo ?? null,
        // `blocks` is what bounds the nudge budget, and it is counted per AGENT
        // — so the reviewer's own nudges are counted, not the builder's.
        ...this.#epochScan(ticket, agentName),
        hasResult: Boolean(w?.resultReceived) || fs.existsSync(path.join(this.dataDir, 'results', `${agentName}.json`)),
      }
    }
    const b = this.#bindingFor(agentName)
    if (b.error) return { error: b.error }
    const { w, ticket, repo, wtPath, branch, basePath } = b
    const state = {
      ticket,
      repo,
      hasResult: Boolean(w?.resultReceived) || fs.existsSync(path.join(this.dataDir, 'results', `${agentName}.json`)),
      ...this.#epochScan(ticket, agentName),
      hasCommits: false,
      prState: null,
      // #160: which of the two endings this agent is held to. `outstanding`
      // picks the checklist off it, so a charting agent is never nudged toward
      // a pull request, a review or a merge it is forbidden to reach.
      charting: this.#epochCharting(ticket, agentName).charting,
    }
    // A charting agent has one daemon-visible step, and it is not in git or on
    // GitHub — so the reads below are skipped whole. The Stop hook fires at the
    // end of every turn, and a `git log` against a checkout that will never
    // carry a commit is pure cost.
    if (state.charting) return state
    try {
      const commits = await this.deps.commitsOnBranch(wtPath, await this.deps.defaultBranchOf(basePath))
      state.hasCommits = commits.length > 0
    } catch (e) {
      this.log(`stop hook ${agentName}: could not read commits on ${branch} (${e.message}) — not asking for a pull request`)
    }
    if (state.reviewApproved && state.prOpened) {
      try {
        state.prState = (await this.deps.findPullRequest(repo, branch))?.state ?? null
      } catch (e) {
        this.log(`stop hook ${agentName}: could not read the pull request for ${branch} (${e.message}) — not asking for a merge`)
      }
    }
    return state
  }

  // The Stop hook's answer (#54 item 4). Returns what index.mjs puts on the wire:
  //   { decision: 'block', reason }  — hold the agent at the ending
  //   { allow: true, terminal: bool } — let it stop; `terminal` says whether the
  //                                     dispatch lifecycle should now close
  //
  // #47 stays FIRST and unchanged: a turn that ends with an escalation still open
  // is an agent blocked on a human, not an agent that finished — and blocking
  // THAT stop would spin an agent whose next move is not its own to make.
  async onStopHook(agentName, { stopHookActive = false } = {}) {
    // #194's backstop, FIRST and before the nudge. An agent that got here having
    // never sent an `/mcp` request has no way to satisfy any item of the ending
    // — `open_pull_request`, `request_review` and `report_result` are all curia
    // tools — so holding it at that ending would spin it against a channel it
    // does not have. Allow the stop, and say why on the surfaces.
    if (this.#muteAtStop(agentName)) {
      const w = this.agents.get(agentName)
      this.store.logEvent('agent_mute', {
        repo: w.repo, ticket: w.ticket, agent: agentName, harness: w.harness,
        model: w.model, grace_s: null, found: 'stop hook', attempt: (w.muteRespawns ?? 0) + 1,
      })
      this.notify(w.ticket, `⚠️ \`${agentName}\` ended a turn having never called one curia tool — its MCP client never connected, so it has no way to report a result or ask anything. The Stop hook rides curl and reached curia anyway, which is how this is known. Not held at the ending: there is nothing it could do about it.`)
      return { allow: true, terminal: true }
    }
    const block = await this.#humanBlockEvidence(agentName)
    if (block.blocked) {
      this.#recordHumanBlock(agentName, block.open, { crossCheck: block.crossCheck })
      return { allow: true, terminal: false }
    }

    const state = await this.#endingState(agentName)
    if (state.error) return { allow: true, terminal: true }
    const items = outstanding(state)
    if (!items.length) return { allow: true, terminal: true }

    const budget = this.config.dispatch.stop_nudge_budget
    const attempt = state.blocks + 1
    if (attempt > budget) {
      // The one thing worse than an unfinished ticket is an agent looping on
      // quota unattended (#48). Past the budget the stop is allowed and the
      // lifecycle closes on the evidence it actually has: report_result present
      // ⇒ verify and repair; absent ⇒ the abnormal-exit branch, which keeps the
      // pane and says so.
      this.store.logEvent('stop_budget_exhausted', {
        agent: agentName, ticket: state.ticket, repo: state.repo, blocks: state.blocks, outstanding: items,
      })
      this.notify(state.ticket, `⚠️ \`${agentName}\` stopped with ${items.length} step(s) of the ending outstanding after ${state.blocks} nudge(s) — curia is no longer holding it:\n${items.map((t) => `• ${t}`).join('\n')}`)
      return { allow: true, terminal: true }
    }
    this.store.logEvent('stop_blocked', {
      agent: agentName, ticket: state.ticket, repo: state.repo, attempt, outstanding: items, stop_hook_active: stopHookActive,
    })
    this.log(`stop hook ${agentName}: blocking stop ${attempt}/${budget} — ${items.join('; ')}`)
    return { decision: 'block', reason: stopReason(items, { attempt, budget }) }
  }

  // ---- lifecycle callbacks -----------------------------------------------------

  // report_result lands here. Marking the dispatch lifecycle is the old half;
  // the new half (#41) is the TICKET's own resolution — verified, repaired and
  // landed by resolve.mjs, or explicitly not-resolved on a non-clean status.
  // Returns the text the agent gets back as its tool result, so a failure the
  // daemon hit is visible to the one agent still able to react to it.
  async onResult(agentName, result = null) {
    const w = this.agents.get(agentName)
    if (w) w.resultReceived = true
    if (!result) return 'result recorded'

    // #164: a reviewer's result IS the verdict, and nothing else happens on it.
    // Branched before every line below, because all of them act on a ticket —
    // and a reviewer that reached the resolve path would close the builder's.
    if (this.#isReviewer(agentName)) {
      try {
        return await this.#captureVerdict(agentName, result, w)
      } catch (e) {
        this.store.logEvent('verdict_failed', { agent: agentName, error: e.message })
        return `result recorded — but curia could not capture the verdict: ${e.message}`
      }
    }

    // The ticket comes from the SPAWN BINDING (the agent record, else the
    // session name), never from `result.ticket` — that field is agent-supplied,
    // and this path closes issues and rewrites map bodies. An agent that names
    // someone else's ticket gets its own resolved and the disagreement
    // journalled.
    const m = agentName.match(SESSION_RE)
    const ticket = String(w?.ticket ?? (m ? m[1] : ''))
    if (!ticket) {
      this.store.logEvent('resolve_skipped', { agent: agentName, reason: 'no ticket is bound to this agent' })
      return 'result recorded — no curia ticket is bound to this agent, so nothing on the tracker was touched'
    }
    if (result.ticket != null) {
      const ref = parseTicketRef(result.ticket)
      const boundRepo = w?.repo ?? null
      const sameTicket = ref.number === ticket
        && (!ref.repo || !boundRepo || ref.repo.toLowerCase() === boundRepo.toLowerCase())
      if (!sameTicket) {
        this.store.logEvent('result_ticket_mismatch', { agent: agentName, bound: ticket, reported: String(result.ticket) })
        this.log(`WARNING: ${agentName} reported ticket ${result.ticket} but is bound to ${ticket} — acting on ${ticket}`)
      }
    }
    const repo = w?.repo ?? this.#epochRepo(ticket)
    if (!repo) {
      this.store.logEvent('resolve_skipped', { agent: agentName, ticket, reason: 'no repo could be determined' })
      return `result recorded — curia could not tell which repo #${ticket} belongs to, so the ticket was left untouched`
    }

    try {
      // #160: a map dispatch never runs the resolve protocol. resolveAndLand
      // would close the map, append a Decisions-so-far pointer to whatever the
      // map's own parent is, and open a pull request for a session that wrote no
      // code — three wrong acts on the one issue every later agent reads.
      const { charting, instruction } = this.#epochCharting(ticket, agentName)
      if (charting) return await this.#finishCharting(agentName, repo, ticket, result, w, instruction)
      return result.status === 'resolved'
        ? await this.#resolveTicket(agentName, repo, ticket, result, w)
        : await this.#noteNonClean(agentName, repo, ticket, result, w)
    } catch (e) {
      this.store.logEvent('resolve_failed', { repo, ticket, agent: agentName, status: result.status, error: e.message })
      this.notify(ticket, `⚠️ ${repo}#${ticket}: the result was recorded but curia's resolve step failed — ${e.message}`)
      return `result recorded — but curia's resolve step failed: ${e.message}`
    }
  }

  // The repo this ticket was last dispatched against, for an agent whose record
  // this process never held (reconcile-adopted, or a restart mid-flight).
  #epochRepo(ticket) {
    let repo = null
    for (const ev of this.#readJournal()) {
      if ((ev.type === 'dispatch_claimed' || ev.type === 'agent_spawned')
        && String(ev.ticket ?? '') === String(ticket) && ev.repo) repo = ev.repo
    }
    return repo
  }

  // Was this ticket's latest dispatch a charting one, and what rode it (#160)?
  // Same journal reduction as #epochRepo, for an agent record this process never
  // held: a restart mid-session, or a reconcile-adopted agent. The in-memory
  // record wins where there is one — the journal is the fallback, not a second
  // opinion.
  //
  // The failure direction matters: `charting: false` on a real map agent sends
  // it to the ticket ending, which would try to close the map. So the reduction
  // reads `agent_spawned` only, which is the event that states the kind, and a
  // number with no such event at all is a ticket — nothing was ever charted
  // under it, so there is no map to protect.
  #epochCharting(ticket, agentName) {
    const w = this.agents.get(agentName)
    if (w) return { charting: Boolean(w.charting), instruction: w.instruction ?? null }
    let out = { charting: false, instruction: null }
    for (const ev of this.#readJournal()) {
      if (ev.type !== 'agent_spawned' || String(ev.ticket ?? '') !== String(ticket)) continue
      out = { charting: ev.kind === 'charting', instruction: ev.instruction ?? null }
    }
    return out
  }

  // What this session was last spawned ON (#187): the routing label and the
  // harness. Same journal reduction as #epochRepo and #epochCharting, keyed by
  // SESSION rather than by ticket — a re-dispatch down the fallback chain
  // writes a second `agent_spawned` for the same session, and the last one is
  // the model that is actually running.
  //
  // The journal is the only source for the label. The harness has on-disk
  // evidence too (detectHarness), but the label names a row in `routing.yaml`
  // that nothing on disk points back to.
  #epochSpawn(journal, session) {
    let out = null
    for (const ev of journal) {
      if (ev.type !== 'agent_spawned' || ev.agent !== session) continue
      out = { model: ev.model ?? null, harness: ev.harness ?? null }
    }
    return out
  }

  async #resolveTicket(agentName, repo, ticket, result, w) {
    const wtPath = w?.wtPath ?? worktreePathFor(this.root, repo, ticket)
    const login = await this.deps.viewerLogin().catch(() => null)
    const out = await resolveAndLand({
      repo, ticket, agent: agentName, result, login,
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
    // recorded result ends the checklist, so an agent that goes straight from the
    // work to comment-close-report_result never gets held. Nothing here can
    // un-resolve that ticket — but the daemon can refuse to call it reviewed, and
    // this is the record a human reads afterwards. Sibling of the unmerged
    // warning in resolve.mjs, for the same reason: say it, do not hide it.
    if (!this.#epochScan(ticket, agentName).reviewApproved) {
      this.store.logEvent('resolved_unreviewed', { repo, ticket, agent: agentName })
      out.warnings.push('NO approved review gate for this dispatch — this ticket was resolved without anyone approving it')
    }
    this.store.logEvent('ticket_resolved', {
      repo, ticket, agent: agentName,
      comment: out.comment, close: out.close, map: out.map.state, land: out.land.state,
      pr: out.land.url ?? null, repaired: out.repaired,
    })
    const text = summariseOutcome(out)
    this.notify(ticket, `✅ ${repo}#${ticket} resolved — ${text}`)
    return text
  }

  // The map dispatch's whole ending (#160). Three acts, and each one is the
  // opposite of the ticket path's:
  //
  //   1. COMMENT — curia posts the agent's summary on the map, so the change
  //      has a dated record beside the body it changed. The ticket path only
  //      comments as a repair; here it is the point.
  //   2. UNCLAIM — the map goes back to unassigned. The ticket path closes; a
  //      map is the standing artifact and closing it would take the whole effort
  //      off every frontier.
  //   3. Nothing else. No close, no Decisions-so-far line, no branch, no
  //      merge check.
  //
  // The map edits themselves are NOT verified or repaired here, and cannot be:
  // curia has no expected value for a charting session, which is the same reason
  // #49 gave for having no verification gate at all. What the daemon can do is
  // say plainly what it did and did not check.
  async #finishCharting(agentName, repo, ticket, result, w, instruction) {
    const record = w ?? { repo, ticket, session: agentName }
    // The agent is still alive at report_result, so its credential copy stays
    // until the session is positively gone — the #noteNonClean rule, same
    // reason (#34's snapshot bound).
    const released = await this.#releaseClaim(record, 'charting agent reported in', { keepCredentials: true })
    let noted = false
    try {
      await this.deps.commentIssue(repo, ticket, chartingComment({
        agent: agentName, model: w?.model ?? null, instruction, result,
      }))
      noted = true
    } catch (e) {
      this.log(`could not post the charting summary on ${repo}#${ticket}: ${e.message}`)
    }
    this.store.logEvent('charting_finished', {
      repo, map: ticket, ticket, agent: agentName, status: result.status, commented: noted, released,
    })
    const clean = result.status === 'resolved'
    const bits = [
      noted ? 'summary posted on the map' : '⚠️ the summary comment could NOT be posted',
      released ? 'map unassigned' : '⚠️ the map is still assigned to the bot; reconcile will retry',
      'the map stays open',
    ]
    this.notify(ticket, `${clean ? '🗺️' : '↩️'} ${repo}#${ticket} charted (**${result.status}**) — ${bits.join('; ')}. Nobody reviewed these map edits: read them.`)
    return `charting recorded — ${bits.join('; ')}. Nothing was closed, resolved or pushed.`
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
  async #noteNonClean(agentName, repo, ticket, result, w) {
    const record = w ?? { repo, ticket, session: agentName }
    const released = await this.#releaseClaim(record, `agent reported ${result.status}`, { keepCredentials: true })
    let noted = false
    try {
      await this.deps.commentIssue(repo, ticket, nonCleanComment({ agent: agentName, result, released }))
      noted = true
    } catch (e) {
      this.log(`could not note the ${result.status} result on ${repo}#${ticket}: ${e.message}`)
    }
    this.store.logEvent('nonclean_noted', { repo, ticket, agent: agentName, status: result.status, released, noted })
    const tail = released
      ? 'claim released, ticket back on the frontier'
      : 'claim release FAILED — the ticket is still assigned; reconcile will retry'
    this.notify(ticket, `↩️ ${repo}#${ticket} NOT resolved (**${result.status}**) — ${tail}${noted ? ', reason noted on the ticket' : ', and the note could not be posted'}`)
    return `result recorded — nothing was resolved or pushed; ${tail}`
  }

  // Serialise this daemon's writes to one map body. GitHub has no conditional
  // issue update, so two agents appending Decisions-so-far lines concurrently
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

  // A preview outlives its agent unless someone withdraws it: `tailscale
  // serve --bg` config lives in tailscaled, not in this process. Every path
  // that ends a ticket goes through here.
  async #withdrawPreview(ticket, why) {
    if (!this.previews?.get(ticket)) return
    const r = await this.previews.withdraw(ticket).catch((e) => ({ ok: false, reason: e.message }))
    if (r.ok && r.withdrawn) this.log(`preview for ticket ${ticket} withdrawn (${why})`)
    else if (!r.ok) this.log(`WARNING: preview for ticket ${ticket} REMAINS PUBLISHED after ${why}: ${r.reason}`)
  }

  // Open escalations bound to THIS agent. The binding is the spawn binding —
  // the MCP URL and the Stop hook carry the same `agent=curia-<n>` — so an
  // overseer confirm on the same ticket is correctly not one of these: a
  // confirm is a question to a human about the agent, not a call the agent
  // is sitting in.
  #openEscalationsFor(agentName) {
    return this.store.openEscalations().filter((r) => r.agent === agentName)
  }

  // #47's evidence, in one place because two callers need it: the Stop hook's
  // decision and the terminal path. An open escalation bound to this agent means
  // it is blocked in a human call; the ONE thing that outranks that is positive
  // evidence the session is gone (killed between the hook's curl and this check),
  // because then the call can never resume. An indeterminate tmux read is not
  // evidence, and its safe direction is the block.
  async #humanBlockEvidence(agentName) {
    const open = this.#openEscalationsFor(agentName)
    // #165: a builder parked on a cross-check verdict is blocked in exactly the
    // same sense, and it has NO open escalation to show for it — the press
    // closed the gate record. Without this the Stop hook would nudge it toward
    // the `request_review` it is already sitting in, and the terminal path would
    // treat an idle agent as a finished one.
    if (this.#parkedOnCrossCheck(agentName)) {
      return { blocked: true, gone: false, open, crossCheck: true }
    }
    if (!open.length) return { blocked: false, gone: false, open }
    let gone = false
    try {
      gone = !(await this.deps.hasSession(agentName))
    } catch (e) {
      this.log(`agent_done ${agentName}: session presence indeterminate (${e.message}) — treating the open escalation as a live block`)
    }
    return { blocked: !gone, gone, open }
  }

  // Is this agent the builder parked inside `request_review` on a verdict
  // (#165)? The wait map is the record, and it is keyed by ticket — the agent
  // name is checked too, so a wait a previous dispatch of the same ticket left
  // behind cannot vouch for a fresh agent.
  #parkedOnCrossCheck(agentName) {
    const ticket = this.agents.get(agentName)?.ticket ?? String(agentName).match(SESSION_RE)?.[1] ?? null
    return ticket != null && this.reviewWaits.get(String(ticket))?.agent === agentName
  }

  #recordHumanBlock(agentName, open, { crossCheck = false } = {}) {
    const w = this.agents.get(agentName)
    const reviewing = open.some((r) => r.kind === REVIEW_KIND)
    if (w) w.state = crossCheck ? 'cross-checking' : (reviewing ? 'awaiting-review' : 'blocked')
    const ticket = w?.ticket ?? agentName.match(SESSION_RE)?.[1] ?? agentName
    this.store.logEvent('agent_blocked_on_human', {
      agent: agentName, ticket, repo: w?.repo,
      escalations: open.map((r) => r.id), awaiting_review: reviewing, cross_check: crossCheck,
    })
    if (crossCheck) {
      this.log(`agent_done ${agentName}: turn ended parked on a cross-check verdict — idle, not gone`)
      return
    }
    this.log(`agent_done ${agentName}: turn ended with ${open.map((r) => r.id).join(', ')} still open — ${reviewing ? 'awaiting review' : 'blocked on a human'}, not gone`)
  }

  async onAgentDone(agentName) {
    // #164: the reviewer's ending has none of the ticket's terminal acts in it —
    // no preview to withdraw, no claim to settle, no workspace lease to end, no
    // thread label to release. All of those belong to the builder, which is
    // still alive on the same ticket.
    if (this.#isReviewer(agentName)) return this.#reviewerDone(agentName)
    const w = this.agents.get(agentName)
    const m = agentName.match(SESSION_RE)
    const ticket = w?.ticket ?? (m ? m[1] : agentName)
    const resultsFile = path.join(this.dataDir, 'results', `${agentName}.json`)
    const hasResult = Boolean(w?.resultReceived) || fs.existsSync(resultsFile)

    // #47: the Stop hook fires when a TURN ends, which is not the same as an
    // agent ending. #35 caught the difference live — an agent that pushes
    // ask_human onto a background MCP task ends its turn while the call is
    // still pending, and every terminal act below then ran on a healthy blocked
    // agent: the preview was withdrawn out from under the human mid-review,
    // the record was marked failed, and the thread was told it had stopped
    // without a result.
    //
    // The daemon already held the evidence and did not consult it: an OPEN
    // escalation bound to this agent means it is blocked in `ask_human`,
    // exactly where #11 promises it stays. This is decided BEFORE the result
    // branch, because the question here is "is this agent still there", not
    // "did it finish" — and the result branch kills the session, which would
    // strand a question a human is still being asked. Nothing terminal happens;
    // the Stop that follows the answer is judged on its own, with no open
    // escalation left to defer on.
    const { blocked, open, crossCheck } = await this.#humanBlockEvidence(agentName)
    if (blocked) {
      this.#recordHumanBlock(agentName, open, { crossCheck })
      return
    }
    if (open.length) {
      // Positively gone with calls still open: the exit is abnormal after all and
      // the escalations must not keep asking — a human answering into a dead
      // agent gets a ✅ for an answer nothing will ever read.
      for (const r of open) {
        this.cancelEscalation(r.id, { by: 'agent-death' })
        this.store.logEvent('escalation_orphaned', { id: r.id, agent: agentName, ticket })
      }
      this.notify(ticket, `⚠️ \`${agentName}\` is gone while ${open.length} escalation(s) were still open — ${open.map((r) => `**${r.id}**`).join(', ')} cancelled: nothing is waiting for an answer any more`)
    }

    // Both branches: a finished agent's dev server is dead either way, so the
    // rule would publish a dead port (or whatever binds it next) — the exact
    // thing publish() refuses to create in the first place.
    await this.#withdrawPreview(ticket, hasResult ? 'agent finished' : 'agent exited without a result')
    if (hasResult) {
      this.store.logEvent('lifecycle_closed', { agent: agentName, ticket, repo: w?.repo })
      await this.deps.killSession(agentName).catch(() => {})
      this.agents.delete(agentName)
      // the OAuth credential copy never survives (a pre-#53 leftover collector)
      this.deps.removeCredentials(w?.cfgDir ?? cfgDirFor(this.root, agentName))
      // #54 item 7: the merge — not the result — is what ends the lease. Review
      // already happened, so "kept for review" no longer means anything; what
      // decides now is whether the code is in.
      const lease = await this.#endWorkspaceLease(agentName, ticket, w?.repo ?? this.#epochRepo(ticket))
      this.notify(ticket, `✅ \`${agentName}\` finished with a recorded result — session closed; ${lease}`)
      this.lapseConfirmsFor(agentName, `\`${agentName}\` finished`)
      this.expireNotesFor(agentName, ticket, 'finished')
      // terminal state ⇒ the ticket label comes off the thread (#93)
      await this.threads.release(ticket, 'finished').catch(() => {})
    } else {
      // result-less exit: the pane is the post-mortem evidence — keep it
      if (w) w.state = 'failed'
      this.store.logEvent('agent_abnormal_exit', { agent: agentName, ticket, repo: w?.repo })
      this.notify(ticket, `⚠️ \`${agentName}\` stopped WITHOUT reporting a result — session kept for post-mortem (\`/attach ${ticket}\`)`)
      // the agent the confirm described has exited, whatever the pane holds (#94)
      this.lapseConfirmsFor(agentName, `\`${agentName}\` stopped without a result`)
      this.expireNotesFor(agentName, ticket, 'stopped without a result')
    }
  }

  // The reviewer's terminal state (#164). Two outcomes, and the difference is
  // whether the verdict landed:
  //
  //   verdict in  — the reviewer did its whole job. The session and the checkout
  //                 go, because the artifact is what survives and the checkout is
  //                 a re-creatable read-only copy of a pushed sha.
  //   no verdict  — the pane and the checkout are the post-mortem evidence, the
  //                 same rule a result-less builder gets.
  //
  // Nothing here touches the ticket, the claim or the thread label. The builder
  // holds all three and is still working.
  async #reviewerDone(agentName) {
    const w = this.agents.get(agentName)
    const ticket = String(w?.ticket ?? agentName.match(REVIEW_SESSION_RE)?.[1] ?? agentName)
    const hasResult = Boolean(w?.resultReceived)
      || fs.existsSync(path.join(this.dataDir, 'results', `${agentName}.json`))
    if (!hasResult) {
      if (w) w.state = 'failed'
      this.store.logEvent('reviewer_abnormal_exit', { repo: w?.repo, ticket, agent: agentName })
      // #165: the builder may be parked at the gate on this reviewer. It is
      // released with the truth — no verdict — rather than left waiting on a
      // pane that is being kept only as evidence.
      this.#endReviewWait(ticket, 'the reviewer stopped without producing one')
      this.notify(ticket, `⚠️ \`${agentName}\` stopped WITHOUT a verdict — session and checkout kept for post-mortem (\`/attach ${ticket}\` names both). The builder is untouched: nothing about #${ticket} changed.`)
      return
    }
    this.store.logEvent('lifecycle_closed', { repo: w?.repo, ticket, agent: agentName, kind: 'reviewer' })
    await this.deps.killSession(agentName).catch(() => {})
    this.agents.delete(agentName)
    this.deps.removeCredentials(w?.cfgDir ?? cfgDirFor(this.root, agentName))
    const removed = await this.#removeReviewCheckout(w?.repo, ticket, w?.wtPath)
    this.notify(ticket, `✅ \`${agentName}\` finished — verdict captured; session closed${removed ? ', checkout removed' : ', checkout kept'}`)
    this.lapseConfirmsFor(agentName, `\`${agentName}\` finished`)
  }

  // The reviewer's checkout is a detached HEAD at a PUSHED sha, so it holds
  // nothing that exists nowhere else — which is exactly why it may be removed
  // without the evidence dance a builder's worktree needs. Failing to remove it
  // is rubble, never risk: the next cross-check on this ticket recreates it.
  async #removeReviewCheckout(repo, ticket, wtPath = null) {
    if (!repo) return false
    const target = wtPath ?? reviewPathFor(this.root, repo, ticket)
    if (!fs.existsSync(target)) return true
    try {
      await this.deps.removeWorktree(basePathFor(this.root, repo), target)
      return true
    } catch (e) {
      this.log(`review checkout ${target} could not be removed (${e.message}) — the next cross-check recreates it`)
      return false
    }
  }

  // Merge ends the workspace lease (#54 item 7), replacing "worktree, branch and
  // claim kept for review" — the review is over by now.
  //
  // Every branch here fails towards KEEPING the workspace. A worktree is the only
  // copy of anything not pushed, so "merged" has to be positively established:
  // an unreadable pull-request state, an unreadable git log, an unmerged pull
  // request and a missing repo all keep it, loudly. The remote branch is deleted
  // as a REPAIR only — the agent's own `gh pr merge --delete-branch` is what
  // normally does it.
  async #endWorkspaceLease(agentName, ticket, repo) {
    if (!repo) return 'worktree kept — curia could not tell which repo this ticket belongs to'
    const branch = branchFor(ticket)
    const basePath = basePathFor(this.root, repo)
    const wtPath = worktreePathFor(this.root, repo, ticket)

    let pr
    try {
      pr = await this.deps.findPullRequest(repo, branch)
    } catch (e) {
      this.store.logEvent('lease_kept', { repo, ticket, agent: agentName, branch, reason: `pull-request state unreadable: ${e.message}` })
      return `worktree and branch kept — curia could not read the pull-request state (${e.message})`
    }

    if (pr && pr.state !== 'MERGED') {
      this.store.logEvent('lease_kept', { repo, ticket, agent: agentName, branch, reason: `pull request is ${pr.state}` })
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
        this.store.logEvent('lease_kept', { repo, ticket, agent: agentName, branch, reason: 'no pull request, and the branch may hold commits' })
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
    this.store.logEvent('lease_released', { repo, ticket, agent: agentName, branch, merged: Boolean(pr), worktree_removed: removed })
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
    const live = this.agents.has(session) || await this.deps.hasSession(session).catch(() => false)
    if (!live) {
      // #164: a reviewer can outlive its builder — the builder finished, or was
      // cancelled first — and `cancel <n>` has to reach it either way, because
      // it is the only verb that ends an agent on this ticket.
      const reviewer = await this.#teardownReviewer(ticket, { by })
      if (reviewer) return reviewer
      return `nothing to cancel — no live agent on #${ticket}`
    }
    return this.#teardown(ticket, { by })
  }

  // The bulk verb (#81), immediate like the single one: the same teardown,
  // agent by agent. Sessions this process does not track are cancelled too —
  // `cancel all` means all.
  async cancelAll({ by } = {}) {
    const listed = await this.#liveTargets()
    if (listed.error) return listed.error
    const { targets, rows } = listed
    if (!targets.length) return 'no live agents to cancel'
    for (const t of targets) {
      await this.#teardown(t.ticket, { by }).catch((e) => this.log(`cancel of ${t.session} failed:`, e.message))
    }
    return `⚰️ cancelled ${targets.length} agent(s):\n${rows.join('\n')}`
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
    const sessions = [...new Set([...this.agents.keys(), ...live])].sort()
    const targets = sessions.map((s) => this.#targetFor(s))
    const rows = targets.map((t) => (t.state ? `• \`${t.session}\` ${t.repo}#${t.ticket} — **${t.state}**` : `• \`${t.session}\` — untracked`))
    return { targets, rows }
  }

  #targetFor(session) {
    const ticket = session.match(SESSION_RE)?.[1] ?? session
    const w = this.agents.get(session)
    return w
      ? { session, ticket, repo: w.repo, state: w.state, instance: w.instance }
      : { session, ticket, repo: null, state: null, instance: `${session}@untracked` }
  }

  // The interpreted cancel (#94): open the confirm, execute nothing. The
  // confirm is INSTANCE-bound and lapses when its agent exits; no expiry
  // clock. A newer confirm on the same instance supersedes the older
  // (store.open).
  async requestCancel(n, { threadId = null } = {}) {
    const ticket = String(n)
    const session = `curia-${ticket}`
    let target = null
    if (this.agents.has(session)) target = this.#targetFor(session)
    else if (await this.deps.hasSession(session).catch(() => false)) target = this.#targetFor(session)
    if (!target) return `nothing to cancel — no live agent on #${ticket}`
    const desc = target.state ? `(${target.repo}#${ticket}, **${target.state}**)` : '(untracked)'
    const record = this.openConfirm({
      ticket,
      prompt: `Cancel \`${session}\` ${desc}? This kills the session, removes the worktree and re-frontiers the ticket.`,
      action: { verb: 'cancel', targets: [target] },
      originThreadId: threadId,
    })
    if (!record) return '⚠️ could not open the confirm — nothing was cancelled'
    return `⚙️ posted confirm **${record.id}** with ✅/❌ buttons ${this.#confirmPlace(threadId)} — nothing happens until ✅, and it lapses if the agent exits first`
  }

  // What the reply says about where the buttons are (#218). It read "in the
  // ticket thread" for every cancel, which was the fault written down: the
  // confirm renders where the command was typed. The same threadId decides both,
  // so the words and the message can never disagree.
  #confirmPlace(threadId) {
    return threadId ? 'in this thread' : `in #${this.channelName}`
  }

  async requestCancelAll({ threadId = null } = {}) {
    const listed = await this.#liveTargets()
    if (listed.error) return listed.error
    const { targets, rows } = listed
    if (!targets.length) return 'no live agents to cancel'
    const record = this.openConfirm({
      ticket: 'all',
      prompt: `Cancel ALL ${targets.length} agent(s)? Each session is killed, its worktree removed and its ticket re-frontiered:\n${rows.join('\n')}`,
      action: { verb: 'cancel', targets },
      originThreadId: threadId,
    })
    if (!record) return '⚠️ could not open the confirm — nothing was cancelled'
    return `⚙️ posted confirm **${record.id}** for ${targets.length} agent(s) ${this.#confirmPlace(threadId)} — nothing happens until ✅:\n${rows.join('\n')}`
  }

  // The executing path (#94): button → daemon. gate.answer calls this after
  // the record closed (first-valid-wins already decided who spoke). Approve
  // tears down every target whose instance is STILL the live one; a target
  // whose agent exited or was replaced since the confirm was posted is
  // skipped, never guessed at.
  async onConfirmAnswered(record) {
    const { verb, targets = [] } = record.action ?? {}
    if (verb !== 'cancel') {
      this.log(`confirm ${record.id} carries unknown verb "${verb}" — nothing executed`)
      return
    }
    const name = targets.length === 1 ? `\`${targets[0].session}\`` : `${targets.length} agent(s)`
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
    const w = this.agents.get(t.session)
    if (w) return w.instance === t.instance
    if (!String(t.instance).endsWith('@untracked')) return false
    return this.deps.hasSession(t.session).catch(() => false)
  }

  #noteOrigin(record, text) {
    if (record.origin_thread_id) this.overseerNote(record.origin_thread_id, text)
  }

  // Confirms lapse the moment their agent exits (#89): every exit path calls
  // this with the dying session, so a stale confirm can never hit a successor
  // agent. Session-name match suffices — an open confirm can only describe
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

  // The same rule for operator notes (#208), and every exit path calls this
  // the way it calls lapseConfirmsFor above: the words were about what THAT
  // agent was doing, so a successor on the session must never read them. The
  // #139 hand-off carries no instance stamp and is untouched, because
  // reaching the successor is its whole point.
  //
  // The count, never the words: the journal keeps the text, and the thread
  // says how many died so the operator knows to say them again. A note that
  // vanishes with no line is the dead end #170 was about.
  //
  // `liveInstance` is null at every death. Adoption after a restart passes
  // the FRESH instance instead, which expires the pre-restart words on the
  // same rule that lapses a pre-restart confirm.
  expireNotesFor(session, ticket, why, liveInstance = null) {
    const n = this.store.expireAgentNotes(session, liveInstance)
    if (!n) return
    this.log(`${n} operator note(s) for ${session} expired — ${why}`)
    const again = liveInstance
      ? 'Say them again in this thread.'
      : `Say them again after \`resume ${ticket}\`.`
    this.notify(ticket, `📭 \`${session}\` ${why} with ${n} operator note${n === 1 ? '' : 's'} it never read. A note dies with the agent it was typed at, so nothing carries these words to a successor. ${again}`)
  }

  // The teardown a confirmed cancel runs — shared verbatim by cancel and
  // cancelAll, so the bulk verb can never drift from the single one.
  async #teardown(ticket, { by } = {}) {
    const session = `curia-${ticket}`
    const w = this.agents.get(session)
    // #164: cancelling a ticket ends every agent on it. A reviewer left reading
    // a diff whose builder is gone burns a slot on a verdict nobody will use.
    const reviewerLine = await this.#teardownReviewer(ticket, { by })
    await this.#withdrawPreview(ticket, 'ticket cancelled')
    await this.deps.killSession(session).catch(() => {})
    // The other half of #47: this is the one path that KNOWS the agent is
    // gone. An agent cancelled while blocked leaves its ask_human asking —
    // the record stays open, the thread keeps nudging every ~30 min, and an
    // answer would settle a resolver whose agent no longer exists. Cancel
    // them here, where the death is certain.
    for (const r of this.#openEscalationsFor(session)) {
      this.cancelEscalation(r.id, { by: 'cancel' })
      this.store.logEvent('escalation_orphaned', { id: r.id, agent: session, ticket })
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
    this.deps.forgetAgentToken(this.dataDir, session)
    this.agents.delete(session)
    if (w) {
      if (released) {
        this.store.logEvent('dispatch_unclaimed', { repo: w.repo, ticket, agent: session, reason: 'cancelled', by: by ?? 'unknown' })
      } else {
        this.store.logEvent('unclaim_failed', { repo: w.repo, ticket, agent: session, reason: 'cancelled', by: by ?? 'unknown', error: failure ?? 'no viewer login' })
      }
    }
    // status's recent-cancelled view reads this event; the unclaim events
    // above cannot carry it because an untracked cancel writes none.
    this.store.logEvent('agent_cancelled', { repo: w?.repo, ticket, agent: session, by: by ?? 'unknown', tracked: Boolean(w) })
    const tail = w
      ? (released ? ', worktree removed, ticket re-frontiered' : ', worktree removed — but the claim release FAILED: the issue is still assigned; reconcile will retry')
      : ' (was untracked; GitHub claim untouched)'
    const msg = `⚰️ \`${session}\` cancelled — session killed${tail}${reviewerLine ? `\n${reviewerLine}` : ''}`
    this.notify(ticket, msg)
    // the agent is positively gone ⇒ any OTHER open confirm on it lapses (#94)
    this.lapseConfirmsFor(session, `\`${session}\` was cancelled`)
    this.expireNotesFor(session, ticket, 'was cancelled')
    // The binding stays (#140): a cancel ends the AGENT and releases the
    // claim, but the ticket goes back to the frontier — a later dispatch
    // belongs in the thread its history lives in. The label comes off when
    // the ticket itself closes (reconcile's sweep reads GitHub for that).
    //
    // The NAME does change (#200): 🎫 → ⚰️, so the thread list says a cancel
    // happened without a message opened. A later dispatch relabels it 🎫.
    await Promise.resolve(this.threads.cancelled?.(ticket)).catch((e) => this.log(`thread rename for ${session} failed:`, e.message))
    return msg
  }

  // End a live cross-check reviewer on this ticket, if there is one (#164).
  // Returns the line to say about it, or null when there was nothing to end.
  // Untracked sessions are torn down too — the reviewer's whole state is one
  // pane and one throwaway checkout, so there is nothing here to keep.
  async #teardownReviewer(ticket, { by } = {}) {
    const session = reviewSessionFor(ticket)
    const w = this.agents.get(session)
    if (!w && !(await this.deps.hasSession(session).catch(() => false))) return null
    await this.deps.killSession(session).catch(() => {})
    for (const r of this.#openEscalationsFor(session)) {
      this.cancelEscalation(r.id, { by: 'cancel' })
      this.store.logEvent('escalation_orphaned', { id: r.id, agent: session, ticket })
    }
    this.agents.delete(session)
    const removed = await this.#removeReviewCheckout(w?.repo ?? this.#epochRepo(ticket), ticket, w?.wtPath)
    this.deps.removeConfigDir(w?.cfgDir ?? cfgDirFor(this.root, session))
    this.deps.forgetAgentToken(this.dataDir, session)
    this.store.logEvent('reviewer_cancelled', { repo: w?.repo, ticket, agent: session, by: by ?? 'unknown', tracked: Boolean(w) })
    this.lapseConfirmsFor(session, `\`${session}\` was cancelled`)
    // #165: a cancel of the reviewer alone releases the builder back to the
    // gate. A cancel of both settles the same wait, and the builder's own MCP
    // call dies with its session a moment later — settling twice is a no-op.
    this.#endReviewWait(ticket, 'the reviewer was cancelled')
    return `⚰️ \`${session}\` cancelled too — the cross-check ends with no verdict${removed ? ', checkout removed' : ', checkout kept'}`
  }

  // ---- resume --------------------------------------------------------------------

  // The resume contract (#81): a fresh agent on the ticket, inheriting the
  // surviving worktree and — since #177 — the model of the last spawn, never
  // the conversation. A live agent is refused flat — resume means "the agent is
  // gone", and the teardown-and-redispatch offer already lives on `start`.
  async resume(n, { repo, model, by, threadId } = {}) {
    const ticket = String(n)
    const session = `curia-${ticket}`
    if (this.agents.has(session) || this.inFlight.has(session) || await this.deps.hasSession(session).catch(() => false)) {
      return `▶️ \`${session}\` is already running — \`cancel ${ticket}\` first, or \`attach ${ticket}\``
    }
    // A resumed map dispatch inherits the instruction that rode the original
    // one (#160). Without it the fresh charting agent would open by asking what
    // should change — a question the operator already answered, into a session
    // that is gone. `start` re-reads the label and decides again, so an issue
    // that is no longer a map degrades to an ordinary dispatch and the inherited
    // sentence is dropped, never refused (the `!reuse` clause in start).
    const { instruction } = this.#epochCharting(ticket, session)
    return this.start(ticket, { repo, model: model ?? this.#inheritedModel(session), instruction, by, reuse: true, threadId })
  }

  // What a resume runs on (#177). Resume re-routed from the labels, so a ticket
  // that ran on gpt came back on opus: `resume` supplied no model and the
  // journal was never asked. The worktree was inherited and the lane was not.
  //
  // The MODEL is what is inherited, and the harness follows it. `routing.yaml`
  // is the authority on which harness a model runs on, so a journalled harness
  // that disagrees with the config today is exactly the contradiction the other
  // half of #177 closes — the journal answers the one question config cannot,
  // which is which ROW was picked.
  //
  // Two degradations, both back to ordinary routing rather than a refusal,
  // because the surviving worktree is resumable either way: a session with no
  // spawn in the journal (the journal was rotated, or the agent predates this),
  // and a label `routing.yaml` no longer carries (a row renamed or removed).
  #inheritedModel(session) {
    const last = this.#epochSpawn(this.#readJournal(), session)?.model ?? null
    return last && this.routing.models?.[last] ? last : undefined
  }

  // Bulk resume (#81): every surviving worktree without a live agent, behind
  // ONE confirm carrying count and list. A closed ticket in the list refuses at
  // dispatch and says so in its own thread.
  async resumeAll({ by } = {}) {
    let targets
    try {
      targets = await this.#resumable()
    } catch (e) {
      return `❌ resume all refused — the tmux session list is indeterminate (${e.message}); retry, or resume tickets one by one`
    }
    if (!targets.length) return 'nothing to resume — no surviving worktree without a live agent'
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

  // Surviving worktrees with no live agent, across the watch list. Throws on
  // an indeterminate session list — "no sessions" would make every worktree
  // look resumable and re-dispatch live agents' tickets.
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
        if (live.has(session) || this.agents.has(session) || this.inFlight.has(session)) continue
        out.push({ repo: entry.repo, ticket: d })
      }
    }
    return out
  }

  // ---- status --------------------------------------------------------------------

  async status() {
    const live = (await this.deps.listSessions()).filter((s) => s.startsWith('curia-'))
    // #54 item 9: *awaiting review* is read off the open escalation record, not
    // off the agent record, so it is also right for an agent this process
    // adopted at reconcile and whose in-memory state is a guess.
    const open = this.store.openEscalations()
    const reviewing = new Set(open
      .filter((r) => r.kind === REVIEW_KIND)
      .map((r) => r.agent))
    const agents = [...this.agents.values()].map((w) => ({
      session: w.session,
      repo: w.repo,
      ticket: w.ticket,
      title: w.title,
      model: w.model,
      // #164: two agents can sit on one ticket now, so a row has to say which
      // one it is. Without it `/status` shows the same ticket twice.
      reviewer: Boolean(w.reviewer),
      state: reviewing.has(w.session) ? 'awaiting-review' : w.state,
      uptime_s: w.spawnedAt ? Math.round((Date.now() - w.spawnedAt) / 1000) : null,
      result_received: w.resultReceived,
      tmux_live: live.includes(w.session),
      // where a waiting agent waits (#81's grown status): the open escalation
      // records bound to it — id and kind, enough to name the thread and ask
      waiting_on: open.filter((r) => r.agent === w.session).map((r) => ({ id: r.id, kind: r.kind })),
    }))
    const untracked = live.filter((s) => !this.agents.has(s))
    return { agents, untracked, recent: this.#recentOutcomes() }
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
    return [...of({ agent_cancelled: 'cancelled' }), ...of({ lifecycle_closed: 'finished' }), ...of({ agent_died: 'died' })]
  }

  // ---- liveness sweep (#138) -------------------------------------------------------

  // #108 items 19/20: agent death used to be discovered only at boot
  // reconcile or when a human read /status — between those, every surface
  // trusted the last journal event, and the status line said "working" about
  // a killed agent. Every dispatch tick, ask tmux about each tracked agent;
  // a session that is gone WITHOUT a teardown order is a death. One
  // `agent_died` event flips every surface at once. Same evidence rule as
  // reconcile: an indeterminate hasSession is not absence — skip the agent
  // this pass. In-pane wedge detection is out of scope on purpose (item 8's
  // heartbeat layer): session-exists is the only question asked here.
  async livenessSweep() {
    for (const w of [...this.agents.values()]) {
      if (this.orderedKills.has(w.session)) continue
      let present
      try {
        present = await this.deps.hasSession(w.session)
      } catch {
        continue
      }
      if (present) continue
      // re-judge after the await: a teardown or replacement that started while
      // tmux was being asked makes this absence an ordered one after all
      if (this.agents.get(w.session) !== w || this.orderedKills.has(w.session)) continue
      await this.#onAgentDied(w).catch((e) => this.log(`agent_died handling for ${w.session} failed:`, e.message))
    }
  }

  async #onAgentDied(w) {
    const { session, ticket, repo } = w
    // A dead session WITH a recorded result is a finishing agent whose Stop
    // hook never landed — the normal close, not a death. onAgentDone already
    // handles exactly that shape.
    if (w.resultReceived || fs.existsSync(path.join(this.dataDir, 'results', `${session}.json`))) {
      return this.onAgentDone(session)
    }
    // #164: a reviewer that died holds no claim to settle and no question to
    // keep open. Say it in the thread and leave the checkout — the builder is
    // still working on the same ticket, and a second press starts a fresh
    // reviewer over this checkout.
    if (w.reviewer) {
      this.agents.delete(session)
      this.store.logEvent('agent_died', { repo, ticket, agent: session, kind: 'reviewer' })
      this.lapseConfirmsFor(session, `\`${session}\` died`)
      this.deps.removeCredentials(w.cfgDir ?? cfgDirFor(this.root, session))
      this.log(`liveness sweep: reviewer ${session} is gone with no teardown order`)
      this.notify(ticket, `⚰️ \`${session}\` is gone without a teardown order and left NO verdict — nothing about #${ticket} changed. Ask for the cross-check again to start a fresh reviewer.`)
      return
    }
    this.agents.delete(session)
    this.store.logEvent('agent_died', { repo, ticket, agent: session })
    this.log(`liveness sweep: ${session} is gone with no teardown order`)

    // The surface half of item 19: the agent's open questions STAY open and
    // answerable — unlike the ordered-teardown paths, nothing here cancels
    // them, because the ticket continues and the answer has a place to go.
    // (#139 hands the recorded answer to the resumed agent.) The journal
    // line per record is the durable fact that hand-off will read.
    const open = this.#openEscalationsFor(session)
    for (const r of open) {
      this.store.logEvent('escalation_agent_died', { id: r.id, agent: session, ticket })
    }
    // a dead agent's dev server died with it — never publish a dead port
    await this.#withdrawPreview(ticket, 'agent died')
    // an open confirm describes an instance that no longer exists (#94)
    this.lapseConfirmsFor(session, `\`${session}\` died`)
    this.expireNotesFor(session, ticket, 'died')
    // the session is positively gone, so nothing later collects the copy
    this.deps.removeCredentials(w.cfgDir ?? cfgDirFor(this.root, session))

    // The claim decision is boot reconcile's, shared verbatim: an open pull
    // request keeps the claim (awaiting review), anything else releases it.
    // Unreadable evidence decides nothing — reconcile retries.
    let claimLine
    try {
      const outcome = await this.#settleDeadClaim({ repo, ticket, session })
      // A released MAP claim is not a re-frontiering: a map is never on a
      // frontier, so nothing will pick it up again on its own (#160). Saying so
      // matters — the operator has to know the next move is theirs.
      const charting = this.#epochCharting(ticket, session).charting
      claimLine = {
        kept: 'its pull request is open and awaiting review, so the claim stays',
        released: charting
          ? 'the map is unassigned again, and whatever this agent already wrote to it STANDS'
          : 'claim released, ticket re-frontiered',
        'not-ours': charting ? 'the map is no longer claimed by curia' : 'the ticket is no longer claimed by curia',
      }[outcome]
    } catch (e) {
      claimLine = `the claim decision failed (${e.message}) — reconcile will retry`
    }
    const escLine = open.length
      ? ` ${open.length} open question(s) — ${open.map((r) => `**${r.id}**`).join(', ')} — stay answerable: an answer there is recorded and handed to the resumed agent.`
      : ''
    this.notify(ticket, `⚰️ \`${session}\` is gone without a teardown order — ${claimLine}.${escLine} \`resume ${ticket}\` starts a fresh agent on the surviving worktree`)
  }

  // ---- reconcile -----------------------------------------------------------------

  // Three sources — GitHub, `tmux ls`, the journal — settled answer 7, with
  // every journal-as-current-state read EPOCH-SCOPED: judged only against
  // events after the ticket's latest dispatch_claimed/agent_spawned. Sweeps
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
      // `login`; with a null login every live agent looks unowned and the
      // orphan sweep would kill its session AND `git worktree remove --force`
      // its uncommitted output — on nothing worse than a transient
      // `gh api user` failure. A failed identity read is a failed pass.
      this.store.logEvent('reconcile_identity_unknown', { boot })
      this.log('reconcile: no gh viewer identity this pass — skipping session adoption, orphan sweep and dead-claim release')
    } else {
      // Same rule for the tmux read: an indeterminate session list (wedged
      // server, foreign socket, tmux missing, the 5 s timeout) is NOT "no
      // sessions". Treating it as empty would make every open claim look dead
      // — unclaiming live agents and re-frontiering their tickets — and let
      // a re-dispatch force-remove a live agent's worktree. Skip both passes.
      this.store.logEvent('reconcile_sessions_indeterminate', { boot, error: ctx.sessionsError })
      this.log(`reconcile: tmux session list indeterminate this pass (${ctx.sessionsError}) — skipping session adoption, orphan sweep and dead-claim release`)
    }

    // #164: reviewers hold no claim, so they need no viewer identity — only a
    // determinate session list. Run before the three sweeps below, because
    // adoption is what puts a live reviewer into `this.agents` and every one of
    // them reads that map to decide what is abandoned.
    if (ctx.sessions) await this.#reconcileReviewers(ctx)

    // The credential sweep needs only a DETERMINATE session list, not the
    // viewer identity: a cfg dir whose session is gone belongs to no live
    // agent whoever owns the ticket.
    if (ctx.sessions) this.#sweepAbandonedCredentials(ctx.allSessions)

    // Same rule for the containers (#156): a determinate session list is all
    // this needs, because a container whose pane is gone belongs to no live
    // agent whoever owns the ticket.
    if (ctx.sessions) await this.#sweepContainers(ctx.allSessions)

    // And for the agent tokens (#159). The teardown paths that destroy a config
    // dir forget the token beside it, but the two terminal states that KEEP the
    // whole workspace for post-mortem do not — so a token outlives its agent
    // exactly as an old credential copy used to, and gets collected here once
    // tmux positively says the session is gone.
    if (ctx.sessions) {
      const swept = this.deps.sweepAgentTokens(this.dataDir, [
        ...ctx.allSessions, ...this.agents.keys(), ...this.inFlight,
      ])
      for (const agent of swept) this.log(`reconcile: forgot the loopback token of dead ${agent}`)
    }

    // Ticket-label sweep (#93, narrowed by #140): the label comes off only on
    // a TICKET-terminal state — the issue is positively closed (or positively
    // absent from every candidate repo). A dead agent or a released claim is
    // NOT terminal: the binding stands, so a resumed agent lands back in the
    // thread its history, breadcrumbs and recorded answers live in. Same
    // evidence rule as every sweep: only a determinate session list, and an
    // unreadable issue keeps the label for the next pass. An open escalation
    // on the ticket keeps the label — a human is still being asked there
    // (awaiting review across a reboot), and its traffic must keep landing in
    // the labeled thread.
    if (ctx.sessions && typeof this.store.boundTickets === 'function') {
      const asked = new Set(this.store.openEscalations().map((r) => String(r.ticket)))
      for (const ticket of this.store.boundTickets()) {
        const session = `curia-${ticket}`
        if (ctx.sessions.includes(session) || this.agents.has(session) || this.inFlight.has(session)) continue
        if (asked.has(String(ticket))) continue
        const epoch = ctx.epochs.get(String(ticket))
        const reposToCheck = epoch?.repo ? [epoch.repo] : this.config.watch.map((w) => w.repo)
        let terminal = true
        for (const repo of reposToCheck) {
          if (ctx.failedRepos.has(repo)) { terminal = false; break }
          let issue
          try {
            issue = await ctx.getIssue(repo, ticket)
          } catch (e) {
            ctx.skipRepo(repo, e)
            terminal = false
            break
          }
          if (issue && issue.state !== 'closed') { terminal = false; break }
        }
        if (!terminal) continue
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
      if ((ev.type === 'dispatch_claimed' || ev.type === 'agent_spawned') && ev.ticket != null) {
        epochs.set(String(ev.ticket), { idx, repo: ev.repo })
      }
    })

    const login = await this.deps.viewerLogin().catch(() => null)
    // sessions: array on positive evidence (a real listing, or a confirmed
    // "no server"); null when the read failed and the list is indeterminate
    let sessions = null
    let sessionsError = null
    // #164: two lists off one read. `sessions` stays the BUILDER sessions,
    // because every ticket pass below reasons about a claim a reviewer does not
    // hold; `allSessions` is what the resource sweeps (containers, credentials,
    // tokens) need, because a live reviewer owns all three and a sweep blind to
    // it would collect them out from under a running agent.
    let reviewSessions = null
    try {
      const live = await this.deps.listSessions()
      sessions = live.filter((s) => SESSION_RE.test(s))
      reviewSessions = live.filter((s) => REVIEW_SESSION_RE.test(s))
    } catch (e) {
      sessionsError = e.message
    }
    const failedRepos = new Set()
    const issueCache = new Map()

    const ctx = {
      journal, epochs, login, sessions, reviewSessions, sessionsError, failedRepos,
      allSessions: sessions ? [...sessions, ...reviewSessions] : null,
    }
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
      if (this.agents.has(session) || this.inFlight.has(session)) continue
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
          // #157: what the container publishes is the preview bound, and this
          // record is being rebuilt with every spawn-time fact missing. Read it
          // back from docker, which is where a running container's ports live —
          // otherwise an adopted agent either loses `publish_preview` for the
          // rest of its life, or keeps it with no bound and can publish another
          // agent's port. Absence and an unreadable docker both yield null,
          // which refuses every publish: the safe direction for a bound.
          const ports = this.config.sandbox
            ? await this.deps.containerPorts(session).catch((e) => {
              this.log(`reconcile: could not read the published ports of ${session} (${e.message}) — previews are refused for it`)
              return []
            })
            : []
          // #187: the model and the harness are spawn-time facts, and the
          // journal already wrote both down. Rebuilding the record without
          // them cost the status line two meters: no model means no routing
          // spec, and the account bars hang off that spec. The journal is the
          // state home for what a restart cannot re-derive, so it answers here
          // exactly as it does for the repo and the charting kind.
          const spawn = this.#epochSpawn(journal, session)
          // a FRESH instance id: any confirm bound before the restart lapses
          // at boot rather than matching an adopted agent it never described
          const instance = `${session}@adopted-${Date.now()}`
          this.agents.set(session, {
            repo, ticket: n, title: issue.title, session, instance,
            wtPath, cfgDir: cfgDirFor(this.root, session), promptFile: path.join(cfgDirFor(this.root, session), 'prompt.md'),
            model: spawn?.model ?? null, requestedModel: null,
            harness: spawn?.harness ?? null,
            provider: this.routing.models[spawn?.model]?.provider ?? null,
            ports: ports.length ? ports : null,
            sandbox: ports.length ? 'docker' : null,
            spawnedAt: null, state: 'ready',
            resultReceived: fs.existsSync(path.join(this.dataDir, 'results', `${session}.json`)),
          })
          this.log(`reconcile: re-adopted live agent ${session} (${repo}#${n})`)
          // The same reason the confirms lapse here (#208): a pre-restart note
          // named a pre-restart instance, and this one is new. The agent IS
          // running, so the way out is the thread rather than a resume.
          this.expireNotesFor(session, String(n), 'was adopted after a daemon restart', instance)
          adopted = true
          break
        }
      }
      if (adopted || sawFailure) continue

      // #41 guard, BEFORE the sweep: a live session that already reported a
      // result is a FINISHING agent, not an orphan. Its ticket is closed
      // (the agent resolved it) and its claim may already be released, so every
      // positive-evidence test above now reads "orphan" — on a session whose
      // worktree may still hold the only copy of the commits.
      const reported = journal.some((ev, i) => i > (epoch?.idx ?? -1)
        && (ev.type === 'result' || ev.type === 'ticket_resolved')
        && (ev.agent === session || String(ev.ticket ?? '') === n))
      if (reported) {
        this.store.logEvent('orphan_sweep_skipped', { agent: session, ticket: n, reason: 'reported a result after its dispatch' })
        this.log(`reconcile: not sweeping ${session} — it reported a result after its dispatch`)
        continue
      }

      // positive evidence from every candidate repo: closed / unassigned /
      // absent everywhere ⇒ orphan
      this.store.logEvent('orphan_swept', { agent: session, ticket: n })
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
      this.deps.forgetAgentToken(this.dataDir, session)
      this.log(`reconcile: swept orphan ${session}`)
    }
  }

  // Live `curia-review-<n>` sessions (#164): re-adopt the ones the journal can
  // describe, sweep the ones it cannot.
  //
  // Adoption is not a nicety here — it is what keeps the verdict. A reviewer's
  // one output travels through `report_result`, and `onResult` needs a record to
  // know which ticket the verdict is about. Its agent token survives a restart
  // on disk, so the call itself still arrives; without the record the daemon
  // would authenticate the reviewer and then throw its verdict away.
  //
  // There is no GitHub read and no claim decision, because a reviewer holds
  // neither. The journal is the whole source, exactly as it is for the model and
  // harness of a re-adopted builder (#187).
  async #reconcileReviewers({ journal, reviewSessions }) {
    for (const session of reviewSessions) {
      if (this.agents.has(session) || this.inFlight.has(session)) continue
      let spawn = null
      for (const ev of journal) {
        if (ev.type === 'reviewer_spawned' && ev.agent === session) spawn = ev
      }
      if (!spawn) {
        // A reviewer curia cannot describe cannot be resumed, cannot report and
        // cannot be attributed to a ticket. Sweeping is the honest answer: the
        // cross-check is one press away from starting again.
        this.store.logEvent('orphan_reviewer_swept', { agent: session })
        await this.deps.killSession(session).catch(() => {})
        try {
          this.deps.removeConfigDir(cfgDirFor(this.root, session))
        } catch (e) {
          this.log(`reconcile: could not remove the config dir of swept reviewer ${session} (${e.message})`)
        }
        this.deps.forgetAgentToken(this.dataDir, session)
        this.log(`reconcile: swept reviewer ${session} — the journal says nothing about it`)
        continue
      }
      const ticket = String(spawn.ticket)
      const cfgDir = cfgDirFor(this.root, session)
      this.agents.set(session, {
        repo: spawn.repo,
        ticket,
        title: '',
        session,
        // A FRESH instance id, the same rule adoption gives a builder: a confirm
        // bound before the restart must lapse rather than match this agent.
        instance: `${session}@adopted-${Date.now()}`,
        wtPath: spawn.checkout ?? reviewPathFor(this.root, spawn.repo, ticket),
        cfgDir,
        promptFile: path.join(cfgDir, 'prompt.md'),
        model: spawn.model ?? null,
        requestedModel: spawn.model ?? null,
        harness: spawn.harness ?? null,
        provider: this.routing.models[spawn.model]?.provider ?? null,
        ports: null,
        sandbox: spawn.sandbox ?? null,
        spawnedAt: null,
        state: 'ready',
        resultReceived: fs.existsSync(path.join(this.dataDir, 'results', `${session}.json`)),
        reviewer: true,
        builderModel: spawn.builder_model ?? null,
        sameProvider: Boolean(spawn.same_provider),
        sha: spawn.sha ?? null,
        baseBranch: spawn.base_branch ?? null,
      })
      this.log(`reconcile: re-adopted live reviewer ${session} (${spawn.repo}#${ticket})`)
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
      this.store.logEvent('orphan_worktree_kept', { agent: session, ticket: n, repo, path: wt, reason: why })
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
      if (sessions.includes(session) || this.agents.has(session) || this.inFlight.has(session)) continue
      const closedAfterEpoch = journal.some((ev, i) => i > idx
        && (ev.type === 'result' || ev.type === 'lifecycle_closed' || ev.type === 'dispatch_unclaimed')
        && (ev.agent === session || String(ev.ticket ?? '') === ticket))
      if (closedAfterEpoch) continue
      try {
        await this.#settleDeadClaim({ repo, ticket, session, login, getIssue })
      } catch (e) {
        skipRepo(repo, e)
      }
    }
  }

  // The one dead-claim decision, shared by reconcile and the liveness sweep
  // (#138). #54 item 5: open + assigned + no live session + no result is ALSO
  // the shape of *awaiting review* — an agent whose box rebooted while a human
  // sat on the gate. An open pull request from `curia/<n>` says the work is
  // real and waiting on a person, so the claim is not dead and re-dispatch is
  // not the answer. Positive evidence only: an unreadable viewer identity,
  // issue or pull-request state THROWS, and the caller skips the pass — the
  // same rule the rest of reconcile runs on. A failed unclaim throws too;
  // nothing here journals dispatch_unclaimed, so reconcile keeps retrying.
  async #settleDeadClaim({ repo, ticket, session, login = null, getIssue = null }) {
    const viewer = login ?? await this.deps.viewerLogin()
    const issue = getIssue
      ? await getIssue(repo, ticket)
      : await this.deps.fetchIssue(repo, ticket).catch((e) => {
        if (ISSUE_ABSENT_RE.test(e.message)) return null // positively absent
        throw e
      })
    if (!(issue && issue.state === 'open' && (issue.assignees ?? []).some((a) => a.login === viewer))) {
      return 'not-ours'
    }
    const pr = await this.deps.findPullRequest(repo, branchFor(ticket))
    if (pr && pr.state === 'OPEN') {
      this.store.logEvent('dead_claim_kept_awaiting_review', { repo, ticket, agent: session, pr: pr.url })
      this.log(`keeping the claim on ${repo}#${ticket} — ${pr.url} is open and awaiting review`)
      return 'kept'
    }
    await this.deps.unclaim(repo, ticket, viewer)
    this.store.logEvent('dead_claim_released', { repo, ticket, agent: session })
    this.log(`released dead claim ${repo}#${ticket}`)
    return 'released'
  }

  // Abandoned credential collection — a pre-#53 leftover collector now.
  // Agents no longer hold a credential of their own (agentEnv shares the
  // host store), so a fresh cfg dir has nothing to collect and this is a no-op
  // for it. It still runs because cfg dirs seeded before #53 hold a real host
  // refresh token on disk, and the two terminal states that deliberately keep
  // the whole workspace for post-mortem (onAgentDone's abnormal-exit branch
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
      // #164: a reviewer's config dir holds the same credential copy a
      // builder's does, and it is abandoned by the same rule.
      if (!SESSION_RE.test(dir) && !REVIEW_SESSION_RE.test(dir)) continue
      if (sessions.includes(dir) || this.agents.has(dir) || this.inFlight.has(dir)) continue
      const cfgDir = cfgDirFor(this.root, dir)
      if (!fs.existsSync(path.join(cfgDir, '.credentials.json'))) continue
      this.deps.removeCredentials(cfgDir)
      this.store.logEvent('credentials_swept', { agent: dir })
      this.log(`reconcile: swept the OAuth credential copy of dead ${dir} (workspace kept)`)
    }
  }

  // Containers whose pane is gone (#156). A container outlives the `docker run`
  // client that started it, so a pane killed by anything other than curia — a
  // reboot of tmux, a human's `tmux kill-session`, a crash — leaves one running
  // with nobody attached, holding its three published ports and its mounts.
  //
  // Same discipline as every other sweep here: docker is the state home (a
  // restarted daemon finds its predecessor's containers by label), and only a
  // POSITIVELY known session list may condemn anything.
  async #sweepContainers(sessions) {
    if (!this.config.sandbox) return
    let running = []
    try {
      running = await this.deps.listContainers()
    } catch (e) {
      this.log(`reconcile: container sweep skipped — ${e.message}`)
      return
    }
    for (const name of running) {
      if (sessions.includes(name) || this.agents.has(name) || this.inFlight.has(name)) continue
      try {
        await this.deps.stopContainer(name)
        this.store.logEvent('orphan_container_swept', { agent: name })
        this.log(`reconcile: swept orphan container ${name} — no pane holds it`)
      } catch (e) {
        this.log(`reconcile: could not remove orphan container ${name} (${e.message})`)
      }
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
        this.lapseEscalation(r.id, 'the daemon restarted, and agent instances do not match across a restart')
        this.store.logEvent('confirm_lapsed', { id: r.id, reason: 'boot' })
        this.#noteOrigin(r, `confirm ${r.id} lapsed — the daemon restarted; re-issue the command if you still want it`)
        continue
      }
      if (r.agent !== 'overseer') continue
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
  // #151 added a second thing that must be positively up before the rule is
  // asserted: the identity proxy the rule now POINTS AT. ttyd verified but the
  // proxy down would mean publishing 127.0.0.1:<ttyd_port> directly — the
  // un-gated terminal this ticket exists to close — so it is refused exactly
  // like an unverified ttyd, and the persisted rule is withdrawn.
  async #assertAttachSurface() {
    const { serve_port: servePort, ttyd_port: ttydPort, index } = this.config.attach
    const proxyPort = this.config.identity?.proxy_port
    const proxyUp = this.identityProxy?.listening ?? false
    try {
      const { verified } = proxyUp
        ? await this.deps.ensureTtyd({ ttydPort, index, log: this.log })
        : { verified: false }
      if (!verified) {
        // Name the ACTUAL cause: a withdrawal blamed on the wrong half sends
        // the operator to kill a ttyd that was never the problem.
        const cause = proxyUp
          ? `ttyd listener on port ${ttydPort} is UNVERIFIED`
          : `the attach identity proxy is not up on port ${proxyPort}, so the rule has nothing gated to point at`
        try {
          await this.deps.serveOff({ servePort, log: this.log })
          this.log(`reconcile: ${cause} — serve rule for :${servePort} withdrawn; /attach stays down until it is fixed (kill the listener and re-run reconcile, or restart the daemon)`)
        } catch (e) {
          this.log(`WARNING: ${cause} and withdrawing the serve rule failed (${e.message}) — if a rule for :${servePort} exists, an UNGATED listener REMAINS PUBLISHED tailnet-wide; run \`tailscale serve --https=${servePort} off\` by hand`)
        }
        return
      }
      await this.deps.assertServe({ servePort, targetPort: proxyPort })
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
        // #184: lines written before the rename say `worker`/`backend`. The
        // file is never rewritten, so every reader normalizes at its edge.
        events.push(normalizeEvent(JSON.parse(line)))
      } catch { /* torn tail line — ignore */ }
    }
    return events
  }

  // ---- auto loop -----------------------------------------------------------------

  // The tick runs whatever auto_dispatch says (#138): the liveness sweep needs
  // it, and auto_dispatch is shipped OFF. Only the dispatch half of #autoTick
  // is gated on the flag.
  startAutoLoop() {
    const ms = this.config.dispatch.poll_interval_s * 1000
    this.autoTimer = setInterval(() => {
      this.#autoTick().catch((e) => this.log('auto tick failed:', e.message))
    }, ms)
    this.autoTimer.unref()
    if (this.config.dispatch.auto_dispatch) {
      this.log(`auto-dispatch ON: polling every ${this.config.dispatch.poll_interval_s}s, max_concurrent=${this.config.dispatch.max_concurrent}`)
    } else {
      this.log(`auto-dispatch OFF — the ${this.config.dispatch.poll_interval_s}s tick still runs the agent-liveness sweep`)
    }
  }

  async #autoTick() {
    // #138: the liveness sweep rides the dispatch tick — dead agents stop
    // lying on every surface before anything new is dispatched.
    await this.livenessSweep().catch((e) => this.log('liveness sweep failed:', e.message))
    if (!this.config.dispatch.auto_dispatch) return
    const max = this.config.dispatch.max_concurrent
    const liveCount = () => this.agents.size + this.inFlight.size
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
      if (this.agents.has(session) || this.inFlight.has(session)) continue
      if (await this.deps.hasSession(session)) continue // collision or leftover: skip, never churn
      const msg = await this.start(num, { repo, by: 'auto' })
      this.log(`[auto] ${msg}`)
    }
  }
}
