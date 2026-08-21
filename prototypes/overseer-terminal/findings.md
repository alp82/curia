# Overseer terminal facts

## Result

One live Claude pane costs about 154 MiB PSS before its first turn. One short turn raised the mean to 170 MiB PSS.

This cost stays while the conversation is idle. The current session chain keeps only a journal record and a transcript while idle.

An unbounded pane count does not fit the 8 GiB capacity budget in [the configuration](../../config/curia.yaml). Fifty fresh panes project to 7.5 GiB.

The [deployed box](../../docs/deploy.md) has 30 GB RAM and also runs the coinmatica stack. One hundred short-turn panes project to 16.6 GiB before shared services.

A daemon restart can leave a correctly hosted pane alive. A box restart destroys all live panes and needs transcript rehydration.

The pane can keep a conversation for weeks while its process stays alive. Transcript retention and compaction still limit its effective memory.

Keep the daemon verbs on HTTP MCP. Replace the current per-turn identity with a durable conversation identity.

Use the proved Claude rewind flow for take back. Keep Curia responsible for the floor, notes, receipts, and world-effect record.

## Direct measurements

The probe used Claude Code 2.1.220, tmux 3.3a, and Node.js 24.19.0. It started five detached interactive Claude panes.

The probe used the repository's local Anthropic stand-in. This removed network and model time from the startup measurement.

The probe measured process PSS after the composer appeared and the process settled. PSS shares common pages across the measured processes.

| Measure | Result |
| --- | ---: |
| Time to composer, mean | 2.239 seconds |
| Time to composer, range | 2.169 to 2.291 seconds |
| Fresh idle PSS, mean | 154.0 MiB per pane |
| PSS after one short turn, mean | 169.5 MiB per pane |
| tmux server PSS | 1.4 MiB for five panes |
| File descriptors | About 13 per pane |
| Threads | 15 to 18 per pane |
| First short transcript | About 10.5 KiB per conversation |

Idle CPU was low but not zero. Samples ranged from about 0.5 percent to 3 percent of one core per pane.

Terminal timers and the sample window changed the CPU result. Memory gives the more stable capacity limit.

The table below uses straight multiplication. It excludes the daemon, dashboard, container runtime, model traffic, and the coinmatica stack.

| Live panes | Fresh PSS | PSS after one short turn | Serialized startup |
| ---: | ---: | ---: | ---: |
| 10 | 1.50 GiB | 1.66 GiB | 22 seconds |
| 50 | 7.52 GiB | 8.28 GiB | 112 seconds |
| 100 | 15.04 GiB | 16.55 GiB | 224 seconds |

Parallel startup reduces wall time. It causes a simultaneous CPU and memory spike.

Each Discord thread or browser conversation adds this cost. Archived or idle conversations keep the cost unless Curia closes their panes.

[ADR-0016](../../docs/adr/0016-the-conversation-key.md) gives conversations no age limit and no count limit. A pane limit would change that contract.

## Session lifetime and compaction

Claude documents no maximum process lifetime. A pane can stay open for weeks while tmux, its container, and the box stay alive.

Process lifetime must not provide durability. Claude saves each session continuously and can resume it by its session identifier.

Claude deletes old session data after 30 days by default. The current Curia seed does not set `cleanupPeriodDays`.

The installed Claude version rejects zero for this setting. Curia needs a large retention value or Curia-managed transcript retention.

This issue exists in the current session chain too. It conflicts with the no-age-limit promise in [ADR-0016](../../docs/adr/0016-the-conversation-key.md).

Claude compacts a long context automatically. It first clears old tool output, then replaces older history with a generated summary.

Compaction is lossy. Early detailed instructions can disappear from the working context even though the JSONL transcript remains on disk.

The system prompt and root project instructions return after compaction. Path-scoped instructions return only after Claude reads a matching file again.

Invoked skills return with limits. Claude documents 5,000 tokens per skill and 25,000 tokens across all skills.

A weeks-long conversation can continue through repeated compactions. It does not retain every old detail in the active model context.

The current SDK path resumes the same Claude session, so it has the same compaction behavior. A pane does not remove this limit.

The current daemon builds a fresh checkout report for every turn. A pane needs a per-message prompt or hook for that changing report.

Primary Claude sources:

- [Session management](https://code.claude.com/docs/en/sessions)
- [Context windows and compaction](https://code.claude.com/docs/en/context-window)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Prompt caching and resumed sessions](https://code.claude.com/docs/en/prompt-caching)

## Restart behavior

| Event | Pane result | Current session-chain result |
| --- | --- | --- |
| Daemon process restart | A pane outside the daemon stays alive. An active MCP call fails. A later call can reach the new daemon. | The transcript and journal survive. Boot replay resends an eligible interrupted turn. |
| Routine Curia deploy | The tmux service stays alive. A pane inside the recreated overseer service dies. | The deploy recreates the overseer service. Boot replay uses the same limits. |
| tmux service recreation | Every tmux pane dies. | No effect on the overseer session chain. |
| Box restart | Every tmux pane and every `docker exec` process dies. | Docker restarts services. The transcript, session identifier, journal, and eligible replay survive. |

The [compose file](../../deploy/compose.yaml) recreates the daemon, dashboard, and overseer during routine deploys. It does not recreate tmux.

The [deployment guide](../../docs/deploy.md) confirms that a daemon restart leaves tmux panes alive. Current reconciliation re-adopts agent panes.

The pane design needs a new reconciliation rule for overseer panes.

A pane design needs a boot or first-use rehydration step. That step must start Claude with the journaled session identifier.

Without that step, a box restart loses every open conversational process. Disk data survives, but no live pane returns.

Rehydrating many panes at boot repeats their startup and memory cost together. Lazy rehydration avoids that spike but changes the meaning of live pane.

The current journal also controls replay for an interrupted turn. [ADR-0015](../../docs/adr/0015-the-overseer-is-a-service.md) defines those replay limits.

## Hosting constraint

The existing tmux container has the Docker socket, host networking, the full repository, and the full workspace mount.

Running the overseer Claude process directly there breaks the containment from [ADR-0014](../../docs/adr/0014-the-overseer-in-its-own-container.md).

Running Claude through `docker exec` in the shared overseer container keeps that containment. A routine overseer recreation kills every such process.

One container per pane can survive a shared overseer recreation. It restores the lifecycle and checkout costs rejected by ADR-0015.

Those costs include shared-checkout races or one private clone per conversation. [ADR-0012](../../docs/adr/0012-one-container-per-worker.md) describes the private-container model.

The current layout cannot provide containment, deploy survival, and one shared container at the same time.

## Daemon verbs from a pane

Keep HTTP MCP as the verb path. The existing endpoint exposes only the eight overseer schemas and composes canonical command text in the daemon.

Calling the general command endpoint would expose more verbs than the overseer catalog. It would also move schema control out of the daemon.

The current MCP registration is per turn. [`overseerclient.mjs`](../../daemon/src/overseerclient.mjs) stores its token and routing only in daemon memory.

A pane outlives one turn and can outlive one daemon process. The current token and callback closure cannot serve it.

Use one durable random token for each conversation pane. Store the secret in a protected file, as Curia does for agent tokens.

Store the conversation key and routing data in the journal.

Put the conversation key in the MCP URL. Put the token in the pane's MCP header configuration.

On each call, the daemon must validate the token and load current routing from the journal. It must not trust pane-supplied destination text.

The existing durable [agent token](../../daemon/src/agenttoken.mjs) proves this restart pattern. It survives daemon restarts and gates stateless HTTP MCP.

Delete or rotate a pane token when Curia deletes, replaces, or retires that pane. A durable token loses the current automatic turn-end expiry.

An MCP call in progress fails across a daemon restart. The current goodbye path can return an immediate error during a graceful restart.

Later stateless calls can reach the new daemon without a transport session. Claude must have connected successfully when the pane started.

The [first containerized dispatch check](../../docs/live-checks/185-first-containerized-dispatch.md) found no reconnect when MCP was unavailable at Claude startup.

The daemon must start before a pane, or pane rehydration must restart Claude after an initial MCP connection failure.

The daemon can keep its message lock. It types one operator message into the pane and waits for a matching completion signal.

The browser and Discord adapters can read answers through the existing [transcript parser](../../daemon/src/transcript.mjs). They need a new turn-completion signal.

## Take back through pane rewind

The [pane rewind proof](../pane-rewind/index.html) passed with Claude Code 2.1.220. It used the interactive rewind menu and a user-turn target.

The flow is:

1. If a turn runs, send one Escape key to interrupt it.
2. Send Escape twice to open rewind.
3. Select the target operator turn.
4. Select the conversation rewind action.
5. Clear Claude's prefilled old message with Control-C.
6. Prefill the dashboard composer with the old operator text.

Claude can offer turns below Curia's legal floor. Curia must enforce the first-message floor from [ADR-0023](../../docs/adr/0023-the-overseer-take-back-rides-the-session-chain.md).

Batch notes with the operator message. Rewinding that user turn then removes the notes from the Claude branch at the same boundary.

Curia must return those notes to the queue from its journal. Claude cannot restore Curia's note queue.

Claude rewind changes the active branch in the transcript. Curia must make later chat reads follow that branch.

World effects stay. Every completed daemon verb must remain journaled and must appear in the take-back receipt.

The daemon must not select tool results as landing points. [ADR-0021](../../docs/adr/0021-the-take-back-is-the-harness-rewind.md) defines this rule.

The pane should not keep the editable copy. The dashboard composer remains the one editable copy after the pane prefill clears.

This flow retires the overseer's journal-pointer rewind. It keeps the established rewind meaning and the world-effect boundary.

## Decision facts

- A pane removes the per-turn Claude process start, but it charges about 154 to 170 MiB during every idle period.
- Fifty live conversations use about 7.5 to 8.3 GiB before Curia's other services.
- A daemon restart is compatible with panes after Curia adds durable MCP identity.
- A box restart requires transcript rehydration. The current session chain already provides that recovery on the next turn.
- A weeks-long pane works, but compaction replaces old detail with summaries.
- The default 30-day transcript cleanup conflicts with Curia's no-age-limit promise.
- HTTP MCP remains the narrow verb boundary. Its identity and routing must move from turn memory to durable conversation state.
- Claude rewind supplies the take-back mechanism. Curia still supplies policy, receipts, notes, and world-effect truth.
- The current container layout has no pane location that supplies both overseer containment and routine-deploy survival.
