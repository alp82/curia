# Install and reinstall

`curia install` turns a verified stage into a running Curia: one installed version under the installation root, the stable launcher, the Compose project up, and every service healthy. `curia reinstall` runs the same sequence over a root that already holds an installation and keeps everything that installation owns. This page is the reference for both commands: the steps, what each one changes, what a reinstall preserves, what a failure looks like, and how you retry. [The bootstrap](bootstrap.md) tells you how to start an installation; this page tells you what happens after the hand-off.

## What `curia install` does

The bootstrap hands off to `curia install` with the installation root in `CURIA_ROOT` and the verified stage in `CURIA_STAGE`. The command then runs six named steps in order and prints each one as `[n/6] <step>`. The following table lists them.

| Step | What it does | What it changes |
|---|---|---|
| 1. `preflight` | Checks the installation root as [When a lifecycle command refuses the root](command-reference.md#when-a-lifecycle-command-refuses-the-root) describes, then runs the host checks in [Supported hosts and preflight checks](supported-hosts.md). | Nothing. A refusal here leaves no root and no launcher. |
| 2. `root` | Creates the root and its seven directories, or recognizes the installation that is there. Takes the lifecycle lock, which it holds until the command ends. Writes the installation record, and on a fresh root the initial operator configuration (`max_concurrent: 4`). | The root, `state/installation.json`, and `config/config.yaml` on a fresh root only. |
| 3. `stage` | Verifies the staged artifacts against the release manifest, as [What Curia verifies before activation](release-manifest.md#what-curia-verifies-before-activation) describes, and copies the runtime, the lifecycle interface, the retained artifacts, and the unpacked bundle into `versions/<version>/`. The copy lands in a sibling directory first and moves into place in one step. Installed files are read-only. | `versions/<version>/`, replaced whole if it was there. |
| 4. `activate` | Writes the record with the version as `activeVersion` and writes the launcher at `~/.local/bin/curia`. Removes every other directory under `versions/`, so one release is installed. | `state/installation.json`, the launcher, `versions/`. |
| 5. `start` | Writes `run/compose.env` with the five run-time values from [The bundle](bundle.md#the-bundle), creates the directories the containers mount so Docker never creates one as root, pulls the four images by digest, and brings the project up. | `run/compose.env`, directories under `cache/`, `run/`, and `work/`, and the Docker images, containers, network, and volume. |
| 6. `health` | Waits until every service reports healthy, as [Health checks](bundle.md#health-checks) describes. A service that exits or turns unhealthy fails the step at once. A service still starting after four minutes fails it too. | Nothing. |

On success the command prints the installation root, the launcher, and the address of the Curia app on your tailnet, `https://<your node's MagicDNS name>:8445/`, and tells you the next action: open the app and start integration setup. Nothing in integration setup needs the terminal again. See [Integration setup](integration-setup.md).

The version `curia install` installs is always the version of the lifecycle interface that runs it. The bootstrap runs the staged package, so the version it downloaded is the version installed. Installing another version is `curia update`; see [Update discovery and staging](update.md).

## What `curia reinstall` does

`curia reinstall` runs the same six steps over a root that already holds an installation. It refuses a root that holds none. Use it when the installed version's files, the Compose project, or the launcher are damaged and the installation itself is fine.

A reinstall keeps the installation ID, `config/`, `secrets/`, `state/`, and `work/`. It replaces `versions/` and rewrites `run/compose.env`, and it leaves `cache/` alone. Containers are recreated only where the bundle changed. Nothing you did through integration setup has to be repeated, and running work under `work/` resumes. The complete survival table is in [What survives](secrets.md#what-survives).

The bootstrap always hands off `curia install`, even over a preserved root. `curia install` recognizes the installation record and reinstalls, so running the bootstrap again after `curia uninstall` restores the same installation. The one difference between the two commands is that `curia reinstall` refuses when there is nothing to reinstall.

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

A refusal (exit code `3`) also names the step, such as `preflight: ` for a refused host or `stage: ` for a release that doesn't verify. A refusal changes nothing in that step. The root, host, and release refusals are listed in [Command reference](command-reference.md).

## How a retry works

Run the command that the failure message names. Every step checks what is already there before it acts, so a rerun repeats the quick steps, finds the finished ones done, and does the work of the step that failed:

- `preflight` and `root` run every time. They are quick, and they take no more than a few seconds.
- `stage` copies the stage again when the bootstrap hands one over. Without a stage, it verifies the installed version and moves on.
- `activate` rewrites the record and the launcher with the same content.
- `start` rewrites `run/compose.env`, pulls only images that are missing, and recreates only containers whose definition changed.
- `health` waits again.

There is no saved progress record, no repair mode, and no automatic retry. The command doesn't retry a step on its own, and it doesn't undo a completed step. To start over from nothing, run `curia purge` and then the bootstrap.

Some failures and their corrective actions:

| Failure | What to do |
|---|---|
| `start failed: docker compose ... pull failed` with a name-resolution or connection error | Check outbound access to `ghcr.io` (see [Network](supported-hosts.md#network)), then rerun. |
| `start failed: docker compose ... pull failed` with `manifest unknown` or `not found` | The release's images aren't published under the digest the manifest names. Report it at the Curia repository; don't change the bundle by hand. |
| `health failed: <service> exited` or `is unhealthy` | Read the service's log with the `docker compose ... logs <service>` command in the message. A service that can't bind its port names the port; a service that refuses its configuration names the file and the line. Fix the cause and rerun. |
| `health failed: <service> is still starting after 240 seconds` | The host is slow or the service is waiting on something. Read the log, and if the service is making progress, rerun; the wait starts again. |
| `activate failed` | The launcher couldn't be written. The message names the path. Check that `~/.local/bin` is a directory you own, then rerun. |
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
