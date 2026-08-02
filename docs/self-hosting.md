# Self-hosting curia

This is the setup path for a stranger on their own machine: your box, your GitHub account, your
Discord server, your agent subscription. Nothing here assumes the operator's box.

Two documents in this repo describe the same daemon for one specific machine — `daemon/README.md`
(what the daemon expects) and [`deploy.md`](deploy.md) (how it runs on `coinmatica.net`). Both carry
`/home/alp` paths, one hostname and one tailnet. This is the generic version of them.

## Read this first

Curia is a proof of concept that one person runs. First commit 2026-07-21. There are no other users,
no installer, no package, and no upgrade path — you clone the repo and run the daemon out of it.

Setup is manual and it takes an evening. You will install five pieces of software, create a Discord
application, authenticate two CLIs, and hand-edit two YAML files. Several of the defaults in this
repo are the operator's own paths, and you have to notice and change them; the places that bite are
called out below.

**It gets simpler.** Packaging is the obvious next step and it is not shipped. Nothing on this page
promises a command that does not exist today.

What you get for the evening: your tickets across every watched repo become one queue, a worker runs
them one at a time in its own git worktree, and every moment that needs you — a question, a preview,
a merge approval — arrives on whatever device you are holding.

## What you need before you start

**A machine that stays on.** A cheap cloud box or a machine at home. Linux. Curia is one Node
process plus one tmux session per live worker; budget about 0.5 GB per worker and about 0.3 GB per
preview dev server on top of the daemon itself. Six concurrent workers fits in 8 GB.

**Node 22 or newer**, with npm.

**tmux.** Every worker is one agent CLI process in one tmux session named `curia-<ticket>`.

**ttyd**, the browser terminal behind the `attach` verb. A static binary is enough. The attach page
curia serves is a built asset stamped with the ttyd build it was made against — `1.7.7-40e79c7` as
committed. Run a different ttyd and the daemon refuses to serve attach until you rebuild the page:

```
npm run build-attach-index --prefix daemon
```

**Tailscale**, on the box and on every device you want to answer from, with two things switched on:

- **HTTPS certificates** for your tailnet, in the Tailscale admin console. `tailscale serve --https`
  needs them. Without HTTPS certificates, attach and preview links do not publish at all.
- **`tailscale set --operator=<your-user>`**, so the daemon can run `tailscale serve` without root.

Tailscale is not optional and there is no second path. Every attach link, every timeline link and
every preview link is a Tailscale Serve rule, published to your tailnet and nowhere else.

**`gh`, authenticated**, for every repo you want watched:

```
gh auth login
gh auth setup-git
```

The daemon claims, comments, closes and merges through `gh`. It also clones through `gh`, so the
account you authenticate as needs write access to every watched repo.

**An agent CLI, logged in on the box.** Claude Code is the default backend. Log in as the user that
will run the daemon:

```
claude
```

Workers have no login of their own — they share the host's credential store at `~/.claude`, one
refresh lineage for the host and every worker. If the host is logged out, every worker and every
overseer turn fails. The cost of sharing, accepted deliberately: a worker can reach your real
credential file, so it has a host session's blast radius there. A `/logout` issued by a worker would
log you out.

Codex CLI is the second backend, and it is optional. Install it only if you want the `gpt` lane in
`config/routing.yaml`; otherwise delete that lane (see below).

**A Discord server you administer**, and a bot in it. The next section builds it.

**At least one GitHub repo to watch**, with issues enabled.

## Create the Discord bot

Discord is how curia reaches you. There is no web UI and no email path.

1. At <https://discord.com/developers/applications>, create an application.
2. Open **Bot** and add a bot. Copy the token — you paste it into `.env` in a moment, and Discord
   shows it once.
3. On the same page, switch on **MESSAGE CONTENT INTENT** under Privileged Gateway Intents. The
   bridge reads your replies as answers to open questions, so without this intent every reply
   arrives empty and no question is ever answered.
4. Open **OAuth2 → URL Generator**. Scopes: `bot` and `applications.commands`. Bot permissions:
   Manage Channels, Manage Webhooks, Send Messages, Create Public Threads, Send Messages in Threads,
   Read Message History, Embed Links, Attach Files.
5. Open the generated URL and add the bot to your server.
6. Get your own Discord user id: enable Developer Mode in Discord's settings, then right-click your
   name and Copy User ID.

You do not create the channel. On its first healthy boot the bot creates a top-level text channel
named `curia`, with no category parent — a category's permission overwrites can hide threads from
the bot, which is why it refuses to nest itself. It also registers its slash commands into that one
guild, and mints a webhook named `curia-speakers` so each worker's messages arrive under its own
name.

## Get the code

```
git clone https://github.com/alp82/curia.git
cd curia/daemon
npm install
```

The daemon runs from the clone. There is no build step and nothing is installed globally.

## Write `daemon/.env`

Create `daemon/.env` — never committed, and worth `chmod 600` since it holds a bot token:

```
DISCORD_BOT_TOKEN=<the token from step 2>
DISCORD_ALLOWED_USERS=<your Discord user id>
TTYD_BIN=/home/<you>/.local/bin/ttyd
```

Those three are the working minimum, and the third is a trap:

- **`DISCORD_BOT_TOKEN`** — omit it and the daemon runs REST-only. Escalations still open and stay
  answerable through `POST /answer`, but nothing reaches your phone.
- **`DISCORD_ALLOWED_USERS`** — a comma-separated list of Discord user ids, and the whole auth gate:
  a message from anyone else is ignored. The bridge refuses to start if it is empty. This is the
  only access control in front of the command surface, so treat the list as a list of people who may
  dispatch agents against your repos.
- **`TTYD_BIN`** — **set this.** Its built-in default is `/home/alp/.local/bin/ttyd`, one of the
  operator-box leftovers this guide exists to catch. Leave it unset under any other username and the
  daemon logs a warning, attach is down, and nothing is published.

Optional, with defaults that are fine to start:

| Key | Default | What it is |
| --- | --- | --- |
| `CURIA_GUILD_ID` | the bot's first guild | Pin the server if the bot is in more than one. |
| `CURIA_CHANNEL` | `curia` | The one channel that holds everything. |
| `PORT` | `4271` | The daemon's own HTTP surface, on loopback. |
| `NUDGE_MS` | 30 min | How often an open question is re-posted into its thread. |
| `MCP_KEEPALIVE_MS` | 60 s | Keepalive on the worker MCP stream. Load-bearing — see below. |
| `OVERSEER_MODEL` | `claude-haiku-4-5` | The model behind prose messages in `#curia`. |
| `OVERSEER_FALLBACK_MODEL` | `claude-sonnet-5` | One no-side-effect retry when the first fails. |
| `CURIA_CONFIG_DIR` | `../config` | Where the two YAML files live. |
| `CURIA_DATA_DIR` | `daemon/data` | The journal, attachments and overseer session home. |

Leave `MCP_KEEPALIVE_MS` alone unless you know why you are changing it. Claude Code aborts an MCP
tool call after 300 s of server silence, and a worker's question to you routinely blocks for hours.
The keepalive is what makes a long block survive; without it every worker dies five minutes into its
first question.

**One daemon per bot token.** Two daemons on one token fight over the same gateway connection. If
you run a service and also want to run the daemon by hand, stop the service first.

## Edit `config/curia.yaml`

The committed file is the operator's. Both YAML files are validated on load, and a bad shape refuses
the boot with a message naming the file and the key — so a mistake here costs you a restart, not a
silent misbehaviour.

**`watch`** — the repos curia reads, in order:

```yaml
watch:
  - repo: you/your-repo            # mode auto (default): map lane if the repo has one, else flat
  - repo: you/another-repo
    mode: ready-for-agent          # force the flat lane
```

Each entry takes a `mode`: `auto` (default — use the map lane if the repo holds a `wayfinder:map`
issue, otherwise the flat one), `map`, or `ready-for-agent`. The flat lane reads open issues labelled
`ready-for-agent`; the map lane reads the open, unassigned, unblocked children of every map issue.
Create the `ready-for-agent` label in any repo you want the flat lane to read — see
[`agents/triage-labels.md`](agents/triage-labels.md) for the five labels the skills speak.

**`dispatch`** — how many workers, and where they live:

```yaml
dispatch:
  auto_dispatch: false             # ships off; you dispatch by name
  max_concurrent: 6
  poll_interval_s: 60
  workspace_root: /home/<you>/curia-work   # absolute, and OWNED BY THE DAEMON
  ready_timeout_s: 45
  stop_nudge_budget: 3
```

`workspace_root` is the second operator-box leftover: the committed value is `/home/alp/curia-work`.
Point it somewhere that belongs to you, and **do not point it at a checkout you work in yourself.**
Curia creates its own base clone and per-ticket worktrees underneath it:

```
<workspace_root>/repos/<owner>__<repo>/base    the shared clone, push URL disabled
<workspace_root>/repos/<owner>__<repo>/wt/<n>  one worktree per ticket, branch curia/<n>
<workspace_root>/cfg/curia-<n>                 one agent config dir per worker
```

`max_concurrent` is a memory number, not a throughput one. A worker waiting at its review gate holds
its slot on purpose — that is the backpressure that stops a pile of unreviewed pull requests.

**`attach`, `timeline`, `preview`** — four ports and one range, all of which must differ, and the
preview range must not contain either Serve port. The daemon checks all of this at boot and names
the collision. The defaults are fine unless something else on your box already holds one:

```yaml
attach:
  ttyd_port: 7681
  serve_port: 8443
timeline:
  port: 4272
  serve_port: 8444
preview:
  port_from: 8500
  port_to: 8599
```

**`skills`** — read the next section before you touch this.

## The worker skills

**Curia does not ship the skills its workers run.** This is the sharpest edge in the whole setup, so
it gets its own section.

`config/curia.yaml` names nine skills — `wayfinder`, `grilling`, `domain-modeling`, `research`,
`prototype`, `implement`, `tdd`, `code-review`, `diagnosing-bugs` — under `skills.root`, which
defaults to `~/.claude/skills`. Curia symlinks each named skill into every worker's config dir, so a
worker resolves work in the same idiom a hand session does. **A name in the list with no
`<root>/<name>/SKILL.md` behind it refuses the boot**, naming the path it looked for. That refusal is
deliberate — a worker that silently lacks a configured skill was the failure it replaced — but on a
fresh machine it means the daemon will not start until you deal with this.

Three ways out:

1. **Install the skills.** They come from the public `mattpocock/skills` collection, into
   `~/.claude/skills`. This is what the operator runs, and `wayfinder` in particular is what the map
   lane assumes.
2. **Trim the list** to the skills you actually have. Only names present at boot may appear.
3. **Opt out explicitly** with an empty list:

   ```yaml
   skills:
     install: []
   ```

   Omitting the section is not the same thing — omission takes the full default list of nine.
   Workers then run with no installed skills, on the standing orders in their prompt alone.

Two of the nine, `wayfinder` and `implement`, carry `disable-model-invocation: true`: they are not
offered to the model, and a prompt whose **first line** is `/wayfinder` is what loads one.

Nothing else reaches a worker from the host — no `CLAUDE.md`, no permission allowlist, no MCP
connectors.

## Edit `config/routing.yaml`

This file maps a ticket's type label to a model, and a model to a CLI. No model sits in the dispatch
path; the routing is a table lookup.

```yaml
defaults:
  untyped: opus          # required — the fallback for a ticket with no type label
models:
  opus:
    provider: anthropic
    backend: claude
backends:
  claude:
    template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"'
    ready: '⏵⏵|bypass permissions'
```

Three things the validator insists on:

- **`defaults.untyped`** must exist, and every model named in `defaults` or `fallbacks` must exist in
  `models`.
- **Every backend template** must contain `{model}` and `{prompt_file}`.
- **Every backend needs a `ready` regex** — the text that appears in the tmux pane when that CLI has
  reached its composer. It is required rather than defaulted, because a marker that matches nothing
  fails silently: no worker is ever seen as ready, and the symptom is silence.

**If you did not install Codex**, delete the `gpt` model, the `codex` backend, and every mention of
`gpt` in `defaults` and `fallbacks`. A `defaults` entry pointing at a model you cannot run sends real
tickets to a CLI that is not there.

`fallbacks` are chains walked when a provider says you are out of quota. Keeping one cross-provider
hop in each chain is what stops a cooling provider from stranding a ticket.

## Prepare a repo to watch

For the **flat lane**: create the `ready-for-agent` label and put it on issues that are fully
specified. An issue is takeable when it is open, unassigned and unblocked; the assignee is the claim,
so curia assigning itself is what keeps a second worker off the same ticket.

For the **map lane**: the repo needs a `wayfinder:map` issue whose child issues are the tickets, and
it needs a **`docs/agents/issue-tracker.md`** file describing how the tracker works. Dispatch checks
for that file before it keeps the claim and refuses without it — the wayfinder skill would otherwise
follow its own instruction to fall back to a local-markdown tracker and write scratch files instead
of resolving on GitHub. Copy [`agents/issue-tracker.md`](agents/issue-tracker.md) from this repo as a
starting point.

Blocking uses GitHub's own issue dependencies, so a blocked ticket is invisible to dispatch until its
blockers close.

## First boot

```
cd daemon
npm install
npm start
```

A healthy boot logs:

```
[bridge] ready: guild=<your guild> channel=#curia
```

To verify the whole loop rather than the process: send a plain message in `#curia` — not a slash
command. A thread opens and the overseer answers in it. That one exchange proves the token, the
intent, the channel, the allow-list and the model path all work.

Then try the verbs. They work as Discord slash commands, as prose in a `#curia` thread, or as
`POST /command` on the loopback port:

- `tickets [repo]` — what is takeable across your watched repos, in dependency order.
- `start <n>` or `start repo#<n>` — claim the issue, cut a worktree, spawn a worker.
- `status` — live workers, cross-checked against tmux.
- `attach <n>` — the worker's terminal as an HTTPS link on your tailnet.
- `resume <n>` / `cancel <n>` — a fresh worker on a surviving worktree, or teardown.

A repo argument is fuzzy: any unambiguous part of a watched repo name resolves, and an ambiguous one
refuses with the candidates.

Nothing dispatches on its own — `auto_dispatch` ships `false`.

## Keep it running

[`deploy/curia.service`](../deploy/curia.service) is a systemd unit that works once you replace every
path in it. It is written for a user named `alp`:

```ini
[Service]
User=<you>
WorkingDirectory=/path/to/curia/daemon
EnvironmentFile=/path/to/curia/daemon/.env
Environment=PATH=/home/<you>/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/npm start
Restart=on-failure
RestartSec=5
```

The `PATH` line matters: the daemon shells out to `gh`, `git`, `tmux`, `tailscale`, `ttyd` and your
agent CLI, and systemd's default `PATH` finds none of the ones under `~/.local/bin`.

Restarting is cheap and safe. `data/events.jsonl` is an append-only journal and the only durable
artifact; in-memory state is a pure reduction over it, rebuilt on boot and reconciled against GitHub,
`tmux ls` and Tailscale's own Serve rules. Open questions survive a restart with their Discord
buttons still live. A restart loses the in-process call for a worker mid-dispatch, which is
re-dispatched.

`bin/deploy.sh` in this repo pushes to the operator's box over ssh. It is not a generic installer.

## When it does not boot

The daemon refuses rather than limping, so the message usually names the fix.

| What you see | What it means |
| --- | --- |
| `bad config config/curia.yaml: ...` | The named key. Validation runs before anything starts. |
| `skills.install names "x", but <path>/x/SKILL.md does not exist` | See [The worker skills](#the-worker-skills). |
| `preview range 8500-8599 contains attach.serve_port` | The preview sweep would withdraw that rule. Move one. |
| `attach index ... does not exist` / a stamp mismatch | `npm run build-attach-index --prefix daemon`. |
| `bot is in no guild` | The invite did not complete, or `CURIA_GUILD_ID` names a guild the bot is not in. |
| The bridge refuses to start | `DISCORD_ALLOWED_USERS` is empty. |
| Replies in a thread do nothing | The message-content intent is off. |
| `spawned ttyd ... but no listener came up` | `TTYD_BIN` points at nothing. |
| Attach and preview links never publish | Tailscale HTTPS certificates are off, or `--operator` was never set. |

Logs are the daemon's stdout. Under systemd: `journalctl -u curia -f`.

## What is hard today

Stated plainly, because you will hit these:

- **No installer and no package.** You clone, you edit two YAML files, and you keep the clone.
- **Committed defaults carry one person's paths.** `TTYD_BIN` and `dispatch.workspace_root` are the
  two that stop a fresh box.
- **The worker skills are not in this repo.** The daemon refuses to boot until that is resolved one
  of the three ways above.
- **Tailscale is required.** There is no public-internet path and no LAN-only path.
- **Discord is the only human surface.** No web UI, no email, no SMS.
- **Attach and preview are protected by tailnet membership alone.** Anything on your tailnet that can
  reach the box can reach a live worker's terminal. Auth in front of ttyd is a known gap.
- **A worker shares your agent credentials**, with the blast radius that implies.
- **One person has run this.** Every rough edge you find is likely new.

Setup gets simpler. Until it does, this page is the honest length of it.
