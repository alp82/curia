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
  repoMaps, mapFrontier, flatFrontier, fetchIssue, claim, unclaim, blockedByOf,
  selectLane, frontierForRepo, filterTakeable, agentOnlyChainCount, directUnblocks, commentIssue, closeIssue, setIssueBody, issueComments,
  parentNumberOf, hasLabel, findPullRequest, createPullRequest, setPullRequestBody,
  deleteRemoteBranch, pullRequestDiff, approvePullRequest,
} from './github.mjs'
import {
  resolveModel, candidates, buildSpawnCmd, spawnModelId, parseUsageLimit, parseCreditGate,
  carriesLimitPhrase, resolveReviewer, isActive, Cooling, SAME_PROVIDER_STAMP, namedModel,
} from './routing.mjs'
import { hasSession, listSessions, newSession, capturePane, killSession, sendText, sendKey } from './tmux.mjs'
import {
  createPrivateClone, removeWorkspace,
  removeConfigDir, removeCredentials, createReviewCheckout, reviewPathFor, writeReviewPrompt,
  seedConfigDir, writeConnectionSettings, writePrompt, worktreePathFor, cfgDirFor,
  branchFor, defaultBranchOf, commitsOnBranch, changedFilesOnBranch, uncommittedFiles,
  pushBranch, hasUnpushedWork, agentEnv, ghTokenKeyFor, setGitIdentity,
  untrustedProjectConfig, plantedSkills,
} from './workspace.mjs'
// the agent's minted GitHub credential (#389, ADR-0018)
import { GH_DIR, forgetGhCredentials, readGhCredentials, writeGhCredentials } from './agentgh.mjs'
// the overseer's minted read-only credential (#392, the same ADR)
import {
  overseerTokensRootFor, readOverseerToken, writeOverseerToken, sweepOverseerTokens,
} from './overseertoken.mjs'
import { ownersOf } from './overseercreds.mjs'
import { ensureAgentImage } from './image.mjs'
import { readDiffDigest, readFileHunks, digestLine, sliceFromPatch, capText } from './diffdigest.mjs'
import { transcriptReset, holdVerdict, hottestPct, WARM_PCT } from './usage.mjs'
import { mintAgentToken, forgetAgentToken, sweepAgentTokens } from './agenttoken.mjs'
import {
  GUEST_WT, GUEST_CFG, GUEST_DAEMON_HOST, ENV_FILE, PORTS_PER_AGENT,
  allocatePorts, containerPorts, dockerRunCmd, listContainers, modelCredential, stopContainer,
  writeEnvFile,
} from './sandbox.mjs'
import {
  resolveAndLand, summariseOutcome, nonCleanComment, landBranch, prLinkComment, chartingComment,
  verdictComment, judgementComment, verdictNote, verdictCarrier,
} from './resolve.mjs'
import { smallPrint } from './messaging.mjs'
import { outstanding, stopReason, reviewGateText, classifyReviewAnswer, REVIEW_KIND, RESULT_KIND, dutyLines } from './lifecycle.mjs'
import { CONFIRM_KIND, CROSS_CHECK_LABEL, VERDICT_LABEL } from './reduction.mjs'
import {
  probeTtyd, assertServe, serveOff, CHAT_HANDLE_RE, isChatHandle, nextChatHandle,
} from './attach.mjs'
import { failureProse, FailureLines } from './messaging.mjs'

// A ticket session's name. Chat handles are in here since #241: an agent no
// issue answers for — today, the one charting a map that does not exist yet —
// is a ticket-lane session in every way that matters to reconcile, the orphan
// sweep and the tool bindings. It just has a handle where the others have a
// number. Every consumer treats the capture as a STRING already, because a
// ticket id has always been one here.
const SESSION_RE = new RegExp(`^curia-(\\d+|${CHAT_HANDLE_RE.source.replace(/^\^|\$$/g, '')})$`)

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

// Which tool a lint rejection came from (#418, #419). The gate keeps its own
// kind and so does the ending report, and every other kind is an `ask_human`.
// The Stop hook names the tool, because the model has to make the call again.
const TOOL_FOR_KIND = { [REVIEW_KIND]: 'request_review', [RESULT_KIND]: 'report_result' }

// The label a CHARTING dispatch needs (#160): `map curia#<n>` on a map's own
// issue spawns an agent that updates the map, not one that resolves a ticket
// under it. Since #221 the VERB decides the kind and this label is the check on
// it — `start` never charts, whatever the label says. Everything that branches
// on it reads this constant, and the journal records the answer per spawn so a
// restarted daemon still knows which kind of agent it adopted.
const MAP_LABEL = 'wayfinder:map'

// The three kinds an `agent_spawned` line can state, in one place (#219).
//
// THE RULE FOR THIS EVENT: a spawn line describes the agent WHOLE, as it runs
// from that moment. A respawn changes the PROCESS, not the dispatch, so it
// restates every dispatch-time fact its first line carried instead of leaving
// them to the line before. That is what makes "the last line wins" correct for
// every reader of this event at once:
//
//   #epochSpawn (#187)     wants the model that is ACTUALLY running, which the
//                          last line holds.
//   #epochCharting (#160)  wants the ending this agent is held to, which the
//                          dispatch fixed and no respawn changes.
//
// Before #219 the respawn wrote neither `kind` nor `instruction`, so those two
// readers wanted opposite lines and the second one lost. Teaching #epochCharting
// to take the FIRST line of the epoch was refused: it reduces over the whole
// journal by ticket, and a respawn line is itself an epoch boundary for
// #epochScan and for reconcile — so no READER can tell a respawn from a
// re-dispatch. The writer can. It knows which one it is.
const spawnKind = ({ reviewer = false, charting = false }) => (reviewer ? 'reviewer' : charting ? 'charting' : 'ticket')

// How much of the operator's sentence becomes the session's name (#241).
// It is a LABEL, not the map's title: the agent settles the real title with the
// operator and writes it on the issue it creates. This one only has to say
// which charting session this is, on the status line and in the thread name.
const NEW_MAP_TITLE_MAX = 60

// The issue record a new-map dispatch works from (#241). Nothing on GitHub
// answers to it — the map does not exist — so it is synthesised from the
// instruction, and every field is one #dispatch actually reads:
//
//   labels   routing. `wayfinder:map` is a row in the model table, and a new
//            map must be charted by the same model an existing one is.
//   title    the status line, the thread name, and the usage-limit guard.
//   body     the usage-limit guard again: the operator's own sentence can
//            carry the phrase that makes the watchdog cry cooling, so the
//            text has to be visible to textCarriesLimitPhrase.
//   number   the chat handle, which is what names the session.
function newMapIssue(handle, instruction) {
  const one = String(instruction).replace(/\s+/g, ' ').trim()
  const short = one.length > NEW_MAP_TITLE_MAX ? `${one.slice(0, NEW_MAP_TITLE_MAX - 1).trimEnd()}…` : one
  return {
    number: handle,
    title: `new map: ${short}`,
    body: one,
    labels: [{ name: MAP_LABEL }],
    state: 'open',
    assignees: [],
  }
}

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

// The interrupt's grace (#252, ADR-0013): "a few seconds for the current tool
// call". Long enough that an ordinary read, edit or grep finishes on its own and
// the Escape lands on a clear composer; short enough that the operator who
// pressed the button reads it as an interrupt rather than a queue.
const INTERRUPT_GRACE_MS = 5_000

// The limit resume (#346). A window rolls at an instant the PROVIDER states, on
// the provider's own clock, and the box's clock is its own. A resume that lands
// one second early walks straight back into the cap and cools again, so the arm
// sits a minute behind the stated reset. A minute costs nothing against a
// window measured in hours.
const RESUME_GRACE_MS = 60_000

// The floor under every wake. It keeps a reset already in the past — the one a
// daemon that was down through the window re-arms at boot — from firing inside
// the same tick that armed it. A field on the dispatcher rather than a constant
// at the call site, so a test can drive the path without waiting out a real one
// (the same reason `interruptGraceMs` is one).
const WAKE_FLOOR_MS = 5_000

// An instant a phone can read. Discord renders `<t:…>` in the reader's own
// timezone, so the operator reads a local clock time instead of an ISO string
// in UTC, and `:R` beside it answers the question they actually have — how long
// until then. Every surface these messages reach is Discord (`notify` goes to
// the bridge and nowhere else), so nothing here renders the markup raw.
export function discordTime(date) {
  const s = Math.floor(date.getTime() / 1000)
  return `<t:${s}:t> (<t:${s}:R>)`
}

const DEFAULT_DEPS = {
  repoMaps, mapFrontier, flatFrontier, fetchIssue, claim, unclaim, blockedByOf,
  hasSession, listSessions, newSession, capturePane, killSession, sendText, sendKey,
  createPrivateClone, removeWorkspace, removeConfigDir, removeCredentials,
  createReviewCheckout, writeReviewPrompt,
  seedConfigDir, writeConnectionSettings, writePrompt, setGitIdentity,
  probeTtyd, assertServe, serveOff,
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
  setPullRequestBody, deleteRemoteBranch, pullRequestDiff,
  // the gate press as a real GitHub approval (#391) — the one call here that
  // keeps the operator's own login
  approvePullRequest,
  defaultBranchOf, commitsOnBranch, changedFilesOnBranch, uncommittedFiles, pushBranch, hasUnpushedWork,
  // the diff digest (#355) — the numbers at the gate, the hunks on demand
  readDiffDigest, readFileHunks,
}

// GitHub's own words for a review by the pull request's own author (#391),
// whichever surface answers: the GraphQL mutation behind `gh pr review` says
// "Can not approve your own pull request", and the REST route spells it with
// "cannot". It is matched rather than pre-checked, because the only authority on
// whether two logins are one account is GitHub itself.
const SELF_APPROVAL_RE = /can ?not approve your own pull request/i

// The one directory a charting session may write (#297, ADR-0008). Its research
// subagents put one note each under here, and the agent writes the index row
// beside them — nothing else on disk is a charting output.
//
// It is a curia path, said once, in the daemon that watches curia. A watched
// repo that keeps its research notes somewhere else needs this widened, and
// the refusal it drives says so plainly enough for an operator to act on.
export const CHARTING_WRITE_PREFIX = 'docs/research/'

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
  constructor({ config, routing, reduction, notify, openConfirm, lapseEscalation, confirmNote, overseerNote, askReview, cancelEscalation, threads, log = console.log, cooling, readings, dataDir, daemonPort, previews, attachLinks, channelName, minter, deps }) {
    this.config = config
    this.routing = routing
    this.reduction = reduction
    this.notify = notify
    this.openConfirm = openConfirm ?? (() => null)
    this.lapseEscalation = lapseEscalation ?? ((id, reason) => this.reduction.lapse?.(id, reason))
    this.confirmNote = confirmNote ?? (() => {})
    this.overseerNote = overseerNote ?? (() => {})
    // askReview(agent, ticket, promptText) → { text, status } — the review gate
    // (#54 item 2), injected by index.mjs on the same escalation machinery every
    // ask_human uses, so first-valid-wins, the bounded render retry, the MCP
    // keepalive and restart survival all come free. Absent in tests that never
    // reach the gate.
    this.askReview = askReview ?? (async () => ({ text: 'reject', status: 'answered' }))
    // index.mjs injects gate.cancel so voiding a confirm SETTLES it: the
    // pending resolver (if the confirm was opened after listen, mid-boot-
    // reconcile) is released and the Discord buttons get marked — a bare
    // reduction.cancel would leave the resolver hanging in `pending` forever.
    this.cancelEscalation = cancelEscalation ?? ((id, opts) => this.reduction.cancel(id, opts))
    // Ticket-thread bindings (#93), injected by index.mjs over the bridge and
    // the journal. bind(ticket, {threadId, title}) puts the label on (an
    // explicit thread, or a fresh one); release(ticket, reason) takes it off —
    // called on every terminal state. Inert by default so tests and a
    // bridgeless daemon run unchanged.
    this.threads = threads ?? { bind: async () => ({ ok: true }), release: async () => {}, cancelled: async () => {} }
    this.log = log
    this.cooling = cooling ?? new Cooling()
    // The account readings the pre-emptive hold judges (#384), injected by
    // index.mjs: `[{ provider, from, session, windows }]`, one entry per
    // provider that has a reading at all. It is the SAME read the dashboard's
    // provider strip draws, so the hold and the bar the operator looks at can
    // never disagree. Absent it, curia holds nothing pre-emptively and the
    // reactive path stands alone — which is what every test that does not drive
    // this gets.
    this.readings = readings ?? (() => [])
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
    // The GitHub App's minter (#389, ADR-0018), injected by index.mjs. NULL is
    // legal and stays legal: a box with no app keeps #155's PAT, which is what
    // "no PAT comes out ahead of its replacement" means in code. Everything that
    // reads it treats null and a mint that failed as the same answer — fall back
    // — so there is one path to test rather than two.
    this.minter = minter ?? null
    this.deps = { ...DEFAULT_DEPS, ...deps }
    this.root = config.dispatch.workspace_root
    this.agents = new Map() // session -> agent record (disposable cache)
    this.inFlight = new Set() // admission guard: sessions mid-start, pre-spawn
    // The repeat filter behind #failureNotify (#256). In-memory on purpose: a
    // restart loses the counters, and a restart is exactly when a failure
    // deserves to be said again.
    this.failures = new FailureLines()
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
    // The interrupt's grace (#252): how long the CURRENT tool call gets before
    // Escape lands on it. A field rather than a constant so a test can drive
    // the path without waiting out a real one.
    this.interruptGraceMs = INTERRUPT_GRACE_MS
    // Builders parked at the gate waiting for a verdict (#165), ticket ->
    // { agent, resolve }. Process-scoped on purpose: the thing waiting is a live
    // MCP call, and a daemon restart kills the call before it kills this map.
    this.reviewWaits = new Map()
    this.mapLocks = new Map() // "repo#map" -> tail of that map's write chain (#41)
    this.exhaustionNotified = false
    // The limit resumes curia owes (#346), ticket -> { repo, at: Date }. The
    // journal is the durable half (`limit_resume_armed`, re-read at boot); this
    // is the live index the wake timer reads.
    this.limitResumes = new Map()
    // Fields rather than constants at the call site, so a test can drive the
    // whole path — cap, cooling, arm, wake, resume — without waiting out a real
    // reset (the same reason `interruptGraceMs` above is one).
    this.resumeGraceMs = RESUME_GRACE_MS
    this.wakeFloorMs = WAKE_FLOOR_MS
    // The dashboard's frontier and the instant reconcile computed it (#262).
    // Null until the first pass lands, which is how `GET /overview` says "no
    // frontier has been read yet" rather than "the frontier is empty".
    this.frontierAt = null
    this.autoTimer = null
    this.wakeTimer = null
    // Last, and HERE rather than in reconcile (#377). The #346 resume waits for
    // the boot pass because it must not fire on a ticket adoption has just
    // brought back. A cooling waits for nothing, and every millisecond it waits
    // is a millisecond in which a `start` typed two seconds after a deploy
    // spawns a container into a cap curia already measured.
    this.#seedCooling()
  }

  // Who a claim assigns (#390, ADR-0018).
  //
  // It used to be `gh api user` — the daemon's own login, read off the host
  // `gh` config. The daemon calls GitHub as `curia-sh[bot]` now, and GitHub does
  // not let an App be an issue assignee, so the name comes out of the config
  // instead. `loadCuriaConfig` refuses a boot without it, which is why nothing
  // here has a fallback and nothing here can fail.
  //
  // Read fresh on every call rather than kept: a watch reload re-reads the
  // config in place, and a claim must use the name the file says now.
  claimLogin() {
    return this.config.dispatch.claim_login
  }

  // The caps a previous process measured (#377). Cooling holds for hours and a
  // deploy takes minutes, so most holds outlive the daemon that wrote them.
  //
  // An entry whose reset already passed is skipped rather than armed: `Cooling`
  // would expire it on the first read anyway, and skipping keeps the boot log
  // about the holds that still bind. A model or a provider that routing.yaml no
  // longer names is armed all the same — nothing ever asks `isCool` about it,
  // and dropping it here would make this seed depend on a config read.
  #seedCooling() {
    if (typeof this.reduction?.armedCoolings !== 'function') return
    const { models, providers } = this.reduction.armedCoolings()
    const live = []
    const arm = (key, iso, cool) => {
      const at = new Date(iso)
      if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) return
      cool(key, at)
      live.push(`${key} until ${at.toISOString()}`)
    }
    for (const { model, at } of models) arm(model, at, (m, d) => this.cooling.coolModel(m, d))
    for (const { provider, at } of providers) arm(provider, at, (p, d) => this.cooling.coolProvider(p, d))
    if (live.length) this.log(`boot: cooling still holds — ${live.join(', ')}`)
  }

  // ---- the pre-emptive hold (#384, decided on #339) ---------------------------

  // Re-judge every provider's newest reading and hold the hot ones.
  //
  // The hold is a PREDICTION, so it is re-made from scratch on every reading
  // rather than set once and waited out: it stands while the newest reading is
  // at or past COOL_PCT, and it lifts below WARM_PCT or when the window rolls
  // (`accountWindows` rolls a passed window over to a fresh one at 0%, so the
  // second case falls out of the first). The store expiry is the window's own
  // `resetsAt`, which is the outer bound and what the existing wake timer reads.
  //
  // It runs on the dispatch tick, beside the liveness sweep and BEFORE the
  // auto_dispatch gate — a hold is not a dispatch, and an operator typing
  // `start` on a box with auto-dispatch off must get the same answer the loop
  // would. It runs again at the head of every start path, because the tick is
  // not the only thing that spawns a container.
  //
  // A provider with no reading is never held (#339 answer 4): an unmeasured
  // window and an unspent one are not the same fact, and cooling on absent data
  // would freeze a provider with no probe every idle morning. Nothing is
  // journalled at boot either — the seed takes landed caps only, so a hold this
  // process did not measure never binds it.
  judgeReadings() {
    let readings = []
    try {
      readings = this.readings() ?? []
    } catch (e) {
      // A reading curia could not take clears nothing and holds nothing: the
      // entries already standing wait for their own reset.
      this.log('usage reading for the pre-emptive hold failed:', e.message)
      return
    }
    for (const r of readings) {
      if (!r?.provider) continue
      const standing = this.cooling.predictionFor(r.provider)
      const hot = holdVerdict(r.windows, { standing: Boolean(standing) })
      if (hot) {
        // A hold that already stands is re-stated, not re-journalled: the
        // reading moves every ten minutes and the feed would say the same fact
        // every ten minutes with it. A hold whose WINDOW changed is news, and
        // says so.
        const fresh = !standing || standing.window !== hot.window
        if (!this.cooling.predictProvider(r.provider, hot)) continue
        if (!fresh) continue
        this.reduction.journal('provider_precooling', {
          provider: r.provider, window: hot.window, pct: hot.pct,
          reset_at: hot.at.toISOString(), from: r.from ?? null,
        })
        this.log(`pre-emptive hold on ${r.provider}: the ${hot.window} window is at ${hot.pct}% — it lifts ${hot.at.toISOString()}`)
        // The reset is the outer bound of the hold, so the timer that wakes the
        // box at a landed cap's reset wakes it at this one too.
        this.#armWake()
        continue
      }
      if (!standing) continue
      if (!this.cooling.clearPrediction(r.provider)) continue
      this.reduction.journal('provider_precooling_lifted', {
        provider: r.provider, window: standing.window, pct: hottestPct(r.windows),
      })
      this.log(`pre-emptive hold on ${r.provider} lifted — the newest reading is below ${WARM_PCT}%`)
    }
  }

  // The holds standing now, for the surfaces that name them (#384): the
  // dashboard banner and Discord `/status`. One read, so the two cannot say
  // different providers or different lift times.
  preCoolings() {
    return this.cooling.predictions().map((p) => ({
      provider: p.provider, window: p.window, pct: p.pct, reset_at: p.at.toISOString(),
    }))
  }

  // ---- frontier --------------------------------------------------------------

  // The frontier the dashboard draws (#262): the same two-level read as
  // `frontier()`, computed during reconcile and stamped with the instant it was
  // computed. Two reasons it lives on the reconcile pass rather than under the
  // route. The pass already holds the `gh` credentials and already spends this
  // repo's reads, so the frontier costs it nothing new — and the sidecar that
  // asks for it holds no token at all (#249). The stamp is what makes a served
  // snapshot honest: the page says how old the frontier is, instead of dressing
  // a boot-time read as a live one. `POST /reconcile` recomputes it.
  frontierSnapshot() {
    return this.frontierAt ?? { computed_at: null, repos: [] }
  }

  // Never throws and never fails the pass: a frontier the dashboard cannot draw
  // must not cost reconcile its sweeps. The previous snapshot stands, with its
  // own older stamp saying so.
  async #computeFrontier() {
    try {
      const repos = await this.frontier()
      this.frontierAt = { computed_at: new Date().toISOString(), repos }
    } catch (e) {
      this.log(`reconcile: the dashboard frontier failed (${e.message}) — the last snapshot stands`)
    }
  }

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
    // The blocked-by edges, read ONCE per repo and shared (#262). The agent-only
    // count and level two of the frontier ask the same edges two questions, and
    // this is one `gh` call per open blocked ticket — so reading them twice
    // would double the cost of every tickets view for no new fact.
    const pool = lane === 'map' ? Object.values(mapItems).flat() : flatItems
    const edges = await this.#blockerEdges(entry.repo, lane, pool)
    const unblocks = edges ? directUnblocks({ items: pool, edges }) : {}
    return {
      repo: entry.repo,
      lane,
      numbers,
      agentOnly: this.#agentOnlyCount(lane, pool, edges, numbers),
      items: numbers.map((n) => {
        const e = index.get(n)
        const labels = (e?.item?.labels ?? []).map((l) => l.name)
        return {
          number: n,
          title: e?.item?.title ?? '',
          labels,
          // The model this ticket gets if it starts now (#266). The console
          // shows it beside its start button, and it is `resolveModel` — the
          // daemon's OWN precedence rule — rather than a second copy of that
          // rule inside a page. It costs no call: the labels are already here.
          //
          // It names what routing decides, not what a spawn will do. Cooling is
          // read at the spawn, and the chain it walks then is reported by the
          // feed rather than guessed at here.
          model: resolveModel(this.routing, labels, null),
          map: e?.map ?? null,
          mapTitle: e?.map != null ? mapTitle.get(e.map) ?? '' : '',
          // Level two (#262): the tickets this one directly unblocks, which is
          // what makes the dashboard's frontier a tree rather than a list.
          unblocks: (unblocks[n] ?? []).map((i) => ({
            number: i.number,
            title: i.title ?? '',
            labels: (i.labels ?? []).map((l) => l.name),
          })),
        }
      }),
    }
  }

  // The dependency edges of every open blocked ticket in the pool:
  // { [number]: [{number, state}] }. Null when a read failed — an unreadable
  // edge is not an open way, and both readers below treat null as "no answer"
  // rather than "no edges".
  //
  // The MAP lane only. A flat-lane ticket is takeable because a human labelled
  // it `ready-for-agent`, not because a chain opened, so neither reader has a
  // question for its edges — and asking anyway would spend one `gh` call per
  // blocked ticket on every tickets view that a flat repo has never paid.
  async #blockerEdges(repo, lane, pool) {
    if (lane !== 'map') return {}
    try {
      const edges = {}
      for (const i of pool) {
        if (i.state !== 'open' || i.pull_request) continue
        if ((i.issue_dependencies_summary?.blocked_by ?? 0) === 0) continue
        edges[i.number] = (await this.deps.blockedByOf(repo, i.number))
          .map((b) => ({ number: b.number, state: b.state }))
      }
      return edges
    } catch (e) {
      this.log(`dependency edges for ${repo} failed (${e.message}) — omitting the agent-only count and the unblocks`)
      return null
    }
  }

  // The HITL-free chain count for the tickets view (#81), over the edges above.
  // Flat lane: every ready-for-agent ticket is by definition agent-ready, so
  // the count is the takeable count. Fails soft to null — the tickets view
  // must render even when an edge read does not.
  #agentOnlyCount(lane, pool, edges, numbers) {
    if (lane === 'flat') return numbers.length
    if (lane !== 'map') return 0
    if (!edges) return null
    return agentOnlyChainCount({ items: pool, edges })
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

  // `start` has ONE meaning (#221): work the thing. On a ticket it dispatches
  // that ticket. On a map it dispatches the map's next takeable ticket, which
  // is what an operator reaching for `start` on a map wants — it never charts,
  // and charting has its own verb (`map <n>`, see chart below).
  //
  // `reuse` is the resume contract (#81): inherit the surviving worktree
  // instead of recreating it — see #dispatch.
  async start(ticketArg, { repo, model, by, reuse = false, threadId = null } = {}) {
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
      // `start` on a MAP number (#221). It used to spawn a charting agent, which
      // gave one verb two meanings — the fault class #184 exists to kill, on the
      // command surface itself. It now means what it means everywhere else:
      // work the next thing. The map's own frontier is that thing.
      //
      // A resume is exempt. It names a session, not a subject, so redirecting it
      // to another number would resume the wrong agent.
      if (!reuse && hasLabel(issue, MAP_LABEL)) {
        return await this.#startNextOfMap(theRepo, n, issue, { model, by, threadId })
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
      return (await this.#dispatch(theRepo, n, issue, { model, by, reuse, threadId })) ?? this.#exhaustedReply()
    } finally {
      this.inFlight.delete(session)
    }
  }

  // `start <map>` → the map's next takeable ticket (#221). The ordering is the
  // frontier's own — ascending issue number, the order `tickets` prints and the
  // auto loop walks — so "next" means the same thing on every surface.
  //
  // The candidates are filtered exactly as `next` filters them: a number whose
  // session is already live or already starting is skipped rather than refused,
  // because the operator asked for the next takeable one and that one is taken.
  // A ticket the frontier offers can still refuse itself further down (`start`
  // re-reads the issue), and that refusal is returned as it stands — inventing a
  // second candidate would dispatch a ticket the operator never saw named.
  async #startNextOfMap(repo, mapNo, mapIssue, { model, by, threadId }) {
    let items
    try {
      items = filterTakeable(await this.deps.mapFrontier(repo, mapNo))
    } catch (e) {
      return `❌ could not read the frontier of ${repo}#${mapNo} (${e.message}) — try again, or \`start\` one of its tickets by number`
    }
    for (const item of items.sort((a, b) => a.number - b.number)) {
      const session = `curia-${item.number}`
      if (this.agents.has(session) || this.inFlight.has(session)) continue
      if (await this.deps.hasSession(session).catch(() => false)) continue
      // The operator typed a map number and gets an agent on a different one.
      // Which ticket, and why, rides the REPLY — it belongs where they typed
      // the command (#218's rule), and a notify here would open a Discord
      // thread on the map, which nothing else in curia ever does.
      const picked = `🗺️ next takeable ticket of **${mapIssue.title}** is ${repo}#${item.number} **${item.title}**`
      return `${picked}\n${await this.start(String(item.number), { repo, model, by, threadId })}`
    }
    // Nothing takeable is the ordinary end of a map, not a fault. Name the other
    // verb here: an operator who typed `start <map>` meaning "update the map" is
    // exactly the operator standing in front of this message.
    return `❌ ${repo}#${mapNo} **${mapIssue.title}** has no takeable ticket — every child is closed, blocked, or already claimed. \`tickets\` shows the frontier, and \`map ${mapNo} <what should change>\` updates the map itself`
  }

  // ---- map (the charting dispatch) ---------------------------------------------

  // `map <n> [<instruction>]` (#221, carrying #160's mechanics): the operator's
  // own verb for updating a map. It spawns a CHARTING agent on the map issue,
  // which edits the map and its tickets and ends on its edits plus one
  // `report_result` — no close, no pull request, no review gate.
  //
  // Three things it does NOT do, each on purpose:
  //
  //   1. **It never claims the map** (#221). #160 claimed it to serialise the
  //      body edits, and the operator ruled that wrong: a map is never on a
  //      frontier, so the assignee bought nothing but a lie on the issue. The
  //      lock that replaces it was already here — a charting agent on map #147
  //      runs in session `curia-147`, and the two guards below refuse a second
  //      one. The `tmux has-session` guard is the load-bearing half: it asks
  //      tmux rather than daemon memory, so it survives a restart and catches a
  //      session reconcile has not adopted yet.
  //   2. **It reads no assignee or blocked-by anomaly.** Those are frontier
  //      facts and a map is never on one. A map left assigned by a pre-#221
  //      dispatch must not lock charting out forever.
  //   3. **It refuses a non-map** rather than degrading to a ticket dispatch.
  //      The two verbs mean different things now, so guessing which one the
  //      operator meant is the ambiguity this ticket removed.
  async chart(mapArg, { repo, model, instruction = null, by, reuse = false, threadId = null } = {}) {
    const n = String(mapArg)
    const session = `curia-${n}`
    // The whole lock, in the same shape and the same order `start` uses.
    if (this.inFlight.has(session)) return `⚙️ \`${session}\` is already starting`
    // #241: a chat agent that created this map takes its number as its own, so
    // it holds this map's charting lock under a different session name. Without
    // this the two would edit one body at once, which is the exact thing the
    // session-name lock exists to stop.
    const chat = this.#chatOnMap(n)
    // Repo-scoped: two watched repos can both hold a #250, and refusing the
    // other one's map because a chat is charting this one would be a lie about
    // an issue nobody is touching.
    if (chat && (!repo || repo === chat.repo)) {
      return `▶️ \`${chat.session}\` is charting ${chat.repo ?? '?'}#${n} — it created that map and is still working on it. \`cancel ${chat.ticket}\` first, or \`attach ${chat.ticket}\``
    }
    if (this.agents.has(session)) {
      const w = this.agents.get(session)
      return `▶️ \`${session}\` is already charting ${w.repo ?? '?'}#${w.ticket ?? n} (state **${w.state ?? '?'}**) — \`cancel ${n}\` first, or \`attach ${n}\``
    }
    this.inFlight.add(session)
    try {
      if (await this.deps.hasSession(session)) {
        return `⚠️ tmux session \`${session}\` is already live but untracked — \`cancel ${n}\` tears it down, then \`map ${n}\` again`
      }
      const resolved = await this.#resolveRepo(n, repo)
      if (resolved.error) return resolved.error
      const { repo: theRepo, issue } = resolved

      if (issue.state !== 'open') return `❌ ${theRepo}#${n} is ${issue.state} — a closed map is not charted; reopen it first`
      if (!hasLabel(issue, MAP_LABEL)) {
        return `❌ ${theRepo}#${n} is not a \`${MAP_LABEL}\` issue — \`map\` updates a map, and \`start ${n}\` is how a ticket gets worked`
      }
      return (await this.#dispatch(theRepo, n, issue, { model, instruction, by, reuse, threadId, charting: true })) ?? this.#exhaustedReply()
    } finally {
      this.inFlight.delete(session)
    }
  }

  // ---- map with no issue (the new-map dispatch, #241) --------------------------

  // `map [repo] <prose>`: a charting agent with NO map. It runs the wayfinder
  // skill's CHART mode — name the destination, map the frontier breadth-first,
  // then create the `wayfinder:map` issue and its first tickets. The operator's
  // prose is the loose idea that mode starts from, which is why the parser makes
  // it mandatory: there is no map body here to read the effort off instead.
  //
  // Three things are different from `chart`, and they all follow from the same
  // fact — the issue does not exist yet:
  //
  //   1. **The identity is a CHAT HANDLE, not a number** (see attach.mjs). The
  //      operator ruled these enumerated rather than singular: several new maps
  //      may be charted at once, each in its own thread, and `chat-1` is what
  //      `attach`, `cancel` and `resume` take. So there is no lock here — the
  //      handle is picked free, and two of these never meet.
  //   2. **The repo cannot be resolved from a number.** The caller supplies it —
  //      the router fills in the only watched repo when there is one — so this
  //      checks the watch list itself rather than asking #resolveRepo, which
  //      answers "which repo owns #n" and no map owns anything yet.
  //   3. **There is no issue to read.** The record #dispatch works from is
  //      synthesised from the instruction, and it carries the map label so
  //      routing picks the map model exactly as it does for `map <n>`.
  //
  // `handle` is passed only by resume, which is re-dispatching a chat that
  // already has one — its thread, its worktree and its journal epoch all answer
  // to that name, so picking a fresh index would strand all three.
  async chartNew({ repo, model, instruction = null, by, reuse = false, threadId = null, handle = null } = {}) {
    if (!String(instruction ?? '').trim()) {
      return '❌ a new map needs a sentence to chart from — `map [repo] <what to chart>`'
    }
    if (!repo) return '❌ a new map needs a repo — nothing says where to create the issue'
    if (!this.config.watch.some((w) => w.repo === repo)) return `❌ \`${repo}\` is not on the watch list`
    // The index has to be free on the BOX, not merely in this process's memory:
    // a restarted daemon holds no agents map, and handing a live pane's handle
    // to a second agent would put two of them on one tmux session, one config
    // dir and one thread. tmux is the authority the dispatch locks already ask.
    let live = []
    try {
      live = await this.deps.listSessions()
    } catch (e) {
      return `❌ the tmux session list is indeterminate (${e.message}), so curia cannot pick a free chat handle — retry`
    }
    const chat = handle ?? nextChatHandle([...live, ...this.agents.keys(), ...this.inFlight])
    const session = `curia-${chat}`
    if (this.inFlight.has(session)) return `⚙️ \`${session}\` is already starting`
    if (this.agents.has(session)) {
      const w = this.agents.get(session)
      return `▶️ \`${session}\` is already running (state **${w.state ?? '?'}**) — \`cancel ${chat}\` first, or \`attach ${chat}\``
    }
    this.inFlight.add(session)
    try {
      if (await this.deps.hasSession(session)) {
        return `⚠️ tmux session \`${session}\` is already live but untracked — \`cancel ${chat}\` tears it down, then \`map …\` again`
      }
      const issue = newMapIssue(chat, instruction)
      return (await this.#dispatch(repo, chat, issue, {
        model, instruction, by, reuse, threadId, charting: true,
      })) ?? this.#exhaustedReply()
    } finally {
      this.inFlight.delete(session)
    }
  }

  // The live chat agent that has already created map #n (#241), if there is one.
  // `chart` asks so that `map <n>` on a map still being charted is refused by
  // the same lock every other charting dispatch obeys: the session name is the
  // lock, and after the adoption a chat session speaks for that number too.
  #chatOnMap(n) {
    for (const w of this.agents.values()) {
      if (w.mapNumber && String(w.mapNumber) === String(n)) return w
    }
    return null
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
  async #dispatch(repo, n, issue, { model, instruction = null, by, reuse = false, threadId = null, charting = false }) {
    const session = `curia-${n}`
    // #241: a new-map dispatch is charting with no map, so there is no number to
    // name anywhere below. Everything downstream reads THIS rather than a falsy
    // mapNumber, because a mapless TICKET is also falsy and means the opposite
    // thing (the flat lane, where no map is involved at all). Declared out here
    // because the failure path names it too.
    const newMap = charting && isChatHandle(n)
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    // The type label, read once and used twice: it names the thread (#93) and
    // it reaches the agent prompt (#49 decision 2). One read, so the thread a
    // human reads and the prompt the agent reads can never say different kinds.
    const typeLabel = labels.find((l) => l.startsWith('wayfinder:')) ?? null
    // A map dispatch (#160). `wayfinder:map` is a type label like any other for
    // ROUTING — resolveModel reads `defaults.map` off the same loop — and unlike
    // any other for everything downstream of it: the prompt, the ending, the
    // tools curia will answer, and what report_result does.
    //
    // The CALLER says which kind this is (#221), where #160 read it off the
    // label: `start` never charts and `chart` always does, so a label alone can
    // no longer answer the question. The label is still checked, as a belt —
    // both mistakes are expensive (a charting agent on the ticket ending closes
    // the map; a ticket agent on the charting ending lands no work), and this is
    // the one place both are visible.
    if (charting && typeLabel !== MAP_LABEL) {
      return `❌ ${repo}#${n} is not a \`${MAP_LABEL}\` issue — curia dispatches no charting agent on it`
    }
    const modelName = resolveModel(this.routing, labels, model)
    if (!this.routing.models[modelName]) {
      return `❌ unknown model \`${modelName}\` — configured models: ${Object.keys(this.routing.models).join(', ')}`
    }
    // #265: the model is configured, and somebody switched it off. Refused here
    // rather than stepped over, because this name was ASKED for — by a
    // `model:<x>` label or by the caller — and quietly spawning something else
    // would hide the switch from the person who typed the label. A cooling
    // model falls through the chain below; a switched-off one names its switch.
    if (!isActive(this.routing, modelName)) {
      return `❌ \`${modelName}\` is \`active: false\` in routing.yaml — turn it back on in the dashboard's Routing section, or name a model that is on: ${Object.keys(this.routing.models).filter((m) => isActive(this.routing, m)).join(', ')}`
    }
    // The newest reading, before the chain is walked (#384). The tick judges it
    // too, and this is the start path a human typed: it must not spawn into a
    // window the last tick had not yet seen.
    this.judgeReadings()
    // The named model steps over a PREDICTED hold and never over a landed cap
    // (#384): the operator has read the same bars and wants the last of that
    // window spent here.
    const cands = candidates(this.routing, modelName, this.cooling, { named: namedModel(labels, model) })
    if (!cands.length) {
      // exhaustion BEFORE the claim — never claim what cannot be spawned.
      // Returns null when #exhausted's latched notify fired (so a confirm
      // continuation cannot echo it) and the reply sentinel when the latch
      // suppressed it (so the continuation is never silent).
      //
      // #346: a LIMIT RESUME that lands here re-arms rather than giving up. The
      // wake fires at the earliest reset, and a second lane with a later one is
      // still cooling then — dropping the arm there would strand exactly the
      // ticket this path exists to bring back. Nothing else re-arms: an
      // operator whose `start` is refused reads the refusal in their own reply
      // and types it again, so curia holds no order they did not repeat.
      return this.#exhausted(n, repo, { armFor: by === 'limit-reset' ? { ticket: n, repo } : null })
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

    const login = this.claimLogin()
    // NO DISPATCH CLAIMS A MAP (#221). #160 claimed it to serialise the body
    // edits; the operator ruled the claim wrong, because a claim's whole meaning
    // is "off the frontier" and a map is never on one — so on a map it said
    // nothing true and made the issue read as worked when it was being edited.
    //
    // What replaces it is the session name, which was already doing the work:
    // a charting agent on map #147 is `curia-147`, and `chart` refuses a second
    // one on the in-memory table and then on `tmux has-session` itself. That
    // second guard is why this is a real lock and not an optimistic one — it
    // asks tmux, so it survives a daemon restart.
    //
    // The journal line goes with it: `dispatch_claimed` records a claim, and
    // recording one that never happened would send reconcile looking for an
    // assignee to release. `agent_spawned` marks the epoch for a map instead —
    // every epoch reader takes either event.
    if (!charting) {
      await this.deps.claim(repo, n, login)
      this.reduction.journal('dispatch_claimed', { repo, ticket: n, agent: session, by: by ?? 'unknown', kind: 'ticket' })
    }

    // The ticket label goes on at the claim (#93): `start` binds the thread it
    // ran in, an autonomous dispatch opens and binds a fresh one — so every
    // notify from here on lands in the labeled thread. Never fatal: with the
    // bridge down the first notify binds lazily instead.
    try {
      await this.threads.bind(n, { threadId, type: typeLabel?.slice('wayfinder:'.length) ?? '', repo })
    } catch (e) {
      this.log(`thread bind for ${repo}#${n} failed (${e.message}) — the first notify will bind lazily`)
    }

    const cfgDir = cfgDirFor(this.root, session)
    try {
      // every caller resolves the issue through #resolveRepo → fetchIssue, so
      // the body is always present
      const full = issue
      // One workspace shape since #195: a private blobless clone the agent's
      // container mounts. A container cannot use a worktree cut from a shared
      // base clone — its `.git` is a file pointing into a base the container
      // cannot see — and that whole shape went with the bare path.
      const surviving = worktreePathFor(this.root, repo, n)
      const inherited = reuse && fs.existsSync(surviving)
      const wtPath = inherited ? surviving : await this.deps.createPrivateClone(this.root, repo, n)
      // A charting agent's map is the issue in hand. Naming it as the map (and
      // not asking #mapNumberFor for a parent) is what puts the `/wayfinder`
      // line on the prompt and arms #assertTracker: a charting agent without
      // the tracker doc is exactly the agent that would chart into `.scratch/`.
      const mapNumber = charting ? (newMap ? null : Number(n)) : await this.#mapNumberFor(repo, full)
      this.#assertTracker(repo, n, session, wtPath, mapNumber, { charting })
      this.#assertNoPlantedConfig(wtPath, harnessName)
      this.#armAgent({ session, ticket: n, harness: harnessName, model: useModel, wtPath, cfgDir })
      // #157: the prompt NAMES the published ports, so they are allocated before
      // it is written and handed to the container after. The allocation is a
      // bind probe and a set lookup — nothing is held until `docker run`, so a
      // failure between here and the spawn leaks no port.
      const ports = await this.#allocatePorts()
      // The type label reaches the prompt (#49 decision 2): it is the only thing
      // that stops a dispatched `wayfinder:grilling` agent from standing in for
      // the human's side of its own ticket.
      const promptFile = this.deps.writePrompt(cfgDir, full, {
        repo, wtPath: GUEST_WT, mapNumber, type: typeLabel, charting, newMap, instruction, ports,
        // #173: the wayfinder invocation is spelled per harness, so the prompt
        // is no longer harness-blind.
        harness: harnessName,
        // #374: every question a human has already answered on this session.
        // The session name is the key and it does not change across dispatches,
        // so a resumed agent reads the exchange its predecessor paid for. On a
        // first dispatch this is empty and the prompt says nothing about it.
        exchange: this.reduction.answeredExchangeFor(session),
      })
      fs.rmSync(path.join(this.dataDir, 'results', `${session}.json`), { force: true })

      const plan = await this.#spawnPlan({
        session, ticket: n, repo, harness: harnessName, model: useModel,
        wtPath, cfgDir, promptFile, ports,
      })
      const container = plan.container
      const exitMarker = newExitMarker()
      await this.deps.newSession({ name: session, cwd: wtPath, env: plan.env, shellCmd: plan.shellCmd, exitMarker })
      // The instance id (#94): what a button confirm binds to. Unique per
      // DISPATCH, not per ticket, so a confirm can never outlive the agent
      // the operator read about and hit its successor.
      const instance = `${session}@${Date.now()}`
      this.reduction.journal('agent_spawned', {
        repo, ticket: n, agent: session, instance, model: useModel, harness: harnessName,
        kind: spawnKind({ charting }), instruction: charting ? instruction : null,
        // #241: which of the two charting shapes this is. A restarted daemon
        // reads it back the same way it reads the kind — without it, a resumed
        // new-map agent would be sent to `chart new`, and `chart` refuses a
        // handle no issue answers to.
        ...(newMap ? { newMap: true } : {}),
        // The journal is the state home for what a restart cannot re-derive
        // from tmux: which image this agent runs and which ports it published.
        sandbox: 'docker', image: container.image, ports: container.ports,
      })

      const agent = {
        repo, ticket: n, title: full.title, session, instance, wtPath, cfgDir, promptFile,
        model: useModel, requestedModel: modelName, harness: harnessName,
        provider: this.routing.models[useModel].provider,
        // #156: the published loopback ports. #157 hands them to
        // `publish_preview` as its port bound.
        ports: container.ports,
        sandbox: 'docker',
        // which harness the prompt on disk was spelled for (#173) — a fallback
        // across providers moves it, and the codex agent would otherwise
        // inherit the claude spelling of the wayfinder invocation
        promptHarness: harnessName,
        spawnedAt: Date.now(), state: 'spawning', resultReceived: false,
        // #160: which ending this agent is held to, and what the operator
        // asked for. Journalled beside it (agent_spawned above) so a daemon
        // restart re-derives both — see #epochCharting.
        charting, instruction: charting ? instruction : null,
        // #241: a new-map agent, and the map number it has created so far. The
        // number arrives on the side channel (see adoptMap) rather than at the
        // spawn, because nothing knows it yet.
        newMap, mapNumber: null,
        // this spawn's exit marker (#169) — the watchdog's fail-fast signal
        exitMarker,
        // this ticket's own text can forge the usage-limit signal ⇒ the
        // watchdog must not act on it (see paneTail)
        promptCarriesLimitText: textCarriesLimitPhrase(full.title, full.body),
      }
      this.agents.set(session, agent)
      this.#watchdog(agent).catch((e) => this.log(`watchdog ${session} failed:`, e.message))
      if (newMap) {
        return `⚙️ charting agent for a NEW map in ${repo} → \`${session}\` on **${useModel}** — it settles the destination with you, then creates the \`${MAP_LABEL}\` issue. \`attach ${n}\` to watch, \`cancel ${n}\` to end it`
      }
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
      //
      // A charting dispatch took no claim (#221), so there is none to release
      // and an unclaim here would be a write against an issue curia never
      // touched. The failure message says so rather than reporting a release
      // that did not happen.
      let released = false
      if (!charting) {
        try {
          await this.deps.unclaim(repo, n, login)
          released = true
          this.reduction.journal('dispatch_unclaimed', { repo, ticket: n, agent: session, reason: e.message })
        } catch (unclaimErr) {
          this.reduction.journal('unclaim_failed', { repo, ticket: n, agent: session, reason: e.message, error: unclaimErr.message })
        }
      }
      // The binding stays (#140): a failed dispatch is a claim release, not a
      // ticket-terminal state — the retry's traffic belongs in the same thread.
      const claimTail = charting
        ? `nothing was claimed, so nothing was released — \`${newMap ? 'map <what to chart>' : `map ${n}`}\` again when the cause is fixed`
        : released ? 'claim released' : 'claim release FAILED: the issue is still assigned to the bot; reconcile will retry'
      // #241: a new-map dispatch has no issue to name, so it names what it was
      // for. `${repo}#new` would read as an issue number that does not exist.
      const what = newMap ? `a new map in ${repo}` : `${repo}#${n}`
      return `⚠️ dispatch of ${what} failed before the agent could run: ${e.message} — ${claimTail}`
    }
  }

  // Seed the config dir and write the connection settings, in the agent's own
  // view of the paths — the container's mount points, which is the only view
  // there is since #195. Shared by the first dispatch and by the cross-harness
  // respawn a usage limit forces.
  #armAgent({ session, ticket, harness, model, wtPath, cfgDir }) {
    this.deps.seedConfigDir(cfgDir, GUEST_WT, this.config.skills, harness, { sandboxed: true })
    // A FRESH secret per arm (#159), minted before the connection settings that carry it.
    // The cross-harness respawn arms again, so the pane a usage limit killed
    // stops being able to speak for this name the moment its successor is armed.
    const token = this.deps.mintAgentToken(this.dataDir, session)
    this.deps.writeConnectionSettings({
      wtPath: GUEST_WT, hostWtPath: wtPath, cfgDir, agent: session, ticket,
      daemonPort: this.daemonPort, daemonHost: GUEST_DAEMON_HOST, token,
      harness, reasoningEffort: this.routing.models[model].reasoning_effort ?? null,
      // The codex harness turns this into its skill deny list (#171); the
      // claude harness does not read it.
      skills: this.config.skills,
    })
  }

  // What tmux is asked to run, and in what environment. Always a `docker run`
  // line and an EMPTY pane environment: the container carries its own through
  // `--env-file`, and a pane env would put every value of it in `ps` — the cost
  // #155 measured and asked #156 not to repeat.
  async #spawnPlan({ session, ticket, repo, harness, model, wtPath, cfgDir, promptFile, ports, reviewer = false }) {
    const harnessCmd = buildSpawnCmd(this.routing, harness, model, path.join(GUEST_CFG, path.basename(promptFile)))
    const container = await this.#prepareContainer({
      session, ticket, repo, harness, wtPath, cfgDir, spawnCmd: harnessCmd,
      sandbox: this.config.sandbox, ports, reviewer,
    })
    return { container, shellCmd: container.shellCmd, env: {} }
  }

  // ---- the agent's GitHub credential (#389, ADR-0018) -------------------------

  // Which permission set a session's token carries. A cross-check reviewer
  // writes NOTHING — ADR-0010 gives it a detached checkout and no branch, and
  // curia posts its verdict for it — so it gets the READ set. One key and two
  // sets is what the app bought, and a reviewer holding push rights it never
  // uses is the reach the app exists to end. The cost is stated: a reviewer path
  // that did write would fail with a 403 naming the permission.
  #ghRoleFor(reviewer) {
    return reviewer ? 'read' : 'write'
  }

  // One minted token, or null.
  //
  // NULL IS THE FALLBACK SIGNAL, never a refusal. A box with no app, an owner
  // the app is not installed on, and a GitHub that could not be reached all read
  // the same here, and the agent then gets #155's PAT as `GH_TOKEN`. Refusing
  // the dispatch instead would take a working boundary out ahead of its
  // replacement, which is the one thing ADR-0018 says not to do. It is LOUD
  // rather than silent: the log names the owner and the key that carries it.
  async #mintGhToken(repo, role, session) {
    if (!this.minter) return null
    const owner = String(repo ?? '').split('/')[0]
    if (!owner) return null
    try {
      return await this.minter.tokenFor(owner, role)
    } catch (e) {
      this.log(`could not mint a ${role} GitHub token for ${owner} (${e.message}) — ${session} falls back to ${ghTokenKeyFor(repo) ?? 'the host gh login'}`)
      return null
    }
  }

  // Make this workspace's commits read as the app's own user.
  //
  // It never fails the dispatch. Two network reads stand behind the identity,
  // and a GitHub that cannot answer them is no reason to refuse a ticket: the
  // agent keeps the box identity its clone was given, which is exactly today's
  // attribution, and the log says so.
  async #authorAsBot(wtPath, token, session) {
    try {
      const who = await this.minter.botIdentity(token)
      await this.deps.setGitIdentity(wtPath, who)
    } catch (e) {
      this.log(`could not read the GitHub App's own user (${e.message}) — ${session} commits under this box's git identity instead`)
    }
  }

  // The refresh. An installation token lives one hour and a ticket outlives it,
  // so the file is rewritten under every LIVE agent on the dispatch tick — 60 s
  // against `REFRESH_MARGIN_MS`, which is ten minutes. The minter hands back its
  // cached token until that margin, so this costs GitHub one call per owner
  // every fifty minutes and costs the disk one small write per agent per tick.
  //
  // THE FILE IS THE EVIDENCE, which is what makes an adopted agent free. A
  // restarted daemon rebuilds its agent records with every spawn-time fact
  // missing, and it does not have to learn which of them minted: an agent on the
  // PAT has no credential file, and one on the app has the file its own spawn
  // wrote. So this refreshes exactly what is already minted, and never puts a
  // live token on disk for an agent whose `gh` reads `GH_TOKEN` instead.
  //
  // It never throws. A pass that cannot mint leaves the last good file standing,
  // which is the right direction: that token is good for up to another hour, and
  // the next tick is 60 s away.
  async refreshGhCredentials() {
    if (!this.minter) return
    for (const agent of this.agents.values()) {
      if (!agent.repo || !agent.cfgDir) continue
      if (!readGhCredentials(agent.cfgDir)) continue
      const role = this.#ghRoleFor(agent.reviewer)
      const token = await this.#mintGhToken(agent.repo, role, agent.session)
      if (!token) continue
      try {
        writeGhCredentials(agent.cfgDir, token)
      } catch (e) {
        this.log(`could not refresh the GitHub credential of ${agent.session} (${e.message}) — the file it already holds stands until the next tick`)
      }
    }
  }

  // The OVERSEER's credential, on the same tick and for the same reason (#392).
  //
  // The overseer is one long-lived container, not a fleet, so this pass is per
  // WATCHED OWNER rather than per agent: one read-only token each, written to
  // the tree the container mounts read-only. An installation token lives one
  // hour and that container runs for weeks, so the file is the only shape the
  // value can take.
  //
  // IT WRITES FOR EVERY WATCHED OWNER, whether or not the container has ever
  // asked. That is the point of the ticket: compose used to hand the token over
  // at container create, so an owner the container never held needed an env file
  // edited and the service recreated. Now the watch list is the whole input, and
  // the next turn re-reads the tree.
  //
  // It never throws. An owner curia cannot mint for keeps whatever file it has —
  // that token is good for up to another hour — and the container says the rest
  // in the chat, once per turn, through `unroutedNote`.
  async refreshOverseerCredentials() {
    if (!this.minter) return
    const dir = overseerTokensRootFor(this.config.dispatch.workspace_root)
    const owners = ownersOf((this.config.watch ?? []).map((w) => w.repo))
    for (const owner of owners) {
      let token = null
      try {
        token = await this.minter.tokenFor(owner, 'read')
      } catch (e) {
        this.log(`could not mint the overseer's read token for ${owner} (${e.message}) — it reads ${owner}/* with no credential until this passes`)
        continue
      }
      // Read back first, so the log states the arming of an owner once instead
      // of every sixty seconds. A file this pass cannot read is one it replaces.
      let armed = null
      try {
        armed = readOverseerToken(dir, owner)
      } catch { /* a file that is not a token is a file this pass overwrites */ }
      try {
        const file = writeOverseerToken(dir, owner, token)
        if (!armed) this.log(`the overseer reads ${owner}/* through ${file}`)
      } catch (e) {
        this.log(`could not write the overseer's token for ${owner} (${e.message})`)
      }
    }
    // A credential nobody watches is a credential nobody refreshes either.
    try {
      for (const name of sweepOverseerTokens(dir, owners)) {
        this.log(`removed the overseer token file ${name} — no watched repo names that owner`)
      }
    } catch (e) {
      this.log(`could not sweep the overseer token files (${e.message})`)
    }
  }

  // Ports already handed to LIVE agents, so two dispatches landing together
  // cannot publish the same host port. Everything else on the box is caught by
  // the bind probe inside allocatePorts.
  #allocatePorts() {
    const taken = [...this.agents.values()].flatMap((w) => w.ports ?? [])
    return this.deps.allocatePorts(this.config.sandbox.ports, { count: PORTS_PER_AGENT, taken })
  }

  // Everything a container needs before the pane can start it: the image and
  // the environment file. The ports arrive already allocated, because the prompt
  // names them and is written first (#157). Every step here can fail, and all of
  // them run inside #dispatch's try — so a failure unclaims the ticket rather
  // than leaving it assigned to an agent that never ran.
  async #prepareContainer({ session, ticket, repo, harness, wtPath, cfgDir, spawnCmd, sandbox, ports, reviewer = false }) {
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
      this.reduction.journal('agent_image_built', { agent: session, ticket, image: image.ref })
      this.log(`built the agent image ${image.ref} for ${session}`)
    }
    // The pin and the prune (#350). Both are the image module's own work; what
    // belongs here is saying what happened. A failed pin does not refuse the
    // dispatch — the image is on the box — but it is the one warning that
    // explains a four-minute rebuild after the next nightly docker cleanup.
    if (image.pin?.error) {
      this.log(`WARNING: could not pin the agent image ${image.ref}: ${image.pin.error} — the box's nightly docker cleanup deletes every image no container references`)
    } else if (image.pin?.created) {
      this.reduction.journal('agent_image_pinned', { agent: session, ticket, image: image.ref })
      this.log(`pinned the agent image ${image.ref}`)
    }
    if (image.pruned?.length) {
      this.reduction.journal('agent_image_pruned', { agent: session, ticket, tags: image.pruned })
      this.log(`removed ${image.pruned.length} superseded agent image tag(s): ${image.pruned.join(', ')}`)
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
      this.reduction.journal('side_channel_ready', { agent: session, ticket, gateway })
    } catch (e) {
      throw new Error(`refusing to start a sandboxed agent for #${ticket}: ${e.message}. An agent in a container with no side channel cannot reach ask_human, the Stop hook, or any curia tool`)
    }
    // The agent's GitHub authority (#389). The token is minted HERE rather than
    // read out of the environment, and it goes to a file the container mounts
    // instead of into the container's environment — an installation token lives
    // one hour, so a value frozen at spawn dies inside a long ticket.
    //
    // The forget on the fallback arm is not a tidy-up. A config dir is reused
    // across dispatches and across the cross-harness respawn, so an arm that
    // falls back to the PAT could otherwise leave the last arm's `hosts.yml`
    // beside a `GH_TOKEN` that now beats it — a credential on disk nothing
    // reads, and a refresh that would keep it live.
    const role = this.#ghRoleFor(reviewer)
    const ghToken = await this.#mintGhToken(repo, role, session)
    if (ghToken) {
      writeGhCredentials(cfgDir, ghToken)
      this.reduction.journal('agent_token_minted', { agent: session, ticket, repo, role })
      this.log(`minted a ${role} GitHub token for ${session} on ${repo}`)
      // And the commit says the same thing the push now does. A reviewer is
      // skipped because it commits nothing at all: ADR-0010 gives it a detached
      // head and no branch.
      if (!reviewer) await this.#authorAsBot(wtPath, ghToken, session)
    } else {
      forgetGhCredentials(cfgDir)
    }
    const envFile = writeEnvFile(path.join(cfgDir, ENV_FILE), {
      ...agentEnv(GUEST_CFG, harness, { repo, sandboxed: true, minted: Boolean(ghToken) }),
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
  #assertTracker(repo, n, session, wtPath, mapNumber, { charting = false } = {}) {
    if (fs.existsSync(path.join(wtPath, TRACKER_DOC))) return
    // #241: a NEW-map dispatch has no map number and still must not run without
    // the doc — it is the agent that would create the whole map in `.scratch/`,
    // which is the worst version of this fault rather than an exempt one.
    if (mapNumber || charting) {
      const what = mapNumber
        ? `an agent on ${String(mapNumber) === String(n) ? `map #${n}` : `map child #${n}`}`
        : 'an agent charting a new map'
      throw new Error(`${repo} has no ${TRACKER_DOC}, so ${what} would fall back to the local-markdown tracker and write .scratch/ files instead of resolving on GitHub — run \`/setup-matt-pocock-skills\` in ${repo} first`)
    }
    this.reduction.journal('tracker_doc_missing', { repo, ticket: n, agent: session })
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
    const wayOut = where === 'respawn'
      ? 'The harness this agent was dispatched on does not load it, and the fallback harness does. Remove the file from the repo, or dispatch the ticket again once a harness that does not load it is warm'
      : 'Remove the file from the repo, or dispatch on another harness if only one harness loads it (`/start <ticket> <model>`)'
    const planted = untrustedProjectConfig(wtPath, harnessName)
    // #224: the same family, one step milder — a repo skill under a name curia
    // installs impersonates the seeded tooling, and on the codex harness it is
    // listed to the model beside and before the installed copy. A repo skill
    // under any other name stays welcome.
    const plants = planted ? [] : plantedSkills(wtPath, harnessName, this.config.skills?.install)
    if (!planted && !plants.length) return
    const e = planted
      ? new Error(`${planted} is a config file curia did not write, and the ${harnessName} harness loads it with no prompt — hooks in it would run unreviewed, with no model in the loop. ${wayOut}`)
      : new Error(`${plants[0].path} is a repo-carried skill named \`${plants[0].name}\`, a name curia installs, and the ${harnessName} harness loads it — the model would read the repo's copy in place of, or beside, the one curia seeded. ${wayOut}`)
    // #217: this throw is curia DECLINING, not curia failing, and only here is
    // that known — by the time it lands in a catch it is one more thrown Error.
    // The mark is what lets the respawn callers frame it as the decision it is.
    e.refusal = true
    throw e
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
  //
  // `armFor` is #346: pass `{ ticket, repo }` and this exhaustion also ARMS a
  // limit resume for that ticket. The promise rides the one message rather than
  // a second one, because the latch is per WINDOW and the promise is per
  // TICKET: with the promise on its own line, the second ticket to exhaust in
  // one window would be armed and never told (ADR-0013 — one fact, one voice,
  // and the two facts land in two different threads).
  #exhausted(ticket, repo, { armFor = null } = {}) {
    const reset = this.cooling.earliestReset()
    const when = reset ? reset.toISOString() : 'unknown'
    this.reduction.journal('dispatch_exhausted', { repo, ticket, earliest_reset: when })
    const resumeAt = armFor ? this.#armLimitResume(armFor.ticket, armFor.repo) : null
    this.#armWake(reset ?? new Date(Date.now() + 3600_000))
    if (this.exhaustionNotified) return this.#exhaustedReply(resumeAt)
    this.exhaustionNotified = true
    this.notify(ticket, resumeAt
      ? `⚠️ every routing lane is cooling. The claim is released and the worktree stands. curia resumes this ticket at ${discordTime(resumeAt)}`
      : `⚠️ every routing lane is cooling — no claim made. Earliest reset: ${reset ? discordTime(reset) : 'unknown'}`)
    return null
  }

  #exhaustedReply(resumeAt = null) {
    const reset = this.cooling.earliestReset()
    if (resumeAt) {
      return `⏳ every routing lane is cooling. The worktree stands, and curia resumes this ticket at ${discordTime(resumeAt)}`
    }
    return `⚠️ all routing lanes are cooling (earliest reset ${reset ? discordTime(reset) : 'unknown'}) — nothing claimed`
  }

  // ---- the limit resume (#346) ---------------------------------------------------
  //
  // A cap does not park an agent: #handleLimit kills it and falls down the
  // chain, and only true exhaustion releases the claim and drops the ticket
  // back on the frontier. What stayed parked was the TICKET. The wake timer
  // fired `#autoTick`, `#autoTick` returns at once while `auto_dispatch` is
  // false, and `auto_dispatch` ships false — so the work stopped until a human
  // noticed and typed `resume` themselves.
  //
  // Three rules decide the shape, and each keeps a wrong answer out:
  //
  //   1. It resumes, it does not start. `resume` inherits the surviving
  //      worktree and the last model; `start` calls createPrivateClone, which
  //      DELETES that worktree first and takes every uncommitted file with it.
  //   2. It is not gated on `auto_dispatch`. That flag decides whether curia
  //      takes NEW work off the frontier by itself. This puts back work the
  //      operator already ordered and curia itself stopped.
  //   3. One arm buys ONE attempt. The cooling is its own throttle: a resume
  //      that walks back into the cap re-cools with a fresh reset and arms
  //      again from there, so a wrong reset instant costs one spawn per window
  //      rather than a loop.

  // Arm the resume, and answer with the instant it will run at. Null when
  // nothing is cooling any more — there is then no reset to wait for, and the
  // ordinary dispatch path is already open.
  #armLimitResume(ticket, repo) {
    const reset = this.cooling.earliestReset()
    if (!reset) return null
    const at = new Date(reset.getTime() + this.resumeGraceMs)
    this.limitResumes.set(String(ticket), { repo: repo ?? null, at })
    this.reduction.journal('limit_resume_armed', {
      repo, ticket, resume_at: at.toISOString(), cooling_until: reset.toISOString(),
    })
    return at
  }

  // ONE timer for both wake reasons, set to whichever comes first: the earliest
  // cooling reset (the exhaustion latch clears there, and the auto loop gets a
  // tick) and the earliest armed resume. `floor` is the instant the exhaustion
  // path insists on even with nothing cooling, so the latch can never stick.
  #armWake(floor = null) {
    const times = []
    const reset = this.cooling.earliestReset()
    if (reset) times.push(reset.getTime())
    for (const e of this.limitResumes.values()) times.push(e.at.getTime())
    if (floor) times.push(floor.getTime())
    clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    if (!times.length) return
    const ms = Math.max(this.wakeFloorMs, Math.min(...times) - Date.now())
    this.wakeTimer = setTimeout(() => {
      this.#wake().catch((e) => this.log('post-cooldown wake failed:', e.message))
    }, ms)
    this.wakeTimer.unref()
  }

  // The resumes run BEFORE the auto tick, so an auto-dispatch that is on cannot
  // `start` a ticket this pass is about to `resume` — the session is live by
  // then and #autoTick skips it.
  async #wake() {
    this.wakeTimer = null
    this.exhaustionNotified = false
    const now = Date.now()
    for (const [ticket, entry] of [...this.limitResumes]) {
      if (entry.at.getTime() > now) continue
      this.limitResumes.delete(ticket)
      await this.#runLimitResume(ticket, entry)
    }
    this.#armWake()
    await this.#autoTick()
  }

  // One attempt, and it always says what happened. Silence after a cap is the
  // fault this whole path exists to end, so a resume that curia cannot make —
  // the ticket closed, somebody else claimed it, the dispatch threw — lands in
  // the same thread as the promise did.
  async #runLimitResume(ticket, entry) {
    let reply
    try {
      reply = await this.resume(ticket, { repo: entry.repo ?? undefined, by: 'limit-reset' })
    } catch (e) {
      this.reduction.journal('limit_resume', { repo: entry.repo, ticket, outcome: 'failed', error: e.message })
      this.notify(ticket, `⚠️ the usage limit reset and curia could not resume this ticket: ${e.message}. \`resume ${ticket}\` starts a fresh agent on the surviving worktree`)
      return
    }
    this.reduction.journal('limit_resume', { repo: entry.repo, ticket, outcome: 'ran' })
    // A lane that is STILL cooling re-armed this ticket inside the dispatch —
    // and #exhausted has already stated the new instant in this thread. Adding
    // the reply on top would say the same window twice.
    if (this.limitResumes.has(String(ticket))) return
    this.notify(ticket, `⏰ the usage limit reset. ${reply}`)
  }

  // Boot repair (#346): the arms this process did not make. Cooling holds for
  // hours and a deploy takes minutes, so most arms outlive the daemon that
  // wrote them. An arm whose instant already passed is due at once, which is
  // exactly the daemon that was down through the whole window.
  #reArmLimitResumes() {
    if (typeof this.reduction.armedLimitResumes !== 'function') return
    for (const { ticket, repo, at } of this.reduction.armedLimitResumes()) {
      const when = new Date(at)
      if (!Number.isFinite(when.getTime())) continue
      const session = `curia-${ticket}`
      // Adoption has already run this pass, so a live agent here is an agent
      // that came back some other way and needs no resume.
      if (this.agents.has(session) || this.inFlight.has(session)) continue
      this.limitResumes.set(String(ticket), { repo: repo ?? null, at: when })
      this.log(`reconcile: re-armed the limit resume of ${repo ?? '?'}#${ticket} for ${when.toISOString()}`)
    }
    this.#armWake()
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
  // `tellBuilder` is #258: a cross-check the operator starts from the command
  // seam lands on a builder that is WORKING, and nothing in its context says a
  // second model is reading. The notice is what says it. The gate press passes
  // `false`, because the builder there is about to park inside the very call
  // that would carry the notice — one fact, one voice (ADR-0013).
  async crossCheck(n, { repo, model, by, tellBuilder = true } = {}) {
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
      const builderModel = builder?.model ?? this.#epochSpawn(builderSession)?.model ?? null
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

      // The newest reading, before the pairing is resolved (#384). A reviewer is
      // a spawn like any other, so it steps over a held provider the same way —
      // and `resolveReviewer` reads the same store `candidates` reads.
      this.judgeReadings()

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
        harnessName, sameProvider, by, tellBuilder,
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
  async #spawnReviewer({ session, ticket, repo, issue, model, builderModel, harnessName, sameProvider, by, tellBuilder = true }) {
    const cfgDir = cfgDirFor(this.root, session)
    let checkout = null
    try {
      checkout = await this.deps.createReviewCheckout(this.root, repo, ticket)
      this.#assertNoPlantedConfig(checkout.path, harnessName)
      this.#armAgent({ session, ticket, harness: harnessName, model, wtPath: checkout.path, cfgDir })
      // No published ports: a reviewer starts no dev server, and
      // `publish_preview` is one of the four tools curia refuses it. Three
      // ports per reviewer would be three ports a builder could not have.
      const promptFile = this.deps.writeReviewPrompt(cfgDir, issue, {
        repo, wtPath: GUEST_WT, branch: checkout.branch, baseBranch: checkout.baseBranch,
        sha: checkout.sha, model: spawnModelId(this.routing, model),
        builderModel: spawnModelId(this.routing, builderModel),
      })
      fs.rmSync(path.join(this.dataDir, 'results', `${session}.json`), { force: true })

      const plan = await this.#spawnPlan({
        session, ticket, repo, harness: harnessName, model,
        wtPath: checkout.path, cfgDir, promptFile, ports: [], reviewer: true,
      })
      const exitMarker = newExitMarker()
      await this.deps.newSession({ name: session, cwd: checkout.path, env: plan.env, shellCmd: plan.shellCmd, exitMarker })

      // `reviewer_spawned` carries everything a restarted daemon needs to adopt
      // this session and still capture its verdict — the journal is the state
      // home for exactly what tmux cannot re-derive (#reconcileReviewers).
      this.reduction.journal('reviewer_spawned', {
        repo, ticket, agent: session, builder: `curia-${ticket}`, model, harness: harnessName,
        builder_model: builderModel, same_provider: sameProvider, sha: checkout.sha,
        checkout: checkout.path, base_branch: checkout.baseBranch, by: by ?? 'unknown',
        sandbox: 'docker', image: plan.container.image,
      })
      // `agent_spawned` too, and deliberately: the status line, the timeline and
      // every surface that draws an agent read that event. A reviewer with its
      // own status line in the ticket thread is what ADR-0010 asks for, and this
      // is the one event that gives it one.
      this.reduction.journal('agent_spawned', {
        repo, ticket, agent: session, model, harness: harnessName, kind: spawnKind({ reviewer: true }),
      })

      const agent = {
        repo, ticket, title: issue.title, session, instance: `${session}@${Date.now()}`,
        wtPath: checkout.path, cfgDir, promptFile,
        model, requestedModel: model, harness: harnessName,
        provider: this.routing.models[model].provider,
        ports: null, sandbox: 'docker',
        promptHarness: harnessName,
        spawnedAt: Date.now(), state: 'spawning', resultReceived: false,
        // What makes every refusal and every terminal branch below read this as
        // a reviewer rather than as a ticket agent.
        reviewer: true, builderModel, sameProvider, sha: checkout.sha, baseBranch: checkout.baseBranch,
        exitMarker,
        promptCarriesLimitText: textCarriesLimitPhrase(issue.title, issue.body),
      }
      this.agents.set(session, agent)
      this.#watchdog(agent).catch((e) => this.log(`watchdog ${session} failed:`, e.message))
      if (tellBuilder) this.#tellBuilderOfCrossCheck(ticket, session)
      const named = spawnModelId(this.routing, model)
      const note = sameProvider ? ` — **${SAME_PROVIDER_STAMP}**, so this is the weaker check` : ''
      return `🔎 cross-checking ${repo}#${ticket} → \`${session}\` on **${named}**${note} — it reads \`${checkout.sha.slice(0, 12)}\` and writes nothing`
    } catch (e) {
      this.agents.delete(session)
      this.deps.removeConfigDir(cfgDir)
      this.deps.forgetAgentToken(this.dataDir, session)
      if (checkout) await this.#removeReviewCheckout(repo, ticket, checkout.path)
      this.reduction.journal('reviewer_spawn_failed', { repo, ticket, agent: session, error: e.message })
      return `⚠️ the cross-check of ${repo}#${ticket} could not start: ${e.message} — the builder is untouched`
    }
  }

  // The notice the builder gets the moment a reviewer starts on its diff (#258).
  //
  // #223 died of a builder that never knew: the operator started the cross-check
  // from the command seam, the builder was working, and it merged, resolved and
  // reported while the reviewer was still reading. The park closes the race for
  // every call curia holds the wire on; this closes the half curia does not hold.
  // `gh pr merge` and `gh issue close` run in the agent's own shell, and the only
  // way into a running agent is its next tool result.
  //
  // Queued, never injected. #252 gives the interrupt to the OPERATOR, behind a
  // button, because Escape aborts whatever the agent is doing — and the thing it
  // would abort here is often the merge this notice exists to stop half-way
  // through. A queued note is what the ticket asks for: the verdict arrives as a
  // message, and so does its warning.
  #tellBuilderOfCrossCheck(ticket, reviewer) {
    const builder = `curia-${ticket}`
    const w = this.agents.get(builder)
    // No builder, no reader. The verdict's own carrier (#252) is the net for
    // that case, and it states the whole verdict rather than a warning about one.
    if (!w) {
      this.reduction.journal('cross_check_unannounced', { ticket, agent: builder, reason: 'no builder is running' })
      return false
    }
    this.reduction.queueAgentNote?.(builder, [
      `\`${reviewer}\` is reading your diff on #${ticket} right now. The operator started a cross-check.`,
      'Its verdict comes to you as a message on a later tool result, and judging it is your duty.',
      '',
      'Until it lands: do not resolve the ticket, do not merge the pull request, and do not call',
      '`report_result`. `report_result` and `request_review` park until the verdict arrives, so neither',
      'call is a way past this. The resolve and the merge are `gh` commands in your own shell, and you',
      'are the only one who can hold those.',
    ].join('\n'), { instance: w.instance ?? null, label: CROSS_CHECK_LABEL })
    this.reduction.journal('cross_check_announced', { ticket, agent: builder, reviewer })
    return true
  }

  // Is this agent the cross-check reviewer? The NAME is the authority, not the
  // record: a daemon restart empties the agents map, and a reviewer whose record
  // is missing must still be refused every write tool rather than falling
  // through to the builder's path with the builder's ticket in hand.
  #isReviewer(agentName) {
    return REVIEW_SESSION_RE.test(String(agentName ?? ''))
  }

  // The same predicate, readable from outside, and journalling nothing (#419).
  // `toolRefusal` answers the same question but writes a refusal line, which is
  // wrong for a caller that only wants to know which SHAPE a call carries. The
  // report lint asks it: a reviewer's `report_result` summary is the verdict,
  // and #421 types that surface.
  isReviewerSession(agentName) {
    return this.#isReviewer(agentName)
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
    this.reduction.journal('reviewer_tool_refused', { repo: w?.repo, ticket, agent: agentName, tool })
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
    const spawn = this.reduction.questions.reviewerSpawn(agentName)
    const ticket = String(w?.ticket ?? spawn?.ticket ?? String(agentName).match(REVIEW_SESSION_RE)?.[1] ?? '')
    const repo = w?.repo ?? spawn?.repo ?? null
    if (!ticket) {
      this.reduction.journal('verdict_skipped', { agent: agentName, reason: 'no ticket is bound to this reviewer' })
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
    this.reduction.journal('verdict_captured', {
      repo, ticket, agent: agentName, model: verdict.model, status: result.status,
      same_provider: sameProvider, chars: verdict.verdict.length, on_disk: held,
    })
    const named = spawnModelId(this.routing, verdict.model ?? '')
    const stamp = sameProvider ? ` (**${SAME_PROVIDER_STAMP}**)` : ''
    // #237: a verdict that lost the race says so, loudly, instead of the
    // neutral holding line. On #223 the merge beat the verdict by three
    // seconds, and "curia is holding it" read as a delivery — the operator had
    // no word that the verdict gated nothing.
    const late = this.#verdictIsLate(ticket)
    if (late) {
      this.reduction.journal('verdict_late', { repo, ticket, agent: agentName })
      this.notify(ticket, `🔎 cross-check verdict on ${repo ?? ''}#${ticket} from \`${agentName}\` on **${named}**${stamp} — ⚠️ it arrived TOO LATE to gate anything: the ticket was resolved before the verdict landed. The verdict goes on the pull request; reopening is the operator's call.`)
    } else {
      this.notify(ticket, `🔎 cross-check verdict on ${repo ?? ''}#${ticket} from \`${agentName}\` on **${named}**${stamp} — curia is holding it${held ? '' : ' in memory only: the artifact could NOT be written'}`)
    }
    // The return path (#165). It runs INSIDE the reviewer's own tool call, so a
    // failure in it must never fail the capture: the verdict is already held,
    // and a reviewer told its work failed would be told a lie about the one
    // thing it did. Every step inside reports itself on the surfaces instead.
    try {
      await this.#deliverVerdict(verdict)
    } catch (e) {
      this.reduction.journal('verdict_delivery_failed', { repo, ticket, agent: agentName, error: e.message })
      this.#failureNotify(ticket, 'verdict-return', `⚠️ the verdict on #${ticket} is captured, but curia's return path failed — ${failureProse(e.message)}. The builder may still be waiting at the gate.`)
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
          this.reduction.journal('usage_limit_ignored_ambiguous', {
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
        this.reduction.journal('agent_ready', { repo: agent.repo, ticket: agent.ticket, agent: agent.session, model: agent.model })
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
    this.reduction.journal(event, { repo: agent.repo, ticket: agent.ticket, agent: agent.session, ...data })
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
  //
  // #370 grew the stamp into a reading. EVERY call moves `mcpLastAt`, and only
  // the first one moves `mcpSeenAt` and journals. The reading stays in memory
  // for the same reason the stamp is journalled once: a tool call is traffic,
  // and the journal holds evidence. A line per call would make the record a
  // traffic log, and the reduction folds no such thing.
  //
  // Null there is two different facts, and `spawnedAt` tells them apart — the
  // rule #muteAtStop already reads. An agent this process spawned has said
  // nothing AT ALL. An agent it adopted after a restart has said nothing to
  // THIS process yet, and that silence belongs to the restart.
  onMcpCall(agentName) {
    const w = this.agents.get(agentName)
    if (!w) return
    w.mcpLastAt = Date.now()
    if (w.mcpSeenAt) return
    w.mcpSeenAt = w.mcpLastAt
    this.reduction.journal('agent_mcp_first', {
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
    this.reduction.journal('agent_mute', {
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
        const verb = e.refusal ? 'refused' : 'failed'
        this.log(`mute respawn of ${agent.session} on ${model} ${verb}:`, e.message)
        const released = await this.#releaseClaim(agent, `respawn after a mute agent ${verb}: ${e.message}`)
        this.notify(agent.ticket, this.#noRespawnNotify(agent, model, 'had no curia tools', e, released))
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
      this.reduction.journal('reset_unparseable', { agent: agent.session, scope: limit.scope, applied_cooldown_h: 1 })
    }
    if (limit.scope === 'model') {
      // Fable's own weekly sub-cap: cool only the model, provider stays warm.
      this.cooling.coolModel(agent.model, resetAt)
      this.reduction.journal('model_cooling', { model: agent.model, reset_at: resetAt.toISOString(), reset_source: source })
    } else {
      this.cooling.coolProvider(agent.provider, resetAt)
      this.reduction.journal('provider_cooling', { provider: agent.provider, reset_at: resetAt.toISOString(), reset_source: source })
    }
    await this.deps.killSession(agent.session).catch(() => {})

    const cands = candidates(this.routing, agent.requestedModel, this.cooling)
    if (cands.length) {
      const next = cands[0]
      // one name for what happened, so the respawned and the not-respawned
      // sentence cannot drift apart
      const cause = `hit ${limit.reason ? `the ${limit.reason}` : `a ${limit.scope} usage limit`}`
      try {
        await this.#respawnOn(agent, next, { retry_after_limit: true })
        this.notify(agent.ticket, `⚙️ \`${agent.session}\` ${cause} — respawned on **${next}**`)
        return
      } catch (e) {
        // The old session is already dead. Letting this reject would strand the
        // GitHub claim in an agent record reconcile deliberately skips, making
        // it unrecoverable short of /cancel — so take the same
        // release path true exhaustion takes.
        const verb = e.refusal ? 'refused' : 'failed'
        this.log(`respawn of ${agent.session} on ${next} ${verb}:`, e.message)
        const released = await this.#releaseClaim(agent, `respawn after ${limit.scope} usage limit ${verb}: ${e.message}`)
        this.notify(agent.ticket, this.#noRespawnNotify(agent, next, cause, e, released))
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
    //
    // #346 arms the resume here, and here ONLY: this is the one exhaustion
    // where curia stopped an agent it had already spawned, so the worktree it
    // was writing in survives and the operator's order still stands. A REVIEWER
    // is excluded. #releaseClaim has already unparked the builder with "the
    // reviewer ended", so a resumed reviewer would read the same diff a second
    // time and land its verdict on a builder that stopped waiting for one.
    const released = await this.#releaseClaim(agent, 'exhausted: all candidates cooling')
    const armFor = agent.reviewer ? null : { ticket: agent.ticket, repo: agent.repo }
    const suppressed = this.#exhausted(agent.ticket, agent.repo, { armFor })
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
    // Everything the agent reads names its paths — the prompt, the connection
    // settings, the config dir — so the whole arming runs again. The WORKSPACE
    // no longer moves with it: both harnesses run containers since #158, and
    // #195 deleted the other shape, so there is one workspace shape to respawn
    // into and no reshape to do.
    //
    // #157: the ports belong to the AGENT, not to one container. A respawn on
    // the same harness keeps its prompt (#rewritePrompt writes only when the
    // harness moved), so fresh numbers here would leave that prompt naming
    // ports nothing publishes. The caller's kill is an ordered teardown, which
    // removes the container before tmux (see the killSession wrapper), so the
    // old bindings are already released.
    // #164: a reviewer publishes nothing — it starts no dev server and
    // `publish_preview` is refused for it — so a respawn must not allocate three
    // host ports a builder could have had.
    const ports = agent.reviewer ? [] : (agent.ports ?? await this.#allocatePorts())
    this.#armAgent({
      session: agent.session, ticket: agent.ticket, harness: nextHarness,
      model: next, wtPath: agent.wtPath, cfgDir: agent.cfgDir,
    })
    await this.#rewritePrompt(agent, nextHarness, ports)
    const plan = await this.#spawnPlan({
      session: agent.session, ticket: agent.ticket, repo: agent.repo,
      harness: nextHarness, model: next, wtPath: agent.wtPath, cfgDir: agent.cfgDir,
      promptFile: agent.promptFile, ports, reviewer: Boolean(agent.reviewer),
    })
    // A fresh marker per spawn: the old session is dead, and reusing its nonce
    // would let the previous life's exit line — still on screen for a moment —
    // read as the successor's death.
    const exitMarker = newExitMarker()
    await this.deps.newSession({ name: agent.session, cwd: agent.wtPath, env: plan.env, shellCmd: plan.shellCmd, exitMarker })
    agent.ports = plan.container.ports
    agent.sandbox = 'docker'
    agent.exitMarker = exitMarker
    agent.model = next
    agent.harness = nextHarness
    agent.provider = this.routing.models[next].provider
    agent.spawnedAt = Date.now()
    agent.state = 'spawning'
    // A respawn is a NEW client process, so what the last one proved about its
    // tool channel says nothing about this one (#194). Clearing these is what
    // makes the second window a real second reading rather than an echo. The
    // last-contact reading goes with the stamp (#370): the successor has
    // reached curia never, and the predecessor's traffic must not say otherwise.
    agent.mcpSeenAt = null
    agent.mcpLastAt = null
    agent.readyAt = null
    // The whole line, not the delta (#219 — see `spawnKind` for the rule). What
    // changed is the model, the harness and the container; what did NOT change
    // is the dispatch this agent belongs to, and a reader that takes the last
    // line gets a description of a ticket agent unless this says otherwise.
    //
    // `kind` and `instruction` have live readers: #epochCharting answers the two
    // refused tools, the ending list, the result path and `resume`, which
    // dispatches a CHILD ticket instead of resuming the map when this says
    // `ticket`. `instance`, `sandbox`, `image` and `ports` have none today —
    // reconcile reads a container's ports back from docker itself. They are
    // restated anyway, because the spawn line is their stated state home and a
    // fact that lives here must not be erased by a respawn.
    this.reduction.journal('agent_spawned', {
      repo: agent.repo, ticket: agent.ticket, agent: agent.session,
      instance: agent.instance ?? null,
      model: next, harness: nextHarness,
      kind: spawnKind(agent), instruction: agent.instruction ?? null,
      sandbox: 'docker', image: plan.container.image, ports: plan.container.ports,
      ...journalData,
    })
    this.#watchdog(agent).catch((e) => this.log(`watchdog ${agent.session} failed:`, e.message))
  }

  // The HARNESS is the one reason to rewrite the prompt (#173). The wayfinder
  // invocation is spelled per harness, and a fallback down the chain crosses
  // providers by design — `opus` falls to `gpt`, which is the other harness.
  // Without this the codex agent would inherit the claude spelling and load
  // nothing. `nextHarness` is passed in rather than read off the record, which
  // still names the harness this agent is leaving.
  //
  // The agent's VIEW of its paths was the second reason until #195. There is
  // one workspace shape now, so the prompt names `/workspace` whatever the
  // harness — the view cannot move, and nothing has to watch it.
  //
  // The issue is re-read rather than remembered: the body is what the prompt
  // carries, and the agent record keeps only the title. A reviewer's prompt
  // carries no invocation, so a harness move rewrites the same text for it.
  // One guard for both is easier to trust than a branch about when the
  // difference matters, and the cost is one issue read.
  async #rewritePrompt(agent, nextHarness, ports = null) {
    if (nextHarness === agent.promptHarness) return
    // #164: a reviewer respawned down the fallback chain must be handed the
    // REVIEWER's prompt again. Writing the builder's here would give an agent
    // with no claim and no branch a full set of ticket standing orders.
    if (agent.reviewer) {
      const reviewed = await this.deps.fetchIssue(agent.repo, agent.ticket)
      agent.promptFile = this.deps.writeReviewPrompt(agent.cfgDir, reviewed, {
        repo: agent.repo,
        wtPath: GUEST_WT,
        branch: branchFor(agent.ticket),
        baseBranch: agent.baseBranch,
        sha: agent.sha,
        model: spawnModelId(this.routing, agent.model),
        builderModel: spawnModelId(this.routing, agent.builderModel),
      })
      agent.promptHarness = nextHarness
      return
    }
    const issue = await this.deps.fetchIssue(agent.repo, agent.ticket)
    const mapNumber = await this.#mapNumberFor(agent.repo, issue)
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    agent.promptFile = this.deps.writePrompt(agent.cfgDir, issue, {
      repo: agent.repo,
      wtPath: GUEST_WT,
      mapNumber,
      type: labels.find((l) => l.startsWith('wayfinder:')) ?? null,
      ports,
      harness: nextHarness,
      // #374: a fallback respawn rewrites the prompt, so it rewrites the
      // exchange with it. Without this the agent that crossed harnesses would
      // be the one agent on the ticket with no memory of the answers.
      exchange: this.reduction.answeredExchangeFor(agent.session),
    })
    agent.promptHarness = nextHarness
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
      this.reduction.journal('reviewer_ended', { repo: agent.repo, ticket: agent.ticket, agent: agent.session, reason })
      // #165: this is the choke point for every bad ending, and a builder parked
      // at the gate is waiting on THIS agent. Ending it without settling the
      // wait would park the builder forever on a second agent that is gone.
      this.#endReviewWait(agent.ticket, `the reviewer ended — ${reason}`)
      return true
    }
    // #221: a charting agent holds no claim either, for the reason a reviewer
    // holds none — nothing put one there. Unclaiming here would write to a map
    // curia never assigned, and on a map an operator HAS assigned by hand it
    // would quietly undo them. Same choke point, same guard, one line apart.
    if (agent.charting) {
      if (!keepCredentials) this.deps.removeCredentials(agent.cfgDir ?? cfgDirFor(this.root, agent.session))
      this.reduction.journal('charting_ended', { repo: agent.repo, map: agent.ticket, ticket: agent.ticket, agent: agent.session, reason })
      return true
    }
    let released = false
    let failure = null
    try {
      await this.deps.unclaim(agent.repo, agent.ticket, this.claimLogin())
      released = true
    } catch (e) {
      failure = e.message
    }
    // the session is dead and the record is being dropped, so nothing later
    // will collect the host OAuth credential copy — take it now; the rest of
    // the config dir (prompt.md) stays for post-mortem
    if (agent.cfgDir && !keepCredentials) this.deps.removeCredentials(agent.cfgDir)
    if (released) {
      this.reduction.journal('dispatch_unclaimed', { repo: agent.repo, ticket: agent.ticket, agent: agent.session, reason })
    } else {
      this.reduction.journal('unclaim_failed', { repo: agent.repo, ticket: agent.ticket, agent: agent.session, reason, error: failure ?? 'the unclaim did not run' })
    }
    return released
  }

  // What a failure message says about the claim after #releaseClaim ran. Two
  // agents can sit on one ticket since #164, and only one of them has a claim to
  // say anything about — so the sentence is chosen where the fact is known,
  // rather than repeated at four call sites that would each have to remember.
  #releaseTail(agent, released) {
    if (agent.reviewer) return 'the cross-check ends with no verdict; the builder and its claim are untouched'
    // #221: a map dispatch claims nothing, so there is no claim to report on.
    // What the operator needs instead is that the map may be half-edited.
    if (agent.charting) return 'the map was never claimed, so nothing was released — whatever the agent already wrote to the map STANDS'
    return released
      ? 'claim released, ticket re-frontiered'
      : 'claim release FAILED: the issue is still assigned; reconcile will retry'
  }

  // What the thread says when a respawn did not happen (#217). #respawnOn throws
  // for two facts the operator must not read as one:
  //
  //   could not   tmux exploded, the config dir would not seed. A fault, and the
  //               operator goes and finds it.
  //   would not   the planted-config refusal (#174). curia declining, and there
  //               is no fault to find — "failed" sends them hunting for one.
  //
  // The error already carries which one it is, so the frame is chosen HERE,
  // where that fact is known, rather than at the two call sites — the rule
  // #releaseTail above follows, for the same reason. Everything else is shared:
  // one shape, one verb swapped, so the two messages stay comparable.
  //
  // Prose, but NOT deduped (#256): one agent life ends once, so there is no
  // repeat to swallow, and a re-dispatch that dies the same way is a second
  // death the operator has to hear about. A REFUSAL is already prose — curia
  // composed it, and #174's way out lives in that sentence — so only the failed
  // arm, which carries whatever tmux or docker said, is translated.
  #noRespawnNotify(agent, next, cause, e, released) {
    const head = e.refusal
      ? `🚫 \`${agent.session}\` ${cause} and curia REFUSED to respawn it on **${next}**`
      : `⚠️ \`${agent.session}\` ${cause} and the respawn on **${next}** failed`
    const why = e.refusal ? e.message : failureProse(e.message)
    return `${head}: ${why} — ${this.#releaseTail(agent, released)}`
  }

  // Every daemon-side failure the thread hears goes through here (#256). The
  // line is already prose — `failureProse` runs at the call site, where the raw
  // error is — and this adds the other half: the thread hears one failure once.
  //
  // The key is the ticket, the failing act and the composed line together, so
  // two different failures of one act both speak, and one failure retried says
  // nothing new. Nothing is hidden by the silence: the failure event is
  // journalled on every occurrence, so the count is in the record whether or
  // not the thread carries it.
  #failureNotify(ticket, kind, text) {
    const line = this.failures.say(`${ticket} ${kind} ${text}`, text)
    if (line) this.notify(ticket, line)
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
    return { w, ticket, repo, wtPath, branch: branchFor(ticket) }
  }

  // The files a charting branch carries that a charting session is not allowed
  // to write (#297). Empty means the branch is clean by this bound.
  //
  // Fails OPEN: a diff curia could not read drops the check rather than trapping
  // an agent whose findings would then have no way to land at all. The human
  // gate still stands in front of the merge, and the failure is journalled — so
  // the worst case here is one unenforced bound, loudly, not a lost session.
  async #strayChartingPaths(wtPath) {
    try {
      const files = await this.deps.changedFilesOnBranch(wtPath, await this.deps.defaultBranchOf(wtPath))
      return files.filter((f) => !f.startsWith(CHARTING_WRITE_PREFIX))
    } catch (e) {
      this.reduction.journal('charting_paths_unread', { wtPath, error: e.message })
      this.log(`charting path check on ${wtPath} failed (${e.message}) — not refusing the push`)
      return []
    }
  }

  // ---- the diff digest, read on demand (#355) ------------------------------
  //
  // The BROWSER names an escalation id or an agent name and nothing else — no
  // path, no repo, no branch, no command. These two resolve the worktree
  // themselves, off the same binding every other agent-facing call reads. That
  // is the #266 seam: the console asks about a THING curia already knows about,
  // and curia decides what reading that means.

  // The live digest behind an agent row, committed and uncommitted work
  // together. Read on demand and never on the poll: it costs three local git
  // calls, and the 5s refresh would pay them for a card nobody opened.
  async agentDiff(agentName) {
    const b = this.#bindingFor(agentName)
    if (b.error) return { digest: null, error: b.error }
    return await this.deps.readDiffDigest(b.wtPath, { uncommitted: true })
  }

  // One file's hunks. `file` is an entry the digest itself produced, so the
  // path this reads is one curia measured rather than one a browser chose.
  //
  // A worktree that is gone falls back to the pull request's own diff, and the
  // answer says which source it came from. With no pull request either, it says
  // that too — an unreadable file and a file with no changes must not render
  // the same, the rule the digest's own null case follows.
  async agentHunks(agentName, file, { uncommitted = false } = {}) {
    const b = this.#bindingFor(agentName)
    if (b.error) return { text: null, error: b.error }
    if (fs.existsSync(b.wtPath)) {
      const out = await this.deps.readFileHunks(b.wtPath, file, { uncommitted })
      return { ...out, source: 'worktree', path: file.path }
    }
    const url = this.pullRequestUrlFor(agentName)
    const n = /\/pull\/(\d+)/.exec(url ?? '')?.[1]
    if (!n) {
      return {
        text: null, path: file.path, source: null,
        error: `the agent worktree is gone and curia knows no pull request for \`${agentName}\`, so there is nowhere left to read this diff from`,
      }
    }
    try {
      const patch = await this.deps.pullRequestDiff(b.repo, n)
      const slice = sliceFromPatch(patch, file.path)
      if (!slice) return { text: null, path: file.path, source: 'pull-request', error: `${file.path} is not in the pull request's own diff` }
      return { ...capText(slice), error: null, source: 'pull-request', path: file.path }
    } catch (e) {
      return { text: null, path: file.path, source: 'pull-request', error: e.message }
    }
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
    const { w, ticket, repo, wtPath, branch } = b
    if (!fs.existsSync(wtPath)) return `❌ the worktree ${wtPath} is gone — nothing was pushed`
    // #297, ADR-0008: a charting agent may push now — its research subagents
    // write files, and a pull request on `curia/<map>` is what keeps those
    // findings off main until a human approves them. What it may NOT push is
    // anything else. The bound is enforced HERE rather than left to the prompt,
    // for the reason the refusal it replaces was: this call pushes, and a
    // charting agent that has misread its own bounds must not be one tool call
    // away from putting daemon code on the remote.
    const mapDispatch = this.#epochCharting(ticket, agentName).charting
    // Which issue this pull request BELONGS to, for its body and its link
    // comment. On a map dispatch that is the map — and on a new-map dispatch the
    // bound ticket is a chat handle, which is no issue at all, so a body built
    // from it would carry a link that 404s. The JOURNAL keeps the bound ticket
    // either way: every epoch reader is keyed by it.
    const onIssue = mapDispatch ? (this.#chartedMap(agentName, ticket, w) ?? ticket) : ticket
    if (mapDispatch) {
      const stray = await this.#strayChartingPaths(wtPath)
      if (stray.length) {
        this.reduction.journal('charting_push_refused', {
          repo, ticket, agent: agentName, tool: 'open_pull_request', paths: stray,
        })
        return [
          `❌ \`${agentName}\` is a CHARTING agent on map ${repo}#${onIssue}, and a charting session commits`,
          `research findings and nothing else. \`${branch}\` touches ${stray.length} file(s) outside`,
          `\`${CHARTING_WRITE_PREFIX}\`:`,
          ...stray.slice(0, 10).map((p) => `- ${p}`),
          ...(stray.length > 10 ? [`- …and ${stray.length - 10} more`] : []),
          '',
          'Nothing was pushed. Take those files back out of the branch and call this again. If the map you',
          'were sent to chart really needs one of them changed, that is an `ask_human` call, not a commit.',
        ].join('\n')
      }
    }

    let title = w?.title
    if (!title) {
      title = await this.deps.fetchIssue(repo, ticket).then((i) => i.title).catch(() => `#${ticket}`)
    }
    let out
    try {
      out = await landBranch({
        repo, ticket, onIssue, title, summary, agent: agentName, model: w?.model ?? null,
        wtPath, branch, deps: this.deps,
        journal: (type, data) => this.reduction.journal(type, data),
      })
    } catch (e) {
      this.reduction.journal('land_failed', { repo, ticket, agent: agentName, branch, error: e.message })
      this.#failureNotify(ticket, 'land', `⚠️ \`${agentName}\`: opening the pull request FAILED — ${failureProse(e.message)}`)
      return `❌ curia could not land \`${branch}\`: ${e.message}. Your commits are safe in the worktree; fix what you can and call this again.`
    }
    if (!out.ok) {
      return `❌ nothing to open a pull request from — \`${branch}\` carries no commits. Commit your work first.`
    }
    if (w) w.prUrl = out.url
    await this.deps.commentIssue(repo, onIssue, prLinkComment({
      branch, commits: out.commits, url: out.url, state: out.state,
    })).catch((e) => this.log(`pull-request comment on ${repo}#${onIssue} failed: ${e.message}`))
    this.notify(ticket, `🔗 \`${agentName}\` ${out.state === 'updated' ? 'updated' : 'opened'} <${out.url}> (${out.commits} commit${out.commits === 1 ? '' : 's'} on \`${branch}\`)`)
    return `${out.state === 'updated' ? 'updated' : 'opened'} ${out.url} — ${out.commits} commit${out.commits === 1 ? '' : 's'} pushed on \`${branch}\`. Next: request_review.`
  }

  // `request_review` (#54 item 2, #48's gate). One gate, and it never branches on
  // ticket type: only the LINKS differ, and every one of them is composed here
  // from curia's own records rather than from anything the agent says — the
  // preview from the registry that allocated it, the pull request from GitHub,
  // the ticket from the spawn binding. #40 recorded the alternative as a live
  // limit: an agent can hand ask_human any `preview_url` string it likes.
  async requestReview(agentName, { summary = '', charting = '', body = '' } = {}) {
    // #164: the reviewer is what a gate ASKS ABOUT, never what opens one. A
    // reviewer at the gate would put its own reading in front of the operator as
    // if it were the work, on a ticket it is not building.
    const refused = this.toolRefusal(agentName, 'request_review')
    if (refused) return { ok: false, text: refused }
    const b = this.#bindingFor(agentName)
    if (b.error) return { ok: false, text: `❌ ${b.error} — no review was requested` }
    const { w, ticket, repo, branch, wtPath } = b
    // #297, ADR-0008: the gate is open to a charting agent now. #160 refused it
    // because a charting agent had no diff — that stopped being true when #286
    // gave the session research subagents that write files. The map edits are
    // still ungated (nothing stages them, and #149 put the operator there
    // instead); what this gate judges is the FINDINGS, and the heading says so.
    const mapDispatch = this.#epochCharting(ticket, agentName).charting

    // #237: the gate must not open blind to a cross-check. A live reviewer on
    // this ticket means a verdict is coming, and the builder asking for a gate
    // is one whose park was severed — a restart killed the parked call, or the
    // client aborted it. Opening a plain approve/reject gate here is how #223
    // merged ahead of its verdict: two buttons, and no word that a second model
    // was still reading. So the call re-parks instead, and returns exactly what
    // the press would have returned.
    if (this.#crossCheckInFlight(ticket)) {
      this.reduction.journal('cross_check_rejoined', { repo, ticket, agent: agentName })
      this.notify(ticket, `⏸️ \`${agentName}\` asked for the review gate while \`${reviewSessionFor(ticket)}\` is still reading its diff — re-parked until the verdict lands, no gate opened`)
      if (w) w.state = 'cross-checking'
      return await this.#parkForVerdict(agentName, { repo, ticket, w })
    }
    // #237, the other half of the same rule: a captured verdict this dispatch
    // never judged shuts the gate too. The duty is the builder's next act toward
    // the operator — judge every finding, one summary with a recommendation,
    // sent as a plain ask_human — and a gate opened over an unjudged verdict is
    // the duty skipped with nobody told. The verdict rides back on the note
    // queue so the refusal and the findings land in one tool result.
    const unjudged = this.#liveUnjudgedVerdict(ticket)
    if (unjudged) {
      this.reduction.journal('review_refused', { repo, ticket, agent: agentName, reason: 'unjudged cross-check verdict' })
      this.reduction.queueAgentNote?.(agentName, verdictNote(unjudged), {
        instance: w?.instance ?? null, label: VERDICT_LABEL,
      })
      return {
        ok: false,
        text: [
          `❌ no gate — a cross-check verdict on #${ticket} sits UNJUDGED, and judging it comes first.`,
          'The verdict rides in this same tool result as a note (it is also on the pull request). Read it, then:',
          '',
          ...dutyLines(),
        ].join('\n'),
      }
    }

    const title = w?.title ?? `#${ticket}`
    // #297: on a map dispatch the issue to look at is the MAP. For `map <n>`
    // that is the bound ticket itself; for a new-map dispatch the bound ticket
    // is a chat handle, which is no issue at all — so the link comes from what
    // the session adopted, and a session that adopted nothing gets a line
    // saying so rather than a URL that 404s.
    const map = mapDispatch ? this.#chartedMap(agentName, ticket, w) : null
    const links = [
      mapDispatch
        ? (map
          ? `Map: https://github.com/${repo}/issues/${map}`
          : '_This session has created no map yet — read the thread._')
        : `Ticket: https://github.com/${repo}/issues/${ticket}`,
    ]
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

    // The count, ONCE, at the instant the gate opens (#355, #343). The worktree
    // is guaranteed to exist here, because the agent is parked inside this very
    // call — so this is the one moment the numbers can be measured for free,
    // locally, with no network and no second reader. Everything downstream
    // (Discord, the console, a poll five seconds later, a card the operator
    // opens after the agent has died) reads this one stored answer.
    const { digest, error: digestError } = await this.deps.readDiffDigest(wtPath)
    if (!digest) this.log(`review gate for ${repo}#${ticket}: the diff could not be counted (${digestError})`)

    const { text } = reviewGateText({
      repo, ticket: map ?? ticket, title, summary, charting, links, mapDispatch, body,
      digestLine: digestLine(digest, digestError),
    })
    this.reduction.journal('review_requested', {
      repo, ticket, agent: agentName, pr: pr?.url ?? w?.prUrl ?? null,
      preview: preview?.url ?? null, ...(mapDispatch ? { kind: 'charting' } : {}),
      // Null, never empty (#355). A worktree that is already gone records the
      // reason, so the card can say curia could not count this diff instead of
      // drawing a change with no files in it.
      diff: digest, diff_error: digestError,
    })
    if (w) w.state = 'awaiting-review'
    // `recorded` is set only when the gate handed back an answer the operator
    // had already given to this same summary over this same diff (#369). It is
    // a LINE rather than a flag, and it stays out of `answer`: the answer is
    // classified by a narrow set of words, and a preface in front of `approve`
    // would read as a rejection.
    const { text: answer, status, recorded } = await this.askReview(agentName, ticket, text, { diff: digest, diffError: digestError })
    if (w && w.state === 'awaiting-review') w.state = 'ready'
    const said = (body) => (recorded && typeof body === 'string' ? `${recorded}\n\n${body}` : body)

    if (status !== 'answered') {
      this.reduction.journal('review_answered', { repo, ticket, agent: agentName, approved: false, status })
      return { ok: true, aborted: true, text: `${answer}\n\n(the review gate was ${status}, not answered — do not merge and do not resolve anything)` }
    }
    const { approved, crossCheck, feedback } = classifyReviewAnswer(answer)
    // #391, ADR-0018: the press becomes a real GitHub approval BEFORE it becomes
    // a fact anything else reads. On a repo whose default branch is protected an
    // unapproved pull request cannot be merged at all — and an approval curia
    // failed to post would send the agent at a merge GitHub refuses, with the
    // journal saying the ticket was approved. So the submission decides what is
    // journalled, and a failure reads as not approved everywhere: the Stop hook,
    // `/status` and the agent.
    //
    // PROTECTION IS THE OPERATOR'S OWN CHOICE, per repo, and nothing here reads
    // it. Curia never requires a setting in a watched repo. Without protection
    // the approval is still posted and still recorded, and the enforcement is
    // the one thing that is missing.
    const submitted = approved
      ? await this.#submitGateApproval({ repo, ticket, agentName, branch, pr, prUrl: w?.prUrl ?? null })
      : null
    const isApproved = approved && submitted.ok
    this.reduction.journal('review_answered', {
      repo, ticket, agent: agentName, approved: isApproved, via: 'gate',
      ...(crossCheck ? { outcome: 'cross-check' } : {}),
      // The press itself is kept when the submission lost it. Without this the
      // record says the operator rejected, which is the one thing they did not
      // do — and #374 writes this exchange into the next agent's prompt.
      ...(approved && !isApproved ? { outcome: 'approval-failed', pressed: 'approve', error: submitted.error } : {}),
      ...(recorded ? { recorded: true } : {}),
    })
    // #165, ADR-0010: the third button. The gate had two answers and now has
    // three, and this one answers NOTHING — nothing merges, nothing is rejected,
    // and the round ends where it started. What it does is put a second model on
    // the diff and hold the builder here until that model has read it.
    if (crossCheck) {
      const out = await this.#runCrossCheck(agentName, { repo, ticket, w })
      return { ...out, text: said(out.text) }
    }
    // The press the submission lost (#391). It is not a rejection: the operator
    // said yes, and nothing about the diff is wrong. What is missing is the
    // approving review on GitHub, and no commit the agent makes supplies it — so
    // the agent is sent to the operator rather than around the loop, and the
    // merge is forbidden the same way a rejection forbids it. That holds on an
    // unprotected repo too: the merge would go through, and it would put code on
    // the default branch with no record anywhere that a human approved it.
    if (approved && !isApproved) {
      this.#failureNotify(ticket, 'gate-approval', [
        `⚠️ ${repo}#${ticket} was APPROVED at the gate, and curia could not post the GitHub approval —`,
        `${failureProse(submitted.error)}. The pull request carries no approving review, so \`${agentName}\``,
        'was told not to merge. Nothing is resolved.',
      ].join(' '))
      return {
        ok: true,
        approved: false,
        approvalFailed: true,
        text: said([
          'NOT approved. The human pressed approve, and curia could NOT post the GitHub approval:',
          submitted.error,
          '',
          'So the pull request carries no approving review, and nothing outside this thread records that',
          'the code was approved. A protected branch refuses the merge outright.',
          'Do not merge and do not resolve. This is a fault on GitHub and not a fault in your diff, so',
          'no commit of yours fixes it: say what happened with `ask_human`, and call `request_review`',
          'again after the operator answers.',
        ].join('\n')),
      }
    }
    if (isApproved) {
      // The box with no app for this owner (#391). The ending is unchanged and
      // the agent is told nothing, because nothing about its next three acts
      // changes — but the OPERATOR is told, once per ticket, that their press
      // left no approval on GitHub. The cure is an installation, and only they
      // can make one.
      if (submitted.selfApproval) {
        this.#failureNotify(ticket, 'gate-selfapproval', [
          `ℹ️ ${repo}#${ticket}: GitHub refused the approval as a self-approval, so the pull request and`,
          'the ✅ press carry the same account. The press stands as the only record of it, and this thread',
          'is where that record lives. An installation of the curia app on this owner is what makes the',
          'approval real.',
        ].join(' '))
      }
      // #297: the ORDER is the answer to #48, and this is where it is said at
      // the moment it matters. A charting agent closes research tickets, never
      // the map — and it closes them after the merge, never before, because a
      // ticket closed on unmerged findings is exactly the map that lies.
      return {
        ok: true,
        approved: true,
        text: said(mapDispatch
          ? [
            `APPROVED by the human. Now, in order: merge the pull request (\`gh pr merge <url> --repo ${repo} --squash --delete-branch\`),`,
            'then resolve each research ticket you burned down — comment, close, map line — then report_result.',
            'Nothing closes before the merge, and the map itself never closes.',
          ].join('\n')
          : `APPROVED by the human. Now, in order: merge the pull request (\`gh pr merge <url> --repo ${repo} --squash --delete-branch\`), then resolve the ticket, then report_result.`),
      }
    }
    return {
      ok: true,
      approved: false,
      text: said([
        'NOT approved. The human said:',
        feedback || '(nothing beyond the rejection itself — ask them what to change with ask_human)',
        '',
        'Do not merge and do not resolve. Make the changes, commit, call open_pull_request again, then',
        'request_review again.',
      ].join('\n')),
    }
  }

  // ---- the press, submitted to GitHub (#391, ADR-0018) -------------------------

  // One approving review on the pull request the gate showed, posted under the
  // OPERATOR's own `gh` login. `approvePullRequest` says why that login and no
  // other. What this method owns is which pull request, and what a failure means.
  //
  // THE PULL REQUEST IS RE-READ. The gate opened with one read, and a human takes
  // hours to answer — so the state at the press is the state that decides, not
  // the state at the open.
  //
  // A SKIP IS NOT A FAILURE. Three cases reach it and all three are honest.
  //
  //   - A ticket that produced no code has no pull request and no merge either.
  //   - A pull request already MERGED can take no approval, which is the #369
  //     replay landing on work the operator approved once already.
  //   - A SELF-APPROVAL, which is a box with no GitHub App for this owner. The
  //     pull request is then the operator's own (#390's fallback is the host
  //     login), and GitHub refuses a review by its own author. ADR-0018 says no
  //     credential comes out ahead of its replacement, and blocking the ending
  //     there would take the whole ending out instead: that box keeps exactly
  //     the gate it had before this ticket, and the thread is told once.
  //
  // Everything else that goes wrong is a failure, the press does not become an
  // approval, and the caller says so to the agent and to the thread.
  async #submitGateApproval({ repo, ticket, agentName, branch, pr = null, prUrl = null }) {
    let target = pr
    let readError = null
    try {
      target = await this.deps.findPullRequest(repo, branch)
    } catch (e) {
      readError = e.message
      target = pr
    }
    if (!target) {
      // A pull request curia knows exists and cannot name is INDETERMINATE, and
      // an indeterminate approval is a failed one: the merge waits on a review
      // that may or may not be there, and nobody can tell which.
      if (readError || prUrl) {
        const why = `curia could not read the pull request for \`${branch}\`${readError ? ` (${readError})` : ''}`
        this.reduction.journal('pr_approval_failed', { repo, ticket, agent: agentName, branch, error: why })
        return { ok: false, error: why }
      }
      this.reduction.journal('pr_approval_skipped', {
        repo, ticket, agent: agentName, branch, reason: 'no pull request',
      })
      return { ok: true, skipped: 'no pull request' }
    }
    if (target.state !== 'OPEN') {
      this.reduction.journal('pr_approval_skipped', {
        repo, ticket, agent: agentName, branch, pr: target.url, reason: `the pull request is ${target.state}`,
      })
      return { ok: true, skipped: `the pull request is ${target.state}` }
    }
    try {
      await this.deps.approvePullRequest(repo, target.number)
    } catch (e) {
      if (SELF_APPROVAL_RE.test(e.message)) {
        this.reduction.journal('pr_approval_skipped', {
          repo, ticket, agent: agentName, branch, pr: target.url, reason: 'self-approval',
        })
        return { ok: true, skipped: 'self-approval', selfApproval: true, url: target.url }
      }
      this.reduction.journal('pr_approval_failed', {
        repo, ticket, agent: agentName, branch, pr: target.url, error: e.message,
      })
      return { ok: false, error: e.message }
    }
    this.reduction.journal('pr_approved', {
      repo, ticket, agent: agentName, branch, pr: target.url, number: target.number,
    })
    this.log(`review gate for ${repo}#${ticket}: approval posted on ${target.url}`)
    return { ok: true, url: target.url }
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
    this.reduction.journal('cross_check_requested', { repo, ticket, agent: agentName })
    // `crossCheck` never throws — every failure comes back as a line and leaves
    // the builder untouched. What decides here is the RECORD, not that line: a
    // reviewer in the agents map is the thing that can produce a verdict, and
    // parking on anything less would park on a sentence.
    // #258: no start notice on this path. The builder is inside the call that
    // would carry it, and the park text below says the same thing at the moment
    // the call returns — a queued notice would only ride out beside the verdict.
    const spawned = await this.crossCheck(ticket, { repo, by: 'review gate', tellBuilder: false })
    if (!this.agents.has(reviewSessionFor(ticket))) {
      if (w) w.state = 'ready'
      this.reduction.journal('cross_check_returned', { repo, ticket, agent: agentName, ok: false, why: 'not spawned' })
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
    return await this.#parkForVerdict(agentName, { repo, ticket, w })
  }

  // The park and everything after it, shared by the press and the rejoin (#237).
  // The rejoin exists because the park itself is process-scoped: a daemon
  // restart severs the parked MCP call, the builder's client sees an error, and
  // the model's natural next move is `request_review` again. On #223 that retry
  // opened a PLAIN approve/reject gate — the restarted daemon knew the reviewer
  // (reconcile re-adopts it) and never asked — so the operator approved and the
  // merge outran the verdict by three seconds.
  //
  // "The builder's client sees an error" is the CLAUDE lane, about 120 s after
  // the death. A codex builder sees nothing and sits in the park for up to
  // `CODEX_TOOL_TIMEOUT_S`, so on that lane the rejoin never gets its chance
  // (#371). This map is the second blocking call a restart strands, beside the
  // escalation resolvers in `index.mjs`, and #426's goodbye has to wake both.
  async #parkForVerdict(agentName, { repo, ticket, w }) {
    const out = await this.#awaitVerdict(ticket, agentName)
    if (w) w.state = 'ready'
    this.reduction.journal('cross_check_returned', { repo, ticket, agent: agentName, ok: out.ok, why: out.why ?? null })
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

  // Park the builder until this ticket's verdict lands. ONE waiter per ticket,
  // and the newest call owns it: `#endReviewWait` settles exactly one waiter, so
  // a second one left in the map would be a builder parked forever on a reviewer
  // that is already gone. #258 gives `report_result` the same park, which is
  // what makes a replacement possible at all — a gate park the client aborted
  // leaves a promise nobody reads, and the ending call takes the wait from it.
  #awaitVerdict(ticket, agentName, on = 'gate') {
    const key = String(ticket)
    this.#endReviewWait(key, 'the builder is now waiting on a newer call')
    return new Promise((resolve) => {
      this.reviewWaits.set(key, { agent: agentName, on, resolve })
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

  // A cross-check that has not returned yet (#237). The reviewer record is the
  // evidence, not the wait map: the wait map dies with the process, while a
  // live reviewer survives a restart through reconcile — which is exactly the
  // window this check exists for. A reviewer whose result already arrived is
  // not in flight; its verdict is, and #liveUnjudgedVerdict holds that half.
  #crossCheckInFlight(ticket) {
    const reviewer = this.agents.get(reviewSessionFor(ticket))
    return reviewer && !reviewer.resultReceived ? reviewer : null
  }

  // The captured verdict that still binds THIS dispatch, or null (#237). The
  // artifact outlives the dispatch that earned it — resolve keeps the file, a
  // cancel keeps the file — so an unjudged verdict counts only when it landed
  // after the ticket's last claim. Without the cut, a verdict some dead
  // dispatch never judged would shut every later agent's gate forever. A
  // resume is deliberately NOT a cut: it continues the same dispatch, and the
  // duty continues with it.
  #liveUnjudgedVerdict(ticket) {
    const v = this.verdictFor(ticket)
    if (!v || v.judged) return null
    const claimed = this.reduction.questions.lastClaimAt(ticket)
    if (claimed && v.at && v.at < claimed) return null
    return v
  }

  // Did the ticket resolve before its verdict landed (#237)? The journal is
  // the evidence — a `ticket_resolved` after the last `reviewer_spawned` means
  // the merge outran the reviewer — and the builder's own record is the
  // in-memory shortcut for the seconds before resolve journals anything.
  #verdictIsLate(ticket) {
    if (this.agents.get(`curia-${ticket}`)?.resultReceived) return true
    return this.reduction.questions.verdictIsLate(ticket)
  }

  // The PARK a builder's `report_result` earns while its cross-check is still
  // reading (#258). It runs at the wire, ahead of everything `resultRefusal`
  // guards, and it is the same control `request_review` has had since #165.
  //
  // #237 made this a refusal, and a refusal is a sentence the model reads and
  // then decides about. The park is not: the call stays open, the builder holds
  // its claim, its worktree and its context for nearly nothing (ADR-0005), and
  // the verdict lands ON this call. So the agent that tried to end the ticket is
  // the one that judges the verdict, which is what ADR-0010 asks for and what
  // #223 never got.
  //
  // Returns the text to hand back, or null to let the ending run on. Null is the
  // honest answer when the cross-check produced NO verdict: the reviewer died,
  // there is nothing to judge, and holding the builder any longer would punish
  // it for the operator's press.
  async endingHold(agentName) {
    if (this.#isReviewer(agentName)) return null
    const ticket = String(this.agents.get(agentName)?.ticket ?? String(agentName).match(SESSION_RE)?.[1] ?? '')
    if (!ticket) return null
    // #297 dropped the charting exemption that stood here. It was sound while a
    // charting agent could not reach the gate — no gate, no press, no verdict.
    // Now it can, so a charting session whose park a restart severed must be
    // held by the same rule as any other. A session with no cross-check falls
    // straight through the next line, which is every charting session there was.
    if (!this.#crossCheckInFlight(ticket)) return null

    const w = this.agents.get(agentName)
    const wasState = w?.state ?? null
    if (w) w.state = 'cross-checking'
    this.reduction.journal('result_parked', { repo: w?.repo, ticket, agent: agentName, reason: 'cross-check in flight' })
    this.notify(ticket, `⏸️ \`${agentName}\` tried to end #${ticket} while \`${reviewSessionFor(ticket)}\` is still reading its diff — parked until the verdict lands, and nothing was recorded`)
    const out = await this.#awaitVerdict(ticket, agentName, 'ending')
    if (w) w.state = wasState ?? 'ready'
    this.reduction.journal('cross_check_returned', {
      repo: w?.repo, ticket, agent: agentName, ok: out.ok, why: out.why ?? null, on: 'report_result',
    })
    if (!out.ok) return null
    // The verdict is not in this text. It is on the note queue, and the drain
    // appends it to this very tool result — the same shape the gate's park
    // returns, for the same reason: duty and findings in one turn.
    return [
      `HELD — \`${out.verdict.agent}\` read your diff on **${spawnModelId(this.routing, out.verdict.model ?? '')}**`,
      'while this call waited, so nothing was recorded and nothing was resolved. Its verdict rides in',
      'this same tool result as a note. Read it, then:',
      '',
      ...dutyLines(),
    ].join('\n')
  }

  // The refusal a builder's `report_result` earns while its cross-check is
  // unfinished (#237). The operator ruled the shape: after a verdict is
  // captured, the builder's next act toward the operator is its judgement, and
  // the ask must be answered before any merge or report_result. This runs at
  // the wire, BEFORE the result is journalled or written to disk — a results
  // file on disk reads as `hasResult` everywhere, and a refused result must
  // not leave that trace.
  //
  // #258 puts `endingHold` in front of it, so on the wire the in-flight case
  // parks rather than refuses. This stays the BELT: every caller that reaches
  // `onResult` directly passes here, and a refusal is the only answer a
  // synchronous belt can give.
  resultRefusal(agentName) {
    if (this.#isReviewer(agentName)) return null
    const ticket = String(this.agents.get(agentName)?.ticket ?? String(agentName).match(SESSION_RE)?.[1] ?? '')
    if (!ticket) return null
    // #297: the charting exemption goes here too, and for the same reason —
    // a gate a charting agent can open is a cross-check it can earn.
    if (this.#crossCheckInFlight(ticket)) {
      this.reduction.journal('result_refused', { ticket, agent: agentName, reason: 'cross-check in flight' })
      return [
        `❌ report_result refused — \`${reviewSessionFor(ticket)}\` is still reading your diff, and a ticket`,
        'cannot end around its own cross-check. Call `report_result` again, or `request_review`: both park',
        'you until the verdict lands and hand you the findings to judge. Nothing was recorded and nothing',
        'was resolved.',
      ].join('\n')
    }
    if (this.#liveUnjudgedVerdict(ticket)) {
      this.reduction.journal('result_refused', { ticket, agent: agentName, reason: 'unjudged cross-check verdict' })
      return [
        `❌ report_result refused — a cross-check verdict on #${ticket} sits UNJUDGED, and the ask must be`,
        'answered before any merge or report_result. The verdict is on the pull request. Then:',
        '',
        ...dutyLines(),
      ].join('\n')
    }
    return null
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
    this.reduction.journal('verdict_commented', {
      repo: verdict.repo, ticket, agent: verdict.agent, ok: posted.ok, why: posted.why ?? null,
    })
    // The comment url rides on the held artifact, because the carrier below —
    // and the one the expiry path posts later — link the full text, and this is
    // the only moment curia learns where that text lives. It goes to disk too:
    // the expiry can come after a restart, and a link only memory holds is a
    // link the carrier would not have.
    if (posted.ok && posted.url) {
      verdict.pr_url = posted.url
      this.verdicts.set(ticket, verdict)
      try {
        fs.writeFileSync(this.#verdictFile(ticket), JSON.stringify(verdict, null, 2))
      } catch (e) {
        this.log(`could not record the pull-request link on the verdict for #${ticket}: ${e.message}`)
      }
    }
    if (!posted.ok) {
      this.#failureNotify(ticket, 'verdict-comment', `⚠️ the cross-check verdict could NOT be posted on the pull request — ${failureProse(posted.why)}. curia still holds it, and the builder still gets it.`)
    }
    const w = this.agents.get(builder)
    if (!w) {
      // #252, ADR-0013: a verdict with no live reader is POSTED, not mourned.
      // The old line said only that it had nowhere to go, which on #223 was the
      // whole record of a four-finding fail verdict. The thread is the verdict's
      // last reader, so the thread gets the verdict.
      this.reduction.journal('verdict_undelivered', { repo: verdict.repo, ticket, agent: builder, reason: 'no builder is running' })
      this.notify(ticket, verdictCarrier({
        agent: verdict.agent,
        model: verdict.model,
        verdict: verdict.verdict,
        ticket,
        url: posted.ok ? posted.url : null,
        why: `\`${builder}\` is not running`,
      }))
      return
    }
    // #208's rule, and the caller is what marks the note: these words are for
    // THIS builder. A successor must not read a verdict about a diff it did not
    // write.
    this.reduction.queueAgentNote?.(builder, verdictNote(verdict), {
      instance: w.instance ?? null, label: VERDICT_LABEL,
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
    this.reduction.journal('judgement_commented', {
      repo: verdict.repo, ticket, agent: agentName, ok: posted.ok, why: posted.why ?? null,
    })
    if (!posted.ok) {
      this.#failureNotify(ticket, 'judgement-comment', `⚠️ \`${agentName}\`'s judgement of the cross-check could NOT be posted on the pull request — ${failureProse(posted.why)}. The question itself is in this thread.`)
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
  //
  // Three questions, three keyed queries (#408, `questions.mjs`). This ran at
  // the end of every turn of every agent and paid a whole read for it.
  #epochScan(ticket, agentName) {
    return this.reduction.questions.epochScan(ticket, agentName)
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
    const { w, ticket, repo, wtPath, branch } = b
    // One question, both answers. It was asked twice below when a whole read
    // answered it, and each ask is a query now (#408).
    const dispatchKind = this.#epochCharting(ticket, agentName)
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
      // #241 adds the third: a NEW-map dispatch owes one step more than a map
      // dispatch — the map has to exist, and curia has to be told its number,
      // or the session ends with its summary nowhere and its thread on a handle.
      charting: dispatchKind.charting,
      newMap: dispatchKind.newMap,
      mapAdopted: Boolean(this.#chartedMap(agentName, ticket, w)),
    }
    // #297 removed the charting shortcut that used to return here. A charting
    // checkout CAN carry commits now — its research subagents write findings —
    // so the same reads decide the same steps for both endings, and `hasCommits`
    // is what forks them. The cost is one `git log` per turn on a session that
    // wrote nothing, against the failure it buys: findings pushed by nobody.
    // #237: the two cross-check states the ending must name, so the Stop hook
    // holds a builder that stops instead of judging. A PARKED builder never
    // reaches this read (#humanBlockEvidence answers first); the builder that
    // does is one whose park was severed by a restart, which is the #223 shape.
    state.crossCheckInFlight = Boolean(this.#crossCheckInFlight(ticket))
    state.unjudgedVerdict = Boolean(this.#liveUnjudgedVerdict(ticket))
    try {
      const commits = await this.deps.commitsOnBranch(wtPath, await this.deps.defaultBranchOf(wtPath))
      state.hasCommits = commits.length > 0
    } catch (e) {
      this.log(`stop hook ${agentName}: could not read commits on ${branch} (${e.message}) — not asking for a pull request`)
    }
    // #297: the one charting-only read. A charting session is the only agent
    // whose ENDING branches on whether it wrote anything at all, and "no
    // commits" cannot tell a session that researched nothing from one that
    // wrote findings and never committed them. The second dies with the
    // workspace, silently, which is the whole failure this ending exists to
    // stop — so the Stop hook asks git what is sitting there.
    if (state.charting) {
      try {
        const dirty = await this.deps.uncommittedFiles(wtPath)
        state.uncommittedFindings = dirty.some((f) => f.startsWith(CHARTING_WRITE_PREFIX))
      } catch (e) {
        this.log(`stop hook ${agentName}: could not read the worktree status (${e.message}) — not asking for a commit`)
      }
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
  // The two stops one rejected call gets (#418, ADR-0005 as #438 amended it).
  //
  // The FIRST hands the rejection back and refuses the stop. The SECOND sends
  // the text itself, flagged, and lets the agent stop. The three-rejection cap
  // can never fire on codex by itself: an agent that lost its rejection has no
  // reason to call again, so without this the question would reach nobody.
  //
  // ADR-0005 named `stop_hook_active` as the key for "the second stop". #447
  // then measured that flag STICKY rather than per-question. It is false on the
  // first stop of a SESSION and true on every stop after it, so a rejection
  // arriving late in a session would be flagged and sent on its very first
  // block. The decision is unchanged and the count moved daemon-side, which is
  // what #447 says a design needing a count must do.
  //
  // Returns a Stop-hook answer, or null to fall through to the ending checks.
  async #holdForRejection(agentName, held) {
    if ((held.stop_blocks ?? 0) < 1) {
      this.reduction.journalLintStopBlock(agentName, held.kind)
      this.log(`stop hook ${agentName}: holding on a rejected ${held.kind} call — ${held.faults.length} lint fault(s)`)
      return {
        decision: 'block',
        reason: [
          `curia REFUSED your last \`${TOOL_FOR_KIND[held.kind] ?? 'ask_human'}\` call, and you did not read the refusal.`,
          held.kind === RESULT_KIND
            ? 'This ticket has reported nothing and nobody saw it. These are the faults:'
            : 'Nothing was asked and nobody saw it. These are the faults:',
          '',
          ...held.faults.map((f) => `• ${f}`),
          '',
          'Rewrite the named fields and make the call again. Keep every option and every constraint.',
        ].join('\n'),
      }
    }
    // The review gate and the ending report are both STEPS OF THE ENDING, so the
    // checklist below already holds an agent that never completed one. Only
    // `ask_human` has no such step, which is the hole this send exists to close.
    // A report is also the wrong thing to send this way: `sendFlagged` opens an
    // ESCALATION, and a report asks nobody anything (#419).
    if (held.kind === REVIEW_KIND || held.kind === RESULT_KIND || !this.deps.sendFlagged) {
      this.reduction.clearLintRejections(agentName, held.kind)
      return null
    }
    const sent = await this.deps.sendFlagged(agentName, held)
    this.reduction.journal('lint_flagged_send', {
      agent: agentName, kind: held.kind, id: sent?.id ?? null, faults: held.faults,
    })
    const ticket = this.agents.get(agentName)?.ticket
    if (ticket != null) {
      this.notify(ticket, `⚠️ \`${agentName}\` ended a turn holding a question curia refused ${held.count} time(s) on the lint. curia sent the text as it stands — the faults are on the card, under the question.`)
    }
    return { allow: true, terminal: false }
  }

  async onStopHook(agentName, { stopHookActive = false } = {}) {
    // #194's backstop, FIRST and before the nudge. An agent that got here having
    // never sent an `/mcp` request has no way to satisfy any item of the ending
    // — `open_pull_request`, `request_review` and `report_result` are all curia
    // tools — so holding it at that ending would spin it against a channel it
    // does not have. Allow the stop, and say why on the surfaces.
    if (this.#muteAtStop(agentName)) {
      const w = this.agents.get(agentName)
      this.reduction.journal('agent_mute', {
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

    // The lint gate's catch (#418, ADR-0005 as #438 amended it).
    //
    // On codex a rejection is the `exec` script's RETURN VALUE and it never
    // throws, not even the JSON-RPC error. A script that ignores the value
    // leaves codex reporting `Script completed` to the model. So an agent whose
    // call curia refused can believe the question went out and come here to end
    // its turn. This is the one lever that is a guarantee rather than prose: the
    // hook fires, codex refuses the stop, and the rejection reaches the model as
    // a user message it cannot discard.
    //
    // It sits UNDER #47. An agent already blocked on a human is not spinning on
    // anything, and its rejection waits for the turn after the answer.
    const held = this.deps.lintRejection?.(agentName)
    if (held) {
      const decision = await this.#holdForRejection(agentName, held)
      if (decision) return decision
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
      this.reduction.journal('stop_budget_exhausted', {
        agent: agentName, ticket: state.ticket, repo: state.repo, blocks: state.blocks, outstanding: items,
      })
      this.notify(state.ticket, `⚠️ \`${agentName}\` stopped with ${items.length} step(s) of the ending outstanding after ${state.blocks} nudge(s) — curia is no longer holding it:\n${items.map((t) => `• ${t}`).join('\n')}`)
      return { allow: true, terminal: true }
    }
    this.reduction.journal('stop_blocked', {
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
    // #237 belt: the wire refuses ahead of persisting anything, and this covers
    // every caller that reaches onResult directly. It sits before the
    // resultReceived mark, because a refused result must not read as
    // `hasResult` anywhere.
    if (result) {
      const refusedResult = this.resultRefusal(agentName)
      if (refusedResult) return refusedResult
    }
    const w = this.agents.get(agentName)
    if (w) w.resultReceived = true
    this.#closeQuestionsAtResult(agentName)
    if (!result) return 'result recorded'

    // #164: a reviewer's result IS the verdict, and nothing else happens on it.
    // Branched before every line below, because all of them act on a ticket —
    // and a reviewer that reached the resolve path would close the builder's.
    if (this.#isReviewer(agentName)) {
      try {
        return await this.#captureVerdict(agentName, result, w)
      } catch (e) {
        this.reduction.journal('verdict_failed', { agent: agentName, error: e.message })
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
      this.reduction.journal('resolve_skipped', { agent: agentName, reason: 'no ticket is bound to this agent' })
      return 'result recorded — no curia ticket is bound to this agent, so nothing on the tracker was touched'
    }
    if (result.ticket != null) {
      const ref = parseTicketRef(result.ticket)
      const boundRepo = w?.repo ?? null
      const sameTicket = ref.number === ticket
        && (!ref.repo || !boundRepo || ref.repo.toLowerCase() === boundRepo.toLowerCase())
      if (!sameTicket) {
        this.reduction.journal('result_ticket_mismatch', { agent: agentName, bound: ticket, reported: String(result.ticket) })
        this.log(`WARNING: ${agentName} reported ticket ${result.ticket} but is bound to ${ticket} — acting on ${ticket}`)
      }
    }
    const repo = w?.repo ?? this.#epochRepo(ticket)
    if (!repo) {
      this.reduction.journal('resolve_skipped', { agent: agentName, ticket, reason: 'no repo could be determined' })
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
      // A daemon-side FAILURE, not the ending: it keeps #256's own line, which
      // translates the raw error and says one failure once. The ending receipt
      // below still speaks for the ending, so neither event borrows the other's
      // message.
      this.reduction.journal('resolve_failed', { repo, ticket, agent: agentName, status: result.status, error: e.message })
      this.#failureNotify(ticket, 'resolve', `⚠️ ${repo}#${ticket}: the result was recorded but curia's resolve step failed — ${failureProse(e.message)}`)
      return `result recorded — but curia's resolve step failed: ${e.message}`
    }
  }

  // A question its own agent has finished past (#336).
  //
  // `report_result` is the agent's LAST call. A record still open on it can
  // never be read: the call that opened it died, and the agent that would have
  // resumed is at its end. Left open it does three things, all of them found
  // live — it holds the ticket on the Needs-You list, it makes the next Stop
  // hook mark a finished agent `blocked_on_human` (#47's evidence, reading a
  // corpse), and through that mark it holds the container up.
  //
  // This closes nothing on silence (#285). The agent's own result is what
  // closes the record, and only for the agent that reported it. A confirm
  // belongs to the operator, never to an agent's call, so it is not one of
  // these — `#openEscalationsFor` keys on the spawn binding.
  //
  // Cancel rather than lapse, for the reason every other void here cancels: it
  // settles the dead promise and edits the card, so a question the operator can
  // still see says it closed instead of asking on.
  #closeQuestionsAtResult(agentName) {
    for (const r of this.#openEscalationsFor(agentName)) {
      this.cancelEscalation(r.id, { by: 'result' })
      this.reduction.journal('escalation_stale_at_result', { id: r.id, agent: agentName, ticket: r.ticket })
      this.log(`${agentName} reported a result with ${r.id} still open — the question is stale, so it is closed`)
    }
  }

  // The repo this ticket was last dispatched against, for an agent whose record
  // this process never held (reconcile-adopted, or a restart mid-flight).
  #epochRepo(ticket) {
    return this.reduction.questions.epochRepo(ticket)
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
  //
  // LAST wins here, exactly as it does for #epochSpawn, and #219 is why that is
  // safe: a respawn restates the kind rather than dropping it (see `spawnKind`).
  // Before that fix every map dispatch that fell down the fallback chain ended
  // its life describing itself as a ticket dispatch.
  #epochCharting(ticket, agentName) {
    const w = this.agents.get(agentName)
    if (w) {
      return {
        charting: Boolean(w.charting), instruction: w.instruction ?? null, newMap: Boolean(w.newMap),
      }
    }
    // #241: which SHAPE of charting, restated by every respawn for the same
    // reason the kind is (#219) — the last line has to describe the agent whole.
    // So the query takes the LAST spawn line of the ticket and reads the shape
    // off it.
    return this.reduction.questions.epochCharting(ticket)
  }

  // What this session was last spawned ON (#187): the routing label and the
  // harness. Same journal reduction as #epochRepo and #epochCharting, keyed by
  // SESSION rather than by ticket — a re-dispatch down the fallback chain
  // writes a second `agent_spawned` for the same session, and the last one is
  // the model that is actually running.
  //
  // This is the reader that fixes the direction for every other one: last wins,
  // so the writer owes every line a complete description (#219, `spawnKind`).
  //
  // The journal is the only source for the label. The harness has on-disk
  // evidence too (detectHarness), but the label names a row in `routing.yaml`
  // that nothing on disk points back to.
  #epochSpawn(session) {
    return this.reduction.questions.epochSpawn(session)
  }

  async #resolveTicket(agentName, repo, ticket, result, w) {
    const wtPath = w?.wtPath ?? worktreePathFor(this.root, repo, ticket)
    const login = this.claimLogin()
    const out = await resolveAndLand({
      repo, ticket, agent: agentName, result, login,
      wtPath: fs.existsSync(wtPath) ? wtPath : null,
      branch: branchFor(ticket),
      // comments are judged against this dispatch, so a resolution comment left
      // by an EARLIER dispatch of the same ticket does not count as this one's
      epochTs: w?.spawnedAt ? new Date(w.spawnedAt).toISOString() : null,
      model: w?.model ?? null,
      deps: this.deps,
      journal: (type, data) => this.reduction.journal(type, data),
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
      this.reduction.journal('resolved_unreviewed', { repo, ticket, agent: agentName })
      out.warnings.push('NO approved review gate for this dispatch — this ticket was resolved without anyone approving it')
    }
    const text = summariseOutcome(out)
    // `summary` is what the ending receipt says about the tracker (#253). It
    // rides the journal rather than the agent record because report_result and
    // the Stop hook are two calls, and a restart between them must not silence
    // the ending — see #endingClause.
    this.reduction.journal('ticket_resolved', {
      repo, ticket, agent: agentName,
      comment: out.comment, close: out.close, map: out.map.state, land: out.land.state,
      pr: out.land.url ?? null, repaired: out.repaired,
      summary: `✅ ${repo}#${ticket} resolved — ${text}`,
    })
    return text
  }

  // The map dispatch's whole ending (#160, narrowed by #221, widened by #297):
  //
  //   1. COMMENT — curia posts the agent's summary on the map, so the change
  //      has a dated record beside the body it changed. The ticket path only
  //      comments as a repair; here it is the point.
  //   2. SAY WHAT LANDED — since #297 a charting session can carry findings on
  //      a branch, so the comment states whether they reached the default
  //      branch. A session that pushed and never got them merged is named as
  //      such, in the same voice `resolved_unreviewed` uses on the ticket path:
  //      the daemon cannot undo it, and it refuses to hide it.
  //   3. Nothing else. No unclaim (#221 took the claim away, so there is
  //      nothing to release), no close, and no Decisions-so-far line. The
  //      research tickets are the AGENT's to resolve — it created them, it read
  //      the findings, and curia has no expected value for either.
  //
  // The map edits themselves are NOT verified or repaired here, and cannot be:
  // curia has no expected value for a charting session, which is the same reason
  // #49 gave for having no verification gate at all. What the daemon can do is
  // say plainly what it did and did not check.
  async #finishCharting(agentName, repo, ticket, result, w, instruction) {
    // `charting: true` is asserted, never inherited: this function is reached
    // only through #epochCharting saying so, and after a restart `w` is null —
    // the case where reading the flag off the record would silently unclaim a
    // map curia never assigned (#221).
    const record = { ...(w ?? { repo, ticket, session: agentName }), charting: true }
    // The agent is still alive at report_result, so its credential copy stays
    // until the session is positively gone — the #noteNonClean rule, same
    // reason (#34's snapshot bound).
    await this.#releaseClaim(record, 'charting agent reported in', { keepCredentials: true })
    // #241: WHICH map this summary belongs on. For `map <n>` the ticket IS the
    // map. For a new-map dispatch the ticket is a chat handle, and the map is
    // whatever the agent created and adopted — so a session that never adopted
    // one has nowhere to post, and that is said out loud rather than failing
    // quietly against an issue called `chat-1`.
    const map = this.#chartedMap(agentName, ticket, w)
    const landing = await this.#chartingLanding(agentName, repo, ticket)
    if (landing.unreviewed) {
      this.reduction.journal('charting_unreviewed', { repo, map: map ?? null, ticket, agent: agentName })
    }
    let noted = false
    if (map) {
      try {
        await this.deps.commentIssue(repo, map, chartingComment({
          agent: agentName, model: w?.model ?? null, instruction, result, landing,
        }))
        noted = true
      } catch (e) {
        this.log(`could not post the charting summary on ${repo}#${map}: ${e.message}`)
      }
    }
    const clean = result.status === 'resolved'
    const bits = [
      map
        ? (noted ? 'summary posted on the map' : '⚠️ the summary comment could NOT be posted')
        : '⚠️ this session created NO map, so there is nowhere to post its summary — read the thread',
      // #221: nothing to unassign — the dispatch never claimed the map.
      'the map was never claimed',
      map ? 'the map stays open' : 'nothing on the tracker was touched by curia',
      landing.line,
    ]
    const what = map ? `${repo}#${map}` : `the new map in ${repo}`
    this.reduction.journal('charting_finished', {
      repo, map: map ?? null, ticket, agent: agentName, status: result.status, commented: noted,
      pr: landing.url ?? null, pr_state: landing.state ?? null,
      summary: `${clean ? '🗺️' : '↩️'} ${what} charted (**${result.status}**) — ${bits.join('; ')}. Nobody reviewed these map edits: read them.`,
    })
    return `charting recorded — ${bits.join('; ')}. Nothing was closed by curia, and the map stays open.`
  }

  // What this charting session put on a branch, and how far it got (#297).
  //
  // Read from curia's OWN records, never from the agent's account: the journal
  // says whether a pull request was opened under this dispatch and whether a
  // human approved at the gate, and GitHub says whether the branch merged. The
  // three answers are what makes the map comment evidence.
  //
  // A session that pushed nothing is the common case and answers in one line
  // with no network call at all.
  async #chartingLanding(agentName, repo, ticket) {
    const { prOpened, reviewApproved } = this.#epochScan(ticket, agentName)
    if (!prOpened) return { landed: false, unreviewed: false, line: 'nothing was pushed' }
    let pr = null
    try {
      pr = await this.deps.findPullRequest(repo, branchFor(ticket))
    } catch (e) {
      this.log(`charting landing for ${repo}#${ticket}: pull-request read failed (${e.message})`)
    }
    const state = pr?.state ?? null
    const merged = state === 'MERGED'
    return {
      landed: true,
      merged,
      approved: reviewApproved,
      // The #48 shape, said out loud: findings a human never approved, or
      // approved and never merged, resolve no research ticket.
      unreviewed: !reviewApproved || !merged,
      url: pr?.url ?? null,
      state,
      line: merged
        ? (reviewApproved
          ? 'the research findings are merged'
          : '⚠️ the research findings were MERGED WITHOUT an approved review gate')
        : `⚠️ the research findings are on a pull request that is ${state ? `**${state}**` : 'in an unknown state'} — NOT in the default branch`,
    }
  }

  // ---- adoption: the daemon learns the new map's number (#241) -----------------

  // The `map_created` tool. A new-map charting agent calls it the moment it has
  // created the `wayfinder:map` issue, and from that call on the session speaks
  // for that number: the status line names it, `map <n>` is refused while this
  // agent lives, the thread becomes the map's thread, and the charting summary
  // has somewhere to land.
  //
  // curia VERIFIES the number rather than believing it. The whole reason the
  // side channel exists is that a daemon record built from an agent's own
  // account is not evidence (#40's rule, and the review gate's links follow it
  // too) — so this reads the issue, and refuses a number that is not an open
  // map in this session's own repo. A refusal is a sentence the agent can act
  // on, never a silent no-op.
  //
  // Idempotent: the same number twice is a no-op, and a DIFFERENT number is
  // refused. One charting session charts one map — a second one would leave the
  // first with no summary, no thread and no lock.
  async adoptMap(agentName, numberArg) {
    const raw = String(numberArg ?? '').trim().replace(/^#/, '')
    if (!/^\d+$/.test(raw)) {
      return `❌ map_created takes the issue NUMBER of the map you created — \`${numberArg}\` is not one`
    }
    if (this.#isReviewer(agentName)) {
      return '❌ a cross-check reviewer writes nothing — it does not create maps. Put what you found in your verdict.'
    }
    const w = this.agents.get(agentName)
    if (!w) return `❌ curia holds no record of \`${agentName}\`, so it cannot take a map for it`
    if (!w.newMap) {
      return w.charting
        ? `❌ \`${agentName}\` was dispatched on an existing map (${w.repo}#${w.ticket}) — there is no new map to take. Edit that one.`
        : '❌ map_created belongs to a charting agent that was sent to create a map. This session is working a ticket.'
    }
    if (w.mapNumber && String(w.mapNumber) !== raw) {
      return `❌ this session already created ${w.repo}#${w.mapNumber}. One charting session charts one map — put the rest on that map, or say so and stop.`
    }
    let issue
    try {
      issue = await this.deps.fetchIssue(w.repo, raw)
    } catch (e) {
      return `❌ curia could not read ${w.repo}#${raw} (${e.message}) — create the issue first, then call map_created again`
    }
    if (issue.state !== 'open') return `❌ ${w.repo}#${raw} is ${issue.state} — a map is charted open`
    if (!hasLabel(issue, MAP_LABEL)) {
      return `❌ ${w.repo}#${raw} carries no \`${MAP_LABEL}\` label, so nothing on the tracker reads it as a map — add the label, then call map_created again`
    }
    if (w.mapNumber) return `already taken — ${w.repo}#${raw} is this session's map`
    w.mapNumber = raw
    w.title = issue.title
    this.reduction.journal('map_adopted', {
      repo: w.repo, ticket: w.ticket, map: raw, agent: agentName, title: issue.title,
    })
    // The thread follows the map (#241). Never fatal: a rename that does not
    // happen costs a stale thread name, and the binding is journalled either way.
    try {
      await this.threads.adoptMap?.(w.ticket, raw, { repo: w.repo, title: issue.title })
    } catch (e) {
      this.log(`thread adoption for ${agentName} → ${w.repo}#${raw} failed (${e.message}) — the binding stays on the handle`)
    }
    this.notify(w.ticket, `🗺️ \`${agentName}\` created ${w.repo}#${raw} **${issue.title}** — curia has taken it as this session's map`)
    return `curia has taken ${w.repo}#${raw} **${issue.title}** as this session's map. \`map ${raw}\` is refused while you run, and your report_result summary lands there.`
  }

  // WHICH map a charting session is responsible for (#241). On `map <n>` the
  // ticket IS the map. On a new-map dispatch the ticket is the handle, and the
  // map is whatever the agent created and reported — null until it does, which
  // is a real state and not a fault: a session cancelled before it created
  // anything has no map, and saying so beats posting to an issue called `new`.
  #chartedMap(agentName, ticket, w) {
    if (!isChatHandle(ticket)) return String(ticket)
    const live = (w ?? this.agents.get(agentName))?.mapNumber
    if (live) return String(live)
    return this.#epochAdoptedMap(agentName)
  }

  // The number this session reported through `map_created`, read off the
  // journal for an agent record this process never held (a restart mid-session,
  // or a reconcile-adopted agent). Reset at every spawn line for the session, so
  // a resumed handle does not inherit the map of the dispatch before it — that
  // map exists now, and `map <n>` is the verb for it.
  #epochAdoptedMap(agentName) {
    return this.reduction.questions.adoptedMap(agentName)
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
    const tail = released
      ? 'claim released, ticket back on the frontier'
      : 'claim release FAILED — the ticket is still assigned; reconcile will retry'
    const said = `${tail}${noted ? ', reason noted on the ticket' : ', and the note could not be posted'}`
    this.reduction.journal('nonclean_noted', {
      repo, ticket, agent: agentName, status: result.status, released, noted,
      summary: `↩️ ${repo}#${ticket} NOT resolved (**${result.status}**) — ${said}`,
    })
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
    return this.reduction.openEscalations().filter((r) => r.agent === agentName)
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
    this.reduction.journal('agent_blocked_on_human', {
      agent: agentName, ticket, repo: w?.repo,
      escalations: open.map((r) => r.id), awaiting_review: reviewing, cross_check: crossCheck,
    })
    if (crossCheck) {
      this.log(`agent_done ${agentName}: turn ended parked on a cross-check verdict — idle, not gone`)
      return
    }
    this.log(`agent_done ${agentName}: turn ended with ${open.map((r) => r.id).join(', ')} still open — ${reviewing ? 'awaiting review' : 'blocked on a human'}, not gone`)
  }

  // The pull request this session pushed, for the ONE place the link is
  // allowed to unfurl (#253): the agent's own report. The in-memory record
  // wins. The reduction answers for a session this process never held, off the
  // reduction its replay filled — this read sits on the `/overview` poll, once
  // per open review gate, so it must not read the journal (#289).
  pullRequestUrlFor(agentName) {
    const live = this.agents.get(agentName)?.prUrl
    return live || this.reduction.pullRequestFor(agentName)
  }

  // The whole ending, in one CuriaBot message (#253, ADR-0013).
  //
  // The cold read of 131 threads found every ending narrated by three
  // identities in up to four messages inside twenty seconds: the agent's
  // report, a resolved line, a 🏁 done line, and a finished line — and the
  // pull-request link rode three of them, so the same GitHub embed rendered
  // three times in a row. Two messages remain. The agent's report is the first
  // and states MEANING in the agent's own voice. This receipt is the second
  // and states MECHANICS: what happened on the tracker, and what happened to
  // the session. It is small print, and it carries no bare link — the report
  // is where the pull request unfurls, and nowhere else.
  //
  // The 🏁 line is gone with no replacement: it said "done" about the same
  // event this sentence opens with (statusline.mjs, #retire).
  #endingReceipt(agentName, lease) {
    const clause = this.#endingClause(agentName)
    const head = clause ?? `✅ \`${agentName}\` finished with a recorded result`
    return smallPrint(`${head} · \`${agentName}\` session closed; ${lease}`)
  }

  // What the tracker step made of this result, composed by whichever path ran
  // it and stored on that path's own journal event.
  //
  // The journal is the carrier rather than the agent record because the two
  // halves of an ending are two calls: report_result runs the tracker step,
  // the Stop hook lands seconds later, and a daemon restart in between must
  // not swallow the sentence. Epoch-scoped like every other reduction here —
  // a resume restarts the count at its own `agent_spawned`, so a fresh
  // dispatch never inherits the last one's ending.
  //
  // Null is a real answer: a session that ended with no tracker step at all
  // (nothing bound, no repo) has nothing to say here, and the receipt falls
  // back to the session sentence alone.
  #endingClause(agentName) {
    try {
      return this.reduction.questions.endingClause(agentName)
    } catch (e) {
      this.log(`ending clause for ${agentName} is unreadable (${e.message}) — the receipt states the session only`)
      return null
    }
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
        this.reduction.journal('escalation_orphaned', { id: r.id, agent: agentName, ticket })
      }
      this.notify(ticket, `⚠️ \`${agentName}\` is gone while ${open.length} escalation(s) were still open — ${open.map((r) => `**${r.id}**`).join(', ')} cancelled: nothing is waiting for an answer any more`)
    }

    // Both branches: a finished agent's dev server is dead either way, so the
    // rule would publish a dead port (or whatever binds it next) — the exact
    // thing publish() refuses to create in the first place.
    await this.#withdrawPreview(ticket, hasResult ? 'agent finished' : 'agent exited without a result')
    if (hasResult) {
      this.reduction.journal('lifecycle_closed', { agent: agentName, ticket, repo: w?.repo })
      await this.deps.killSession(agentName).catch(() => {})
      this.agents.delete(agentName)
      // the OAuth credential copy never survives (a pre-#53 leftover collector)
      this.deps.removeCredentials(w?.cfgDir ?? cfgDirFor(this.root, agentName))
      // #54 item 7: the merge — not the result — is what ends the lease. Review
      // already happened, so "kept for review" no longer means anything; what
      // decides now is whether the code is in.
      const lease = await this.#endWorkspaceLease(agentName, ticket, w?.repo ?? this.#epochRepo(ticket))
      this.notify(ticket, this.#endingReceipt(agentName, lease))
      this.lapseConfirmsFor(agentName, `\`${agentName}\` finished`)
      this.expireNotesFor(agentName, ticket, 'finished')
      // terminal state ⇒ the ticket label comes off the thread (#93)
      await this.threads.release(ticket, 'finished').catch(() => {})
    } else {
      // result-less exit: the pane is the post-mortem evidence — keep it
      if (w) w.state = 'failed'
      this.reduction.journal('agent_abnormal_exit', { agent: agentName, ticket, repo: w?.repo })
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
      this.reduction.journal('reviewer_abnormal_exit', { repo: w?.repo, ticket, agent: agentName })
      // #165: the builder may be parked at the gate on this reviewer. It is
      // released with the truth — no verdict — rather than left waiting on a
      // pane that is being kept only as evidence.
      this.#endReviewWait(ticket, 'the reviewer stopped without producing one')
      this.notify(ticket, `⚠️ \`${agentName}\` stopped WITHOUT a verdict — session and checkout kept for post-mortem (\`/attach ${ticket}\` names both). The builder is untouched: nothing about #${ticket} changed.`)
      return
    }
    this.reduction.journal('lifecycle_closed', { repo: w?.repo, ticket, agent: agentName, kind: 'reviewer' })
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
      await this.deps.removeWorkspace(target)
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
    const wtPath = worktreePathFor(this.root, repo, ticket)

    let pr
    try {
      pr = await this.deps.findPullRequest(repo, branch)
    } catch (e) {
      this.reduction.journal('lease_kept', { repo, ticket, agent: agentName, branch, reason: `pull-request state unreadable: ${e.message}` })
      return `worktree and branch kept — curia could not read the pull-request state (${e.message})`
    }

    if (pr && pr.state !== 'MERGED') {
      this.reduction.journal('lease_kept', { repo, ticket, agent: agentName, branch, reason: `pull request is ${pr.state}` })
      // <> around the url: this sentence rides the ending receipt, and the
      // receipt carries no bare link (#253).
      return `⚠️ worktree and branch KEPT — <${pr.url}> is **${pr.state}**, not merged`
    }
    if (!pr) {
      // No pull request at all: fine for a ticket that produced no code, and a
      // defect for one that did (resolveAndLand would have repaired it, so this
      // is the indeterminate case).
      let commits = null
      try {
        commits = await this.deps.commitsOnBranch(wtPath, await this.deps.defaultBranchOf(wtPath))
      } catch { /* indeterminate ⇒ keep */ }
      if (commits === null || commits.length) {
        this.reduction.journal('lease_kept', { repo, ticket, agent: agentName, branch, reason: 'no pull request, and the branch may hold commits' })
        return '⚠️ worktree and branch KEPT — there is no pull request and curia cannot rule out unlanded commits'
      }
    }

    let removed = false
    try {
      await this.deps.removeWorkspace(wtPath)
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
    this.reduction.journal('lease_released', { repo, ticket, agent: agentName, branch, merged: Boolean(pr), worktree_removed: removed })
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
  // (reduction.open).
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
    for (const r of this.reduction.openEscalations()) {
      if (r.kind !== CONFIRM_KIND) continue
      if (!(r.action?.targets ?? []).some((t) => t.session === session)) continue
      this.lapseEscalation(r.id, why)
      this.reduction.journal('confirm_lapsed', { id: r.id, session, reason: why })
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
  //
  // #252 leaves this as the caller that knows WHY, and nothing else. The
  // announcing moved into the reduction, which every expiry passes through, so a
  // path that forgets to call this one still cannot lose a note in silence.
  expireNotesFor(session, ticket, why, liveInstance = null) {
    this.reduction.expireAgentNotes(session, liveInstance, why)
  }

  // Expiry always announces (#252, ADR-0013). Wired to the reduction's expiry hook,
  // so it runs once per expiry whichever path caused it — an ordered teardown,
  // an adoption after a restart, or the drain's belt-and-braces sweep.
  //
  // Two shapes, because two kinds of words die here:
  //
  //   an operator note — one CuriaBot line with the count. The journal keeps
  //     the text and the operator can say it again, so repeating it back is
  //     noise (#108 item 14's contract, unchanged).
  //   a cross-check verdict — its whole content, with attribution. It is the
  //     output of a whole reviewer session and nobody can say it again: the
  //     reviewer is gone and never reads the same diff twice. On #223 one
  //     expired unread and the thread showed nothing, and that loss class is
  //     what this branch makes impossible.
  announceExpiredNotes({ agent, notes, liveInstance, why }) {
    const ticket = this.agents.get(agent)?.ticket ?? String(agent).match(SESSION_RE)?.[1] ?? String(agent)
    const verdicts = notes.filter((n) => n.label === VERDICT_LABEL)
    // #258: a cross-check START notice that dies gets no line of its own. It
    // says one thing — do not end while the reviewer reads — and an agent it
    // failed to reach has already ended. The fact the operator needs then is the
    // VERDICT's, and the carrier below states that one in full.
    const plain = notes.filter((n) => n.label !== VERDICT_LABEL && n.label !== CROSS_CHECK_LABEL).length
    this.log(`${notes.length} note(s) for ${agent} expired — ${why}`)
    if (plain) {
      const again = liveInstance
        ? 'Say them again in this thread.'
        : `Say them again after \`resume ${ticket}\`.`
      this.notify(ticket, `📭 \`${agent}\` ${why} with ${plain} operator note${plain === 1 ? '' : 's'} it never read. A note dies with the agent it was typed at, so nothing carries these words to a successor. ${again}`)
    }
    const held = verdicts.length ? this.verdictFor(ticket) : null
    for (const note of verdicts) {
      this.reduction.journal('verdict_carried', { ticket, agent, reason: why })
      this.notify(ticket, verdictCarrier({
        agent: held?.agent ?? null,
        model: held?.model ?? null,
        // The held artifact is the fuller copy; the note text is the fallback
        // for a verdict whose artifact this daemon no longer has.
        verdict: held?.verdict ?? note.text,
        ticket,
        url: held?.pr_url ?? null,
        why: `\`${agent}\` ${why}`,
      }))
    }
  }

  // ---- the interrupt, the second delivery mode (#252, ADR-0013) ---------------
  //
  // Queued is the default and is fire-and-forget: the words ride the agent's
  // next tool result and nothing owes a reply. Interrupt is the other mode, and
  // the operator picks it by pressing the button under the receipt — which is
  // why it takes a NOTE id rather than a session: the button names the words it
  // sits under.
  //
  // What it does: gives the current tool call a grace of a few seconds, then
  // sends Escape and types the words into the pane as a user turn. The agent
  // answers them the way it answers any user message, and that reply is the
  // outcome — in the thread, in the agent's voice. No CuriaBot line states it,
  // because the agent's own words are the fact.
  //
  // Three refusals, and each one is a case where the keystrokes would do harm
  // rather than nothing:
  //
  //   the agent is gone — words typed at an agent die with it (#208), and
  //     Escape into a dead session names no pane at all.
  //   the note belongs to an earlier instance — the same rule, one layer in.
  //   an escalation is open — the agent is BLOCKED inside `ask_human`, and
  //     Escape would abort the very tool call that is asking the question. The
  //     answer surface is the card, and the refusal says so.
  //
  // A native terminal dialog (#75) needs no refusal here, unlike the timeline's
  // /send: the Escape goes first, and Escape is the key #75 itself rules safe
  // through a dialog — it dismisses rather than answers. The composer is back
  // by the time the text lands.
  //
  // The press RETURNS as soon as the guards pass; the grace and the keystrokes
  // run after it. The button surface must not sit on a Discord interaction for
  // seconds, and the injection reports its own failure on the thread.
  async interruptNote(id, { by = null } = {}) {
    const note = this.reduction.noteById(id)
    if (!note) return { ok: false, why: 'curia has no record of that note, so there is nothing to ask' }
    const session = note.agent
    const ticket = this.agents.get(session)?.ticket ?? String(session).match(SESSION_RE)?.[1] ?? String(session)
    const w = this.agents.get(session)
    if (!w) {
      return { ok: false, session, ticket, why: `\`${session}\` is NOT running, so there is nobody to ask — \`resume ${ticket}\` puts an agent back on the ticket, then say the words again` }
    }
    if (note.instance && w.instance && note.instance !== w.instance) {
      return { ok: false, session, ticket, why: `those words were typed at an earlier \`${session}\`, and a note dies with the agent it was typed at — say them again in this thread` }
    }
    const open = this.#openEscalationsFor(session)
    if (open.length) {
      const ids = open.map((r) => `**${r.id}**`).join(', ')
      return { ok: false, session, ticket, why: `\`${session}\` is waiting on ${ids} — answer that question instead. An interrupt here would abort the call that is asking it.` }
    }
    const wasPending = note.pending
    // Out of the queue first: a note the interrupt carries must never also ride
    // a tool result. One fact, one delivery, whichever mode carries it.
    this.reduction.interruptAgentNote(id, { by })
    this.reduction.journal('note_interrupt', {
      id, agent: session, ticket, by, grace_ms: this.interruptGraceMs, was_queued: wasPending,
    })
    this.#injectNote(session, ticket, note).catch((e) => this.log(`note interrupt for ${session} failed: ${e.message}`))
    return { ok: true, session, ticket, graceMs: this.interruptGraceMs, was_queued: wasPending }
  }

  // The words, in the pane, as a user turn. The wrapper is short and it says
  // the two things the agent cannot know from the text alone: a human typed
  // this in the thread, and the reply has to go back through `notify` — the
  // pane is not a surface the operator reads.
  //
  // ONE line, and the operator's own whitespace is collapsed into it for the
  // same reason the map instruction's is (see expandCommand): a composer reads
  // a newline as a submit, so a two-line send is a half-sent message and a turn
  // that starts on the first half.
  async #injectNote(session, ticket, note) {
    await sleep(this.interruptGraceMs)
    const w = this.agents.get(session)
    if (!w) {
      this.reduction.journal('note_interrupt_failed', { agent: session, ticket, reason: 'the agent exited during the grace' })
      this.notify(ticket, `📭 \`${session}\` exited during the grace, so these words reached nobody: ${note.text}`)
      return
    }
    const said = String(note.text ?? '').replace(/\s+/g, ' ').trim()
    const text = `[the operator, interrupting from the thread] ${said}`
      + ' — answer this now with the `notify` tool: your terminal output does not reach them. Then carry on.'
    try {
      // Escape aborts whatever tool call the grace did not let finish. It is a
      // separate write from the text on purpose: tmux paces and queues per pane
      // (#223), so the two land in order with the composer clear between them.
      await this.deps.sendKey(session, 'Escape')
      await this.deps.sendText(session, text)
    } catch (e) {
      this.reduction.journal('note_interrupt_failed', { agent: session, ticket, reason: e.message })
      // Prose, but NOT deduped: this line answers words the operator just
      // typed, and an answer to an act is owed once per act. Silence here would
      // read as delivery (#256).
      this.notify(ticket, `⚠️ curia could not put those words to \`${session}\` — ${failureProse(e.message)}. The words are NOT with the agent: say them again.`)
      return
    }
    this.reduction.journal('note_interrupt_delivered', { agent: session, ticket })
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
      this.reduction.journal('escalation_orphaned', { id: r.id, agent: session, ticket })
    }
    // The journal records what HAPPENED, not what was attempted (the W1
    // rule): dispatch_unclaimed only after the unclaim returned; a failed or
    // impossible unclaim journals unclaim_failed (which closedAfterEpoch
    // does not match, so reconcile retries the release); and the untracked
    // branch — whose own message says the GitHub claim was untouched —
    // writes no unclaim event at all.
    //
    // A cancelled MAP dispatch has no claim to release (#221) — the same guard
    // #releaseClaim carries, at the other teardown path.
    const charting = Boolean(w?.charting) || (!w && this.#epochCharting(ticket, session).charting)
    // #241: what a cancelled CHAT leaves behind is its map, if it made one —
    // and nothing at all if it did not. Both are worth saying: "the edits
    // stand" on a session that created nothing is a lie about the tracker.
    const chartedMap = charting && isChatHandle(ticket) ? this.#chartedMap(session, ticket, w) : null
    let released = false
    let failure = null
    if (w) {
      await this.deps.removeWorkspace(w.wtPath).catch((e) => this.log(`workspace removal for ${session} failed:`, e.message))
      if (!charting) {
        try {
          await this.deps.unclaim(w.repo, ticket, this.claimLogin())
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
    if (w && !charting) {
      if (released) {
        this.reduction.journal('dispatch_unclaimed', { repo: w.repo, ticket, agent: session, reason: 'cancelled', by: by ?? 'unknown' })
      } else {
        this.reduction.journal('unclaim_failed', { repo: w.repo, ticket, agent: session, reason: 'cancelled', by: by ?? 'unknown', error: failure ?? 'the unclaim did not run' })
      }
    }
    // status's recent-cancelled view reads this event; the unclaim events
    // above cannot carry it because an untracked cancel writes none.
    this.reduction.journal('agent_cancelled', { repo: w?.repo, ticket, agent: session, by: by ?? 'unknown', tracked: Boolean(w) })
    const chartTail = isChatHandle(ticket)
      ? (chartedMap
        ? `, checkout removed — nothing was claimed, and the map it created (${w?.repo ? `${w.repo}#` : '#'}${chartedMap}) STANDS`
        : ', checkout removed — nothing was claimed, and it had created no map yet, so the tracker is untouched')
      : ', checkout removed — the map was never claimed, and whatever the agent already wrote to it STANDS'
    const tail = w
      ? (charting
        ? chartTail
        : released ? ', worktree removed, ticket re-frontiered' : ', worktree removed — but the claim release FAILED: the issue is still assigned; reconcile will retry')
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
      this.reduction.journal('escalation_orphaned', { id: r.id, agent: session, ticket })
    }
    this.agents.delete(session)
    const removed = await this.#removeReviewCheckout(w?.repo ?? this.#epochRepo(ticket), ticket, w?.wtPath)
    this.deps.removeConfigDir(w?.cfgDir ?? cfgDirFor(this.root, session))
    this.deps.forgetAgentToken(this.dataDir, session)
    this.reduction.journal('reviewer_cancelled', { repo: w?.repo, ticket, agent: session, by: by ?? 'unknown', tracked: Boolean(w) })
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
    // that is gone.
    //
    // #221 moved the decision here from the label. `resume` names a SESSION, and
    // what that session was doing is a journal fact — reading it off the issue
    // would send a resumed charting agent to `start`, which on a map number now
    // dispatches a child ticket instead. So a charting epoch resumes through
    // `chart`, and `chart` refuses an issue that has since lost the map label
    // rather than guessing: there is no map left to chart, and `start <n>` is
    // the verb for what the issue has become.
    const { charting, instruction, newMap } = this.#epochCharting(ticket, session)
    const inherited = { repo, model: model ?? this.#inheritedModel(session), by, reuse: true, threadId }
    // #241: `resume chat-1` is the one resume whose subject may have changed
    // shape while it ran. Once the agent created its map, that map EXISTS — and
    // resume names a session, not a subject, so it must not quietly re-dispatch
    // a "create a map" agent onto a repo that now has one. It names the verb
    // that carries on instead, which is the same refusal `start <map>` gives
    // when the operator reached for the wrong one.
    //
    // The handle is carried over, not re-picked: the thread, the worktree and
    // the journal epoch all answer to it.
    if (newMap) {
      const adopted = this.#epochAdoptedMap(session)
      const theRepo = repo ?? this.#epochRepo(ticket)
      if (adopted) {
        return `❌ \`${session}\` already created ${theRepo ? `${theRepo}#${adopted}` : `#${adopted}`} — that map exists now, so it is charted by number: \`map ${adopted} <what is left to do>\``
      }
      return this.chartNew({ ...inherited, instruction, repo: theRepo, handle: ticket })
    }
    if (charting) return this.chart(ticket, { ...inherited, instruction })
    return this.start(ticket, inherited)
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
    const last = this.#epochSpawn(session)?.model ?? null
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
    const open = this.reduction.openEscalations()
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
      // How long ago this agent last reached curia on the side channel (#370).
      // It is a reading of THIS daemon process, so null means this process has
      // heard nothing — never spoken (an agent it spawned), or not spoken yet
      // (an agent it adopted, which is the row whose `uptime_s` is null too).
      // The daemon judges neither: a working agent and a deaf one are both
      // silent (#341), so the row states the reading and the operator reads it.
      last_contact_s: w.mcpLastAt ? Math.round((Date.now() - w.mcpLastAt) / 1000) : null,
      result_received: w.resultReceived,
      tmux_live: live.includes(w.session),
      // where a waiting agent waits (#81's grown status): the open escalation
      // records bound to it — id and kind, enough to name the thread and ask
      waiting_on: open.filter((r) => r.agent === w.session).map((r) => ({ id: r.id, kind: r.kind })),
    }))
    const untracked = live.filter((s) => !this.agents.has(s))
    // The recent cancelled, finished and died (#81's grown status). The reduction
    // reduces them as the journal is written (#289), so this read costs
    // nothing on disk — `/overview` asks for it every 5 seconds, and it used
    // to parse the whole journal to answer.
    return { agents, untracked, recent: this.reduction.recentOutcomes() }
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
      this.reduction.journal('agent_died', { repo, ticket, agent: session, kind: 'reviewer' })
      this.lapseConfirmsFor(session, `\`${session}\` died`)
      this.deps.removeCredentials(w.cfgDir ?? cfgDirFor(this.root, session))
      this.log(`liveness sweep: reviewer ${session} is gone with no teardown order`)
      this.notify(ticket, `⚰️ \`${session}\` is gone without a teardown order and left NO verdict — nothing about #${ticket} changed. Ask for the cross-check again to start a fresh reviewer.`)
      return
    }
    this.agents.delete(session)
    this.reduction.journal('agent_died', { repo, ticket, agent: session })
    this.log(`liveness sweep: ${session} is gone with no teardown order`)

    // The surface half of item 19: the agent's open questions STAY open and
    // answerable — unlike the ordered-teardown paths, nothing here cancels
    // them, because the ticket continues and the answer has a place to go.
    // (#139 hands the recorded answer to the resumed agent.) The journal
    // line per record is the durable fact that hand-off will read.
    const open = this.#openEscalationsFor(session)
    for (const r of open) {
      this.reduction.journal('escalation_agent_died', { id: r.id, agent: session, ticket })
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
    // A map dispatch holds no claim (#221), so there is no claim decision to
    // take and #settleDeadClaim would read GitHub twice to answer "not ours".
    // What the operator needs is the other fact: a map is never on a frontier,
    // so nothing picks this up again on its own, and the half-finished edits are
    // already live on the body.
    if (this.#epochCharting(ticket, session).charting) {
      claimLine = 'the map was never claimed, and whatever this agent already wrote to it STANDS'
    } else {
      try {
        const outcome = await this.#settleDeadClaim({ repo, ticket, session })
        claimLine = {
          kept: 'its pull request is open and awaiting review, so the claim stays',
          released: 'claim released, ticket re-frontiered',
          'not-ours': 'the ticket is no longer claimed by curia',
        }[outcome]
      } catch (e) {
        claimLine = `the claim decision failed (${e.message}) — reconcile will retry`
      }
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
    this.reduction.journal('reconcile', { boot })
    const ctx = await this.#reconcileContext()

    if (ctx.login && ctx.sessions) {
      await this.#reconcileSessions(ctx)
      await this.#reconcileDeadClaims(ctx)
    } else if (!ctx.login) {
      // No claim login ⇒ NO positive evidence about who owns what. Both passes
      // below decide ownership by comparing assignees to `login`. With a null
      // login every live agent looks unowned, and the orphan sweep would kill
      // its session AND force-remove its uncommitted output.
      //
      // #390 moved that name off `gh api user` and onto `dispatch.claim_login`,
      // which `loadCuriaConfig` refuses a boot without — so this is no longer a
      // transient failure and should never be reachable. The guard stays,
      // because what it prevents is destruction and what it costs is a branch.
      this.reduction.journal('reconcile_identity_unknown', { boot })
      this.log('reconcile: no claim login this pass — skipping session adoption, orphan sweep and dead-claim release')
    } else {
      // Same rule for the tmux read: an indeterminate session list (wedged
      // server, foreign socket, tmux missing, the 5 s timeout) is NOT "no
      // sessions". Treating it as empty would make every open claim look dead
      // — unclaiming live agents and re-frontiering their tickets — and let
      // a re-dispatch force-remove a live agent's worktree. Skip both passes.
      this.reduction.journal('reconcile_sessions_indeterminate', { boot, error: ctx.sessionsError })
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

    // And a fresh GitHub credential for every agent this pass adopted (#389).
    // The tick would reach them within 60 s, and 60 s is too long here: the
    // daemon was DOWN, so the token standing in an adopted agent's file may
    // already be past its hour, and the agent's next `gh` call is a 401 nobody
    // can place. Adoption is exactly the moment to rewrite it.
    await this.refreshGhCredentials().catch((e) => this.log(`reconcile: the GitHub credential refresh failed (${e.message})`))
    // And the overseer's, for a sharper version of the same reason (#392): that
    // container was NOT restarted with this daemon, so it is standing on
    // whatever the last write left. Boot reconcile is the first pass that can
    // arm it at all, and the first tick is 60 s further away.
    await this.refreshOverseerCredentials().catch((e) => this.log(`reconcile: the overseer credential refresh failed (${e.message})`))

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
    if (ctx.sessions && typeof this.reduction.boundTickets === 'function') {
      const asked = new Set(this.reduction.openEscalations().map((r) => String(r.ticket)))
      for (const ticket of this.reduction.boundTickets()) {
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

    // #336, the repair half of the result rule. `onResult` closes a stale
    // question at the moment the result lands, and this pass closes the ones
    // no live call could: a record whose agent reported a result under a
    // previous daemon process, and the two the live box was still holding when
    // this ticket was written. Journal-only evidence, so it needs neither the
    // viewer identity nor a session list — a `result` line for that agent, and
    // a record that opened before it.
    await this.#reconcileStaleQuestions(ctx)

    if (boot) this.#voidBootConfirms()
    // #346, after adoption: the limit resumes a previous process armed. Journal
    // evidence only, so a failed identity read or an indeterminate tmux costs
    // it nothing — and the arm is worth nothing if the resume is not made.
    if (boot) this.#reArmLimitResumes()
    await this.#assertAttachSurface()
    // The timeline surface (#74) rides the same posture: asserted every
    // reconcile, never fatally, withdrawn when it cannot be verified. The
    // object owns its own verify-or-withdraw logic; this catch only keeps a
    // tailscale failure from failing the whole pass.
    if (this.timeline) {
      await this.timeline.assert().catch((e) => this.log(`reconcile: timeline surface assertion failed (${e.message}) — the timeline may be unavailable`))
    }

    // Last, because it reads GitHub and the sweeps above must not wait on it
    // (#262). It is the only part of the pass whose failure costs a surface
    // rather than a decision.
    await this.#computeFrontier()
  }

  // Everything the passes share: the latest dispatch epoch per ticket, the
  // viewer identity, live curia sessions, and a per-pass issue cache whose
  // failures are remembered so one bad repo is skipped, not retried.
  //
  // The journal itself is NOT here any more (#408). This context carried one
  // whole read, and five passes reduced it. Each of those passes asks its own
  // keyed query now, so a pass pays for the questions it asks.
  async #reconcileContext() {
    // The latest dispatch epoch per ticket, and the repo that dispatch named.
    // The one question that is not keyed: it answers for every ticket at once,
    // and this is the list the dead-claim pass walks. (Solo-PoC debt,
    // acknowledged: keyed by bare ticket number, so cross-repo number
    // collisions share an epoch.)
    const epochs = this.reduction.questions.epochs() // ticket -> { repo }

    const login = this.claimLogin()
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
      epochs, login, sessions, reviewSessions, sessionsError, failedRepos,
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
        this.reduction.journal('reconcile_repo_skipped', { repo, error: e.message })
        this.log(`reconcile: skipping ${repo} this pass (${e.message})`)
      }
    }
    return ctx
  }

  // Live curia-<n> sessions: re-adopt the ones GitHub still says we own, sweep
  // the ones every candidate repo positively disowns.
  async #reconcileSessions({ epochs, login, sessions, failedRepos, getIssue, skipRepo }) {
    for (const session of sessions) {
      if (this.agents.has(session) || this.inFlight.has(session)) continue
      const n = session.match(SESSION_RE)[1]
      // #228: the claim was the adoption evidence and #221 took it away for a
      // map — no dispatch claims one, so a live charting session used to walk
      // straight into the orphan branch here. The journal states the kind at
      // every spawn (#219), and that line is the positive evidence now: this
      // daemon (or its predecessor) spawned the session as charting. The map
      // being open still gates adoption below, exactly as it does a builder.
      const { charting, instruction, newMap } = this.#epochCharting(n, session)
      // #241: a CHAT session has no issue to prove itself by. `getIssue(repo,
      // 'chat-1')` is a 404, which every test below reads as "positively
      // absent" — so a live charting agent would be swept as an orphan on the
      // first pass after a restart. Its positive evidence is the journal: this
      // daemon, or its predecessor, spawned this handle as a new-map dispatch.
      // The same evidence #228 gave a map dispatch, for the same reason.
      if (isChatHandle(n)) {
        await this.#reconcileChatSession(session, n, { epochs, charting, instruction, newMap, getIssue, skipRepo, failedRepos })
        continue
      }
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
        if (issue && issue.state === 'open'
          && (charting || (issue.assignees ?? []).some((a) => a.login === login))) {
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
          const spawn = this.#epochSpawn(session)
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
            // #228: restated on the record, because #epochCharting trusts the
            // in-memory record FIRST — an adopted map agent with no `charting`
            // field would read as a ticket one and be held to the ticket
            // ending, which tries to close the map.
            charting, instruction,
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
      if (this.reduction.questions.reportedAfterEpoch(n, session)) {
        this.reduction.journal('orphan_sweep_skipped', { agent: session, ticket: n, reason: 'reported a result after its dispatch' })
        this.log(`reconcile: not sweeping ${session} — it reported a result after its dispatch`)
        continue
      }

      // positive evidence from every candidate repo: closed / unassigned /
      // absent everywhere ⇒ orphan
      this.reduction.journal('orphan_swept', { agent: session, ticket: n })
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

  // A live `curia-chat-<i>` session (#241): re-adopt it, or sweep it.
  //
  // The evidence is inverted here, and it has to be. Every other pass in this
  // file asks GitHub "do we still own this?" — a claim, an open issue, an
  // assignee. A chat session owns no issue by definition, so GitHub can say
  // nothing about it, and the evidence rule forbids reading that silence as a
  // disowning. What speaks positively is the journal: a spawn line naming this
  // handle as a new-map dispatch says curia (or its predecessor) started it.
  //
  // So there are exactly two ways to sweep one, and both are positive:
  //
  //   1. NO spawn line for the handle at all. Nothing curia ever did explains
  //      this pane, which is what "orphan" has always meant.
  //   2. It adopted a map, and that map is now CLOSED. The subject of the work
  //      is positively finished — the same test that retires a builder.
  //
  // A `map_adopted` epoch whose map is open, or a chat with no map yet, is
  // adopted. Adoption is what keeps its ending: `report_result` needs a record
  // to post the charting summary against.
  async #reconcileChatSession(session, handle, { epochs, charting, instruction, newMap, getIssue, skipRepo, failedRepos }) {
    const epoch = epochs.get(handle)
    const spawn = this.#epochSpawn(session)
    const repo = epoch?.repo ?? null
    if (!charting || !repo) {
      this.reduction.journal('orphan_swept', { agent: session, ticket: handle, reason: 'no curia dispatch explains this chat handle' })
      await this.deps.killSession(session).catch(() => {})
      try {
        this.deps.removeConfigDir(cfgDirFor(this.root, session))
      } catch (e) {
        this.log(`reconcile: could not remove the config dir of swept orphan ${session} (${e.message}) — leftovers stay for the next pass`)
      }
      this.deps.forgetAgentToken(this.dataDir, session)
      this.log(`reconcile: swept orphan ${session} — no charting dispatch in the journal`)
      return
    }
    const mapNumber = this.#epochAdoptedMap(session)
    let title = `new map in ${repo}`
    if (mapNumber && !failedRepos.has(repo)) {
      let issue
      try {
        issue = await getIssue(repo, mapNumber)
      } catch (e) {
        // indeterminate ⇒ neither adopt on a guess nor sweep on one: leave the
        // pane alone and let the next pass read it
        skipRepo(repo, e)
        return
      }
      if (issue && issue.state !== 'open') {
        this.reduction.journal('orphan_swept', { agent: session, ticket: handle, reason: `${repo}#${mapNumber} is ${issue.state}` })
        await this.deps.killSession(session).catch(() => {})
        await this.#sweepWorktree(repo, handle, session)
        try {
          this.deps.removeConfigDir(cfgDirFor(this.root, session))
        } catch (e) {
          this.log(`reconcile: could not remove the config dir of swept orphan ${session} (${e.message}) — leftovers stay for the next pass`)
        }
        this.deps.forgetAgentToken(this.dataDir, session)
        return
      }
      if (issue) title = issue.title
    }
    const ports = this.config.sandbox
      ? await this.deps.containerPorts(session).catch((e) => {
        this.log(`reconcile: could not read the published ports of ${session} (${e.message}) — previews are refused for it`)
        return []
      })
      : []
    const instance = `${session}@adopted-${Date.now()}`
    this.agents.set(session, {
      repo, ticket: handle, title, session, instance,
      wtPath: worktreePathFor(this.root, repo, handle),
      cfgDir: cfgDirFor(this.root, session),
      promptFile: path.join(cfgDirFor(this.root, session), 'prompt.md'),
      model: spawn?.model ?? null, requestedModel: null,
      harness: spawn?.harness ?? null,
      provider: this.routing.models[spawn?.model]?.provider ?? null,
      ports: ports.length ? ports : null,
      sandbox: ports.length ? 'docker' : null,
      spawnedAt: null, state: 'ready',
      // A chat handle is a new-map dispatch and nothing else today. The journal
      // is still read for it (newMap above) so that the day a second kind of
      // chat exists, this line is the one that has to change.
      charting: true, instruction, newMap: newMap !== false,
      // the map it had already created, restated on the record so #chartedMap
      // and the `map <n>` lock answer without re-reading the journal
      mapNumber: mapNumber ?? null,
      resultReceived: fs.existsSync(path.join(this.dataDir, 'results', `${session}.json`)),
    })
    this.log(`reconcile: re-adopted live chat agent ${session} (${repo}${mapNumber ? `#${mapNumber}` : ', no map yet'})`)
    this.expireNotesFor(session, handle, 'was adopted after a daemon restart', instance)
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
  async #reconcileReviewers({ reviewSessions }) {
    for (const session of reviewSessions) {
      if (this.agents.has(session) || this.inFlight.has(session)) continue
      const spawn = this.reduction.questions.reviewerSpawn(session)
      if (!spawn) {
        // A reviewer curia cannot describe cannot be resumed, cannot report and
        // cannot be attributed to a ticket. Sweeping is the honest answer: the
        // cross-check is one press away from starting again.
        this.reduction.journal('orphan_reviewer_swept', { agent: session })
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
    const wt = worktreePathFor(this.root, repo, n)
    let unpushed = true
    let why = 'it holds commits that exist nowhere else'
    try {
      unpushed = await this.deps.hasUnpushedWork(wt, branchFor(n), await this.deps.defaultBranchOf(wt))
    } catch (e) {
      why = `curia could not tell whether it holds unlanded commits (${e.message})`
    }
    if (unpushed) {
      this.reduction.journal('orphan_worktree_kept', { agent: session, ticket: n, repo, path: wt, reason: why })
      this.log(`reconcile: kept orphan worktree ${wt} — ${why}`)
      return
    }
    await this.deps.removeWorkspace(wt).catch(() => {})
  }

  // Dead claims: journal-claimed (dispatch_claimed keeps manual claims safe),
  // still assigned, no live session, and no result/lifecycle_closed after the
  // latest epoch — stale results from earlier dispatches of the same ticket
  // never mask a dead claim.
  async #reconcileDeadClaims({ epochs, login, sessions, failedRepos, getIssue, skipRepo }) {
    for (const [ticket, { repo }] of epochs) {
      if (!repo || failedRepos.has(repo)) continue
      const session = `curia-${ticket}`
      if (sessions.includes(session) || this.agents.has(session) || this.inFlight.has(session)) continue
      if (this.reduction.questions.closedAfterEpoch(ticket, session)) continue
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
  // not the answer. Positive evidence only: an unreadable issue or
  // pull-request state THROWS, and the caller skips the pass — the same rule
  // the rest of reconcile runs on. A failed unclaim throws too; nothing here
  // journals dispatch_unclaimed, so reconcile keeps retrying.
  async #settleDeadClaim({ repo, ticket, session, login = null, getIssue = null }) {
    const viewer = login ?? this.claimLogin()
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
      this.reduction.journal('dead_claim_kept_awaiting_review', { repo, ticket, agent: session, pr: pr.url })
      this.log(`keeping the claim on ${repo}#${ticket} — ${pr.url} is open and awaiting review`)
      return 'kept'
    }
    await this.deps.unclaim(repo, ticket, viewer)
    this.reduction.journal('dead_claim_released', { repo, ticket, agent: session })
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
      // #389 widened the test, and it had to. Two terminal states KEEP the whole
      // config dir for a post-mortem, so a minted GitHub token can outlive its
      // agent exactly as an OAuth copy does — and a codex agent, which holds no
      // `.credentials.json` at all, would have been stepped over here with a
      // live push credential still on disk.
      const holds = ['.credentials.json', GH_DIR]
        .some((name) => fs.existsSync(path.join(cfgDir, name)))
      if (!holds) continue
      this.deps.removeCredentials(cfgDir)
      this.reduction.journal('credentials_swept', { agent: dir })
      this.log(`reconcile: swept the credentials of dead ${dir} (workspace kept)`)
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
        this.reduction.journal('orphan_container_swept', { agent: name })
        this.log(`reconcile: swept orphan container ${name} — no pane holds it`)
      } catch (e) {
        this.log(`reconcile: could not remove orphan container ${name} (${e.message})`)
      }
    }
  }

  // Every open record its own agent already finished past (#336).
  //
  // The same rule `#closeQuestionsAtResult` runs at the result, said as a
  // reduction over the journal so it also reaches what no live call could: a
  // result reported under a previous daemon process, and the ghosts a box was
  // already holding when the rule landed. Epoch-scoping is free here — a
  // respawn clears the agent's result, so a question asked by a LATER dispatch
  // of the same session name is never judged against an older one's ending.
  //
  // The second half is the container. A Stop hook that fired while the corpse
  // was open deferred the whole ending to it (#47), and that deferral is a
  // journal line: `agent_blocked_on_human` after the result. With the record
  // closed, the ending it deferred has to run, or the pane and its container
  // stay up on a ticket that merged days ago. An indeterminate session list
  // costs only that half: the record still closes, and the next pass with a
  // readable list ends the session.
  async #reconcileStaleQuestions({ sessions }) {
    const toEnd = new Set()
    // Asked per OPEN RECORD (#408), where a reduction over the whole journal
    // used to answer for every agent that ever ran. The open records are what
    // this pass judges, and there are a handful of them.
    for (const r of this.reduction.openEscalations()) {
      const { at, deferred } = this.reduction.questions.lastResult(r.agent)
      const reportedAt = Date.parse(at ?? '')
      const openedAt = Date.parse(r.opened_at ?? '')
      // An unreadable stamp on either side is not evidence, and the safe
      // direction for a question is to leave it asking.
      if (Number.isNaN(reportedAt) || Number.isNaN(openedAt) || openedAt >= reportedAt) continue
      this.cancelEscalation(r.id, { by: 'result' })
      this.reduction.journal('escalation_stale_at_result', { id: r.id, agent: r.agent, ticket: r.ticket, by: 'reconcile' })
      this.log(`reconcile: ${r.id} was still open on ${r.agent}, which reported a result — the question is stale, so it is closed`)
      if (deferred && sessions?.includes(r.agent)) toEnd.add(r.agent)
    }
    for (const session of toEnd) {
      this.log(`reconcile: ${session} ended its turn on a stale question — running the ending that was deferred`)
      await this.onAgentDone(session).catch((e) => this.log(`reconcile: the deferred ending of ${session} failed (${e.message}) — the next pass retries`))
    }
  }

  // Boot only. A restart mints fresh instance ids at adopt (#94), so no open
  // confirm can name a live instance any more — lapse them, message edited,
  // rather than leaving buttons whose targets can no longer be matched.
  // Legacy pre-#94 overseer approve-reject confirms lost their resolver with
  // the old process and are voided as before. An on-demand POST /reconcile
  // must NOT touch confirms — their instances are still matchable live.
  #voidBootConfirms() {
    for (const r of this.reduction.openEscalations()) {
      if (r.kind === CONFIRM_KIND) {
        this.lapseEscalation(r.id, 'the daemon restarted, and agent instances do not match across a restart')
        this.reduction.journal('confirm_lapsed', { id: r.id, reason: 'boot' })
        this.#noteOrigin(r, `confirm ${r.id} lapsed — the daemon restarted; re-issue the command if you still want it`)
        continue
      }
      if (r.agent !== 'overseer') continue
      this.cancelEscalation(r.id, { by: 'reconcile' })
      this.reduction.journal('confirm_voided', { id: r.id, ticket: r.ticket })
      this.notify(r.ticket, `⚠️ confirm **${r.id}** was voided by a daemon restart — please re-issue the command`)
    }
  }

  // Asserted on every reconcile, never fatally — but the serve rule is only
  // asserted over a surface probeTtyd calls publishable: the agreed index and
  // a live listener on the ttyd port (#260 — compose runs ttyd; the daemon
  // only health-checks it). And because `tailscale serve --bg` config persists
  // in tailscaled across daemon restarts, skipping assertServe alone does not
  // withdraw a rule a previous run asserted — so the refusing branch actively
  // turns the rule off.
  // #151 added a second thing that must be positively up before the rule is
  // asserted: the identity proxy the rule now POINTS AT. ttyd live but the
  // proxy down would mean publishing 127.0.0.1:<ttyd_port> directly — the
  // un-gated terminal that ticket exists to close — so it is refused exactly
  // like a dead ttyd, and the persisted rule is withdrawn.
  async #assertAttachSurface() {
    const { serve_port: servePort, ttyd_port: ttydPort, index } = this.config.attach
    const proxyPort = this.config.identity?.proxy_port
    const proxyUp = this.identityProxy?.listening ?? false
    try {
      const { verified } = proxyUp
        ? await this.deps.probeTtyd({ ttydPort, index, log: this.log })
        : { verified: false }
      if (!verified) {
        // Name the ACTUAL cause: a withdrawal blamed on the wrong half sends
        // the operator to kill a ttyd that was never the problem.
        const cause = proxyUp
          ? `the ttyd surface on port ${ttydPort} is down or stale (is the compose ttyd service up?)`
          : `the attach identity proxy is not up on port ${proxyPort}, so the rule has nothing gated to point at`
        try {
          await this.deps.serveOff({ servePort, log: this.log })
          this.log(`reconcile: ${cause} — serve rule for :${servePort} withdrawn; /attach stays down until it is fixed (bring the service back and re-run reconcile, or restart the daemon)`)
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

  // ---- auto loop -----------------------------------------------------------------

  // The tick runs whatever auto_dispatch says (#138): the liveness sweep needs
  // it, and auto_dispatch is shipped OFF. Only the dispatch half of #autoTick
  // is gated on the flag.
  // Stop the tick, so it can be armed again on a new interval (#362). Idempotent:
  // a loop that was never started has nothing to clear, and `autoTimer` staying
  // null is what tells a reload not to arm one early — the loop belongs to the
  // end of boot reconcile, not to a save.
  stopAutoLoop() {
    if (this.autoTimer) clearInterval(this.autoTimer)
    this.autoTimer = null
  }

  startAutoLoop() {
    // Never two timers on one dispatcher: `poll_interval_s` is reloadable, and
    // a re-arm that left the old interval running would tick at both.
    this.stopAutoLoop()
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
    // #384: the hold rides this tick for the reason the sweep does — it is not a
    // dispatch, and the box holds the same way whether auto-dispatch is on or
    // off. So it runs ABOVE the gate below.
    this.judgeReadings()
    // #389: and the credential refresh, for the same reason again. Every live
    // agent's token dies in an hour whether or not this box dispatches anything
    // new, so a refresh under the gate would strand every agent on a box with
    // auto-dispatch off — which is how curia is shipped.
    await this.refreshGhCredentials().catch((e) => this.log('the GitHub credential refresh failed:', e.message))
    // #392: and the overseer's, above the gate for the same reason again. That
    // container answers the operator whether or not this box dispatches
    // anything, and its token dies in an hour either way.
    await this.refreshOverseerCredentials().catch((e) => this.log('the overseer credential refresh failed:', e.message))
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
      // #346: curia owes this ticket a resume, and a resume is not what this
      // loop does. `start` recreates the worktree from origin, so an auto
      // dispatch landing here first would delete the very files the armed
      // resume exists to hand back.
      if (this.limitResumes.has(String(num))) continue
      if (await this.deps.hasSession(session)) continue // collision or leftover: skip, never churn
      // #376: the same rule for the whole class. A takeable ticket with a
      // worktree still on disk is the work of an agent that ended without
      // landing it — it died, or the daemon went down under it — and `start`
      // would delete every uncommitted file in that worktree. So the auto loop
      // RESUMES it, which is the verb the death notify already promises the
      // operator, and which inherits the worktree and the last model.
      //
      // The path is the evidence, exactly as it is for `resume <n>` and
      // `resume all`. Nothing else leaves a worktree at a TAKEABLE ticket: a
      // cancel removes it, a live agent holds a session (skipped above), and an
      // armed limit resume is stepped over above.
      if (fs.existsSync(worktreePathFor(this.root, repo, num))) {
        const reply = await this.resume(num, { repo, by: 'auto' })
        this.reduction.journal('auto_resume', { repo, ticket: String(num) })
        // The death notify promised `resume <n>` in this thread. Saying that
        // curia made that resume itself is what closes the promise — without
        // it the operator reads an ordinary dispatch line and cannot tell
        // whether the surviving files were kept or thrown away.
        this.notify(num, `▶️ a worktree from an earlier agent stands at ${repo}#${num}, so auto-dispatch RESUMED this ticket instead of starting it. Nothing was recreated from origin. ${reply}`)
        this.log(`[auto] ${reply}`)
        continue
      }
      const msg = await this.start(num, { repo, by: 'auto' })
      this.log(`[auto] ${msg}`)
    }
  }
}
