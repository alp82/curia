# Purge and external cleanup

`curia purge` removes every local trace of one Curia installation: the installation root with your configuration, credentials, history, and unfinished work, the launcher, the installation's containers, networks, and volumes, the release images nothing else on the host uses, and the Tailscale Serve routes Curia created. It asks one question first, and there is no way back. This page is the reference for the command: the warning, the confirmation, the steps, what stays on the host, how you retry, and the external resources that remain yours to remove. To remove the runnable system and keep the installation instead, run `curia uninstall`; see [Uninstall and reinstall from the preserved root](uninstall.md).

## What `curia purge` does

Run it from the launcher:

```sh
curia purge
```

When the launcher is gone, run the bootstrap's purge mode instead; see [Purge from the bootstrap](#purge-from-the-bootstrap).

The command runs six named steps in order and prints each one as `[n/6] <step>`. The following table lists them.

| Step | What it does | What it removes |
|---|---|---|
| 1. `preflight` | Checks the installation root as [When a lifecycle command refuses the root](command-reference.md#when-a-lifecycle-command-refuses-the-root) describes, reads the installation record and the identifiers for the external report, and prints the warning with the exact root. A root that holds no installation is refused. | Nothing. |
| 2. `confirm` | Takes the one confirmation; see [The confirmation](#the-confirmation). An answer that isn't the root stops the command. | Nothing. |
| 3. `docker` | Takes the lifecycle lock, which it holds until the command ends. Finds every container, network, and volume that carries the label `sh.curia.installation=<installation ID>`, stops the running containers, and removes all of them. | The five service containers, the Compose network, the tmux socket volume, every agent container, and the agent cache volumes. Nothing without the label. |
| 4. `routes` | Reads the Serve routes Curia created from `state/tailscale.json` and turns off each one that the node still serves. | Curia's own Serve route for the app, `https://<node>:8445`. No other route, and nothing else of the node. |
| 5. `images` | Finds the release images by their exact repositories and removes each one that Docker proves unused; see [Which images go](#which-images-go). | The release images of this and every earlier version that no container on the host uses. |
| 6. `root` | Removes the launcher when it names this root, then the installation root. | `~/.local/bin/curia` and the whole root: `config/`, `secrets/`, `state/`, `work/`, `versions/`, `cache/`, and `run/`. |

The root goes last. Until the `root` step ends, the installation record is on disk and a rerun finds the installation.

Purge doesn't wait for running sessions. It doesn't drain them, write interruption records, change GitHub claims, scan for unpublished work, or offer to keep anything. An agent's worktree with uncommitted changes goes with `work/`. If you want to keep something, copy it out before you confirm, or run `curia uninstall` instead.

## The warning

Before the question, the command prints the exact installation root and what goes with it:

```text
[1/6] preflight
This purges the Curia installation at /home/you/.local/share/curia (installation 3f9c..., version 1.2.0).
It deletes, with no way back:
  - your configuration (config/), credentials (secrets/), history (state/), and unfinished work (work/)
  - the installed versions, caches, and runtime files (versions/, cache/, run/) and the launcher
  - the installation's containers, networks, and volumes, and the release images nothing else uses
  - the Tailscale Serve routes Curia created
It does not delete the GitHub App, the Discord bot and channel, the Tailscale node, or any model-provider login; those stay yours to remove.
```

Read the root. Purge acts on the root the launcher names, or on `CURIA_ROOT` when you run the lifecycle interface without the launcher.

## The confirmation

One confirmation authorizes the whole deletion, and the confirmation is the exact installation root. There is no second question and no `--force`.

- **On a terminal**, the command asks `Type the installation root to confirm, or anything else to stop:`. Type the root exactly as the warning printed it. `yes`, a trailing slash, or a different case stops the command with exit code `3` and nothing changed.
- **Without a terminal**, such as from a script or a `docker exec` without a TTY, the command refuses and names the flag. Pass the root on the command line instead:

  ```sh
  curia purge --confirm /home/you/.local/share/curia
  ```

  `--confirm` with any value other than the installation root is refused with exit code `3` and nothing changed. `--confirm=<root>` is the same flag. On a terminal, `--confirm <root>` skips the question.

The two forms say the same thing: you named the exact directory that goes. A script that purges several installations names each root once.

## Which images go

Curia's release images are the four images under `ghcr.io/alp82/curia-daemon`, `curia-tmux`, `curia-dashboard`, and `curia-overseer`, pulled by digest. They carry no installation label, because two installations on one host share a pulled image. The `images` step lists every image under those four exact repositories, of this version and of earlier ones, and for each image:

1. Asks Docker for every container, of any installation, that runs it (`docker ps --all --filter ancestor=<image>`). An image with a container over it is kept, and the report names the container.
2. Removes the image without `--force`. An image Docker refuses, for example because another image depends on it, is kept, and the report gives Docker's reason.

A kept image is reported, not a failure. Purge never removes an image because its name starts with `curia`: the agent image the service builds on the host (`curia-agent:<pins>` by default) isn't a release image and stays. Remove it by hand with `docker image rm` when nothing uses it.

## What the command prints

On success the command prints what was removed and the external report:

```text
Curia is purged. The installation root /home/you/.local/share/curia is removed.
  removed:   the root with config/, secrets/, state/, and work/, the launcher, the installation's containers, networks, and volumes, and 4 release images
  reinstall: a later install starts a new installation with a new ID; the removed one cannot come back

External resources Curia never deletes. Deleting the local secret files revokes nothing: each credential stays valid until you remove it where it was issued.
  GitHub App 424242 and its installations: https://github.com/settings/apps
  Discord bot, server 987..., channel curia: https://discord.com/developers/applications
  Tailscale node curia.sh: https://login.tailscale.com/admin/machines
  Serve route https://:8445 -> http://127.0.0.1:4273: withdrawn
  Model-provider logins (Anthropic, OpenAI): revoke them in each provider's account settings if you won't reinstall; only the local copies were deleted.
```

The report is built from identifiers Curia already stored: the GitHub App ID from `secrets/github-app.json`, the Discord server and channel from `state/discord.json`, the machine name and the Serve routes from `state/tailscale.json`. Curia reads them before the root goes, looks nothing up, and revokes nothing. The list never holds a token or a key. A line is absent when Curia never stored that identifier.

Deleting the local credential files doesn't revoke them. The GitHub App's private key, the Discord bot token, and the model-provider logins stay valid where they were issued until you delete the App, reset or delete the bot, and sign out of the provider. The report names where.

A Serve route reads `withdrawn` when the step turned it off, `was not standing` when the node no longer served it, and `still recorded when the root was removed` with the command to run on the node when the `tailscale` command wasn't on the path.

## When a step fails

A step that fails stops the command with exit code `1` and a message that names the step and the rerun:

```text
curia purge: docker failed: docker rm --force --volumes c0 c1 failed:
Error response from daemon: ...
Run '/home/you/.local/bin/curia purge' to run docker again; the completed steps are kept.
```

Run the command that the message names, and confirm again. Every step reads what is there before it removes it, so a rerun over a partial purge removes what is left and skips what is gone. A rerun after the root is gone is refused at `preflight`, because there is nothing left to purge.

The launcher goes at the start of the `root` step. When a step fails after that, or when the launcher was already removed by an uninstall, the message names the bootstrap's purge mode as the rerun.

A refusal (exit code `3`) names the step too. `preflight: ... holds no installation` means there is nothing to purge. `confirm: ...` means you didn't confirm, and nothing changed. `docker: another lifecycle operation is running` means a second lifecycle command holds the lock; see [The lifecycle lock](command-reference.md#the-lifecycle-lock).

## Purge from the bootstrap

After `curia uninstall`, or on a host where the installed version can't run, the launcher is gone. Run the bootstrap's purge mode, which acquires and verifies the lifecycle interface temporarily and runs `curia purge` from it:

```sh
curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh --purge
```

Pass `--root <dir>` for a nondefault root, the same root the uninstall printed. The bootstrap hands off only the root, so the confirmation is the question on your terminal; the bootstrap refuses to run from a pipe for that reason. The root's `run/` directory may be gone by then, and purge creates it for the lock before it takes one. The bootstrap writes no launcher, creates no root, and removes its stage when the command returns; see [Purge mode](bootstrap.md#purge-mode).

## After a purge

Nothing of the installation is left on the host: no root, no launcher, no labelled Docker resource, no Curia Serve route, and no unused release image. A later bootstrap creates a new installation with a new installation ID, so integration setup runs again from the start. The external resources in the report are still there until you remove them, and a new installation can reuse the same GitHub App, Discord bot, and Tailscale node if you keep them.
