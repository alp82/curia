# What the map snapshot must carry for the Maps page

Evidence for [What must the map snapshot carry for the dependency-graph Maps page?](https://github.com/alp82/curia/issues/1030), on [the Curia app redesign map](https://github.com/alp82/curia/issues/1017). Read on September 23, 2026, against `origin/main` at `0c61595`. GitHub facts come from GitHub's REST docs and from live reads of map #1017 with `gh api`.

[Choose a map overview for the full plan and its execution](https://github.com/alp82/curia/issues/1022) chose **L, Graph + list**. The prototype's mock ticket carries a number, type, title, state, and every blocker number, and its map carries a destination, fog, out-of-scope lines, a parent or child map, a last-look time, and a list of changes (`prototypes/map-overview/index.html` lines 396-527 on branch [`prototype/map-overview`](https://github.com/alp82/curia/tree/prototype/map-overview/prototypes/map-overview)). This note checks each of those facts against what the daemon reads today.

## Summary

| Fact | Carried today | Gap | Cheapest source |
| --- | --- | --- | --- |
| Blocking edges | Open blockers of open, unassigned, blocked children only | Closed blockers, and every edge on closed, working, and ready children | One GraphQL query per map, or one REST `blocked_by` call per child with `total_blocked_by > 0` |
| Type | `type` on every child | Nothing for children. Blocker and unblock entries carry no type | Look up by number in the same snapshot |
| State | Four buckets: walked, in flight, takeable, blocked | Working needs a live session. Needs an answer and needs a review aren't per ticket | Journal and reduction, joined in memory. No GitHub call |
| Fog | `fog: [{ text }]` | Nothing | Already carried |
| Out of scope | Nothing. Ruled-out tickets count as walked | The section, and which closed children it names | Parse the map body the snapshot already holds |
| Planning map to build map | Nothing | The link, both ways | Sub-issue nesting: the planning map's child list, plus one `/parent` read when needed |
| Changes since the last look | One latest-event stamp per map | The change list and the last-look time | Journal rows after a watermark, plus `closed_at` and `created_at` from GitHub |

## How the snapshot is built today

`readMapSnapshot` (`daemon/src/mapsnapshot.mjs:77-151`) makes these reads for each watched repo:

1. `repoMaps` lists every `wayfinder:map` issue, open and closed, with its body (`daemon/src/github.mjs:64-66`). The snapshot keeps the open ones (`mapsnapshot.mjs:82`).
2. `mapFrontier` lists each open map's sub-issues (`github.mjs:69-71`, `mapsnapshot.mjs:84`).
3. `journal.mapSnapshotFacts` asks the journal for each child's latest event and the agent spawned in its current epoch (`daemon/src/questions.mjs:404-450`).
4. `categoriesOf` sorts the children into `walked`, `in_flight`, `takeable`, and `blocked` (`mapsnapshot.mjs:58-67`).
5. `blockedByOf` reads the blockers of each child in `blocked` (`github.mjs:174-176`, `mapsnapshot.mjs:87-96`).

`MapSnapshot` serves the last reading and refreshes it in the background when any journal event marks it dirty (`mapsnapshot.mjs:160-201`, `daemon/src/index.mjs:662-666`). One refresh costs 18 to 28 seconds on the live box (`mapsnapshot.mjs:155-157`). `GET /overview` serves it as `maps` (`index.mjs:3057-3071`, `index.mjs:3203`).

The frontier snapshot adds nothing this page needs. It holds takeable tickets with labels, the routed model, and one level of unblocks (`daemon/src/dispatch.mjs:865-897`). Its edge read covers the same open blocked children and drops nothing else (`dispatch.mjs:1092-1107`). The Maps page can stay off it, as `CONTEXT.md` already requires for the current Maps screen.

## Blocking edges, including closed blockers

**Today.** Only children in `blocked` get an edge read, and the snapshot keeps only open blockers (`mapsnapshot.mjs:87-91`). A child is in `blocked` only if it's open, unassigned, and `issue_dependencies_summary.blocked_by > 0` (`mapsnapshot.mjs:60-64`). Takeable children get `unblocks`, which is the same edge set reversed (`mapsnapshot.mjs:109-116`).

**Gap.** The graph lays tickets out in dependency order and draws a line to every blocker, open or closed. Three kinds of edges are missing:

- Edges to closed blockers. Ticket #1025 has four blockers, and the snapshot names one of them.
- Every edge on a closed child. #1021 and #1022 are closed with blockers, and the snapshot reads none of their edges.
- Every edge on a working child, since `in_flight` takes assigned children before the blocked check.

**GitHub facts.**

- `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` returns issue objects, paginated to 100 per page ([Issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)). The docs don't say whether closed blockers are included. A live read of #1025 returned all four blockers, three `closed` and one `open`, so closed blockers are included.
- Each issue in the sub-issue list carries `issue_dependencies_summary` with `blocked_by` (open blockers) and `total_blocked_by` (all blockers). #1021 reads `blocked_by: 0, total_blocked_by: 2`. The daemon reads only `blocked_by` today.
- A parent holds up to 100 sub-issues, nested up to eight levels ([Adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)).

**Cheapest source.** There are two options:

- **REST, the pattern the daemon already uses.** Call `blockedByOf` for every child with `total_blocked_by > 0`, and keep `state` on each blocker. On #1017 that's seven calls instead of two. Each call is one `gh` process spawn.
- **GraphQL, one call per map.** One query for `subIssues { number state stateReason labels assignees blockedBy { number state } }` returned the full graph of #1017, closed blockers included, at a cost of 3 rate-limit points. The daemon makes no GraphQL calls today. The query ran with the operator's token, and it wasn't checked with the Curia App installation token.

Either way, the snapshot should carry the edge list once per map, for example `edges: [{ from, to, open }]` or `blocked_by: [number]` on every child. A blocker outside the map needs its own small node with number, title, state, and repo, because the lookup by number fails for it.

## Each ticket's type

**Today.** `typeOf` reads the first `wayfinder:` label and strips the prefix (`mapsnapshot.mjs:14-17`). `ticketFact` puts it on every child in all four buckets (`mapsnapshot.mjs:19-25`). A child with no such label has `type: null`, and the page says "untyped" (`daemon/assets/dashboard.html:2766`).

**Gap.** None for children. Entries in `blockers` and `unblocks` carry number and title only (`mapsnapshot.mjs:91`, `mapsnapshot.mjs:115`). With a full child list, the page finds their type by number. The set of type strings for execution tickets is open on [Which ticket types do execution tickets on a map carry?](https://github.com/alp82/curia/issues/1031). The snapshot passes the label through, so it doesn't need to change when that set does.

One side effect to watch: `typeOf` takes the first `wayfinder:` label. A child that also carries `wayfinder:deferred` could report `deferred` as its type, depending on label order.

**Cheapest source.** Already carried.

## Each ticket's state

The page needs six states: closed, working, needs an answer, needs a review, ready, and blocked.

**Today.** `categoriesOf` makes four buckets from GitHub fields alone (`mapsnapshot.mjs:58-67`):

| Bucket | Rule | Page state |
| --- | --- | --- |
| `walked` | `state === 'closed'` | Closed, but ruled-out tickets land here too |
| `in_flight` | open with any assignee | Working, needs an answer, or needs a review, mixed |
| `blocked` | open, unassigned, open blocker | Blocked |
| `takeable` | the rest | Ready |

`in_flight` rows carry `agent` from the journal: the session, model, and harness of the `agent_spawned` row in the ticket's current epoch (`questions.mjs:404-450`). That row stays after the session ends, so `agent` doesn't prove a live session.

The current Maps screen finds "needs you" outside the snapshot. `mapNeeds` joins `overview.escalations`, `overview.review_gate`, and agents that are waiting, all by ticket number without the repo (`dashboard.html:2768-2775`). Escalation records carry `agent` and `ticket` but no repo (`daemon/src/reduction.mjs:706-711`, `index.mjs:2954-2972`). A review gate is an escalation of kind `review-gate` (`daemon/src/lifecycle.mjs:31`, `index.mjs:3162-3170`).

**Gaps.**

- **Working.** An assignee is a claim, not a live session. A claim that a dead session left, or an assignee a person added by hand, reads as working.
- **Needs an answer** and **needs a review** aren't in the snapshot. The page has to join them, which breaks the rule that every Maps fact comes from the map snapshot. The join also matches by ticket number only, so two watched repos with the same number collide.
- **Blocked** has one hole: a claimed child with an open blocker goes to `in_flight` and never gets its blockers read.

**Cheapest source.** Every missing fact is already in the daemon's memory or the journal, so no GitHub call is needed:

- **Needs an answer:** an open escalation in `reduction.openEscalations()` whose kind isn't `review-gate`, for this ticket. Resolve the repo through the agent's spawn row, which records the repo.
- **Needs a review:** an open escalation of kind `review-gate` for this ticket.
- **Working:** the current epoch has an `agent_spawned` row and no closing row after it. `questions.mjs:46` already lists the closing types as `result`, `lifecycle_closed`, and `dispatch_unclaimed`, and `agent_died` belongs with them for this purpose. That's one more column on the `mapSnapshotFacts` query. The fleet read would confirm the session is live, but it asks tmux (`index.mjs:3073-3085`), so keep it off the refresh.

Suggested precedence: closed, then needs an answer, needs a review, working, blocked, and ready. An open ticket with an assignee and no live session remains. The resolution on #1022 says reconcile releases such claims, so this state is brief for a Curia claim. An assignee a person added by hand doesn't clear. The build should pick one word for it rather than call it working.

**Freshness.** These facts change on journal events. Today every journal event triggers a GitHub refresh that takes 18 to 28 seconds. The cheaper shape splits the snapshot into a GitHub half, refreshed as now, and a journal half, joined on every `read()` from memory. Then an escalation shows on the next poll instead of after the next GitHub refresh.

## Fog and out-of-scope lines

**Today.** `fogFacts` parses the `## Not yet specified` section of the map body into `[{ text }]`. It drops comments, sub-headings, and "None" or "empty" (`mapsnapshot.mjs:35-51`). Each map carries `fog` and `counts.fog` (`mapsnapshot.mjs:117`, `mapsnapshot.mjs:133-139`). Nothing reads `## Out of scope`.

**Gap.**

- Fog: none. The prototype also places each fog line in a phase (`ph`), but the map body has no such field. That's a layout choice, not a snapshot fact.
- Out of scope: the lines aren't carried. The wayfinder skill closes a ruled-out ticket and leaves one line under **Out of scope** that links it. So a ruled-out child sits in `walked` and counts toward "4 of 32 closed". The sub-issue list carries `state_reason`, and a ticket closed as `not_planned` would say so. All five closed children of #1017 read `completed`, and the skill doesn't ask for `not_planned`, so the reason alone can't be trusted.

**Cheapest source.** The map body, which `repoMaps` already returns. Parse `## Out of scope` with the same `sectionBounds` helper `fogFacts` uses (`daemon/src/resolve.mjs:76`), into `[{ text, tickets: [number] }]`. Mark each closed child whose URL a line names as out of scope, and leave it out of the closed count. No extra call is needed. The page header also shows the destination, which the snapshot doesn't carry. It comes from the `## Destination` section of the same body at no extra cost.

## A planning map's link to its build map

**Today.** Nothing. The snapshot treats every map as flat. No code or doc names a link between two maps. The prototype's split plans use a parent and child map (`index.html:486-500`).

**Gap.** The link in both directions. There's also a hazard in the obvious shape. A build map nested as a sub-issue of its planning map shows up in `mapFrontier` as an ordinary child. The snapshot counts it as a ticket of type `map`. `filterTakeable` has no label check (`github.mjs:290-296`), so the frontier offers it as takeable.

**Cheapest source.** GitHub sub-issues. The planning map's child list already holds the build map with its `wayfinder:map` label, so the downward link costs nothing. Each build map's parent is then the map whose list held it, which covers the upward link while the planning map is open. The issue list doesn't carry `parent_issue_url`. The daemon already works around this with `GET /issues/{n}/parent` (`github.mjs:78-94`). One such call per open map covers a closed planning map. GraphQL's `parent { number labels }` gives it in the same query as the edges. Whichever shape wins, the snapshot and `filterTakeable` must pull `wayfinder:map` children out of the ticket list. A convention like a `Build map: #N` line in Notes would also work at no call, but it's a second place to keep in sync, and GitHub can't enforce it.

## What changed since the operator last looked

The prototype lists seven kinds of change: resolved, new, unblocked, started, claim released, asks you, and asks for review (`index.html:559`).

**Today.** Each map carries `latest_event_at`, the newest journal stamp among its tickets, or the newest `updated_at` when the journal has none (`mapsnapshot.mjs:69-75`, `mapsnapshot.mjs:142-145`). The journal query reads only the latest event per ticket (`questions.mjs:404-450`). There's no last-look time anywhere.

**Gap.** A list of changes after a point, per map, and the point itself.

**Cheapest source.** Split by where each change happens:

| Change | Source | Cost |
| --- | --- | --- |
| Started | Journal `dispatch_claimed` or `agent_spawned` | Indexed read |
| Claim released | Journal `dispatch_unclaimed` | Indexed read |
| Asks you | Journal `esc_open` with a kind other than `review-gate` | Indexed read |
| Asks for review | Journal `esc_open` with kind `review-gate` | Indexed read |
| Resolved | `closed_at` on the child, from the sub-issue list | Already fetched |
| New | `created_at` on the child | Already fetched |
| Unblocked | The newest `closed_at` among a child's blockers, once none are open | Free with full edges |

The journal half is one new question beside `mapSnapshotFacts`: rows for the map's tickets with `id` after a watermark and `type` in that list. The `events_ticket_type (ticket, type, id)` index already serves it (`daemon/src/journal.mjs:90`). The GitHub half needs a timestamp, because GitHub changes have no journal id. `created_at` stands in for when a ticket joined the map. The exact time is a `sub_issue_added` event on the map's timeline. A live read of #1017's timeline shows `sub_issue_added`, `blocked_by_added`, `blocking_added`, and `parent_issue_added` events. GitHub's [issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types) page doesn't list them yet. That's one more call per map, and the page doesn't need it.

### Where the last-look time can live

The last look needs two values per operator and map: the journal `id` and the wall-clock time the operator last saw it. The operator is the `Tailscale-User-Login` that the identity check already stamps on every request (`daemon/src/identity.mjs:37`, `CONTEXT.md` **Identity check**).

- **Recommended: a journal event.** Record `map_seen { repo, map, operator, event_id }` when the operator opens a map or leaves it, at most once a minute per map. The reduction keeps the latest one per operator and map. ADR-0001 says GitHub is the only home for ticket state, and it keeps the journal as the record of Curia's own events (`docs/adr/0001-github-is-the-only-durable-state-home.md`). A view mark is a Curia event about the operator. It holds no ticket fact and never competes with GitHub, so it isn't a second state home. It survives restarts and backups, and it's the same on the phone and the desktop. The app sidecar holds no journal access, so it asks the daemon to record the event, the same way it sends actions today. At a few marks a day, each insert costs about 1.2 ms (`journal.mjs:20`).
- **Rejected: browser storage.** It needs no daemon change, but it's per device. The operator checks progress on the phone and works on the desktop, per the Notes on #1017, so each device would show different changes.
- **Rejected: GitHub.** Notification threads carry `last_read_at`, but those endpoints accept only classic personal access tokens ([Notifications](https://docs.github.com/en/rest/activity/notifications)), and ADR-0018 replaced every PAT with the Curia App. A comment or reaction on the map would write view state into the tracker for every reader.

## Open points for the build

- Whether GraphQL works under the Curia App installation token. The one-query graph depends on it. REST works either way at more calls.
- What the page calls a claimed ticket with no live session, when a person assigned it by hand.
- Whether `typeOf` should skip `wayfinder:deferred` and `wayfinder:map` when it picks a type.
- The `CONTEXT.md` entry for the **Maps screen** still describes the five-stage rail and changes when the page is built.
