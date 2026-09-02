# Update discovery and staging

`curia update` moves an installed Curia to another release. This page is the reference for how Curia finds out that an update exists, how you select a version, what `curia update` does in this release, what it writes where, and what the Curia app shows. [Releases, the stable-release index, and version selection](releases.md) explains how a version becomes the recommended one; this page explains what happens on your host.

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
| 6. `switch` | Switches the core services to the target and records it as active. **This step isn't in this release.** The command stops here, reports that the target is staged and validated, and exits with code `1`. The active version is unchanged. | Nothing, in this release. |

After a run in this release, the root holds two complete versions: the active one and the staged target. Nothing else changed: the record, the launcher, `run/compose.env`, and every container are as they were. The staged target stays under `versions/<target>/` for the release that switches; a rerun finds it, verifies it, and downloads nothing.

When the switch lands, it recreates the service, the app, and the overseer on the target while tmux, ttyd, and the live agent containers keep running, waits for health, proves that the service and the app report the target version, re-adopts the live sessions, and then records the target as active and keeps the previous release as the one rollback release. Until then, `curia update` is a safe rehearsal of everything before the switch.

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
| `acquire: another lifecycle operation is running` | A second lifecycle command holds the lock. Wait for it to finish, as [The lifecycle lock](command-reference.md#the-lifecycle-lock) describes. |

## What gets written where

| Path | Written by | Holds |
|---|---|---|
| `state/update-check.json` | The service's daily check | The last check's result: `format`, `checked_at`, `ok`, `error`, `succeeded_at`, and the verified index's `sequence`, `updated`, `stable`, and `withdrawn`. Mode `0600`. |
| `cache/update/<target>.<pid>/` | `acquire` | The downloaded artifacts while they are proven. Removed when `stage` ends. |
| `versions/<target>/` | `stage` | `node/`, `cli/`, `cli.tgz`, `bundle.tar.gz`, `bundle.tar.gz.sha256`, and `bundle/compose.yaml`, the same layout as the active version. |

No step prints or writes a secret. The command's output carries versions, paths, and URLs only, and never an integrity value or a digest.
