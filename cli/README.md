# @curia-sh/cli

Curia's lifecycle interface. It installs, updates, rolls back, diagnoses, and removes one Curia installation. It contains no Curia service code: the service, the app, and the overseer run in containers that the Compose bundle of an installed version describes.

For the operator's view, read the [command reference](https://github.com/alp82/curia/blob/main/docs/operator/command-reference.md). This file is for people who work on the package.

## What this version ships

This version ships the stable launcher, the command vocabulary, the installation-root boundary, the operator configuration contract, the supported-host preflight, the Compose bundle contract, and the release manifest with its verification. Every lifecycle command exists and routes. Each one opens its root through the boundary first, so the root refusals are real, and then refuses with exit code `3` and a message that names the version and the release map. The follow-up tickets in [Ship Curia's supported installation lifecycle](https://github.com/alp82/curia/issues/863) fill the commands in.

## Layout

- `bin/curia.mjs`: the process entry. It hands `argv`, `env`, and the streams to `runCli` and exits with what `runCli` returns.
- `src/cli.mjs`: `runCli`. It routes one command, prints usage, turns a thrown `Refusal` into exit `3` and any other error into exit `1`. Nothing in the package calls `process.exit`.
- `src/commands.mjs`: the command table, in lifecycle order. One entry per command with a one-line summary and a `run(context)`.
- `src/exit.mjs`: the four exit codes and the `Refusal` error.
- `src/root.mjs`: the installation root. `installationRoot(env)` resolves it, `openRoot(root, { uid })` is the one safe way in and raises every boundary refusal, `ensureLayout` creates the root and its seven boundaries with mode `0700`, and the record functions read and write `state/installation.json`. It also names the two paths an installed version must have.
- `src/atomic.mjs`: `writeAtomically(path, content, { mode })`, the temporary-file, `fsync`, and rename write that every critical file goes through.
- `src/config.mjs`: the operator configuration contract, `config/config.yaml`. One reader, validator, renderer, and atomic writer, shared with the Curia service and the Curia app. See [The operator configuration](#the-operator-configuration).
- `src/lock.mjs`: `withLifecycleLock(root, operation)`, the exclusive lifecycle-operation lock at `run/lifecycle.lock`.
- `src/layout.mjs`: `serviceLayout(root)`, where the service data lives inside the seven boundaries, and `SERVICE_MOUNTS`, what each container may mount. See [The service layout and the secret files](#the-service-layout-and-the-secret-files).
- `src/secrets.mjs`: the catalogue of long-lived secret files under `secrets/`, their reader, writer, and status, shared with the Curia service.
- `src/bundle.mjs`: the Compose bundle contract: the project name, the installation label, the four release images, the run-time variables, and the render, inspect, and env-file functions. See [The Compose bundle](#the-compose-bundle).
- `src/manifest.mjs`: the release manifest contract and the release verification: what one release is, how the manifest is created, rendered, and parsed, and the two verification doors that `curia install`, `curia update`, and `curia doctor` call. See [The release manifest](#the-release-manifest).
- `src/archive.mjs`: `readArchive(bytes)`, a reader for gzipped tar archives, which is how the verification opens the package tarball and the bundle archive without a system `tar`.
- `src/preflight.mjs`: the supported-host preflight. `gatherHostFacts` reads the host through injectable probes, `evaluateHostFacts` turns the facts into one report, and `preflight` does both and prints it. See [The host preflight](#the-host-preflight).
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

## The service layout and the secret files

`src/layout.mjs` is the one place that says where the service's mutable data lives inside the root, and what each container may see of it. The daemon imports it through `daemon/src/paths.mjs`, and the Compose bundle at `deploy/bundle/compose.yaml` is inspected against it by `daemon/test/bundlecompose.test.mjs`. The operator's view is [Secrets, mounts, and what survives](https://github.com/alp82/curia/blob/main/docs/operator/secrets.md).

- `serviceLayout(root)` returns the seven boundaries plus the paths inside them that a service names: `overseerConfigDir` under `work/`, `home` and `overseerRepos` under `cache/`, `overseerTokens` under `run/`. Every path sits in the boundary whose lifecycle class it has, so the survival contract of the root applies with no extra rule.
- `SERVICE_MOUNTS` lists, per service, the layout paths it mounts and the mode. The service gets `config/` read-only and the other five mutable boundaries read-write. The tmux runtime gets `work/` and `home`. The attach surface and the app get nothing. The overseer gets its config directory and its mirrors read-write and its tokens read-only. `DOCKER_SOCKET_SERVICES` names the two containers that reach the Docker socket.

`src/secrets.mjs` is the catalogue of long-lived credentials, one owner-only file each under `secrets/`:

- `SECRET_FILES` names the four files, what each holds, and who writes it. `SECRET_NAMES` is the list of names.
- `readSecret(root, name)` returns the text or `null`, and throws a `SecretError` for a symbolic link, a foreign owner, or a mode that reaches past the owner. `writeSecret(root, name, text)` lands the file through `writeAtomically` at mode `0600` and refuses an empty value.
- `secretsStatus(root)` reports each file as `present`, `absent`, or `refused` with the reason, and never reads a value. `curia doctor` and the service's overview use it.
- `credentialsInEnvironment(env)` names the environment keys that carry a credential. The service refuses to boot under a root while any of them is set. `redact(text, values)` replaces given values in a text on its way to a log or a response.

A `SecretError` is not a `Refusal`, for the same reason a `ConfigError` is not: the command that meets one decides what it means.

## The host preflight

`src/preflight.mjs` is the one module that decides whether the host can carry an operation. `curia install` (#873) and `curia update` (#883) call it after `openRoot` and before the lock, and `curia doctor` (#881) calls it for its host section. The operator's view is [Supported hosts and preflight checks](https://github.com/alp82/curia/blob/main/docs/operator/supported-hosts.md).

The interface:

- `preflight({ uid, root, stdout }, probes)` gathers the facts, evaluates them, prints the report on `stdout`, and returns `{ ok, checks, refusal, facts }`. A command throws `report.refusal`, a `Refusal`, when `ok` is false. Pass `facts` instead of `uid` and `root` to evaluate facts you already have.
- `gatherHostFacts({ uid, root }, probes)` reads the host into one plain object: `os`, `arch`, `cpus`, `memoryBytes`, `disk`, `ports`, `docker`, `compose`, `tailscale`, and `outbound`. Every read goes through `probes`, whose default is `hostProbes`: `exec`, `readFile`, `arch`, `cpus`, `memoryBytes`, `freeDiskBytes`, `socketAccessible`, `groups`, and `fetchOrigin`. A test hands in fakes, so the suite never depends on the machine it runs on. The test file's `ubuntu()` fixture is the shape of the facts.
- `evaluateHostFacts(facts)` is pure. It returns one result per entry of `CHECKS`, in order, each `{ name, status, observed, action }` with `status` one of `passed`, `warning`, or `refused`. A refused check carries the one corrective action. `refusal` is one `Refusal` that lists every refused condition, so the operator sees all of them at once.
- `renderPreflight(report)` prints one line per check and a summary line.
- The constants are the contract: `SUPPORTED_SYSTEMS`, `MINIMUM_PROFILE`, `RECOMMENDED_PROFILE`, `TESTED_VERSIONS`, `REQUIRED_PORTS`, `SANDBOX_PORTS`, `RELEASE_ORIGINS`, and `CLOCK_SKEW_LIMIT_SECONDS`. `daemon/test/preflightports.test.mjs` keeps the ports in step with `config/curia.yaml`.

Three probes create temporary resources, and each removes its own before it returns: the port probe listens on every port it tests and closes the listener; the Docker probe writes one temporary directory, opens one loopback HTTP listener, and runs one `--rm` container named `curia-preflight-<id>` that reads the directory through a bind mount and fetches the listener over the host network, then removes the container by force when the run failed or timed out, closes the listener, and deletes the directory. Nothing in the module installs or reconfigures the host.

## The Compose bundle

`src/bundle.mjs` is the one place that says what a release's Compose bundle is, shared by the release workflow that renders it, the tests that inspect it, and the lifecycle commands that start it. The operator's view is [Release images and the Compose bundle](https://github.com/alp82/curia/blob/main/docs/operator/bundle.md).

- The constants are the contract: `COMPOSE_PROJECT` (`curia`), `INSTALLATION_LABEL` (`sh.curia.installation`), `IMAGE_REGISTRY` (`ghcr.io/alp82`), `RELEASE_IMAGES` (the four images by service), and `BUNDLE_VARIABLES` (the five run-time variables, in env-file order).
- `imageReference(service, digest)` is `ghcr.io/alp82/<image>@sha256:<digest>` and refuses anything but a full digest.
- `renderBundle(template, digests)` replaces each `${CURIA_<SERVICE>_IMAGE...}` in `deploy/bundle/compose.yaml` with the digest reference and leaves every other variable alone. It is deterministic.
- `inspectBundle(text)` returns the problems a rendered bundle has, one line each: a project name other than `curia`, an image that is not a digest reference under the registry, a variable outside the run-time set, a build stanza, an env file, or an operator path. Empty means fit to publish.
- `bundleEnvironment({ root, uid, gid, dockerGid, installationId })` renders the env file `curia install` writes under `run/` and passes with `--env-file`. Paths and numbers only.

The module reads text by line and never a YAML tree, because the package has no dependencies and every question is answerable that way. The release script that uses it is `deploy/bundle/render.mjs`, which writes the bundle directory, a deterministic `.tar.gz`, its `.sha256`, and the digest set for one version. `deploy/bundle/pins.mjs` reads the Node and Claude Code pins the images build with from `config/curia.yaml`.

## The release manifest

`src/manifest.mjs` is the one place that says what a Curia release is and proves that a downloaded or installed one is whole. The release workflow writes the manifest through `deploy/bundle/render.mjs`, the publication step copies it into this package as `manifest.json`, and the lifecycle commands verify against it. The operator's view is [The release manifest and release verification](https://github.com/alp82/curia/blob/main/docs/operator/release-manifest.md).

The contract:

- `MANIFEST_FORMAT` (`1`), `PACKAGE_NAME` (`@curia-sh/cli`), `RELEASE_REPOSITORY` (`alp82/curia`), `RELEASE_WORKFLOW` (the signer workflow), and `MANIFEST_FILE` (`manifest.json`, so `versions/<version>/cli/manifest.json` once installed). `releaseAssets(version)` names the five files a release publishes: the manifest, the bundle archive, its `.sha256`, the digest set, and the package tarball.
- `createManifest({ version, commit, bundleSha256, digests })` builds one from the facts the workflow holds. `renderManifest(manifest)` is the one text form, keys in contract order, so two manifests that say the same thing are the same bytes. `parseManifest(text)` validates every field, refuses any key outside the contract, and throws a `ManifestError` that names the field and the rule.
- `evaluateRelease(facts)` is pure: facts in, `{ ok, checks, refusal, manifest }` out, one `{ name, status, observed, action }` per entry of `RELEASE_CHECKS` (`manifest`, `version`, `package integrity`, `bundle checksum`, `image digests`, `release manifest`) and, when the facts come from an installed version, `PROVENANCE_CHECKS` (`installed files`, `image provenance`, `package provenance`). `status` is `passed` or `failed`. `refusal` is one `Refusal` that lists every failed condition with its action. A null fact is a missing artifact and fails its check.
- `verifyStagedRelease({ version, tarball, archive, checksum }, { stdout }, probes)` is the door for `curia install` (#873), `curia update` (#883), and the bootstrap (#872): the downloaded bytes in, the report printed and returned. The caller throws `report.refusal` when `ok` is false and unpacks when it is true.
- `verifyInstalledRelease({ root, version, stdout }, probes)` is the door for `curia doctor` (#881). It reads the retained artifacts and the installed files under `versions/<version>/` through `versionPaths`, verifies them the same way, and adds the provenance checks. Read-only.
- `releaseProbes` are the three network boundaries, each injectable: `packument(name, version)` asks the npm registry for the integrity value and whether provenance is recorded, `releaseManifest(version)` downloads the manifest asset from the GitHub release, and `attestation({ reference, commit, version })` runs `gh attestation verify` for one image digest. `attestationCommand(reference, { commit })` is the exact command line, which the report prints as the corrective action.
- `renderVerification(report)` prints one line per check and a summary. No line carries a full digest, a full integrity value, or a manifest body.

The tests build a complete release the way the workflow does (an archive, a manifest that binds it, a package tarball that embeds the manifest, and a fake registry) and then change one thing at a time. `daemon/test/bundlerelease.test.mjs` proves that `render.mjs` writes a manifest that binds what it rendered.

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

The suite has no dependencies, reads no file outside its own temporary directories, and reaches no network. `test/package.test.mjs` runs `npm pack` and installs the tarball into an empty prefix, so it needs `npm` and `tar` on the path; the manifest and archive tests build their fixtures with the same `tar`. The launcher tests run the rendered script with `/bin/sh` against a fake version directory whose `node` is a shell script that reports how it was called.

There is no build step. `npm pack` produces the release artifact.
