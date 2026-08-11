# Deployment: the Hetzner box

This file records one specific machine. To run curia on your own, read the
[root README](../README.md) instead.

Curia runs under docker compose on `coinmatica.net`, a Hetzner Cloud box (Ubuntu 20.04, 30 GB RAM). The box also runs the coinmatica Docker stack. Curia stays inside the `alp` user. The compose stack replaced the systemd unit on 2026-08-09 ([#259](https://github.com/alp82/curia/issues/259), [#260](https://github.com/alp82/curia/issues/260)).

## The compose stack

`deploy/compose.yaml` defines four services, all built locally, all on the host network:

| Service | Restart | Role |
| --- | --- | --- |
| `daemon` | `on-failure` | The daemon. `POST /restart` journals and exits nonzero, docker respawns it. |
| `dashboard` | `unless-stopped` | The #249 sidecar. It stays up while the daemon restarts. |
| `tmux` | `unless-stopped` | The tmux server that holds the agent panes, parked on a `keeper` session. A daemon restart never touches it. |
| `ttyd` | `unless-stopped` | The attach surface. The daemon health-checks port 7681 and does not spawn ttyd. |

**The deploy rule outranks the restart flags.** A bare `docker compose up -d` recreates any changed service, and a recreated `tmux` service kills every live agent (wayfinder #132 in compose clothes). Every deploy names its targets: `docker compose up -d --build --force-recreate --no-deps daemon dashboard`. Recreate `tmux`/`ttyd` only as a deliberate act at zero live agents.

Host trees mount into the containers at their identical paths (`/home/alp/curia`, `/home/alp/curia-work`, `~/.claude`, `~/.codex`, gh and git config). Host paths are data in this repo — `curia.yaml`, `workspace_root`, every composed `docker run -v` line — so no translation layer exists. The host docker socket and the host tailscaled socket bind-mount in: agent containers are siblings on host dockerd, and Serve state stays in host tailscaled.

`deploy/.env` (uncommitted, beside the compose file) holds one value:

```
DOCKER_GID=<output of: getent group docker | cut -d: -f3>
```

## Layout on the box

| Item | Path |
| --- | --- |
| Checkout | `/home/alp/curia` (clone of this repo) |
| Env file | `/home/alp/curia/daemon/.env.daemon` (mode 600, never committed) |
| Overseer env file | `/home/alp/curia/daemon/.env.overseer` (mode 600, never committed, #313) |
| Compose env | `/home/alp/curia/deploy/.env` (`DOCKER_GID`, never committed) |
| Box settings | `/home/alp/curia/config/curia.local.yaml`, `routing.local.yaml` (never committed) |
| Worktrees | `/home/alp/curia-work` |
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
- `CURIA_AGENT_GH_TOKEN_ALP82`, `CURIA_AGENT_GH_TOKEN_GETALFREDO` — the scoped GitHub tokens agents get as `GH_TOKEN` ([#155](https://github.com/alp82/curia/issues/155)). One per resource owner, because a fine-grained PAT has exactly one. Adding a repo to an owner already covered is an edit on the token page and does **not** change the value, so it costs no edit here and no restart. A new owner needs a new token and a new key.
- `CLAUDE_CODE_OAUTH_TOKEN` — a long-lived subscription token from `claude setup-token` (decision [#100](https://github.com/alp82/curia/issues/100)). Compose loads the file with `env_file:`, so the token reaches the daemon and flows into every agent.

## The second env file, `daemon/.env.overseer`

- `CURIA_OVERSEER_GH_TOKEN_ALP82`, `CURIA_OVERSEER_GH_TOKEN_GETALFREDO` — the overseer's own GitHub tokens ([#313](https://github.com/alp82/curia/issues/313)). One per resource owner, read-only, and 366 days or less.
- **The overseer service loads this file and never `daemon/.env.daemon`.** That is the whole reason there are two files. The overseer container holds a shell, and a shell exports whatever the container is given. `daemon/.env.daemon` carries the agents' read-write tokens and the Discord bot token, and compose cannot filter an env file.
- The daemon reads this file to state each token at boot, and never loads it into its own environment.
- Boot warns when a key that belongs in `daemon/.env.daemon` turns up here. A copy of the wrong file is the accident this catches.

**One daemon at a time.** The Discord bot token must live in exactly one running daemon. Before you start the local daemon for development, stop the service: `ssh alp@coinmatica.net docker compose -f curia/deploy/compose.yaml stop daemon`.

## Deploy

```
bin/deploy.sh
```

The script connects over ssh, pulls `main`, and runs `docker compose up -d --build --force-recreate --no-deps daemon dashboard` (`--no-deps` keeps a dependency from ever riding along). The daemon container installs its npm dependencies at start, so a dependency change needs no extra step. The script prints the two services' state on success. Override the target with `CURIA_DEPLOY_HOST`.

### The `deploy` verb

Curia also deploys itself, with no dev box in the loop ([#270](https://github.com/alp82/curia/issues/270)). Type `/deploy` in Discord, or `POST /command {"text":"deploy"}` on loopback. The overseer has no deploy tool: a typed verb is its own confirmation, and an interpreted one is refused.

The daemon cannot recreate its own container, so the verb only orders the deploy:

1. The daemon fetches `origin/main` and refuses anything that is not a fast-forward.
2. It writes `daemon/data/deploy.json`, journals `deploy_requested`, and starts a detached sibling container (`curia-deploy`, on the `curia-daemon` image) running `deploy/self-deploy.sh`.
3. The sibling merges, runs the compose deploy above, and health-checks the new daemon: `/ping` answers, still answers 10 s later, and the container has restart count zero.
4. On a failed health check the sibling runs `git reset --hard` to the previous ref and recreates again. Code runs from the repo mount, so the previous ref is a full rollback.
5. The surviving daemon reads the marker at boot, journals `deploy_landed` or `deploy_rolled_back`, announces the outcome in #curia, and deletes the marker.

The sibling logs to `daemon/data/deploy.log`. The fixed container name is the concurrency guard: a second `deploy` while one is in flight is refused. Two checkout states are refused before anything is ordered, and both need ssh: local commits `origin/main` does not have, and uncommitted changes to a tracked file. Untracked files are none of the deploy's business, which is what lets the dashboard's own override files sit in `config/` forever.

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
