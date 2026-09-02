# 2. Install Curia

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · **2. Install Curia (this topic)** · [3. Connect services](03-connect-services.md) · [4. Run your first Full loop](04-run-your-first-full-loop.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

**Outcome:** This host on your tailnet as a named node, the stable release installed under the installation root, the `curia` launcher on your path, five services healthy, and the address of the Curia app on your tailnet.

**Starting state:** The host from [1. Check prerequisites](01-check-prerequisites.md), logged in as the user who will own the installation. No Curia installation on the host. To reinstall over a root that `curia uninstall` preserved, this is still the command; see [Reinstall from the preserved root](09-uninstall-or-purge.md#reinstall-from-the-preserved-root).

**Active operator time:** About 4 minutes, one of them approving the machine in Tailscale. The downloads (the lifecycle interface, the pinned Node.js runtime, the Compose bundle, and four container images) wait 2 to 10 minutes on the connection, and the health wait is up to 4 minutes. Neither is active work.

## What the command changes

On a fresh host there is nothing to preserve. The command logs the host in to your tailnet as a node named `curia` (or the name you pass), creates the installation root, `~/.local/share/curia` by default, with seven directories owned by you at mode `0700`, writes one file outside the root, the launcher at `~/.local/bin/curia`, and starts one Docker Compose project named `curia`. It asks for no privileges and changes nothing else on the host. A node that is already logged in keeps its name. Over a preserved root it reinstalls and keeps the installation ID, `config/`, `secrets/`, `state/`, and `work/`.

## Do this

Download the bootstrap to a file, then run it:

```sh
curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh
```

Don't pipe `curl` into `bash`. The script refuses to run from a pipe, because it can't check that a piped copy downloaded completely.

To name the node something other than `curia` on your tailnet, add `--name <machine-name>`: lowercase letters, digits, and hyphens. To install into another directory, add `--root <absolute path>` once. The root is written into the launcher, and you never pass it again. To install an exact version instead of the stable release, add `--version <version>`. The options are in [The bootstrap](../bootstrap.md#the-command).

The script prints its own version, downloads every artifact into one temporary stage, proves each one against the registry, nodejs.org, the release manifest, and the signed stable-release index, and then hands off to `curia install`, which prints seven named steps:

```text
[1/7] preflight
[2/7] root
[3/7] tailnet
[4/7] stage
[5/7] activate
[6/7] start
[7/7] health
```

What each step does is in [What `curia install` does](../install.md#what-curia-install-does).

## Approve the machine in Tailscale

At `[3/7] tailnet`, when the host isn't logged in to your tailnet yet, the command joins it and prints one link:

```text
this node is not logged in to a tailnet; joining it as curia
Open this link on a device where you are signed in to Tailscale and approve this machine:
  https://login.tailscale.com/a/...
waiting for the login (up to 10 minutes)
```

Open the link on any device where you're signed in to Tailscale, such as your laptop or phone, and approve the machine. The command continues on its own once the node is running. This is the one moment in the installation that needs you: the Curia app is reachable only through Tailscale, so the login can't wait for the browser.

When the host is already logged in, the step reports the node's name and address instead and asks nothing. The tailnet step doesn't rename a node. If the name isn't the one you passed, the step says so and continues with the actual name; rename it later from the **Node name** field of the Tailscale card, run `sudo tailscale set --hostname <name>` on the host, or pass `--name <actual name>` next time. The step is described in [The tailnet step](../install.md#the-tailnet-step).

## What you should see

The command ends with the installation root, the launcher, and one line that starts with `Next: open the Curia app at https://<your node's MagicDNS name>:8445/`. Keep that address. Then confirm from the launcher:

```sh
curia version
docker compose -p curia ps
```

`curia version` prints the lifecycle interface version, the same version as active, and the root. `docker compose -p curia ps` lists `daemon`, `tmux`, `ttyd`, `dashboard`, and `overseer` as `healthy`. `tailscale status` lists this node as online under the name the `tailnet` step reported. If the app answers a refusal in the first seconds after the install, wait a moment and reload: the app reads who it admits from the service, and it keeps asking until the service answers.

## If it fails

The message names the step, the cause, one corrective action, and the command that reruns the step:

```text
curia install: health failed: daemon exited with code 1. Read its log with 'docker compose --env-file /home/you/.local/share/curia/run/compose.env -f /home/you/.local/share/curia/versions/1.2.3/bundle/compose.yaml logs daemon', fix the cause, and run the command again.
Run '/home/you/.local/bin/curia install' to run health again; the completed steps are kept.
```

Do the action, then run the command the second line names. Before the launcher exists that command is the bootstrap again; after it exists it's `curia install`. Every step checks what is already there, so the rerun repeats the quick steps and does the work of the one that failed. There is no progress record to clear and no repair mode.

A refusal (exit code `3`) changes nothing. Preflight names the host condition and its action, for example a port another program holds or a Docker daemon your user can't reach. The `tailnet` step refuses when your user may not operate Tailscale (`sudo tailscale set --operator=$USER`) or when the tailnet issues no HTTPS certificate (enable HTTPS certificates under **DNS** in the admin console). Remove the condition and run the bootstrap again. The conditions by message are under [Install](troubleshooting.md#install) in Troubleshooting.

## Next

[3. Connect services](03-connect-services.md). Nothing in it needs the terminal.
