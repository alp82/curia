// Canonical-text command surface (#33 step 9, grown per #81's catalogue). The
// rename frontier→tickets lives HERE and in the bridge manifest only — the
// domain term "frontier" stays in the code and docs. parseCommand is pure; the
// CommandRouter turns parsed verbs into Discord-markdown replies. Long-running
// continuations (confirm outcomes, watchdog results) arrive as thread notifies
// so the slash reply itself stays fast (#18 seam: bridge macro-expands, this
// router interprets — the stated deviation until the overseer session exists).

import { validSessionName } from './attach.mjs'
import { clampList } from './messaging.mjs'

// A repo argument is any single non-numeric token — #81 resolves it fuzzily
// against the watch list (see #matchRepo), so `cur` is as valid as `alp82/curia`.
const REPOISH_RE = /^[\w./-]+$/

// 'tickets [repo]' | 'next [repo]' | 'status'
// | 'start <n>|<owner/repo#n> [model=x] [backend=y]'
// | 'cancel <n>|all' | 'resume <n>|all' | 'attach <n>'  — anything else ⇒ null.
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
    case 'start': {
      if (!rest.length) return null
      const cmd = { verb: 'start' }
      let m
      if ((m = rest[0].match(/^(\d+)$/))) {
        cmd.ticket = m[1]
      } else if ((m = rest[0].match(/^([\w.-]+\/[\w.-]+)#(\d+)$/))) {
        // field-notes contract 6: the repo-qualified form the ambiguity
        // refusal recommends must itself parse
        cmd.repo = m[1]
        cmd.ticket = m[2]
      } else {
        return null
      }
      for (const opt of rest.slice(1)) {
        const om = opt.match(/^(model|backend)=([\w.-]+)$/)
        if (!om) return null
        cmd[om[1]] = om[2]
      }
      return cmd
    }
    case 'cancel':
    case 'resume': {
      if (rest.length !== 1) return null
      if (rest[0] === 'all') return { verb, all: true }
      if (/^\d+$/.test(rest[0])) return { verb, ticket: rest[0] }
      return null
    }
    case 'attach': {
      if (rest.length === 1 && /^\d+$/.test(rest[0])) return { verb, ticket: rest[0] }
      return null
    }
    default:
      return null
  }
}

const USAGE = [
  'commands:',
  '`tickets [repo]` — takeable tickets across the watch list (repo: any unambiguous part of the name)',
  '`next [repo]` — dispatch the next takeable ticket',
  '`status` — workers running, workers waiting on input, recent cancelled and finished',
  '`start <n>|owner/repo#<n> [model=x] [backend=y]` — claim + dispatch a worker',
  '`cancel <n>|all` — immediate teardown (the overseer\'s interpreted cancel posts a ✅/❌ confirm instead)',
  '`resume <n>|all` — fresh worker on a ticket, inheriting its surviving worktree',
  '`attach <n>` — timeline + browser-terminal links for a live worker',
].join('\n')

export class CommandRouter {
  // attach: { link(ticket) -> Promise<url> } — injected by index.mjs.
  // dispatcher carries the loaded routing config at dispatcher.routing so
  // `backend=` validates without a network round-trip, and the watch list at
  // dispatcher.config.watch so repo arguments resolve without one either.
  constructor({ dispatcher, attach, log = console.log }) {
    this.dispatcher = dispatcher
    this.attach = attach
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
    if (!cmd) return `❌ could not parse \`${canonical}\`\n${USAGE}`
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
          if (cmd.backend && !this.dispatcher.routing.backends?.[cmd.backend]) {
            const configured = Object.keys(this.dispatcher.routing.backends ?? {}).map((b) => `\`${b}\``).join(', ')
            return `❌ backend \`${cmd.backend}\` is not configured — configured backends: ${configured}`
          }
          return await this.dispatcher.start(cmd.ticket, { repo: cmd.repo, model: cmd.model, backend: cmd.backend, by: userId, threadId })
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
          return await this.dispatcher.resume(cmd.ticket, { by: userId, threadId })
        case 'attach':
          return await this.#attachReply(cmd.ticket)
      }
    } catch (e) {
      this.log(`command "${canonical}" failed:`, e.message)
      return `⚠️ \`${cmd.verb}\` failed: ${e.message}`
    }
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
      // #95: one line per ticket, bold titles, and "N more" instead of a tail
      const items = clampList(r.items.map((i) => {
        const type = i.labels.find((l) => l.startsWith('wayfinder:'))
        return `  • #${i.number} **${i.title}**${type ? ` \`${type.replace('wayfinder:', '')}\`` : ''}`
      })).join('\n')
      return `**${r.repo}** (${r.lane} lane)${chain}:\n${items}`
    })
    return lines.join('\n')
  }

  // Grown per #81: running workers, workers waiting on input (and where),
  // recent cancelled and finished.
  async #status() {
    const { workers, untracked, recent = [] } = await this.dispatcher.status()
    if (!workers.length && !untracked.length && !recent.length) return 'no live workers'
    const waitingStates = new Set(['blocked', 'awaiting-review'])
    const isWaiting = (w) => waitingStates.has(w.state) || (w.waiting_on ?? []).length > 0
    const line = (w) => {
      const uptime = w.uptime_s != null ? `${Math.floor(w.uptime_s / 60)}m${w.uptime_s % 60}s` : '—'
      const liveness = w.tmux_live ? '' : ' ⚠️ tmux session GONE'
      const where = (w.waiting_on ?? []).length
        ? ` — waiting on ${w.waiting_on.map((e) => `**${e.id}** (${e.kind})`).join(', ')} in the ticket thread`
        : ''
      return `• \`${w.session}\` ${w.repo}#${w.ticket} — ${w.model ?? '?'} — **${w.state}** — up ${uptime}${w.result_received ? ' — result in' : ''}${where}${liveness} — \`/attach ${w.ticket}\``
    }
    const lines = []
    for (const w of workers.filter((x) => !isWaiting(x))) lines.push(line(w))
    for (const w of workers.filter(isWaiting)) lines.push(line(w))
    for (const s of untracked) lines.push(`• \`${s}\` — ⚠️ live tmux session not tracked by the dispatcher (reconcile will adopt or sweep it)`)
    for (const r of recent) {
      lines.push(`• ${r.kind === 'cancelled' ? '⚰️ cancelled' : '✅ finished'} ${r.repo ? `${r.repo}#${r.ticket}` : `#${r.ticket}`}`)
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
    return lines.join('\n')
  }
}
