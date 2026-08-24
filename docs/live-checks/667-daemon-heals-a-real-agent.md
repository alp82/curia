# 667: does the daemon heal a REAL dispatched agent, and does it move on its own?

Run on the box, 2026-08-24, 11:06–14:13 UTC. The box ran `558b402` for the whole check, so C1, C2 and
C3 were all deployed. Agent image `curia-agent:2.1.220-0.146.0-7cba0f7a`, Claude Code 2.1.220,
codex-cli 0.146.0.

Every earlier record on this map was a container built by hand: no MCP side channel, no Stop hook, no
worktree, no daemon in the loop. This one uses agents the daemon dispatched onto real tickets, and the
daemon's own tick does every write.

Three subjects, all real dispatches:

| | ticket | harness | what it was for |
|---|---|---|---|
| `curia-678` | `alp82/curia#678` | claude, sonnet | the fan-out healing a live agent |
| `curia-533` | `alp82/curia#533` | codex, gpt-5.6-sol | the hold, the freeze, the skip, the login, the adoption |
| `curia-214` | `alp82/aistack#214` | claude, sonnet | the nudge, and the ticket carrying on afterwards |

**No credential was allowed to die by itself.** Both earlier checks manufactured the failure, and so
does this one. Both stores were copied before the run and both are byte-identical to those copies
afterwards; the copies are deleted.

## 1. The daemon's own fan-out heals a real dispatched agent

**Settled twice, and the first time cost nothing at all.** Six seconds after the daemon seeded the
anthropic store on the C1 deploy, its first tick created `.credentials.json` in three live claude
agents spawned that morning with the credential in an environment variable and no file at all:

```
11:05:56Z  seeded the anthropic credential store from daemon/.env.daemon
11:06:02Z  handed the current anthropic credential to 3 live claude agent(s):
           curia-625, curia-670, curia-671
```

All three carried on working across the write. `curia-671` went on to ship #679. **That is question 4
answered by the box's own boot** - the fix reaches the agents that predate it, on the real path.

The sharp form ran on `curia-678`, dispatched at 12:42. Its credential was replaced with a
revoked-looking one - same prefix, same length, same charset, written atomically - at 12:43:46. The
turn died, and the next tick repaired it:

```
12:44:45.356Z  credential_fanned_out {"consumer":"claude","provider":"anthropic","agents":["curia-678"]}
```

Right config dir, mode `0600`, the agent's mount already open, the daemon's own journal line as the
record. Repeated on `curia-214` at 13:52:45, 51 seconds after that break.

**A post-C1 claude agent has no `CLAUDE_CODE_OAUTH_TOKEN` at all.** C1 did not merely add the file, it
took the whole precedence ladder out. `curia-678`'s container env is `CLAUDE_CONFIG_DIR`,
`GH_CONFIG_DIR`, `HOME`, `TERM`, `BASH_ENV` and a tool timeout, and nothing else. The file is the only
credential the agent has, which is what makes a post-C1 agent a clean subject and a pre-C1 one
useless: the older population still carries the variable, so a dead file there is rescued by it and
proves nothing.

## 2. Does a healed agent move on its own? No.

The answer every hand-built record gave, now measured on the real path. `curia-678` and `curia-214`
both had a Stop hook, the MCP side channel, a curia claim and a worktree. It made no difference. The
turn dies in the transcript body, not in a modal, with the composer live beneath it:

```
● Please run /login · API Error: 401 OAuth access token is invalid.
✻ Brewed for 1m 46s
❯
```

`curia-678` sat there for ten minutes after its credential was repaired, polled every thirty seconds.
`curia-214` sat there for fifteen minutes and twenty-five seconds, until the ladder typed into it.
**The nudge is load-bearing on the real path, not only on the rehearsal.**

That one line is also the claude lane's dead-credential pane text, which #647's classifier has never
had from a real dispatched agent.

## 3. Does the nudge finish the recovery? Yes.

The chain the map has been pointing at since filing, watched end to end. It took two lanes, for a
reason section 4 explains: only the claude lane can be made to die on demand, and only the codex lane
has a hold today.

### The codex lane: hold → freeze → skip → login → adoption → lift → fan-out

The store was doctored at 13:33:37 - the access token's own `iat`/`exp` moved so that now sits inside
the last quarter of its life, and the refresh token corrupted so that no real rotation could spend it.

```
13:33:45.569  credential_refresh_failed      attempt 1 of 5, HTTP 400
                                             invalid_refresh_token_ciphertext_integrity, terminal:false
13:33:45.574  credential_fanned_out          consumer:codex agents:["curia-533"]
13:34:45      credential_refresh_failed      attempt 2
13:35:45      credential_refresh_failed      attempt 3
13:36:45      credential_refresh_failed      attempt 4
13:37:45.551  credential_refresh_exhausted   terminal:true
13:37:45.559  credential_hold                by:"bound" consumers:["codex"] frozen:["curia-533"]
13:37:45.706  reauth_started                 curia-auth-openai
13:37:45.764  reauth_requested               by:"credential-hold"
13:37:46.245  stall_sweep_skipped            curia-533 — the freeze holds
13:38:45.411  reauth_code_seen               a real device code on the card
13:46:16      (a valid auth.json placed in the login's scratch dir)
13:46:45.824  reauth_completed               after_s:540, expires 2026-09-02T14:55:40Z
13:46:45.837  credential_hold_lifted         openai
13:46:45.842  credential_fanned_out          curia-533 — the SAME tick
```

Nine minutes from the first failed refresh to a healed agent, with 686 ms between the hold and the
sweep learning to leave the agent alone. Afterwards the lane reads `valid`, the reauth card is gone,
the `curia-auth-openai` session is torn down, and no further `stall_sweep_skipped` line appears -
**the skip is lifted, not merely stale.**

**`stall_sweep_skipped` is journalled once per agent per hold**, as designed: one line across nine
minutes of freeze rather than nine.

**The adoption ran through the real path, with only the browser half stood in for.**
`DeviceLoginLane.finish` takes ADR-0027's completion rule literally - the credential file appearing in
the login's scratch dir *is* completion - so placing a valid one there drove `adopt()` →
`releaseHold` → `#frozenNoted.clear()` → the fan-out, exactly as a finished device login does. What
was simulated is where the file came from. #642 measured that half end to end with an operator at a
browser, and re-running it would have rotated the account's real credential for nothing.

### The claude lane: death → heal → nudge → the ticket carries on

```
13:51:54      (curia-214's credential file replaced with a dead token)
13:52:10.7    the transcript stops growing; the turn dies with the 401 above
13:52:45.421  credential_fanned_out          consumer:claude agents:["curia-214"] — 51 s
              ... fifteen minutes at the composer, not moving ...
14:07:45.461  stall_detected                 idle_ms 934735
14:07:45.466  stall_nudge_started            attempt 1
14:07:47.292  stall_nudge_accepted           attempt 1
14:12:37      the transcript is 578 KB and growing again
```

The nudge fired on the first tick after the fifteen-minute mark, was accepted in 1.8 seconds, and the
agent went back to the ticket it had been working when the credential died - same conversation, same
worktree, same claim, its todo list intact, two of six items done and the third under way.

**Settled: rung 1 finishes the recovery.** Nothing above rung 1 was needed, and no respawn happened.

### What the recovery costs the agent: nothing

`curia-533` was frozen for nine minutes and went on to reach its review gate. `curia-214` lost a
single turn. Freeze in place is what the map claimed it was.

## 4. The two lanes do not fail alike, and only one of them can be killed by the fan-out

**This is the finding the check did not go looking for.**

- **claude bites immediately.** The CLI reads `<CLAUDE_CONFIG_DIR>/.credentials.json` per request, so a
  dead file kills the next turn. Measured twice, ~16 seconds each time.
- **codex does not bite at all while the process is healthy.** `curia-533` ran for thirteen minutes
  with a dead `auth.json` on disk - byte-identical to the doctored store, confirmed by md5 - and never
  noticed. It holds its access token in memory and re-reads the file only when it has reason to.

So **#644's "freeze in place works for codex" is one-directional, and the direction it lacks is a good
property nobody had stated.** A dead→good swap heals a codex process whose turn already died, because
a failed call is what sends it back to the file. A good→dead swap does not stop a healthy one - which
means a codex agent survives a rotation it never sees, and the tick's fan-out can never be the thing
that breaks one.

Two consequences worth carrying:

1. **The codex fan-out cannot simulate a credential death in a live agent.** Anyone reaching for this
   apparatus on that lane will watch an agent keep working and conclude the fan-out failed. It did
   not.
2. **Only the claude lane can produce the stall the ladder recovers from, on demand.** Which is why
   question 3 needed both lanes: the hold is built on codex today, and the death is only reachable on
   claude.

## 5. Two more measured facts

**The `by: "bound"` path ran live for the first time.** Every earlier hold on this map was
`by: "provider"` - a code curia recognises. Here five unrecognised answers, sixty seconds apart,
became a terminal call in exactly four minutes, as #646 argued they would. The cost of refusing to
treat any 400 as terminal is those four minutes, on an outage already under way; the thing it buys is
not waking an operator for a network blip.

**A fourth OpenAI refusal code, and it is NOT evidence about a real dead token.** HTTP 400
`invalid_refresh_token_ciphertext_integrity`, which is what OpenAI answers when the string it is
handed is not a well-formed refresh token - which is precisely what this apparatus made. A spent token
still answers `refresh_token_reused` (#643), a revoked one has not been seen. Recorded so nobody
mistakes it for a production shape, and so **nobody adds it to `TERMINAL_REFRESH_CODES` on this
evidence**: on this box it can only mean curia's own store is corrupted, and five wasted retries is
the right price for not guessing about that.

## The apparatus, for whoever runs the next one

**Breaking one agent's delivered file beats breaking the store**, on the claude lane. The fan-out
rewrites anything that differs from the store, so the break repairs itself within one tick with the
daemon doing the repairing - a blast radius of one agent and under a minute, no fleet outage, no
overseer outage, and the healing write is the daemon's own rather than the operator's. What it cannot
produce is a hold, because the store stays good.

**One honest artifact of the codex half:** because the store was changed by hand, the tick's fan-out
pushed the doctored token to the live agent four minutes *before* the hold armed. In a real incident
the store is unchanged and the agents keep their good-but-expiring copies until the hold lands. It
made no difference here only because codex ignored the write.

## What is still not measured

- **A real credential dying on its own.** Both lanes were manufactured, as every check on this map has
  been. The first evidence from a real refresh is due about 2026-08-31.
- **The anthropic lane's hold, live.** C3 is deployed and its detector is quota-free, but arming it
  needs the store to hold a dead `sk-ant-…`, which takes every claude agent and the overseer down
  together. The codex lane answered the same question for less.
- **The anthropic re-authentication flow end to end**, which is [#669](https://github.com/alp82/curia/issues/669)'s and needs an operator pasting a token.
- **Rungs 2 and 3 of the ladder.** Rung 1 was accepted, so nothing above it ran.
