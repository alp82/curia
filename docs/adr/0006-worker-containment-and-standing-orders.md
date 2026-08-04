# ADR-0006: Worker containment and standing orders

**Status**: accepted (2026-07), amended 2026-08 (#155, #159, #180)
**Provenance**: [Build preview-link allocation (#40)](https://github.com/alp82/curia/issues/40), [Close the loop: the worker resolves its ticket (#41)](https://github.com/alp82/curia/issues/41), [Align the worker's standing orders with the wayfinder skill (#49)](https://github.com/alp82/curia/issues/49), [Mint the scoped GitHub PAT and inject GH_TOKEN (#155)](https://github.com/alp82/curia/issues/155), [Per-worker token on the daemon loopback (#159)](https://github.com/alp82/curia/issues/159), [A worker reaches the operator's account connectors (#180)](https://github.com/alp82/curia/issues/180)

## Context

A dispatched worker holds `gh` and full read access, so its authority must be shaped, not assumed. The full-loop rehearsal exposed workers that rebuilt tools they already had, resolved before review, and never advanced the map.

## Decision

- The worker resolves its ticket in the tracker's own idiom with `gh`: resolution comment, close, one map pointer. The daemon verifies at `report_result` and repairs what is missing, marked as repairs.
- The daemon lands the code: it pushes `curia/<n>` and opens the one pull request. Workers never push. The base clone's push URL stays disabled.
- Standing orders supply parameters and bounds, not procedure. Procedure lives in the skill set curia symlinks into every worker's config dir, so a worker resolves in the same idiom as a hand session.
- Read is unbounded. The worker may zoom any issue, map, or closed ticket. Writes are bounded: the worktree, the ticket, the map subtree, nothing else on the tracker, and the assignee stays untouched.
- The worker has no browser and must not build one. The orders name the daemon's tools with one-line reach-for-it-when lines, because a tool manifest alone loses to a strong prior.
- The worker carries full charting authority, human-gated: fog graduation, new tickets, blocking edges, scope rulings. The proposal must be concrete in the gate text, or the approval is a rubber stamp.
- Preview ports are daemon-allocated. The registry refuses curia's own surfaces and requires a live listener, because "publish this port" is a privileged request.
- The evidence rule governs every read: a failed read is not evidence. Only a positive absent narrows a set. Every uncertain case fails toward keeping work.
- Bounds are standing orders, not controls, and the docs say so plainly.
- **Amended by [#155](https://github.com/alp82/curia/issues/155)**: the tracker half of "nothing else on the tracker" is now a control, not only an order. A worker reaches GitHub with a scoped fine-grained PAT as `GH_TOKEN` — one per resource owner, Contents/Issues/Pull requests read-write plus Commit statuses read — instead of the host's account-wide `gh` login. Read stays unbounded within those repos. Everything the token does not name is refused by GitHub rather than by a standing order.
- **Amended by [#159](https://github.com/alp82/curia/issues/159)**: a worker's own NAME is a control too. `/mcp` and `/worker_done` take the worker's name in a query param, and until #159 that name was the whole claim — anything that reached the daemon port could report a result for another worker, ask a question as it, or end its turn. The daemon now mints a secret per worker at spawn and delivers it in the harness (a header on the MCP server, the same header on the Stop hook's curl), refusing any call whose token does not match the name it claims. The container-facing listener carries those two routes and nothing else, so a container reaches neither `/command` nor `/answer`. The token is a header rather than an environment variable because a pane env rides tmux argv and lands in `ps`, which is the cost #155 measured.

- **Amended by [#180](https://github.com/alp82/curia/issues/180)**: a worker's TOOL SET is a control too, and it was never bounded. `CLAUDE_CONFIG_DIR` holds the #23/#29 line for every MCP server named in a config file. The operator's account-level claude.ai connectors are not named in one. Claude Code fetches them over the wire from the account behind the credential, which [ADR-0007](0007-shared-credential-store.md) shares with the host on purpose, so a worker listed 38 tools where curia configured six and could read and write the operator's Notion, Gmail, Drive and Calendar. The bound is two settings keys in the config dir curia already owns: `disableClaudeAiConnectors` stops the fetch, ahead of every auth branch in the CLI's own eligibility chain, and `allowedMcpServers` admits curia's server and nothing else whatever route another one arrives by. Neither touches the credential. The sandbox ([ADR-0012](0012-one-container-per-worker.md)) does not reach this at all: a connector call is ordinary outbound HTTPS, and the network is open by design.

## Consequences

- The daemon cannot verify the charting half. The review gate is the only control on it.
- Concurrent map writes converge worker-side by read, modify, write, re-read, redo. The daemon's map lock covers only its own repair writes.
- Every ticket type dispatches, HITL included, so HITL workers are the long-lived slot tenants.
- The one merge exception to "workers never push" is defined in [ADR-0008](0008-resolved-means-merged.md).
