# ADR-0001: GitHub is the only durable state home

**Status**: accepted (2026-07)
**Provenance**: [Decide dispatcher shape and state home (#9)](https://github.com/alp82/curia/issues/9), [Decide the overseer's awareness source (#10)](https://github.com/alp82/curia/issues/10)

## Context

Curia needs awareness of every watched repo, map, and ticket, and that awareness must survive restarts. The alternatives were a local database (the hermes-agent kanban) and a long-running agent session that holds the picture in context. Both create a second writer that can drift from the tracker.

## Decision

- GitHub is the single source of truth for ticket state. The daemon holds no durable board of its own.
- The frontier is a native tracker query: open child of a map, no open blockers, no assignee. A claim is the assignee. Status is labels.
- The daemon is an always-on process, not a cron loop and not an agent. Dispatch is rules, not reasoning.
- The watch list is checked-in configuration in `config/curia.yaml`, not evolving state. Each watched repo names its lane.
- Read depth is a shallow poll. The daemon reads a ticket's full body only at dispatch.
- The journal (`daemon/data/events.jsonl`) is curia's one durable artifact. It holds curia's own events, append-only. Everything in memory is a reduction over GitHub, tmux, and the journal. Reconcile re-derives it at boot and on demand.

## Consequences

- Restart recovery is a re-query, not a restore. There is no local brain to lose.
- GitHub has no compare-and-swap on issue bodies. Concurrent map writes stay best-effort: detected, journaled verbatim, replayable, never prevented. See [ADR-0006](0006-worker-containment-and-standing-orders.md) for the worker-side convergence rule.
- The flat lane has no native blocking or ordering. Label presence is its only gate. Dependency-aware frontiers need a map.
- A whole-box reboot loses in-flight turns. The accepted recovery is re-dispatch, because the ticket is still on the tracker.
