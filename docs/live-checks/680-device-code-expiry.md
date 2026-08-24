# 680: what happens when a codex device code expires

Run on the box 2026-08-24, 18:52:23 to 19:24 UTC. Two throwaway containers on `curia-agent:2.1.220-0.146.0-7cba0f7a`, codex-cli 0.146.0. No login was completed, and no live session was touched.

[#642](642-codex-reauth.md) drove the flow to a *completed* login. Nobody had ever watched one fail. [#680](https://github.com/alp82/curia/issues/680) assumed the failure was passive - the code quietly stops working while curia's thirty-minute window runs on - and that assumption decided the ticket's four options. It is wrong.

## The apparatus

Neither probe went near the daemon. The real tmux server is parked on `-S /run/curia-tmux/default` (`tmux.mjs`, #260); both probes used the plain default socket, which is a separate server, and neither container carried the `curia.session` label. The session names sat outside the `curia-auth-` prefix, so no adoption path could have reached them either.

The first probe ran under tmux and was sampled every two minutes. It proved the ending but lost the final frame, because `docker run --rm` takes the pane with it. The second dropped tmux entirely and redirected the container's own stdout to a file, which is what caught the last line.

## What was measured

| Question | Answer |
|---|---|
| Does codex reprint a fresh code when the old one expires? | **No.** |
| What does it do instead? | Exits, with `Error logging in with device code: device auth timed out after 15 minutes`. |
| When? | Probe 1 was alive at t+13:39 and gone by t+15:05. Probe 2 ran the full fifteen minutes and printed the timeout. |
| Is the fifteen minutes readable off the pane? | **Yes, twice.** `2. Enter this one-time code (expires in 15 minutes)`, on the line `DEVICE_CODE_RE` already anchors on, and again in the timeout message. |
| Does the codex log store record the ending? | **No.** `log/codex-login.log` holds one line, `starting device code login flow`, and nothing else. |
| Is a credential written? | No. The scratch config dir holds `log/` and `tmp/` and no `auth.json`. |
| Has a real `reauth` ever run on this box? | **No.** The journal carries no `reauth_*` event of any kind. |

## What it means for curia

**The stale-code window is one tick, not fifteen minutes.** The ticket claimed the panel can show a dead code for up to half of the thirty-minute window. It cannot. Codex ends the process the moment the code expires, so the tmux session goes with it, and `poll` reaches `if (!present) return this.#end('abandoned', 'reauth_abandoned')` on the next tick. `poll_interval_s` is 60, so the card comes down within a minute of the code dying.

**`REAUTH_TIMEOUT_MS` has never fired on the codex lane, and cannot.** Codex's fifteen minutes always arrives first. The thirty minutes was chosen as a margin for the operator - a phone that locks, a person who walks away - and on this lane that margin has never existed. It is reachable only on the anthropic lane, where `setup-token` waits on a paste with no clock of its own.

**Curia cannot read the reason the login ended.** The timeout message is real and specific, and it is gone before the next tick looks: `capturePane` throws on a session that is no longer there. So the ending arrives at curia as an absence, and `abandoned` is the only word the code has for it. `CONTEXT.md` defines that word as "an operator who closed it, or a `codex login` that died" - one word for two different things, and the one it implies is the one that blames the operator.

**The code's own clock is the only way to tell them apart.** A session that vanishes at or after fifteen minutes timed out; one that vanishes before it was closed. Nothing else on the box distinguishes them, because codex logs neither.

## What was not measured

- **A completed login after a first code expired.** Both probes were abandoned at the timeout, so nothing here says how `reauth` behaves immediately afterwards.
- **The anthropic lane's authorize URL.** It also expires and nobody has measured it. `claude setup-token` was not run.
- **The daemon's own path.** Both containers were hand-built, the same caveat every record on this map before [#667](667-daemon-heals-a-real-agent.md) carried. What the daemon does with the vanished session is read off `credentials.mjs`, not watched.
