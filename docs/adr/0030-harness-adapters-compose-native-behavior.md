# ADR-0030: Harness adapters compose native behavior

**Status**: accepted (2026-08).
**Provenance**: [Choose the integration shape for additional harnesses](https://github.com/alp82/curia/issues/829), on [Decide whether OpenCode and Pi become selectable harnesses](https://github.com/alp82/curia/issues/825).

## Context

[ADR-0029](0029-selectable-harnesses-satisfy-one-behavioral-contract.md) defines the outcomes that every Selectable harness must prove. Curia does not yet have the public Harness adapter that ADR requires.

Harness behavior currently lives in private tables and direct branches across routing, workspace setup, dispatch, transcripts, usage, and pane control. Adding another row to every table would scatter one Harness across the daemon. Moving every difference into one configuration row would instead hide native state machines behind unrelated callbacks.

## Decision

**A static registry returns one immutable, composed Harness adapter for each selectable Harness.** Routing selects a registered adapter and supplies operator-tunable model values. Routing configuration does not define native Harness behavior.

### The public adapter

Each adapter groups its contract into five facets:

- **Identity**: Harness name, provider, credential consumer, and configuration layout.
- **Setup**: repository refusal rules, configuration seeding, standing orders, skills, and the Curia connection.
- **Lifecycle**: fresh launch, same-conversation resume, readiness, process death, interruption, and native recovery.
- **Evidence**: transcript discovery, normalized events, activity, usage, and loud reporting of unknown native data.
- **Control**: completion enforcement and each supported operator action.

Adapters receive explicit agent context and injected filesystem, process, pane, transcript, and tool-channel ports. They hold no durable or hidden process state. The journal and existing runtime records remain the authority across daemon restarts.

Optional capabilities are declarations backed by operations. Startup rejects an adapter that declares support without an implementation. Shared command surfaces hide or refuse unsupported acts before Curia sends pane input.

### Shared services and native behavior

Shared Curia services own these invariants:

- Model routing and adapter lookup.
- Durable state and journal reduction.
- Provider credential refresh, holds, fan-out, and recovery under [ADR-0027](0027-the-daemon-owns-model-credentials.md).
- Worktree-preserving cross-Harness fallback.
- Conservative pane text delivery.
- Capability refusal and contract validation.
- Normalized lifecycle and transcript event types.

The conservative pane-send service keeps its unconditional pacing. An adapter supplies readiness evidence and owns explicit native interactions, including model switching, dialogs, rewind, and interruption.

Each adapter owns native configuration files, commands, classifiers, transcript parsing, tool-channel setup, completion enforcement, and supported optional operations. OpenCode controllers and Pi extensions are pinned adapter assets. The adapter plants and validates them, and repository content cannot replace or extend them.

Each adapter declares one provider and one credential consumer. Routing model rows reference the adapter instead of owning a conflicting provider answer. Supporting several providers through one adapter requires a later contract decision.

### Runtime identity and configuration roots

The journal names the adapter and the configuration-layout version for every spawn. Filesystem artifacts never determine a running agent's Harness identity.

New spawns use an isolated native root for each agent and Harness. Cross-Harness fallback preserves the worktree, then creates or reseeds the target adapter's root. It does not reuse native conversation state.

Existing journal records default to the legacy layout. Curia keeps an existing conversation on that layout and does not move its native files during an upgrade.

### Tests and migration

One conformance suite drives every adapter through injected ports and asserts observable contract outcomes. Native fixture suites test each adapter's commands, file formats, pane classifiers, transcript parser, and companion assets. The live-check bar from ADR-0029 remains unchanged.

Implementation follows this order:

1. Add the public interface, static registry, layout identity, and conformance harness.
2. Move Claude behind the interface without changing behavior.
3. Move Codex behind the interface without changing behavior.
4. Remove superseded private tables and central Harness branches.
5. Add OpenCode, then Pi, only after the existing adapters pass automated and live checks.

### Codex migration checks

The Codex extraction moves native code without changing the pinned command-line interface or worker image. Run these recorded checks again before treating the migrated adapter as deployable:

- Recheck container setup and credential delivery with [the Codex container check](../live-checks/158-codex-container.md) and [the credential replacement check](../live-checks/644-credential-swap-heals.md).
- Recheck bounded skills and tools with [the skill-root check](../live-checks/171-codex-skill-roots.md), [the feature-table check](../live-checks/207-codex-feature-table.md), and [the skill-arming check](../live-checks/399-codex-skill-arming.md).
- Recheck completion enforcement with [the Codex Stop-hook check](../live-checks/447-codex-stop-hook.md).
- Recheck pane and rollout behavior with [the attach-surface check](../live-checks/176-codex-attach-surfaces.md), [the tool-channel check](../live-checks/194-tool-channel.md), and [the session-memory check](../live-checks/360-codex-session-memory.md).
- Run the full-loop rehearsal from ADR-0029, including same-conversation resume and restart-based model switching.

Automated fixtures guard the extracted byte shapes. These live checks still guard process boundaries, terminal geometry, credential reads, and conversation identity.

## Considered options

- **One declarative row per Harness** was rejected because native lifecycle, completion, and recovery behavior are state machines, not configuration values.
- **Central branches by Harness name** were rejected because they reproduce the current scattering and make every new Harness change unrelated modules.
- **Dynamically configured adapters** were rejected because native behavior and companion code are trusted executable policy tied to the pinned worker image.

## Consequences

- Claude and Codex must cross the new boundary before Curia selects another Harness.
- Shared orchestration cannot branch on a Harness name after the relevant responsibility migrates.
- Native differences remain explicit and testable inside focused adapter modules.
- A command-line interface version change reruns its affected native fixtures and live checks without changing the shared conformance contract.
