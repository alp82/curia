# 9. Uninstall or purge

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · [4. Run the Test run](04-run-the-test-run.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · **9. Uninstall or purge (this topic)**
- **When something fails:** [Troubleshooting](troubleshooting.md)

Curia has two removals. The following table says which one you want.

| You want to | Run |
|---|---|
| Stop Curia and free the host, and come back later to the same installation with the same integrations, history, and unfinished work. | [Uninstall](#uninstall) |
| Remove every local trace and start over, or leave the host clean. | [Purge](#purge) |

Neither removal touches the GitHub App, the Discord bot and channel, the Tailscale node, or the model-provider logins. Deleting a local credential file never revokes it. Both commands print the external resources with the page where you remove each one.

## Uninstall

**Outcome:** Curia stopped and its runnable footprint removed from the host, with the installation identity, configuration, secrets, history, and resumable work preserved for a reinstall.

**Starting state:** An installed Curia, up or down. No running work you need to finish: the command doesn't wait for agents, drain them, or salvage anything. Cancel or let them finish first.

**Active operator time:** About 1 minute.

### What the uninstall keeps

- **Kept:** `config/`, `secrets/`, `state/`, and `work/`, with the installation ID. No integration has to be set up again after a reinstall, and sessions under `work/` resume.
- **Removed:** the launcher, the contents of `versions/`, `cache/`, and `run/`, every container, network, and volume that carries this installation's label, and Curia's own Tailscale Serve route. Nothing without the label is touched.
- **Left for a purge:** the release images.

The full table is in [What is preserved](../uninstall.md#what-is-preserved).

### Do this

```sh
curia uninstall
```

The command takes no options and asks no question. It prints four named steps, `[1/4] preflight`, `[2/4] docker`, `[3/4] routes`, and `[4/4] files`. What each step removes is in [What `curia uninstall` does](../uninstall.md#what-curia-uninstall-does).

### What you should see

```text
Curia is uninstalled. The installation at /home/you/.local/share/curia is preserved.
  kept:      config/, secrets/, state/, work/ (installation 3f9c...: configuration, secrets, history, and resumable work)
  removed:   the launcher, versions/, cache/, run/, and the installation's containers, networks, volumes, and Serve routes
  images:    kept; 'curia purge' removes them
  reinstall: curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh --version 1.2.3
  stable:    curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh
  purge:     curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh --purge --version 1.2.3
  The reinstall and purge lines name version 1.2.3, the one uninstalled, so they work whether or not a stable release is named.
  The stable line installs the current stable release instead, and refuses while the index names none.
```

The `reinstall` and `purge` lines name the version the installation record still holds, so they work as printed and bring back the release you uninstalled. Run the `stable` line instead to move to the current stable release. See [What the command prints](../uninstall.md#what-the-command-prints).

Below it, `External resources Curia never deletes` lists the GitHub App ID, the Discord server and channel, and the Tailscale machine name, for you. `docker compose -p curia ps` lists nothing.

### If it fails

The message names the step and the rerun. Run `curia uninstall` again: every step reads what is there before it removes it, so the rerun removes what is left and skips what is gone. When the `files` step fails after the launcher is gone, the message says to reinstall with the bootstrap and uninstall again, or to empty `versions/`, `cache/`, and `run/` by hand. The failures by message are under [Uninstall](troubleshooting.md#uninstall) in Troubleshooting.

### Reinstall from the preserved root

On the same host, as the same user, run the bootstrap again:

```sh
curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh --version 1.2.3
```

Name the version the uninstall printed to get the release you uninstalled back. Without `--version` the bootstrap takes the current stable release, and refuses while the signed index names none. Pass the same `--root <dir>` the uninstall printed for a nondefault root. `curia install` recognizes the installation record and reinstalls over it: the same installation ID, `config/`, `secrets/`, `state/`, and `work/`, the version you named under `versions/`, the launcher, and the project started. It ends with every service healthy and the app address. Nothing in integration setup has to be repeated, and the service creates its Serve route again when the Tailscale card is next read. The rollback release is gone, so `curia rollback` refuses until the next `curia update`. Confirm with `curia doctor`.

### Next

Reinstall as described, or [purge](#purge) the preserved root.

## Purge

**Outcome:** No trace of this installation on the host: no root, no launcher, no labelled Docker resource, no Curia Serve route, and no unused release image. A report of the external resources that remain yours to remove.

**Starting state:** An installed Curia with its launcher, or a root that `curia uninstall` preserved. For the second case, or a host whose installed version can't run, the bootstrap's purge mode is the command.

**Active operator time:** About 2 minutes, plus the external cleanup you do afterwards from the report.

### What the purge deletes

Everything local, with no way back: your configuration (`config/`), credentials (`secrets/`), history (`state/`), and unfinished work (`work/`), the installed versions, caches, and runtime files, the launcher, the installation's containers, networks, and volumes, the release images that nothing else on the host uses, and Curia's Serve route. An agent's worktree with uncommitted changes goes with `work/`. Copy out anything you want to keep before you confirm, or run `curia uninstall` instead.

Not deleted: the GitHub App, the Discord bot and channel, the Tailscale node, the model-provider logins, the agent image the service built (`curia-agent:<pins>`), and any image a container still uses. Deleting the local secret files revokes nothing.

### Do this

From the launcher:

```sh
curia purge
```

The command prints the exact root with the warning, then asks `Type the installation root to confirm, or anything else to stop:`. Type the root exactly as printed. `yes`, a trailing slash, or a different case stops the command with nothing changed. From a script or a session without a terminal, pass the root instead:

```sh
curia purge --confirm /home/you/.local/share/curia
```

When the launcher is gone, run the bootstrap's purge mode, which asks the same question:

```sh
curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh --purge --version 1.2.3
```

Name the version the uninstall printed, the way the uninstall's `purge` line does: the purge needs a lifecycle interface, and after an uninstall there is none under `versions/` to run. Without `--version` the bootstrap acquires the stable release the index names, and refuses while it names none. Add `--root <dir>` for a nondefault root, the same root the uninstall printed. With no `--root`, the default root is purged. Without a terminal, add `--confirm <root>` here too: the bootstrap passes it to `curia purge`, and the value must be the root being purged.

```sh
bash curia-install.sh --purge --version 1.2.3 --root /srv/curia --confirm /srv/curia
```

The bootstrap runs the interface the root already holds, under `versions/<active>/`, and verifies it before it runs it, so it downloads nothing. After a `curia uninstall`, which empties `versions/`, it acquires and verifies one instead: the release `--version` names, or the stable release the index names when you name none. See [Purge from the bootstrap](../purge.md#purge-from-the-bootstrap).

The command prints six named steps, `[1/6] preflight`, `[2/6] confirm`, `[3/6] docker`, `[4/6] routes`, `[5/6] images`, and `[6/6] root`. The root goes last. What each step removes is in [What `curia purge` does](../purge.md#what-curia-purge-does).

### What you should see

```text
Curia is purged. The installation root /home/you/.local/share/curia is removed.
  removed:   the root with config/, secrets/, state/, and work/, the launcher, the installation's containers, networks, and volumes, and 4 release images
  reinstall: a later install starts a new installation with a new ID; the removed one cannot come back
```

Below it, the external report names the GitHub App ID, the Discord server and channel, the Tailscale node and its Serve route, and the model-provider logins, each with the page where you remove it. An image Docker kept because a container still uses it is reported under `[5/6] images` and isn't a failure.

### If it fails

A refusal at `confirm` means you didn't confirm, and nothing changed. A failure names the step and the rerun. Run the command again and confirm again: every step reads what is there before it removes it, and the installation record is the last file to go, so a rerun still finds the installation. After the launcher is gone the rerun is the bootstrap's purge mode. The failures by message are under [Purge](troubleshooting.md#purge) in Troubleshooting.

### Next

Work through the external report: delete or keep the GitHub App under [GitHub Apps settings](https://github.com/settings/apps), reset or delete the bot in the [Discord developer portal](https://discord.com/developers/applications), remove the node in the [Tailscale admin console](https://login.tailscale.com/admin/machines), and sign out of the providers if you won't reinstall. A later bootstrap starts a new installation with a new ID, from [2. Install Curia](02-install-curia.md), and can reuse the same App, bot, and node.
