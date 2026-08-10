// Canonical-text command surface (#33 step 9, grown per #81's catalogue). The
// rename frontier→tickets lives HERE and in the bridge manifest only — the
// domain term "frontier" stays in the code and docs. parseCommand is pure; the
// CommandRouter turns parsed verbs into Discord-markdown replies. Long-running
// continuations (confirm outcomes, watchdog results) arrive as thread notifies
// so the slash reply itself stays fast (#18 seam: bridge macro-expands, this
// router interprets — the stated deviation until the overseer session exists).

import { validSessionName, CHAT_HANDLE_RE } from './attach.mjs'
import { clampList } from './messaging.mjs'

// A repo argument is any single non-numeric token — #81 resolves it fuzzily
// against the watch list (see #matchRepo), so `cur` is as valid as `alp82/curia`.
const REPOISH_RE = /^[\w./-]+$/

// The instruction separator on `map` (#160, moved off `start` by #221). Every
// other argument on this seam is one whitespace-free token, because the seam
// itself is one line of text that gets split on whitespace — and a map update
// has to carry a whole operator sentence ("update the landing page map so that
// X").
//
// A bare `--` is the boundary: everything before it parses as before, and
// everything after it is the instruction, joined back with single spaces. The
// round trip is stable — the instruction is taken from the FIRST `--` onward,
// so a sentence that itself contains ` -- ` survives canonicalFor → parseCommand
// unchanged.
const INSTRUCTION_SEP = '--'

// What names ONE live agent on `cancel`, `resume` and `attach`: an issue
// number, or a chat handle (#241). An agent no issue answers for — today, the
// one charting a map that does not exist yet — is reached by its handle
// instead: `cancel chat-1`. `all` is not here; it names every agent, and only
// two of the three verbs take it.
const AGENT_RE = new RegExp(`^(\\d+|${CHAT_HANDLE_RE.source.replace(/^\^|\$$/g, '')})$`)

// #221: `start` carries no instruction any more, because it no longer charts.
// The parser refuses the shape and the router names the verb that does take
// one — the same treatment `harness=` got, and for the same reason: an operator
// with muscle memory deserves the rule, not the whole catalogue.
const START_INSTRUCTION_RE = /^start\b.*(^|\s)--(\s|$)/
const START_INSTRUCTION_GONE = '`start` carries no instruction — it works a ticket. `start <map>` now dispatches that map\'s next takeable ticket, and `map <n> -- <sentence>` is how a map itself is updated.'

// #241: `map` has two shapes, and a parse failure on the verb names both. The
// second one carries no issue reference at all, so the FIRST shape's refusal
// ("not a number") would be a lie about what the operator may type. Any `map`
// that fails to parse gets this line, because both shapes are short enough to
// state whole and the difference between them is the whole point.
const MAP_VERB_RE = /^map(\s|$)/
const MAP_SHAPES = [
  '`map` takes one of two shapes:',
  '• `map <n> [model=x] [-- <what should change>]` — chart an EXISTING map, by its own issue number.',
  '• `map [repo] [model=x] -- <what to chart>` — chart a NEW map from your words. The sentence is',
  '  required here, and it is the whole brief. Name the repo when more than one is watched.',
].join('\n')

// #177: `harness=` is gone from every surface. The harness is a FUNCTION of the
// model — `models.<x>.harness` holds one value — so every value the daemon could
// accept was either the model's own harness (a no-op) or a contradiction that
// built `codex --model opus`, which is not a model, and died at the composer.
// The parser refuses it, and the router names the rule rather than printing the
// catalogue at an operator with muscle memory. `review` already ruled this way.
const HARNESS_OPT_RE = /(^|\s)harness=/
const HARNESS_GONE = '`harness=` is gone — the harness follows the model, so `model=` is the whole override. To run a model on another harness, add a row to `routing.yaml`.'

// An issue reference plus `model=` options, shared by `start` and `map` (#221).
// Both verbs name an issue in a watched repo and both take the model override;
// only `map` takes a trailing instruction. Written once so the two verbs cannot
// drift apart on the repo-qualified forms, which the ambiguity refusals
// recommend by name and therefore have to parse back.
function parseIssueRef(cmd, rest, { instruction: takesInstruction = false } = {}) {
  if (!rest.length) return null
  let m
  if ((m = rest[0].match(/^(\d+)$/))) {
    cmd.ticket = m[1]
  } else if ((m = rest[0].match(/^([\w.-]+\/[\w.-]+)#(\d+)$/))) {
    // field-notes contract 6: the repo-qualified form the ambiguity
    // refusal recommends must itself parse
    cmd.repo = m[1]
    cmd.ticket = m[2]
  } else if ((m = rest[0].match(/^([\w.-]+)#(\d+)$/))) {
    // the fuzzy form `tickets`/`next` accept — the overseer reuses it on
    // start, so an unslashed repo resolves through the same matcher
    cmd.repoArg = m[1]
    cmd.ticket = m[2]
  } else {
    return null
  }
  const sep = takesInstruction ? rest.indexOf(INSTRUCTION_SEP) : -1
  const opts = sep === -1 ? rest.slice(1) : rest.slice(1, sep)
  for (const opt of opts) {
    const om = opt.match(/^model=([\w.-]+)$/)
    if (!om) return null
    cmd.model = om[1]
  }
  if (sep !== -1) {
    // `--` with nothing after it is a typo, not an empty instruction: it
    // would dispatch the "what should change?" escalation the operator was
    // trying to skip.
    const instruction = rest.slice(sep + 1).join(' ').trim()
    if (!instruction) return null
    cmd.instruction = instruction
  }
  return cmd
}

// The NEW-map shape of `map` (#241): `map [repo] [model=x] -- <prose>`. No issue
// reference, because the issue does not exist yet — the prose is what the
// charting agent chooses a destination and a scope from, with the operator.
//
// The instruction is MANDATORY here, and that asymmetry with `map <n>` is
// deliberate. On an existing map a missing sentence has a safe meaning ("ask me
// what should change", #160), because the map itself says what the effort is.
// On a new map there is nothing to ask ABOUT, so a bare `map` is a refusal that
// names both shapes rather than a session that opens with a blank question.
//
// The repo token is optional, and the ROUTER fills it in when exactly one repo
// is watched (see #newMapRepo). It is parsed here as the same two forms
// parseIssueRef takes — qualified `owner/repo` and the fuzzy part-of-a-name —
// so the two shapes of one verb cannot drift apart on how a repo is named.
function parseNewMap(rest) {
  const sep = rest.indexOf(INSTRUCTION_SEP)
  if (sep === -1) return null
  const instruction = rest.slice(sep + 1).join(' ').trim()
  if (!instruction) return null
  const cmd = { verb: 'map', instruction }
  for (const opt of rest.slice(0, sep)) {
    const om = opt.match(/^model=([\w.-]+)$/)
    if (om) {
      if (cmd.model) return null
      cmd.model = om[1]
      continue
    }
    // one repo token, and never a bare number: `map 147 -- x` is the OTHER
    // shape, and a number that failed to parse there must not silently become
    // a new-map dispatch against a repo called "147"
    if (cmd.repo || cmd.repoArg || /^\d+$/.test(opt) || !REPOISH_RE.test(opt)) return null
    if (/^[\w.-]+\/[\w.-]+$/.test(opt)) cmd.repo = opt
    else cmd.repoArg = opt
  }
  return cmd
}

// 'tickets [repo]' | 'next [repo]' | 'status'
// | 'start <n>|<owner/repo#n> [model=x]'
// | 'map <n>|<owner/repo#n> [model=x] [-- <instruction>]'
// | 'map [repo] [model=x] -- <instruction>'
// | 'cancel <n>|all' | 'resume <n> [model=x]' | 'resume all' | 'attach <n>'
// — anything else ⇒ null.
export function parseCommand(text) {
  const parts = (text ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const [verb, ...rest] = parts
  switch (verb) {
    case 'tickets':
    case 'next': {
      if (!rest.length) return { verb }
      if (rest.length === 1 && REPOISH_RE.test(rest[0]) && !/^\d+$/.test(rest[0])) return { verb, repo: rest[0] }
      return null
    }
    case 'status':
      return rest.length ? null : { verb: 'status' }
    // #270: self-deploy. Bare, because everything it could say is decided —
    // the target is origin/main and the services are named by the deploy rule.
    case 'deploy':
      return rest.length ? null : { verb: 'deploy' }
    // One meaning for one verb (#221): `start` works the thing. On a ticket it
    // dispatches that ticket; on a map it dispatches the map's next takeable
    // ticket. It never charts, and it never carries an instruction.
    case 'start':
      return parseIssueRef({ verb: 'start' }, rest)
    // The map-update verb (#221), replacing `start <map> -- <instruction>`.
    // The operator's own word, ruled over `chart` on the grounds that it is the
    // word they already reach for.
    // #241: two shapes. The issue-reference one is tried FIRST, so every form
    // that parsed before still parses to exactly what it parsed to; the
    // new-map one is the fallback, and it is the only shape with no number.
    case 'map':
      return parseIssueRef({ verb: 'map' }, rest, { instruction: true }) ?? parseNewMap(rest)
    case 'cancel': {
      if (rest.length !== 1) return null
      if (rest[0] === 'all') return { verb, all: true }
      if (AGENT_RE.test(rest[0])) return { verb, ticket: rest[0] }
      return null
    }
    // `resume` takes the same `model=` override `start` takes (#177). It needs
    // one because resume now INHERITS the model of the dead agent, and an
    // inheritance with no way out pins a ticket to a model the operator has
    // changed their mind about.
    //
    // `resume all` takes none: one model over every surviving worktree would
    // overwrite each ticket's own inherited model with a single guess.
    case 'resume': {
      if (!rest.length) return null
      if (rest[0] === 'all') return rest.length === 1 ? { verb, all: true } : null
      if (!AGENT_RE.test(rest[0])) return null
      const cmd = { verb, ticket: rest[0] }
      for (const opt of rest.slice(1)) {
        const om = opt.match(/^model=([\w.-]+)$/)
        if (!om) return null
        cmd.model = om[1]
      }
      return cmd
    }
    case 'attach': {
      if (rest.length === 1 && AGENT_RE.test(rest[0])) return { verb, ticket: rest[0] }
      return null
    }
    // The cross-check's daemon-side entry point (#164, ADR-0010). The operator
    // surface is a third button on the review gate (#165); this verb is what
    // proves the engine without it, and it takes the same `model=` override
    // `start` does, for the one diff where the pairing table is not what the
    // operator wants.
    case 'review': {
      if (!rest.length || !/^\d+$/.test(rest[0])) return null
      const cmd = { verb: 'review', ticket: rest[0] }
      for (const opt of rest.slice(1)) {
        const om = opt.match(/^model=([\w.-]+)$/)
        if (!om) return null
        cmd.model = om[1]
      }
      return cmd
    }
    default:
      return null
  }
}

const USAGE = [
  'commands:',
  '`tickets [repo]` — takeable tickets across the watch list (repo: any unambiguous part of the name)',
  '`next [repo]` — dispatch the next takeable ticket',
  '`status` — agents running, agents waiting on input, recent cancelled and finished',
  '`start <n>|repo#<n> [model=x]` — claim + dispatch an agent (repo: any unambiguous part of the name)',
  '`start <map>` — dispatch that map\'s next takeable ticket',
  '`map <n> [-- <instruction>]` — dispatch a charting agent on a `wayfinder:map` issue; the sentence after `--` is what it should change',
  '`map [repo] -- <instruction>` — dispatch a charting agent with NO map: it settles the destination with you and creates the `wayfinder:map` issue itself',
  '`cancel <n>|all` — immediate teardown (the overseer\'s interpreted cancel posts a ✅/❌ confirm instead)',
  '`resume <n> [model=x]|resume all` — fresh agent on a ticket, inheriting its surviving worktree and the model it last ran on',
  '`attach <n>` — timeline + browser-terminal links for a live agent',
  '`cancel chat-1` / `resume chat-1` / `attach chat-1` — the same three verbs on an agent no ticket answers for, such as one charting a NEW map. `status` lists its handle',
  '`review <n> [model=x]` — cross-check: a reviewer on the other provider reads the pushed diff and returns a verdict',
  '`deploy` — self-deploy: fast-forward to origin/main, rebuild, restart the daemon; a failed health check rolls back automatically',
].join('\n')

export class CommandRouter {
  // attach: { link(ticket) -> Promise<url> } — injected by index.mjs.
  // dispatcher carries the watch list at dispatcher.config.watch so repo
  // arguments resolve without a network round-trip.
  // deploy: the SelfDeploy seam (#270) — optional, because the dev daemon and
  // most tests run without one.
  constructor({ dispatcher, attach, deploy = null, log = console.log }) {
    this.dispatcher = dispatcher
    this.attach = attach
    this.deploy = deploy
    this.log = log
  }

  // ctx.threadId: the Discord thread the command was issued in, if any (#93) —
  // dispatch verbs bind the ticket to that thread ("start binds the thread it
  // runs in"); absent one, the dispatcher's first notify opens a fresh thread.
  // ctx.interpreted (#94): true when the text came out of a model (the
  // overseer's verb tools) rather than a typed slash command or REST call —
  // interpreted destructive verbs go through the button confirm.
  async handle(canonical, userId, { threadId = null, interpreted = false } = {}) {
    const cmd = parseCommand(canonical)
    if (!cmd) {
      let why = ''
      if (HARNESS_OPT_RE.test(canonical)) why = `${HARNESS_GONE}\n`
      else if (START_INSTRUCTION_RE.test(canonical)) why = `${START_INSTRUCTION_GONE}\n`
      else if (MAP_VERB_RE.test(canonical.trim())) why = `${MAP_SHAPES}\n`
      return `❌ could not parse \`${canonical}\`\n${why}${USAGE}`
    }
    try {
      // `return await` is load-bearing throughout: a bare `return <promise>` is
      // adopted AFTER the try block exits, so the catch below would never see a
      // rejection and the failure reply was unreachable.
      switch (cmd.verb) {
        case 'tickets': {
          const repo = cmd.repo ? this.#matchRepo(cmd.repo) : {}
          if (repo.error) return repo.error
          return await this.#tickets(repo.repo)
        }
        case 'next': {
          const repo = cmd.repo ? this.#matchRepo(cmd.repo) : {}
          if (repo.error) return repo.error
          return await this.dispatcher.next(repo.repo, { by: userId, threadId })
        }
        case 'status':
          return await this.#status()
        case 'start': {
          const repo = this.#dispatchRepo(cmd)
          if (repo.error) return repo.error
          return await this.dispatcher.start(cmd.ticket, {
            repo: repo.repo, model: cmd.model, by: userId, threadId,
          })
        }
        case 'map': {
          const repo = this.#dispatchRepo(cmd)
          if (repo.error) return repo.error
          // #241: no issue reference ⇒ the new-map shape. It needs a repo
          // BEFORE the dispatch, because there is no issue number to resolve
          // one from — `chart <n>` finds its repo by asking which watched repo
          // owns that number, and a map that does not exist owns nothing.
          if (!cmd.ticket) {
            const target = repo.repo ? repo : this.#newMapRepo()
            if (target.error) return target.error
            return await this.dispatcher.chartNew({
              repo: target.repo, model: cmd.model, instruction: cmd.instruction,
              by: userId, threadId,
            })
          }
          return await this.dispatcher.chart(cmd.ticket, {
            repo: repo.repo, model: cmd.model, instruction: cmd.instruction,
            by: userId, threadId,
          })
        }
        case 'cancel':
          if (interpreted) {
            if (cmd.all) return await this.dispatcher.requestCancelAll({ threadId })
            return await this.dispatcher.requestCancel(cmd.ticket, { threadId })
          }
          if (cmd.all) return await this.dispatcher.cancelAll({ by: userId })
          return await this.dispatcher.cancel(cmd.ticket, { by: userId })
        case 'resume':
          if (cmd.all) return await this.dispatcher.resumeAll({ by: userId })
          return await this.dispatcher.resume(cmd.ticket, { model: cmd.model, by: userId, threadId })
        case 'attach':
          return await this.#attachReply(cmd.ticket)
        case 'review':
          return await this.dispatcher.crossCheck(cmd.ticket, { model: cmd.model, by: userId })
        case 'deploy':
          if (!this.deploy) return '❌ this daemon has no self-deploy seam — use bin/deploy.sh'
          return await this.deploy.run({ by: userId, interpreted })
      }
    } catch (e) {
      this.log(`command "${canonical}" failed:`, e.message)
      return `⚠️ \`${cmd.verb}\` failed: ${e.message}`
    }
  }

  // The repo a dispatch verb runs against: the qualified form as typed, or the
  // fuzzy one resolved against the watch list. `start` and `map` share it
  // (#221) so one verb cannot accept a repo shape the other refuses.
  #dispatchRepo(cmd) {
    if (!cmd.repoArg) return { repo: cmd.repo }
    return this.#matchRepo(cmd.repoArg)
  }

  // The repo a NEW-map dispatch runs against when the operator named none
  // (#241). One watched repo means there is no question to ask, and asking it
  // anyway would put a token in the way of the shortest form of the command.
  // Two or more, and curia refuses rather than picking the first — a map is a
  // standing artifact, and one charted into the wrong repo is a manual move.
  #newMapRepo() {
    const watched = (this.dispatcher.config?.watch ?? []).map((w) => w.repo)
    if (watched.length === 1) return { repo: watched[0] }
    if (!watched.length) return { error: '❌ no repo is on the watch list, so there is nowhere to chart a new map' }
    return { error: `❌ ${watched.length} repos are watched, so a new map needs one named: ${watched.map((r) => `\`map ${r} -- …\``).join(' or ')}` }
  }

  // #81: a repo argument matches on any unambiguous substring of a watched
  // repo's name; ambiguity asks instead of guessing.
  #matchRepo(arg) {
    const watched = (this.dispatcher.config?.watch ?? []).map((w) => w.repo)
    const hits = watched.includes(arg)
      ? [arg]
      : watched.filter((r) => r.toLowerCase().includes(arg.toLowerCase()))
    if (hits.length === 1) return { repo: hits[0] }
    if (!hits.length) return { error: `❌ no watched repo matches \`${arg}\` — watched: ${watched.map((r) => `\`${r}\``).join(', ')}` }
    return { error: `❌ \`${arg}\` matches more than one watched repo (${hits.map((r) => `\`${r}\``).join(', ')}) — say more of the name` }
  }

  async #tickets(repoFilter) {
    const rows = await this.dispatcher.frontier(repoFilter)
    if (!rows.length) return `❌ no watched repo matches \`${repoFilter}\``
    const lines = rows.map((r) => {
      if (r.error) return `**${r.repo}** — ⚠️ ${r.error}`
      // #81: the count of HITL-free tickets per blocker chains — how many an
      // agent can work through with no human in the loop
      const chain = r.agentOnly == null ? '' : ` — ${r.agentOnly} agent-only runnable`
      if (!r.items.length) return `**${r.repo}** (${r.lane} lane) — nothing takeable${chain}`
      // #95: one line per ticket, bold titles, and "N more" instead of a tail.
      // #120: map-lane tickets sit under their map's header, so a map named in
      // prose ("the landing page map") is resolvable against this output.
      const ticketLine = (i) => {
        const type = i.labels.find((l) => l.startsWith('wayfinder:'))
        return `  • #${i.number} **${i.title}**${type ? ` \`${type.replace('wayfinder:', '')}\`` : ''}`
      }
      const lines = []
      let currentMap
      for (const i of r.items) {
        if (i.map != null && i.map !== currentMap) {
          lines.push(`  🎫 map #${i.map} **${i.mapTitle}**:`)
        }
        currentMap = i.map
        lines.push(`${i.map != null ? '  ' : ''}${ticketLine(i)}`)
      }
      return `**${r.repo}** (${r.lane} lane)${chain}:\n${clampList(lines).join('\n')}`
    })
    return lines.join('\n')
  }

  // Grown per #81: running agents, agents waiting on input (and where),
  // recent cancelled and finished.
  async #status() {
    const { agents, untracked, recent = [] } = await this.dispatcher.status()
    if (!agents.length && !untracked.length && !recent.length) return 'no live agents'
    // #165: `cross-checking` is a waiting state too — the builder is parked
    // inside its gate call while a second agent reads the diff.
    const waitingStates = new Set(['blocked', 'awaiting-review', 'cross-checking'])
    const isWaiting = (w) => waitingStates.has(w.state) || (w.waiting_on ?? []).length > 0
    const line = (w) => {
      const uptime = w.uptime_s != null ? `${Math.floor(w.uptime_s / 60)}m${w.uptime_s % 60}s` : '—'
      const liveness = w.tmux_live ? '' : ' ⚠️ tmux session GONE'
      const where = (w.waiting_on ?? []).length
        ? ` — waiting on ${w.waiting_on.map((e) => `**${e.id}** (${e.kind})`).join(', ')} in the ticket thread`
        : ''
      // #164: two agents can sit on one ticket, so the row says which one — a
      // second `alp82/curia#164` line with no marker reads like a duplicate.
      const kind = w.reviewer ? ' 🔎 cross-check reviewer' : ''
      return `• \`${w.session}\` ${w.repo}#${w.ticket}${kind} — ${w.model ?? '?'} — **${w.state}** — up ${uptime}${w.result_received ? ' — result in' : ''}${where}${liveness} — \`/attach ${w.ticket}\``
    }
    const lines = []
    for (const w of agents.filter((x) => !isWaiting(x))) lines.push(line(w))
    for (const w of agents.filter(isWaiting)) lines.push(line(w))
    for (const s of untracked) lines.push(`• \`${s}\` — ⚠️ live tmux session not tracked by the dispatcher (reconcile will adopt or sweep it)`)
    for (const r of recent) {
      const label = { cancelled: '⚰️ cancelled', finished: '✅ finished', died: '⚰️ died' }[r.kind] ?? r.kind
      const hint = r.kind === 'died' ? ` — \`resume ${r.ticket}\`` : ''
      lines.push(`• ${label} ${r.repo ? `${r.repo}#${r.ticket}` : `#${r.ticket}`}${hint}`)
    }
    return lines.join('\n')
  }

  // One verb, two handles (#74, #73's division of labor): the timeline is
  // where you drive, the PTY is where you go when you need to see the terminal
  // itself. A new verb would need the bridge's slash manifest re-registered on
  // every device (#65 found a stale one is silently wrong), so the existing
  // verb carries both — each composed from curia's own records, each failing
  // independently so one surface being down never hides the other.
  async #attachReply(ticket) {
    const session = `curia-${ticket}`
    if (!validSessionName(session)) return `❌ \`${session}\` is not a valid curia session name`
    // #89: attach links stay bare — the one exception to the <> wrap.
    const lines = []
    try {
      lines.push(`🔗 timeline ${await this.attach.timelineLink(ticket)}`)
    } catch (e) {
      lines.push(`❌ timeline: ${e.message}`)
    }
    try {
      lines.push(`🔗 terminal ${await this.attach.link(ticket)}`)
    } catch (e) {
      lines.push(`❌ terminal: ${e.message}`)
    }
    // #164: a cross-check puts a SECOND agent on this ticket, and ADR-0010 asks
    // for it to be attachable — the operator watches it read. Its links are
    // added only when a reviewer is actually live, so an ordinary attach reply
    // is unchanged.
    const reviewer = this.dispatcher.reviewerSession?.(ticket)
    if (reviewer) {
      lines.push(`— the cross-check reviewer \`${reviewer}\`:`)
      for (const [label, get] of [
        ['timeline', () => this.attach.timelineLink(ticket, { session: reviewer })],
        ['terminal', () => this.attach.link(ticket, { session: reviewer })],
      ]) {
        try {
          lines.push(`🔗 ${label} ${await get()}`)
        } catch (e) {
          lines.push(`❌ ${label}: ${e.message}`)
        }
      }
    }
    return lines.join('\n')
  }
}
