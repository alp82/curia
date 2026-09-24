# ADR-0033: Discord is optional, and work needs only GitHub and a model

**Status**: accepted (2026-09). Not built yet. Supersedes the four required integrations of [Integration setup](../operator/integration-setup.md) and the four-card readiness of the Full-loop gate ([#880](https://github.com/alp82/curia/issues/880)).
**Provenance**: [Which product requirements belong in Curia's first-use path? (#1023)](https://github.com/alp82/curia/issues/1023), on [map #1017](https://github.com/alp82/curia/issues/1017).

## Context

Integration setup requires four integrations before any work starts: GitHub, Discord, Tailscale, and one AI login. Discord was required because it was the only conversation surface and the only phone alert. The redesign makes the app the conversation surface, with question cards, attachments, and full phone parity ([#1021](https://github.com/alp82/curia/issues/1021)). Tailscale already has to run on the host before `curia install`, so a setup card for it repeats a host prerequisite.

## Decision

- **The Work gate replaces the Full-loop gate.** Starting work needs GitHub and at least one AI login, both verified on the current read. Nothing else gates work.
- **GitHub stays required.** It's the only durable state home ([ADR-0001](0001-github-is-the-only-durable-state-home.md)). Once GitHub verifies, the app can read maps, tickets, and history before an AI login connects.
- **Discord is an optional integration.** Every question, answer, and attachment works in the app alone, and answers keep one identity across surfaces. Connected, Discord mirrors conversations and alerts the phone. A Discord failure degrades that integration and never blocks work.
- **Tailscale is an installation prerequisite, not a setup step.** `curia install` checks it, and the app shows the verified operator as a status fact. [ADR-0011](0011-tailscale-identity-in-front-of-every-attach-surface.md) is unchanged.
- **The Test run gates nothing.** Whether it stays in the first-use path is open on [#1024](https://github.com/alp82/curia/issues/1024).

## Consequences

- A new operator without Discord gets no phone alert when an agent waits. The app's **Needs you** group is the source of truth. Push alerts from the app are a later decision.
- An installation that already has Discord connected keeps its mirror and alerts, and its Discord settings move out of setup.
