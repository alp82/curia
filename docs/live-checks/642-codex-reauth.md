# 642: the codex re-authentication flow, end to end

Run on the box 2026-08-23, 14:40:49 to 14:56:09 UTC, against daemon `5be61f6` deployed the same minute. codex-cli 0.146.0.

[#644](644-credential-swap-heals.md) §1 proved the *shape* by hand: a named tmux session, `docker run` against the agent image, a device code needing no paste-back. What this check proves is curia driving it, with no ssh in the operator's half.

The device flow gets a live check rather than a test, and that is a decision. Proving it means completing a real login against a real OpenAI account, so nothing in `npm test` can assert it and nothing should pretend to. Everything around it is hermetic: the expiry arithmetic, the refresh margin, the exchange against an injected `fetchImpl`, the fan-out against a temp directory tree, and the five sweep refusals all run in `daemon/test/credentials.test.mjs` and `daemon/test/dispatch.test.mjs`.

## What ran

`POST /command {"text":"reauth"}` on loopback, which is the same canonical text the slash verb expands to. The reply came back in about 130 ms:

```
🔑 signing `openai` back in. Open the session and follow the two lines codex prints:
a link, then a one-time code that lives fifteen minutes. Nothing is pasted back.
The code is on the dashboard too, and never in this channel.
Terminal: https://<box>.ts.net:8443/?arg=curia-auth-openai
```

The agent image was already built, so `ensureAgentImage` was a no-op. A box whose image is missing pays the same four minutes a dispatch pays.

The pane printed codex's two steps, verbatim and unchanged from #644:

```
1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device
2. Enter this one-time code (expires in 15 minutes)
   88S2-THR9B
```

The operator opened the link on a second device and signed in. Nothing was typed into the terminal.

## What was measured

| Question | Answer |
|---|---|
| Did the card show a link and a code? | Yes, both. `GET /overview` carried `url`, `code`, `session`, and `seconds_left` counting down from 1800. |
| How long until the card filled in? | 20 s. The code reached the pane at about 14:40:52 and `reauth_code_seen` is stamped 14:41:09, so it is one dispatch tick and no more. |
| How long until completion was detected? | 29 s. The token states `iat` 14:55:40; `reauth_completed` is stamped 14:56:09. Again one tick. |
| Is the host store the new credential, at mode 0600? | Yes. `mode=600 owner=alp`, mtime 14:56:09, and the access token now expires 2026-09-02T14:55:40Z. |
| Is the tmux session gone? | Yes. Only `keeper` remains. |
| Is the container gone? | Yes. It carries no `curia.session` label, so no sweep would ever have collected it; the flow removed it. |
| Is the scratch config dir gone? | Yes. `~/curia-work/cfg/curia-auth-openai` no longer exists, so no live refresh token is left in a directory nothing sweeps. |
| Do the journal lines read right? | Four lines, in order: `reauth_requested`, `reauth_started`, `reauth_code_seen`, `reauth_completed` with `after_s: 920`. |
| Does any of them carry the code? | **No.** `reauth_code_seen` carries `consumer` and `session` and nothing else. |

## The adopted credential

```
keys:         auth_mode, OPENAI_API_KEY, tokens, last_refresh
token keys:   id_token, access_token, refresh_token, account_id
last_refresh: 2026-08-23T14:55:40.676486460Z
iat:          2026-08-23T14:55:40Z
exp:          2026-09-02T14:55:40Z
life_days:    10.000
plan:         prolite      account: 7c9992f3… (unchanged)
```

**A third sample of exactly ten days.** #644 measured two on this account, 2026-08-13 and 2026-08-23, both 10.000. The refresh margin is a fraction of that measured life rather than a constant, so this is the number the daemon now runs on: 2.5 days, and the first refresh falls due 2026-08-31.

**The `last_refresh` stamp carries nanoseconds**, which is codex's own Rust-written value and not curia's. That is the adoption path behaving correctly: `adopt()` writes the login's file verbatim and re-stamps nothing. Only `applyRefresh`, on the refresh path, writes a stamp of its own.

**The nudge case did not arise.** No agent was live, so the fan-out healed nobody and the recovery line read "No live agent needed it." Whether a healed agent moves on its own is still open, and #644 §3 says it does not: a turn that died leaves the agent idle at the composer, and that nudge is rung 1 of the stall ladder #651 landed.

## What this check still does not cover

- **A fan-out that WRITES.** Half of this is now measured; see below.
- **The refresh itself.** It fires once every 7.5 days on a 10-day token, so the first live evidence will be a `credential_refreshed` journal line on or about 2026-08-31 rather than something anyone can schedule.
- **The timeout.** Start a `reauth` and walk away; after 30 minutes the session, the container, and the scratch dir should all be gone and `reauth_timed_out` should be in the journal. Worth forcing, because a re-authentication that silently vanished is the same class of bug as the credential that silently vanished.
- **What happens when a refresh fails**, which is [#646](https://github.com/alp82/curia/issues/646) and deliberately not built here.

## Addendum: the fan-out against a live agent

`curia-647` was dispatched onto Slice B at 15:09 UTC, twelve minutes after the login above, which gave the fan-out its first real target.

```
host store          mode=600  3896 bytes  sha=253731725af7f7a8
cfg/curia-647       mode=400  3896 bytes  sha=253731725af7f7a8
identical: YES
credential_fanned_out rows: 0
```

**What this proves.** The two modes are correct and distinct: the host store the daemon owns at `0600`, the agent's lease at `0400`. The target selection reaches a live agent's config dir and reads the file that is there. And the content comparison holds: a byte-identical file is **not** rewritten, so a steady box does no disk writes at all and a `credential_fanned_out` line means "these agents just changed" rather than "this pass ran".

**What it does not prove.** No write happened, because the seed and the host store already agreed. Proving the write needs a rotation while an agent is live: either the refresh due about 2026-08-31, or a re-authentication completed with an agent running. Neither is worth forcing on its own.

