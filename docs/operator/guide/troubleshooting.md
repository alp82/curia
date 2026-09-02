# Troubleshooting

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · [4. Run your first Full loop](04-run-your-first-full-loop.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** **Troubleshooting (this topic)**

Find the phase that failed, then the message you saw. Every entry gives one corrective action and the retry, which is always the same step you were on: the command that failed, the bootstrap, or **Try again** on the screen. There is no repair mode and no automatic retry. When the phase isn't obvious, run `curia doctor` first; its output names the failed condition and the action.

Every lifecycle command uses the same four exit codes: `0` ok, `1` failed (the operation started and stopped; the message says what to do), `2` usage (the command line was wrong; nothing ran; run `curia help`), and `3` refused (Curia stopped before changing anything; the message names the condition). A refusal isn't a failure.

## Bootstrap

Before the hand-off to `curia install`. A refusal leaves nothing on the host: no root, no launcher, and the stage is removed.

| You see | Cause | Action, then rerun the bootstrap |
|---|---|---|
| `this script runs as root` | You ran it with `sudo` or as `root`. | Run it as your own user. There is no force flag. |
| `running from a pipe`, or `is incomplete` | `curl ... \| bash`, or a cut download. | Download the script to a file with the command in [2. Install Curia](02-install-curia.md#do-this). |
| The operating system, the architecture, or a tool is named. | The host isn't Linux on x86_64, or `curl`, `tar`, `gzip`, or a checksum tool is missing. | Use a supported host, or install the named tool. |
| `the download of <file> was interrupted` | The connection dropped. | Rerun. Nothing was unpacked. |
| `<file> is not at <URL>` | The version isn't published there, or the origin is unreachable. | Check the version and outbound access to the origin in [Network](../supported-hosts.md#network). |
| `package integrity`, `bundle checksum`, or `Node.js <version> checksum` | An artifact was substituted or damaged. | Rerun. If it repeats, don't install it; report it at the [Curia repository](https://github.com/alp82/curia/issues). |
| `version mismatch` | The package, the manifest, or the runtime names another version. | The release is inconsistent. Report it. |
| A withdrawn version, an unsigned or foreign-signed index, or no stable release | The signed index refuses the selection. | See [Releases, the stable-release index, and version selection](../releases.md). Choose another version, or wait for a promotion. |
| `must be an absolute path`, or `must not contain a single quote` | `--root` was relative or holds a quote. | Pass an absolute path. |

## Install

`curia install` and `curia reinstall`. A refusal (exit `3`) names the step and changes nothing in it. A failure (exit `1`) names the step, the cause, and the rerun command; the completed steps are kept.

| You see | Cause | Action, then rerun the command the message names |
|---|---|---|
| `preflight: ` and a host check | A refused host condition, for example a busy port, a Docker daemon your user can't reach, or another operating-system release. | The one action per check is in [The checks](../supported-hosts.md#the-checks). |
| `preflight: ` and a root condition: foreign ownership, a mode past `0700`, a symbolic link, or an unknown nonempty root | The root or one of its seven directories isn't safe. | Fix the named path (`chmod 0700`, replace the link, or choose an empty directory). Curia never repairs or deletes it. See [When a lifecycle command refuses the root](../command-reference.md#when-a-lifecycle-command-refuses-the-root). |
| `root: another lifecycle operation is running` | A second lifecycle command holds `run/lifecycle.lock`. | Wait for it to finish. A lock whose process is gone is taken over on the next run; never delete it by hand. |
| `tailnet failed: no login arrived within 10 minutes` | The machine wasn't approved from the link in time. | Open the link on a device where you're signed in to Tailscale and approve the machine, then rerun; the rerun lands at `tailnet` and prints a fresh link when needed. |
| `tailnet: your user may not operate Tailscale on this host` | Your user isn't the Tailscale operator, so `tailscale up` and Serve are refused for it. | Run the `sudo tailscale set --operator=<user>` command the message names, then rerun. |
| `tailnet: the tailnet issues no HTTPS certificate for this node` | HTTPS certificates are off for the tailnet. | Enable them under **DNS** in the [Tailscale admin console](https://login.tailscale.com/admin/dns), then rerun. |
| `tailnet: this node is not logged in to a tailnet` on `curia reinstall` | Reinstall inspects the tailnet and never logs in. | Run `curia install`, which joins the tailnet, or `sudo tailscale up` on the host. |
| `this node is named <x>, not <y>` (not a refusal) | The node was already logged in under another name. | Nothing; the install continues with the actual name. To rename it, run `sudo tailscale set --hostname <name>` on the host. |
| `<name> is not a machine name` (exit `2`) | `--name` isn't a MagicDNS label. | Use lowercase letters, digits, and hyphens, up to 63 characters. |
| `stage: ` and a verification check | The release didn't verify against its manifest. | The failure classes are in [When a check fails](../release-manifest.md#when-a-check-fails). |
| `activate failed` | The launcher couldn't be written. | Check that `~/.local/bin` is a directory you own. |
| `start failed: docker compose ... pull failed` with a name-resolution or connection error | No outbound access to `ghcr.io`. | Allow it; see [Network](../supported-hosts.md#network). |
| `start failed: docker compose ... pull failed` with `manifest unknown` or `not found` | The release's images aren't published under the digest the manifest names. | Report it. Don't edit the bundle. |
| `health failed: <service> exited` or `is unhealthy` | The service couldn't start. A port conflict names the port; an invalid configuration names the file and line. | Read the log with the `docker compose ... logs <service>` command in the message and fix the cause. |
| `health failed: <service> is still starting after 240 seconds` | A slow host, or a service waiting on something. | Read the log. If the service is making progress, rerun; the wait starts again. |
| The launcher exits `3` and names a missing file | The installation record or the active version's runtime is gone. | Run the bootstrap again to reinstall the active version. |

## Connect services

The Setup screen. A failed card reads **Action required** with the failed check and one action. Do the action and select **Try again**, which runs every card's verification again.

| You see | Cause | Action, then Try again |
|---|---|---|
| The app doesn't open at `https://<node>:8445/` | The node has no certificate, Serve isn't standing, or the `dashboard` container is down. | Run `curia doctor`; its `app` and `host` sections name the cause. |
| The app opens but refuses your login | An operator is recorded and it isn't you, or the app hasn't read the recorded operator yet. | Open it as the recorded login, or select **Restart service** on the Settings screen. |
| The Tailscale card says the request carries no identity | You opened the app on loopback or by IP address. | Open it through Tailscale at the MagicDNS address. |
| **Setup** says it can't reach the service | The `daemon` container is down. | Run `curia doctor`, then read `docker compose -p curia logs daemon`. |
| GitHub: `curia's GitHub App is not installed on <owner>` | The App exists but isn't installed for a watched owner. | Install it from the panel's link and grant the watched repositories. |
| GitHub: the conversion failed | GitHub's one-hour code expired or the round trip broke. | Select **Create GitHub App** again. |
| Discord: Discord refuses the token | A reset or mistyped token. | Paste a fresh token from the developer portal; the panel puts the form first. |
| Discord: `The bot is not in the selected server` | The bot wasn't added. | Select **Add the bot to a server** and approve it in Discord. |
| Discord: `curia can't Send Messages in #curia`, or another permission | The channel's permissions block the bot. | Allow the named permission for the bot in that channel. |
| Discord: verified, but the bot doesn't answer | The bridge reads the token at boot and hasn't restarted since the first connection. | Select **Restart Curia** in the panel. |
| Tailscale: no certificate, node offline, or Serve refused | The tailnet's HTTPS certificates were turned off, the node was logged out, or the operator permission was removed since the install. | Enable HTTPS certificates under **DNS** in the admin console, run `curia install` (or `sudo tailscale up`) to log the node in again, or run `sudo tailscale set --operator=$USER`. |
| Model provider: the link or code doesn't show | The sign-in session hasn't started, or the agent image is still being prepared on a fresh installation. | Wait a minute, then select **Open the terminal instead** to watch the session. |
| Model provider: `refused the credential (HTTP 401` or `403)` | The credential expired or was revoked. | Sign in again from the panel. |
| Model provider: HTTP 429 | The subscription's usage window is spent. | Wait for it to reset, or sign in with another subscription. |
| Model provider: can't be reached | No outbound access to the provider. | Run `curia doctor`; check [Network](../supported-hosts.md#network). |

The full check lists per card are in [Integration setup](../integration-setup.md).

## Full loop

The **Full loop** panel names the failed leg, one cause, and one action. **Try again** reruns the failed leg.

| Failed leg | Cause | Action, then Try again |
|---|---|---|
| Frontier discovery | No takeable ticket carries the `rehearsal` label, or the frontier can't be read. | Label a takeable ticket in the covered repository, or fix the GitHub card. |
| Dispatch | The dispatcher refused the ticket: a clone an earlier agent left, an assigned or blocked ticket, or a missing model credential. | The cause is the dispatcher's own sentence. Fix what it names. |
| Any later leg | The agent ended before that leg: it exited, died, or was cancelled. | Read the ticket's thread in the command channel and fix what stopped the agent. The retry dispatches the same ticket again. |

A rejected review isn't a failure. The agent takes your feedback and asks for review again on the same pull request.

## Daily operation

| You see | Cause | Action |
|---|---|---|
| A container shows `unhealthy` or `exited` in `docker compose -p curia ps` | The process stopped answering. | Read `docker compose -p curia logs <service>`, then run `curia doctor` for the corrective action. |
| The service refuses to start after a restart and names `config/config.yaml`, a line, a key, and a rule | You edited the file by hand and it's invalid. | Fix or revert the named line, then restart. `curia doctor` prints the same diagnostic. |
| The service refuses to start and names an environment variable such as `GH_TOKEN` | A credential is set in the service's environment. | Unset it. Credentials live only in files under `secrets/`. |
| Agents fail to start, or a card reads **Action required** with an expired credential | A model-provider or GitHub credential lost its authority. | Open **Setup**, sign in again on that card, and select **Try again**. Running agents get the new credential on the next tick. |
| The bot stopped answering in the channel | The bridge lost its token or the service is down. | Run `curia doctor`. If the Discord card reads connected and the bridge isn't running, select **Restart Curia** in its panel. |
| A verb answers `assigned`, `blocked`, or `already live` | The ticket isn't takeable. | Change that on GitHub, or `/cancel` the live agent, then run the verb again. |
| The Settings screen warns that the installed version was withdrawn | The stable-release index marks it known-bad. | Read the reason on the release page it links, then run `curia update` for the recommended release. |

## Check the installation

| You see | Cause | Action |
|---|---|---|
| Exit `1` with `failed` or `refused` lines | A condition the doctor found. | Take the action under each line, then run `curia doctor` again. |
| Exit `3` before any section | The installation root refused the command. | Fix the named path; see [When a lifecycle command refuses the root](../command-reference.md#when-a-lifecycle-command-refuses-the-root). |
| `image provenance` failed with a `gh attestation verify` command | The GitHub CLI isn't logged in. | Run `gh auth login`, then `curia doctor` again. |
| `installation` names a missing file under `versions/` | The active version is incomplete. | Run `curia reinstall`, or the bootstrap when the launcher is gone. |
| `integrations` is skipped | The service didn't answer on `127.0.0.1:4271`. | Fix the `containers` or `service` line first. |

## Update

`curia update`. A refusal at `preflight` or `select` never touches the running installation.

| You see | Cause | Action, then rerun `curia update` |
|---|---|---|
| `preflight: this node is not logged in to a tailnet` | The node was logged out since the install. Update inspects the tailnet and never logs in. | Run `curia install`, which joins the tailnet, or `sudo tailscale up` on the host, then rerun. |
| `select: the stable-release index could not be downloaded` | No outbound access to `raw.githubusercontent.com`. | Allow it; see [Network](../supported-hosts.md#network). |
| `select: ... signed with key ...` | The index was signed with a key the installed package doesn't pin. | Don't install from it. Report it. |
| `select: <version> is withdrawn` | The version is marked known-bad. | Choose another version, or run without a version for the stable release. |
| `acquire: <artifact> is not at <url>` | The version isn't published, or not completely. | Check the release page, or choose another version. |
| `acquire: package integrity` or `checksum` | An artifact was substituted or damaged. | Rerun. If it repeats, report it. |
| `acquire: another lifecycle operation is running` | A second lifecycle command holds the lock. | Wait for it to finish. |
| `stage: <check>` | The release verification refused the target. | See [When a check fails](../release-manifest.md#when-a-check-fails). |
| `validate failed: <target> refuses the current operator configuration` | `config/config.yaml` has a line the target rejects. | Fix the named line as [Operator configuration](../configuration.md) describes, or choose another version. |
| `validate failed: <target> carries no operator configuration reader` | The target is older than the configuration contract. | Choose a newer version. |
| `switch failed: <service> exited` or `is unhealthy`, then `Switched back to <previous>, which is healthy` | The target didn't come up. Curia switched back once; your agents kept running. | Read the log the message names, fix the cause or choose another version. The rerun finds the staged target and downloads nothing. |
| `switch failed: the service reports <x> and the Curia app reports <y>, not <target>` | The recreated containers don't run the target, or the target is older than the release that added the version report. | Choose a newer version. |
| `switch failed: <target> did not re-adopt <session> within 120 seconds` | The recreated service found the pane but didn't track it. Curia switched back. | Read the service's log for `reconcile:` lines about that session before you rerun. |
| `switch failed: ... The switch back to <previous> failed too` | Neither release came up. This points at the host. | Read both logs, then run `curia reinstall` to start the release the record names. |

## Roll back

`curia rollback`. A refusal (exit `3`) changes nothing.

| You see | Cause | Action |
|---|---|---|
| `preflight: this node is not logged in to a tailnet` | The node was logged out. Rollback inspects the tailnet and never logs in. | Run `curia install` or `sudo tailscale up` on the host, then `curia rollback` again. |
| `select: versions/ holds no release beside the active one` | No rollback release: no update since the last install or reinstall. | Nothing to roll back. Run `curia update <version>` to move to another version. |
| `select: versions/ holds two releases beside the active one` | A failed update left its staged target beside the rollback release. | Run `curia update` to finish it, or remove the staged release from `versions/`, then `curia rollback` again. |
| `validate: <version> refuses the current operator configuration` | The rollback release can't read `config/config.yaml` as it stands. | Change the named line so both releases accept it, then `curia rollback` again. Or stay on the active release. |
| `validate: <version> carries no operator configuration reader` | The rollback release is older than the configuration contract. | Stay on the active release. |
| `switch failed: ...`, then `Switched back to <active>` | The rollback release didn't come up. Curia switched back once. | Read the log, then `curia rollback` again. |
| `switch failed: ... The switch back to <active> failed too` | Neither release came up. | Read both logs, then run `curia reinstall`. |

## Uninstall

`curia uninstall`. Every step reads before it removes, so the rerun is always `curia uninstall` again.

| You see | Cause | Action |
|---|---|---|
| `preflight: ... holds no installation` | Nothing to uninstall. | Nothing. To remove a root without a record, do it by hand; Curia never deletes what it doesn't recognize. |
| `docker failed: docker rm ...` | Docker refused a removal. | Read Docker's reason in the message, then rerun. |
| `docker: another lifecycle operation is running` | A second lifecycle command holds the lock. | Wait for it to finish. |
| `routes failed` and the node doesn't answer | `tailscaled` is down. | Run `sudo systemctl start tailscaled`, then rerun. A host without the `tailscale` command withdraws nothing, says so, and isn't a failure. |
| `files failed` after the launcher is gone | The step failed part way. | Reinstall with the bootstrap and run `curia uninstall` again, or empty `versions/`, `cache/`, and `run/` by hand. |

## Purge

`curia purge`. The installation record is the last file to go, so a rerun finds the installation until the root is removed.

| You see | Cause | Action |
|---|---|---|
| `confirm: ...` | The answer wasn't the exact root, or `--confirm` named another path. | Nothing changed. Run it again and type the root exactly as the warning printed it. |
| `no terminal to confirm on` | No TTY, for example from a script. | Run `curia purge --confirm <root>`. |
| `docker failed`, `routes failed`, or `root failed` | A step stopped part way. | Rerun and confirm again. The rerun removes what is left. |
| An image listed as kept under `[5/6] images` | A container still uses it, or Docker refused the removal. | Not a failure. Remove the container, then `docker image rm` the image by hand if you want it gone. |
| The launcher is gone | An uninstall or a partial purge removed it. | Run the bootstrap's purge mode: `bash curia-install.sh --purge`, with `--root <dir>` for a nondefault root. |
| `preflight: ... holds no installation` after a rerun | The purge finished. | Nothing left to purge. |
