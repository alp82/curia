# Live check: the thread-rename rate limit (#199)

Ticket: [alp82/curia#199](https://github.com/alp82/curia/issues/199), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 against the
real Discord API, with the daemon's own bot token, in the real guild. Two scratch threads in
`#curia`, created for the probe and deleted after it. No live thread was touched.

The ticket names a reported limit of 2 renames per 10 minutes per thread and says the number
decides the whole design. This check measures it instead of trusting it.

## The probe

The probe script does five things:

1. Create thread A and thread B in `#curia`.
2. PATCH thread A's name until a 429 lands, and record every `x-ratelimit-*` header.
3. PATCH thread B's name right after A is exhausted.
4. PATCH a non-name field (`rate_limit_per_user`) on the exhausted thread A.
5. Wait out `retry_after`, rename A once more, then delete both threads.

## The reading

```
A rename 1: 200  x-ratelimit-limit=10 remaining=9 reset-after=15.000 bucket=9852e1a5…
A rename 2: 200  x-ratelimit-limit=10 remaining=8 reset-after=13.084 bucket=9852e1a5…
A rename 3: 429  x-ratelimit-scope=shared retry-after=597
                 body={"message":"The resource is being rate limited.","retry_after":596.274,"global":false}
B rename 1: 200  remaining=9 — a fresh budget
A slowmode patch: 200  remaining=6 — the same visible bucket, no 429
A rename after wait: 200 — the budget came back
```

## What it settles

**The budget is 2 renames per thread per 10 minutes.** Two PATCHes passed and the third
got `retry_after: 596.274` about 4 seconds after the first spend. So the window is 600
seconds, counted from the first rename.

**The budget is invisible until it is spent.** The 429 landed while the visible bucket
reported 7 requests remaining. The limit is a hidden secondary limit with
`x-ratelimit-scope: shared`, and no header warns before the hit. A client cannot read this
budget. It must account for it itself.

**The budget is per thread.** Thread B renamed with a full budget at the moment thread A
was exhausted.

**The budget is name-specific.** A non-name PATCH on the exhausted thread returned 200.
Only the `name` field spends it.

**Creation does not spend it.** Thread A was created with a name, then took two renames
before the 429. A thread created with its final label keeps its full rename budget.

**The 429 is not global.** The body states `"global": false`, so the rest of the bot's
traffic does not stall.

## What the design takes from this

The `ThreadRenamer` gate (`daemon/src/threadname.mjs`) holds the two constants this check
measured: `RENAME_LIMIT = 2`, `RENAME_WINDOW_MS = 600000`. Because no header warns before
the hit, the gate keeps its own per-thread ledger and defers a rename that would cross it.
Because `retry_after` ran to the end of the 10-minute window, a hit costs up to 10 minutes
of wrong name — which is why the gate reserves the last slot for the rename that clears an
operator-blocked glyph, and never spends it to add one.

## Rerun

The probe script is not checked in. It is 90 lines against `discord.com/api/v10` with
`DISCORD_BOT_TOKEN` from `daemon/.env`: create two threads, PATCH names, read headers,
delete the threads. Rebuild it from the list above if the limit needs a re-measurement.
