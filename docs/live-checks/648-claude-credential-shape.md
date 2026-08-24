# 648: which `.credentials.json` shape the sandboxed claude CLI accepts

Run on `coinmatica.net`, 2026-08-24, from a dev session while building [Slice C1 (#648)](https://github.com/alp82/curia/issues/648). Agent image `curia-agent:2.1.220-0.146.0-7cba0f7a`, Claude Code 2.1.220. Nothing in the live system was touched: every run was a throwaway `docker run --rm` against a scratch config dir, no daemon restart, no live agent nudged, and `curia-207` and `curia-625` were up throughout.

[#659](https://github.com/alp82/curia/issues/659) settled that the CLI reads `<CLAUDE_CONFIG_DIR>/.credentials.json` in the sandboxed shape. It did not settle what that file has to contain, and #648 has to write one. **The obvious guess is wrong**, which is the whole reason this record exists.

## The apparatus

Each row is one container: `CLAUDE_CONFIG_DIR=/cfg` on a mounted scratch dir, `CLAUDE_SECURESTORAGE_CONFIG_DIR` unset, the `.claude.json` and `settings.json` seeds `workspace.mjs` writes, no `CLAUDE_CODE_OAUTH_TOKEN` in the environment, and `claude -p 'Reply with exactly the word: PONG'`.

The token is the box's own `CLAUDE_CODE_OAUTH_TOKEN` from `daemon/.env.daemon` — a live `sk-ant-oat01` `setup-token` credential.

## 1. Which fields are load-bearing

| # | `claudeAiOauth` fields | result |
|---|---|---|
| S1 | `accessToken` | `Not logged in · Please run /login`, exit 1 |
| S5 | `accessToken`, future `expiresAt` | `Not logged in`, exit 1 |
| S9 | `accessToken`, future `expiresAt`, `subscriptionType` | `Not logged in`, exit 1 |
| S8 | `accessToken`, future `expiresAt`, `scopes: ["user:inference"]` | `PONG`, exit 0 |
| S2 | S8 plus `subscriptionType` | `PONG`, exit 0 |
| S11 | S8 with two scopes | `PONG`, exit 0 |
| S4 | `accessToken`, **past** `expiresAt`, `scopes` | `Not logged in`, exit 1 |
| S10 | `accessToken`, `expiresAt` **10 min out**, `scopes` | `PONG`, exit 0 |
| S3 | a bogus `accessToken`, nothing else | `Not logged in`, exit 1 |
| S6 | a bogus `accessToken`, future `expiresAt` | `Not logged in`, exit 1 |

**Settled. Three fields are load-bearing: `accessToken`, an `expiresAt` in the future, and a non-empty `scopes` array.** A file missing any one of them reads as *no credential at all* — the same message an empty config dir gives. `subscriptionType` is not one of the three (S9 against S8).

**Settled. There is no pre-expiry refusal window.** An `expiresAt` ten minutes out still authenticated (S10), which makes sense for a credential the CLI cannot refresh. What it refuses is a date already past (S4).

## What this decides for #648

- The delivered file carries exactly `accessToken`, `expiresAt`, `scopes`. Writing the minimal `{accessToken}` shape — the obvious reading of "the CLI reads the file" — would have shipped a fleet that cannot spawn, on the one mechanism the slice exists to fix.
- `scopes` is written as `["user:inference"]`, which is what the token actually carries: #659 read that scope out of the `setup-token` authorize URL.
- `expiresAt` is `obtained_at + 365 days`, the documented lifetime applied to the instant curia adopted the login. For a credential **seeded** from an env file there is no adoption instant, and curia must not invent one — so the file's date is counted from `seeded_at`, the instant curia read the seed, which is a fact about curia rather than a claim about the token. The credentials row still reads `unknown` for that case. The two numbers are deliberately different things.
- The date is a stable function of a stored instant rather than of `now`, because the fan-out compares file contents and rewrites nothing that already matches. A rolling instant would rewrite every live agent's credential once a minute.
- A stamped date that outlives the real token is not a hazard the file has to solve: the CLI will use it, the request will 401, and the account-usage probe on the same credential is what detects that.

## What was not measured

- **A revoked or genuinely expired `sk-ant-oat01` token in a well-formed file.** #659 measured that shape through the environment variable and got `401 OAuth access token has expired`; the same token in a file was not run here.
- **Whether `scopes` is checked for its contents.** Two different non-empty arrays both authenticated (S8, S11); an empty array was not run.
- **The daemon's real dispatch path.** These containers were built by hand, like #659's. No MCP side channel, no Stop hook, no worktree, no daemon in the loop.
