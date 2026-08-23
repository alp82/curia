# ADR-0027: The daemon owns model credentials

**Status**: accepted (2026-08). Built for the codex consumer; the other two cut over on their own ticket.
**Provenance**: [Model credentials and provider-account failures (#641)](https://github.com/alp82/curia/issues/641), built by [Slice A1 (#642)](https://github.com/alp82/curia/issues/642) and measured by [#644](https://github.com/alp82/curia/issues/644). Amends [ADR-0007](0007-shared-credential-store.md) rule 1 and [ADR-0014](0014-the-overseer-in-its-own-container.md).

## Context

On August 23, 2026, two codex agents went silent at 06:37 UTC and stayed silent until a human asked about them at 11:30. The daemon reported both as healthy for five hours.

The credential had expired. Codex refreshed it over the network, exactly as it is supposed to, and the write-back failed with `Permission denied` because `workspace.mjs` seeds the container copy at mode `0400` on purpose. The server had already rotated the refresh token by the time the write failed, so the host store and both agents were stranded on one spent credential together. A later exchange of that token returned `refresh_token_reused`, which converts the account of the failure from inference to measurement.

`workspace.mjs` predicted this in as many words: "The bound this buys is one access-token lifetime: an agent that outlives a fresh token still dies on the same sequence."

ADR-0007 rule 1 is what left the bound in place. It says the daemon never writes the credential store, because a refresh rotates the refresh token server-side and every live session on the box holds the old one. That rule was written when the CLI owned the refresh lineage and the daemon was a reader. Under [ADR-0012](0012-one-container-per-worker.md) no agent can reach the store at all, so the CLI owns a lineage it cannot record, and the rule now protects nothing while costing the fleet.

## Decision

**The daemon owns every model credential. Agents hold leases the daemon refreshes. An agent never writes a credential.**

### Three consumers, not two

There are three model-credential consumers: codex agent containers, claude agent containers, and the overseer. The word is consumer, not harness, because the overseer is one and is not the other. A decision that covers two of the three makes this ADR's own claim false on the day it lands, so all three are named here and [#648](https://github.com/alp82/curia/issues/648) brings the second and third under it.

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

Session rules: the prefix is `curia-auth-`, one session per consumer enforced by the fixed name, completion detected by the credential file appearing in the scratch config dir, a 30-minute timeout comfortably past the code's own fifteen, and every outcome journaled. A re-authentication that silently vanished is the same class of bug as the credential that silently vanished.

**No sweep ever walks a `curia-auth-` session.** Not the liveness sweep, not the stall sweep, not reconcile, not the credential sweep, not the container sweep. The stall sweep in particular would find a pane with no transcript growth and type a continue message into a login prompt.

### The device code reaches one surface

The dashboard scrapes the link and the code off the pane and draws them as a card, because reading a code off a terminal on a phone at 3am is the experience this replaces. The card is an optimization over the terminal and never a replacement for it: when the scrape misses, it says so and points at the session.

Discord carries the alarm and a link to the dashboard. It never carries the code. A one-time auth code in a chat log is a credential in a chat log.

## Consequences

- ADR-0007 rule 1 is **amended, not withdrawn**. The daemon writes the credential store for the consumers it owns, and the rule's original reason survives as the `0400` bit: exactly one writer, and it is the daemon. The account-usage probe keeps reading under rules 2 and 3 unchanged.
- ADR-0007's narrowing for sandboxed agents said "nothing here writes a credential, and the container has no path back to the host store". The second half still holds and is now the point. The first half is superseded for the codex consumer.
- ADR-0014 gains a boundary it did not have. The overseer's model credential arrives through `.env.overseer` at container create, which means replacing it requires recreating the container. #648 moves it to a file the daemon writes.
- What happens when a refresh **fails** is deliberately not decided here. Distinguishing a spent token from a network blip needs evidence, and it is [#646](https://github.com/alp82/curia/issues/646).
- Freeze-versus-kill differs per consumer, and that is measurement rather than choice. A running codex process picks up a replaced `auth.json` with no restart, keeping its pane, claim, worktree, and conversation; it needs a nudge, because a turn that died leaves the agent idle at the composer. The claude lane cannot be healed this way at all, because `modelCredential` hands the container its credential as an environment variable and a running process's environment cannot be changed from outside.
- A new harness added with no credential story is how this bug returns. The per-consumer contract that refuses one is #648's, because the overseer is a consumer and not a harness, and the table it belongs in may no longer be keyed by harness alone.
