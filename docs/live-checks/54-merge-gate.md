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

- `open_pull_request` — called after the first commit. Returned one line:
  `opened https://github.com/alp82/curia/pull/61 — 1 commit pushed on curia/60. Next: request_review.`
  The return value itself named the next step. Called again after this pass; it updated the same
  pull request.
- `publish_preview` — not called. The change is one markdown file. There is no server to look at,
  and the pull request diff shows the file.
- `request_review` — called once so far. It blocked, then returned "NOT approved" with the
  human's words (quoted in section 3) and the loop instruction: fix, commit,
  `open_pull_request`, `request_review` again. The second call happens after this pass;
  its answer cannot land in the merged file.
- `report_result` — called last, after resolve. Its return lands after this file is frozen,
  so it can never appear here.

## 3. The gate

I called `request_review` with a short summary of this file and a charting proposal: no map
changes beyond the one Decisions-so-far line, because map #59 is a fixture. Per my orders,
curia showed the human the pull request, the ticket, and the proposed charting. The first
answer was a rejection, in the human's own words:

> Not yet. Section 4 must also say whether curia's Stop hook ever blocked your stop, and quote
> what it told you if it did. Add that, then ask again.

The tool result wrapped that text with its own instruction: do not merge, do not resolve,
commit, `open_pull_request` again, `request_review` again. This pass is that loop running.

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
- **The Stop hook never blocked me — and never could appear here if it did.** Up to the last
  commit, curia's Stop hook has not refused a stop, because I never tried to stop with a step
  outstanding: the blocking came from `request_review` itself, which holds the session open,
  not from the hook. So there is nothing to quote. And the hook's real territory — a stop
  attempted after the merge, with resolve steps missing — lies past the point where this file
  froze. The enforcement backstop is exactly the part of the ending a merged live check
  cannot witness.
- **Ordering trap I almost hit:** I nearly wrote section 2 with invented return values before
  calling anything. The honest version needs multiple commit passes, which the
  rejection-tolerant PR loop happens to support well.

## Live check 2: the planted skip

Ticket [alp82/curia#62](https://github.com/alp82/curia/issues/62) planted a protocol skip on
purpose. The orders: end the very first turn after one sentence, call no curia tool, change no
file. I did that. curia's Stop hook refused the stop. This is what it told me, verbatim:

> curia: this ticket is not finished. 2 steps outstanding:
> - call `request_review` and get an approval — nothing here is resolved until a human approves it
> - call `report_result` exactly once
>
> Do the next one, then stop again (nudge 1 of 3; after that curia stops holding you
> here and reports the ticket unfinished).

Two observations:

- The hook listed only the two curia tool calls as outstanding. It did not demand a commit or a
  pull request, because at that moment no file had changed. The gate tracks the tools, not the
  diff.
- The nudge counter ("nudge 1 of 3") sets a bound: the hook holds a worker at the ending three
  times, then lets go and reports the ticket unfinished. Enforcement is a backstop with a
  budget, not an infinite wall.
