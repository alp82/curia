# @curia-sh/cli

Curia's lifecycle interface. It installs, updates, rolls back, diagnoses, and removes one Curia installation. It contains no Curia service code: the service, the app, and the overseer run in containers that the Compose bundle of an installed version describes.

For the operator's view, read the [command reference](https://github.com/alp82/curia/blob/main/docs/operator/command-reference.md). This file is for people who work on the package.

## What this version ships

This version ships the stable launcher, the command vocabulary, the installation-root boundary, and the operator configuration contract. Every lifecycle command exists and routes. Each one opens its root through the boundary first, so the root refusals are real, and then refuses with exit code `3` and a message that names the version and the release map. The follow-up tickets in [Ship Curia's supported installation lifecycle](https://github.com/alp82/curia/issues/863) fill the commands in.

## Layout

- `bin/curia.mjs`: the process entry. It hands `argv`, `env`, and the streams to `runCli` and exits with what `runCli` returns.
- `src/cli.mjs`: `runCli`. It routes one command, prints usage, turns a thrown `Refusal` into exit `3` and any other error into exit `1`. Nothing in the package calls `process.exit`.
- `src/commands.mjs`: the command table, in lifecycle order. One entry per command with a one-line summary and a `run(context)`.
- `src/exit.mjs`: the four exit codes and the `Refusal` error.
- `src/root.mjs`: the installation root. `installationRoot(env)` resolves it, `openRoot(root, { uid })` is the one safe way in and raises every boundary refusal, `ensureLayout` creates the root and its seven boundaries with mode `0700`, and the record functions read and write `state/installation.json`. It also names the two paths an installed version must have.
- `src/atomic.mjs`: `writeAtomically(path, content, { mode })`, the temporary-file, `fsync`, and rename write that every critical file goes through.
- `src/config.mjs`: the operator configuration contract, `config/config.yaml`. One reader, validator, renderer, and atomic writer, shared with the Curia service and the Curia app. See [The operator configuration](#the-operator-configuration).
- `src/lock.mjs`: `withLifecycleLock(root, operation)`, the exclusive lifecycle-operation lock at `run/lifecycle.lock`.
- `src/launcher.mjs`: renders the stable `curia` launcher for one installation root.

## The root boundary

A lifecycle command's `run` gets `{ env, args, stdout, stderr, uid, root }`. It calls `openRoot(root, { uid })` before it does anything else and reads the status that comes back: `absent`, `empty`, or `installed` with the record. `openRoot` throws a `Refusal` for root execution, a relative root, a symbolic link at the root, a boundary, or the record, foreign ownership, a mode that reaches past the owner, and a nonempty root without a record. A command that changes the installation then calls `ensureLayout` if it may create the root, and wraps its work in `withLifecycleLock`. The order matters: the boundary refuses before the lock exists, and the lock lives under `run/`, which `ensureLayout` creates.

A command that writes a record calls `createInstallationRecord(version)` and `writeInstallationRecord(root, record)`. The writer rejects any key beyond `format`, `installationId`, and `activeVersion`. Write the record as soon as the layout exists: `openRoot` recognizes a root by its record, so a root that has a layout but no record reads as unknown on the next run.

## The operator configuration

`src/config.mjs` is the one module that reads, validates, renders, and writes `config/config.yaml`. The daemon and the Curia app import it from `daemon/src` by relative path (`../../cli/src/config.mjs`), and the source deployment's compose file mounts `cli/src` into their containers for that reason. One module in three processes is what keeps a file meaning one thing and a refusal reading the same everywhere. The operator's view is [Operator configuration](https://github.com/alp82/curia/blob/main/docs/operator/configuration.md).

The interface:

- `OPERATOR_CONFIG_KEYS` and `WATCH_MODES` name the contract. `operatorConfigPath(root)` is `<root>/config/config.yaml`.
- `readOperatorConfig(path)` returns the validated configuration, `null` when there is no file, and throws a `ConfigError` for a symbolic link or an invalid file. The message carries the path, the line, the key, and the rule.
- `parseOperatorConfig(text, { file })` and `validateOperatorConfig(data)` are the two doors in: text from disk, or an object from the app. Both apply one table of rules.
- `renderOperatorConfig(data)` validates and prints the file in contract order. `writeOperatorConfig(path, data)` does that and lands it through `writeAtomically` with mode `0600`. An invalid configuration throws before anything touches the disk.
- `initialOperatorConfig()` is what `curia install` writes: `{ max_concurrent: 4 }` and nothing else.

The reader is a strict subset of YAML written by hand, because the package has no dependencies and the file has one small documented shape. It refuses what it does not read, by line, rather than guessing. A `ConfigError` is not a `Refusal`: the command that meets one decides what it means, so `curia doctor` reports it and `curia install` fails on it.

## The launcher

The bootstrap writes `~/.local/bin/curia` once per installation. The launcher is a POSIX shell script with the installation root written into it. On each run it reads `state/installation.json`, takes `activeVersion`, and runs:

```text
<root>/versions/<activeVersion>/node/bin/node <root>/versions/<activeVersion>/cli/bin/curia.mjs "$@"
```

with `CURIA_ROOT` exported. An update changes the active version and never rewrites the launcher. When the record is missing or either file is absent, the launcher exits `3` and names the missing file.

`versions/<version>/cli/` is the unpacked package: the `package/` directory of the npm tarball. `versions/<version>/node/` is the pinned Node runtime. Later versions may add sibling files under the version directory; the launcher reads only these two paths.

## Tests

```sh
npm test
```

The suite has no dependencies and reads no file outside its own temporary directories. `test/package.test.mjs` runs `npm pack` and installs the tarball into an empty prefix, so it needs `npm` and `tar` on the path. The launcher tests run the rendered script with `/bin/sh` against a fake version directory whose `node` is a shell script that reports how it was called.

There is no build step. `npm pack` produces the release artifact.
