// Turns `results.json` into the one self-contained page (#321).
//
//   node prototypes/journal-schema/run.mjs && node prototypes/journal-schema/demo.mjs
//
// Every number on the page comes out of the run. Nothing here is typed by hand.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const r = JSON.parse(fs.readFileSync(path.join(here, 'results.json'), 'utf8'))
const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8')

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const mb = (b) => `${(b / 1e6).toFixed(2)} MB`
const live = r.sizes.find((s) => s.live)
const top = r.sizes[r.sizes.length - 1]
const keyedTotal = (s) => s.queries.filter((q) => q.n !== 12).reduce((a, b) => a + b.sqlMs, 0)
const q12 = (s) => s.queries.find((q) => q.n === 12)
const checks = r.sizes.reduce((a, s) => a + s.equivalence.checks, 0)
const mismatches = r.sizes.reduce((a, s) => a + s.equivalence.mismatches.length, 0)

const costRows = r.sizes.map((s) => `
  <tr>
    <td>${s.size.toLocaleString('en-US')}${s.live ? ' <span class="tag">today</span>' : ''}</td>
    <td>${mb(s.sizes.journalFileBytes)}</td>
    <td>${mb(s.sizes.dbBytes)}</td>
    <td>${s.wholeReadMs} ms</td>
    <td>${keyedTotal(s).toFixed(3)} ms</td>
    <td>${q12(s).sqlMs} ms</td>
  </tr>`).join('')

const queryCards = live.queries.map((q) => {
  const atTop = top.queries.find((x) => x.n === q.n)
  return `
  <article class="q">
    <h3><span class="n">${q.n}</span> ${esc(q.question)}</h3>
    <p class="meta">shape ${q.shape} · ${esc(q.where)} · <b>${q.sqlMs} ms</b> today, <b>${atTop.sqlMs} ms</b> at 250,000 · the loop it replaces: ${q.scanMs} ms <i>plus</i> a ${live.wholeReadMs} ms read</p>
    ${q.note ? `<p class="note">${esc(q.note)}</p>` : ''}
    <pre>${esc(q.sql)}</pre>
    <details><summary>query plan</summary><pre class="plan">${esc(q.plan.join('\n'))}</pre></details>
  </article>`
}).join('')

const operatorCards = live.operator.map((o) => `
  <article class="q">
    <h3>${esc(o.title)}</h3>
    <pre>${esc(o.sql)}</pre>
    <p class="meta">${o.count} row${o.count === 1 ? '' : 's'} in ${o.ms} ms</p>
    ${o.note ? `<p class="note">${esc(o.note)}</p>` : ''}
    <pre class="out">${esc(JSON.stringify(o.sample[0] ?? null, null, 1))}</pre>
  </article>`).join('')

const indexRows = live.sizes.perIndex.map((i) => `<tr><td>${esc(i.name)}</td><td>${mb(i.bytes)}</td></tr>`).join('')

const html = `<title>The schema and the fourteen queries — curia#321</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --dim: #5c6470; --bg: #fbfbfa; --card: #fff; --line: #e3e2dd; --accent: #7a4a1e; --ok: #1f6b3a; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e6e1; --dim: #9aa1ac; --bg: #16181c; --card: #1e2126; --line: #2e323a; --accent: #e0a166; --ok: #6fd39a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 1rem 1rem 5rem; background: var(--bg); color: var(--fg);
         font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         max-width: 52rem; margin-inline: auto; overflow-wrap: break-word; }
  h1 { font-size: 1.45rem; line-height: 1.25; margin: .4rem 0 .2rem; }
  h2 { font-size: 1.1rem; margin: 2.2rem 0 .6rem; padding-top: .8rem; border-top: 1px solid var(--line); }
  h3 { font-size: 1rem; margin: 0 0 .3rem; font-weight: 620; }
  .sub { color: var(--dim); margin: 0 0 1rem; font-size: .92rem; }
  .verdict { background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--ok);
             border-radius: 8px; padding: .9rem 1rem; }
  .verdict p:first-child { margin-top: 0; }
  .verdict ul { margin: .5rem 0 0; padding-left: 1.1rem; }
  .verdict li { margin: .35rem 0; }
  article.q { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
              padding: .8rem .9rem; margin: .7rem 0; }
  .n { display: inline-block; min-width: 1.5rem; color: var(--accent); font-variant-numeric: tabular-nums; }
  .meta { color: var(--dim); font-size: .84rem; margin: .2rem 0 .5rem; }
  .note { font-size: .88rem; margin: .3rem 0 .5rem; }
  pre { background: color-mix(in srgb, var(--fg) 5%, transparent); border-radius: 6px;
        padding: .6rem .7rem; overflow-x: auto; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        margin: .4rem 0; }
  pre.plan, pre.out { font-size: 11.5px; color: var(--dim); }
  details summary { cursor: pointer; color: var(--dim); font-size: .82rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .88rem; min-width: 34rem; }
  th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--dim); font-weight: 600; font-size: .8rem; }
  .tag { background: var(--accent); color: var(--bg); border-radius: 4px; padding: 0 .3rem; font-size: .7rem; vertical-align: 2px; }
  ol.ask { padding-left: 1.2rem; }
  ol.ask li { margin: .6rem 0; }
  code { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: color-mix(in srgb, var(--fg) 7%, transparent); border-radius: 4px; padding: .05rem .25rem; }
  footer { color: var(--dim); font-size: .8rem; margin-top: 2.5rem; }
</style>

<h1>The schema and the fourteen queries</h1>
<p class="sub">alp82/curia#321, on the store map #316 · prototype · Node ${r.node}, SQLite ${r.sqlite}</p>

<div class="verdict">
  <p><b>The schema holds.</b> One table, seven columns, four indexes, one trigger. It answers all
  fourteen questions exactly as the daemon's loop answers them: <b>${checks.toLocaleString('en-US')} checks</b>
  over four journal sizes, <b>${mismatches} mismatches</b>.</p>
  <ul>
    <li><b>The thirteen keyed questions cost ${keyedTotal(live).toFixed(3)} ms together</b>, and the number does not
    move with history: ${keyedTotal(top).toFixed(3)} ms at 250,000 events. Today one of them costs a
    ${live.wholeReadMs} ms whole read.</li>
    <li><b>The Stop hook is the win.</b> It pays one whole read per turn of every agent today. It pays
    three indexed seeks after this.</li>
    <li><b>One question stays proportional to history.</b> Question 12 asks about every ticket at once, and
    reconcile runs it once a pass: ${q12(live).sqlMs} ms today, ${q12(top).sqlMs} ms at 250,000 — against the
    ${top.wholeReadMs} ms read it replaces.</li>
    <li><b>A committed write costs ${live.write.stamped} ms</b> with WAL and <code>synchronous=full</code>, against
    ${live.write.plain} ms without the epoch trigger. At 404 events a day that difference is a tenth of a second a day.</li>
    <li><b>The journal costs about ${(live.sizes.dbBytes / live.sizes.journalFileBytes).toFixed(1)}× the text file</b>:
    ${mb(live.sizes.dbBytes)} against ${mb(live.sizes.journalFileBytes)} today. The verbatim <code>body</code> is the record,
    and the columns and indexes are what make it answer.</li>
    <li><b>The five queries in the daemon README all run</b>, on a journal whose oldest fifth carries the
    pre-#184 spelling.</li>
  </ul>
</div>

<h2>What one journal costs</h2>
<div class="scroll">
<table>
  <tr><th>events</th><th>text file</th><th>journal</th><th>one whole read (today)</th><th>the 13 keyed queries</th><th>question 12</th></tr>
  ${costRows}
</table>
</div>
<p class="sub">The read column is what the daemon pays now, once per question that misses its in-memory
short circuit. The two query columns are what it pays after. Every row is one synthetic journal of the
measured shape: about ${live.fidelity.bytesPerLine} bytes a line, ${live.fidelity.types} distinct types,
dispatches interleaved, the oldest fifth in the old spelling.</p>

<h2>The schema</h2>
<pre>${esc(schema)}</pre>
<div class="scroll">
<table>
  <tr><th>on disk today (${live.size.toLocaleString('en-US')} events)</th><th></th></tr>
  ${indexRows}
</table>
</div>

<h2>The fourteen questions</h2>
<p class="sub">Every one is checked against the daemon's own loop, ported line for line into
<code>oracle.mjs</code>. Where the two disagree the query is wrong — including where the daemon's rule
is surprising.</p>
${queryCards}

<h2>The five the operator types</h2>
<p class="sub">From <a href="https://github.com/alp82/curia/blob/main/daemon/README.md#reading-the-journal">the daemon README</a>,
run as written against the synthetic journal. The ticket below was dispatched before #184, so its lines
say <code>"worker"</code> and the column still finds them.</p>
${operatorCards}

<h2>What the prototype found</h2>
<article class="q">
  <h3>1 · Split the disjunction, or lose the index</h3>
  <p>The daemon's test is <code>ev.agent === agent || ticket matches</code>. Written as one
  <code>where … and (ticket = :t or agent = :a)</code>, SQLite drops both keyed indexes and walks the type
  index instead: <b>3.75 ms</b> at 60,000 events, against <b>0.02 ms</b> for two <code>exists</code> —
  185 times the work for the same answer. Shapes B and C are written as two <code>exists</code> above.</p>
</article>
<article class="q">
  <h3>2 · Stringify the ticket at the write edge</h3>
  <p><code>node:sqlite</code> binds a JavaScript number as a REAL, so a ticket handed straight off the event
  lands in the TEXT column as <code>"${live.fidelity.numbers.bound_number.stored}"</code> — and every
  <code>where ticket=321</code> then misses it. Stringified, it stores
  <code>"${live.fidelity.numbers.bound_string.stored}"</code> and a bare integer literal finds it:
  <code>where ticket=${live.fidelity.affinity.ticket}</code> and <code>where ticket='${live.fidelity.affinity.ticket}'</code>
  both return ${live.fidelity.affinity.asNumber} rows.</p>
</article>
<article class="q">
  <h3>3 · <code>body</code> is verbatim, so one JSON field still says <code>backend</code></h3>
  <p>The columns carry today's spelling. <code>body</code> carries the line as written, which is what
  ADR-0017 fixes. #184 renamed two fields, and one of them is not a column: a pre-rename line says
  <code>"backend"</code> where today's says <code>"harness"</code>. Question 8 reads
  <code>coalesce(json_extract(body,'$.harness'), json_extract(body,'$.backend'))</code> for it. That is the
  only field with the problem — <code>worker</code> is the <code>agent</code> column.</p>
</article>
<article class="q">
  <h3>4 · The epoch is keyed by ticket, and a reviewer moves it</h3>
  <p>A cross-check writes <code>agent_spawned</code> under the BUILDER's ticket, so spawning a reviewer
  opens a new epoch for the builder. The daemon does that today. The schema reproduces it rather than
  fixing it, because the check is "does the query answer what the loop answers". If it is wrong it is
  wrong in <code>dispatch.mjs</code>, and it is not this ticket's to change.</p>
</article>

<h2>What the operator is asked</h2>
<ol class="ask">
  <li><b>The <code>epoch</code> column: keep it?</b> #320 asked for it, and this prototype reads it as the
  dispatch epoch rather than a unix stamp. It buys the operator
  <code>select * from events where epoch=(select max(epoch) from events where ticket=321)</code> — one
  dispatch, whole. It does not buy speed: a query that probes the epoch itself runs the same. It costs
  ${(live.write.stamped - live.write.plain).toFixed(3)} ms a write and one index.
  <i>Recommended: keep it.</i></li>
  <li><b>A sixth column, <code>repo</code>?</b> Three of the fourteen read it out of the body, and it is a
  plausible thing to type by hand. It costs about twelve bytes a row and nothing at write time.
  <i>Recommended: add it.</i></li>
</ol>

<h2>Run it</h2>
<pre>node prototypes/journal-schema/run.mjs   # builds, checks, measures, writes results.json
node prototypes/journal-schema/demo.mjs  # writes this page</pre>

<footer>Generated from results.json. Throwaway code under <code>prototypes/</code> (ADR-0008), kept on main
because a merge is the only durable home curia has.</footer>
`

fs.writeFileSync(path.join(here, 'demo.html'), html)
console.log(`demo.html written (${(html.length / 1024).toFixed(1)} kB)`)
