# ADR-0034: The app is a built React frontend

**Status**: accepted (2026-09). Decided, not built. Amends [ADR-0002](0002-thin-custom-daemon.md) for the app only: the app has a build step, and the daemon still has none.
**Provenance**: [Choose the frontend and component architecture for the accepted experience (#1025)](https://github.com/alp82/curia/issues/1025), on [Redesign the Curia app for agent work and roadmap planning (#1017)](https://github.com/alp82/curia/issues/1017).

## Context

The app is one hand-written `daemon/assets/dashboard.html` of about 7,000 lines, with no framework and no build. The sidecar serves it straight from the repository mount, and its tests run the inline script in a Node VM. [ADR-0002](0002-thin-custom-daemon.md) says "no build step".

The redesign is a new app, not a restyle. It has a conversation-led shell with a quiet sidebar and a phone drawer ([#1021](https://github.com/alp82/curia/issues/1021)), a dependency-graph Maps page ([#1022](https://github.com/alp82/curia/issues/1022)), and one Settings page with a first-use checklist ([#1024](https://github.com/alp82/curia/issues/1024)). The research on [#1019](https://github.com/alp82/curia/issues/1019) found that standard React components fit without changing the service, but need a build.

## Decision

- **The app is React 19, TypeScript, Vite, Tailwind 4, and shadcn/ui on Radix primitives.** It lives in its own package, `app/`, at the repository root. Accessible menus, dialogs, drawers, and popovers come from the primitives instead of being written by hand.
- **The dashboard image builds it.** A build stage in `deploy/dashboard/Dockerfile` runs `vite build`, and the `box` and `release` stages copy the output to a fixed image path. The sidecar serves the app from there and keeps its `proto` check against the built `index.html`. A source deploy stays `docker compose up -d --build dashboard`. Built output is never committed.
- **Curia owns the conversation components.** The parts of AI Elements the app needs are copied into `app/` and driven by Curia's own timeline store. assistant-ui's runtime is rejected, because first-answer-wins cards, shared drafts, composite sends, take-back, and timeline resets fit its model poorly.
- **The service is the only authority.** TanStack Query holds request-and-response data, a small reducer per open conversation consumes the timeline EventSource, and `localStorage` holds only view preferences. The sidecar's endpoints change freely with the page. Compatibility with the old page and old links is not a goal.
- **Routes are paths**, such as `/c/<key>`, `/maps/<owner>/<repo>/<n>`, and `/settings`. The sidecar serves the app shell for any unknown path. Old `#chat/` links aren't redirected.
- **The new app is built beside the old page, then cut over.** Slices merge to `main` and the sidecar serves the new app at a separate path. One pull request makes it the default and deletes `dashboard.html` and its VM tests. The terminal pages (`timeline.html` and the attach pages) are outside the redesign.
- **The accessibility bar is practical, not formal.** Phone-first usability, 44-pixel touch targets for primary actions, labeled controls, full keyboard use on desktop, and deliberate focus when navigation or the drawer changes. No audit tooling gates the cutover.
- **Tests are Vitest and a few Playwright journeys.** Vitest covers layout, reducers, and components. Playwright runs quick task, answer a card, open a map, and select a ticket, at phone and desktop width, against a fake sidecar. CI runs `npm test` in both `daemon/` and `app/`.

## Considered options

- **Preact or Lit with no build.** It keeps "pull plus restart", but every accessible primitive would be hand-written.
- **Split the current file into plain modules.** Cheapest now and most expensive over a new shell, graph, and Settings page.
- **Commit the built output.** Every frontend pull request would conflict on generated files while several agents work at once.
- **Replace screens inside the old page.** The sidebar, drawer, and status line span every screen, so there's no seam to replace one at a time.

## Consequences

- The app has a frontend dependency tree and a build to maintain. The daemon keeps neither.
- Graph rendering for the Maps page is still open between Curia's own layout and React Flow. [Choose between Curia's own layout and React Flow for the Maps graph](https://github.com/alp82/curia/issues/1034) decides it before the Maps page is built.
- AGENTS.md names both test suites as required once `app/` exists.
