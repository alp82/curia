# ADR-0029: Selectable harnesses satisfy one behavioral contract

**Status**: accepted (2026-08).
**Provenance**: [Define the contract for a selectable Curia harness](https://github.com/alp82/curia/issues/826), on [Decide whether OpenCode and Pi become selectable harnesses](https://github.com/alp82/curia/issues/825).

## Context

Curia selects claude and codex today. OpenCode and Pi also ship in the worker image, but routing cannot select them. Adding either program is not a routing-table change: harness behavior is spread across configuration seeding, standing orders, skill discovery, launch and resume commands, pane handling, transcript reading, Curia tools, completion enforcement, model switching, reasoning effort, and credentials.

Copying the current branches for each new program would turn accidental Claude and Codex details into the contract. Treating every difference as optional would create a weaker problem: a selectable agent that starts but cannot ask a question, resume safely, expose its history, or reach Curia's merge-gated ending.

## Decision

**A selectable harness proves one complete behavioral contract through one public Harness adapter. Native commands, files, and transcript formats may differ. Required outcomes do not.**

The Harness adapter owns the harness's configuration, launch, pane lifecycle, transcript, instruction, tool-channel, and completion behavior. Routing configuration selects an adapter and supplies operator-tunable values. It does not implement harness behavior.

### Required behavior

Every selectable harness provides all of these outcomes:

- An isolated, container-compatible configuration root and a declared model provider.
- A credential consumer that satisfies [ADR-0027](0027-the-daemon-owns-model-credentials.md). Provider-specific delivery, refresh, reauthentication, and healing remain separate decisions.
- Deterministic fresh launch and same-conversation resume.
- Durable standing orders and bounded skill discovery for every turn, without unbounded prompt duplication.
- Authenticated Curia tool access before the measured startup grace window ends.
- A completion gate that can force another turn until Curia's required review and resolution steps finish. A native Stop hook is one mechanism, not the contract.
- Detectable readiness, activity, stalls, process death, and safe composer input.
- Durable normalized transcript events for user, assistant, and tool activity. Malformed or unknown native events surface loudly instead of disappearing.
- Safe cross-harness fallback that preserves the ticket worktree and restates the required context. A saved conversation remains harness-bound.
- Refusal of repository configuration or skills that the harness would load automatically under Curia's authority.
- Automated conformance tests and recorded live evidence.

A program that misses any required outcome is not selectable. It may remain installed for experiments, but routing does not name it.

### Optional behavior

The adapter declares optional capabilities explicitly:

- Operator model switching.
- Explicit reasoning-effort control.
- Transcript-provided usage meters when a provider probe supplies equivalent routing evidence.
- Native skill invocation syntax when durable catalog discovery supplies the skill.
- Richer status or transcript metadata that no lifecycle safety decision reads.

Curia validates these declarations at daemon startup. It hides unavailable controls and refuses unsupported commands before sending pane input. Runtime discovery never changes the contract of a live harness.

### Public test seams

One shared conformance suite drives every adapter through injected filesystem, process, pane, transcript, and tool-channel seams. The suite asserts required outcomes rather than native representations. Harness-specific fixtures cover command rendering, file formats, pane classifiers, transcript parsing, and other native details.

The public adapter surface groups behavior by responsibility:

- Identity and setup: provider, configuration root, credential consumer, configuration seeding, connection settings, standing orders, and skills.
- Lifecycle: fresh command, resume command, readiness, process death, interruption, and safe pane messaging.
- Conversation evidence: transcript discovery, normalized events, activity, usage evidence, and unknown-event reporting.
- Curia control: authenticated tool-channel readiness and enforceable completion.
- Optional capabilities: declared support and the operation behind each supported capability.

### Live-check bar

Before routing can select a harness, the pinned command-line interface in the pinned worker image passes one containerized full-loop rehearsal. The rehearsal proves dispatch, readiness, Curia tools, a human question and answer, completion blocking, review, and resolution in one run.

Focused live checks also prove same-conversation resume, worktree preservation, tool-channel loss, process death, transcript shape, safe composer handling, and live credential replacement. The credential check follows the later provider and consumer design rather than assuming Claude or Codex behavior.

Each live record names the command-line interface version and worker-image version. A version change reruns the checks whose native contract may have changed. Automated tests remain necessary but cannot replace these checks because pane geometry, startup ordering, resume identity, credential reads, and tool behavior cross process boundaries that fixtures do not prove.

## Consequences

- Claude and Codex must pass the same contract during the adapter refactor. Their current behavior stays unchanged unless the shared contract requires a tested correction.
- OpenCode and Pi are judged independently. Installing a command-line interface or supporting reasoning effort does not earn a routing lane.
- Adding a harness costs one adapter, one conformance run, and measured live evidence instead of a growing set of untracked branches.
- Some harness-specific code remains. The boundary centralizes the difference; it does not pretend native behavior is identical.
