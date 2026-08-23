# aistack machine registration and usage sync for the curia box

Date: 2026-08-23. Ticket: [Register the curia box as an aistack machine](https://github.com/alp82/curia/issues/637).

All aistack citations are `path:line` against commit `46b8028` of `alp82/aistack`. Curia citations name the curia repo.

**Verdict.** The box can register and sync. Registration is one headless `npx @use-aistack/cli login` on the box, plus one browser approval by the operator on any machine. The sync path a box can use is `sync --auto`, because the interactive `sync` refuses a shell without a TTY. Three things stand in the way. First, the CLI reads Claude Code transcripts from `CLAUDE_CONFIG_DIR` or from `$HOME/.claude/projects`, but curia's agent transcripts live in per-session config dirs under `<workspace_root>/cfg/`, and the daemon deletes each dir at session teardown. Second, a machine is a token, not a row in the measured layer. Snapshots key on stack plus harness, so a box that syncs to the operator's own stack replaces the operator's Claude Code numbers instead of standing beside them. The box needs its own stack. Third, no hook fires on the box, so the recurring sync needs a box-side timer.

## 1. The registration

A machine is a `cliTokens` row (`convex/schema.ts:608`). The one-time act is the device-code login:

1. The CLI calls `POST /api/cli/auth/start` and gets a six-character `userCode`, a `secretId`, and an `authUrl` (`packages/cli/src/api.ts:54`, `convex/httpCli.ts:231`).
2. The pending session lives 15 minutes (`convex/httpCli.ts:289`).
3. A signed-in human opens `<app>/cli/auth?code=<userCode>`, edits the proposed machine name, picks the stack the machine will sync to, and approves (`convex/cliSessions.ts:99`).
4. The CLI polls `GET /api/cli/auth/poll?secretId=...` every 5 seconds, 36 times, so the human has 3 minutes before the CLI gives up (`packages/cli/src/commands/login.ts:63`). The session itself stays approvable for the full 15 minutes, so a timed-out CLI can rerun `login`.
5. On approval the server mints a 256-bit random bearer, stores only its SHA-256, and returns the plaintext once (`convex/httpCli.ts:317`, `convex/cliSessions.ts:239`).

The credential is that bearer. The CLI stores it in `$HOME/.config/aistack/credentials.json`, keyed by server URL (`packages/cli/src/config.ts:6`, `config.ts:20`). This file holds the only plaintext copy. The proposed machine name is the hostname, and the approval page can overwrite it (`packages/cli/src/commands/login.ts:16`).

The `login` command tries to open a browser and prints the URL when it cannot (`packages/cli/src/commands/login.ts:53`). So a headless box works: the operator opens the URL on their own machine. The name and revoke surface is `/settings/machines` (`src/features/settings/MachinesPage.tsx:14`).

## 2. The token model

The server stores `tokenHash` (unsalted SHA-256, lowercase hex), `userId`, an optional `name`, the bound `stackId`, a `scopes` array, and three clocks: `createdAt`, `expiresAt`, `lastUsedAt` (`convex/schema.ts:608`). The plaintext never reaches the database layer (`convex/httpCli.ts:47`).

Lifetime: 90 days, and the TTL is sliding. Every successful `collect` or `sync` request pushes `expiresAt` out another 90 days (`convex/httpCli.ts:329`, `httpCli.ts:389`, `httpCli.ts:507`, `convex/cliTokens.ts:120`). A machine that syncs weekly never expires. Revocation deletes the row (`convex/cliTokens.ts:122`).

Scope: every token is minted with the full set `['collect', 'sync']` (`convex/lib/cliScopes.ts`, `convex/cliSessions.ts:261`). The enforcement point is `validateBearerToken`, which also rate-limits per token at 60 requests per minute (`convex/httpCli.ts:104`, `convex/rateLimit.ts:9`). Validation is one indexed lookup by digest, and an expired row answers null (`convex/cliTokens.ts:36`).

The token is also the stack binding. The stack is chosen at approval time and never in a payload (`convex/cliSessions.ts:108`, `convex/measured.ts:186`).

## 3. The reading

One sync pushes one `MeasuredPayload` per detected harness, in one atomic request (`packages/cli/src/harness/shared/payload.ts:450`). The payload carries `schemaVersion`, `capturedAt`, `window {days, from, to}`, `harness {name, version}`, `pricingTable`, `activity {sessions, activeDays, projects, totalTokens, cacheHitShare, subagentShare}`, `models` (per model: sanitized id, tokenShare, input/output/cacheWrite/cacheRead token counts, optional `apiEquivalentUSD`), `inventory` (allowlisted tool/MCP/skill/subagent/slash-command names as call shares, plus withheld counts), `coverage`, and `excludedTokens` (`packages/cli/src/harness/shared/payload.ts:74`). Raw transcripts, prompts, paths, and project names never travel (`packages/cli/src/harness/claude/scan.ts:6`).

The rolling window is 30 calendar days, UTC, today inclusive (`packages/cli/src/harness/shared/window.ts:6`). `windowStartMs` defines it once for detection, scan, and the payload's `window.from` (`window.ts:16`). A harness counts as detected only when it wrote a matching file inside the window (`packages/cli/src/harness/index.ts:174`, `harness/shared/recency.ts`).

Source files per harness:

| Harness | Wire name | Roots | Format |
|---|---|---|---|
| Claude Code | `claude-code` | `$CLAUDE_CONFIG_DIR` (comma-separated list, `projects/` appended per entry), else `$HOME/.claude/projects` and `$XDG_CONFIG_HOME/claude/projects` | `*.jsonl` transcripts, recursive walk (`packages/cli/src/harness/claude/scan.ts:28`) |
| Codex | `codex` | `$CODEX_HOME/sessions`, else `~/.codex/sessions`. One root only | `rollout-*.jsonl` and `.jsonl.zst` (`packages/cli/src/harness/codex/scan.ts:29`) |
| opencode | `opencode` | `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode` | `opencode*.db` SQLite (`packages/cli/src/harness/opencode/scan.ts:41`) |
| Pi | `pi-mono` | `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`, `sessions/` only | session files (`packages/cli/src/harness/pi/scan.ts:44`) |

A file whose mtime predates the window is skipped without a read (`packages/cli/src/harness/claude/scan.ts:122`).

## 4. The identity

A machine is separated from other machines only as a token. The measured layer does not record which machine sent a snapshot: `measuredSnapshots` rows carry `stackId`, `capturedAt`, `receivedAt`, `schemaVersion`, `harness`, `payload`, and no token id (`convex/schema.ts:770`, `convex/measured.ts:164`).

The read side takes the newest snapshot per `(stack, harness)` pair as "current" (`convex/measured.ts:317`). So the answer to the ticket's question is neither of its two options:

- A second machine that syncs the same harness to the **same stack** does not double-count. It replaces. The last writer's 30-day window becomes the stack's Claude Code numbers, and the other machine's usage vanishes from the current reading until it syncs again.
- A second machine lands cleanly as its own reading only when its token binds a **different stack**. One token binds exactly one stack, chosen at approval (`convex/cliSessions.ts:108`).

Conclusion for the prototype: register the box against its own stack, created for the box. `approveSession` also allows a stack-less link, but such a token cannot publish until relinked (`convex/httpCli.ts:372`).

## 5. The sync path

The CLI is the npm package `@use-aistack/cli`, binary name `aistack`, run as `npx @use-aistack/cli <command>` (`packages/cli/package.json`). Commands: `login`, `sync`, `sync --auto [on|off]`, `collect`, `connect claude`, `mcp`, `create` (`packages/cli/src/index.ts:19`).

The base URL is `process.env.AISTACK_URL || "https://aistack.to"` (`packages/cli/src/api.ts:3`). The app's TanStack routes under `src/routes/api.cli.*.tsx` proxy to Convex httpActions, and forward only `Authorization` and `Content-Type` (`convex/httpCli.ts:93`).

HTTP calls and their Convex receivers (`convex/http.ts:18`):

| Call | httpAction (`convex/httpCli.ts`) | Inner function |
|---|---|---|
| `POST /api/cli/auth/start` | `authStart` | `internal.cliSessions.createSession` |
| `GET /api/cli/auth/poll` | `authPoll` | `internal.cliSessions.issueTokenAndDeleteSession` |
| `GET /api/cli/sync-config` | `syncConfig` | `internal.measured.getPublicSyncConfigInternal`, `getSyncConfigForStack` |
| `POST /api/cli/sync` | `syncPublish` | `internal.measured.publishForToken` (`convex/measured.ts:1954`) |
| `POST /api/cli/auto-sync` | `autoSyncSet` | `internal.autoSync.setForToken` (`convex/autoSync.ts:68`) |
| `POST /api/cli/stacks/collect` | `stackCollect` | `internal.httpCliHelpers.upsertStackResources` |
| `GET /api/cli/stacks` | `stackGet` | `internal.httpCliHelpers.getStackWithResourcesByCreator` |

One sync is: `GET /api/cli/sync-config` with the bearer, a local scan, `buildSyncBody`, then `POST /api/cli/sync` with the staged bytes (`packages/cli/src/sync/stage.ts:86`, `api.ts:130`). The interactive `sync` refuses when stdin or stdout is not a TTY: "sync needs an interactive terminal" (`packages/cli/src/commands/sync.ts:93`). The non-interactive path is `sync --auto`, which never prompts and publishes only under the standing opt-in plus the stack's permission (`packages/cli/src/autosync/run.ts:74`).

## 6. The recurring path

`convex/crons.ts` schedules no sync. Its five jobs are garbage collection: icon orphans, rate-limit rows, expired device-code sessions, snapshot downsampling, and view-dedupe markers (`convex/crons.ts:8`). The server never pulls. Every snapshot is a client push.

`convex/autoSync.ts` holds the permission, not the schedule. The flag lives on the stack (`stacks.autoSync {enabled, frequencyHours}`, `stacks.lastAutoSyncAt`, `convex/schema.ts:460`). Three writers: a one-time seed from a sync, the machine over `POST /api/cli/auto-sync`, and the owner's web switch (`convex/autoSync.ts:9`). `publishForToken` refuses a `trigger: 'auto'` publish when the stack's flag is explicitly false (`convex/measured.ts:2040`). The frequency is clamped to 1 through 168 hours, default 24 (`convex/lib/autoSync.ts`).

The trigger is client-side: `sync --auto on` writes a `SessionStart` hook into `$HOME/.claude/settings.json` for Claude Code and `~/.codex/hooks.json` for Codex (`packages/cli/src/autosync/hook.ts:15`, `optin.ts:87`). The hook command is `npx -y @use-aistack/cli@latest sync --auto` with an offline fallback (`hook.ts:17`). `sync --auto` then gates on the local flag in `$HOME/.config/aistack/settings.json`, on the frequency stamp in `autoSyncState.lastRunAt`, and on the stack's permission fetched before the scan (`run.ts:86`, `run.ts:97`, `run.ts:111`). Each run logs one line to `$HOME/.config/aistack/sync.log` (`run.ts:41`).

What a box-side recurring sync needs from the box:

1. A linked token in `<HOME>/.config/aistack/credentials.json`.
2. The local opt-in, written once by `sync --auto on` (this path shows no prompt, so it runs headless, `packages/cli/src/commands/sync.ts:48`). It requires a detected harness and asks the stack first.
3. A timer. The hook file the CLI installs sits in `<HOME>/.claude/settings.json`, and no curia agent reads that file: every agent gets its own `CLAUDE_CONFIG_DIR` (`daemon/src/workspace.mjs:639` in curia), so the hook never fires. The daemon or a cron must invoke `npx @use-aistack/cli sync --auto` itself. The run self-throttles to `frequencyHours`.
4. The correct `CLAUDE_CONFIG_DIR` and `HOME` in the invocation's environment, per the next section.

## The curia side

Curia's HOME is `<workspace_root>/home` (`deploy/compose.yaml:83`, `daemon/src/deploy.mjs:82` in curia). But agent transcripts do not live under it. Each agent runs with `CLAUDE_CONFIG_DIR=<workspace_root>/cfg/<session>` or `CODEX_HOME=<workspace_root>/cfg/<session>` (`daemon/src/workspace.mjs:59`, `workspace.mjs:639`, `workspace.mjs:740`). The overseer's dir is `<workspace_root>/cfg/curia-overseer` (`daemon/src/overseerturn.mjs:82`). Claude transcripts are `cfg/<session>/projects/*.jsonl` and codex rollouts are `cfg/<session>/sessions/...` (`daemon/src/transcript.mjs:4`).

The aistack CLI can be pointed at a non-default HOME. It resolves every path through `homedir()` and honors `HOME` on Linux. For Claude Code it also honors `CLAUDE_CONFIG_DIR` as a comma-separated list of config dirs (`packages/cli/src/harness/claude/scan.ts:28`), so one sync can scan every `cfg/<session>` dir: enumerate `cfg/*` at invocation time and join with commas. `CODEX_HOME` is a single directory (`packages/cli/src/harness/codex/scan.ts:29`), so codex rollouts spread over many cfg dirs cannot be aggregated in one scan.

Overlap with `daemon/src/usage.mjs` (curia): the same files, a different question. `usage.mjs` reads the tail of one transcript per agent for context and rate-limit meters, and probes the Anthropic API for the account's 5-hour and 7-day windows (`daemon/src/usage.mjs:169`, `usage.mjs:278`, `usage.mjs:726`). The aistack CLI reads the whole transcript set and aggregates tokens per model over 30 days. It reads no rate-limit window and makes no Anthropic call. So the transcript JSONL files overlap fully, and the account-window reading has no aistack counterpart.

## Risks

- **Teardown deletes the evidence.** The daemon removes each agent's config dir when the session ends (`daemon/src/dispatch.mjs:5377`, `workspace.mjs:364` in curia). A sync sees only the sessions still on disk, so `activity.totalTokens` understates the box's real 30-day usage, and each new snapshot replaces the last. A frequent recurring sync narrows the gap but cannot close it, because the measured layer stores windows, not increments.
- **Stack contention.** A box token bound to the operator's own stack overwrites the operator's `claude-code` current snapshot on every box sync (section 4). The registration step must create and bind a box-owned stack.
- **No TTY, no interactive gate.** The one-time acts that need answers (`login`, the approval, `sync --auto on`) run headless, but any path into the interactive `sync` fails on the box (`packages/cli/src/commands/sync.ts:93`).
- **The login poll is short.** The CLI polls for 3 minutes while the session lives 15 (`packages/cli/src/commands/login.ts:63`). The operator must approve within 3 minutes of the command, or the box must rerun it.
- **Codex is one root.** `CODEX_HOME` takes no list, so per-agent codex usage syncs from at most one config dir per run (`packages/cli/src/harness/codex/scan.ts:29`).
- **The hook writes into curia's HOME.** `sync --auto on` writes `<workspace_root>/home/.claude/settings.json` and would write `<workspace_root>/home/.codex/hooks.json` (`packages/cli/src/autosync/hook.ts:15`). Harmless today, because no agent reads either file, but it is a write into curia's HOME that the prototype should expect.
- **`@latest` through npx.** The installed hook command and the documented invocation pull the newest CLI on each run (`packages/cli/src/autosync/hook.ts:17`). A box-side timer that pins a version avoids a silent behavior change.
- **Name lint.** The machine name must be 64 printable characters or fewer, and a failing hostname is dropped, not rejected (`convex/httpCli.ts:269`, `convex/cliSessions.ts:147`).

## Sources

- aistack clone at commit `46b8028`: `packages/cli/src/` (commands, config, api, harness adapters, autosync), `convex/httpCli.ts`, `convex/cliTokens.ts`, `convex/cliSessions.ts`, `convex/measured.ts`, `convex/autoSync.ts`, `convex/crons.ts`, `convex/schema.ts`, `convex/lib/cliScopes.ts`, `convex/lib/autoSync.ts`, `convex/rateLimit.ts`, `convex/http.ts`, `src/features/settings/MachinesPage.tsx`, `packages/cli/README.md`, `packages/cli/package.json`.
- curia repo: `daemon/src/usage.mjs`, `daemon/src/transcript.mjs`, `daemon/src/workspace.mjs`, `daemon/src/dispatch.mjs`, `daemon/src/overseerturn.mjs`, `daemon/src/deploy.mjs`, `deploy/compose.yaml`.
