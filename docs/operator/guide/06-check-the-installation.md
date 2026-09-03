# 6. Check the installation

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · [4. Run the Test run](04-run-the-test-run.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · **6. Check the installation (this topic)**
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

**Outcome:** One screen that says whether the host, the installation, the configuration, the installed release, the secret files, the containers, the service, the four integrations, and the Curia app are in order, with one corrective action under every problem.

**Starting state:** An installed Curia. The service may be up or down; the command reports either way.

**Active operator time:** About 1 minute. The command runs for 10 to 60 seconds, most of it the host probes and the provenance check.

## What the command changes

Nothing. `curia doctor` is read-only: it takes no lifecycle lock, repairs nothing, keeps no history, and prints no secret value. Every line passes a redaction step, so you can paste the output into a support request as it is.

## Do this

```sh
curia doctor
```

The command takes no options.

## What you should see

Nine sections, `host`, `installation`, `configuration`, `release`, `secrets`, `containers`, `service`, `integrations`, and `app`, one line per check, each starting with `ok`, `warning`, `failed`, or `refused`, and a summary line such as `33 checks passed, 0 warnings, failed: 0 conditions.` The exit code is `0` when nothing failed; warnings don't change it. What every check proves, with a sample of the output, is in [Diagnostics with `curia doctor`](../doctor.md#the-checks).

## If a check fails

The line under a `failed` or `refused` check is the one corrective action. Take it, then run `curia doctor` again. The exit code is `1` while any check fails or any host condition is refused.

Two checks need a note:

- `image provenance` asks `gh attestation verify` and needs the GitHub CLI logged in. When it isn't, the action prints the command to run after `gh auth login`. Nothing else in Curia depends on that login.
- Exit code `3` means the installation root itself refused the command before any check ran, for example a directory another user owns. The message names the path and the fix; see [When a lifecycle command refuses the root](../command-reference.md#when-a-lifecycle-command-refuses-the-root).

The failures by message are under [Check the installation](troubleshooting.md#check-the-installation) in Troubleshooting.

## When to run it

- After `curia install`, to see the whole installation before you connect services.
- When the Curia app doesn't open, a card on the Setup screen fails, the bot doesn't answer, or a container shows `unhealthy` in `docker compose -p curia ps`.
- Before and after `curia update` or `curia rollback`.
- Before you ask for help.

## Next

Return to [5. Daily operation](05-daily-operation.md), or, when the action the doctor named is a lifecycle command, open [7. Update or roll back](07-update-or-roll-back.md) or [9. Uninstall or purge](09-uninstall-or-purge.md).
