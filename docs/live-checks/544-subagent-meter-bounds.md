# Live check: the subagent meter and the subagent bounds (#544)

Ticket: [alp82/curia#544](https://github.com/alp82/curia/issues/544), on the map
[The UX map](https://github.com/alp82/curia/issues/511). Run on 2026-08-18, inside a dispatched
agent container, under curia's own config. Versions: claude-code 2.1.220 and codex-cli 0.146.0,
the versions `config/curia.yaml` pins.

The rig and the committed evidence are [prototypes/subagent-meter-bounds](../../prototypes/subagent-meter-bounds).
Two lanes, two methods.

- **Claude lane: fully live.** The dispatched claude agent for this ticket spawned a real subagent
  in its own session, then read its own transcript directory with the daemon's own
  `findTranscript` and `readTranscriptMeters`. Real model, real config, real quota.
- **Codex lane: real CLI, stub model.** An agent container holds no codex credential (the #447
  precedent), so a stub Responses API scripted the parent through `spawn_agent` and the child
  through one write outside the worktree. Every measured fact is mechanical: which files codex
  writes, what the daemon reads from them, what the child receives on the wire.

## Summary

**The meter misread is real on the codex lane and absent on the claude lane. The mechanism is not
the one #530 assumed. Both harnesses hand the standing orders to the spawned subagent, and neither
harness blocks a subagent write outside the bounds.**

| Question | claude 2.1.220 | codex 0.146.0 |
|---|---|---|
| Where do subagent usage lines land? | Own file: `projects/<proj>/<session>/subagents/agent-<id>.jsonl` | Own rollout in the same `sessions/` tree |
| In the parent transcript too? | No. Zero `isSidechain:true` lines there | No. Zero child `token_count` lines there |
| Does the daemon meter misread? | **No.** The walker never lists the subagent file | **Yes.** Newest-by-mtime picks the child rollout while the child runs |
| Standing orders reach the child? | Yes, the config-dir `CLAUDE.md` loads into the subagent | Yes, `$CODEX_HOME/AGENTS.md` is the child's first user message |
| Is an outside write blocked? | No. The write returned exit 0 | No. The write landed on disk |

## 1. The assumption behind the misread claim was wrong

#529 and #530 carried this sentence: claude writes subagent usage into the same transcript as
`isSidechain` lines, so a small subagent request that lands last would make `claudeTail`
under-report. The live run disproves the file layout. The parent transcript of this very session
holds 140 usage lines and not one has `isSidechain: true`. The subagent's nine usage lines all sit
in a separate file, `<cfg>/projects/-workspace/<sessionId>/subagents/agent-a02414b3394a09e65.jsonl`,
and every one of them has `isSidechain: true` (`out/claude-live/extract.json`).

## 2. Claude lane: no misread, measured with the daemon's own code

`claudeFiles` in `daemon/src/transcript.mjs` lists `projects/<proj>/*.jsonl` and nothing deeper.
The subagent file sits two levels deeper, so it is never a candidate. Measured live right after
the subagent finished: `findTranscript('claude', '/cfg')` picked the parent transcript, and
`readTranscriptMeters` reported 99,192 input tokens — the parent's own last request — while the
subagent's last line said 27,841. The operator's statusline observation in #530 was correct, and
so is the daemon meter. **No claude-lane fix is needed.**

## 3. Codex lane: the misread is real, and it is a file-pick fault

`spawn_agent` with `fork_turns: "none"` starts a second session. The child writes its own rollout
file into the same `sessions/<y>/<m>/<d>/` tree, and the parent rollout carries none of the
child's `token_count` lines (`out/s3/summary.json`). `codexTail` reads one file correctly. The
fault is one level up: `findTranscript` picks the newest rollout by mtime across the whole tree.
While the child runs, the child's file is the newest, so the meter reports the child's context.

The rig's poller sampled the daemon's own read four times a second (`out/s3/timeline.jsonl`). At
20:04:06.923 the pick was the child's rollout and the reported figure was the child's 2,222
tokens, while the parent stood at 111,111. The parent's next write flipped the pick back. In a
real delegation the parent waits for minutes, so the status line would show the child's small
context for that whole window — the misread #530 suspected, through a mechanism it did not.

The fix has a clean key. The child rollout's first line marks itself: `thread_source: "subagent"`,
a `parent_thread_id`, and the spawn path (`/root/probe_child`). A root session says
`thread_source: "user"`. So the meter can skip subagent rollouts in the walk, or pin the parent's
rollout by session id. That fix belongs to
[The delegation paragraph in the standing orders](https://github.com/alp82/curia/issues/545), per #530.

## 4. The collaboration tools sit behind an account-served flag

Under curia's shipped `multi_agent = false` and a stub provider, the collaboration namespace is
absent from the advertised tool set (run d1). #207 measured the same tools present on a live
agent on the operator's account, under the same config table. So the effective flag on the box
comes from the account side, and the local key only holds when nothing overrides it. The rig
writes `multi_agent = true` and `multi_agent_v2 = true` to reach the tools at all (run d2 lists
six: `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `interrupt_agent`,
`list_agents` — schemas in `out/d2/tools-extract.json`).

A wire detail for any re-run: codex addresses a namespaced tool with a `namespace` field beside
`name` on the `function_call` item. The dotted and the plain spelling both answer
`unsupported call` (runs s1, s2).

## 5. The bounds: the orders arrive, nothing enforces them

Both lanes hand the memory file to the child.

- **Claude:** the subagent quoted the standing-orders heading and the write-only rule back from
  its own context. The config-dir `CLAUDE.md` loads into a subagent exactly as into the parent.
- **Codex:** the child's first user message on the wire is the `# AGENTS.md instructions` block,
  sentinel included, even with `fork_turns: "none"` (`child_saw_orders_sentinel: true`).

Enforcement is another matter. The claude subagent, instructed to try, wrote a file outside
`/workspace` and got exit 0. The codex child's `exec_command` wrote outside its worktree with no
obstacle, as expected under `--dangerously-bypass-approvals-and-sandbox`. On both lanes the write
bounds bind exactly as they bind the parent: as prose the model obeys, plus the review gate.
The one hole a subagent adds is on the claude lane only in principle and on neither lane in
fact: the orders travel with the child.

## 6. Limits

1. The codex model was a stub. The run proves what the child receives and that no machinery
   blocks its writes. It cannot prove what a real codex model chooses to do with the orders.
2. The codex lane ran with `multi_agent` flipped on locally, because the stub provider serves no
   account flags. #207 proved the tools live on the real account, so the production file layout
   should match, but this run did not measure the live account.
3. The claude outside-write was instructed. It measures enforcement, not model inclination. The
   subagent in fact flagged the conflict with its orders unprompted, and deleted the probe file.

## 7. What follows for #545

1. No claude-lane meter change.
2. One codex-lane meter change: skip rollouts whose first line says `thread_source: "subagent"`
   in `codexFiles` or `findTranscript`, so the parent's rollout keeps the line while a child runs.
3. The bounds sentence in the delegation paragraph can state what is measured: the standing
   orders, bounds included, travel into every subagent on both harnesses, and the write bounds
   bind a subagent the same way they bind the parent.
