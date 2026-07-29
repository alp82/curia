// Canonical-text command surface (#33 step 9). parseCommand is pure; the
// CommandRouter turns parsed verbs into Discord-markdown replies. Long-running
// continuations (confirm outcomes, watchdog results) arrive as thread notifies
// so the slash reply itself stays fast (#18 seam: bridge macro-expands, this
// router interprets — the stated deviation until the overseer session exists).

import { validSessionName } from './attach.mjs'

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

// 'frontier [repo]' | 'status' | 'start <n>|<owner/repo#n> [model=x] [backend=y]'
// | 'cancel <n>' | 'attach <n>'  — anything else ⇒ null.
export function parseCommand(text) {
  const parts = (text ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const [verb, ...rest] = parts
  switch (verb) {
    case 'frontier': {
      if (!rest.length) return { verb: 'frontier' }
      if (rest.length === 1 && REPO_RE.test(rest[0])) return { verb: 'frontier', repo: rest[0] }
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
  '`frontier [owner/repo]` — takeable tickets across the watch list',
  '`status` — live workers',
  '`start <n>|owner/repo#<n> [model=x] [backend=y]` — claim + dispatch a worker',
  '`cancel <n>` — confirm-then-teardown',
  '`attach <n>` — timeline + browser-terminal links for a live worker',
].join('\n')

export class CommandRouter {
  // attach: { link(ticket) -> Promise<url> } — injected by index.mjs.
  // dispatcher carries the loaded routing config at dispatcher.routing so
  // `backend=` validates without a network round-trip.
  constructor({ dispatcher, attach, log = console.log }) {
    this.dispatcher = dispatcher
    this.attach = attach
    this.log = log
  }

  async handle(canonical, userId) {
    const cmd = parseCommand(canonical)
    if (!cmd) return `❓ could not parse \`${canonical}\`\n${USAGE}`
    try {
      switch (cmd.verb) {
        // `return await` is load-bearing: a bare `return <promise>` is adopted
        // AFTER the try block exits, so the catch below would never see a
        // rejection from these two and the failure reply was unreachable.
        case 'frontier':
          return await this.#frontier(cmd.repo)
        case 'status':
          return await this.#status()
        case 'start': {
          if (cmd.backend && !this.dispatcher.routing.backends?.[cmd.backend]) {
            const configured = Object.keys(this.dispatcher.routing.backends ?? {}).map((b) => `\`${b}\``).join(', ')
            return `⛔ backend \`${cmd.backend}\` is not configured — configured backends: ${configured}`
          }
          return await this.dispatcher.start(cmd.ticket, { repo: cmd.repo, model: cmd.model, backend: cmd.backend, by: userId })
        }
        case 'cancel':
          return this.dispatcher.cancel(cmd.ticket, { by: userId })
        case 'attach':
          return await this.#attachReply(cmd.ticket)
      }
    } catch (e) {
      this.log(`command "${canonical}" failed:`, e.message)
      return `⚠️ \`${cmd.verb}\` failed: ${e.message}`
    }
  }

  async #frontier(repoFilter) {
    const rows = await this.dispatcher.frontier(repoFilter)
    if (!rows.length) return `❓ no watched repo matches \`${repoFilter}\``
    const lines = rows.map((r) => {
      if (r.error) return `**${r.repo}** — ⚠️ ${r.error}`
      if (!r.items.length) return `**${r.repo}** (${r.lane} lane) — nothing takeable`
      const items = r.items.map((i) => `  • #${i.number} ${i.title}`).join('\n')
      return `**${r.repo}** (${r.lane} lane):\n${items}`
    })
    return lines.join('\n')
  }

  async #status() {
    const { workers, untracked } = await this.dispatcher.status()
    if (!workers.length && !untracked.length) return '💤 no live workers'
    const lines = workers.map((w) => {
      const uptime = w.uptime_s != null ? `${Math.floor(w.uptime_s / 60)}m${w.uptime_s % 60}s` : '—'
      const liveness = w.tmux_live ? '' : ' ⚠️ tmux session GONE'
      return `• \`${w.session}\` ${w.repo}#${w.ticket} — ${w.model ?? '?'} — **${w.state}** — up ${uptime}${w.result_received ? ' — result in' : ''}${liveness} — \`/attach ${w.ticket}\``
    })
    for (const s of untracked) lines.push(`• \`${s}\` — ⚠️ live tmux session not tracked by the dispatcher (reconcile will adopt or sweep it)`)
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
    if (!validSessionName(session)) return `⛔ \`${session}\` is not a valid curia session name`
    const lines = []
    try {
      lines.push(`🧭 timeline ${await this.attach.timelineLink(ticket)}`)
    } catch (e) {
      lines.push(`⛔ timeline: ${e.message}`)
    }
    try {
      lines.push(`🖥️ terminal ${await this.attach.link(ticket)}`)
    } catch (e) {
      lines.push(`⛔ terminal: ${e.message}`)
    }
    return lines.join('\n')
  }
}
