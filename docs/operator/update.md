# Update discovery, staging, and the switch

`curia update` moves an installed Curia to another release while your agents keep working. This page is the reference for how Curia finds out that an update exists, how you select a version, what `curia update` does step by step, what keeps running through the switch, what is kept for a rollback, what it writes where, and what the Curia app shows. [Releases, the stable-release index, and version selection](releases.md) explains how a version becomes the recommended one; this page explains what happens on your host. [Update](guide/07-update-or-roll-back.md#update) in the operator guide is where you run it.

## How Curia learns about an update

The service checks the stable-release index once a day. At startup, when the last successful check is more than 24 hours old, or when there has never been one, it checks at once. Otherwise it waits until the last successful check turns 24 hours old, and then checks every 24 hours.

Each check downloads `release/stable.json`, verifies the signature with the key the installed version's package carries (`versions/<version>/cli/stable-index.pub`), and records the result in `state/update-check.json`. The record holds when the check ran, whether the index verified, the reason when it didn't, and the index's own fields: sequence, timestamp, recommended stable release, and withdrawn versions. It holds nothing else. A check that fails keeps the last verified index beside the failure. An index with a sequence lower than the one already verified is refused, so a replayed old file can't un-withdraw a version.

A check downloads no release, changes nothing under `versions/`, restarts nothing, and sends no Discord message. A failed check is one line in the service log and one field in the record. The running installation is not affected. Curia never updates on its own: you start every update with `curia update`.

## What the Curia app shows

The **Update** section of the Settings screen reads the last check's record and shows:

- The installed version, with a link to its release notes.
- The recommended stable release, with a link to its release notes, or `none` when no stable release is recommended.
- Whether an update is available, with the command to run on the box.
- A warning when the installed version was withdrawn, before anything else.
- When the last check ran, when the next one is due, and, for a failed check, the reason and the age of the last successful check.

The section has no button. It starts no check and no update.

For a Curia that runs from a source checkout instead of an installation root, the section shows the version and says that the deploy updates it.

## How a version is selected

`curia update` reads the same index the daily check reads and applies one rule. The following table lists the forms.

| Command | What is selected |
|---|---|
| `curia update` | The stable release named in the index. When none is named, the command refuses and says no stable release is recommended right now. |
| `curia update <version>` | Exactly that version, whether or not it is the stable release. |
| `curia update --prerelease <version>` | Exactly that prerelease. Without `--prerelease`, a prerelease is refused, so nobody installs one by accident. |

A withdrawn version is refused in every form. When the installed version is withdrawn, the command says so, with the release notes, and continues. When the selected version is the installed one, the command says there is nothing to update and exits with code `0`.

`--prerelease` needs a version, and one version at most is accepted. Any other option is a usage error, exit code `2`, and nothing runs.

## What `curia update` does

The command runs six named steps in order and prints each one as `[n/6] <step>`. The following table lists them.

| Step | What it does | What it changes |
|---|---|---|
| 1. `preflight` | Checks the installation root as [When a lifecycle command refuses the root](command-reference.md#when-a-lifecycle-command-refuses-the-root) describes, requires an installation there, then runs the host checks in [Supported hosts and preflight checks](supported-hosts.md). | Nothing. |
| 2. `select` | Downloads the stable-release index, verifies it against the pinned key, and selects the target version as the preceding section describes. | Nothing. A refusal here never touches the running installation. |
| 3. `acquire` | Takes the lifecycle lock, which it holds until the command ends. Downloads every artifact of the target into `cache/update/` and proves each one: the package against the registry's integrity record, the pinned Node.js runtime against `SHASUMS256.txt` from nodejs.org, the bundle against its `.sha256` file and the release manifest. When the target is already complete under `versions/<target>/`, the step verifies those retained artifacts instead and downloads nothing. | `cache/update/` while the step runs. |
| 4. `stage` | Runs the release verification in [What Curia verifies before activation](release-manifest.md#what-curia-verifies-before-activation) and lands the target under `versions/<target>/`, read-only, through one rename. The active version stays where it is. | `versions/<target>/`. `cache/update/` is removed. |
| 5. `validate` | Has the target release validate your current operator configuration with its own reader. A `config/config.yaml` the target refuses stops the update here, with the same message the target's service would print. | Nothing. |
| 6. `switch` | Recreates the service, the app, and the overseer from the target's bundle while tmux, ttyd, and the agent containers keep running, then accepts the target and records it as active. The next section describes it. | `run/compose.env`, the three recreated containers, `state/installation.json`, and `versions/`. |

On success the command prints `Curia <target> is running. Open the Curia app as before; nothing in integration setup has to be repeated.` No Full loop runs. The release you came from stays under `versions/` as the rollback release; see [Rollback](rollback.md).

## What the switch does

The `switch` step is the only step that changes the running installation, and it runs only after the target is staged, verified, and has validated your configuration. It does the following, in order:

1. Reads the live sessions from the running service: every agent whose tmux pane is live.
2. Rewrites `run/compose.env` with the same five values, pulls the target's images by digest, and recreates the service, the app, and the overseer from the target's bundle with `docker compose up --detach --no-deps daemon dashboard overseer`.
3. Waits until every service reports healthy, as [Health checks](bundle.md#health-checks) describes, with the same four-minute bound as `curia install`.
4. Reads the version the service and the app report on their `/ping` routes. Both must be the target.
5. Reads the live sessions again from the recreated service until every session from step 1 is adopted, for up to two minutes. The service's boot pass re-adopts a live session from tmux and the journal, the same way it does after any restart. A session that ended on its own meanwhile is reported and isn't a failure.
6. Writes `state/installation.json` with the target as `activeVersion`, in one atomic write. From here the launcher runs the target's lifecycle interface, and the service reports the target as installed.
7. Removes every directory under `versions/` except the target and the release that was active.

### What keeps running

The switch recreates three containers and nothing else:

| What | During the switch | After the switch |
|---|---|---|
| The service (`daemon`), the Curia app (`dashboard`), and the overseer | Recreated from the target's images. Requests to the service and the app fail for the seconds the recreate takes. | Run the target release. |
| The tmux runtime and the attach surface (`ttyd`) | Keep running. Every tmux session, every pane, and every attached terminal stays where it was. | Keep the image they started on until a `curia reinstall` or a host restart. Neither carries Curia's version. |
| Agent containers | Keep running. An agent notices nothing; its worktree, config directory, and conversation are untouched. | Keep the image they started on until their session ends. The next agent Curia spawns uses the target release's agent image. |
| An overseer turn in flight | The overseer container is recreated, so a turn in flight dies with it. | The recreated service replays that turn once, as it does after any restart: a turn that ran no verb is sent again, and a turn that did gets a line in the conversation that says what it ran. |
| Work under `config/`, `secrets/`, `state/`, and `work/` | Untouched. | Untouched. |

Because the tmux runtime keeps running, an agent's pane is what the recreated service finds and adopts back. That's why the switch never stops tmux, never removes orphan containers, and passes `--no-deps`, which keeps Compose from touching the runtime the service depends on.

### What is kept for a rollback

After a successful switch, `versions/` holds two complete releases: the target, now active, and the release that was active before it. The previous release is the one rollback release. `curia rollback` switches back to it through the same steps, with the same health and re-adoption checks, after the rollback release validates your configuration; [Rollback](rollback.md) is its reference. Any older release under `versions/` is removed during the switch; Curia keeps no history beyond one.

A second `curia update` moves the pair forward: the release you updated from becomes the rollback release, and the one before it is removed. The command prints `removed <version>, which is no longer a rollback release` for each one.

### When the switch fails

Acceptance fails when a recreated service exits or turns unhealthy, when a service is still starting after four minutes, when the service or the app reports another version than the target, or when a live session isn't adopted within two minutes. In every case the switch goes back once: it recreates the service, the app, and the overseer from the release that was active, waits for its health, checks that the service and the app report that release, and reads the live sessions until every one that was live before the switch is adopted back. It doesn't retry the target, and it doesn't switch back a second time. The command exits with code `1` and its message names the cause, the switch back, and where the installation stands:

```text
curia update: switch failed: overseer exited with code 1. Read its log with 'docker compose --env-file /home/you/.local/share/curia/run/compose.env -f /home/you/.local/share/curia/versions/1.4.0/bundle/compose.yaml logs overseer', fix the cause, and run the command again. Switched back to 1.3.0, which is healthy and re-adopted 2 live sessions. The record still names 1.3.0.
Run '/home/you/.local/bin/curia update' to run switch again; the completed steps are kept.
```

[What an update does on its own](rollback.md#what-an-update-does-on-its-own) spells out the switch back step by step.

The record is written only after acceptance, so a failed switch never changes `activeVersion`, and the launcher keeps running the release that was active. The staged target stays under `versions/<target>/`, and a rerun finds it, verifies it, downloads nothing, and switches again.

When the switch back doesn't come up either, the message says so and names `curia reinstall`, which starts the release the record names from its retained artifacts. Read the logs the message names first: two releases that both fail their health check point at the host, not at either release.

## When a step fails

A refusal (exit code `3`) names the step and changes nothing in that step:

```text
curia update: select: 1.3.0 is withdrawn: the release notes at https://github.com/alp82/curia/releases/tag/v1.3.0 say why. Choose another version, or run the command without a version for the stable release.
```

A failure (exit code `1`) names the step, the cause, and the command that reruns it:

```text
curia update: validate failed: 1.4.0 refuses the current operator configuration: /home/you/.local/share/curia/config/config.yaml line 3: `max_concurrent` must be a positive whole number (got 0). Fix the file, or choose another version. The active version is unchanged.
Run '/home/you/.local/bin/curia update' to run validate again; the completed steps are kept.
```

Every step checks what is already there before it acts, so a rerun repeats `preflight` and `select`, finds a staged target under `versions/<target>/`, verifies it, and continues at the step that failed. There is no saved progress record and no automatic retry.

Some failures and their corrective actions:

| Failure | What to do |
|---|---|
| `select: the stable-release index could not be downloaded` | Check outbound access to `raw.githubusercontent.com` (see [Network](supported-hosts.md#network)), then rerun. The daily check reports the same condition in the app. |
| `select: ... signed with key ...` | The index was signed with a key the installed package doesn't pin. Don't install from it. Report it at the Curia repository. |
| `acquire: <artifact> is not at <url>` | The version isn't published, or not completely. Check the release page, or choose another version. |
| `acquire: package integrity` or `checksum` | An artifact was substituted or damaged in transit. Rerun. If it repeats, report it. |
| `stage: <check>` | The release verification refused the target. The failure classes are in [When a check fails](release-manifest.md#when-a-check-fails). |
| `validate failed: <target> refuses the current operator configuration` | Fix the named line in `config/config.yaml` as [Operator configuration](configuration.md) describes, or choose another version. |
| `validate failed: <target> carries no operator configuration reader` | The target is older than the operator configuration contract. Choose a newer version. |
| `switch failed: <service> exited` or `is unhealthy`, then `Switched back to <previous>, which is healthy` | The target didn't come up on this host. Read the service's log with the command in the message, fix the cause or choose another version, and rerun. Your agents kept running throughout. |
| `switch failed: the service reports <x> and the Curia app reports <y>, not <target>` | The recreated containers don't run the target release. A target older than the release that added the version report fails this way too. Choose a newer version. |
| `switch failed: <target> did not re-adopt <session> within 120 seconds` | The recreated service found the pane but didn't track it. Curia switched back, and the previous release adopted it again. Read the service's log for `reconcile:` lines about that session before you rerun. |
| `switch failed: ... The switch back to <previous> failed too` | The previous release didn't come up either, or didn't report its version or adopt a live session back. Read both logs, then run `curia reinstall` to start the release the record names. |
| `acquire: another lifecycle operation is running` | A second lifecycle command holds the lock. Wait for it to finish, as [The lifecycle lock](command-reference.md#the-lifecycle-lock) describes. |

## What gets written where

| Path | Written by | Holds |
|---|---|---|
| `state/update-check.json` | The service's daily check | The last check's result: `format`, `checked_at`, `ok`, `error`, `succeeded_at`, and the verified index's `sequence`, `updated`, `stable`, and `withdrawn`. Mode `0600`. |
| `cache/update/<target>.<pid>/` | `acquire` | The downloaded artifacts while they are proven. Removed when `stage` ends. |
| `versions/<target>/` | `stage` | `node/`, `cli/`, `cli.tgz`, `bundle.tar.gz`, `bundle.tar.gz.sha256`, and `bundle/compose.yaml`, the same layout as the active version. |
| `run/compose.env` | `switch` | The same five run-time values as before. Rewritten, never changed in content. |
| `state/installation.json` | `switch`, after acceptance | The record with the target as `activeVersion`. The installation ID doesn't change. |
| `versions/` | `switch`, after activation | The target and the previous active release only. Every other directory is removed. |

The launcher at `~/.local/bin/curia` is never rewritten: it reads the record on every run, so it follows the switch on its own.

No step prints or writes a secret. The command's output carries versions, paths, and URLs only, and never an integrity value or a digest.
