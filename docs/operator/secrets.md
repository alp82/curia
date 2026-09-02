# Secrets, mounts, and what survives

An installed Curia keeps every long-lived credential as one owner-only file under `secrets/` in the [installation root](command-reference.md#the-installation-root), and gives each container only the directories it owns. This page is the reference for the secret files, for what each container can see, and for what a restart, an update, or an uninstall keeps. The lifecycle topics in the operator guide tell you when to act on any of it.

## The secret files

Curia owns four long-lived credentials. Each one is a file in `secrets/`, owned by you, with mode `0600`. The following table lists them.

| File | Holds | Who writes it |
|---|---|---|
| `secrets/discord-bot-token` | The Discord bot token, one line. | The Discord step of integration setup. |
| `secrets/github-app.json` | The GitHub App: `{ "id": "<app id>", "pem": "<private key>" }`. | The GitHub step of integration setup, from GitHub's manifest conversion. |
| `secrets/anthropic.json` | The Anthropic subscription credential that Curia adopted, with the instant it was adopted. | The Anthropic row of the [model provider card](integration-setup.md#connect-anthropic), or `reauth anthropic`. Both run the same `claude setup-token` session, and Curia adopts the token only after Anthropic accepts it. |
| `secrets/codex-auth.json` | The OpenAI Codex credential. | The OpenAI row of the [model provider card](integration-setup.md#connect-openai), or `reauth openai`. Both run the same `codex login --device-auth` session. Curia rewrites the file when it refreshes the credential. |

A credential reaches a consumer through a file and nothing else. It never enters an environment variable, a Compose variable, a command argument, a log line, a diagnostic, or a browser response. The service refuses to start while any of these environment variables is set: `DISCORD_BOT_TOKEN`, `CURIA_GH_APP_ID`, `CURIA_GH_APP_KEY_FILE`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`. The refusal names the variable and the secret file to use instead, and never prints the value.

Curia writes a secret file atomically: a temporary file beside the target, then one rename. A reader sees the old file or the new one. When you replace a secret by hand, write the whole file at mode `0600`. Curia refuses a secret file that is a symbolic link, that another user owns, or that the group or other users can read, and the message names the `chmod` to run.

The service reports each secret by name and presence only, in the Curia app and in `curia doctor`. No surface shows a value.

### Renewable tokens and session capabilities

Three kinds of short-lived values are not secret files, and you never manage them:

- **GitHub installation tokens.** The service mints one per repository owner from the GitHub App, about every fifty minutes. An agent's copy lands in that agent's own config directory. The overseer's copies land in `run/overseer-tokens/`, one file per owner, which the overseer container mounts read-only.
- **Model credential copies.** Every claude agent and the overseer get a copy of the Anthropic credential in their own config directory under `work/`, and every codex agent gets a copy of the Codex credential. The service rewrites a copy on its next tick whenever the secret file changes, so a replaced credential reaches a running agent or the next overseer turn with nothing restarted.
- **Agent and conversation tokens.** Each agent session and each overseer conversation gets a token that proves its name to the service. The service keeps its record under `state/`, and the session's own copy sits in that session's worktree or config directory under `work/`. It survives a restart with the session and goes away when the session ends.

### Facts beside the token

The Discord facts that are not secret live in `state/discord.json`: `allowed_users` (the Discord user IDs that may speak to Curia, which is the whole access check), `guild_id`, and `channel` (default `curia`). The Discord card of [integration setup](integration-setup.md#connect-discord) writes the file: the user ID with the token, the server and the channel on the second press. When the file names no allowed user, the service starts without the Discord bridge and says so.

The allowed operator lives in `state/tailscale.json`: the Tailscale login the [Tailscale card](integration-setup.md#connect-tailscale) recorded when you confirmed it, when it was confirmed, the machine name you expect, and the Serve routes Curia created. Under an installation root that login is the whole identity allowlist for the app and every published surface. The `identity.allow` list in `curia.yaml` admits nobody there. Until the file names an operator, the app admits the first tailnet identity that opens it, and only to **Setup**.

The setup checkpoint lives in `state/setup.json`: the selected card and a closed list of safe fields per card, never a token and never a completion marker. See [Integration setup](integration-setup.md#what-a-reopen-restores).

The routing override lives in `state/routing.local.yaml`: the routing preset a [model provider](integration-setup.md#the-routing-preset) applied when it connected, laid over the tracked `routing.yaml` that ships with the release. `config/` is read-only to the service, so this is the one routing file the service writes under an installation root. Nothing in it is a secret.

## What each container sees

Every long-running Curia process runs in a container. The following table lists what each one mounts from the installation root, at the same path inside the container as on the host. A container that isn't listed for a directory can't reach it.

| Container | Mounts from the root | Mode | Docker socket |
|---|---|---|---|
| Service (`daemon`) | `config/` | read-only | Yes |
| | `secrets/`, `state/`, `work/`, `cache/`, `run/` | read-write | |
| tmux runtime (`tmux`) | `work/`, `cache/home/` | read-write | Yes |
| Attach surface (`ttyd`) | Nothing. It reaches the tmux socket only. | | No |
| Curia app (`dashboard`) | Nothing. It reads and updates configuration through the service. | | No |
| Overseer (`overseer`) | `work/cfg/curia-overseer/`, `cache/overseer-repos/` | read-write | No |
| | `run/overseer-tokens/` | read-only | |

Only the service reaches `secrets/`, because the service is the one process that reads and replaces a credential. Only the service and the tmux runtime reach the Docker socket: the service runs agent containers, and the tmux runtime's panes run `docker run`. The overseer holds a shell, so it stays off the host network and gets neither a secret file nor a socket. Its model credential is a copy the service writes into its config directory.

An agent container gets even less: its own worktree, its own config directory with its credential copies, and the two shared caches for npm and browsers. It never sees the installation root, the Docker socket, or another agent's directories.

Every process runs with `HOME` at `cache/home/` inside the root. That directory holds tool caches and nothing Curia has to keep.

### Named Docker volumes

Curia uses named volumes for the tmux socket and for the agents' npm and browser caches. No volume holds installation identity, durable state, or resumable work. Curia can recreate every volume without losing the installation.

Every container, the Compose network, and the tmux socket volume carry the label `sh.curia.installation=<installation ID>`, so `curia purge` can find what belongs to this installation. The images, the project name, and the health checks are in [Release images and the Compose bundle](bundle.md).

## What survives

The seven directories of the root fall into two groups. `config/`, `secrets/`, `state/`, and `work/` are preserved. `versions/`, `cache/`, and `run/` are replaceable. The following table says what each operation keeps.

| Operation | Keeps | Replaces or removes |
|---|---|---|
| Service or host restart | Everything. | Stale entries under `run/`, such as a lock whose process is gone. |
| `curia update` or `curia rollback` | `config/`, `secrets/`, `state/`, `work/`. | Staged versions, caches, and runtime files. |
| `curia reinstall` | `config/`, `secrets/`, `state/`, `work/`. | `versions/`, `cache/`, `run/`. |
| `curia uninstall` | `config/`, `secrets/`, `state/`, `work/`. | Containers, networks, volumes, the launcher, `versions/`, `cache/`, `run/`. |
| `curia purge` | Nothing. | The entire root and every Curia-labelled Docker resource. |

After a restart, the service reads the same secret files, the same journal in `state/`, and the same sessions under `work/`. Running agents keep their worktrees and their credential copies. Renewable tokens under `run/` are minted again. Nothing you did through integration setup has to be repeated.

`curia uninstall` leaves the preserved directories in place, so a later `curia install` into the same root finds the same installation ID, secrets, journal, and sessions. Only `curia purge` removes them, after one confirmation. External resources, such as the GitHub App, the Discord bot, and the Tailscale node, are never deleted by Curia.
