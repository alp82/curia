#!/usr/bin/env node
// The #448 run: one command for the whole matrix, on a real codex credential.
//
// It answers two questions.
//
//   1. After a rejection the model reaches, does it rewrite its own text and
//      call again?
//   2. Does the model print the `exec` script's return value by itself, or only
//      when the tool description tells it to?
//
// Run it ON THE BOX, where the operator is logged in to codex. Never in an
// agent container: #438 settled that no codex credential goes into one.
//
//   cd prototypes/reject-on-lint
//   node matrix-448.mjs
//
// Env knobs:
//   ONLY=r1,r5     run these rows only
//   SKIP_PINGPONG=1 drop the two `always` rows, which are the long ones
//   MODEL / EFFORT / CODEX_AUTH / TIMEOUT_MS  pass through to run-codex.mjs
//
// It writes out/448-matrix.json and out/448-matrix.md. Send the .md back.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const auth = process.env.CODEX_AUTH ?? join(homedir(), '.codex', 'auth.json')
if (!existsSync(auth)) {
  console.error(`No codex credential at ${auth}. Run this on the box, logged in to codex.`)
  process.exit(2)
}

// desc: the tool description under test.
//   plain        says nothing about the return value — what curia ships today
//   read-return  tells the model to read the return value and print it
//
// The `plain` rows answer question 2. The `read-return` rows answer question 1,
// because a rejection the model never reads cannot be rewritten from.
//
// The two `always` rows are the ping-pong test. They answer what the cap of 3
// costs on codex: how many rejections the model absorbs before it quits. They
// use the `neutral` task, because the `cap` task names 3 and 5 and an agent can
// anchor its own stopping point on those numbers (#416 section 2).
const ROWS = [
  { id: 'r1', desc: 'plain', carriage: 'tool-error', mode: 'lint', task: 'cap' },
  { id: 'r2', desc: 'plain', carriage: 'tool-error', mode: 'lint', task: 'cap' },
  { id: 'r3', desc: 'plain', carriage: 'ok-text', mode: 'lint', task: 'cap' },
  { id: 'r4', desc: 'plain', carriage: 'protocol-error', mode: 'lint', task: 'cap' },
  { id: 'r5', desc: 'read-return', carriage: 'tool-error', mode: 'lint', task: 'cap' },
  { id: 'r6', desc: 'read-return', carriage: 'tool-error', mode: 'lint', task: 'cap' },
  { id: 'r7', desc: 'read-return', carriage: 'ok-text', mode: 'lint', task: 'cap' },
  { id: 'r8', desc: 'read-return', carriage: 'protocol-error', mode: 'lint', task: 'cap' },
  { id: 'r9', desc: 'read-return', carriage: 'tool-error', mode: 'always', task: 'neutral', pingpong: true },
  { id: 'r10', desc: 'read-return', carriage: 'ok-text', mode: 'always', task: 'neutral', pingpong: true },
]

const only = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const rows = ROWS
  .filter((r) => (only.length ? only.includes(r.id) : true))
  .filter((r) => !(process.env.SKIP_PINGPONG === '1' && r.pingpong))

const results = []
for (const row of rows) {
  const name = `448-${row.id}-${row.desc}-${row.carriage}-${row.mode.replace(':', '')}`
  console.log(`\n=== ${row.id}: ${row.desc} / ${row.carriage} / ${row.mode} / ${row.task} ===`)
  const r = spawnSync(process.execPath, [join(HERE, 'run-codex.mjs'), name, row.carriage], {
    cwd: HERE,
    env: {
      ...process.env,
      REAL: '1',
      LINT_MODE: row.mode,
      LINT_TOOL_DESC: row.desc,
      TASK_VARIANT: row.task,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const file = join(HERE, 'out', name, 'summary.json')
  const summary = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  results.push({ ...row, name, spawn_status: r.status, summary })
}

// The table the finding is written from. Every column is read off the wire: the
// server's own call log, and the rollout codex wrote.
const head = '| Run | Description | Carriage | Policy | Calls | Rejected | Passed on | Return value reached the model |'
const sep = '|---|---|---|---|---|---|---|---|'
const lines = results.map((r) => {
  const s = r.summary
  // A session that made no call measured nothing. Say so, rather than let a
  // zero read as a finding.
  if (!s || s.exit_code !== 0 || s.tool_calls === 0) {
    return `| ${r.id} | ${r.desc} | ${r.carriage} | ${r.mode} | RUN FAILED, read out/${r.name}/codex.log | | | |`
  }
  return `| ${r.id} | ${r.desc} | ${r.carriage} | ${r.mode} | ${s.tool_calls} | ${s.rejected} | ${s.passed_on_attempt ?? 'never'} | ${s.return_value_reached_model ? 'yes' : 'NO'} |`
})

const md = [
  `# #448 matrix, ${results[0]?.summary?.model ?? process.env.MODEL ?? 'gpt-5.6-sol'}`,
  '',
  head, sep, ...lines,
  '',
  '## The scripts the model wrote',
  '',
  ...results.flatMap((r) => {
    const s = r.summary
    if (!s) return [`### ${r.id}: run failed`, '']
    return [
      `### ${r.id} (${r.desc} / ${r.carriage} / ${r.mode})`,
      '',
      '```js',
      ...(s.scripts_full ?? []).map((x, i) => `// call ${i + 1}\n${x.script}`),
      '```',
      '',
      `Final message: ${JSON.stringify(s.final_message)}`,
      '',
    ]
  }),
].join('\n')

writeFileSync(join(HERE, 'out', '448-matrix.json'), `${JSON.stringify(results, null, 2)}\n`)
writeFileSync(join(HERE, 'out', '448-matrix.md'), `${md}\n`)
console.log(`\n${head}\n${sep}\n${lines.join('\n')}\n`)
console.log(`Wrote out/448-matrix.json and out/448-matrix.md. Send the .md back.`)
