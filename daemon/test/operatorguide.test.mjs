// The operator guide stays true to the tree and to the lifecycle interface
// (#888). Every relative link in `docs/operator/` resolves to a file and, when
// it carries an anchor, to a heading in that file. Every `curia <command>` in a
// code span or block names a command the interface routes, with only the
// options that command accepts. Every `bash curia-install.sh --option` names an
// option the bootstrap parses. Every `[n/N] step` names the step at that
// position of that command. Every guide topic carries the lifecycle rail with
// itself marked current, and opens with the topic contract. The index links
// every topic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname, relative, join } from 'node:path'

import { commands } from '../../cli/src/commands.mjs'
import { INSTALL_STEPS } from '../../cli/src/install.mjs'
import { UPDATE_STEPS } from '../../cli/src/update.mjs'
import { ROLLBACK_STEPS } from '../../cli/src/rollback.mjs'
import { UNINSTALL_STEPS } from '../../cli/src/uninstall.mjs'
import { PURGE_STEPS } from '../../cli/src/purge.mjs'

const REPO = resolve(new URL('../..', import.meta.url).pathname)
const OPERATOR = join(REPO, 'docs/operator')
const GUIDE = join(OPERATOR, 'guide')

// Pages a later ticket writes. A link to one of these is allowed while the file
// is absent; once the file lands, remove the entry here.
const PENDING = {}

// Files outside docs/operator whose links into docs/operator are checked too.
const OUTSIDE = ['README.md', 'CONTEXT.md', 'docs/deploy.md', 'docs/github-app.md', 'daemon/README.md']

// The lifecycle rail, in the accepted order (#858, variant A). Each entry is a
// guide page; the label is what the rail prints for it.
const RAIL = [
  { group: 'Get Curia running', topics: [
    ['01-check-prerequisites.md', '1. Check prerequisites'],
    ['02-install-curia.md', '2. Install Curia'],
    ['03-connect-services.md', '3. Connect services'],
    ['04-run-your-first-full-loop.md', '4. Run your first Full loop'],
  ] },
  { group: 'Run Curia', topics: [
    ['05-daily-operation.md', '5. Daily operation'],
    ['06-check-the-installation.md', '6. Check the installation'],
  ] },
  { group: 'Change the installation', topics: [
    ['07-update-or-roll-back.md', '7. Update or roll back'],
    ['08-migrate-the-current-deployment.md', '8. Migrate the current deployment'],
    ['09-uninstall-or-purge.md', '9. Uninstall or purge'],
  ] },
  { group: 'When something fails', topics: [
    ['troubleshooting.md', 'Troubleshooting'],
  ] },
]
const RAIL_PAGES = RAIL.flatMap((g) => g.topics.map(([file]) => file))

// The direct entries. Each names the page and the H2 section (or the whole
// page when the section is null) that must open with the topic contract.
const DIRECT_ENTRIES = [
  ['06-check-the-installation.md', null],
  ['07-update-or-roll-back.md', 'Update'],
  ['07-update-or-roll-back.md', 'Roll back'],
  ['08-migrate-the-current-deployment.md', null],
  ['09-uninstall-or-purge.md', 'Uninstall'],
  ['09-uninstall-or-purge.md', 'Purge'],
]
const CONTRACT = ['**Outcome:**', '**Starting state:**', '**Active operator time:**']

function markdownFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path))
    else if (entry.endsWith('.md')) out.push(path)
  }
  return out.sort()
}

function stripFences(text) {
  return text.replace(/^```[\s\S]*?^```$/gm, '')
}

function fences(text) {
  return [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map((m) => m[1])
}

function codeSpans(text) {
  return [...stripFences(text).matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
}

// GitHub's heading slug: lowercase, drop everything but letters, digits,
// spaces, and hyphens, turn spaces into hyphens, suffix duplicates.
function slugs(text) {
  const seen = new Map()
  const out = new Set()
  for (const m of stripFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

function links(text) {
  return [...stripFences(text).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1])
}

const operatorPages = markdownFiles(OPERATOR)
const read = (path) => readFileSync(path, 'utf8')
const rel = (path) => relative(REPO, path)

test('every relative link in the operator pages resolves to a file and a heading', () => {
  const problems = []
  const sources = [...operatorPages, ...OUTSIDE.map((f) => join(REPO, f))]
  for (const source of sources) {
    const text = read(source)
    const inside = source.startsWith(OPERATOR)
    for (const href of links(text)) {
      if (/^[a-z]+:/i.test(href)) continue
      const [pathPart, anchor] = href.split('#')
      const target = pathPart ? resolve(dirname(source), pathPart) : source
      if (!inside && !target.startsWith(OPERATOR)) continue
      const targetRel = rel(target)
      if (!existsSync(target)) {
        if (PENDING[targetRel]) continue
        problems.push(`${rel(source)}: ${href} -> ${targetRel} does not exist`)
        continue
      }
      if (anchor !== undefined && target.endsWith('.md')) {
        if (!slugs(read(target)).has(anchor)) problems.push(`${rel(source)}: ${href} -> no heading #${anchor} in ${targetRel}`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('a pending page is removed from the list once it lands', () => {
  for (const [page, ticket] of Object.entries(PENDING)) {
    assert.ok(!existsSync(join(REPO, page)), `${page} exists now: drop it from PENDING (${ticket})`)
  }
})

test('every curia command in the operator pages is one the interface routes, with its own options', () => {
  const known = new Set([...Object.keys(commands), 'help', '--help', '-h', '--version', '-V'])
  const options = { install: new Set(['--name']), update: new Set(['--prerelease']), purge: new Set(['--confirm']) }
  // A message quoted in code font may read `curia can't ...`: the bot speaks
  // as curia. Nothing else after `curia ` is prose.
  const prose = new Set(['can'])
  const problems = []
  for (const page of operatorPages) {
    const text = read(page)
    const snippets = [...codeSpans(text), ...fences(text).flatMap((f) => f.split('\n'))]
    for (const snippet of snippets) {
      // `curia` starts a command when it opens the snippet, follows a quote, a
      // path, or `&&`. After `-p` it is the Compose project name.
      for (const m of snippet.matchAll(/(?:^|['"(]|bin\/|&&\s+)curia ((?:-|[a-z])[\w-]*)((?:\s+\S+)*)/g)) {
        const name = m[1]
        if (prose.has(name)) continue
        if (!known.has(name)) {
          problems.push(`${rel(page)}: \`curia ${name}\` is not a command`)
          continue
        }
        const flags = (m[2] ?? '').split(/\s+/).filter((t) => t.startsWith('--')).map((t) => t.split('=')[0])
        const allowed = options[name] ?? new Set()
        for (const flag of flags) {
          if (!allowed.has(flag)) problems.push(`${rel(page)}: \`curia ${name} ${flag}\` is not an option ${name} accepts`)
        }
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('every bootstrap option in the operator pages is one the script parses', () => {
  const script = read(join(REPO, 'deploy/bootstrap/curia-install.sh'))
  const parsed = new Set([...script.matchAll(/^\s+(--[a-z-]+)(?:\|-h)?\)/gm)].map((m) => m[1]))
  assert.ok(parsed.has('--root') && parsed.has('--purge'), `the script's option parser was not found: ${[...parsed]}`)
  const problems = []
  for (const page of operatorPages) {
    const text = read(page)
    const snippets = [...codeSpans(text), ...fences(text).flatMap((f) => f.split('\n'))]
    for (const snippet of snippets) {
      for (const m of snippet.matchAll(/curia-install\.sh((?:\s+\S+)*)/g)) {
        for (const flag of (m[1] ?? '').split(/\s+/).filter((t) => t.startsWith('--')).map((t) => t.split('=')[0])) {
          if (!parsed.has(flag)) problems.push(`${rel(page)}: curia-install.sh ${flag} is not an option the script parses`)
        }
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('every [n/N] step in the operator pages is the step at that position of a command', () => {
  const sequences = [INSTALL_STEPS, UPDATE_STEPS, ROLLBACK_STEPS, UNINSTALL_STEPS, PURGE_STEPS]
  const problems = []
  for (const page of operatorPages) {
    for (const m of read(page).matchAll(/\[(\d)\/(\d)\] ([a-z]+)/g)) {
      const [, n, total, step] = m
      const fits = sequences.some((s) => s.length === Number(total) && s[Number(n) - 1] === step)
      if (!fits) problems.push(`${rel(page)}: [${n}/${total}] ${step} is not a step at that position of any command`)
    }
  }
  assert.deepEqual(problems, [])
})

test('every guide topic carries the lifecycle rail with itself marked current', () => {
  const railFor = (current) => [
    'Operator guide · [Index](../README.md)',
    '',
    ...RAIL.map(({ group, topics }) => `- **${group}:** ` + topics
      .map(([file, label]) => (file === current ? `**${label} (this topic)**` : `[${label}](${file})`))
      .join(' · ')),
  ]
  const present = readdirSync(GUIDE).filter((f) => f.endsWith('.md')).sort()
  assert.deepEqual(present, [...RAIL_PAGES].sort(), 'the guide directory holds exactly the rail pages')
  for (const file of RAIL_PAGES) {
    const lines = read(join(GUIDE, file)).split('\n')
    assert.match(lines[0], /^# /, `${file} starts with its title`)
    assert.deepEqual(lines.slice(2, 2 + railFor(file).length), railFor(file), `${file} carries the rail`)
  }
})

test('every lifecycle topic and every direct entry opens with the topic contract', () => {
  const sections = (text) => {
    const out = new Map()
    let name = null
    for (const line of stripFences(text).split('\n')) {
      const h2 = line.match(/^## (.+)$/)
      if (h2) { name = h2[1]; out.set(name, []); continue }
      if (name === null) { out.set(null, [...(out.get(null) ?? []), line]); continue }
      out.get(name).push(line)
    }
    return out
  }
  const inOrder = (lines) => {
    const positions = CONTRACT.map((key) => lines.findIndex((l) => l.startsWith(key)))
    return positions.every((p) => p >= 0) && positions.every((p, i) => i === 0 || p > positions[i - 1])
  }
  for (const file of RAIL_PAGES.filter((f) => f !== 'troubleshooting.md')) {
    const secs = sections(read(join(GUIDE, file)))
    const entries = DIRECT_ENTRIES.filter(([page, section]) => page === file && section !== null).map(([, section]) => section)
    if (entries.length === 0) {
      assert.ok(inOrder(secs.get(null) ?? []), `${file} opens with ${CONTRACT.join(', ')}`)
    } else {
      for (const section of entries) {
        assert.ok(secs.has(section), `${file} has a section ## ${section}`)
        assert.ok(inOrder(secs.get(section)), `${file} ## ${section} opens with ${CONTRACT.join(', ')}`)
      }
    }
  }
})

test('the index links every guide topic and every reference page', () => {
  const index = read(join(OPERATOR, 'README.md'))
  const hrefs = new Set(links(index).map((h) => h.split('#')[0]))
  for (const file of RAIL_PAGES) assert.ok(hrefs.has(`guide/${file}`), `the index links guide/${file}`)
  for (const page of operatorPages) {
    const name = relative(OPERATOR, page)
    if (name === 'README.md' || name.startsWith('guide/')) continue
    assert.ok(hrefs.has(name), `the index links the reference page ${name}`)
  }
})
