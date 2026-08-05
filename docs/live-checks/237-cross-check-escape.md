# Live check 237: why #223 escaped the park

Ticket: [#237](https://github.com/alp82/curia/issues/237). Date: 2026-08-05. Box: `coinmatica.net`, journal `curia/daemon/data/events.jsonl`.

## The event order

The probe read the live journal for every #223 event. The order, with journal line numbers:

| Line | Time (UTC) | Event |
| --- | --- | --- |
| 1824 | 10:11:11.800 | `review_answered` on `esc-123`, `outcome: cross-check` — the 🔎 press |
| 1825 | 10:11:11.801 | `cross_check_requested` — the builder parks inside `request_review` |
| 1827 | 10:11:16.041 | `reviewer_spawned` — `curia-review-223` on `gpt` |
| 1832 | 10:11:30.224 | `reconcile` — **the daemon restarted** |
| 1843 | 10:13:35.082 | `review_requested` again, `esc_open` **esc-126** — a plain approve/reject gate |
| 1848 | 10:15:38.456 | `agent_blocked_on_human` with `cross_check: false` |
| 1850 | 10:17:00.193 | `review_answered`, `approved: true` — the operator approved esc-126 |
| 1853 | 10:18:33.430 | `result` from `curia-223` — merged, `merge_commit: cc81838` |
| 1855 | 10:18:35.880 | `ticket_resolved` |
| 1857 | 10:18:36.724 | `verdict_captured` — **3 seconds after the resolve** |
| 1859 | 10:18:39.856 | `agent_note` to instance `curia-223@adopted-1785924691772` |
| 1865 | 10:18:48.229 | `agent_notes_expired`, `count: 1` — the verdict note died unread |

## The cause

The daemon restarted 19 seconds after the press. The park is a process-scoped wait map, so it died with the daemon. The builder's client saw its MCP call fail and retried `request_review`. The restarted daemon held the re-adopted reviewer in its agents map and never asked it: it opened a plain gate with two buttons and no word that a second model was still reading. The operator approved, the merge ran, and the verdict landed 3 seconds too late. The note queued for the builder expired 9 seconds later, so the builder never read one finding.

The instance stamp `curia-223@adopted-1785924691772` on the note is the restart's own signature: 1785924691772 ms is 10:11:31 UTC, the reconcile that re-adopted the builder.

## The candidate holes, judged

- **The press raced an approval**: no. The press and the approval are two different escalations, 6 minutes apart.
- **The builder's gate call ended before the reviewer returned**: yes — the daemon restart at 10:11:30 severed it.
- **The reviewer was slow**: no. It returned in 7 minutes; the gate that mattered was already open at minute 2.

## What closed it

See the amendment on [ADR-0010](../adr/0010-the-cross-check.md): `request_review` re-parks on a live reviewer and refuses on an unjudged verdict, `report_result` is refused in both states before anything persists, the Stop hook names the duty, and a late verdict says TOO LATE instead of the neutral holding line.
