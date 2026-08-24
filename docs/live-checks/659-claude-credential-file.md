# 659: the claude CLI reads a credential file, and a running agent picks up a replacement

Run on `coinmatica.net`, 2026-08-24 00:47–00:57 UTC, from a dev session. Agent image
`curia-agent:2.1.220-0.146.0-7cba0f7a`, Claude Code 2.1.220. Nothing in the live system was touched:
every run was a throwaway container against a scratch config dir, no daemon restart, no live agent
nudged, and `curia-652`, `curia-207` and `curia-625` were up throughout.

The apparatus reproduced the sandboxed shape by hand: `CLAUDE_CONFIG_DIR=/cfg` on a mounted scratch
dir, `CLAUDE_SECURESTORAGE_CONFIG_DIR` unset, the `.claude.json` and `settings.json` seeds
`workspace.mjs` writes, and `claude --dangerously-skip-permissions` in a tmux pane.

Two credentials were used. The **good** one is the box's own `CLAUDE_CODE_OAUTH_TOKEN` from
`daemon/.env.daemon`. The **expired** one is the access token in the box's host
`~/.claude/.credentials.json`, which expired on 2026-08-03 — a real, well-formed, genuinely dead
`sk-ant-oat01` token, which is what makes the negative controls worth anything.

## 1. Where the CLI looks for a credential

Each row is one `docker run`, one `claude -p 'Reply with exactly the word: PONG'`.

| # | `<cfgDir>/.credentials.json` | `CLAUDE_CODE_OAUTH_TOKEN` | result |
|---|---|---|---|
| T1 | good | — | `PONG`, exit 0 |
| T2 | — | good | `PONG`, exit 0 |
| T3 | malformed | good | `PONG`, exit 0 |
| T4 | — | — | `Not logged in · Please run /login`, exit 1 |
| T5 | good | malformed | `PONG`, exit 0 |
| T6 | malformed | — | `401 OAuth access token is invalid.`, exit 1 |
| T8 | good | **real expired** | `PONG`, exit 0 |
| T9 | — | **real expired** | `401 OAuth access token has expired.`, exit 1 |

**Settled. The CLI reads `<CLAUDE_CONFIG_DIR>/.credentials.json` in the sandboxed shape** (T1 against
T4). Dropping `CLAUDE_SECURESTORAGE_CONFIG_DIR` does not take the credential file away with it; the
CLI falls back to `CLAUDE_CONFIG_DIR`, which is already a mount, exactly as #648 hoped.

**Settled. The file beats a stale environment variable** (T8 against T9). This is not strict
precedence in either direction — T3 and T5 both succeed, so the CLI tries both sources rather than
committing to one. The consequence is what matters: **a good file rescues a dead environment
variable, and a dead file does not poison a good one.** Neither source has to be removed for the
other to work.

The credential file's md5 was unchanged after four successful authenticated runs. A `setup-token`
credential carries no refresh token, so the CLI has nothing to write back.

## 2. Does replacing the file heal a RUNNING agent?

Two runs, each: start a pane on a dead credential, send a turn, watch it fail, replace the credential
by temp-file-plus-rename, send one more turn. No restart in either — `claude` stayed PID 1 in the
container across the swap, and the container's `StartedAt` never moved.

### 2a. The file was the delivery channel

Started with the **expired token in `<cfgDir>/.credentials.json`**, no environment variable.

```
❯ Reply with exactly the word: PONG1
● Please run /login · API Error: 401 OAuth access token has expired. Re-authenticate to continue.
```

Credential replaced at 00:52:52Z, pid unchanged, 85 s of process uptime. Then one more turn:

```
❯ Reply with exactly the word: PONG2
● PONG1
  PONG2
```

### 2b. The environment variable was the delivery channel — today's shape

Started the way the daemon spawns a claude agent **now**: the expired token as
`CLAUDE_CODE_OAUTH_TOKEN`, no credential file at all. Turn 1 died on the same 401. A good
`.credentials.json` was then written into the agent's already-mounted config dir, while the expired
variable stayed in the process's environment — verified by reading `/proc/1/environ` inside the
container afterwards, and confirming it still held the expired token and not the good one. Then one
more turn:

```
❯ Reply with exactly the word: PONG2
● PONG1
  PONG2
```

**Settled. Freeze in place works for claude**, and #644's "settled by construction" is wrong: it
inferred from `modelCredential` handing over an environment variable that no channel could reach a
running process, and the credential *file* is such a channel.

**Settled, and bigger than the ticket asked. An agent spawned by today's code can be healed without
being respawned.** The heal does not need the agent to have been started with a file, and it does not
need the environment variable dropped first. #648 does not have to kill the claude agents that
predate it.

The claude lane also comes out **better than codex on the conversation**: the failed turn's user
message was retained and answered on resume — both panes replied `PONG1` and `PONG2`. Codex, in #644,
resumed the conversation but had already discarded the dead turn.

It needs a nudge, the same as codex and for the same reason: a turn that dies leaves the agent idle
at the composer and nothing restarts it.

## 3. Where `claude setup-token` puts what

`claude setup-token` has **no options** beyond `--help`. There is no flag that prints the token alone.

Run once with stdout redirected to a file, once without.

**Redirected (`claude setup-token > /out/stdout.txt`): the tmux pane was completely empty.** The file
held 2597 bytes of a redrawing TUI — ANSI escapes, a spinner, repeated `Welcome to Claude Code
v2.1.220` frames, the authorize URL as an OSC 8 hyperlink, and the `Paste code here if prompted >`
prompt.

**Unredirected: the pane showed the whole flow** — `Browser didn't open? Use the url below to sign in
(c to copy)`, the URL, and the prompt.

**Settled (#660). The redirect is not viable.** The URL and the prompt do not go to the terminal while
the token goes to stdout; *everything* goes to stdout, so `claude setup-token > store` hands the
operator a blank pane and the store a TUI transcript. #660 needs a stream-splitting wrapper or a pane
scrape, and both face the same last step — the token has to be picked out of a rendered TUI frame
either way, which makes the pane scrape the cheaper of the two rather than the last resort.

Two traps for whoever builds it:

- **The URL is line-wrapped by the terminal**, at 160 columns in this run. Any scrape must dewrap
  before the URL is usable, and the OSC 8 hyperlink wrapper has to come off.
- **`setup-token` writes no credential file.** After the abandoned flow the scratch config dir held
  `.claude.json` and nothing else. **ADR-0027's completion rule — the credential file appearing — has
  nothing to detect on this lane**, exactly as #659 suspected. Completion has to be the token
  appearing, or the process exiting 0.

The authorize URL requests `scope=user:inference` alone. That is the bound #180 bought, visible in
the request, and it supports the map's refusal of a `/login` credential for agent containers.

## What was not measured

- **The token's own stream at completion.** The flow was abandoned at the paste prompt — no browser
  was driven. That the whole TUI is on stdout is measured; that the token lands there among the
  frames is inference.
- **The daemon's real dispatch path.** These containers were built by hand. The environment, the
  mounts and the config seeds were replicated from `workspace.mjs` and `sandbox.mjs`, but there was no
  MCP side channel, no Stop hook, no git worktree and no daemon in the loop.
- **A long-lived process.** Both healed panes were about two minutes old at the swap. Nothing suggests
  the CLI caches the credential differently after hours, and nothing here rules it out.
- **A swap during an in-flight request.** Both swaps happened while the pane sat idle at the composer,
  which is the state a credential death actually leaves it in.
- **The revoked case, and any anthropic refresh.** Still open, and a `setup-token` credential has no
  refresh path to test.
