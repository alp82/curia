# What the operator sees, from the alarm to a healed agent

A throwaway prototype for [#645](https://github.com/alp82/curia/issues/645), child of
[map #641](https://github.com/alp82/curia/issues/641). Canned state, no daemon, no network.

## The verdict

**B wins** (operator, 2026-08-23). C is not built: its takeover was covering the 3am phone
case, and B's flow panel already reads at 390 px without it. What C was really pointing at was
a defect in B, now fixed - see finding 6.

## The question

**What does the operator see and touch, from the Discord alarm to a healed agent?**

Three variants disagree about structure, not about colour. Flip between them and say which one
wins, or which parts of which.

## Running it

```
node build.mjs        # rebuild after editing pre.js / post.js / proto.css
```

Then open `index.html` in a browser. Nothing else to start.

The URL carries the state, so a view is shareable and survives a reload:

```
index.html?variant=B&step=2#credentials
```

- `variant` — `A`, `B` or `C`. Also the `◀ ▶` buttons, or the `←` / `→` keys.
- `step` — `0`–`5`, the six stops of the incident. Also the buttons in the rail, or `,` and `.`.
- `phone` — `1` frames the page at 390 px, which is where this actually gets used.

## What is real and what is canned

`build.mjs` reads the **real** `daemon/assets/dashboard.html` and injects three pieces into it.
So the shell, the nav, the tiles, the fleet table, the feed and the escalation card on every
screenshot are the shipped page, drawing canned data. Only the credentials surface is the
prototype's. That is deliberate: a credentials surface judged on a blank route always looks
fine, and this one has to survive the density it really lands in.

The wire shape is `credentialsStatus()` as it really answers (`daemon/src/dispatch.mjs:1768`),
and the base payload is lifted from `daemon/test/dashboardpage.test.mjs`, so the neighbours are
the ones the page's own test draws.

- `pre.js` — the canned incident and a stubbed `fetch`, injected **before** the page's script.
- `post.js` — the three variants and the prototype's chrome, appended **inside** the page's
  script so it can reach `SCREENS`, `NAMES`, `UI` and reassign the page's own functions.
- `proto.css` — the new atoms, built only from the page's own design tokens, so no variant can
  win by bringing its own palette.

## The six steps

The incident is the real one, from the map's own record.

1. **Quiet** — 7.4 days left, nothing said anywhere.
2. **The alarm** — the refresh is refused with `refresh_token_reused`, the lane is cooled, two
   live codex agents are frozen mid-ticket, and the operator is asleep.
3. **Signing in** — a `curia-auth-openai` session is up, the link and the code are scraped.
4. **The scrape missed** — same flow, both regexes found nothing. The card must degrade, never
   dead-end.
5. **Healed** — the credential is adopted and fanned out to both frozen agents on one tick.
6. **Timed out** — thirty minutes passed, nothing changed, and the page has to say so.

## The three variants

### A — Attention list (no new surface)

What slice A1 shipped, with its gaps closed. Cards at the top of Needs-you; no seventh screen.

- Cheapest to build, and one glance shows everything.
- The whole flow competes for column width with an open escalation and two dispatch holds.
- There is nowhere to look when nothing is wrong. `valid` and `expiring` are silent by design,
  so "when does this expire?" has no answer short of an incident.

### B — Credentials tab (a row per consumer)

A seventh screen: one row per consumer with state, expiry, last refresh, why and one action.
Needs-you keeps a one-line pointer into it, and the live login is a panel above the table.

- The only variant that answers "what is the state of all three?" — which is also what makes
  `unowned` legible instead of an absence.
- The Discord alarm links straight to `#credentials`, so the pointer costs a tap only for
  someone who came in through the front door.
- **Cost found while building:** the tile and the list header disagree — the tile reads
  `needsYou` (3) and the list header counts its own items (2), because B collapses N consumers
  into one pointer. Visible on step 2. Either the pointer names the number or `needsYou` counts
  pointers rather than consumers.

### C — Takeover (one flow, phone first) — not built

While a credential is dead or a login is running, a full-bleed sheet replaces the page: one
step at a time, a huge link target, a tap-to-copy code, a countdown. Always dismissible, and
Needs-you keeps a `reopen` line for anyone who dismissed it.

- The only variant that reads well at 390 px without pinch-zooming, which is where it is used.
- It takes the page over for a failure that is sometimes not urgent (`absent` on a fresh box).
- The page's own comment already argues for it: "while it is up nothing else on the box matters
  as much."

## Findings, independent of which variant wins

1. **The badge is cold on the one failure that most needs it hot.** `needsYou` is the nav badge,
   the tab title and the Home tile. It counts escalations, review gates, GitHub token warnings
   and dispatch holds — and not a dead model credential. By its own stated test ("whether an
   operator act ends it") a dead model credential is the strongest member of that set. All three
   variants count it; the real page does not.

2. **Nothing says what is broken behind the credential.** A dead credential is a fact about the
   box, not about a file: one lane stops dispatching and every live agent on it freezes
   mid-ticket. `pre_cooling` cannot carry it — that structure is usage-shaped, a window, a
   percent and a reset instant, and a credential cool has none of the three. The variants
   compose the sentence on the page; the wire needs a field.

3. **The feed has no prose for the credential events slice A1 journals.** `credential_refresh_failed`
   renders through the fallback as "credential refresh failed — —", because the fallback names an
   agent or a ticket subject and a credential event carries neither.

4. **The terminal link is named but never linked.** The shipped card tells the operator to open
   the terminal and gives them no way to. The link is composable — `attachSessionUrl(base, port,
   'curia-auth-openai')` — and it is the path that always works.

6. **B's table pushed its own action off a phone screen.** Found by looking, not by reasoning:
   at 390 px the six-column table did not wrap, it overflowed, and the last column is the one
   press. At the alarm step the Sign-in button was unreachable on the device the whole no-ssh
   requirement exists for. Fixed here by restacking each row as a card below 640 px, with the
   action full width at the bottom. This is the finding that retired variant C: the phone case
   is B's to carry, and it can.

5. **The claude paste-back has no path to this page.** `claude setup-token` waits on
   `Paste code here if prompted >`, and the page cannot type it: `sendText` and `sendKey` refuse
   a `curia-auth-` session outright, with no exception. `dispatch.mjs:490` already predicted
   this — "a consumer whose login needs a paste back gets its own explicit path here rather than
   a hole in this one". So #648 owes a deliberate `ReauthFlow`-owned write, or the claude lane
   sends the operator to ttyd for that one keystroke. No variant here invents a hole.

## The Discord copy

The alarm is #646's to send and does not exist yet. The recovery line does. Both are in
`pre.js` and render in the right-hand rail.

Two rules hold in every step: the one-time code never appears in Discord, and no surface
anywhere offers a field to type a credential into. Subscription only.

## The plumbing decision this owes slice C

See the resolution comment on #645.
