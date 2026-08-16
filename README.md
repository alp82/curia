# Curia

**Many repos, one queue, driven from a phone.**

Curia watches your GitHub issues, sends a coding agent at the ones that are ready, and brings
everything that needs you — a question, a preview, an approval — to whatever device you are holding.
Your box, your subscription, your repos.

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
- Survives restarts. GitHub holds the truth and the daemon rebuilds the rest.
- Runs Claude Code or Codex CLI under one contract.

## Where it stands

- First commit 2026-07-21. One person runs it. You would be the second.
- Setup is manual and takes an evening. It gets simpler. There is no package yet.
- Tailscale and Discord are required. There is no web UI.
- Attach and preview links are open to anything on your tailnet.
- Agents use your own harness login, so an agent can do what you can do with it.

# Setup

## 1. The box

Linux, always on. Node 22 or newer, tmux, Docker, Tailscale. About 0.5 GB per running agent.
For the attach surface (`attach <n>` in the browser) you also need ttyd on port 7681 — the compose
stack in step 13 runs it for you.

## 2. Tailscale

Install it on the box and on your phone. Turn on HTTPS certificates for your tailnet in the admin
console. Then let the daemon publish links without root:

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

Log in as the user that runs the daemon:

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
CURIA_AGENT_GH_TOKEN_<OWNER>=<a fine-grained GitHub PAT>
```

- `DISCORD_ALLOWED_USERS` is the whole access check. Everyone on it can send agents at your repos.
- `CURIA_AGENT_GH_TOKEN_<OWNER>` is what an agent uses to reach GitHub. Without it the agent inherits your own `gh` login, which is your whole account. Mint one [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) per resource owner you watch, with **Contents**, **Issues** and **Pull requests** read/write plus **Commit statuses** read. Put the owner in the key, uppercased: `alp82/curia` reads `CURIA_AGENT_GH_TOKEN_ALP82`.

Optional: `CURIA_GUILD_ID`, `CURIA_CHANNEL` (default `curia`), `PORT` (4271).

The overseer takes no model variable. It runs in its own container since the
cutover (#315), on `claude-sonnet-5` with no fallback, and the model is
`OVERSEER_CONTAINER_MODEL` in `daemon/src/overseerturn.mjs`.

Run one daemon per bot token.

### `daemon/.env.overseer`

```
CURIA_OVERSEER_GH_TOKEN_<OWNER>=<a fine-grained GitHub PAT, read-only>
```

The overseer runs in a container with a shell, so its own token is read-only (#313). Mint one fine-grained PAT per resource owner you watch, with **Contents**, **Issues**, **Pull requests** and **Commit statuses** at read, plus **Metadata** read. Nothing at write. An organization can cap the token lifetime, so a token for an org owner needs an expiry inside that cap.

Add `CLAUDE_CODE_OAUTH_TOKEN` here too (#327): the overseer container runs its turns on it, and it cannot read the daemon's copy. Same value as the one in `daemon/.env.daemon`.

Keep these keys in this second file. The overseer service loads the file whole, and `daemon/.env.daemon` holds the read-write tokens the overseer must never get.

## 8. `config/curia.yaml`

Change two things:

```yaml
watch:
  - repo: you/your-repo

dispatch:
  workspace_root: /home/<you>/curia-work
```

`workspace_root` is where curia keeps its own clones and worktrees. It ships as `/home/alp/curia-work`.
Do not point it at a checkout you work in.

`auto_dispatch` is `false`, so nothing starts without you. The ports work as they ship; the daemon
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

The daemon reads the tracked file, then lays the override over it. A mapping merges key by key. A
list or a scalar replaces whole. The daemon names both files at boot.

The dashboard settings screen writes the override file and never the tracked one. So a save from
your phone leaves your checkout clean, and the next `git pull` does not collide with it. You need no
override file to start. With none there, curia runs the tracked files as they ship.

## 9. The skills

The skills ship with this repo, at `skills/`. They are a vendored copy of the public
`mattpocock/skills` collection, under its MIT license — see
[skills/UPSTREAM.md](skills/UPSTREAM.md) for the pinned release and how to bump it. So there is
nothing to install: `skills.root` names `../skills`, relative to `config/curia.yaml`.

The daemon refuses to boot if a name in `skills.install` has no directory in that tree, and names
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

`deploy/compose.yaml` is a docker compose stack: the daemon, the dashboard sidecar, a tmux service
that holds the agent panes, ttyd for attach, and the overseer container. Replace the `/home/alp` paths
with yours, write `deploy/.env` with your docker group id (`DOCKER_GID=$(getent group docker | cut -d: -f3)`),
make the overseer's two trees (`mkdir -p ~/curia-work/overseer/repos ~/curia-work/cfg/curia-overseer`,
or docker makes them owned by root), then:

```
docker compose -f deploy/compose.yaml up -d --build
```

After that, deploy with `docker compose up -d --build --no-deps daemon dashboard overseer` — never a
bare `up -d`, which would recreate the tmux service and kill every live agent.

Restarting is safe. `daemon/data/events.jsonl` is the record; everything else is rebuilt from GitHub,
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

Logs are the daemon's output. Under compose: `docker compose -f deploy/compose.yaml logs -f daemon`.

## Where things are

- `CONTEXT.md` — the words curia uses.
- `docs/adr/` — the decisions behind the design.
- `daemon/src/` — the daemon itself: the dispatch loop, the Discord bridge, the MCP tools an agent
  calls.
- `config/` — the two files you edit: what curia watches, and which model each label gets. A
  `*.local.yaml` beside either one holds your box's own answers and stays out of git.
- `docs/landing-page/` — the brief, the build notes and the hosting record for <https://curia.sh>.
- `daemon/README.md` and `docs/deploy.md` — the operator's own box, not yours.
