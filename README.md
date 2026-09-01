# Curia

**Run Matt Pocock's wayfinder from your phone.**

Curia watches the maps and issues in all your GitHub repositories, sends coding agents at the work
that is ready, and brings every question, preview, and approval to your phone. Your box, your
subscription, your repositories.

The page is <https://curia.sh>. It makes the same promise to a reader who has not cloned anything
yet. This file sets curia up on your machine, and shows you around the code.

## What it does

- Reads what is takeable across every watched repo, in dependency order.
- Sends an agent with one command: claims the issue, cuts a worktree, picks the model by label.
- Runs each agent in its own tmux session and git worktree. Six at once fits in 8 GB.
- Asks you questions in Discord and waits. Buttons, text, and images both ways.
- Publishes an agent's dev server as an HTTPS link on your tailnet, so you see the result.
- Puts a live agent's terminal in your browser, phone or desktop, at the same time.
- Ends every ticket the same way: commit, pull request, preview, your approval, merge.
- Survives restarts. GitHub holds the truth and the service rebuilds the rest.
- Runs Claude Code or Codex CLI under one contract.

## Where it stands

- First commit 2026-07-21. One person runs it. You would be the second.
- Setup is manual and takes an evening. It gets simpler. There is no package yet.
- Tailscale and Discord are required. The Curia app gives you a browser view of your maps, agents, and
  operator conversations.
- Attach and preview links are open to anything on your tailnet.
- Agents use your own harness login, so an agent can do what you can do with it.

# Setup

## 1. The box

Linux, always on. Node 22 or newer, tmux, Docker, Tailscale. About 0.5 GB per running agent.
For the attach surface (`attach <n>` in the browser) you also need ttyd on port 7681 — the compose
stack in step 13 runs it for you.

## 2. Tailscale

Install it on the box and on your phone. Turn on HTTPS certificates for your tailnet in the admin
console. Then let the service publish links without root:

```
tailscale set --operator=$USER
```

Every attach and preview link is a Tailscale link. Skip this and none of them work.

## 3. GitHub

```
gh auth login
gh auth setup-git
```

The account needs write access to every repo you watch.

## 4. Your harness (Claude Code, or Codex)

Log in as the user that runs the service:

```
claude
```

Agents use this login. Log out and every agent fails.

Codex CLI is optional. Install it only if you want the `gpt` entry in `config/routing.yaml`.

## 5. The Discord bot

1. Create an application at <https://discord.com/developers/applications>.
2. Open **Bot**, add a bot, copy the token. Discord shows it once.
3. Turn on **MESSAGE CONTENT INTENT**. Without it your replies arrive empty and no question is ever
   answered.
4. Open **OAuth2 → URL Generator**. Scopes: `bot`, `applications.commands`. Permissions: Manage
   Channels, Manage Webhooks, Send Messages, Create Public Threads, Send Messages in Threads, Read
   Message History, Embed Links, Attach Files.
5. Open the generated URL and add the bot to your server.
6. Turn on Developer Mode in Discord, right-click your name, Copy User ID.

The bot creates the `#curia` channel itself on its first boot.

## 6. The code

```
git clone https://github.com/alp82/curia.git
cd curia/daemon
npm install
```

## 7. `daemon/.env.daemon`

```
DISCORD_BOT_TOKEN=<the bot token>
DISCORD_ALLOWED_USERS=<your Discord user id>
CURIA_GH_APP_ID=<the app id>
CURIA_GH_APP_KEY_FILE=.curia-app.pem
```

- `DISCORD_ALLOWED_USERS` is the whole access check. Everyone on it can send agents at your repos.
- **The GitHub App is how curia reaches GitHub, and a dispatch needs it.** Create one app under your own account, install it on each owner you watch, and grant it the repos. An agent then mints its own one-hour token per ticket, commits as your app's bot, and nothing you make by hand expires. See [docs/github-app.md](docs/github-app.md).
- A mint that fails refuses the dispatch and releases the ticket. There is no PAT behind it: `CURIA_AGENT_GH_TOKEN_*` retired on [#466](https://github.com/alp82/curia/issues/466), and a key still in the file is a live token with no job.

Optional: `CURIA_GUILD_ID`, `CURIA_CHANNEL` (default `curia`), `PORT` (4271).

This env file belongs to the source deployment only. An installed Curia keeps each credential as one owner-only file under `secrets/` in its installation root and the Discord facts in `state/discord.json`, and refuses to start with a credential in its environment. See [Secrets, mounts, and what survives](docs/operator/secrets.md).

The overseer takes no model variable. It runs in its own container since the
cutover (#315), on `claude-sonnet-5` with no fallback, and the model is
`OVERSEER_CONTAINER_MODEL` in `daemon/src/overseerturn.mjs`.

Run one service per bot token.

### `daemon/.env.overseer`

```
CLAUDE_CODE_OAUTH_TOKEN=<the same value as in daemon/.env.daemon>
```

One key, and that is the whole file (#392). The overseer container runs its turns on this credential and cannot read the service's copy, so it needs its own line. The overseer service loads this file whole and never `daemon/.env.daemon`, which holds the read-write tokens the overseer must never get.

The overseer runs in a container with a shell, so its own GitHub token is read-only (#313) — **Contents**, **Issues**, **Pull requests** and **Commit statuses** at read, plus **Metadata** read, and nothing at write. You mint none of it by hand: the service mints one token per resource owner from the GitHub App and writes it where the container reads it (#392). Set the app up ([docs/github-app.md](docs/github-app.md)) and install it on each owner you watch. An owner the app is not installed on reads public repositories only, and the overseer says so in the chat.

## 8. `config/curia.yaml`

Change two things:

```yaml
watch:
  - repo: you/your-repo

dispatch:
  workspace_root: /home/<you>/curia-work
```

`workspace_root` is where curia keeps its own clones and worktrees. It ships as `/home/alp/curia-work`.
Do not point it at a checkout you work in. Under the compose stack it also holds curia's own `HOME`,
at `home/` inside it, and `deploy/.env` states the same path a second time — see step 13.

`auto_dispatch` is `false`, so nothing starts without you. The ports work as they ship; the service
checks them at boot and names any clash.

### The override file

Git tracks `config/curia.yaml` and `config/routing.yaml`. Beside each one you may put an override
file that git ignores: `config/curia.local.yaml` and `config/routing.local.yaml`. It holds only what
your box answers differently.

```yaml
# config/curia.local.yaml
dispatch:
  max_concurrent: 3
```

The service reads the tracked file, then lays the override over it. A mapping merges key by key. A
list or a scalar replaces whole. The service names both files at boot.

The Curia app settings screen writes the override file and never the tracked one. So a save from
your phone leaves your checkout clean, and the next `git pull` does not collide with it. You need no
override file to start. With none there, curia runs the tracked files as they ship.

## 9. The skills

The skills ship with this repo, at `skills/`. They are a vendored copy of the public
`mattpocock/skills` collection, under its MIT license — see
[skills/UPSTREAM.md](skills/UPSTREAM.md) for the pinned release and how to bump it. So there is
nothing to install: `skills.root` names `../skills`, relative to `config/curia.yaml`.

The service refuses to boot if a name in `skills.install` has no directory in that tree, and names
the path it looked for.

To use your own set instead, point `skills.root` at it. The path may be absolute, may start with
`~`, or may be relative to `config/curia.yaml`. Then pick one:

- Keep the nine names, if your set carries them.
- Cut the list down to the ones you have.
- Turn them off with an empty list — not a missing key:

  ```yaml
  skills:
    install: []
  ```

## 10. `config/routing.yaml`

Maps a ticket label to a model, and a model to a CLI. If you did not install Codex, delete the `gpt`
model, the `codex` harness, and every `gpt` under `defaults` and `fallbacks`.

## 11. The repos you watch

- **Flat**: label an issue `ready-for-agent`. Curia takes open, unassigned, unblocked issues.
- **Map**: the repo needs a `wayfinder:map` issue with child issues, and a
  `docs/agents/issue-tracker.md` file. Dispatch refuses without that file.

Blocking uses GitHub's own issue dependencies.

## 12. Run it

```
cd daemon
npm start
```

A good boot logs `[bridge] ready: guild=<your guild> channel=#curia`.

Test it: send a normal message in `#curia`. A thread opens and answers you.

Then use the commands, as Discord slash commands or as plain English in a thread:

- `tickets` — what is takeable
- `start <n>` — send an agent. On a map number, this sends one to the map's next takeable ticket.
- `map <n> <what should change>` — send an agent that updates the map itself. Leave the sentence off and the agent asks you what should change.
- `map <what to chart>` — send an agent with no map. It settles the destination with you, then creates the map issue itself. Name the repo first (`map alp82/curia <what to chart>`) when more than one is watched. The first word is the repo only when it is a watched repo's own name.
- `status` — who is running
- `attach <n>` — that agent's terminal in your browser
- `resume <n>` / `cancel <n>`

An agent that no ticket answers for gets a handle instead of a number — `chat-1`, `chat-2` — and the
three verbs above take it: `attach chat-1`, `cancel chat-1`, `resume chat-1`. `status` lists it.

## 13. Keep it running

`deploy/compose.yaml` is a docker compose stack: the service, the app sidecar, a tmux service
that holds the agent panes, ttyd for attach, and the overseer container. You edit no committed file.
Write `deploy/.env` beside it, with your docker group id and the two roots the stack mounts:

```
DOCKER_GID=<output of: getent group docker | cut -d: -f3>
CURIA_REPO_ROOT=/home/you/curia
CURIA_WORKSPACE_ROOT=/home/you/curia-work
```

Both roots fall back to the paths of the box curia is written on, so a box that leaves them out
mounts `/home/alp`. `CURIA_WORKSPACE_ROOT` must be the same path as `dispatch.workspace_root` from
step 8. The service refuses to boot when the two disagree, because a workspace root nothing mounts is
worktrees written inside a container and lost on the next deploy.

**The stack runs on curia's own home, and never yours.** `HOME` in every container is
`$CURIA_WORKSPACE_ROOT/home`, so no container reads your `~/.claude`, `~/.codex`, `~/.config/gh` or
`~/.gitconfig`. Make the trees, and log in where curia reads them (docker makes a missing tree owned
by root, which is why these come first):

```
export W=/home/you/curia-work
mkdir -p $W/home $W/overseer/repos $W/cfg/curia-overseer
HOME=$W/home gh auth login && HOME=$W/home gh auth setup-git
HOME=$W/home git config --global user.name "you" && HOME=$W/home git config --global user.email "you@example.com"
```

Copying `~/.claude`, `~/.codex` and `~/.config/gh` into `$W/home` works too, and is what an existing
install does. The model credential itself comes from `daemon/.env.daemon`, so a fresh install needs
no `claude` login in that tree. Then:

```
docker compose -f deploy/compose.yaml up -d --build
```

After that, deploy with `docker compose up -d --build --no-deps daemon dashboard overseer` — never a
bare `up -d`, which would recreate the tmux service and kill every live agent.

Restarting is safe. `daemon/data/events.db` is the record; everything else is rebuilt from GitHub,
tmux and Tailscale on boot. Open questions keep their Discord buttons across a restart.

## If it does not start

| Message | Fix |
| --- | --- |
| `bad config config/curia.yaml: ...` | The key it names. Config is checked before anything starts. |
| `skills.install names "x", but ... does not exist` | Step 9. |
| `preview range ... contains attach.serve_port` | Move one of the ports. |
| `attach index ... does not exist`, or a stamp mismatch | `npm run build-attach-index --prefix daemon` |
| `bot is in no guild` | The invite did not finish, or `CURIA_GUILD_ID` is wrong. |
| The bridge refuses to start | `DISCORD_ALLOWED_USERS` is empty. |
| Replies in a thread do nothing | The message content intent is off. |
| `Speaker identities are off` in `#curia` | The bot role lacks Manage Webhooks. Grant it on the role, or as a `#curia` channel override. Agent prose keeps posting under the bot voice until you do. |
| `no listener on ttyd port ...` | Nothing serves port 7681. Start the compose ttyd service, or your own ttyd. |
| Attach and preview links never appear | Tailscale HTTPS certificates are off, or `--operator` was never set. |

Logs are the service's output. Under compose: `docker compose -f deploy/compose.yaml logs -f daemon`.

## Where things are

- `CONTEXT.md` — the words curia uses.
- `docs/adr/` — the decisions behind the design.
- `daemon/src/` — the service itself: the dispatch loop, the Discord bridge, the MCP tools an agent
  calls.
- `config/` — the two files you edit: what curia watches, and which model each label gets. A
  `*.local.yaml` beside either one holds your box's own answers and stays out of git.
- `docs/landing-page/` — the brief, the build notes and the hosting record for <https://curia.sh>.
- `daemon/README.md` and `docs/deploy.md` — the operator's own box, not yours.
