# Operator guide

This guide takes one Curia from a supported host to a verified installation, keeps it running, changes it, and removes it. It's one ordered lifecycle. A new operator follows the numbered route from the top. A returning operator opens the operation needed from the same list, because every topic stands on its own and names its starting state.

Every topic opens the same way: the outcome, the starting state, and the active operator time to expect. Then it gives the exact command or browser action, what you should see, one corrective action with the same-step retry when you don't, and the next action. Before every command that changes or removes something, the topic says what the command keeps.

## New to Curia

Start at [1. Check prerequisites](guide/01-check-prerequisites.md) and follow the route through [4. Run the Test run](guide/04-run-the-test-run.md). The four topics under **Get Curia running** end at the Test run, one real Full loop on two tickets Curia creates, which is the installation's acceptance, and they add up to about 30 minutes of active operator work on a host that already meets the prerequisites. Downloads and the agent's own run are waits, not work, and the topics say where they fall.

## Returning to an installation

Open the topic for the operation you need. Each of these entries is direct:

| Operation | Topic |
|---|---|
| Send agents, answer them, change a setting, restart the service, read a log | [5. Daily operation](guide/05-daily-operation.md) |
| `curia doctor` | [6. Check the installation](guide/06-check-the-installation.md) |
| `curia update` | [Update](guide/07-update-or-roll-back.md#update) |
| `curia rollback` | [Roll back](guide/07-update-or-roll-back.md#roll-back) |
| The one-time move of the current source deployment | [8. Migrate the current deployment](guide/08-migrate-the-current-deployment.md) |
| `curia uninstall`, and the reinstall after it | [Uninstall](guide/09-uninstall-or-purge.md#uninstall) |
| `curia purge` | [Purge](guide/09-uninstall-or-purge.md#purge) |
| A command or a screen that failed | [Troubleshooting](guide/troubleshooting.md) |

## The lifecycle

1. **Get Curia running**
   1. [Check prerequisites](guide/01-check-prerequisites.md). A supported host with Docker Engine, Docker Compose, and Tailscale, and the four accounts.
   2. [Install Curia](guide/02-install-curia.md). One bootstrap command, seven named steps with one link to approve, five healthy services.
   3. [Connect services](guide/03-connect-services.md). GitHub, Discord, Tailscale, and one AI login, verified on the Setup screen.
   4. [Run the Test run](guide/04-run-the-test-run.md). Two tickets Curia creates, each through all eight legs, and the map closed. This is the acceptance.
2. **Run Curia**
   5. [Daily operation](guide/05-daily-operation.md). Discord and the Curia app, with no terminal.
   6. [Check the installation](guide/06-check-the-installation.md). `curia doctor`, read-only, one action per problem.
3. **Change the installation**
   7. [Update or roll back](guide/07-update-or-roll-back.md). The recommended stable release, or one step back, while agents keep running.
   8. [Migrate the current deployment](guide/08-migrate-the-current-deployment.md). Applies only to the one source deployment that predates the package.
   9. [Uninstall or purge](guide/09-uninstall-or-purge.md). Remove what runs and keep the installation, or remove everything after one confirmation.
4. **When something fails**
   - [Troubleshooting](guide/troubleshooting.md). By the phase that failed and the message you saw.

## Reference pages

The lifecycle topics link to these pages at the point of use. Read them for what a command or a file is, not for when to use it.

- [Command reference](command-reference.md): the launcher, the installation root, the lifecycle lock, every command, and the exit codes.
- [Supported hosts and preflight checks](supported-hosts.md): the supported systems, the host profile, the prerequisites, the network, and every host check.
- [The bootstrap](bootstrap.md): what `curia-install.sh` downloads, proves, and hands off, and its purge mode.
- [Install and reinstall](install.md): the six steps of `curia install` and `curia reinstall`.
- [Integration setup](integration-setup.md): the Setup screen, the four cards, and the Test run.
- [Diagnostics with `curia doctor`](doctor.md): the checks, the output, and what it never prints.
- [Operator configuration](configuration.md): `config/config.yaml`, its keys, and how a change lands.
- [Secrets, mounts, and what survives](secrets.md): the secret files, what each container sees, and what every operation keeps.
- [Update discovery, staging, and the switch](update.md): the daily check, version selection, and the six steps of `curia update`.
- [Rollback](rollback.md): the rollback release and the four steps of `curia rollback`.
- [Uninstall and reinstall from the preserved root](uninstall.md): the four steps of `curia uninstall` and the reinstall.
- [Purge and external cleanup](purge.md): the warning, the confirmation, the six steps, and the external report.
- [Releases, the stable-release index, and version selection](releases.md): publication order, promotion, and withdrawal.
- [The release manifest and release verification](release-manifest.md): what a release is made of and what Curia proves before activation.
- [Release images and the Compose bundle](bundle.md): the five services, their health checks, and the bundle.
- [The source cutover runbook](source-cutover-runbook.md): the one-time move of the source deployment on the box into a packaged Curia, with its script, its evidence, and its rollback. Read it from [8. Migrate the current deployment](guide/08-migrate-the-current-deployment.md).

## What this guide doesn't cover

- **Contributor setup.** Building Curia from source, running its tests, and the source deployment on the operator's own box are in the [repository README](../../README.md), [the daemon README](../../daemon/README.md), [the lifecycle interface README](../../cli/README.md), and [Deployment: the Hetzner box](../deploy.md).
- **Backup and replacement-host recovery.** That lifecycle is charted separately in [Chart Curia's backup and replacement-host recovery lifecycle](https://github.com/alp82/curia/issues/861) and joins this guide when it resolves.
