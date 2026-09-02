# 8. Migrate the current deployment

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · [4. Run your first Full loop](04-run-your-first-full-loop.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · **8. Migrate the current deployment (this topic)** · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

This topic applies to one installation only: the source deployment that ran Curia from a checkout with `deploy/compose.yaml` and `daemon/.env.daemon` before the package existed. If you installed Curia with the bootstrap, skip this topic. The clean installation route never includes a migration step, and Curia publishes no generic migration utility.

**Outcome:** The source deployment's operator intent, credentials, journal, results, attachments, and native sessions live in a supported installation root on a separate Ubuntu 24.04 host, proven by one Full loop there, and the source deployment is retired.

**Starting state:** The source deployment at the exact commit the runbook names, with a clean checkout, no running agent, review, or operator turn, and new dispatches disabled. A separate Ubuntu 24.04 host prepared as in [1. Check prerequisites](01-check-prerequisites.md) and installed as in [2. Install Curia](02-install-curia.md) with the target release the runbook names. SSH between the two hosts.

**Active operator time:** about 60 minutes, as the runbook states, plus the copy and the Full loop as waits. Plan a maintenance window: the source is stopped before the copy, and it stays stopped until the target's Full loop passes or you roll back.

## What the migration keeps

- **The source stays intact until acceptance.** The runbook stops the source, records the evidence, copies, and validates. Rollback is restarting the unchanged source deployment. Nothing on the source is deleted before the target's Full loop passes.
- **Moved into supported boundaries:** the operator intent (`curia.local.yaml` values into `config/config.yaml`), the four credentials (from the env file into owner-only files under `secrets/`), the journal with its integrity checked and its row bounds recorded, results, attachments, and the overseer's native sessions.
- **Excluded:** caches and runtime state. The runbook doesn't migrate live containers or tmux sessions, which is why it requires zero active work first.
- **Never used twice at once:** the Discord bot token. The runbook refuses to run the source and the target on the same credential at the same time.
- **After acceptance:** the runbook's cleanup removes the duplicate secrets and the old runtime resources on the source. External GitHub, Discord, Tailscale, and model-provider resources stay in use and are never deleted or revoked.

## Do this

Follow [The source cutover runbook](../source-cutover-runbook.md). It names the accepted source commit, the expected source layout, the target release, and every command, and `deploy/cutover/cutover.mjs` runs its mechanical steps, dry-run by the daemon suite against a copy of the layout. The contract it implements is [Define the isolated legacy migration contract](https://github.com/alp82/curia/issues/856).

The runbook runs in this order, and every step names its refusal:

1. **Admission.** Refuses a dirty or unexpected source, active work, a failed target preflight, ambiguous paths, and simultaneous use of the Discord credential.
2. **Evidence.** Records the stopped journal's integrity and bounds, the file inventory with hashes, ownership, permissions, and the source identity, and stages the copy over protected SSH.
3. **Transformation.** Maps every preserved item into the target's installation-root boundaries.
4. **Validation.** Checks the integrations, the artifacts, the configuration, the permissions, the absence of the source paths on the target, and one Full loop, as in [4. Run your first Full loop](04-run-your-first-full-loop.md).
5. **Rollback or cleanup.** Restarts the unchanged source until acceptance, or removes the duplicate secrets and old runtime resources after it.

## What you should see

`curia doctor` on the target reads `ok` in every section, the Settings screen shows the values that were in `curia.local.yaml`, the Feed shows the journal's history, and the target's Full loop reads **Full loop verified**.

## If it fails

Every step of the runbook names its own corrective action and the same-step retry. A validation that fails before acceptance is a rollback: restart the source deployment as the runbook describes, and the target stays installed for the next attempt.

## Next

Operate the target as in [5. Daily operation](05-daily-operation.md). The source host's own retirement is the runbook's cleanup step, not a `curia purge`.
