# Landing page proof

**Settled**: 2026-08-02, in [Decide what proof of curia working goes on the page](https://github.com/alp82/curia/issues/114),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).
Every answer below came from the operator over Discord escalations.

This file names each proof element, its form, and who produces it. It sits under
[the positioning brief](positioning.md): the brief says what the page claims, this file says what
the page shows. The brief's banned moves apply here — no logo wall, no testimonials, no star count.

## The medium of every story scene

**Settled**: 2026-08-22, in [Choose the medium of every proof moment](https://github.com/alp82/curia/issues/601),
on the map [Ship the story landing page](https://github.com/alp82/curia/issues/600). The operator
answered one round of six questions, one per scene.

**Every story scene is built HTML. No scene shows a screenshot.** The six scenes that show curia
working are scenes 4 to 9 of [the storyboard](../../prototypes/landing-storyboard/NOTES.md): the
grilling, the preview, the app, the harness, one ticket from issue to merge, and the VPS. The
operator ruled all six the same way, in their own words: "we can build the whole thing in html.
as realistic as possible. that makes it easier to animate it".

Three rules follow from that round:

- **Build each scene as realistic as possible.** Realism is the defence against the mockup read.
  HTML is what lets a scene move with the scroll, stay sharp on every screen, and never go stale.
- **The content stays true.** The grilling question comes from a real escalation. The terminal
  types lines from a real transcript. The app carries real map names. A drawn scene with
  invented content is the fake proof the brief bans.
- **The screenshot list for the operator is empty.**
  [Capture the screenshots the story needs](https://github.com/alp82/curia/issues/602) has nothing
  to shoot, and the build ships no placeholder boxes for images.

The capture and redaction rules further down stay written, for any later page that does take a
screenshot. The story page uses none of them.

## Why the page carries proof at all

Failure mode one is a page that reads like every other agent landing page. The defence is showing
rather than claiming: three supporting claims, and under them a strip of a real ticket being done.

The operator chose pictures over text (Q1). A page proved only by links is words about words, which
runs straight into failure mode two.

## The four frames

**Dead for the story page.** The strip left the page at
[Grill the final landing page](https://github.com/alp82/curia/issues/550), and the medium ruling
above replaces the capture. The record below stays as the history of that decision.

**One ticket, four frames** — not one image per claim. The reader watches a thing get done rather
than reading four assertions. A frame-per-claim set was considered and turned down: it argues more
tightly but reads as a feature grid.

**Source: a real ticket on a repo other than `alp82/curia`.** `getalfredo/landing-page` or
`alp82/alperortac.com`, both already watched in `config/curia.yaml`. Photographing this map's own
tickets was the cheaper option and was rejected — a page that only proves it can build itself
answers the sceptic with nothing.

The four frames, in order:

1. The operator dispatches the ticket in a Discord thread.
2. The agent asks a question; the operator answers in the thread.
3. The preview link, opened on the phone.
4. The review gate, approved.

**Producer: the operator, on a phone.** Agents have no browser, so this is the one element on the
page nobody else can make.

**Redaction: the tailnet host, and nothing else.** Frame 3 shows a curia preview link, and those are
tailnet HTTPS URLs — publishing one hands out the machine's name on the network. The operator's
Discord handle, the server name, the repo and the ticket text stay visible on purpose: a
redacted-to-death screenshot proves nothing, and the frames have to feel real. **The blurring
happens at capture time.** An agent cannot judge what is still readable in an image.

**Delivery: Discord attachments on an `ask_human` answer.** The daemon downloads them to
`daemon/data/attachments/<esc-id>/`, and the answer reaches the agent with real image blocks. A
agent copies the files out of that directory into `docs/` and commits them; the directory sits
outside the worktree, so this is a read-then-copy, not a write. Two escalations have already carried
images this way. `MAX_FILES` in `daemon/src/attachments.mjs` is **4**, and `MAX_INBOUND_BYTES` is 5 MB
per file — the whole set fits one answer with nothing to spare.

**Placement: one strip, after the three claims, before the honesty block.** The reader learns why
they would want curia, sees it being done, then finds out what it costs. Distributing one frame per
claim was rejected for the same reason the frame-per-claim set was.

**Nothing blocks on the capture.** The prototype and the real build use grey placeholder boxes, and
the page goes live with them. The frames land in a later commit. The page is public with holes in
its proof strip for a while, and that was the operator's call over a ship date set by a camera roll.

## The pull-request trail

**Form: one line on the page, pointing at the merged pull requests on `alp82/curia`.**

This is the "curia built this page" proof the brief held back. It costs nothing, it is public, and
it updates itself. Every agent pull request ends with a block the daemon writes, not the agent:

> Dispatched by the curia daemon — session `curia-113`, model `opus`.
>
> Commits (read out of git by the daemon, not reported by the agent):

Four merged so far on this map — [#116](https://github.com/alp82/curia/pull/116),
[#128](https://github.com/alp82/curia/pull/128), [#129](https://github.com/alp82/curia/pull/129),
[#130](https://github.com/alp82/curia/pull/130) — each one an agent, each one merged after a review
gate the operator approved from a phone.

**Producer: an agent.** GitHub is the evidence; the page only points at it.

## The stats line

**Form: a short line of counts, split by where each number comes from, and dated.**

**Producer: an agent, regenerated whenever the page is touched.** Two sources, and they are not
equally durable:

**From GitHub — permanent, and the reader can re-derive them.**

```sh
gh pr list --repo alp82/curia --state merged --limit 200 --json number --jq length
gh issue list --repo alp82/curia --state closed --limit 200 --json number --jq length
git log --reverse --format=%ad --date=short | head -1     # first commit, for the age
grep -c 'repo:' config/curia.yaml                          # repos watched
```

**From the journal — only ever "since 1 Aug 2026".** The journal reaches back to
**2026-08-01T13:41:50Z** and no further. Everything before that is gone. Threads, sessions,
escalations answered and agents spawned come from here, and the line on the page must carry the
since-date rather than read as a lifetime total.

**An agent cannot count the journal.** It lives on the operator's box, outside the worktree, so the
journal half of the line is an `ask_human` call, not a command
([Polish the live page](https://github.com/alp82/curia/issues/137), 2026-08-05). Ask for the output
of these two, run in [the read-only shell](../../daemon/README.md#reading-the-journal):

```sql
select type,count(*) from events group by type order by 2 desc;
select json_extract(body,'$.kind') as kind,count(*) from events where type='esc_open' group by kind;
```

Then read the three numbers off them:

- **Agents spawned** — `agent_spawned`. The journal is append-only and every line written before the
  #184 rename says `worker_spawned`. `normalizeEvent` in `daemon/src/journal.mjs` rewrites the type
  on the way in, so the `type` column carries one spelling and already counts both. A count off
  `body` instead is short by every agent before the rename.
- **Questions asked** — `esc_open` minus the `review-gate` kind, because the gate is the third
  number and one thing gets counted once.
- **Review gates answered** — `review_answered`.

**The page says "answered", not "approved".** The journal records that the human answered the gate,
not which button they pressed, so the page claims the number it can count. The line said "approved"
until 2026-08-05.

**Tokens are not on the page.** The operator asked for them; curia never journals them. They exist
only in the harness's own transcripts, for Claude and not Codex, and only for projects
still on disk — the one number a reader could not check. **Handed to the production map
[#99](https://github.com/alp82/curia/issues/99): make the daemon journal token usage**, so a later
page can carry it honestly. That is a change to the daemon, so it belongs to #99's fog and not to
this map. Filing it is the operator's, not an agent's — this map's tickets cannot write to #99.

## What is deliberately not on the page

- **The eight-hour question.** The brief held back "a question stayed open almost 8 hours and
  resumed cleanly" and said `README.md` records it. It does not — the record is
  [the gateway crash live check](../live-checks/56-gateway-crash.md), and **the same file records
  the other half**: one `request_review` dropped after about 4 hours 22 minutes in that same run.
  The agent who wrote it says plainly it cannot tell which mechanism made the difference. Neither
  figure can be re-verified, because the journal no longer reaches 27 July. Carrying the eight hours
  alone is failure mode one, and it is a fact a reader can find in this repo in two clicks. Carrying
  both was offered; the operator dropped the number entirely and let the pull-request trail carry
  endurance instead.
- **The live-check records.** `docs/live-checks/` is the deepest proof in the repo and the page does
  not link it. Three hundred lines of internal detail, and the operator chose the pull-request trail
  and the stats line over it.
- **The two daemon restarts survived mid-pass.** Held back as proof by the brief; it lives in
  [the overseer rehearsal](../live-checks/96-overseer-rehearsal.md), which the page does not link.
  It stays where it already is — backing for claim 2 in the brief — and does not appear as page
  copy.

## Corrections this ticket makes to the positioning brief

- The eight-hour question is recorded in `docs/live-checks/56-gateway-crash.md`, not `README.md`.
- The brief's "Held back as proof, not claims" section is now resolved, and points here.
