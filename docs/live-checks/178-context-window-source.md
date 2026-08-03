# Live check: where the context meter's denominator comes from (#178)

Ticket: [alp82/curia#178](https://github.com/alp82/curia/issues/178), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.net` on 2026-08-03, against the live Anthropic API with the box's own credential.
Read-only: every request was a `GET`, nothing was written and the daemon was not restarted.

The fault this answers is measured in
[docs/research/worker-context-budget.md](../research/worker-context-budget.md) (#166): the
status line divided by `models.<name>.context_window` = 200000, and the claude lane runs a
1,000,000-token window, so every context figure that lane ever showed was five times too large.

## 1. What the box authenticates with

This matters because [#162](https://github.com/alp82/curia/issues/162) found that not every
Anthropic endpoint answers every credential shape.

```
$ tr '\0' '\n' < /proc/<daemon>/environ | grep -E 'ANTHROPIC|CLAUDE'
CLAUDE_CODE_OAUTH_TOKEN=sk-...
```

A `claude setup-token` credential. No `ANTHROPIC_API_KEY`, no `~/.claude/.credentials.json` —
exactly the shape `GET /api/oauth/usage` refuses.

## 2. `GET /v1/models/<id>` answers it

Run on the box, with that token, in the CLI's own header shape:

| Request | Status | `max_input_tokens` | `max_tokens` |
|---|---|---|---|
| `/v1/models/claude-opus-5` | 200 | **1000000** | 128000 |
| `/v1/models/claude-haiku-4-5` | 200 | 200000 | 64000 |

So the endpoint answers the credential the box already has, and it states the window. The field
is `max_input_tokens`. **There is no `context_window` field on this endpoint** — a fix that
looked for one would have found nothing.

`1000000` for `claude-opus-5` agrees with the second, independent source: `/context` in a live
session on the box reported `24.8k/1m tokens (2%)` (#166 §1).

## 3. It costs nothing, unlike #162's probe

The response carries **no `anthropic-ratelimit-*` header of any kind**:

```
$ curl -s -D - -o /dev/null .../v1/models/claude-opus-5 ... | grep -iE 'ratelimit|retry-after|^HTTP'
HTTP/2 200
```

This is metadata, not a completion. It spends no account quota, which is why the lookup needs
none of the account probe's machinery — no cooperative attempt stamp, no `usage.account_bars`
switch, no per-ten-minute throttle. It keeps only ADR-0007's first rule: read the credential,
never rewrite it, and stop asking once it has been refused.

## 4. The list endpoint, for the record

`GET /v1/models?limit=20` on the same credential, showing that the wrong denominator was wrong
for every model on the lane and not just one:

| id | `max_input_tokens` |
|---|---|
| `claude-opus-5` | 1000000 |
| `claude-sonnet-5` | 1000000 |
| `claude-fable-5` | 1000000 |
| `claude-opus-4-8` | 1000000 |
| `claude-opus-4-7` | 1000000 |
| `claude-sonnet-4-6` | 1000000 |
| `claude-opus-4-6` | 1000000 |
| `claude-sonnet-4-5-20250929` | 1000000 |
| `claude-opus-4-5-20251101` | 200000 |
| `claude-haiku-4-5-20251001` | 200000 |
| `claude-opus-4-1-20250805` | 200000 |

All three configured anthropic models (`fable`, `opus`, `sonnet`) route to 1M-window models.
The daemon fetches per id rather than listing, because one id is what a worker needs and the
list would have to be re-walked to find it anyway.

## 5. Which id to ask about

The claude transcript states the model on the same line as the token counts it already reads:

```
$ grep -o '"model":"[^"]*"' <worker transcript> | sort | uniq -c
     25 "model":"claude-opus-5"
```

That is the id the CLI resolved, not the routing label the daemon asked for (`opus`). Keying the
lookup on it is what makes the denominator self-correcting: when the alias moves, the transcript
says so on the next turn and the window follows.

## 6. End to end

The shipped chain, run against a real claude transcript and the real API:

```
first read (cold): null            <- the lookup never blocks; no figure on this tick
after fetch:       1000000
transcript ctx:    {"tokens":432314,"window":null,"model":"claude-opus-5"}
meters:            {"model":"opus","ctxPct":43,"ctxOver":false}
```

432,314 tokens reads **43%**. Under the old configured 200000 the same session computes 216%,
which the clamp would have rendered as `ctx 100%`.
