# 2. Install Curia

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · **2. Install Curia (this topic)** · [3. Connect services](03-connect-services.md) · [4. Run your first Full loop](04-run-your-first-full-loop.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

**Outcome:** The stable release installed under the installation root, the `curia` launcher on your path, five services healthy, and the address of the Curia app on your tailnet.

**Starting state:** The host from [1. Check prerequisites](01-check-prerequisites.md), logged in as the user who will own the installation. No Curia installation on the host. To reinstall over a root that `curia uninstall` preserved, this is still the command; see [Reinstall from the preserved root](09-uninstall-or-purge.md#reinstall-from-the-preserved-root).

**Active operator time:** About 3 minutes. The downloads (the lifecycle interface, the pinned Node.js runtime, the Compose bundle, and four container images) wait 2 to 10 minutes on the connection, and the health wait is up to 4 minutes. Neither is active work.

## What the command changes

On a fresh host there is nothing to preserve. The command creates the installation root, `~/.local/share/curia` by default, with seven directories owned by you at mode `0700`, writes one file outside the root, the launcher at `~/.local/bin/curia`, and starts one Docker Compose project named `curia`. It asks for no privileges and changes nothing else on the host. Over a preserved root it reinstalls and keeps the installation ID, `config/`, `secrets/`, `state/`, and `work/`.

## Do this

Download the bootstrap to a file, then run it:

```sh
curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh
```

Don't pipe `curl` into `bash`. The script refuses to run from a pipe, because it can't check that a piped copy downloaded completely.

To install into another directory, add `--root <absolute path>` once. The root is written into the launcher, and you never pass it again. To install an exact version instead of the stable release, add `--version <version>`. The options are in [The bootstrap](../bootstrap.md#the-command).

The script prints its own version, downloads every artifact into one temporary stage, proves each one against the registry, nodejs.org, the release manifest, and the signed stable-release index, and then hands off to `curia install`, which prints six named steps:

```text
[1/6] preflight
[2/6] root
[3/6] stage
[4/6] activate
[5/6] start
[6/6] health
```

What each step does is in [What `curia install` does](../install.md#what-curia-install-does).

## What you should see

The command ends with the installation root, the launcher, and one line that starts with `Next: open the Curia app at https://<your node's MagicDNS name>:8445/`. Keep that address. Then confirm from the launcher:

```sh
curia version
docker compose -p curia ps
```

`curia version` prints the lifecycle interface version, the same version as active, and the root. `docker compose -p curia ps` lists `daemon`, `tmux`, `ttyd`, `dashboard`, and `overseer` as `healthy`. If the app answers a refusal in the first seconds after the install, wait a moment and reload: the app reads who it admits from the service, and it keeps asking until the service answers.

## If it fails

The message names the step, the cause, one corrective action, and the command that reruns the step:

```text
curia install: health failed: daemon exited with code 1. Read its log with 'docker compose --env-file /home/you/.local/share/curia/run/compose.env -f /home/you/.local/share/curia/versions/1.2.3/bundle/compose.yaml logs daemon', fix the cause, and run the command again.
Run '/home/you/.local/bin/curia install' to run health again; the completed steps are kept.
```

Do the action, then run the command the second line names. Before the launcher exists that command is the bootstrap again; after it exists it's `curia install`. Every step checks what is already there, so the rerun repeats the quick steps and does the work of the one that failed. There is no progress record to clear and no repair mode.

A refusal (exit code `3`) changes nothing. Preflight names the host condition and its action, for example a port another program holds or a Docker daemon your user can't reach. Remove the condition and run the bootstrap again. The conditions by message are under [Install](troubleshooting.md#install) in Troubleshooting.

## Next

[3. Connect services](03-connect-services.md). Nothing in it needs the terminal.
