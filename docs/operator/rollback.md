# Rollback

`curia rollback` switches an installed Curia back to the one release it kept from the last update, while your agents keep working. This page is the reference for which release that is, what the command does step by step, when it refuses, what happens when the rollback release doesn't come up, what an update does on its own when its switch fails, and the rule that keeps the rollback release able to read what a newer release wrote. [Update discovery, staging, and the switch](update.md) describes the switch itself; a rollback is that switch with the versions swapped. [Roll back](guide/07-update-or-roll-back.md#roll-back) in the operator guide is where you run it.

## The rollback release

After a successful `curia update`, `versions/` holds two complete releases: the active one and the release you updated from. That second release is the rollback release. Curia keeps exactly one. It doesn't keep older releases, configuration snapshots, or a history of switches, so a rollback is one step back, never two.

`curia rollback` finds the rollback release by looking: it's the one complete release under `versions/` that isn't the active one. Two cases have no answer, and the command refuses both without guessing:

- **No other release.** You haven't updated since the install, or a reinstall replaced `versions/` whole. There is nothing to roll back to.
- **Two other releases.** An update failed at its switch and left its staged target beside the rollback release. Finish that update with `curia update`, or remove the staged release you don't want from `versions/`, then run `curia rollback` again. The message names both releases.

When the only other release is the staged target of an update that failed before any update ever succeeded, the command treats that target as the rollback release, because nothing on disk says otherwise. The line `rolling back from <active> to <target>` tells you which way the switch goes. Read it before the switch starts. To retry that update instead, run `curia update`.

## What `curia rollback` does

The command runs four named steps in order and prints each one as `[n/4] <step>`. The following table lists them.

| Step | What it does | What it changes |
|---|---|---|
| 1. `preflight` | Checks the installation root as [When a lifecycle command refuses the root](command-reference.md#when-a-lifecycle-command-refuses-the-root) describes, requires an installation there, then runs the host checks in [Supported hosts and preflight checks](supported-hosts.md). | Nothing. |
| 2. `select` | Takes the lifecycle lock, which it holds until the command ends, and finds the rollback release as the preceding section describes. Prints `rolling back from <active> to <rollback release>`. | Nothing. |
| 3. `validate` | Has the rollback release validate your current operator configuration with its own reader, the same way `curia update` has the target validate it. A `config/config.yaml` the rollback release refuses stops the command here. | Nothing. |
| 4. `switch` | Recreates the service, the app, and the overseer from the rollback release's bundle while tmux, ttyd, and the agent containers keep running, then accepts the rollback release and records it as active. This is [What the switch does](update.md#what-the-switch-does), with the versions swapped. | `run/compose.env`, the three recreated containers, `state/installation.json`, and `versions/`. |

On success the command prints `Curia <version> is running.` and names what the two releases now are: the release you rolled back from is the new rollback release, so a second `curia rollback` switches forward to it again, and the next `curia update` replaces it.

The command takes no options and no version. There is one rollback release, so there is nothing to select.

### What a rollback keeps

A rollback changes the record and the three core containers, and nothing else. `config/`, `secrets/`, `state/`, and `work/` are untouched, byte for byte: your configuration, your secret files, the journal and every other record under `state/`, and every worktree and session under `work/`. The tmux runtime, the attach surface, and every running agent container keep running through the switch, as [What keeps running](update.md#what-keeps-running) describes. Nothing in integration setup has to be repeated, and no Full loop runs.

The launcher at `~/.local/bin/curia` is never rewritten: it reads the record on every run, so after the rollback it runs the rollback release's lifecycle interface on its own.

## When the rollback is refused

A refusal (exit code `3`) names the step and changes nothing. The running release is not touched, no container is recreated, and the record still names the active version.

| Refusal | What it means | What to do |
|---|---|---|
| `select: versions/ holds no release beside the active one` | There is no rollback release. | Nothing to roll back. To move to another version, run `curia update <version>`. |
| `select: versions/ holds two releases beside the active one, <active>: <a> and <b>` | A failed update left its staged target beside the rollback release. | Run `curia update` to finish that update, or remove the staged release from `versions/`, then run `curia rollback` again. |
| `validate: <version> refuses the current operator configuration: <path> line <n>: ...` | The rollback release can't read `config/config.yaml` as it is now. The line names the key and the rule, the same way the release's own service would print it. This is the blocking incompatibility: rolling back would start a release that refuses its configuration. | Change the named line so that both releases accept the file, as [Operator configuration](configuration.md) describes, then run `curia rollback` again. Or stay on the active release. |
| `validate: <version> carries no operator configuration reader` | The rollback release is older than the operator configuration contract, so Curia can't prove that it reads this installation. | Stay on the active release. No packaged release is this old; the message exists for a rehearsal that installs one on purpose. |
| `preflight: ...` | The root or the host was refused. | Follow the corrective action in the message. |
| `select: another lifecycle operation is running` | A second lifecycle command holds the lock. | Wait for it to finish, as [The lifecycle lock](command-reference.md#the-lifecycle-lock) describes. |

## When the rollback release doesn't come up

The `switch` step accepts the rollback release the way an update accepts its target: every service healthy, the service and the app reporting the rollback release's version, and every live session adopted back. When acceptance fails, the switch goes back once to the release that was running, proves it the same way, and reports both outcomes. The command exits with code `1`:

```text
curia rollback: switch failed: daemon exited with code 1. Read its log with 'docker compose ... logs daemon', fix the cause, and run the command again. Switched back to 1.4.0, which is healthy and re-adopted 2 live sessions. The record still names 1.4.0.
Run '/home/you/.local/bin/curia rollback' to run switch again; the completed steps are kept.
```

The record is written only after acceptance, so a failed rollback never changes `activeVersion`, and both releases stay under `versions/`. A rerun repeats the four steps and switches again. Nothing runs the rollback release a second time on its own.

When the switch back doesn't come up either, the message says so and names `curia reinstall`, which starts the release the record names from its retained artifacts. Two releases that both fail their health check point at the host, not at either release; read the logs the message names first.

## What an update does on its own

A failed `curia update` rolls back once by itself. When the target fails acceptance at the `switch` step, the command:

1. Recreates the service, the app, and the overseer from the release that was active, once.
2. Waits until every service reports healthy, with the same four-minute bound.
3. Reads the version the service and the app report. Both must be the release that was active.
4. Reads the live sessions from the recreated service until every session that was live before the switch is adopted back, for up to two minutes.
5. Reports the failed update: the cause, the outcome of the switch back, and the fact that the record still names the release that was active.

It never retries the target, and it never switches back a second time. A switch back that fails its own proof is reported as failed too, with `curia reinstall` as the way out, and the command stops there. Nothing restarts in a loop: every recreate is one `docker compose up`, run once, and the only automatic recovery is the one switch back. Your next move is yours: rerun `curia update` to try the target again, or leave the installation on the release that was active, which is running. [When the switch fails](update.md#when-the-switch-fails) lists the failure messages.

## Migrations and the rollback release

A minor release may add a restart-safe migration to what it keeps under `state/` and `work/`, and the retained rollback release must still read what that migration wrote. Otherwise a rollback would start a release that can't read its own journal. The rule that makes this true is that a minor release's migrations are additive:

- **The journal** (`state/` holds the service's `events.db`). A minor release may add a column with a default, an index, a table, or a trigger. It never renames, drops, retypes, or constrains a column, never rewrites a row's `body`, and never sets a schema version that the previous release refuses. The rollback release then opens the journal, writes rows that take the new column's default, and reads every row in order, including the rows the newer release wrote. `daemon/test/journalforward.test.mjs` proves this against a journal migrated that way.
- **The records under `state/`** (`installation.json`, `discord.json`, `tailscale.json`, `setup.json`, `update-check.json`, `routing.local.yaml`). Each JSON record carries `format: 1`. A minor release may add an optional key that the previous release ignores. It never changes the meaning of a key, removes one, or raises the format number. The installation record holds exactly `format`, `installationId`, and `activeVersion`, and every release of this major refuses any other key, so a minor release adds nothing there.
- **`work/`** (worktrees, per-session configuration directories, the overseer's native sessions). A minor release may add files. It never moves or renames what a live session or a resumable one depends on.
- **`config/config.yaml`.** A minor release may add an optional key. Whether the rollback release accepts the file as it stands is what the `validate` step checks, with that release's own reader, so a key the rollback release doesn't know is refused before anything switches.

A change that can't follow this rule is a major release, and a major release needs its own lifecycle specification. Rollback across a major version isn't supported.
