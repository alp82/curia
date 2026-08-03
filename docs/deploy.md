# Deployment: the Hetzner box

This file records one specific machine. To run curia on your own, read the
[root README](../README.md) instead.

Curia runs as a systemd service on `coinmatica.net`, a Hetzner Cloud box (Ubuntu 20.04, 30 GB RAM). The box also runs the coinmatica Docker stack. Curia stays inside the `alp` user and its own systemd unit. Ticket: [#101](https://github.com/alp82/curia/issues/101).

## Layout on the box

| Item | Path |
| --- | --- |
| Checkout | `/home/alp/curia` (clone of this repo) |
| Env file | `/home/alp/curia/daemon/.env` (mode 600, never committed) |
| Worktrees | `/home/alp/curia-work` |
| Skills | `/home/alp/.claude/skills` (rsync from the dev box) |
| Unit file | `/etc/systemd/system/curia.service` (copy of `deploy/curia.service`) |
| Node 22 | `/usr/local/bin/node` (tarball in `/opt`) |
| ttyd | `/home/alp/.local/bin/ttyd` |
| Claude Code | `/home/alp/.local/bin/claude` |
| Codex | `/home/alp/.local/bin/codex` |

The committed config (`config/curia.yaml`) hardcodes `/home/alp/...` paths. The box mirrors the dev box username, so the committed config works unchanged.

**The `identity:` section is required** (#151, [ADR-0011](adr/0011-tailscale-identity-in-front-of-every-attach-surface.md)). The daemon refuses to boot without it, naming the key. `identity.allow` lists the tailscale logins that may reach the attach and timeline surfaces — the `Tailscale-User-Login` that Serve stamps, which is the account login, not the node name. Read yours with:

```
tailscale status --json | jq -r '.User[].LoginName'
```

Getting it wrong 403s every attach. Fixing it is an edit plus a restart, over ssh, so a wrong list locks nobody out of the box.

## The env file

Three keys:

- `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS` — copied from the dev box.
- `CLAUDE_CODE_OAUTH_TOKEN` — a long-lived subscription token from `claude setup-token` (decision [#100](https://github.com/alp82/curia/issues/100)). The unit loads the file with `EnvironmentFile`, so the token reaches the daemon and flows into every worker.

**One daemon at a time.** The Discord bot token must live in exactly one running daemon. Before you start the local daemon for development, stop the service: `ssh alp@coinmatica.net sudo /bin/systemctl stop curia`.

## Deploy

```
bin/deploy.sh
```

The script connects over ssh, pulls `main`, installs daemon dependencies, copies the unit file, and restarts the service. It prints `active` on success. Override the target with `CURIA_DEPLOY_HOST`.

The `alp` user holds narrow sudo rights (`/etc/sudoers.d/curia`): copy the unit file, `daemon-reload`, and `start`/`stop`/`restart` of `curia` only.

## The worker sandbox image

Workers run in one Docker container each ([#148](https://github.com/alp82/curia/issues/148)). They share one image, built on the box from `deploy/worker/Dockerfile`:

```
ssh alp@coinmatica.net 'cd curia && npm run build-worker-image --prefix daemon'
```

The image tag is a content address over the Dockerfile and the pins in `config/curia.yaml` (`sandbox:`), so the command is a no-op when the image is already there. The daemon runs the same build itself when a dispatch wants a container and the tag is missing, which is what makes a version bump in that config enough on its own. Pass `--force` to rebuild against today's apt and npm without changing a pin.

A cold build takes about four minutes and the image is about 1.6 GB. Two Docker volumes hold what stays out of it: the npm cache and the Playwright browsers.

**The daemon user must be in the `docker` group.** The Docker socket is root-owned, and `alp` holds no sudo right that reaches it:

```
sudo usermod -aG docker alp     # as root, once
```

This grants `alp` root on the box, because anyone who can reach the socket can mount `/` into a container. That is the accepted cost of rootful Docker. Rootless Docker does not replace it here: it maps a container uid to a subordinate host uid, so an agent running as uid 1000 could not write the clone the daemon bind-mounts, and the container-root that does map to `alp` is the one user Claude Code refuses to run as.

The worker itself never reaches the socket. It is denied inside the container, which is the whole point of the boundary.

## Logs

```
ssh alp@coinmatica.net journalctl -u curia -f
```

Add `-n 200` for history. A healthy boot logs `ready: guild=<guild> channel=#curia`.

## Service control

```
ssh alp@coinmatica.net sudo /bin/systemctl restart curia
ssh alp@coinmatica.net sudo /bin/systemctl stop curia
ssh alp@coinmatica.net systemctl status curia
```

## One-time provisioning record

Done on 2026-08-01, as root unless noted:

1. Created user `alp`, copied the ssh authorized key, added the user to `systemd-journal`.
2. Installed Node 22.17.1 from the official tarball into `/opt`, symlinked into `/usr/local/bin`.
3. Installed `gh` 2.76.1 from the release deb. Authenticated as `alp` with a token from the dev box (`gh auth login --with-token`, then `gh auth setup-git`).
4. Installed `ttyd` 1.7.7 (static binary) to `/home/alp/.local/bin/ttyd`.
5. Installed tailscale 1.98.10 from the official apt repo. Removed a stale NodeSource apt source that broke `apt-get update`. Set `tailscale set --operator=alp` so the daemon can run `tailscale serve`.
6. Installed Claude Code (native installer) as `alp`.
7. Cloned the repo, ran `npm install` in `daemon/`, created `~/curia-work`, rsynced the nine worker skills.
8. Wrote `/etc/sudoers.d/curia` and installed the unit.
9. HITL: `tailscale up` approved in the browser. `claude setup-token` ran on the dev box, token pasted into the env file.
