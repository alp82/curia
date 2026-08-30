// The overseer's verb catalogue (#314), including numberless ticket and map
// creation for chat conversations.
//
// The catalogue moved out of `overseer.mjs` for the reason the standing orders
// moved into `overseerprompt.mjs`: it outlives that file. The in-daemon host
// serves these verbs as an IN-PROCESS SDK server, because the model runs in the
// daemon. The container cannot, because the model is on the other side of the
// boundary, so the daemon serves the same catalogue over HTTP MCP and the
// container connects to it as a client (#314). #315 deletes the in-process adapter and
// this catalogue stays.
//
// WHY THE MODEL REACHES THE SEAM THROUGH MCP RATHER THAN POSTING TEXT. The
// obvious transport is a daemon route that takes canonical text: the container
// composes `start 314` and posts it. That route would carry the WHOLE router,
// because the seam parses text and the router knows verbs no tool here names —
// `deploy`, `restart`, everything a slash verb can say. A tool call cannot. The
// daemon composes the canonical text itself, from arguments the MCP layer has
// validated against the schemas below, so the container reaches these verbs
// and nothing else. The transport is the containment, which is what makes
// it worth the extra hop.
//
// `canonicalFor` is the whole tool → router contract, and it is pure: one
// string builder rather than a template literal inline in every tool, so the
// mapping is testable with no model and no transport in the loop. #692 pins it
// against `parseCommand` with a generated case for every verb and every
// combination of its optional arguments.

import { z } from 'zod'

export function canonicalFor(verb, args = {}) {
  switch (verb) {
    case 'tickets':
    case 'next':
      return `${verb}${args.repo ? ' ' + args.repo : ''}`
    case 'status':
      return 'status'
    case 'skill':
      return `skill ${args.name} ${args.target}`
    // #177 removed `harness=`: the harness follows the model. #221 removed the
    // instruction: `start` no longer charts, so it carries no sentence.
    case 'start':
      return `start ${args.repo ? `${args.repo}#` : ''}${args.ticket}${args.model ? ` model=${args.model}` : ''}`
    case 'ticket_new': {
      let text = `ticket${args.repo ? ` ${args.repo}` : ''}`
      if (args.model) text += ` model=${args.model}`
      const instruction = String(args.instruction ?? '').replace(/\s+/g, ' ').trim()
      if (instruction) text += ` ${instruction}`
      return text
    }
    // #692, ADR-0022: two tools, one router verb. `map_update` requires the map
    // number and `map_new` has no number field at all, so the shape the model
    // could get wrong is now the shape it cannot call. Both compose `map`, so
    // the router and the slash surface never learn that the tool split.
    //
    // The legacy `map` name still composes, because `canonicalFor` is a pure
    // string builder that other callers reach for, and the shape it picks is
    // the one the arguments name: a ticket means an update.
    case 'map':
    case 'map_update':
    case 'map_new': {
      // A ticket handed to `map_new` is DROPPED rather than composed, the way
      // a hallucinated `harness=` is dropped on `start`. The new-map shape has
      // no number to carry, and a number smuggled through the wrong tool would
      // compose an update the operator never asked for.
      const ticket = verb === 'map_new' ? null : args.ticket
      // #241: with no map number this is the NEW-map shape, where the repo is a
      // bare token rather than the `repo#n` qualifier — there is no `n` to
      // qualify. The instruction is mandatory there, and a call that omits it
      // composes a bare `map`, which the router refuses by naming both shapes.
      let text = ticket
        ? `map ${args.repo ? `${args.repo}#` : ''}${ticket}`
        : `map${args.repo ? ` ${args.repo}` : ''}`
      if (args.model) text += ` model=${args.model}`
      // The instruction (#160, moved here by #221) rides LAST, because it is
      // the one argument that is a whole sentence. #255 retired the `--` that
      // used to mark its start: the arguments come first and the sentence runs
      // to the end of the line, so nothing has to separate them.
      // Whitespace is collapsed here: the seam is one line of text, and the
      // router splits it on whitespace, so a newline the model wrote would
      // otherwise come back as a space anyway — collapsing it makes the
      // canonical text the operator sees and the text the router parses the
      // same string.
      const instruction = String(args.instruction ?? '').replace(/\s+/g, ' ').trim()
      if (instruction) text += ` ${instruction}`
      return text
    }
    case 'cancel':
      return `cancel ${args.ticket}`
    // #177: resume takes the same model override start takes. `all` takes none,
    // so the argument is dropped rather than composed into text the router
    // refuses.
    case 'resume':
      return `resume ${args.ticket}${args.model && args.ticket !== 'all' ? ` model=${args.model}` : ''}`
    case 'attach':
      return `attach ${args.ticket}`
    default:
      throw new Error(`no canonical form for verb "${verb}"`)
  }
}

// #255: the regex is enforced, but the JSON schema the model reads drops it —
// the SDK publishes `{"type":"string"}` and the description is the only place
// the rule survives. A model that packed a whole sentence in here got a raw
// validation dump about a constraint it was never shown, so the rule is
// written where it can read it.
const ticketArg = z.string().regex(/^\d+$/).describe('issue number, digits only — never a sentence')
const bulkArg = z.string().regex(/^(\d+|all)$/).describe('ticket number, or "all"')
const repoArg = z.string().optional().describe('repo qualifier — any unambiguous part of a watched repo name')
const modelArg = z.string().optional().describe('model override — the harness follows it, so there is no harness argument')
const skillNameArg = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('configured skill name, without a slash or dollar prefix')
const skillTargetArg = z.string().regex(/^(?:\d+|[\w.-]+\/[\w.-]+#\d+)$/).describe('target issue number, optionally qualified as owner/repo#number')

// The catalogue. Each entry is a name, the text the model reads, and the
// argument shape both transports publish — a raw zod shape, which is what the
// agent SDK's `tool()` and the MCP SDK's `server.tool()` both take.
export const VERB_SPECS = [
  {
    verb: 'tickets',
    description: 'List the takeable tickets across the watched repos, in map order, with the agent-only runnable count. Optionally limit to one repo.',
    args: { repo: repoArg },
  },
  {
    verb: 'next',
    description: 'Dispatch an agent on the next takeable ticket. Optionally limit to one repo.',
    args: { repo: repoArg },
  },
  {
    verb: 'status',
    description: 'Show the live agents: ticket, model, state, uptime, and who is waiting on input.',
    args: {},
  },
  {
    verb: 'skill',
    description: 'Run a configured skill when no existing ticket carries the request. The daemon creates a durable record issue. The review gate shows proposed tracker writes before publication. If an existing ticket carries the work, use start instead.',
    args: { name: skillNameArg, target: skillTargetArg },
  },
  {
    verb: 'start',
    description: 'Claim a ticket and dispatch an agent to WORK it. Use the repo field when the ticket number alone is ambiguous. Given a MAP number, this dispatches that map\'s next takeable ticket — it does NOT update the map; the map tool does that.',
    args: { ticket: ticketArg, repo: repoArg, model: modelArg },
  },
  {
    verb: 'ticket_new',
    description: 'Create a NEW mapless ticket from the operator\'s brief and immediately work it in this conversation thread. Use this after the operator accepts your suggestion, or when they explicitly ask to create and work a ticket. Use map_new instead when the work needs discovery or several sessions.',
    args: {
      repo: z.string().optional().describe('repo qualifier — with no issue number it must be the repo\'s own name. Add it only when more than one repo is watched.'),
      instruction: z.string().describe('The complete ticket brief, in the operator\'s own words. On a later acceptance such as "yes", use the original request, not the acceptance message.'),
      model: modelArg,
    },
  },
  // #692, ADR-0022: the map tool is two tools. The exists-test used to be prose
  // in the standing orders ("the test between the two shapes is whether the map
  // EXISTS"), and prose is what an A-class incident argues with. It is a schema
  // now: `map_update` cannot be called without a number, and `map_new` has no
  // number field to fill in. Both compose the `map` router verb, so the router,
  // the slash surface and the operator's usage catalogue don't change.
  //
  // The header-resolution rule stays prose in `overseerprompt.mjs`, because
  // deciding which map the operator's phrase names needs the model's judgment.
  {
    verb: 'map_update',
    description: 'Dispatch a charting agent to UPDATE an EXISTING map, by its own issue number: add tickets, graduate fog, change scope, fix what the map says. It never closes the map, and the only tickets it closes are the research ones it burned down itself. To chart a map that does not exist yet, use map_new.',
    args: {
      ticket: ticketArg.describe('the EXISTING map\'s issue number, digits only — never a sentence'),
      repo: repoArg,
      instruction: z.string().optional().describe('What should change, in the operator\'s own words ("update the landing page map so that X"). Leave it out and the agent asks.'),
      model: modelArg,
    },
  },
  {
    verb: 'map_new',
    description: 'Dispatch a charting agent to chart a NEW map from the operator\'s brief. The agent settles the destination and the scope with the operator, then creates the `wayfinder:map` issue itself. Use this when the operator asks for a map that does not exist yet ("make a map for the next feature"). There is no map number, so do not ask for one. To change a map that already exists, use map_update.',
    args: {
      // #255: with no map number the repo rides in front of a plain sentence,
      // so only the repo's OWN name is read as one.
      repo: z.string().optional().describe('repo qualifier — with no map number it must be the repo\'s own name. Add it only when more than one repo is watched.'),
      instruction: z.string().describe('The whole brief, in the operator\'s own words. It is what the agent chooses a destination and a scope from, so pass their sentence unchanged.'),
      model: modelArg,
    },
  },
  {
    verb: 'cancel',
    description: 'Cancel the agent on a ticket, or "all" for every agent. Destructive, so the daemon posts ✅/❌ buttons and executes ONLY after the operator presses ✅. Call this directly when asked — never seek confirmation in conversation first, and never report the cancel as done: report that the confirm was posted.',
    args: { ticket: bulkArg },
  },
  {
    verb: 'resume',
    description: 'Fresh agent on a ticket, inheriting its surviving worktree, the model the dead agent ran on, and every question the operator already answered on it. "all" resumes every resumable ticket, each on its own model.',
    args: {
      ticket: bulkArg,
      model: z.string().optional().describe('model override — otherwise the model the dead agent ran on. Ignored for "all".'),
    },
  },
  {
    verb: 'attach',
    description: 'Get the attach links (timeline + browser terminal) for a live agent.',
    args: { ticket: ticketArg },
  },
]

// The names, in catalogue order. `overseerprompt.mjs` builds the allowed
// list from this one array, so a verb added here cannot be a tool the standing
// orders never admit.
export const VERB_TOOLS = VERB_SPECS.map((s) => s.verb)

// The catalogue, bound to a seam. `command(text)` is injected — in the daemon it
// is gate.command, so every overseer effect is journalled and routed exactly
// like a slash verb, whichever side of the boundary the model sits on.
//
// A handler runs only after the transport has validated the arguments, so this
// call is the proof that the text reached the router. #275 hangs the status line
// off the injected `command` for exactly that reason.
export function verbHandlers(command) {
  return VERB_SPECS.map((spec) => ({
    ...spec,
    handler: async (args) => ({
      content: [{ type: 'text', text: await command(canonicalFor(spec.verb, args)) }],
    }),
  }))
}
