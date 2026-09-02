# Uninstall and reinstall from the preserved root

`curia uninstall` stops Curia and removes everything that runs it from the host: the launcher, the installed versions, the caches, the runtime files, the containers, the networks, the volumes, and the Tailscale Serve routes Curia created. It keeps the installation itself: `config/`, `secrets/`, `state/`, and `work/` stay in the installation root with the installation ID, so the bootstrap reinstalls the same Curia later, with the same integrations, history, and resumable work. This page is the reference for the command: the steps, what each one removes, what stays, how you retry, and how you reinstall. Removing the installation too is `curia purge`; see [Command reference](command-reference.md#commands).

## What `curia uninstall` does

Run it from the launcher:

```sh
curia uninstall
```

The command takes no options and asks no question. It runs four named steps in order and prints each one as `[n/4] <step>`. The following table lists them.

| Step | What it does | What it removes |
|---|---|---|
| 1. `preflight` | Checks the installation root as [When a lifecycle command refuses the root](command-reference.md#when-a-lifecycle-command-refuses-the-root) describes, and reads the installation record. A root that holds no installation is refused. | Nothing. |
| 2. `docker` | Takes the lifecycle lock, which it holds until the command ends. Finds every container, network, and volume that carries the label `sh.curia.installation=<installation ID>`, stops the running containers, and removes all of them. | The five service containers, the Compose network, the tmux socket volume, every agent container, and the agent cache volumes. Nothing without the label. |
| 3. `routes` | Reads the Serve routes Curia created from `state/tailscale.json` and turns off each one that the node still serves. | Curia's own Serve route for the app, `https://<node>:8445`. No other route, and nothing else of the node. |
| 4. `files` | Empties `versions/`, `cache/`, and `run/`, then removes the launcher. | Every installed version, the caches, the runtime files, and `~/.local/bin/curia`. |

The container images stay. Curia removes them only in `curia purge`, after confirmation. The label is what finds Curia's resources: a container with another installation's ID, a container of yours without the label, the default network, and an unlabelled volume are never listed and never touched. Curia doesn't remove resources by name.

The `routes` step never installs, starts, or reconfigures Tailscale. On a host where the `tailscale` command isn't on the path, the step withdraws nothing, says so, and keeps the recorded routes for a host that runs Tailscale. On a host where the node doesn't answer, the step fails so you can start `tailscaled` and rerun.

Uninstall doesn't wait for running sessions. It doesn't drain them, write interruption records, change GitHub claims, inspect unpublished work, or copy anything out of `work/`. The preserved directories are the recovery mechanism: an agent's worktree and config directory stay under `work/`, and the service resumes what it can after a reinstall.

## What is preserved

The root stays, with its seven directories. Four keep their contents, and three are emptied. The following table lists them.

| Directory | After `curia uninstall` |
|---|---|
| `config/` | Kept. Your operator configuration. |
| `secrets/` | Kept. Every secret file, so no integration has to be set up again. |
| `state/` | Kept. The installation record with the installation ID, the journal, the setup checkpoint, the Discord and Tailscale facts, and the update check. |
| `work/` | Kept. Worktrees, per-session config directories, and the overseer's native sessions. |
| `versions/` | Emptied. |
| `cache/` | Emptied. |
| `run/` | Emptied. |

The installation record keeps naming the version that was active. Nothing runs it, because the launcher and the versions are gone, and the next `curia install` replaces the version.

Deleting a local file never revokes anything outside the host. The GitHub App, its installations, the Discord bot and its channel, the Tailscale node, and the model-provider logins all stay as they are. See [What the command prints](#what-the-command-prints).

## What the command prints

On success the command prints the preserved root, what was kept and removed, and the two commands you can run next:

```text
Curia is uninstalled. The installation at /home/you/.local/share/curia is preserved.
  kept:      config/, secrets/, state/, work/ (installation 3f9c...: configuration, secrets, history, and resumable work)
  removed:   the launcher, versions/, cache/, run/, and the installation's containers, networks, volumes, and Serve routes
  images:    kept; 'curia purge' removes them
  reinstall: curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh
  purge:     curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh --purge
```

Both commands are the bootstrap, because the launcher is gone. A nondefault root appears as `--root <dir>` on both lines.

When Curia holds identifiers of external resources, the command lists them under `External resources Curia never deletes`, with the page where you remove each one: the GitHub App ID, the Discord server and channel, and the Tailscale machine name. The list is a checklist for you. Curia looks nothing up and revokes nothing. The list never holds a token or a key.

## When a step fails

A step that fails stops the command with exit code `1` and a message that names the step:

```text
curia uninstall: docker failed: docker rm --force --volumes c0 c1 failed:
Error response from daemon: ...
Run '/home/you/.local/bin/curia uninstall' to run docker again; the completed steps are kept.
```

Run the command that the message names. Every step reads what is there before it removes it, so a rerun over a partial cleanup removes what is left and skips what is gone. A rerun over a finished uninstall lists nothing, removes nothing, and prints the same completion. There is no saved progress record, no undo, and no repair mode.

The launcher goes last, at the end of the `files` step, so it's there for every rerun before that. If the `files` step itself fails after the launcher is gone, the message says to reinstall with the bootstrap and run `curia uninstall` again, or to empty `versions/`, `cache/`, and `run/` by hand.

A refusal (exit code `3`) names the step too. `preflight: ... holds no installation` means there is nothing to uninstall. `docker: another lifecycle operation is running` means a second lifecycle command holds the lock; see [The lifecycle lock](command-reference.md#the-lifecycle-lock).

## Reinstall from the preserved root

To reinstall, run the bootstrap on the same host as the same user:

```sh
curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh
```

The bootstrap hands off to `curia install`, which recognizes the installation record and reinstalls over the root, as [What `curia reinstall` does](install.md#what-curia-reinstall-does) describes. The installation ID, `config/`, `secrets/`, `state/`, and `work/` are the ones the uninstall left. The command stages the current stable release under `versions/`, writes the launcher again, writes `run/compose.env` with the same installation ID, creates the mount directories under `cache/` and `run/`, pulls the images, and starts the project. It ends with every service healthy and the app address.

After the reinstall, nothing in integration setup has to be repeated. The service reads the same secret files and the same journal, admits the same operator, and creates its Serve route again when the Tailscale card is read. Sessions under `work/` resume the way they do after a restart. The rollback release is gone, because `versions/` was emptied, so `curia rollback` refuses until the next `curia update`.

`curia reinstall` from a launcher rerun needs an installed version under `versions/`, which an uninstall removed, so after an uninstall the bootstrap is the reinstall command. If you pass `--root` to the bootstrap, pass the same root the uninstall printed.
