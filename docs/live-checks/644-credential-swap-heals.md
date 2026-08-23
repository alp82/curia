# 644: replacing a credential under a running agent heals it

Run on the box, 2026-08-23 13:34–13:40 UTC, against the two agents wedged by the incident in #641.
codex-cli 0.146.0, agent image `curia-agent:2.1.220-0.146.0-7cba0f7a`.

The apparatus was the incident itself: `curia-574` and `curia-578` had been dead since 06:37 UTC on a
credential that could not refresh. Recovering them deliberately was cheaper than rebuilding the
condition later, so the recovery was run as this check.

## 1. The re-authentication flow (#642)

A `curia-auth-openai` tmux session in the `tmux` container, running `docker run` against the agent
image with a scratch `CODEX_HOME` at `~/curia-work/cfg/curia-auth-openai`:

```
docker run --rm -it --name curia-auth-openai \
  -v /home/alp/curia-work/cfg/curia-auth-openai:/cfg \
  -e CODEX_HOME=/cfg \
  curia-agent:2.1.220-0.146.0-7cba0f7a \
  codex login --device-auth
```

The pane printed:

```
1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device
2. Enter this one-time code (expires in 15 minutes)
   85PT-A4E5M
```

The operator entered the code on a separate device. The pane printed `Successfully logged in` and the
process exited 0, leaving `auth.json` (mode 600) in the scratch dir.

**Settled.** The whole shape works: a named tmux session, `docker run` against the agent image, a
device code needing no paste-back, and completion detectable by the credential file appearing. The
tmux image carries `docker` but not `codex`, so the `docker run` indirection is required, not a choice.

## 2. What a fresh credential carries

| | old (2026-08-13) | new (2026-08-23) |
|---|---|---|
| `iat` | 2026-08-13T23:36:30Z | 2026-08-23T13:35:23Z |
| `exp` | 2026-08-23T23:36:30Z | 2026-09-02T13:35:23Z |
| lifetime | 10.0 days | 10.0 days |
| `chatgpt_plan_type` | `plus` | `prolite` |
| account | 7c9992f3-… | 7c9992f3-… (same) |
| refresh token | — | different |

**Settled (#643 q4).** The access-token lifetime is exactly 10 days across two samples on one account.
Stable enough to compute a refresh margin as a fraction of life, so #641's "last 25%" holds.

**Settled (#643 q3, partly).** A fresh login reflects a plan change: the operator upgraded the account
between the two samples and the plan string moved from `plus` to `prolite`. Whether a *refresh* picks
a plan change up is untested.

## 3. Does replacing `auth.json` heal a running agent?

The new credential was written into `~/curia-work/cfg/curia-574/auth.json` and
`~/curia-work/cfg/curia-578/auth.json` by temp-file-plus-rename, mode restored to `0400`. Both
containers read the new `last_refresh` immediately.

Neither agent moved on its own. Both had already returned to an idle composer when their turn died,
so there was no in-flight request to retry.

`curia-578` was then nudged at 13:36:51Z. It resumed on the next turn:

```
• I will resume from the saved worktree. I will verify the review fixes before I run the full suite.
• Called
  └ curia.notify({"kind":"progress","message":"The worktree is intact. I resumed the review fixes …"})
    ok
◦ Working (12s • esc to interrupt)
```

`curia-574` was on the rate-limit modal, so it took an `Escape` first, then the same nudge, and also
resumed.

**Settled (#644, codex).** **Freeze in place works.** A running codex process picks up a replaced
`auth.json` with no restart, keeping its pane, its claim, its worktree and its conversation. It needs
a nudge, because a turn that died leaves the agent idle at the composer and nothing restarts it. That
nudge is exactly rung 1 of #578's stall ladder.

**Settled by construction (#644, claude).** The claude lane cannot be healed this way. `modelCredential`
in `sandbox.mjs` hands the container its credential as an environment variable, and a running process's
environment cannot be changed from outside. Freeze-versus-kill therefore differs per consumer, and the
claude lane needs the relocation in #648 before freeze is even reachable.

## 4. What a spent refresh token returns

After the re-login, the old refresh token was definitively spent, so refreshing with it cost nothing:

```
POST https://auth.openai.com/oauth/token
{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"rt.1.…"}

HTTP 401
{
  "error": {
    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
    "type": "invalid_request_error",
    "param": null,
    "code": "refresh_token_reused"
  }
}
```

**Settled (#643 q1, spent case).** The code is **`refresh_token_reused`**, not the OAuth-standard
`invalid_grant`. It arrives in OpenAI's own API error envelope, so a classifier must key on
`error.code` and not on a top-level OAuth `error` field. A classifier written against `invalid_grant`
would have missed this and treated a terminal failure as unrecognized.

The *revoked* case is still untested, and Anthropic's equivalents are untested.

**This also converts #641's central inference into measurement.** The map assumed the 06:37 refresh
succeeded on the wire and rotated the server-side token, stranding the read-only copy and the host
store together. `refresh_token_reused` proves it: something did successfully exchange that token, and
the `0400` copy could not record the result. This is #351's bound, observed.

## Artifacts

- `~/curia-work/archive/codex-auth-spent-20260823.json` — the spent credential, kept for the revoked-case
  and Anthropic follow-ups in #643.
- `~/curia-work/archive/578-worktree-20260823.patch` — `wt/578`'s uncommitted work at the time of the
  incident, 1133 lines. Taken by hand because nothing in curia would have (#649).
