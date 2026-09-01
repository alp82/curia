import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeAtomically } from './atomic.mjs'

// The operator configuration contract: `config/config.yaml` inside the
// installation root. This module is the one reader, validator, and writer of
// that file. The lifecycle interface, the Curia service, and the Curia app all
// go through it, so one file means one thing in three processes and a refusal
// reads the same in each.
//
// The file holds operator intent and nothing else. Generated state, release
// metadata, and secrets have their own homes (`state/`, the release manifest,
// `secrets/`) and never appear here. Every key is optional: a key the operator
// does not set takes the service's shipped default, and the first installation
// writes `max_concurrent: 4` and no other value.
//
// The file is read as a plain subset of YAML: `key: value` lines, comments, and
// the `watch` list as `- repo: owner/name` entries. Anchors, flow collections,
// block scalars, and other YAML are refused by line rather than guessed at.
// That keeps the reader dependency-free, which the lifecycle interface has to
// be, and it keeps a hand edit either exactly what the operator wrote or an
// exact error. Curia never rewrites an edit into a different meaning.

export const WATCH_MODES = Object.freeze(['auto', 'map', 'ready-for-agent'])

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

const wholeNumber = (text) => (/^\d+$/.test(text) ? Number(text) : undefined)
const number = (text) => (/^\d+(\.\d+)?$/.test(text) ? Number(text) : undefined)
const positiveInteger = (v) => Number.isInteger(v) && v > 0

// One rule per scalar key: how a written value reads, what a value must
// satisfy, and the words a refusal uses. The same `check` judges a value the
// app hands over as an object, so the two paths cannot disagree.
const SCALAR_RULES = {
  max_concurrent: { parse: wholeNumber, check: positiveInteger, rule: 'a positive whole number' },
  auto_dispatch: {
    parse: (text) => ({ true: true, false: false })[text],
    check: (v) => typeof v === 'boolean',
    rule: 'true or false',
  },
  poll_interval_s: { parse: number, check: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0, rule: 'a positive number' },
  prototype_variations: { parse: wholeNumber, check: positiveInteger, rule: 'a positive whole number' },
  messages_per_send: {
    parse: wholeNumber,
    check: (v) => Number.isInteger(v) && v >= 1 && v <= 4,
    rule: 'a whole number from 1 through 4',
  },
  live_pane_cap: { parse: wholeNumber, check: positiveInteger, rule: 'a positive whole number' },
}

// The keys, in the order the operator documentation lists them and the order
// a written file carries them.
export const OPERATOR_CONFIG_KEYS = Object.freeze([...Object.keys(SCALAR_RULES), 'watch'])

const WATCH_RULE = '`watch` must be a list written as `- repo: owner/name` lines'
const WATCH_EMPTY = '`watch` must list at least one `- repo: owner/name` entry'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function operatorConfigPath(root) {
  return join(root, 'config', 'config.yaml')
}

// What `curia install` writes into a fresh root: the one value the first
// release fixes, and no operator-specific default.
export function initialOperatorConfig() {
  return { max_concurrent: 4 }
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

// Parses the text of a configuration file and returns the validated
// configuration: an object holding only the keys the file sets, each in its
// checked form. `file` names the file in every message.
export function parseOperatorConfig(text, { file }) {
  const at = (line, message) => new ConfigError(`${file} line ${line}: ${message}`)
  const got = (value) => `(got ${value === '' ? 'nothing' : value})`
  const config = {}
  const lines = text.split('\n')

  // The `watch` list under construction, or null outside it.
  let list = null
  const closeEntry = () => {
    const entry = list.entries.at(-1)
    if (!entry) return
    if (entry.repo === undefined) throw at(entry.line, `\`watch\` entry ${list.entries.length} needs a \`repo\``)
  }
  const closeList = () => {
    if (!list) return
    if (list.entries.length === 0) throw at(list.line, WATCH_EMPTY)
    closeEntry()
    config.watch = list.entries.map((e) => ({ repo: e.repo, mode: e.mode ?? 'auto' }))
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1
    const raw = lines[i]
    if (raw.includes('\t')) throw at(n, 'tabs are not allowed; indent with spaces')
    const line = stripComment(raw)
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    if (indent === 0) {
      closeList()
      const m = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/.exec(body)
      if (!m) throw at(n, 'expected `key: value`')
      const [, key, value = ''] = m
      if (!OPERATOR_CONFIG_KEYS.includes(key)) {
        throw at(n, `\`${key}\` is not an operator configuration key. The keys are ${OPERATOR_CONFIG_KEYS.join(', ')}`)
      }
      if (key in config || (list && key === 'watch')) throw at(n, `\`${key}\` appears twice`)
      if (key === 'watch') {
        if (value !== '') throw at(n, WATCH_RULE)
        list = { line: n, entries: [] }
        continue
      }
      const rule = SCALAR_RULES[key]
      const parsed = rule.parse(unquote(value))
      if (parsed === undefined || !rule.check(parsed)) throw at(n, `\`${key}\` must be ${rule.rule} ${got(value)}`)
      config[key] = parsed
      continue
    }

    if (!list) throw at(n, 'expected `key: value` at the start of the line')
    let entryBody = body
    if (body.startsWith('- ')) {
      if (indent !== 2) throw at(n, WATCH_RULE)
      closeEntry()
      list.entries.push({ line: n })
      entryBody = body.slice(2).trim()
    } else if (indent !== 4 || list.entries.length === 0) {
      throw at(n, WATCH_RULE)
    }
    const entry = list.entries.at(-1)
    const index = list.entries.length
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/.exec(entryBody)
    if (!m) throw at(n, WATCH_RULE)
    const [, key, value = ''] = m
    if (key !== 'repo' && key !== 'mode') throw at(n, `\`watch\` entry ${index}: \`${key}\` is not a watch entry key`)
    if (key in entry) throw at(n, `\`watch\` entry ${index}: \`${key}\` appears twice`)
    const text = unquote(value)
    if (key === 'repo') {
      if (!REPO_RE.test(text)) throw at(n, `\`watch\` entry ${index}: \`repo\` must be \`owner/name\` ${got(value)}`)
      if (list.entries.some((e) => e !== entry && e.repo === text)) throw at(n, `\`watch\` lists ${text} twice`)
    } else if (!WATCH_MODES.includes(text)) {
      throw at(n, `\`watch\` entry ${index}: \`mode\` must be one of ${WATCH_MODES.join(', ')} ${got(value)}`)
    }
    entry[key] = text
  }
  closeList()
  return config
}

// A `#` starts a comment at the start of a line or after whitespace, outside
// quotes. Values here never legitimately hold one.
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

function unquote(value) {
  const m = /^(["'])(.*)\1$/.exec(value)
  return m ? m[2] : value
}

// Returns the validated configuration, or null when the file does not exist.
// A symbolic link at the path is refused: the file is owner-only and lives in
// `config/`, and a link would let it read from anywhere.
export function readOperatorConfig(path) {
  let text
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new ConfigError(`${path} is a symbolic link. Replace the link with the real file.`)
    }
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  return parseOperatorConfig(text, { file: path })
}

// ---------------------------------------------------------------------------
// validating an object, and writing
// ---------------------------------------------------------------------------

// Judges a configuration handed over as an object (the app's save, the
// installer's initial file) by the same rules the reader applies, and returns
// it with the keys in contract order.
export function validateOperatorConfig(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError('the operator configuration must be a mapping of keys to values')
  }
  for (const key of Object.keys(data)) {
    if (!OPERATOR_CONFIG_KEYS.includes(key)) {
      throw new ConfigError(`\`${key}\` is not an operator configuration key. The keys are ${OPERATOR_CONFIG_KEYS.join(', ')}`)
    }
  }
  const out = {}
  for (const [key, rule] of Object.entries(SCALAR_RULES)) {
    if (data[key] === undefined) continue
    if (!rule.check(data[key])) throw new ConfigError(`\`${key}\` must be ${rule.rule} (got ${JSON.stringify(data[key])})`)
    out[key] = data[key]
  }
  if (data.watch !== undefined) {
    if (!Array.isArray(data.watch)) throw new ConfigError(WATCH_RULE)
    if (data.watch.length === 0) throw new ConfigError(WATCH_EMPTY)
    const seen = new Set()
    out.watch = data.watch.map((entry, i) => {
      const index = i + 1
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new ConfigError(WATCH_RULE)
      for (const key of Object.keys(entry)) {
        if (key !== 'repo' && key !== 'mode') throw new ConfigError(`\`watch\` entry ${index}: \`${key}\` is not a watch entry key`)
      }
      if (typeof entry.repo !== 'string' || !REPO_RE.test(entry.repo)) {
        throw new ConfigError(`\`watch\` entry ${index}: \`repo\` must be \`owner/name\` (got ${JSON.stringify(entry.repo ?? '')})`)
      }
      if (seen.has(entry.repo)) throw new ConfigError(`\`watch\` lists ${entry.repo} twice`)
      seen.add(entry.repo)
      const mode = entry.mode ?? 'auto'
      if (!WATCH_MODES.includes(mode)) {
        throw new ConfigError(`\`watch\` entry ${index}: \`mode\` must be one of ${WATCH_MODES.join(', ')} (got ${JSON.stringify(entry.mode)})`)
      }
      return { repo: entry.repo, mode }
    })
  }
  return out
}

const HEADER = [
  '# Curia operator configuration.',
  '#',
  '# Curia reads this file when the service starts and when the Curia app saves',
  '# a setting. A key you leave out takes the shipped default. Curia checks the',
  '# file before every write and refuses an invalid edit by line, so what is',
  '# here is either exactly what you wrote or an exact error.',
  '#',
  '# The keys, and what each accepts, are documented in the operator guide under',
  '# "Operator configuration". The Curia app rewrites this file when you save, and',
  '# it keeps only the keys, not the comments.',
  '',
]

// The text of a configuration file for `config`, validated first. Keys print
// in contract order, and a watch entry prints its mode only when it is not
// the default, so a file round-trips through the reader unchanged in meaning.
export function renderOperatorConfig(data) {
  const config = validateOperatorConfig(data)
  const lines = [...HEADER]
  for (const key of Object.keys(SCALAR_RULES)) {
    if (config[key] !== undefined) lines.push(`${key}: ${config[key]}`)
  }
  if (config.watch) {
    lines.push('watch:')
    for (const entry of config.watch) {
      lines.push(`  - repo: ${entry.repo}`)
      if (entry.mode !== 'auto') lines.push(`    mode: ${entry.mode}`)
    }
  }
  return `${lines.join('\n')}\n`
}

// Validates, renders, and writes the file atomically with owner-only mode. An
// invalid configuration throws before anything touches the disk.
export function writeOperatorConfig(path, data) {
  const text = renderOperatorConfig(data)
  writeAtomically(path, text, { mode: 0o600 })
}
