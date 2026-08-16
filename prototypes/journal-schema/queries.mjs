// The fourteen questions as SQL, for #321.
//
// Each entry carries the SQL for the proposed schema (`sql`) and, where the
// two differ, the SQL the same question needs on a table with NO epoch column
// (`plain`). The difference is exactly one subquery, and it is the whole case
// for the column.
//
// `read` turns the rows into the value `oracle.mjs` returns for the same
// question, so the two can be compared with deepStrictEqual.

// The epoch of a ticket, two ways.
//   stamped — one probe of (ticket, epoch), rightmost entry.
//   probed  — one probe each of (ticket, 'dispatch_claimed') and
//             (ticket, 'agent_spawned') on (ticket, type, id).
const EPOCH_STAMPED = "(select coalesce(max(epoch), 0) from events where ticket = :t)"
const EPOCH_PROBED = "(select coalesce(max(id), 0) from events where ticket = :t and type in ('dispatch_claimed', 'agent_spawned'))"

// Shape B, split in two on purpose.
//
// The daemon's test is `ev.agent === agentName || ticket matches`, and written
// as one `where ... and (ticket = :t or agent = :a)` that disjunction defeats
// both indexes: SQLite falls back to the type index and walks every event of
// that type since the epoch. Measured at 60,000 events, that costs 3.75 ms
// against 0.02 ms for the form below — 185 times the work, for the same answer.
// So each key gets its own `exists`, and each one is a covering-index seek.
const since = (types) => (epoch) => {
  const list = types.map((t) => `'${t}'`).join(', ')
  return `
select (exists(select 1 from events where ticket = :t and type in (${list}) and id > ${epoch})
     or exists(select 1 from events where agent = :a and type in (${list}) and id > ${epoch})) as answer`.trim()
}

const prSince = since(['pr_opened', 'pr_reused', 'land_repaired'])
const reportedSince = since(['result', 'ticket_resolved'])
const closedSince = since(['result', 'lifecycle_closed', 'dispatch_unclaimed'])

const approvedSince = (epoch) => `
select (exists(select 1 from events where ticket = :t and type = 'review_answered'
                and id > ${epoch} and json_extract(body, '$.approved') = 1)
     or exists(select 1 from events where agent = :a and type = 'review_answered'
                and id > ${epoch} and json_extract(body, '$.approved') = 1)) as answer`.trim()

const blocksSince = (epoch) => `
select count(*) as answer from events
 where id > ${epoch}
   and type = 'stop_blocked'
   and agent = :a`.trim()

// The reset an agent-keyed question runs on: everything after this session's
// last spawn line.
const LAST_SPAWN = "coalesce((select max(id) from events where agent = :a and type = 'agent_spawned'), 0)"

export const QUERIES = [
  {
    n: 1,
    shape: 'B',
    where: '#epochScan',
    question: 'Did this dispatch push a pull request?',
    sql: prSince(EPOCH_STAMPED),
    plain: prSince(EPOCH_PROBED),
    args: ({ ticket, agent }) => ({ t: String(ticket), a: agent }),
    read: (rows) => Boolean(rows[0]?.answer),
    oracle: 'prOpened',
  },
  {
    n: 2,
    shape: 'B',
    where: '#epochScan',
    question: 'Did a human approve this dispatch at the gate?',
    note: 'Predicate-narrowed: only a review_answered whose `approved` is true counts.',
    sql: approvedSince(EPOCH_STAMPED),
    plain: approvedSince(EPOCH_PROBED),
    args: ({ ticket, agent }) => ({ t: String(ticket), a: agent }),
    read: (rows) => Boolean(rows[0]?.answer),
    oracle: 'reviewApproved',
  },
  {
    n: 3,
    shape: 'C',
    where: '#epochScan',
    question: 'How many times has the Stop hook held this agent?',
    sql: blocksSince(EPOCH_STAMPED),
    plain: blocksSince(EPOCH_PROBED),
    args: ({ ticket, agent }) => ({ t: String(ticket), a: agent }),
    read: (rows) => Number(rows[0].answer),
    oracle: 'blocks',
  },
  {
    n: 4,
    shape: 'A',
    where: '#verdictIsLate',
    question: 'Did the merge outrun the reviewer?',
    sql: `
select coalesce(
  (select max(id) from events where ticket = :t and type = 'ticket_resolved')
  > (select max(id) from events where ticket = :t and type = 'reviewer_spawned'), 0) as answer`.trim(),
    args: ({ ticket }) => ({ t: String(ticket) }),
    read: (rows) => Boolean(rows[0].answer),
    oracle: 'verdictIsLate',
  },
  {
    n: 5,
    shape: 'A',
    where: '#liveUnjudgedVerdict',
    question: 'When was this ticket last claimed?',
    sql: `
select ts from events
 where ticket = :t and type = 'dispatch_claimed'
 order by id desc limit 1`.trim(),
    args: ({ ticket }) => ({ t: String(ticket) }),
    read: (rows) => rows[0]?.ts ?? null,
    oracle: 'lastClaim',
  },
  {
    n: 6,
    shape: 'A',
    where: '#epochRepo',
    question: 'Which repo was this ticket last dispatched against?',
    note: 'Predicate-narrowed: the last dispatch event that CARRIES a repo.',
    sql: `
select json_extract(body, '$.repo') as repo from events
 where ticket = :t
   and type in ('dispatch_claimed', 'agent_spawned')
   and json_extract(body, '$.repo') <> ''
 order by id desc limit 1`.trim(),
    args: ({ ticket }) => ({ t: String(ticket) }),
    read: (rows) => rows[0]?.repo ?? null,
    oracle: 'epochRepo',
  },
  {
    n: 7,
    shape: 'A',
    where: '#epochCharting',
    question: 'Was the last dispatch a charting one, and what rode it?',
    sql: `
select json_extract(body, '$.kind') = 'charting' as charting,
       json_extract(body, '$.instruction') as instruction,
       coalesce(json_extract(body, '$.newMap'), 0) as newMap
  from events
 where ticket = :t and type = 'agent_spawned'
 order by id desc limit 1`.trim(),
    args: ({ ticket }) => ({ t: String(ticket) }),
    read: (rows) => (rows.length
      ? { charting: Boolean(rows[0].charting), instruction: rows[0].instruction ?? null, newMap: Boolean(rows[0].newMap) }
      : { charting: false, instruction: null, newMap: false }),
    oracle: 'epochCharting',
  },
  {
    n: 8,
    shape: 'A',
    where: '#epochSpawn',
    question: 'Which model and harness was this session last spawned on?',
    note: 'The one query that reaches for a field #184 renamed. `body` is verbatim, so a pre-rename line says `backend`. The columns are normalized; a JSON field is not.',
    sql: `
select json_extract(body, '$.model') as model,
       coalesce(json_extract(body, '$.harness'), json_extract(body, '$.backend')) as harness
  from events
 where agent = :a and type = 'agent_spawned'
 order by id desc limit 1`.trim(),
    args: ({ agent }) => ({ a: agent }),
    read: (rows) => (rows.length ? { model: rows[0].model ?? null, harness: rows[0].harness ?? null } : null),
    oracle: 'epochSpawn',
  },
  {
    n: 9,
    shape: 'A',
    where: '#epochAdoptedMap',
    question: 'Which map did this session report?',
    note: 'Keyed by agent, and reset at that session`s last spawn line.',
    sql: `
select json_extract(body, '$.map') as map from events
 where agent = :a and type = 'map_adopted'
   and id > ${LAST_SPAWN}
   and json_extract(body, '$.map') <> ''
 order by id desc limit 1`.trim(),
    args: ({ agent }) => ({ a: agent }),
    read: (rows) => (rows[0]?.map == null ? null : String(rows[0].map)),
    oracle: 'adoptedMap',
  },
  {
    n: 10,
    shape: 'A',
    where: '#endingClause',
    question: 'What did the ending say?',
    note: 'Predicate-narrowed: the last ending carrier that CARRIES a summary.',
    sql: `
select json_extract(body, '$.summary') as summary from events
 where agent = :a
   and type in ('ticket_resolved', 'nonclean_noted', 'charting_finished')
   and id > ${LAST_SPAWN}
   and json_extract(body, '$.summary') <> ''
 order by id desc limit 1`.trim(),
    args: ({ agent }) => ({ a: agent }),
    read: (rows) => rows[0]?.summary ?? null,
    oracle: 'endingClause',
  },
  {
    n: 11,
    shape: 'A',
    where: '#captureVerdict',
    question: 'Which ticket and repo does this reviewer belong to?',
    sql: `
select ticket,
       json_extract(body, '$.repo') as repo,
       json_extract(body, '$.model') as model,
       json_extract(body, '$.builder_model') as builder_model,
       json_extract(body, '$.same_provider') as same_provider,
       json_extract(body, '$.sha') as sha
  from events
 where agent = :a and type = 'reviewer_spawned'
 order by id desc limit 1`.trim(),
    args: ({ agent }) => ({ a: agent }),
    read: (rows) => (rows.length
      ? {
        ticket: String(rows[0].ticket ?? ''),
        repo: rows[0].repo ?? null,
        model: rows[0].model ?? null,
        builder_model: rows[0].builder_model ?? null,
        same_provider: Boolean(rows[0].same_provider),
        sha: rows[0].sha ?? null,
      }
      : null),
    oracle: 'reviewerSpawn',
  },
  {
    n: 12,
    shape: 'A',
    where: '#reconcileContext',
    question: 'What is every ticket`s latest dispatch epoch?',
    note: 'The one question that is not keyed: it answers for every ticket at once, and reconcile runs it once a pass.',
    sql: `
select e.ticket, e.id, json_extract(e.body, '$.repo') as repo
  from events e
  join (select ticket, max(id) as id from events
         where type in ('dispatch_claimed', 'agent_spawned') and ticket is not null
         group by ticket) latest on latest.id = e.id
 order by e.ticket`.trim(),
    args: () => ({}),
    read: (rows) => new Map(rows.map((r) => [String(r.ticket), { idx: r.id - 1, repo: r.repo ?? null }])),
    oracle: 'epochs',
    whole: true,
  },
  {
    n: 13,
    shape: 'B',
    where: 'reconcile, the orphan guard',
    question: 'Did this session report a result after its dispatch?',
    sql: reportedSince(EPOCH_STAMPED),
    plain: reportedSince(EPOCH_PROBED),
    args: ({ ticket, agent }) => ({ t: String(ticket), a: agent }),
    read: (rows) => Boolean(rows[0]?.answer),
    oracle: 'reportedAfterEpoch',
  },
  {
    n: 14,
    shape: 'B',
    where: 'reconcile, the dead-claim guard',
    question: 'Did anything close this epoch?',
    sql: closedSince(EPOCH_STAMPED),
    plain: closedSince(EPOCH_PROBED),
    args: ({ ticket, agent }) => ({ t: String(ticket), a: agent }),
    read: (rows) => Boolean(rows[0]?.answer),
    oracle: 'closedAfterEpoch',
  },
]

// The five the operator types by hand, from the daemon README. They are here
// to be RUN, not quoted: #320 made this schema the whole debugging surface.
//
// Each one is built as literal SQL text, because that is what a human types
// into `sqlite3`. A bound parameter would prove something else — see the
// `numbers` note in `run.mjs`.
export const OPERATOR_QUERIES = [
  {
    title: 'what happened to one ticket',
    sql: ({ ticket }) => `select ts, type, ticket, agent from events where ticket=${ticket} order by id`,
    note: 'A bare number against a TEXT column. SQLite applies the column`s TEXT affinity to the integer literal, so `ticket=320` finds the rows stored as `320`.',
  },
  {
    title: 'the last thirty events',
    sql: () => 'select ts, type, ticket, agent from events order by id desc limit 30',
  },
  {
    title: 'one whole line, exactly as curia wrote it',
    sql: ({ id }) => `select body from events where id=${id}`,
  },
  {
    title: 'the census, by type',
    sql: () => 'select type, count(*) from events group by type order by 2 desc',
  },
  {
    title: 'how one agent ended',
    sql: ({ agent }) => `select ts, type, body from events where agent='${agent}' order by id desc limit 10`,
    note: 'The #184 test: this agent was named `"worker"` on the lines it wrote, and the normalized column still finds them.',
  },
]
