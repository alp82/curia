# Live check: the merge-gated ending (#54), as a worker experienced it

Ticket: [alp82/curia#60](https://github.com/alp82/curia/issues/60), on the disposable map
[#59](https://github.com/alp82/curia/issues/59). Written during the run, in passes: the file
must exist before the pull request, so each pass records what had happened up to its commit.

## 1. The ending

My standing orders gave these steps, in this order:

1. Commit locally on `curia/60`. Never push: curia pushes.
2. Call `open_pull_request` after any commit. Repeat calls update the same pull request.
3. Start a dev server and call `publish_preview` if there is something to look at.
4. Call `request_review` with a summary and a charting proposal. Block on the answer.
   On rejection: fix, commit, `open_pull_request`, `request_review` again. No loop limit.
5. Only after approval: `gh pr merge <url> --repo alp82/curia --squash --delete-branch`.
   This is the one write to the remote I own.
6. Then resolve the ticket: resolution comment, close, map line, approved charting, in that order.
7. Call `report_result` exactly once, and stop.

## 2. The tools

- `open_pull_request` — *(pass 2 records the return value here)*
- `publish_preview` — not called. The change is one markdown file. There is no server to look at,
  and the pull request diff shows the file.
- `request_review` — *(pass 2 or later records what came back)*
- `report_result` — called last, after resolve. Its return lands after this file is frozen,
  so it can never appear here.

## 3. The gate

*(written before the first answer; a later pass fills this in)*

I called `request_review` with a short summary of this file and a charting proposal of "none".
curia showed the human the pull request, the ticket, and the proposed charting.

## 4. What surprised me

- **The file freezes before the story ends.** The doc must be merged, but the approval that
  permits the merge arrives after the last commit the human approved. So the final approval,
  the merge, the resolve steps, and `report_result` can never be recorded in the merged file
  from direct experience. A live check of an ending cannot contain its own ending.
- **`request_review` is not `ask_human(approve-reject)`.** Issue #54 sketches the gate as
  `ask_human(approve-reject)`, but the standing orders and the MCP server give a dedicated
  `request_review` tool with a required `charting` field. The orders won; the sketch was stale.
- **The charting field forced a real answer.** Even on a fixture map, `request_review` requires
  concrete map changes or an explicit "none". A vague proposal is called out as a rubber stamp
  in the tool description itself. That is good pressure.
- **Ordering trap I almost hit:** I nearly wrote section 2 with invented return values before
  calling anything. The honest version needs multiple commit passes, which the
  rejection-tolerant PR loop happens to support well.
