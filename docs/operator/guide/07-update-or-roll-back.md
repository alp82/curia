# 7. Update or roll back

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · [4. Run your first Full loop](04-run-your-first-full-loop.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** **7. Update or roll back (this topic)** · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

Curia never updates on its own. The **Update** section of the Settings screen tells you when the signed stable-release index recommends a newer release, and you run the update from the host. An update keeps the release you came from as the one rollback release, and a rollback is the same switch in the other direction. Both run while your agents keep working.

## Update

**Outcome:** The installation runs the recommended stable release, or the exact version you name, with the release you updated from retained for a rollback.

**Starting state:** An installed, healthy Curia, and a terminal on the host as the owning user. The Settings screen or `curia doctor` shows the installed version. Agents may be running.

**Active operator time:** About 2 minutes. The download and the switch wait 3 to 10 minutes. Requests to the Curia app fail for the few seconds the switch takes to recreate three containers.

### What the update keeps

Before you run it, know what the command touches and what it doesn't:

- **Kept, byte for byte:** `config/`, `secrets/`, `state/`, and `work/`. Nothing in integration setup has to be repeated, and no Full loop runs.
- **Kept running:** the tmux runtime, the attach surface, every agent container, and every attached terminal. An agent notices nothing.
- **Recreated:** the service, the Curia app, and the overseer, from the target's images. An overseer turn in flight dies with the container and is replayed once by the recreated service.
- **Replaced:** `run/compose.env`, rewritten with the same values, and `versions/`, which afterwards holds the target and the release you came from. Any older release is removed.
- **Written last:** `state/installation.json`, only after the target is healthy, reports its version, and has adopted every live session back.

The full table is in [What keeps running](../update.md#what-keeps-running).

### Do this

```sh
curia update
```

To move to an exact published version instead of the recommended one, run `curia update <version>`. To rehearse a prerelease on a disposable host, run `curia update --prerelease <version>`; a prerelease is never selected otherwise. A withdrawn version is refused in every form. The selection rule is in [How a version is selected](../update.md#how-a-version-is-selected).

The command prints six named steps, `[1/6] preflight` through `[6/6] switch`. `select` reads the signed index before the lock, `acquire` downloads and proves every artifact, `stage` lands the target read-only beside the active release, `validate` has the target read your `config/config.yaml` with its own reader, and `switch` recreates the three core services and accepts the target. What each step does is in [What `curia update` does](../update.md#what-curia-update-does).

### What you should see

The command ends with `Curia <target> is running. Open the Curia app as before; nothing in integration setup has to be repeated.` Then confirm:

```sh
curia version
curia doctor
```

`curia version` names the target as active, and the doctor's `containers` and `service` sections read `ok`. The Settings screen shows the target as installed.

### If it fails

A refusal (exit code `3`) at `preflight` or `select` changes nothing: a refused host condition, a withdrawn or unpublished version, or an index that didn't verify. The message names the condition and its action. Fix it and run `curia update` again.

A failure (exit code `1`) names the step, the cause, and the rerun:

```text
curia update: switch failed: overseer exited with code 1. Read its log with 'docker compose ... logs overseer', fix the cause, and run the command again. Switched back to 1.3.0, which is healthy and re-adopted 2 live sessions. The record still names 1.3.0.
Run '/home/you/.local/bin/curia update' to run switch again; the completed steps are kept.
```

When the target fails its acceptance, the command switches back to the release that was running, once, and proves it the same way. Your agents kept running throughout. Read the log the message names, fix the cause or choose another version, and run `curia update` again: the rerun finds the staged target under `versions/`, verifies it, downloads nothing, and switches again. When `validate` fails, the message names the line in `config/config.yaml` the target refuses; fix it as [Operator configuration](../configuration.md) describes.

The failures by message are under [Update](troubleshooting.md#update) in Troubleshooting.

### Next

Return to [5. Daily operation](05-daily-operation.md). When the new release misbehaves, [roll back](#roll-back).

## Roll back

**Outcome:** The installation runs the release you updated from, and the release you rolled back from becomes the new rollback release.

**Starting state:** A `curia update` that succeeded since the last install or reinstall, so `versions/` holds two complete releases. The active release may be unhealthy, but the host and Docker answer. Agents may be running.

**Active operator time:** About 1 minute. The switch waits up to 4 minutes for health and up to 2 minutes for re-adoption.

### What the rollback keeps

The same as an update: `config/`, `secrets/`, `state/`, and `work/` untouched, the tmux runtime and every agent kept running, and the three core services recreated from the rollback release's images. Rows the newer release wrote to the journal and the records under `state/` stay readable, because a minor release's migrations are additive by rule. Rollback across a major version isn't supported; see [Migrations and the rollback release](../rollback.md#migrations-and-the-rollback-release).

Curia keeps exactly one rollback release, so a rollback is one step back, never two. After a `curia uninstall` and reinstall there is none until the next update.

### Do this

```sh
curia rollback
```

The command takes no options and no version. It prints four named steps, `[1/4] preflight`, `[2/4] select`, `[3/4] validate`, and `[4/4] switch`. Read the line `rolling back from <active> to <rollback release>` before the switch starts. What each step does is in [What `curia rollback` does](../rollback.md#what-curia-rollback-does).

### What you should see

The command ends with `Curia <version> is running. Open the Curia app as before; nothing in integration setup has to be repeated.` Confirm with `curia version` and `curia doctor` as after an update.

### If it fails

A refusal (exit code `3`) changes nothing:

- `select: versions/ holds no release beside the active one`: there is nothing to roll back to. To move to another version, run `curia update <version>`.
- `select: versions/ holds two releases beside the active one`: a failed update left its staged target beside the rollback release. Run `curia update` to finish that update, or remove the staged release from `versions/`, then run `curia rollback` again.
- `validate: <version> refuses the current operator configuration`: the rollback release can't read `config/config.yaml` as it stands. Change the named line so both releases accept it, then run `curia rollback` again, or stay on the active release.

A failure (exit code `1`) at `switch` means the rollback release didn't come up. The command switched back once to the release that was running and says so. Read the log the message names, then run `curia rollback` again. When the switch back fails too, the message names `curia reinstall`, which starts the release the record names from its retained artifacts. Two releases that both fail their health check point at the host, not at either release.

The refusals and failures by message are under [Roll back](troubleshooting.md#roll-back) in Troubleshooting.

### Next

Run `curia doctor`, then return to [5. Daily operation](05-daily-operation.md). Report the release that failed at the [Curia repository](https://github.com/alp82/curia/issues) so it can be withdrawn.
