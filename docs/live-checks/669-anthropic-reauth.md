# 669: the anthropic re-authentication flow, end to end

Run on the box 2026-08-24, 21:07:51 to 21:31:50 UTC, against daemon `0695b5e`. Claude Code 2.1.220, agent image `curia-agent:2.1.220-0.146.0-7cba0f7a`.

This is [#642](642-codex-reauth.md)'s counterpart on the second lane. [Slice C2](https://github.com/alp82/curia/issues/660) built the flow on a measured *renderer* - the `setup-token` success state read out of the box's own agent image - and on a wrap measured on a real 60-column pane. It had never seen a frame from a login that finished, and [#660](660-setup-token-frame.md) says so rather than implying coverage. This check is that frame.

It could not be run against a manufactured failure. The credential it produces is real and adopting it replaced the box's own, which is why it needed an operator at a browser and a deliberate decision to mint a year-long token.

## What ran

`POST /command {"text":"reauth anthropic","by":"alp82"}` on loopback. The reply came back inside a second:

```
🔑 signing `anthropic` back in. Open the session, follow the link, and paste the code the
browser shows back into the same terminal. curia takes the token from there; it never
appears in this channel.
The link is on the dashboard too. The code you paste, and the token that comes back,
never reach this channel.
Terminal: https://<box>.ts.net:8443/?arg=curia-auth-anthropic
```

The operator opened the ttyd terminal, signed in at the printed URL in a browser, and pasted the code into the pane. That paste is the step no agent can take: `sendText` refuses a `curia-auth-` session by name, so on this lane the attach surface's writability is load-bearing rather than a convenience. ttyd runs with `-W`.

## What was measured

| Question | Answer |
|---|---|
| Did the card show a link, and no code? | Yes. `url` filled, `code: null`, `typed: true`, `seconds_left` counting from 1800. |
| How long until the card filled in? | ~67 s, two dispatch ticks. #642's codex counterpart took one. |
| Did the token come off a real completed frame? | Yes, and the frame matched the renderer read in C2 line for line. |
| Did the verification gate pass on a real token? | Yes. Adoption happened, and adoption is conditional on a `200`. |
| Is the store the new credential, at mode 0600? | Yes. `-rw------- alp alp`, mtime 21:31, `obtained_at: 2026-08-24T21:31:50.969Z`, `seeded_at: null`. |
| Do the rows carry a date now? | Yes. Both anthropic rows went `unknown` / `null` to `valid` / `2027-08-24T21:31:50.969Z`. |
| Did the teardown take the plaintext copy off the box? | Yes. Session, container, and `cfg/curia-auth-anthropic` all gone on the adopting tick. |
| Did any surface carry the token? | No. It exists in exactly two files on the whole box, both of them intended. |
| Did the fan-out reach a live claude agent? | Yes, `curia-629`, byte-identical to the store. |
| Did the overseer's next turn run without a restart? | Yes. |

## The completed frame

Captured every two seconds from the start, so the teardown could not take it. Token characters replaced with `#`; the frame is shredded.

```
18 len= 56 | ✓ Long-lived authentication token created successfully!
19 len=  0 |
20 len= 37 | Your OAuth token (valid for 1 year):
21 len=  0 |
22 len=109 | ############################################################################################################
23 len=  0 |
24 len= 62 | Store this token securely. You won't be able to see it again.
25 len=  0 |
26 len= 66 | Use this token by setting: export #######################=<token>
```

Every claim C2 made from the renderer holds against the render: a bare `Text` alone on its line, a blank line either side, no border and no prefix, both lines beneath containing spaces, and the last holding the literal `<token>` rather than the value. The token is 108 characters, the number #648 took from the docs, and the screen states the one-year lifetime itself.

### The wrapped token is still unmeasured, and the URL is not

The one thing this run did **not** prove. `joinWrapped` exists because Ink hard-wraps at the pane width and `capture-pane -J` cannot undo it, and tmux sizes a window to its smallest attached client - so the operator's own terminal sets how many pieces the token arrives in.

The operator's client was **116 columns**, so the 108-character token printed on one line and the reassembly had nothing to do. The run sheet asked for a phone precisely to avoid this, and a desktop-width client is what actually ran.

What did get measured is the same mechanism on a different string. Before anyone attached, the pane was 80 columns and the login URL arrived in **five** wrapped pieces:

```
https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88
ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co
m%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=f-ElrpijWqEKyw
znmZfTKr6ucSUp86KshoIFwZN28NI&code_challenge_method=S256&state=txeA_zu34XxgW2B7z
s7NiSUq7HG936ldxjuT69Oh9zw
```

The card's `url` is that string rejoined, byte-correct across all five pieces. So the wrapping is real, it happens at exactly the pane width, and the rejoin works on a five-piece value from a live pane - just not yet on the token itself.

## The journal says three lines, not four, and that is right

```
{"ts":"2026-08-24T21:07:51.841Z","type":"reauth_requested","provider":"anthropic","session":"curia-auth-anthropic","by":"alp82"}
{"ts":"2026-08-24T21:07:51.791Z","type":"reauth_started","provider":"anthropic","session":"curia-auth-anthropic"}
{"ts":"2026-08-24T21:31:50.970Z","type":"credential_adopted","provider":"anthropic","obtained_at":"2026-08-24T21:31:50.969Z"}
{"ts":"2026-08-24T21:31:50.975Z","type":"reauth_completed","provider":"anthropic","session":"curia-auth-anthropic","after_s":1439,"expires_at":"2027-08-24T21:31:50.969Z"}
{"ts":"2026-08-24T21:31:50.995Z","type":"credential_fanned_out","consumer":"claude","provider":"anthropic","agents":["curia-629"]}
```

The ticket expected a `reauth_code_seen` by analogy with the codex lane. There is none, and there should be none: on this lane the operator types the code and curia never sees it. `typed: true` on the card is the same fact said to the dashboard.

Nothing carries the token. Grepping the adopted value across `daemon/data` and all of `curia-work` returns exactly two files - `credentials/anthropic.json` and the one live agent's config - and zero hits in `events.db`, its WAL, and the command reply. The bar on this lane was that **no** surface may carry it, higher than the codex lane's fifteen-minute device code, and it holds.

## The fan-out, and the overseer

`curia-629` was the only live claude agent at adoption. Its file was rewritten in the same 25 ms as the adoption:

```json
{"claudeAiOauth": {"accessToken": "<token>", "expiresAt": 1819143110969, "scopes": ["user:inference"]}}
```

`0600`, token byte-identical to the store, and the three fields #648 measured as load-bearing. This is a heal rather than a seed: the credential changed under a running agent.

The overseer needs nothing pushed at it - it re-reads the store per turn - so what there was to confirm is that its next turn runs on the new credential without a restart. A `status` at **21:43:28** ended `ok: true` nine seconds later, twelve minutes after adoption, with the container up seven hours and never restarted.

## What the run leaves behind

- **The adopted token stays**, as decided on the ticket before the run. A `setup-token` credential does not revoke the one it replaces, and adoption is the only thing that can ever give the row a date.
- **`CLAUDE_CODE_OAUTH_TOKEN` in `daemon/.env.daemon` is now a live year-long credential that nothing reads.** C1 reads the env exactly once, to seed an absent store, and the store is no longer absent. Leaving it is a plaintext credential no surface accounts for; removing it takes away the seed path's fallback if the store is ever lost. A separate call.
- **The wrapped token remains unmeasured.** Costing a second real credential to measure it is the question, not whether it would be nice to have.
