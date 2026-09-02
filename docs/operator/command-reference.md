# Command reference

The `curia` command is the lifecycle interface of an installed Curia. This page lists the launcher, the commands, and the exit codes. It's a reference: the lifecycle topics in the operator guide tell you when to run each command and what to check afterwards. Follow those topics and open this page from them.

This page describes the vocabulary that the first packaged release ships. Commands that a later release adds say so on their own line.

## The launcher

[The bootstrap](bootstrap.md) installs one file, `~/.local/bin/curia`, and puts nothing else on your path. That file is the stable launcher. It runs as you, never as root, and it doesn't change across updates.

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

The root must be an absolute path. To install into a nondefault root, pass `--root` to [the bootstrap](bootstrap.md). The bootstrap writes that root into the launcher, and every later command reads it from there.

### Directory layout

Curia creates the root and seven directories inside it. The following table lists them, with what each one holds and what the lifecycle commands do with it.

| Directory | Holds | Across update, reinstall, and uninstall |
|---|---|---|
| `config/` | `config.yaml`, your operator configuration. See [Operator configuration](configuration.md). | Preserved |
| `secrets/` | Long-lived credentials, one owner-only file each. See [Secrets, mounts, and what survives](secrets.md). | Preserved |
| `state/` | The installation record `state/installation.json`, the journal, attachments, results, and the service's own token records. | Preserved |
| `work/` | Worktrees, per-session config directories, and the overseer's native sessions, all of which can resume. | Preserved |
| `versions/` | Installed versions: the pinned runtime, the lifecycle interface, the release manifest, the Compose bundle, and the retained artifacts of each. See [Release images and the Compose bundle](bundle.md) and [The release manifest and release verification](release-manifest.md). | Replaceable |
| `cache/` | The overseer's mirrors of origin and the containers' home directory with its tool caches. | Removable |
| `run/` | The lifecycle lock, renewable tokens, sockets, and staging for one operation. | Removable |

The root and all seven directories are owned by you with mode `0700`. Configuration, secret, and state files use mode `0600`. Curia sets these modes itself and doesn't depend on your `umask`. Only `curia purge` removes the preserved directories. What each container mounts from the root, and what a restart keeps, is in [Secrets, mounts, and what survives](secrets.md).

`state/installation.json` is the installation record. It holds three fields and nothing else: `format` (the record format, `1`), `installationId` (a random ID that Curia generates once per installation), and `activeVersion` (the installed version the launcher runs). Curia writes the record atomically, so the file is always either the previous complete record or the new one.

### When a lifecycle command refuses the root

Every lifecycle command checks the root before it changes anything. Each check that fails stops the command with exit code `3` and a message that names the path and the corrective action. `curia version` is read-only and skips these checks. The following conditions are refused:

- **Root execution.** The command runs as the `root` user. Run it as the operator that owns the installation. There is no force flag.
- **Foreign ownership.** The root or one of its seven directories belongs to another user.
- **Broad permissions.** The root or one of its seven directories has a mode that lets the group or other users reach it, such as `0755`. Curia doesn't repair the mode. Run `chmod 0700` on the named path and try again.
- **Symbolic links.** The root, one of its seven directories, or `state/installation.json` is a symbolic link. Curia doesn't follow links at those paths. Replace the link with a real directory or file.
- **An unknown nonempty root.** The root holds files but no installation record, so Curia can't tell whether the directory is a damaged installation or something else. Choose an empty or absent directory, or move the contents out of the way. Curia never deletes what it doesn't recognize.

A present but unreadable installation record is a failure (exit code `1`), not a refusal: Curia treats a damaged record as a damaged installation, never as a fresh directory.

### When a lifecycle command refuses the host

After the root, `curia install` and `curia update` check the host itself, and `curia doctor` runs the same checks. A refused host condition, such as another operating-system release, a busy port, or a Docker daemon your user can't reach, stops the command with exit code `3` and one corrective action. A warning, such as a host below the recommended profile, doesn't stop anything. The systems, the profile, every check, and every corrective action are in [Supported hosts and preflight checks](supported-hosts.md).

### When a lifecycle command refuses a release

Before `curia install` or `curia update` activates a version, it verifies the downloaded artifacts against the release manifest: the manifest itself, the version, the npm integrity of the package, the bundle checksum, every image digest, and the copy of the manifest on the GitHub release. A check that fails stops the command with exit code `3`, names the condition, and gives one corrective action. Nothing is unpacked and the active version doesn't change. `curia doctor` repeats the checks on the active version and adds the publication provenance of each image and of the package. The manifest, every check, and every failure class are in [The release manifest and release verification](release-manifest.md).

### How a version is selected

`curia update` reads the signed stable-release index and selects the stable release it names. With an exact version it selects that version; with `--prerelease` and an exact prerelease version it selects that prerelease, which is never selected otherwise. A withdrawn version is refused in every form, with exit code `3`. The index, the signature, promotion, and withdrawal are in [Releases, the stable-release index, and version selection](releases.md).

### The lifecycle lock

One lifecycle operation runs at a time per installation root. A lifecycle command takes `run/lifecycle.lock` before it changes anything and releases the lock when it finishes, whether it succeeds or fails. A second command that finds the lock held stops with exit code `3` and names the process that holds it. Wait for that command to finish, then run yours again.

The lock file holds the process ID of its owner. When that process no longer exists, for example after a power loss during an update, the next lifecycle command takes the lock over on its own. You never delete the lock file by hand.

## Commands

Run `curia help` to print this list from the installed version. The commands appear in lifecycle order.

| Command | What it does | Available |
|---|---|---|
| `curia install` | Installs Curia into the installation root and starts it. | Later release |
| `curia reinstall` | Reinstalls the active version over a preserved installation root. It keeps `config/`, `secrets/`, `state/`, and `work/`. | Later release |
| `curia update` | Stages, verifies, and switches to the stable release named in the stable-release index. `curia update <version>` selects an exact version, and `curia update --prerelease <version>` selects an exact prerelease. It keeps the previous release for rollback. See [How a version is selected](#how-a-version-is-selected). | Later release |
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

A refusal is not a failure. It means Curia checked a precondition, such as a missing runtime file or an unsupported host, and stopped before touching anything. The host preconditions are in [Supported hosts and preflight checks](supported-hosts.md).

## Environment

`CURIA_ROOT` names the installation root. The launcher sets it for you. Set it yourself only when you run the lifecycle interface without the launcher, such as from a development checkout. The value must be an absolute path.
