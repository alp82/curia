# Command reference

The `curia` command is the lifecycle interface of an installed Curia. This page lists the launcher, the commands, and the exit codes. It's a reference: the lifecycle topics in the operator guide tell you when to run each command and what to check afterwards. Follow those topics and open this page from them.

This page describes the vocabulary that the first packaged release ships. Commands that a later release adds say so on their own line.

## The launcher

The bootstrap installs one file, `~/.local/bin/curia`, and puts nothing else on your path. That file is the stable launcher. It runs as you, never as root, and it doesn't change across updates.

On every run, the launcher:

1. Reads `state/installation.json` in the installation root to find the active version.
2. Runs that version's own Node.js runtime on that version's lifecycle interface, from `versions/<active version>/` inside the installation root.

Each installed version carries its own pinned runtime, so the launcher needs no Node.js on the host. The launcher knows its installation root. A nondefault root is written into the launcher during bootstrap, so you never pass it on the command line.

When the installation record is missing, or the active version lacks its runtime or entry point, the launcher stops with exit code `3` and names the missing file. Run the bootstrap again to reinstall the active version. If you purged Curia, delete the launcher.

## The installation root

The installation root is the one directory that holds an installed Curia. You own it, and Curia never asks for privileges to work in it. Curia resolves the root in this order:

1. `CURIA_ROOT`, when set. The launcher sets it to the root it was installed for.
2. `$XDG_DATA_HOME/curia`, when `XDG_DATA_HOME` is set.
3. `~/.local/share/curia`.

The root must be an absolute path. To install into a nondefault root, pass the root to the bootstrap. The bootstrap writes that root into the launcher, and every later command reads it from there.

### Directory layout

Curia creates the root and seven directories inside it. The following table lists them, with what each one holds and what the lifecycle commands do with it.

| Directory | Holds | Across update, reinstall, and uninstall |
|---|---|---|
| `config/` | `config.yaml`, your operator configuration. See [Operator configuration](configuration.md). | Preserved |
| `secrets/` | Long-lived credentials and private keys, one owner-only file each. | Preserved |
| `state/` | Durable service state and the installation record, `state/installation.json`. | Preserved |
| `work/` | Worktrees and native agent sessions that can resume. | Preserved |
| `versions/` | Installed versions: the pinned runtime, the lifecycle interface, and the Compose bundle of each. | Replaceable |
| `cache/` | Rebuildable mirrors and download caches. | Removable |
| `run/` | The lifecycle lock, sockets, and staging for one operation. | Removable |

The root and all seven directories are owned by you with mode `0700`. Configuration, secret, and state files use mode `0600`. Curia sets these modes itself and doesn't depend on your `umask`. Only `curia purge` removes the preserved directories.

`state/installation.json` is the installation record. It holds three fields and nothing else: `format` (the record format, `1`), `installationId` (a random ID that Curia generates once per installation), and `activeVersion` (the installed version the launcher runs). Curia writes the record atomically, so the file is always either the previous complete record or the new one.

### When a lifecycle command refuses the root

Every lifecycle command checks the root before it changes anything. Each check that fails stops the command with exit code `3` and a message that names the path and the corrective action. `curia version` is read-only and skips these checks. The following conditions are refused:

- **Root execution.** The command runs as the `root` user. Run it as the operator that owns the installation. There is no force flag.
- **Foreign ownership.** The root or one of its seven directories belongs to another user.
- **Broad permissions.** The root or one of its seven directories has a mode that lets the group or other users reach it, such as `0755`. Curia doesn't repair the mode. Run `chmod 0700` on the named path and try again.
- **Symbolic links.** The root, one of its seven directories, or `state/installation.json` is a symbolic link. Curia doesn't follow links at those paths. Replace the link with a real directory or file.
- **An unknown nonempty root.** The root holds files but no installation record, so Curia can't tell whether the directory is a damaged installation or something else. Choose an empty or absent directory, or move the contents out of the way. Curia never deletes what it doesn't recognize.

A present but unreadable installation record is a failure (exit code `1`), not a refusal: Curia treats a damaged record as a damaged installation, never as a fresh directory.

### The lifecycle lock

One lifecycle operation runs at a time per installation root. A lifecycle command takes `run/lifecycle.lock` before it changes anything and releases the lock when it finishes, whether it succeeds or fails. A second command that finds the lock held stops with exit code `3` and names the process that holds it. Wait for that command to finish, then run yours again.

The lock file holds the process ID of its owner. When that process no longer exists, for example after a power loss during an update, the next lifecycle command takes the lock over on its own. You never delete the lock file by hand.

## Commands

Run `curia help` to print this list from the installed version. The commands appear in lifecycle order.

| Command | What it does | Available |
|---|---|---|
| `curia install` | Installs Curia into the installation root and starts it. | Later release |
| `curia reinstall` | Reinstalls the active version over a preserved installation root. It keeps `config/`, `secrets/`, `state/`, and `work/`. | Later release |
| `curia update` | Stages, verifies, and switches to the latest stable release. It accepts an exact version. It keeps the previous release for rollback. | Later release |
| `curia rollback` | Switches back to the one retained previous release. | Later release |
| `curia doctor` | Checks the host, operator configuration, integrations, containers, and service reachability. It's read-only and repairs nothing. | Later release |
| `curia uninstall` | Removes the runnable system and keeps `config/`, `secrets/`, `state/`, and `work/`. | Later release |
| `curia purge` | Removes the entire installation root and every Curia-labelled Docker resource, after one confirmation. | Later release |
| `curia version` | Prints the lifecycle interface version, the active installed version, and the installation root. | Now |
| `curia help` | Prints the command list and exit codes. | Now |

`curia --version` prints only the lifecycle interface version.

In this release, a command marked **Later release** checks the installation root as described in [When a lifecycle command refuses the root](#when-a-lifecycle-command-refuses-the-root), then exits with code `3` and a message that names the installed version and the release map. Nothing changes on the host.

## Exit codes

Every command and the launcher use the same four exit codes, so a script can branch on them. The following table lists them.

| Code | Name | Meaning |
|---|---|---|
| `0` | ok | The command did what it said. |
| `1` | failed | The operation started and failed. The installation may have changed. The message says what to do next. |
| `2` | usage | The command line was wrong. Nothing ran. Run `curia help`. |
| `3` | refused | Curia refused to start the operation. Nothing changed. The message names the condition and one corrective action. |

A refusal is not a failure. It means Curia checked a precondition, such as a missing runtime file or an unsupported host, and stopped before touching anything.

## Environment

`CURIA_ROOT` names the installation root. The launcher sets it for you. Set it yourself only when you run the lifecycle interface without the launcher, such as from a development checkout. The value must be an absolute path.
