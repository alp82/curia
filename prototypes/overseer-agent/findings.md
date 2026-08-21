# The overseer and the agent

## Result

Curia still needs two roles. It does not need two chat runtimes.

The shared runtime can read a transcript, send one message, interrupt a turn, rewind, and report liveness.
The pane prototype proved these operations on an overseer pane without a second chat driver.
It also proved the same branch-read fix serves both chat types.
See [the pane findings](../overseer-pane/findings.md).

The roles stay different because they own different work, authority, identity, and lifetime.
An agent resolves one ticket under a guarded ending.
An overseer conversation interprets operator requests and can dispatch agents.
It has no ticket ending.
See [ADR-0015](../../docs/adr/0015-the-overseer-is-a-service.md) and [the agent ending](../../daemon/src/lifecycle.mjs).

Keep **overseer** and **agent** as separate domain terms.
Use a shared chat runtime as an implementation layer.
The chat runtime can be live in a pane or parked on disk.
An agent or an overseer conversation can own the chat runtime.
Neither role becomes the chat runtime.

```text
Chat surface
    |
shared chat runtime
    |-- agent
    `-- overseer conversation
```

## Essential differences and artifacts

“Essential” means the difference follows from a product contract or an authority boundary.
“Artifact” means the current implementation can remove the difference without changing either role.

| Area | Difference | Class | Finding |
| --- | --- | --- | --- |
| Dispatch | A ticket claim starts an agent. An operator message starts or resumes an overseer conversation. | Essential | The first action leases write authority and an agent slot. The second action addresses durable conversation memory. [Agent dispatch](../../daemon/src/dispatch.mjs), [ADR-0016](../../docs/adr/0016-the-conversation-key.md) |
| Lifecycle | An agent must reach its ticket ending. An overseer conversation has no timer, count limit, or required ending. | Essential | One lifecycle cannot govern both roles. [Agent ending](../../daemon/src/lifecycle.mjs), [ADR-0016](../../docs/adr/0016-the-conversation-key.md) |
| Process start | Curia spawns agents through tmux. Curia starts an overseer model for each turn. | Artifact | A pane can host both, and the same chat path can drive both. [ADR-0015](../../docs/adr/0015-the-overseer-is-a-service.md), [pane findings](../overseer-pane/findings.md) |
| Containment | An agent gets one writable clone. The overseer gets read-only mirrors of all watched repositories. | Essential | These mounts and GitHub grants express different authority. [ADR-0012](../../docs/adr/0012-one-container-per-worker.md), [ADR-0014](../../docs/adr/0014-the-overseer-in-its-own-container.md) |
| Hosting | Compose owns the overseer service. A tmux pane owns each agent container. | Artifact | A pane can execute inside the overseer container. Rehydration can handle service recreation. [ADR-0015](../../docs/adr/0015-the-overseer-is-a-service.md), [terminal findings](../overseer-terminal/findings.md) |
| Isolation count | Agents need one container each. Overseer conversations can share one container. | Essential | Agents have separate writable workspaces. Overseer conversations share the same read-only authority. [ADR-0012](../../docs/adr/0012-one-container-per-worker.md), [ADR-0015](../../docs/adr/0015-the-overseer-is-a-service.md) |
| Identity | An agent name identifies one agent session. A conversation key identifies memory, notes, and a turn lock. | Essential | A ticket thread can move from an overseer conversation to an agent and back. A shared record can wrap these typed identities. [ADR-0016](../../docs/adr/0016-the-conversation-key.md) |
| MCP authentication | Agent tokens survive daemon restarts. Overseer secrets currently last one turn. | Artifact | A pane overseer needs one durable token per conversation. The agent token pattern already proves restart-safe authentication. [Agent token](../../daemon/src/agenttoken.mjs), [overseer client](../../daemon/src/overseerclient.mjs), [terminal findings](../overseer-terminal/findings.md) |
| MCP catalog | Agents get lifecycle tools. The overseer gets orchestration verbs. | Essential | The catalogs grant different effects. A shared superset would weaken both boundaries. [Agent MCP server](../../daemon/src/index.mjs), [overseer verbs](../../daemon/src/overseerverbs.mjs) |
| MCP transport | The two catalogs use separate HTTP MCP routes and registration code. | Artifact | Both already use stateless HTTP MCP and the same token comparison. They can share transport and registration components. [Agent token](../../daemon/src/agenttoken.mjs), [overseer client](../../daemon/src/overseerclient.mjs) |
| Prompt content | An agent reads ticket bounds and an ending. The overseer reads command rules and read-only checkout rules. | Essential | The prompt content states each role's authority and work. [Agent prompt](../../daemon/src/workspace.mjs), [overseer prompt](../../daemon/src/overseerprompt.mjs) |
| Prompt delivery | Agent orders live in harness memory files. Overseer orders enter each SDK query as a system prompt. | Artifact | A pane can load either order set at spawn. The role selects the content. [Agent prompt](../../daemon/src/workspace.mjs), [overseer turn](../../daemon/src/overseerturn.mjs) |
| Per-turn context | The overseer must get a fresh checkout report before each turn. An agent does not need that report. | Essential | The overseer answers about changing repositories. Its checkout pass fetches every watched repository before the model runs. [ADR-0014](../../docs/adr/0014-the-overseer-in-its-own-container.md), [overseer turn](../../daemon/src/overseerturn.mjs) |
| Context injection | The current SDK constructor adds the checkout report. | Artifact | A pane needs a per-message prompt or hook instead. The report requirement stays. [Overseer prompt](../../daemon/src/overseerprompt.mjs), [terminal findings](../overseer-terminal/findings.md) |
| Conversation key | Overseer memory uses a Discord snowflake or `console-<n>`. Agent state uses a session name and dispatch epoch. | Essential | The conversation key must survive process parking and ticket takeover. [ADR-0016](../../docs/adr/0016-the-conversation-key.md), [agent dispatch](../../daemon/src/dispatch.mjs) |
| Transcript lookup | Agent chat uses its config directory. Overseer chat uses the session bound to its conversation key. | Artifact | A branch-aware reader can accept either resolved transcript path. Rewind then uses one read path. [Transcript reader](../../daemon/src/transcript.mjs), [pane findings](../overseer-pane/findings.md) |
| Idle cost | Active agents have the `max_concurrent` cap. Conversation count has no cap. | Essential | The budgets measure different promises. `max_concurrent` limits active work, not durable conversation memory. [Configuration](../../config/curia.yaml), [ADR-0016](../../docs/adr/0016-the-conversation-key.md) |
| Live pane cost | A pane pays memory while idle. The current overseer session chain pays no model-process memory between turns. | Artifact | This cost comes from keeping the process live. It does not come from overseer semantics. [Terminal findings](../overseer-terminal/findings.md) |
| Pane parking | Curia can stop an idle overseer pane and resume it on the next message. Curia keeps a blocked agent pane live. | Essential | An idle conversation has no open work. A blocked agent still owns a call, claim, workspace, and agent slot. [Terminal findings](../overseer-terminal/findings.md), [agent human block](../../daemon/src/dispatch.mjs) |

The current agent catalog has seven tools.
They are `notify`, `publish_preview`, `open_pull_request`, `request_review`, `ask_human`, `map_created`, and `report_result`.
See [the agent MCP server](../../daemon/src/index.mjs).

The current overseer catalog has eight verbs.
They are `tickets`, `next`, `status`, `start`, `map`, `cancel`, `resume`, and `attach`.
See [the overseer catalog](../../daemon/src/overseerverbs.mjs).

## The shared runtime

The chat runtime interface needs five operations.

1. Resolve the active transcript branch.
2. Send one bracketed message batch.
3. Interrupt the current turn.
4. Rewind to an allowed operator message.
5. Start, stop, and resume the process.

The pane prototype proves the first four operations.
The terminal research proves session rehydration supplies the fifth operation.
See [the pane findings](../overseer-pane/findings.md) and [the terminal findings](../overseer-terminal/findings.md).

The take-back policy can merge completely.
Both roles keep the first-message floor, immediate interrupt, active-branch read, and unchanged world effects.
The pane rewind replaces the overseer journal-pointer mechanism from ADR-0023.
Curia still restores queued notes and writes the receipt.
See [ADR-0023](../../docs/adr/0023-the-overseer-take-back-rides-the-session-chain.md) and [the pane findings](../overseer-pane/findings.md).

## Pane parking

A live overseer pane uses about 154 MiB before its first turn.
One short turn raises the mean to about 170 MiB.
Fifty live panes project to 7.5 through 8.3 GiB before other services.
See [the terminal measurements](../overseer-terminal/findings.md).

Curia cannot map every durable conversation to a permanent live pane.
ADR-0016 permits unlimited keys and no idle expiry.
Parking must therefore stop the process without ending the conversation.
The journal keeps the key, resume identifier, notes, and active transcript identity.
See [ADR-0016](../../docs/adr/0016-the-conversation-key.md) and [the overseer client](../../daemon/src/overseerclient.mjs).

Use lazy rehydration on the next operator message.
The measured composer startup mean is 2.239 seconds before model and network time.
This delay is the direct cost of parking.
See [the terminal measurements](../overseer-terminal/findings.md).

Do not count parked conversations in `max_concurrent`.
The build needs a separate limit for live overseer panes.
A least-recently-used policy is one option.
Parking must wait for an idle composer and no active rewind.
An in-flight turn keeps the existing replay and world-effect rules.
See [ADR-0015](../../docs/adr/0015-the-overseer-is-a-service.md) and [ADR-0023](../../docs/adr/0023-the-overseer-take-back-rides-the-session-chain.md).

## Final merge boundary

Merge the chat surface, pane driver, branch reader, rewind driver, process rehydration, and MCP transport.

Keep separate role policies for dispatch, endings, containment, authority, identity, prompts, verb catalogs, and capacity limits.

The overseer becomes a conversation that can own a pane.
It does not become an agent.
The agent still works one ticket and uses the same chat runtime.
