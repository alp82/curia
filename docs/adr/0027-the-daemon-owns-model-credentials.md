# ADR-0027: The daemon owns model credentials

**Status**: accepted (2026-08). All three consumers are under it.
**Provenance**: [Model credentials and provider-account failures (#641)](https://github.com/alp82/curia/issues/641), built by [Slice A1 (#642)](https://github.com/alp82/curia/issues/642) and [Slice C1 (#648)](https://github.com/alp82/curia/issues/648), measured by [#644](https://github.com/alp82/curia/issues/644) and [#659](https://github.com/alp82/curia/issues/659). Amends [ADR-0007](0007-shared-credential-store.md) rule 1 and [ADR-0014](0014-the-overseer-in-its-own-container.md).

## Context

On August 23, 2026, two codex agents went silent at 06:37 UTC and stayed silent until a human asked about them at 11:30. The daemon reported both as healthy for five hours.

The credential had expired. Codex refreshed it over the network, exactly as it is supposed to, and the write-back failed with `Permission denied` because `workspace.mjs` seeds the container copy at mode `0400` on purpose. The server had already rotated the refresh token by the time the write failed, so the host store and both agents were stranded on one spent credential together. A later exchange of that token returned `refresh_token_reused`, which converts the account of the failure from inference to measurement.

`workspace.mjs` predicted this in as many words: "The bound this buys is one access-token lifetime: an agent that outlives a fresh token still dies on the same sequence."

ADR-0007 rule 1 is what left the bound in place. It says the daemon never writes the credential store, because a refresh rotates the refresh token server-side and every live session on the box holds the old one. That rule was written when the CLI owned the refresh lineage and the daemon was a reader. Under [ADR-0012](0012-one-container-per-worker.md) no agent can reach the store at all, so the CLI owns a lineage it cannot record, and the rule now protects nothing while costing the fleet.

## Decision

**The daemon owns every model credential. Agents hold leases the daemon refreshes. An agent never writes a credential.**

### Three consumers, not two

There are three model-credential consumers: codex agent containers, claude agent containers, and the overseer. The word is consumer, not harness, because the overseer is one and is not the other. A decision that covers two of the three makes this ADR's own claim false on the day it lands, so all three are named here, and [#648](https://github.com/alp82/curia/issues/648) brought the second and third under it.

### The store is keyed by provider, and the contract is two tables

The claude agent containers and the overseer run on one value from one account, so there are **two stores and three rows**. A store per consumer would be two copies of one token, two expiry answers free to disagree, and a re-authentication that healed one row and left the other stale. Codex's store stays at `~/.codex/auth.json` because that one is the CLI's own store and the CLI must read it; the anthropic store is a new daemon-owned file at `<workspace_root>/credentials/anthropic.json`, holding `{ token, obtained_at }`.

It is deliberately **not** `~/.claude/.credentials.json`. Writing curia's record into the CLI's own path would leave a host `claude` session reading a file it did not write in a shape it did not expect, which [ADR-0007](0007-shared-credential-store.md) already paid for once.

The contract this ADR left open is **two tables**, and neither is keyed by harness:

- **Provider**: `credentialExpiry`, `refresh`, `reauth`.
- **Consumer**: `provider`, `deliver`, `heal`.

What varies by provider — how a credential expires, whether it rotates, how you sign back in — and what varies by consumer — how it reaches them, what happens to a live one — are different axes. One table keyed on either writes the anthropic answer twice, which is how the claude row and the overseer row drift apart. `config.mjs` refuses a boot where a configured harness names a provider with no contract row, or a consumer declares no delivery.

### The anthropic lane declares `refresh: null`

A `claude /login` credential does have a refresh lineage: measured on the workstation on August 23, 2026, an `accessToken`, a `refreshToken`, an `expiresAt` 8.0 hours out and a `refreshTokenExpiresAt` 17.7 days out. So "no refresh path" is true of `setup-token`, not of the provider.

The `/login` shape is **refused anyway**. It hands every agent container a credential with the operator's full account scope, where a `setup-token` credential can only make model requests — visible in the authorize URL, which requests `scope=user:inference` alone. It also brings an undocumented file format, a rotating refresh token (this ADR's own trap, on a second lane), and a 17.7-day ceiling if the daemon is ever down that long.

So `refresh` is explicitly `null` on this lane, and **`null` is a statement rather than a gap**. Two consequences follow. The expiry column comes from a daemon-stamped `obtained_at` plus the documented one-year lifetime, labelled as an estimate from the docs rather than a date the token states — and a credential seeded from an env file carries no stamp, so its row reads `unknown`, which is the nudge to sign in once and get a real one. And what detects a dead credential here is the account-usage probe's 401, because that call already runs on this credential on this schedule and nothing new has to poll.

### Delivery is per consumer, and neither shape is an environment variable

An agent's claude credential is a **file in its own config dir**, `<cfgDir>/.credentials.json`, written at spawn and rewritten by the dispatch tick. Measured on the box in [#659](https://github.com/alp82/curia/issues/659): the CLI reads it in the sandboxed shape, a good file rescues a dead environment variable, and a dead file does not poison a good one. Three fields are load-bearing — `accessToken`, an `expiresAt` in the future, and a non-empty `scopes` — and a file missing any of them reads as no credential at all.

The overseer's is the **store itself, behind a read-only mount**, re-read per turn beside the checkout pass and the credential pass it already runs per turn. That is [#392](https://github.com/alp82/curia/issues/392)'s shape, in the same container, for the same reason. Not over the loopback turn body: a secret riding the request puts it in one more place. A turn in flight when the credential changes fails; the next one is correct.

The environment carries no model credential to any consumer now. That was the freeze itself — compose reads an env file at container **create**, so a refreshed credential could never reach a running process.

### The refresh clock is the token's own

The daemon refreshes when the access token is inside the last 25% of its life, computed from the `iat` and `exp` claims the server stamped on the token itself. A fraction, not a constant: the lifetime belongs to the provider, and this box does not negotiate it. The measured codex lifetime is exactly 10 days across two samples, so the margin is 2.5 days.

The dispatch tick is the clock. A deploy replaces the daemon at any moment, and the next tick re-derives everything from the file. Nothing is remembered across a restart because nothing needs to be.

### The write order is host store first, then live agents

The daemon writes the host store, then fans the result out to the config dirs of live agents. A crash between the two leaves the host correct and the agents stale, which the next tick repairs. The reverse order loses the rotation, which is the failure this ADR exists to end.

Both writes are a temp file plus a rename. Codex's own write is a truncating rewrite in place, and a refresh racing a read can be seen torn.

Live agents only, never every config dir. There were 245 directories under `cfg/` on the box the day this was written. A dead one holds nothing worth a live credential, and `removeCredentials` already sweeps them.

### The `0400` bit stays

Its reason was to stop the agent rotating the host token out from under the daemon, and a broker does not change that reason. The daemon restores the mode after every write. The bit that used to be the bug is now the bit that records who owns the rotation.

### Subscription only

No API-key path anywhere, not as a default and not as an escape hatch. `ANTHROPIC_API_KEY` and codex's `--with-api-key` are metered billing and are out. When a device flow will not complete, the recovery is to retry it. `sk-ant-oat...` is the subscription credential, not an API key, and the claude lane keeps using it.

### Re-authentication is a browser flow, never an ssh session

When there is no credential left to refresh, the daemon opens a `curia-auth-<consumer>` tmux session inside the existing tmux container and runs the consumer's own login command in it. The operator drives it through the ttyd attach surface already published over the tailnet. For codex that is `codex login --device-auth`, which prints a link and a one-time code that lives fifteen minutes, and needs nothing pasted back.

This was chosen over scraping a PTY and over reimplementing PKCE inside curia:

- No parsing contract with the CLI. A wording change upstream breaks nothing.
- No new auth story. ttyd runs writable behind Tailscale Serve, and the surface identifies the operator by Tailscale login ([ADR-0011](0011-tailscale-identity-in-front-of-every-attach-surface.md)).
- Phone-reachable, with no ssh.
- One mechanism for every consumer.

Session rules: the prefix is `curia-auth-`, one session per **provider** enforced by the fixed name, a 30-minute timeout comfortably past the code's own fifteen, and every outcome journaled. A re-authentication that silently vanished is the same class of bug as the credential that silently vanished.

The session is keyed by provider and not by consumer, which the codex lane's name said from the first commit while the code called it a consumer. [#660](https://github.com/alp82/curia/issues/660) made the word matter: one `anthropic` login serves the claude containers **and** the overseer, so there is no consumer to name.

### A restart does not end a login

The flow itself is process state, and it keeps no file, the same posture the credential hold takes. That left a daemon replaced mid-login with three faults at once ([#671](https://github.com/alp82/curia/issues/671)): a Credentials screen drawing no panel, a finished credential nobody adopted, and a session no sweep may walk, holding a window whose clock died with the process.

**The journal carries what a restart cannot re-derive**, the way [ADR-0015](0015-the-overseer-is-a-service.md) carries the overseer turn a restart kills: one `reauth_started` line, one terminal line, and the boot reads what is left between them. The next daemon re-adopts the login on its first poll, and boot reconcile runs that poll rather than leaving the panel blank for a tick.

**Only the clock comes back.** The session is named by its provider, the pane still holds the link and the code and is scraped again on the same tick, and the credential is wherever the login left it. So `startedAt` is the one fact the dead process was holding that nothing else can restate, and keeping it honest is what stops a login outliving its window twice over. A record curia cannot date is not resumed, and a session the journal never saw is still adopted, on a fresh window.

Nothing about the outcome is decided by the resume. The ordinary poll finishes it: adopted when the operator completed the login in the browser while curia was down, timed out when the window is spent, abandoned when the pane is gone. The session is the liveness and the record is not, so an open record whose session is gone never answers "already running" to an operator asking for a login.

### Completion is per lane, and only one lane has a file

This ADR originally stated one completion rule — the credential file appearing in the scratch config dir. That rule is **codex's**, not the mechanism's. [#659](https://github.com/alp82/curia/issues/659) measured that `claude setup-token` writes no credential file at all: it prints the token once, into a redrawing Ink TUI on stdout, and saves nothing. So the anthropic lane has nothing to detect by that rule, and its completion signal is **the token appearing in the pane**.

That means a parsing contract with the CLI's output, which the four reasons above were chosen to avoid. #660 accepted it under one condition, and the condition is what makes it safe: **curia asks Anthropic whether what it read is a working credential, and adopts only on a yes.** The contract is not avoided, it is made falsifiable. A wording change upstream, a layout change, or a misread frame ends the login as `failed` and leaves the store exactly as it was — where an unchecked scrape would write a broken token into the store and fan it out to every live claude agent.

Two measured facts shape the read, both on the box's own agent image:

- The token is a bare Ink `Text`, its own child of a bordered-less column with `gap: 1` — alone on its line, with a blank line either side.
- Ink hard-wraps at the pane width, emitting real newlines, so `tmux capture-pane -J` does not rejoin them and no tmux flag does. A 108-character token arrives in pieces on any pane narrower than itself, and something has to put it back together.

The three shapes #660 inherited resolved as follows. Redirecting stdout into the store is **dead**: everything goes to stdout, so the redirect hands the operator a blank pane. A stream-splitting wrapper and a pane scrape face the identical last step — picking the token out of a rendered frame — which makes the pane scrape the cheaper of the two rather than the last resort. Having the operator paste the token into the dashboard stays **refused**: a year-long credential through a browser and a request body is what the tmux surface exists to avoid.

**No sweep ever walks a `curia-auth-` session.** Not the liveness sweep, not the stall sweep, not reconcile, not the credential sweep, not the container sweep. The stall sweep in particular would find a pane with no transcript growth and type a continue message into a login prompt.

### The device code reaches one surface

The dashboard scrapes the link and the code off the pane and draws them as a card, because reading a code off a terminal on a phone at 3am is the experience this replaces. The card is an optimization over the terminal and never a replacement for it: when the scrape misses, it says so and points at the session.

The anthropic lane runs this the other way round. The operator does not read a code out of the pane; the browser shows one and they paste it **in**, into the writable terminal — curia cannot type it for them, because the pane write path refuses a `curia-auth-` session by name and that refusal is what stops the stall ladder typing into a login prompt. So the card carries the link alone and says what to do with the code rather than inventing one to display.

**The token that lane produces reaches no surface at all.** A device code is a fifteen-minute secret and the card is the one place it is allowed; a `setup-token` credential is good for a year. It goes from the pane to the store and appears in no card, no journal line, and no Discord message. The teardown is part of that: killing the session on the tick that adopts is what takes the last plaintext copy off the box.

Discord carries the alarm and a link to the dashboard. It never carries the code. A one-time auth code in a chat log is a credential in a chat log.

### A failed refresh is classified, and an unknown answer is never fatal

A refresh can fail because the token is spent or revoked, which needs a person, or because the network blipped, which needs a retry. `classifyRefreshFailure` returns `{ terminal, why }`, and `why` is journaled so a wrong call is arguable after the fact.

Terminal means HTTP 400 or 401 carrying `refresh_token_expired`, `refresh_token_reused`, or `refresh_token_invalidated`, or HTTP 400 carrying `invalid_grant`. The first three are codex's own vocabulary, and `refresh_token_reused` is the one measured on this account. Everything else is transient, including an unrecognized HTTP 401.

Codex itself treats any 401 as permanent, and curia deliberately does not copy that rule. The asymmetry is the design: a wrong transient call costs a few more minutes of an outage already under way, and a wrong terminal call cools a lane, freezes a fleet, and wakes the operator for a network blip. Five consecutive transient failures make a terminal call anyway, which at the dispatch tick is five minutes.

### A dead lane is held, and a hold has no reset instant

A terminal call holds the provider so nothing new spawns into a credential that cannot work. `Cooling` gains a third kind for it: a landed cap and a pre-emptive hold both end on a clock, and a credential hold ends when a person finishes a login.

Cooling to an invented far-future date was refused. `earliestReset` becomes "back at HH:MM" on the dashboard banner and in Discord `/status`, and a fabricated reset time on a credentials surface is the class of lie this whole ADR exists to remove.

The hold also latches the broker off the wire, because a dead refresh token does not resurrect and a per-minute retry writes a failure line every 60 seconds into the journal the operator will read to reconstruct the incident. It is not persisted: a restart clears it, the token is still inside its last quarter, and the next tick spends exactly one refresh to hear the same answer and re-arm. That costs one call and buys a hold derived from the provider rather than remembered from a file.

### Freeze means the stall ladder does not run

On the codex lane the agents are left alone: pane, claim, worktree, and conversation. This does not hold by itself. A turn that died leaves the agent idle at the composer, the stall sweep's pane check matches the ready prompt, and fifteen minutes later rung 1 nudges a credential that cannot work and rung 2 respawns, which kills the session. Freeze would silently become a kill half an hour after a failure whose whole design was to keep the agent.

So the stall sweep skips every agent whose provider is held, and journals it once per agent. Adoption then lifts the hold, the fan-out heals on that same tick, and the next sweep's rung 1 nudge is what finishes the recovery.

## Consequences

- ADR-0007 rule 1 is **amended, not withdrawn**. The daemon writes the credential store for the consumers it owns, and the rule's original reason survives as the `0400` bit: exactly one writer, and it is the daemon. The account-usage probe keeps reading under rules 2 and 3 unchanged.
- ADR-0007's narrowing for sandboxed agents said "nothing here writes a credential, and the container has no path back to the host store". The second half still holds and is now the point. The first half is superseded for the codex consumer.
- ADR-0014 gains a boundary it did not have. The overseer's model credential used to arrive through `.env.overseer` at container create, so replacing it meant recreating the container. #648 moved it to a file the daemon writes and that container mounts read-only. [#726](https://github.com/alp82/curia/issues/726) retired both environment seeds after browser re-authentication shipped. An absent store now requires `reauth anthropic`. Existing records with `seeded_at` remain readable.
- What happens when a refresh **fails** was deliberately left open here until the evidence existed. It is now decided above, by [#646](https://github.com/alp82/curia/issues/646), on the measurements in [#643](https://github.com/alp82/curia/issues/643) and [#644](https://github.com/alp82/curia/issues/644).
- Freeze-in-place works on **both** agent lanes, and that is measurement rather than choice. A running codex process picks up a replaced `auth.json` with no restart, keeping its pane, claim, worktree, and conversation. #646 recorded the claude lane as unreachable, which was an inference from `modelCredential` handing over an environment variable — and [#659](https://github.com/alp82/curia/issues/659) overturned it by measuring the other channel: writing a good `.credentials.json` into a running agent's already-mounted config dir heals it with no restart, **including an agent spawned before #648, with its expired variable still in its environment**. So no kill path was built, the fix reaches the agents that predate it, and both lanes need the same nudge afterwards, because a turn that died leaves the agent idle at the composer.
- A new harness added with no credential story is how this bug returns, and the two tables above are what refuse one at boot. `HARNESS` gained a `provider` row for the same reason it carries `memoryFile`: a new lane has to answer it.
- The re-authentication **flow** now covers both lanes ([#660](https://github.com/alp82/curia/issues/660)). One flow, one lane object per provider: the session naming, the window, the sweep guards, the teardown and the journal are shared, and only what to run, what the pane means, and what completion is vary. Growing a second flow would have made all five sweep guards re-earn themselves.
- **`reauth` takes a provider**, not a consumer, and bare still means `openai` — the one lane whose credential dies on a timer. The dashboard's own nudge names the provider with it, because two of the three rows are anthropic and a bare `reauth` on either would start the wrong login.
- This ADR's "no parsing contract with the CLI" holds for the codex lane and is **bought back** on the anthropic one, at the price of one HTTP call per completed login. The trade is stated above rather than buried: the alternative was no login flow on that lane at all, since `setup-token` is the only way to mint the credential the map keeps.
