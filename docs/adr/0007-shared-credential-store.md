# ADR-0007: Agents share the host credential store

**Status**: accepted (2026-07), extended (2026-08), corrected (2026-08), relocated (2026-08), amended (2026-08)
**Provenance**: [Share the host credential file with agents instead of copying it (#53)](https://github.com/alp82/curia/issues/53), [Status line shows model, effort, context %, and the usage bars (#146)](https://github.com/alp82/curia/issues/146), [The account usage bars have no source on the deployment box (#162)](https://github.com/alp82/curia/issues/162), [The compose mount paths stop being one box's paths (#473)](https://github.com/alp82/curia/issues/473), [The codex credential broker (#642)](https://github.com/alp82/curia/issues/642)

## Context

The daemon used to copy the host's credential file into each agent's config dir at spawn. The host session refreshes tokens in place, and the refresh rotates the refresh token server-side. Every agent then carried a dead snapshot, and a long human-in-the-loop block killed the agent on its next model turn. That failure is fatal under merge-gated resolution, where an agent waits hours on a review.

## Decision

Agents share the host credential store instead of holding a copy. An agent's config dir contains no credential file at all. The agent's environment keeps `CLAUDE_CONFIG_DIR` per-agent and points the secure-storage location at the host's `~/.claude`, so every agent rides the host's one refresh lineage.

The isolation of everything else is untouched: prompt, skills, settings, and harness stay per-agent. Only auth is shared, which is the one thing that should be.

## Consequences

- An agent survives any host-side refresh. Verified live: an agent blocked in `ask_human` across a forced token rotation resumed and completed model turns.
- The parked agent-auth watchdog is retired as mis-framed. There is nothing to watch once nothing is snapshotted.
- The refresh writes temp-then-rename, verified empirically. A symlinked credential file would have been silently replaced by a regular file, so the environment-level share is the durable form.
- The concurrent-refresh race stays parity with N host sessions on one machine. Argued, not exercised.

## Extension: the daemon reads the store, and never writes it (#146)

The status line's account usage bars have no per-agent source. The claude transcript states no rate limit anywhere, so the only source is the account usage endpoint the CLI itself polls, and reaching it needs the shared token.

The daemon may read that token. Three rules bound the read, and they apply to any future daemon-side use of the store:

1. **Read only.** The daemon never writes `.credentials.json` and never refreshes the token. A refresh rotates the refresh token server-side, and every live session on the box holds the old one. That is the exact failure ADR-0007 exists to prevent, pointed the other way.
2. **A refusal is terminal.** A 401 or 403 stops the daemon fetching until the credential file's mtime changes. The CLI owns the refresh lineage, so the daemon waits for it.
3. **The endpoint budget is shared.** The attempt stamp beside the usage cache is a cooperative lock. The operator's own status-line script writes the same two files under the same rules, so the two throttle each other and each one's fetch keeps the other fresh.

`usage.account_bars: false` in `config/curia.yaml` stops the daemon reaching the endpoint at all. The bars then show whatever reading is already cached on disk, and age.

Only the account bars need this. The model, the reasoning effort and the context percent come from the daemon's own records and the agent's own transcript.

## Correction: the credential store is not a usage source on a headless box (#162)

The extension above was built and verified against a workstation, where an interactive `claude /login` keeps `~/.claude/.credentials.json` current. The deployment box has no such file. It authenticates through `CLAUDE_CODE_OAUTH_TOKEN`, the `claude setup-token` credential [#100](https://github.com/alp82/curia/issues/100) chose, so the account bars never rendered there. That was a wrong reference machine, not a wrong idea.

**The cause is a scope, not a missing file.** `GET /api/oauth/usage` answers only a credential that carries `user:profile`. Measured against the live API: the setup token gets `403 OAuth token does not meet scope requirement any_of(user:profile, user:office)` on the sibling profile endpoint, and the usage endpoint refuses it exactly as it refuses a request carrying no credential at all. The same token authenticates `/v1/messages` without complaint, so the token is sound and the endpoint is out of reach. The CLI carries the matching guard: it polls that endpoint only when the stored scopes hold both `user:inference` and `user:profile`. That is why no agent config dir on the box has ever cached a reading.

**The source moves to the response headers.** Every accepted completion states the same two windows, as `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`. Measured side by side against the endpoint: identical percentages, identical reset instants. Every credential shape gets them, so one path serves a workstation, the deployment box, and a stranger's own VPS alike.

So the daemon takes one minimal completion for its headers, on the cheapest model, asking for one token. It uses whatever credential the box already authenticates with, in the CLI's own precedence order: `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then the stored credential. The three rules above still bind, with one amendment and one addition:

1. **Read only**, unchanged. A refusal is still terminal, but it is now keyed on a digest of the credential rather than the credential file's mtime. An environment variable has no mtime, and the value is the thing that actually changed.
2. **New: the headers are the reading, whatever the status code.** A window spent to its limit states itself on the rejection that proves it, and that is the moment the bars matter most.
3. **New: the probe spends account quota to measure account quota.** That is only honest at this size. One probe costs about two dozen tokens, at most one attempt per ten minutes and in practice one per thirty, against an agent turn that spends thousands. `usage.account_bars: false` stops it completely.
4. **The shared lock is unchanged**, and the cache file keeps the endpoint's own schema. A reading either fetcher takes serves both, so the operator's `statusline.sh` needs no change to benefit from a reading the daemon took.

### What this rules out

**Seeding the box's cache file from a workstation.** Curia must run on a server alone, and a stranger must be able to run it on their own VPS. A source that needs a second machine is not a source.

**Switching the box to a `claude /login` lineage.** It brings back the expiring access token that [#100](https://github.com/alp82/curia/issues/100) chose the setup token to avoid, and rule 1 forbids the daemon refreshing it.

## Narrowing: a sandboxed agent cannot share the store (#156)

A container denies the host HOME, and the store lives there. So an agent under [ADR-0012](0012-one-container-per-worker.md) gets the model credential COPIED into its environment through an env file, in the same precedence order the probe above uses: `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then the stored credential.

That is the frozen-credential shape this ADR exists to avoid, accepted knowingly and only this far:

- **The deployment box gives out a token that does not rotate.** It authenticates with `CLAUDE_CODE_OAUTH_TOKEN`, the `claude setup-token` credential of [#100](https://github.com/alp82/curia/issues/100), so a container holds a copy of a long-lived value rather than a snapshot of a rotating one.
- **A box on a rotating login is the case that breaks.** There the copy is an access token, and an agent outliving it dies mid-ticket exactly as [#53](https://github.com/alp82/curia/issues/53) described. The refusal is loud rather than silent: a dispatch with no credential to copy fails before the claim is spent.
- **Nothing here writes a credential.** Rule 1 of the extension above is unchanged, and the container has no path back to the host store to rotate anything.

The bare path keeps sharing the store. The two paths differ only while both exist.

## Relocation: the store is curia's own, not the operator's (#473)

Every word above says **host** store and means `~/.claude` of the user who runs the box. Under docker compose that is no longer where it is. `HOME` in every curia container is `home/` inside `dispatch.workspace_root`, so the store is `<workspace_root>/home/.claude`, and no container mounts a tree out of the operator's home. The compose file named one box's home directory on 34 lines, and a curia on another VPS had to reproduce it.

**The decision itself is untouched.** One store, one refresh lineage, shared by every pane agent and read by the daemon under the three rules. What moved is which directory holds it, and `os.homedir()` is what reads it, so no code here changed. A sandboxed agent is still narrowed out by #156, for the same reason: it mounts no home of any kind.

Two shared things stop being shared, and both were shared with the **operator**, never between agents:

- **The endpoint budget.** Rule 3 of the extension, and consequence 4 of the correction, say the attempt stamp is a cooperative lock the operator's own `statusline.sh` writes too. It reads `~/.claude/cache` and the daemon now reads `<workspace_root>/home/.claude/cache`, so the two no longer throttle each other and neither keeps the other fresh. The rules still bind the daemon against itself, and the probe's ceiling is unchanged. To share it again, point `statusline.sh` at curia's home.
- **The refresh lineage against a host `claude` session.** A pane agent rides curia's store, and an interactive session on the box rides the operator's. The #53 failure needs one lineage refreshed under another, and these two never touch, so neither can strand the other.

This is what curia being agnostic to one installation costs here, and it is the price of the box's own home not being curia's business.

## Amendment: the daemon owns model credentials now (#642, ADR-0027)

Rule 1 above says the daemon never writes the credential store. [ADR-0027](0027-the-daemon-owns-model-credentials.md) amends that for the consumers the daemon owns, and #642 built the first one.

The rule was written when the CLI owned the refresh lineage and the daemon was a reader. Under [ADR-0012](0012-one-container-per-worker.md) no agent can reach the store at all, so the CLI owns a lineage it cannot record. On August 23, 2026 that cost two agents five silent hours: codex refreshed over the network, the server rotated the refresh token, and the write-back died on the `0400` bit. Both the agent and the host store were left holding one spent token.

What the amendment keeps is the rule's own reason. There is still exactly one writer, and it is now the daemon rather than the CLI. The `0400` bit stays, and its job is unchanged: an agent must never be the thing that rotates this credential.

The account-usage probe of the extension and the correction above is untouched. It still reads, its refusal is still terminal, and it still writes nothing.

