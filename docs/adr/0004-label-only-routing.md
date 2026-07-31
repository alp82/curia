# ADR-0004: Label-only routing and reactive cooling

**Status**: accepted (2026-07)
**Provenance**: [Define the model-routing rule (#13)](https://github.com/alp82/curia/issues/13)

## Context

Every dispatch picks a model, and subscription plans expose no clean remaining-quota API. The dispatch path is rules, not reasoning, per [ADR-0001](0001-github-is-the-only-durable-state-home.md), so classification cannot call a model and quota awareness cannot scrape dashboards.

## Decision

- The classification signal is labels only. A `model:<x>` label is an absolute override. Otherwise the `wayfinder:<type>` label indexes a default table: grilling and prototype get the top tier, research burns the OpenAI quota, task and untyped tickets get the mid tier.
- Quota awareness is reactive, not proactive. A usage-limit error at spawn marks the provider account cooling until the error's stated reset. A model-specific cap cools only that model.
- Fallback chains are config data. A fallback never upgrades bulk AFK work onto the scarcest top-tier budget.
- When every candidate model cools, the frontier is the queue. Tickets stay open and unassigned on GitHub. One in-memory wake timer fires at the earliest reset. Exactly one Discord notify reports the exhaustion event.
- The table, the chains, and the provider grouping live in `config/routing.yaml`. Re-tuning is a git commit.

## Consequences

- The first ticket after an exhaustion eats one failed spawn before the fallback. Accepted.
- Cooling state is an in-memory cache. A restart re-learns it.
- A local retry queue is rejected. It would be the two-writer drift [ADR-0001](0001-github-is-the-only-durable-state-home.md) exists to avoid.
- A small classifier as a routing leaf is a possible later upgrade and changes nothing architecturally.
