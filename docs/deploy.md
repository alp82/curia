# Deployment: the Hetzner box

This file records one specific machine. To run curia on your own, read the
[root README](../README.md) instead.

Curia runs under docker compose on `coinmatica.net`, a Hetzner Cloud box (Ubuntu 20.04, 30 GB RAM). The box also runs the coinmatica Docker stack. Curia stays inside the `alp` user. The compose stack replaced the systemd unit on 2026-08-09 ([#259](https://github.com/alp82/curia/issues/259), [#260](https://github.com/alp82/curia/issues/260)).

## The compose stack

`deploy/compose.yaml` defines five services, all built locally from the `box` stage of their Dockerfiles (the `release` stage after it is the published image, see [Release images and the Compose bundle](operator/bundle.md)). Four run on the host network:

| Service | Restart | Role |
| --- | --- | --- |
| `daemon` | `on-failure` | The daemon. `POST /restart` journals and exits nonzero, docker respawns it. |
| `dashboard` | `unless-stopped` | The #249 sidecar. It stays up while the daemon restarts. |
| `tmux` | `unless-stopped` | The tmux server that holds the agent panes, parked on a `keeper` session. A daemon restart never touches it. |
| `ttyd` | `unless-stopped` | The attach surface. The daemon health-checks port 7681 and does not spawn ttyd. |
| `overseer` | `unless-stopped` | The overseer container (#327, [ADR-0015](adr/0015-the-overseer-is-a-service.md)). On the docker bridge, published on `127.0.0.1:4274`. The daemon health-checks it and spawns nothing. |

**The deploy rule outranks the restart flags.** A bare `docker compose up -d` recreates any changed service, and a recreated `tmux` service kills every live agent (wayfinder #132 in compose clothes). Every deploy names its targets: `docker compose up -d --build --force-recreate --no-deps daemon dashboard overseer`. Recreate `tmux`/`ttyd` only as a deliberate act at zero live agents. Recreating the overseer kills no agent.

**The overseer is the one service off the host network.** It holds a shell, and on the host network that shell reaches the daemon's loopback surface, ttyd, the identity proxy and the tailscaled socket. On the bridge it reaches none of them. It reaches the daemon at `host.docker.internal`, the way an agent container does, and the daemon reaches it on the published loopback port.

Host trees mount into the containers at their identical paths. Host paths are data in this repo — `curia.yaml`, `workspace_root`, every composed `docker run -v` line — so no translation layer exists. The host docker socket and the host tailscaled socket bind-mount in: agent containers are siblings on host dockerd, and Serve state stays in host tailscaled.

**The compose file names no path of this box** ([#473](https://github.com/alp82/curia/issues/473)). Two variables carry the roots, and both fall back to this box's answers, so this box states neither. A curia on another VPS writes them in its own `deploy/.env` and edits no committed file.

**Curia runs on its own home, not the `alp` user's.** `HOME` in every container is `home/` inside the workspace root. The four trees the stack used to take out of `/home/alp` — `.claude`, `.codex`, `.config/gh`, `.gitconfig` — live in there now, and no mount reaches into the operator's home. The workspace mount carries it, so it needs no mount of its own.

`deploy/.env` (uncommitted, beside the compose file) holds one value on this box:

```
DOCKER_GID=<output of: getent group docker | cut -d: -f3>
```

`DOCKER_GID` has no default: the docker group id differs per box, and a guess is a group that grants nothing or too much. The two roots do have defaults, and these are them:

| Key | Default | What it is |
| --- | --- | --- |
| `CURIA_REPO_ROOT` | `/home/alp/curia` | The checkout |
| `CURIA_WORKSPACE_ROOT` | `/home/alp/curia-work` | `dispatch.workspace_root`, and curia's `HOME` at `home/` inside it |

`CURIA_WORKSPACE_ROOT` and `dispatch.workspace_root` are the same fact written twice, so compose hands the value back to every container that reads the config, and the daemon refuses to boot when the two disagree. That refusal exists because the failure is otherwise silent: the daemon writes its worktrees where no mount covers, they land inside the container, and the next recreate throws them away.

## Layout on the box

| Item | Path |
| --- | --- |
| Checkout | `/home/alp/curia` (clone of this repo) |
| Env file | `/home/alp/curia/daemon/.env.daemon` (mode 600, never committed) |
| Retired overseer env file | `/home/alp/curia/daemon/.env.overseer` (remove after deleting legacy keys, #726) |
| Compose env | `/home/alp/curia/deploy/.env` (`DOCKER_GID`, never committed) |
| Box settings | `/home/alp/curia/config/curia.local.yaml`, `routing.local.yaml` (never committed) |
| Worktrees | `/home/alp/curia-work` |
| Curia's HOME | `/home/alp/curia-work/home` (#473; the containers read no `/home/alp` tree) |
| Skills | `/home/alp/curia/skills` (vendored in the checkout, #268) |
| tmux socket | `/run/curia-tmux/default` inside the `tmux-sock` volume |
| Claude Code | `/home/alp/.local/bin/claude` (host copy; agents run the containerized pin) |

The committed config (`config/curia.yaml`) hardcodes `/home/alp/...` paths. The box mirrors the dev box username, so the committed config works unchanged.

## The two config layers, and a clean `git status`

Git tracks `config/curia.yaml` and `config/routing.yaml`. The dashboard settings screen does **not** write them ([#292](https://github.com/alp82/curia/issues/292)). It writes `config/curia.local.yaml` and `config/routing.local.yaml` beside them, and `.gitignore` holds those out of the checkout. The daemon reads the tracked file, then lays the override over it. A mapping merges key by key. A list or a scalar replaces whole.

The override holds only what this box answers differently. A value that comes back to the tracked answer is dropped from the override. An override file that holds nothing is removed. The daemon names both files at boot:

```
config: curia.yaml + curia.local.yaml (overrides: dispatch, watch)
```

**On an ordinary day `git status` on the box is clean.** That is the point of the split. A save from the phone leaves the checkout clean. So a dirty tree means one thing: somebody hand-edited a tracked file on the box. Fix that over ssh.

The `deploy` verb refuses a dirty tree and names the files. It must. A deploy fast-forwards, and `git merge --ff-only` refuses to overwrite a local change. The sibling reads that refusal as a failed deploy and runs `git reset --hard`, which discards the edit and says nothing.

To change a setting on this box, edit the override file. To change what curia ships, edit the tracked file in this repo and deploy it.

**The `identity:` section is required** (#151, [ADR-0011](adr/0011-tailscale-identity-in-front-of-every-attach-surface.md)). The daemon refuses to boot without it, naming the key. `identity.allow` lists the tailscale logins that may reach the attach and timeline surfaces — the `Tailscale-User-Login` that Serve stamps, which is the account login, not the node name. Read yours with:

```
tailscale status --json | jq -r '.User[].LoginName'
```

Getting it wrong 403s every attach. Fixing it is an edit plus a restart, over ssh, so a wrong list locks nobody out of the box.

## The env file, `daemon/.env.daemon`

**This file was called `daemon/.env` until [#313](https://github.com/alp82/curia/issues/313).** There is one env file per container that holds secrets now, so the pair reads as a pair. Rename it on the box **before** you deploy that change:

```
mv /home/alp/curia/daemon/.env /home/alp/curia/daemon/.env.daemon
```

Compose refuses a missing `env_file`, so a deploy that arrives first fails its health check and rolls back. The running daemon is not touched in between: its environment is already in the process.

- `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS` — copied from the dev box.
- `CURIA_AGENT_GH_TOKEN_*` is **retired** ([#466](https://github.com/alp82/curia/issues/466)). An agent mints its own token from the GitHub App, and nothing reads these keys. A key still in this file is a live read-write PAT with no job, and boot names it: delete the line, then revoke the token on GitHub. A dispatch now needs the app. A mint that fails refuses it and releases the ticket, and adding a watched repo means granting it on the installation rather than editing a token.
- `CURIA_GH_APP_ID`, `CURIA_GH_APP_KEY_FILE` — the GitHub App ([ADR-0018](adr/0018-the-daemon-is-a-github-app.md)). The key itself is a file beside this one, `daemon/.curia-app.pem` at mode 0600, and the deploy copies it the way it copies the env files. The operator's own steps are [docs/github-app.md](github-app.md).
- `CLAUDE_CODE_OAUTH_TOKEN` is **retired** ([#726](https://github.com/alp82/curia/issues/726)). Delete the line. The daemon reads the provider store only.

## The retired env file, `daemon/.env.overseer`

- `CLAUDE_CODE_OAUTH_TOKEN` is **retired** ([#726](https://github.com/alp82/curia/issues/726)). Delete the line. The overseer reads the provider store per turn.
- **The overseer service loads no env file.** Its GitHub and model credentials arrive through separate read-only mounts.
- `CURIA_OVERSEER_GH_TOKEN_*` is **retired** ([#392](https://github.com/alp82/curia/issues/392)). The daemon mints the overseer's read-only token from the GitHub App and writes it into the tokens tree below. A key still in this file is a live PAT with no job, and boot names it: delete the line, then revoke the token on GitHub.
- The daemon reads an existing file for deletion warnings. Remove the file after you delete every legacy key.

## Curia's own home, and the one-time move into it

**Do this on the box BEFORE you deploy [#473](https://github.com/alp82/curia/issues/473).** `HOME` moves from `/home/alp` to `/home/alp/curia-work/home`, and nothing copies the credentials for you. A deploy that lands first leaves the daemon with no `gh` auth, no git identity and no codex login, and every dispatch fails on the tracker call.

```
ssh alp@coinmatica.net 'W=~/curia-work; mkdir -p $W/home/.config
  cp -a ~/.gitconfig $W/home/
  cp -a ~/.claude ~/.codex $W/home/
  cp -a ~/.config/gh $W/home/.config/'
```

Then deploy. The four trees are curia's own from that point, and the copies left in `/home/alp` are the operator's to keep or delete.

**`tmux` and `ttyd` keep the old `HOME` until they are recreated**, because no deploy names them. Little rides on it: the daemon hands a pane every path it needs as an absolute one, and it writes each worktree's git identity itself. Recreate the pair at the next zero-agent window anyway, with the command under [Deploy](#deploy), so no container is left describing a home that is not curia's.

Two things stop being shared, both on purpose:

- The usage probe's attempt stamp, which the operator's own `statusline.sh` used to throttle against ([#146](https://github.com/alp82/curia/issues/146)). The two now read separate caches.
- The claude credential a **pane** agent runs on ([#34](https://github.com/alp82/curia/issues/34), [#53](https://github.com/alp82/curia/issues/53)). It is one refresh lineage inside curia's home, and a host `claude` session on the box is another.

The Discord bot token, the model credential and the GitHub App key are unaffected: they are env files under the checkout, and no home holds them.

## The overseer container's four host trees

Docker creates a missing bind-mount source as **root**, and every curia container runs as uid 1000. So make all four trees before the first `up`. Without them the container cannot write its checkouts, and the daemon cannot write the tokens or the model credential:

```
ssh alp@coinmatica.net 'mkdir -p ~/curia-work/overseer/repos ~/curia-work/overseer/tokens ~/curia-work/credentials ~/curia-work/cfg/curia-overseer'
```

`bin/deploy.sh` and the self-deploy sibling make these on every deploy, along with `curia-work/home`, so this is the first-`up` step rather than a repeated one.

All four mount at their identical paths inside. One mount line covers every watched repo, because the watch list changes and the compose file is static — the set of clones inside the tree moves with the config ([#312](https://github.com/alp82/curia/issues/312)).

`overseer/tokens` mounts **read-only** and holds one file per resource owner, and nothing else ([#392](https://github.com/alp82/curia/issues/392)). The daemon writes it on the dispatch tick, so the value turns over about every fifty minutes. A `permission denied` for that path in the daemon log means docker made the directory first. Fix it with `sudo chown -R 1000:1000 ~/curia-work/overseer/tokens`.

`credentials/` is the daemon's model-credential store, one file per provider ([#648](https://github.com/alp82/curia/issues/648)). Since [#867](https://github.com/alp82/curia/issues/867) it is **not mounted** into the overseer: the daemon writes the overseer a copy into `cfg/curia-overseer/.credentials.json`, the same file every claude agent gets, when it prepares a pane and on every tick. Replacing the model credential still reaches the next turn with nothing recreated. Same `permission denied` fix for the store itself: `sudo chown -R 1000:1000 ~/curia-work/credentials`.

The `ttyd` service holds no Docker socket since #867 either. It runs `tmux attach` over the socket volume and nothing else. Recreate `tmux`/`ttyd` at the next zero-agent window to apply that.

**The packaged installation uses a different Compose file.** `deploy/bundle/compose.yaml` is the shape an installed Curia runs on: every mount is a boundary of the installation root, no env file exists, and the four long-lived credentials are files under `secrets/`. That file is what the versioned bundle packages and `curia install` starts. This box keeps running on `deploy/compose.yaml` and `daemon/.env.daemon` until its cutover, and [The source cutover runbook](operator/source-cutover-runbook.md) moves the env file's values into secret files, with `deploy/cutover/cutover.mjs` doing the mechanical steps. See [Secrets, mounts, and what survives](operator/secrets.md) and [8. Migrate the current deployment](operator/guide/08-migrate-the-current-deployment.md). This file and the READMEs are the contributor's documentation; the [operator guide](operator/README.md) is for an installed Curia.

### The model credential moves to the store

`credentials/anthropic.json` is the only Anthropic credential source ([#726](https://github.com/alp82/curia/issues/726)). The Credentials screen accounts for that store.

For a new box or a lost store, start the daemon and run `reauth anthropic`. The browser flow verifies and adopts the credential.

Keep `daemon/.env.daemon`, because compose loads the daemon's own secrets from that file. Remove `daemon/.env.overseer` after deleting its legacy keys.

`ANTHROPIC_API_KEY` is read nowhere. The map settled subscription-only, and #648 removed the branch from both readers that preferred it, so a key still in an env file is a box paying metered rates for nothing. The boot names that one too.

**One daemon at a time.** The Discord bot token must live in exactly one running daemon. Before you start the local daemon for development, stop the service: `ssh alp@coinmatica.net docker compose -f curia/deploy/compose.yaml stop daemon`.

## Deploy

```
bin/deploy.sh
```

The script connects over ssh, pulls `main`, and runs `docker compose up -d --build --force-recreate --no-deps daemon dashboard overseer` (`--no-deps` keeps a dependency from ever riding along). The daemon container installs its npm dependencies at start, so a dependency change needs no extra step. The script prints the three services' state on success. Override the target with `CURIA_DEPLOY_HOST`.

### The `deploy` verb

Curia also deploys itself, with no dev box in the loop ([#270](https://github.com/alp82/curia/issues/270)). Type `/deploy` in Discord, or `POST /command {"text":"deploy"}` on loopback. The overseer has no deploy tool: a typed verb is its own confirmation, and an interpreted one is refused.

`daemon/package.json` contains Curia's release version. [Release Please](https://github.com/googleapis/release-please) updates it and `daemon/package-lock.json` from the conventional pull-request title that reaches `main` through a squash merge:

- `fix:` selects a patch release.
- `feat:` selects a minor release.
- `feat!:` selects a major release.

When the release pull request merges, Release Please drafts the release, and the rest of the same workflow (`.github/workflows/release.yml`) publishes the version in order: it builds and pushes the five release images (the four services and the agent image), renders the Compose bundle against the service digests and the release manifest against all five, attaches them to the draft, publishes the release (which creates the tag), and publishes `@curia-sh/cli` last. Which published version installations run is a separate act, the stable-release index, in [Releases, the stable-release index, and version selection](operator/releases.md). This box doesn't consume those artifacts until its cutover.

The `open_pull_request` tool produces these titles from its `release_level` argument. The pull-request title workflow rejects titles that don't select a release. Release Please then opens or updates one release pull request with the version files and `daemon/CHANGELOG.md`. Merge that release pull request before you deploy. Until it merges, `main` still has the old version and the deploy gate refuses it.

A self-deploy refuses `origin/main` when its version is malformed, unchanged, or lower than the running version. Git commit IDs remain internal rollback references. Discord, the dashboard, the journal projection, and the deploy log identify releases by version.

### One-time release automation setup

The release workflow uses the existing Curia GitHub App. It doesn't use a personal access token. Add these values in the `alp82/curia` repository settings:

1. Add the app's client ID as the Actions variable `CURIA_RELEASE_APP_CLIENT_ID`. The client ID is on the app's **General** page and differs from the numeric app ID.
2. Add the app's PEM private key as the Actions secret `CURIA_RELEASE_APP_PRIVATE_KEY`.
3. Set the repository's allowed merge method to squash only.
4. Set the default squash commit title to the pull-request title.

The app keeps **Workflows** at **No access**. Release Please only changes the version files and changelog after this workflow is on `main`. Curia agents still can't add or edit workflow files.

The publication of images, the bundle, the package, and the stable-release index needs more one-time setup: the signing key, the npm trusted publisher, the `release` environment, immutable releases, and public GHCR packages. The list is [One-time setup](operator/releases.md#one-time-setup).

The release manifest starts at `0.2.0`. Its `bootstrap-sha` excludes repository history before this automation change. Remove `bootstrap-sha` from `release-please-config.json` after the first release pull request merges.

The daemon cannot recreate its own container, so the verb only orders the deploy:

1. The daemon fetches `origin/main` and refuses anything that is not a fast-forward or a version increase.
2. It writes `daemon/data/deploy.json`, journals `deploy_requested`, and starts a detached sibling container (`curia-deploy`, on the `curia-daemon` image) running `deploy/self-deploy.sh`.
3. The sibling merges, runs the compose deploy above, and health-checks the new daemon: `/ping` answers, still answers 10 s later, and the container has restart count zero.
4. On a failed health check the sibling runs `git reset --hard` to the previous ref and recreates again. Code runs from the repo mount, so the previous ref is a full rollback.
5. The surviving daemon reads the marker at boot, journals `deploy_landed` or `deploy_rolled_back`, announces the outcome in #curia, and deletes the marker.

The sibling logs to `daemon/data/deploy.log`. The fixed container name refuses a second `deploy` while one runs.

Before it reads the checkout, the deploy preflight checks the active `github.com` login in curia's HOME. It refuses the deploy if `gh auth status` cannot verify the login.

Local commits and uncommitted changes to a tracked file also cause a refusal before the deploy order. Both states need ssh. An untracked file causes a refusal when `origin/main` adds different content at the same path. The preflight removes a byte-identical copy and records the removal. Other untracked files do not cause a refusal. This rule lets the dashboard keep its override files in `config/`.

Both paths were proven live on 2026-08-10: the verb rolled back a deliberate boot crash on its own, and then landed the revert as a real deploy.

The deploy never names `tmux` or `ttyd`. To recreate those two, wait for zero live agents, then:

```
ssh alp@coinmatica.net 'cd curia && docker compose -f deploy/compose.yaml up -d --build tmux ttyd'
```

## The agent sandbox image

Agents run in one Docker container each ([#148](https://github.com/alp82/curia/issues/148)). They share one image, built on the box from `deploy/agent/Dockerfile`:

```
ssh alp@coinmatica.net 'cd curia && npm run build-agent-image --prefix daemon'
```

The image tag is a content address over the Dockerfile and the pins in `config/curia.yaml` (`sandbox:`), so the command is a no-op when the image is already there. The daemon runs the same build itself when a dispatch wants a container and the tag is missing, which is what makes a version bump in that config enough on its own. Pass `--force` to rebuild against today's apt and npm without changing a pin.

A cold build takes about four minutes and the image is about 1.6 GB. Two Docker volumes hold what stays out of it: the npm cache and the Playwright browsers.

**The `alp` user must be in the `docker` group, and the containers join it too.** The Docker socket is root-owned. The compose services reach it through `group_add: ${DOCKER_GID}`. Host-side, `alp` keeps the membership from [#181](https://github.com/alp82/curia/issues/181):

```
sudo usermod -aG docker alp     # as root, once
```

This grants `alp` root on the box, because anyone who can reach the socket can mount `/` into a container. That is the accepted cost of rootful Docker. Rootless Docker does not replace it here: it maps a container uid to a subordinate host uid, so an agent running as uid 1000 could not write the clone the daemon bind-mounts, and the container-root that does map to `alp` is the one user Claude Code refuses to run as.

The agent itself never reaches the socket. It is denied inside the container, which is the whole point of the boundary.

**The firewall must let a container reach the daemon.** The box runs ufw with a default-deny
INPUT policy, and an agent's side channel — `ask_human`, the Stop hook, every curia tool —
goes from the container to the daemon over the docker bridge. Without a rule the traffic is
dropped, not refused, so the agent hangs instead of failing. Done on 2026-08-04
([#185](https://github.com/alp82/curia/issues/185)):

```
sudo ufw allow in on docker0 from 10.0.1.0/24 to 10.0.1.1 port 4271 proto tcp \
  comment 'curia agent side channel'
```

Read the bridge subnet and the gateway off the box first — `docker network inspect bridge` and
`ip -4 addr show docker0`. This box states no `Gateway` field, and `docker0` carries `10.0.1.1/24`.

This rule is host state. No file in this repo carries it, so a rebuilt box needs it again.

**The overseer needs its own rule.** The overseer container is not on `docker0`: compose puts it
on the `curia_default` network, which this box carved out of the next pool block, `10.0.2.0/24`.
Its MCP seam — the verb tools of every turn — goes to the daemon at `host.docker.internal:4271`,
and without a rule that traffic is dropped the same silent way. The symptom is a turn that runs
but holds no `start` tool, because Claude Code drops an unreachable MCP server without a word.
Done on 2026-08-16, keyed on the subnet because the `br-…` interface name embeds the network id
and dies on a network recreate:

```
sudo ufw allow from 10.0.2.0/24 to 10.0.1.1 port 4271 proto tcp \
  comment 'curia overseer mcp'
```

Read the subnet off the box first — `docker network inspect curia_default`. Compose does not pin
it, so a rebuilt box may get a different block. This rule is host state too.

Since [#188](https://github.com/alp82/curia/issues/188) the daemon no longer trusts the rule to
be there. Every sandboxed dispatch first binds the gateway, then sends one throwaway container
at `GET /ping`, and refuses the dispatch if the answer does not come back. A **timeout** in that
refusal names this rule. A **refused connection** means the traffic arrives and the daemon is
not listening. Check the rule by hand the same way:

```
docker run --rm --add-host host.docker.internal:host-gateway --entrypoint curl \
  $(docker images --format '{{.Repository}}:{{.Tag}}' | grep curia-agent | head -1) \
  -sS -m 5 http://host.docker.internal:4271/ping
```

## Logs

```
ssh alp@coinmatica.net docker compose -f curia/deploy/compose.yaml logs -f daemon
```

Add `--tail 200` for history. A healthy boot logs `ready: guild=<guild> channel=#curia`.

## Service control

```
ssh alp@coinmatica.net docker compose -f curia/deploy/compose.yaml restart daemon
ssh alp@coinmatica.net docker compose -f curia/deploy/compose.yaml stop daemon
ssh alp@coinmatica.net docker compose -f curia/deploy/compose.yaml ps
```

A daemon stop or restart leaves `tmux`, `ttyd` and every agent pane running. Boot reconcile re-adopts the live sessions.

## One-time provisioning record

Done on 2026-08-01, as root unless noted:

1. Created user `alp`, copied the ssh authorized key, added the user to `systemd-journal`.
2. Installed Node 22.17.1 from the official tarball into `/opt`, symlinked into `/usr/local/bin` (host copy; the containers pin their own).
3. Installed `gh` 2.76.1 from the release deb. Authenticated as `alp` with a token from the dev box (`gh auth login --with-token`, then `gh auth setup-git`).
4. Installed `ttyd` 1.7.7 (static binary) to `/home/alp/.local/bin/ttyd` (retired 2026-08-09 — ttyd runs in its container now).
5. Installed tailscale 1.98.10 from the official apt repo. Removed a stale NodeSource apt source that broke `apt-get update`. Set `tailscale set --operator=alp` so the daemon can run `tailscale serve`.
6. Installed Claude Code (native installer) as `alp`.
7. Cloned the repo, ran `npm install` in `daemon/`, created `~/curia-work`, rsynced the nine agent skills.
8. Wrote `/etc/sudoers.d/curia` and installed the unit (both retired 2026-08-09 by the compose cutover, #260).
9. HITL: `tailscale up` approved in the browser. `claude setup-token` ran on the dev box, token pasted into the env file.

Compose cutover, done on 2026-08-10 as `alp` ([#260](https://github.com/alp82/curia/issues/260)):

1. Installed the compose v2 plugin, v2.39.2, to `~/.docker/cli-plugins/docker-compose` — the box's docker 20.10 ships without it.
2. Wrote `deploy/.env` with the box's `DOCKER_GID` (998).
3. At zero live agents: `sudo /bin/systemctl stop curia`, `tmux kill-server`, killed the old detached ttyd, removed a stale agent container.
4. `docker compose -f deploy/compose.yaml up -d --build`.
5. Retired `/etc/systemd/system/curia.service`, its `multi-user.target.wants` symlink, and `/etc/sudoers.d/curia` through a root container, then `systemctl daemon-reload` through `nsenter` — the sudoers grant was too narrow to remove itself, and docker-group root is the box's accepted model.
6. Proved: a session on the shared socket survives a daemon restart, and `bin/deploy.sh` leaves `tmux`/`ttyd` untouched.
