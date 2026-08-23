# 642: the codex re-authentication flow, end to end

**Status**: not yet run against this build. The shape it exercises was proved by hand on August 23, 2026 (see [644](644-credential-swap-heals.md) §1); what is unproved is curia driving it.

The device flow gets a live check rather than a test, and that is a decision. Proving it means completing a real login against a real OpenAI account, so nothing in `npm test` can assert it and nothing should pretend to. Everything around it is hermetic: the expiry arithmetic, the refresh margin, the exchange against an injected `fetchImpl`, the fan-out against a temp directory tree, and the four sweep refusals all run in `daemon/test/credentials.test.mjs` and `daemon/test/dispatch.test.mjs`.

## What to run

On the box, with at least one live codex agent so the fan-out has a target.

1. Type `reauth` in the curia channel. Expect a reply naming the session `curia-auth-openai` and carrying a terminal link.
2. Open the dashboard. The attention list should carry a card with the device link, the one-time code, and the session name.
3. Complete the login in a browser on a second device. Do not type anything into the terminal.
4. Watch the channel for the recovery line, which names how many live agents took the fresh credential.

## What to record

| Question | Why it matters |
|---|---|
| Did the card show a link and a code? | The scrape is a guess about codex's wording. A miss is not a failure of the flow, but it must degrade to "open the terminal" rather than to a blank card. |
| Did the daemon detect completion, and how long after the browser finished? | Completion is the credential file appearing in the scratch config dir, and it is checked once per dispatch tick, so up to 60 seconds is expected. |
| Is `<workspace_root>/home/.codex/auth.json` the new credential, at mode 0600? | The host store is written first, and the mode is restored explicitly. |
| Did every live codex agent's `auth.json` change, at mode 0400? | This is the fan-out, and 0400 is what keeps the agent from being the thing that rotates the credential. |
| Is the tmux session gone, the container gone, and `<workspace_root>/cfg/curia-auth-openai` removed? | The container carries no `curia.session` label on purpose, so no sweep collects it and the flow must tear it down itself. |
| Do the journal lines read `reauth_requested`, `reauth_started`, `reauth_code_seen`, `reauth_completed`? | And `reauth_code_seen` must carry no code. A one-time auth code in a journal is a credential in a journal. |

## The two cases worth forcing

**The timeout.** Start a `reauth` and walk away. After 30 minutes the session, the container, and the scratch dir should all be gone and `reauth_timed_out` should be in the journal. A re-authentication that silently vanished is the same class of bug as the credential that silently vanished.

**The nudge.** [#644](644-credential-swap-heals.md) §3 measured that a running codex process picks up a replaced `auth.json` with no restart, but it does not restart itself: a turn that died leaves the agent idle at the composer. So an agent healed by this flow may still need a nudge, which is rung 1 of #578's stall ladder. Record whether the healed agents moved on their own.

## What this check does not cover

The refresh itself. It fires once every 7.5 days on a 10-day token, so the first live evidence will be a `credential_refreshed` journal line rather than something anyone can schedule. Watch for it.

What happens when a refresh fails is [#646](https://github.com/alp82/curia/issues/646), and it is deliberately not built here.
