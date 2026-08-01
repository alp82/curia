# Headless worker auth: subscription OAuth token vs API key

How a Claude Code worker authenticates on a headless Hetzner box, with no browser and no interactive login. Compares a long-lived subscription OAuth token (`claude setup-token`) with an Anthropic API key. Primary sources only: the official Claude Code docs, Anthropic support articles, the consumer terms, the `claude-code-action` repo, and the local CLI (`claude` v2.1.x help output).

## Supported headless auth paths

The [authentication doc](https://code.claude.com/docs/en/authentication) lists a fixed precedence order when more than one credential is present:

1. Cloud provider credentials (`CLAUDE_CODE_USE_BEDROCK` / `VERTEX` / `FOUNDRY`).
2. `ANTHROPIC_AUTH_TOKEN` env var (sent as `Authorization: Bearer`, for gateways).
3. `ANTHROPIC_API_KEY` env var (sent as `X-Api-Key`). In non-interactive mode (`-p`) the key is always used when present. In interactive mode you approve it once.
4. `apiKeyHelper` script output (settings key that runs a shell script which prints a key).
5. `CLAUDE_CODE_OAUTH_TOKEN` env var, a long-lived OAuth token from `claude setup-token`. The docs name this the path "for CI pipelines and scripts where browser login isn't available".
6. Subscription OAuth credentials from `/login` (the default for Pro, Max, Team, Enterprise).

All four candidate paths for a headless worker are officially documented:

- **`ANTHROPIC_API_KEY`** — documented, first-class ([authentication](https://code.claude.com/docs/en/authentication#authentication-precedence)).
- **`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`** — documented, first-class for CI ([authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)). The `claude-code-action` [setup guide](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md) uses the same pair: "Pro and Max users can generate this by running `claude setup-token` locally".
- **`apiKeyHelper`** — documented, for "dynamic or rotating credentials, such as short-lived tokens fetched from a vault" ([settings](https://code.claude.com/docs/en/settings), [authentication](https://code.claude.com/docs/en/authentication#credential-management)). Refresh: the helper runs again after 5 minutes or on HTTP 401. `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` changes the interval.
- **Copying `~/.claude/.credentials.json`** — **folk practice, not documented.** The docs say only that "Claude Code manages `.credentials.json` through `/login` and `/logout`" ([credential management](https://code.claude.com/docs/en/authentication#credential-management)). No official page describes moving the file to another machine. It may work, but nothing guarantees the refresh flow survives the move, and the consumer terms forbid sharing account credentials (see below).

## Token lifetime and renewal

**`setup-token` OAuth token.** The docs state a fixed lifetime: "generate a one-year OAuth token with `claude setup-token`" ([authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)). The command prints the token once and does not save it. The token is a static env var value. No doc describes auto-refresh for it. Plan for manual rotation before the year ends. Restrictions: it "can only make model requests", so no Remote Control sessions and no claude.ai connectors. Locally configured MCP servers still work. **Bare mode (`--bare`) does not read `CLAUDE_CODE_OAUTH_TOKEN`** — with `--bare`, only `ANTHROPIC_API_KEY` or `apiKeyHelper` authenticate (docs and `claude --help` agree).

**`/login` credentials (`.credentials.json`).** These refresh silently during normal use. When the stored login is within three days of expiry, the CLI warns: "Your login expires in 3 days · run /login to renew". After expiry, "each request fails with `Login expired · Please run /login` until you sign in again" ([renew an expiring login](https://code.claude.com/docs/en/authentication#renew-an-expiring-login)). The docs do not state the base lifetime of a `/login` credential. The docs call out the failure mode that matters here: an unattended session "that outlives the login stops making progress once the credential expires and can't recover until you sign in again". This makes the `/login` file a fragile base for a server worker.

**API key.** No expiry. Revoke or rotate it in the [Claude Console](https://platform.claude.com) at will.

## Cost posture

**Subscription (Pro/Max).** Fixed monthly price. Usage limits are shared: "usage of all different Claude product surfaces (claude.ai, Claude Code, Claude Desktop) counts towards the same usage limit" ([usage and length limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)). Limits are per session window plus weekly caps: "Max plans also have two weekly usage limits: one that applies across all models and another for Sonnet models only", and "weekly limits reset at a fixed time each week" ([What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)). The current support articles describe tiers as "5x / 20x more usage per session than the Pro plan" but no longer print the session length or message counts. The widely cited 5-hour session window is not stated in the current primary articles — treat the exact number as unverified. At the limit, work stops until reset, or you enable usage credits: "usage will be billed at standard API rates (distinct from Pro/Max Plan pricing)" ([use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)).

**API key.** Pay per token, no hard cap: "no hard stop; the account is charged for what it uses" ([models, usage, and limits in Claude Code](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)). Cost scales with worker activity. Console spend limits provide the ceiling.

**Terms question for automated subscription use.** The [consumer terms](https://www.anthropic.com/legal/consumer-terms) prohibit access "through automated or non-human means, whether through a bot, script, or otherwise" — *except* "when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it". They also forbid sharing "your Account login information, Anthropic API key, or Account credentials with anyone else". Anthropic's own docs explicitly document `setup-token` for CI on Pro/Max plans, and the [Agent SDK support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) confirms subscription-billed SDK and `claude -p` use. So single-user automation on your own subscription appears to fall under "explicitly permit". But the same article steers scale-out away: "Teams running shared production automation should use Claude Platform with an API key for predictable pay-as-you-go billing", and subscription credits are "per-user, not pooled". **Unresolved:** no primary source draws a line between "my own CI/worker" and "production automation". A fleet of always-on workers on one personal subscription sits in a gray zone the docs do not settle.

## Headless constraints

- **`setup-token` needs a browser somewhere, once.** It "opens the same browser authorization flow as `/login`" ([authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)). The login flow has a code-paste fallback for machines where the browser cannot reach the local callback server ("common in WSL2, SSH sessions, and containers"): copy the URL, open it in a browser on any machine, then paste the code back into the terminal. So you can run `setup-token` over SSH on the Hetzner box itself, with your desktop browser completing the approval. Or run it on the desktop and copy the printed token. Local CLI confirms: `claude setup-token --help` says "Set up a long-lived authentication token (requires Claude subscription)".
- **API key needs no browser at any point.** Create it in the Console, set the env var.
- **Precedence trap:** if both are present, `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN` and subscription credentials. The docs warn this "can cause authentication failures if the key belongs to a disabled or expired organization"; `/status` shows which method is active ([authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)). On a worker box, set exactly one credential.

## systemd notes

- **Env injection.** Both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are plain env vars. Use `Environment=` or, better, `EnvironmentFile=` with a root-readable file, or a systemd credential. The env var path is the documented CI pattern ([claude-code-action setup](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)).
- **No keychain on Linux.** "On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`" — plaintext on disk, unlike the encrypted macOS Keychain ([credential management](https://code.claude.com/docs/en/authentication#credential-management)). `CLAUDE_CONFIG_DIR` relocates the file.
- **Env-var auth avoids the file entirely.** A worker driven by `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` needs no `.credentials.json`, so nothing on the box refreshes or expires out from under a long-lived unit (until the one-year token itself ends).
- **Rotation.** `apiKeyHelper` is the documented hook if you later want vault-fetched short-lived keys instead of a static env var (5-minute / on-401 refresh).

## Curia-specific note

The daemon points every worker at the host's credential store: `workerEnv` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the host's `~/.claude`, so host and workers share one refresh lineage (issue #53, `daemon/README.md`). On the Hetzner box this means one decision covers everything: whatever single credential the host holds is what all workers use. With env-var auth (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the daemon's environment), the shared store simply carries no credential and the `/login` expiry failure mode disappears. The env var must reach the daemon so it flows into `workerEnv`.

## Comparison

| Aspect | Subscription OAuth token (`setup-token`) | API key |
|---|---|---|
| Setup on headless box | One browser approval (code-paste over SSH works), then env var | Env var only, no browser ever |
| Lifetime | One year, static, no auto-refresh documented | No expiry, revoke in Console |
| Renewal | Re-run `setup-token`, redeploy the token | None needed |
| Cost | Fixed monthly, shared session + weekly limits | Pay per token, no cap |
| Behavior at limit | Worker stalls until reset (or usage credits at API rates) | Never stalls, bill grows |
| Feature limits | Model requests only, no Remote Control or claude.ai connectors, ignored by `--bare` | Full, works with `--bare` |
| Terms clarity | Gray zone for always-on automation (see above) | Explicitly the automation path |
| Precedence | Rank 5 | Rank 3 (wins over the token) |

## Recommendation

For one personal worker that shares your existing Max plan, the `setup-token` route is the documented, cheapest path: generate the token once (over SSH with the code-paste fallback, or on the desktop), set `CLAUDE_CODE_OAUTH_TOKEN` in the systemd unit, and put a calendar note one year out. Accept two operational costs: the worker stalls when your shared session or weekly limit trips, and Anthropic's own guidance points "shared production automation" at the API instead. For a worker that must never stall, or for more than personal-scale automation, use an `ANTHROPIC_API_KEY` with a Console spend limit. Do not copy `.credentials.json` between machines: it is undocumented, refresh behavior is unspecified, and the consumer terms prohibit credential sharing. Flagged as unverified: the exact session-window length (the "5 hours" figure is absent from current support articles) and where exactly the terms draw the automation line for a subscription.
