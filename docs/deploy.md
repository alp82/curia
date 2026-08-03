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
