#!/usr/bin/env node
// The instrument for the #416 live check: a stdio MCP server whose one tool
// REJECTS the prose it is given and says why.
//
// It is hand-rolled JSON-RPC on purpose. The rig must run in any container with
// node and no network, and the wire is what the harness sees anyway.
//
// Three carriages, because a rejection can reach the model three ways and the
// daemon has to pick one:
//
//   tool-error       `{ isError: true, content: [...] }` — a failed tool call
//   ok-text          a normal result whose text refuses (what curia does today)
//   protocol-error   a JSON-RPC error on tools/call, code -32602 — the shape a
//                    zod schema failure takes inside the MCP SDK
//
// Three policies:
//
//   lint      lint the prose for real, so the agent can escape by rewriting
//   always    reject every call, whatever it says — the ping-pong test
//   until:N   reject the first N calls, then accept — a guaranteed retry
//
// Every call is appended to LINT_LOG as one JSON line.
import { appendFileSync } from 'node:fs'

const CARRIAGE = process.env.LINT_CARRIAGE ?? 'tool-error'
const POLICY = process.env.LINT_MODE ?? 'lint'
const LOG = process.env.LINT_LOG ?? null

let calls = 0

// ---------------------------------------------------------------- the lint --
// A mechanically checkable subset of daemon/assets/voice.md. Not the whole
// voice: the point is a rule an agent can obey by rewriting, not a full linter.
const CONTRACTIONS = /\b\w+(?:'|’)(?:s|t|re|ve|ll|d|m)\b/gi
const MARKETING = /\b(seamless|robust|powerful|cutting-edge|effortless|world-class|next-generation|revolutionary)\b/gi

function lintField(text, field) {
  const faults = []
  const em = text.match(/—/g)
  if (em) faults.push(`In ${field}: remove the em-dash. Write two sentences, or use a normal dash. Found ${em.length}.`)
  const semi = text.match(/;/g)
  if (semi) faults.push(`In ${field}: remove the semicolon. Write two sentences. Found ${semi.length}.`)
  const contractions = [...text.matchAll(CONTRACTIONS)].map((m) => m[0])
  if (contractions.length) faults.push(`In ${field}: expand every contraction: ${[...new Set(contractions)].join(', ')}.`)
  const marketing = [...text.matchAll(MARKETING)].map((m) => m[0])
  if (marketing.length) faults.push(`In ${field}: remove the marketing adjective: ${[...new Set(marketing)].join(', ')}.`)
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const words = s.trim().split(/\s+/).filter(Boolean)
    if (words.length > 20) {
      faults.push(`In ${field}: split this sentence. It has ${words.length} words and the cap is 20: "${s.trim().slice(0, 90)}"`)
      break
    }
  }
  return faults
}

function lint(args) {
  return [
    ...lintField(String(args?.headline ?? ''), 'headline'),
    ...lintField(String(args?.prompt ?? ''), 'prompt'),
  ]
}

// The rejection message. Actionable prose: it names the rule, quotes the text,
// and says what to do next. It never rewrites the prose for the agent.
function rejection(faults) {
  return [
    'REJECTED: the prompt fails the voice rules.',
    ...faults.map((f, i) => `${i + 1}. ${f}`),
    'Rewrite the prompt yourself and call ask_human again. Keep every option and every constraint.',
  ].join('\n')
}

function verdict(args) {
  calls += 1
  if (POLICY === 'always') {
    const faults = lint(args)
    // A pathological rejecter. When the prose is already clean it invents a
    // fault, because the question is what the agent does when it cannot win.
    return { ok: false, message: rejection(faults.length ? faults : ['In prompt: the wording is still not plain enough. Say it in shorter words.']) }
  }
  // The fallback under test: reject up to N times, then take the text anyway
  // and tell the agent it went out with a flag on it. The lint still runs, so
  // an agent that fixes its text before the cap gets a clean accept.
  if (POLICY.startsWith('cap:')) {
    const n = Number(POLICY.slice(4))
    if (calls > n) return { ok: true, flagged: true }
    // Unwinnable, like `always`, so the run always reaches the cap. The cap is
    // the thing under test, not the lint.
    const faults = lint(args)
    const message = rejection(faults.length ? faults : ['In prompt: the wording is still not plain enough. Say it in shorter words.'])
    return { ok: false, message: `${message}\nThis was attempt ${calls} of ${n}. After ${n} rejections curia sends your text anyway, with a lint warning on it.` }
  }
  if (POLICY.startsWith('until:')) {
    const n = Number(POLICY.slice(6))
    if (calls <= n) return { ok: false, message: rejection(['In prompt: expand every contraction.', 'In prompt: split any sentence over 20 words.']) }
    return { ok: true }
  }
  const faults = lint(args)
  return faults.length ? { ok: false, message: rejection(faults) } : { ok: true }
}

// ------------------------------------------------------------- the wire ----
const TOOL = {
  name: 'ask_human',
  description: 'Ask the human a question and block until they answer. The prompt is the question they read.',
  inputSchema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One line naming the decision.' },
      prompt: { type: 'string', description: 'The question, with the options and their consequences.' },
    },
    required: ['headline', 'prompt'],
  },
}

function log(row) {
  if (!LOG) return
  appendFileSync(LOG, `${JSON.stringify(row)}\n`)
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'lintcheck', version: '0.0.1' },
      },
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } })
    return
  }
  if (method === 'tools/call') {
    const args = params?.arguments ?? {}
    const v = verdict(args)
    log({ call: calls, at: new Date().toISOString(), carriage: CARRIAGE, policy: POLICY, args, ok: v.ok, flagged: v.flagged === true, message: v.message ?? null })
    if (v.ok) {
      const text = v.flagged
        ? 'SENT WITH A LINT WARNING. The retry cap is used up, so curia sent your text as it stands. The operator sees a warning that it failed the voice check. Do not call ask_human again for this question.'
        : 'ACCEPTED. The human reads it now.'
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
      return
    }
    if (CARRIAGE === 'protocol-error') {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: v.message } })
      return
    }
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: v.message }], ...(CARRIAGE === 'tool-error' ? { isError: true } : {}) },
    })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  // Notifications carry no id and want no answer.
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no such method: ${method}` } })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch {
      // A malformed line is not this rig's problem.
    }
  }
})
process.stdin.on('end', () => process.exit(0))
