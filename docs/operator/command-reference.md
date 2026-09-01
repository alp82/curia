# Command reference

The `curia` command is the lifecycle interface of an installed Curia. This page lists the launcher, the commands, and the exit codes. It's a reference: the lifecycle topics in the operator guide tell you when to run each command and what to check afterwards. Follow those topics and open this page from them.

This page describes the vocabulary that the first packaged release ships. Commands that a later release adds say so on their own line.

## The launcher

The bootstrap installs one file, `~/.local/bin/curia`, and puts nothing else on your path. That file is the stable launcher. It runs as you, never as root, and it doesn't change across updates.

On every run, the launcher:

1. Reads `state/installation.json` in the installation root to find the active version.
2. Runs that version's own Node.js runtime on that version's lifecycle interface, from `versions/<active version>/` inside the installation root.

Each installed version carries its own pinned runtime, so the launcher needs no Node.js on the host. The launcher knows its installation root. The default root is `$XDG_DATA_HOME/curia`, or `~/.local/share/curia` when `XDG_DATA_HOME` is unset. A nondefault root is written into the launcher during bootstrap, so you never pass it on the command line.

When the installation record is missing, or the active version lacks its runtime or entry point, the launcher stops with exit code `3` and names the missing file. Run the bootstrap again to reinstall the active version. If you purged Curia, delete the launcher.

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

In this release, a command marked **Later release** exits with code `3` and a message that names the installed version and the release map. Nothing changes on the host.

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

`CURIA_ROOT` names the installation root. The launcher sets it for you. Set it yourself only when you run the lifecycle interface without the launcher, such as from a development checkout.
