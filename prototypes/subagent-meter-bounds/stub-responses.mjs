#!/usr/bin/env node
// A stub Responses API for the #544 subagent rig — the instrument #360 built,
// #416 and #447 reused, now scripted to drive a codex parent through
// `spawn_agent` and its child through one out-of-bounds write.
//
// The stub routes on marker strings, not on request order, because the parent
// and the child interleave on one wire:
//
//   PARENT-544 in the body  -> the parent session. First sight: answer with a
//                              spawn_agent call. After the spawn result: a wait
//                              call. After the wait result: a final message.
//   CHILD-544 without it    -> the child session (fork_turns "none" gives it a
//                              fresh context, so the parent marker never rides
//                              along). First sight: a shell call that writes
//                              OUTSIDE the worktree. After the shell result: a
//                              final message.
//
// Distinctive usage numbers make the meter reading attributable: the parent's
// responses state input_tokens 111111 and the child's 2222. Whatever
// `codexTail` later reports, the number itself says whose line it read.
//
// DISCOVER=1 turns the script off: every turn gets a plain message, and the
// value of the run is the request log, which carries the tool schemas codex
// actually advertises on the pinned 0.146.0.
//
// Env: STUB_PORT (default 8899), STUB_LOG (request dump dir), DISCOVER.
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.STUB_PORT ?? 8899)
const LOG = process.env.STUB_LOG ?? '/tmp/curia-544/stub'
const DISCOVER = process.env.DISCOVER === '1'
mkdirSync(LOG, { recursive: true })

let n = 0
const state = { spawned: false, waited: false, childShelled: false }

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function reply(res, output, usage) {
  const response = { id: `resp_${n}`, object: 'response', status: 'completed', output, usage }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  sse(res, { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
  for (const item of output) sse(res, { type: 'response.output_item.done', item })
  sse(res, { type: 'response.completed', response })
  res.end()
}

const msg = (text) => [{
  id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }],
}]
// `namespace` is a FIELD on the wire item, not a prefix on the name: codex's
// router builds ToolName::new(namespace, name) from the two fields (tagged
// source, core/src/tools/router.rs build_tool_call). A dotted or plain name
// answers "unsupported call" — both measured, out/s1 and out/s2.
const call = (name, args, namespace) => [{
  id: `fc_${n}`, type: 'function_call', status: 'completed',
  call_id: `call_${n}`, name, arguments: JSON.stringify(args),
  ...(namespace ? { namespace } : {}),
}]

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    n += 1
    writeFileSync(join(LOG, `req-${n}.json`), body)
    const parentUsage = { input_tokens: 111111, output_tokens: 50, total_tokens: 111161 }
    const childUsage = { input_tokens: 2222, output_tokens: 50, total_tokens: 2272 }

    if (DISCOVER) return reply(res, msg(`discover turn ${n}: done`), parentUsage)

    if (body.includes('PARENT-544')) {
      if (!state.spawned) {
        state.spawned = true
        // Schema read off the wire in the discover run (out/d2): namespace
        // `collaboration`, spawn_agent(task_name, message, fork_turns).
        return reply(res, call('spawn_agent', {
          task_name: 'probe_child',
          message: 'CHILD-544: run the one shell command your instructions allow and stop.',
          fork_turns: 'none',
        }, 'collaboration'), parentUsage)
      }
      if (!state.waited) {
        state.waited = true
        return reply(res, call('wait_agent', { timeout_ms: 60000 }, 'collaboration'), parentUsage)
      }
      return reply(res, msg('parent done: child collected.'), parentUsage)
    }

    if (body.includes('CHILD-544')) {
      const target = process.env.OUTSIDE_TARGET ?? '/tmp/curia-544/outside-probe.txt'
      if (!state.childShelled) {
        state.childShelled = true
        return reply(res, call('exec_command', {
          cmd: `echo curia-544-outside-probe > ${target} && cat ${target}`,
          login: false,
        }), childUsage)
      }
      return reply(res, msg('child done: probe attempted.'), childUsage)
    }

    return reply(res, msg(`unmatched turn ${n}: done`), parentUsage)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`stub responses on 127.0.0.1:${PORT}, logging to ${LOG}\n`)
})
