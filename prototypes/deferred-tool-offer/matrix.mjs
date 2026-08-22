#!/usr/bin/env node
// Run equal pane and exec samples, one at a time, then write one matrix.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const count = Number(process.env.RUNS ?? 5)
const prefixName = process.env.PREFIX ?? ''
const prefix = prefixName ? `${prefixName}-` : ''
const summarizeOnly = process.env.SUMMARIZE_ONLY === '1'
const rows = []
mkdirSync(join(HERE, 'out'), { recursive: true })

for (const lane of ['pane', 'exec']) {
  for (let run = 1; run <= count; run += 1) {
    const name = `${prefix}${lane}-${run}`
    if (!summarizeOnly) {
      const result = spawnSync(process.execPath, [join(HERE, 'run.mjs'), name, lane], {
        env: process.env,
        encoding: 'utf8',
        timeout: Number(process.env.MATRIX_TIMEOUT_MS ?? 360_000),
      })
      process.stdout.write(result.stdout ?? '')
      process.stderr.write(result.stderr ?? '')
      if (result.status !== 0) {
        console.error(`${name} failed with status ${result.status}`)
        process.exit(result.status ?? 1)
      }
    }
    const row = JSON.parse(readFileSync(join(HERE, 'out', name, 'summary.json'), 'utf8'))
    const rollout = readFileSync(join(HERE, 'out', name, 'rollout.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const prompt = rollout.find((line) => line.type === 'event_msg'
      && line.payload?.type === 'user_message'
      && line.payload.message.includes(row.sentinel))
    row.first_tool_latency_ms = prompt && row.tool_calls[0]
      ? Date.parse(row.tool_calls[0].at) - Date.parse(prompt.timestamp)
      : null
    rows.push(row)
  }
}

const totals = Object.fromEntries(['pane', 'exec'].map((lane) => {
  const samples = rows.filter((row) => row.lane === lane)
  const number = (path) => samples.map((row) => path(row)).filter((value) => Number.isFinite(value))
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
  }
  return [lane, {
    runs: samples.length,
    obeyed: samples.filter((row) => row.obeyed).length,
    searches: number((row) => row.tool_searches.length),
    model_turns: number((row) => row.model_turns),
    discovery_modes: samples.map((row) => row.discovery_mode),
    second_turn_tokens: number((row) => row.turn_tokens?.[1]?.total_tokens),
    total_tokens: number((row) => row.tokens?.total_tokens),
    first_tool_latency_ms: number((row) => row.first_tool_latency_ms),
    median_total_tokens: median(number((row) => row.tokens?.total_tokens)),
    median_input_tokens: median(number((row) => row.tokens?.input_tokens)),
    median_cached_input_tokens: median(number((row) => row.tokens?.cached_input_tokens)),
    median_uncached_input_tokens: median(number((row) => row.tokens
      ? row.tokens.input_tokens - row.tokens.cached_input_tokens
      : null)),
    median_output_tokens: median(number((row) => row.tokens?.output_tokens)),
    median_reasoning_tokens: median(number((row) => row.tokens?.reasoning_output_tokens)),
    median_first_tool_latency_ms: median(number((row) => row.first_tool_latency_ms)),
  }]
}))

const matrix = { generated_at: new Date().toISOString(), rows, totals }
const matrixFile = prefixName ? `${prefixName}-matrix.json` : 'matrix.json'
writeFileSync(join(HERE, 'out', matrixFile), `${JSON.stringify(matrix, null, 2)}\n`)
console.log(JSON.stringify(totals, null, 2))
