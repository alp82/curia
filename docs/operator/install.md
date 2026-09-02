# Install and reinstall

`curia install` turns a verified stage into a running Curia: this host on your tailnet as a named node, one installed version under the installation root, the stable launcher, the Compose project up, and every service healthy. `curia reinstall` runs the same sequence over a root that already holds an installation and keeps everything that installation owns. This page is the reference for both commands: the steps, what each one changes, what a reinstall preserves, what a failure looks like, and how you retry. [2. Install Curia](guide/02-install-curia.md) in the operator guide is where you run the installation, and [The bootstrap](bootstrap.md) is what starts it; this page tells you what happens after the hand-off.

## What `curia install` does

The bootstrap hands off to `curia install` with the installation root in `CURIA_ROOT`, the verified stage in `CURIA_STAGE`, and the `--name` you gave it. The command then runs seven named steps in order and prints each one as `[n/7] <step>`. The following table lists them.

| Step | What it does | What it changes |
|---|---|---|
| 1. `preflight` | Checks the installation root as [When a lifecycle command refuses the root](command-reference.md#when-a-lifecycle-command-refuses-the-root) describes, then runs the host checks in [Supported hosts and preflight checks](supported-hosts.md). | Nothing. A refusal here leaves no root and no launcher. |
| 2. `root` | Creates the root and its seven directories, or recognizes the installation that is there. Takes the lifecycle lock, which it holds until the command ends. Writes the installation record, and on a fresh root the initial operator configuration (`max_concurrent: 4`). | The root, `state/installation.json`, and `config/config.yaml` on a fresh root only. |
| 3. `tailnet` | Finds the node logged in to your tailnet and reports its name and MagicDNS address, or joins the tailnet now under the name `--name` gave it and prints the login link. Then checks that your user may use Tailscale Serve and that the tailnet issues the node's HTTPS certificate. See [The tailnet step](#the-tailnet-step). | The node's tailnet login, when it wasn't logged in. Nothing on disk. |
| 4. `stage` | Verifies the staged artifacts against the release manifest, as [What Curia verifies before activation](release-manifest.md#what-curia-verifies-before-activation) describes, and copies the runtime, the lifecycle interface, the retained artifacts, and the unpacked bundle into `versions/<version>/`. The copy lands in a sibling directory first and moves into place in one step. Installed files are read-only. | `versions/<version>/`, replaced whole if it was there. |
| 5. `activate` | Writes the record with the version as `activeVersion` and writes the launcher at `~/.local/bin/curia`. Removes every other directory under `versions/`, so one release is installed. | `state/installation.json`, the launcher, `versions/`. |
| 6. `start` | Writes `run/compose.env` with the five run-time values from [The bundle](bundle.md#the-bundle), creates the directories the containers mount so Docker never creates one as root, pulls the five images by digest (the four the bundle names through Compose, and the agent image the release manifest binds), and brings the project up. | `run/compose.env`, directories under `cache/`, `run/`, and `work/`, and the Docker images, containers, network, and volume. |
| 7. `health` | Waits until every service reports healthy, as [Health checks](bundle.md#health-checks) describes. A service that exits or turns unhealthy fails the step at once. A service still starting after four minutes fails it too. | Nothing. |

On success the command prints the installation root, the launcher, the node name, and the address of the Curia app on your tailnet, `https://<your node's MagicDNS name>:8445/`, and tells you the next action: open the app and start integration setup. Nothing in integration setup needs the terminal again. See [Integration setup](integration-setup.md).

## The tailnet step

The Curia app is reachable only through Tailscale Serve, so the login to your tailnet can't happen in the browser. It happens on the terminal, inside `curia install`, before anything is downloaded, so nothing lands on a host you can't reach.

The node's name is a decision you make before the install command runs, because the Curia app is served under it from the moment it starts and nothing in the app changes it later:

1. Choose the name. The default is `curia`. The name must be a MagicDNS label: lowercase letters, digits, and hyphens, up to 63 characters, not starting or ending with a hyphen.
2. The address of the Curia app follows from it: `https://<name>.<tailnet>.ts.net:8445/`.
3. Pass it as `--name <machine-name>` to the bootstrap or to `curia install`. Anything else is a usage error before anything runs. The bootstrap takes the same option and hands it through; see [The bootstrap](bootstrap.md#the-command).

The step prints the chosen name first, `the node name is <name>, chosen with --name`, then reads the node and does one of two things:

- **The node is logged in.** The step reports its name and MagicDNS address and changes nothing. When the node's name isn't the one `--name` asked for, the step says so as a fact and that the existing name wins, and it continues with the actual name. Curia never renames a node. To use the name you asked for, run `sudo tailscale set --hostname <name>` on the host and run the command again, or run the command again with `--name <actual name>`.
- **The node isn't logged in.** The step runs `tailscale up --hostname <name>` and prints the one action:

  ```text
  Open this link on a device where you are signed in to Tailscale and approve this machine:
    https://login.tailscale.com/a/...
  waiting for the login (up to 10 minutes)
  ```

  Open the link on any device where you're signed in to Tailscale and approve the machine. The step polls the node until it's running, then continues. When no login arrives within 10 minutes, the step fails; run the command again and it lands at the same step.

To change the name after the install, reinstall with another `--name`, or run `sudo tailscale set --hostname <name>` on the host and then restart Curia, from **Restart Curia** on the Tailscale card or with `docker compose -p curia restart`. The app's sidecar reads the hosts it serves when it starts, so a rename under a running app answers `Host <new name> is not a name this box serves` until the restart. The Tailscale card shows the name and address as facts and has no field; see [Connect Tailscale](integration-setup.md#connect-tailscale).

Then, in both cases, the step checks two facts and refuses with exit code `3` when one is missing:

| Refusal | Corrective action |
|---|---|
| `tailnet: your user may not operate Tailscale on this host` | Run `sudo tailscale set --operator=$USER` on the host, then run the command again. The refusal names your user in the command. Without the operator permission, `tailscale up` and Tailscale Serve are refused for your user. |
| `tailnet: the tailnet issues no HTTPS certificate for this node` | Enable HTTPS certificates under **DNS** in the [Tailscale admin console](https://login.tailscale.com/admin/dns), then run the command again. Serve can't publish the Curia app without one. |

The step never installs Tailscale. Installing the package is a prerequisite, as [The prerequisites you install](supported-hosts.md#the-prerequisites-you-install) describes, because Curia never installs software on the host.

`curia reinstall`, `curia update`, and `curia rollback` run the same step in its inspect-only form: they report the node and check the two facts, and a node that isn't logged in is a refusal that names `curia install`. None of them logs a node in.

The version `curia install` installs is always the version of the lifecycle interface that runs it. The bootstrap runs the staged package, so the version it downloaded is the version installed. Installing another version is `curia update`; see [Update discovery, staging, and the switch](update.md).

## What `curia reinstall` does

`curia reinstall` runs the same seven steps over a root that already holds an installation, with the `tailnet` step inspect-only. It refuses a root that holds none. Use it when the installed version's files, the Compose project, or the launcher are damaged and the installation itself is fine.

A reinstall keeps the installation ID, `config/`, `secrets/`, `state/`, and `work/`. It replaces `versions/` and rewrites `run/compose.env`, and it leaves `cache/` alone. Containers are recreated only where the bundle changed. Nothing you did through integration setup has to be repeated, and running work under `work/` resumes. The complete survival table is in [What survives](secrets.md#what-survives).

The bootstrap always hands off `curia install`, even over a preserved root. `curia install` recognizes the installation record and reinstalls, so running the bootstrap again after `curia uninstall` restores the same installation; see [Reinstall from the preserved root](uninstall.md#reinstall-from-the-preserved-root). The one difference between the two commands is that `curia reinstall` refuses when there is nothing to reinstall.

To reinstall from the installed launcher, run:

```sh
curia reinstall
```

Without `CURIA_STAGE`, the `stage` step verifies the artifacts already under `versions/<version>/` instead of copying a stage. To reinstall from a fresh download, run the bootstrap again.

## When a step fails

A step that fails stops the command with exit code `1` and a message that names the step:

```text
curia install: health failed: daemon exited with code 1. Read its log with 'docker compose --env-file /home/you/.local/share/curia/run/compose.env -f /home/you/.local/share/curia/versions/1.2.3/bundle/compose.yaml logs daemon', fix the cause, and run the command again.
Run '/home/you/.local/bin/curia install' to run health again; the completed steps are kept.
```

The first line says which step failed and why, and gives the one corrective action. The second line gives the command that reruns the step. Before the launcher exists, that command is the bootstrap; after it exists, it's `curia install` or `curia reinstall` from the launcher.

A refusal (exit code `3`) also names the step, such as `preflight: ` for a refused host, `tailnet: ` for a user who may not operate Tailscale, or `stage: ` for a release that doesn't verify. A refusal changes nothing in that step. The root, host, and release refusals are listed in [Command reference](command-reference.md).

## How a retry works

Run the command that the failure message names. Every step checks what is already there before it acts, so a rerun repeats the quick steps, finds the finished ones done, and does the work of the step that failed:

- `preflight` and `root` run every time. They are quick, and they take no more than a few seconds.
- `tailnet` reads the node every time and logs it in only when it isn't logged in, so a rerun after a login that didn't arrive lands here and prints a fresh link.
- `stage` copies the stage again when the bootstrap hands one over. Without a stage, it verifies the installed version and moves on.
- `activate` rewrites the record and the launcher with the same content.
- `start` rewrites `run/compose.env`, pulls only images that are missing, and recreates only containers whose definition changed.
- `health` waits again.

There is no saved progress record, no repair mode, and no automatic retry. The command doesn't retry a step on its own, and it doesn't undo a completed step. To remove the runnable system and keep the installation, run `curia uninstall`; see [Uninstall and reinstall from the preserved root](uninstall.md). To start over from nothing, run `curia purge` and then the bootstrap; see [Purge and external cleanup](purge.md).

Some failures and their corrective actions:

| Failure | What to do |
|---|---|
| `start failed: docker compose ... pull failed` with a name-resolution or connection error | Check outbound access to `ghcr.io` (see [Network](supported-hosts.md#network)), then rerun. |
| `start failed: docker compose ... pull failed` with `manifest unknown` or `not found` | The release's images aren't published under the digest the manifest names. Report it at the Curia repository; don't change the bundle by hand. |
| `health failed: <service> exited` or `is unhealthy` | Read the service's log with the `docker compose ... logs <service>` command in the message. A service that can't bind its port names the port; a service that refuses its configuration names the file and the line. Fix the cause and rerun. |
| `health failed: <service> is still starting after 240 seconds` | The host is slow or the service is waiting on something. Read the log, and if the service is making progress, rerun; the wait starts again. |
| `activate failed` | The launcher couldn't be written. The message names the path. Check that `~/.local/bin` is a directory you own, then rerun. |
| `tailnet failed: no login arrived within 10 minutes` | Open the link the step printed on a device where you're signed in to Tailscale, approve the machine, then rerun. The rerun prints a fresh link when the node still isn't logged in. |
| `root: another lifecycle operation is running` | A second lifecycle command holds the lock. Wait for it to finish, as [The lifecycle lock](command-reference.md#the-lifecycle-lock) describes. |

## What gets written where

After a successful install, the root holds the following. The complete layout is in [Directory layout](command-reference.md#directory-layout).

| Path | Written by | Holds |
|---|---|---|
| `state/installation.json` | `root`, then `activate` | The record: format, installation ID, active version. |
| `config/config.yaml` | `root`, on a fresh root only | The initial operator configuration. See [Operator configuration](configuration.md). |
| `versions/<version>/` | `stage` | `node/` (the pinned runtime), `cli/` (the lifecycle interface), `cli.tgz`, `bundle.tar.gz`, `bundle.tar.gz.sha256` (the retained artifacts), and `bundle/compose.yaml` (the unpacked bundle). |
| `~/.local/bin/curia` | `activate` | The launcher, with the root written in. It's outside the root, and it's the one file the install writes there. |
| `run/compose.env` | `start` | `CURIA_ROOT`, `CURIA_UID`, `CURIA_GID`, `DOCKER_GID`, `CURIA_INSTALLATION_ID`. Paths and numbers, never a secret. |
| `cache/home/`, `cache/overseer-repos/`, `run/overseer-tokens/`, `work/cfg/curia-overseer/` | `start` | The mount sources of [What each container sees](secrets.md#what-each-container-sees), created empty before the project starts. |

No step prints or writes a secret. The command's output carries paths, versions, ports, and host names only.
