# #240 — the thread says done while the prototype waits on the operator's first answer

Date: 2026-08-05. Box: `coinmatica.net`, live journal `curia/daemon/data/events.jsonl`.

## What the journal shows

The fault fired twice on one dispatch, `curia-98` at `alp82/aistack#98` (prototype):

```
13:17:10 esc_open   esc-133  "question 1 of 3: where does an owner enter the view numbers from?"
13:19:30 agent_done          hook_event: Stop, stop_hook_active: false
13:19:30 agent_blocked_on_human  escalations: ["esc-133"], awaiting_review: false
...
14:11:10 esc_open   esc-134  "question 2 of 3"
14:13:23 agent_done          hook_event: Stop
14:13:23 agent_blocked_on_human  escalations: ["esc-134"]
```

The agent was healthy and parked. It answered later questions (esc-134, esc-135, esc-136 all follow answers), pushed a branch, and reused its pull request. No `report_result` preceded either `agent_done` line.

## The diagnosis

`agent_done` is the Stop-hook webhook receipt. The hook fires when a TURN ends, and a turn ends parked on an open escalation as a matter of course (#47). The dispatcher judges the turn end and journals its verdict 9 ms later (`agent_blocked_on_human`). The status line was the one reader that took the receipt as the verdict: its `agent_done` case set the state to `done`, so the thread said `🏁 curia-98 · done` under the unanswered question.

The same read also rendered 🏁 for an agent that stopped WITHOUT a result (`agent_abnormal_exit`), while the notify beside it said the opposite.

## The fix

Read edge only (`statusline.mjs`). The writer keeps its receipt.

- `agent_done` no longer changes state.
- `lifecycle_closed` sets `done`. It is the dispatcher's own verdict that the ending ran, it carries the ticket, and it also covers reconcile's direct `onAgentDone` path, which never posts to `/agent_done` at all.
- `agent_blocked_on_human` redraws the parked line. Live this repeats what `esc_open` drew. After a restart it is the only event that redraws a parked line before the next nudge.
- `agent_abnormal_exit` / `reviewer_abnormal_exit` render `⚠️ stopped without a result — session kept for post-mortem`.

Replay is silent by construction (pinned by an existing test), so legacy `agent_done` lines never reach the status line.

## Not closed and said so

Nothing ran against the live daemon. The next parked turn end after a restart is the live check: the thread must keep its ⏳ line, and the 🏁 must arrive only with `lifecycle_closed`.
