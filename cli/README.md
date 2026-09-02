# @curia-sh/cli

Curia's lifecycle interface. It installs, updates, rolls back, diagnoses, and removes one Curia installation. It contains no Curia service code: the service, the app, and the overseer run in containers that the Compose bundle of an installed version describes.

For the operator's view, read the [command reference](https://github.com/alp82/curia/blob/main/docs/operator/command-reference.md). This file is for people who work on the package.

## What this version ships

This version ships the stable launcher, the command vocabulary, the installation-root boundary, the operator configuration contract, the supported-host preflight, the Compose bundle contract, the release manifest with its verification, the stable-release index with its selection rule, `curia install` and `curia reinstall`, `curia doctor`, `curia update` end to end (discovery, acquisition, verified staging beside the active version, the target's validation of the current configuration, and the switch of the live installation with session re-adoption), and `curia rollback` (the switch back to the one retained release, after that release validates the configuration). Every lifecycle command exists and routes. Each one opens its root through the boundary first, so the root refusals are real. The commands a later ticket fills in refuse with exit code `3` and a message that names the version and the release map. The follow-up tickets in [Ship Curia's supported installation lifecycle](https://github.com/alp82/curia/issues/863) fill them in.

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
- `src/archive.mjs`: `readArchive(bytes)` and `extractArchive(bytes, dir, { strip })`, a reader and an extractor for gzipped tar archives, which is how the verification opens the package tarball and the bundle archive and how `curia update` unpacks the package and the runtime without a system `tar`.
- `src/stage.mjs`: `placeVersion`, the one door from a stage (the seven files `STAGE_FILES` names) to a read-only `versions/<version>/`, shared by `curia install` and `curia update`, and `validateWithRelease`, an installed release's validation of the current operator configuration with its own reader, shared by `curia update` and `curia rollback`. See [Update](#update).
- `src/steps.mjs`: `namedSteps`, the `[n/N] <step>` printing and the `<step> failed: <cause>` wrapping that `curia update` and `curia rollback` share.
- `src/rollback.mjs`: `curia rollback`, the four named steps from the root to the switch back to the one rollback release. See [Rollback](#rollback).
- `src/acquire.mjs`: `acquireRelease`, the download and proof of one version's artifacts into a stage, the bootstrap's own steps in this package's code, through injectable `acquireProbes`. See [Update](#update).
- `src/update.mjs`: `curia update`, the six named steps from the stable-release index to a staged, verified, validated target and the switch to it. See [Update](#update).
- `src/switch.mjs`: `switchRelease`, the switch of a live installation from one installed release to another, with the acceptance checks, the atomic activation, the one proven switch back on failure, and the retention of one rollback release. `curia update` and `curia rollback` share it. See [The switch](#the-switch).
- `src/stable.mjs`: the stable-release index and the selection rule: the signed index's contract, the two transitions (`promote`, `withdraw`), `selectRelease`, and the fetch that verifies the index against the key this package pins at `stable-index.pub`. See [The stable-release index](#the-stable-release-index).
- `src/preflight.mjs`: the supported-host preflight. `gatherHostFacts` reads the host through injectable probes, `evaluateHostFacts` turns the facts into one report, and `preflight` does both and prints it. See [The host preflight](#the-host-preflight).
- `src/launcher.mjs`: renders the stable `curia` launcher for one installation root.
- `src/compose.mjs`: the one seam to Docker Compose. `composeProject` names one version's project files, `writeComposeEnvironment` writes `run/compose.env`, `startProject` pulls and brings the project up, and `waitForHealth` waits for the five services, all through an injectable `dockerRunner`. See [Install and reinstall](#install-and-reinstall).
- `src/install.mjs`: `curia install` and `curia reinstall`, the six named steps from the host checks to healthy services. See [Install and reinstall](#install-and-reinstall).
- `src/doctor.mjs`: `curia doctor`, the read-only pass over every direct check, and the redaction every printed line goes through. See [The doctor](#the-doctor).

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
- `SERVICE_MOUNTS` lists, per service, the layout paths it mounts and the mode. The service gets `config/` and the five mutable boundaries read-write: it reads `config/` at boot and writes `config/config.yaml` when the operator saves from the Curia app, which mounts nothing of the root (#880). The tmux runtime gets `work/` and `home`. The attach surface and the app get nothing. The overseer gets its config directory and its mirrors read-write and its tokens read-only. `DOCKER_SOCKET_SERVICES` names the two containers that reach the Docker socket.

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

## The stable-release index

`src/stable.mjs` is the one place that says which published version an installation should run and how that answer is trusted. The index is `release/stable.json` on `main`, one signed file that names the stable release and the withdrawn versions and never describes a release. `deploy/release/index.mjs` writes it, `.github/workflows/stable-index.yml` commits it, and `curia update` (#883), the service's daily check, and the Curia app read it through this module. The operator's view is [Releases, the stable-release index, and version selection](https://github.com/alp82/curia/blob/main/docs/operator/releases.md).

The contract:

- `STABLE_INDEX_FORMAT` (`1`), `STABLE_INDEX_PATH` (`release/stable.json`), `STABLE_INDEX_URL` (the raw file on `main`), and `STABLE_INDEX_KEY_FILE` (`stable-index.pub`, beside `package.json`, so `versions/<version>/cli/stable-index.pub` once installed). `isPrerelease(version)` is the one definition of a prerelease: a release version with a hyphenated suffix. `releaseNotesUrl(version)` is the GitHub release page.
- `createStableIndex({ sequence, updated, stable, withdrawn })`, `renderStableIndex` (the one canonical text, which the signature covers), and `parseStableIndex`. Every field is required, nothing beyond the five is allowed, `stable` is never a prerelease and never withdrawn, and a `StableIndexError` names the field and the rule.
- `signStableIndex(index, privateKeyPem)` writes the envelope `{ index, signature: { algorithm, key, value } }`, deterministic for one index. `verifyStableIndex(text, { publicKey })` returns the index or throws: no pinned key, no signature, another key (the message names both fingerprints), or a changed byte all fail. `pinnedPublicKey()` reads the shipped key, `keyFingerprint` names one, and `generateStableIndexKeys()` makes a pair for `deploy/release/keygen.mjs` and the tests.
- `promote(index, version, { updated })` and `withdraw(index, version, { updated })` are pure: index in, index out, the sequence one higher when something changed and the same index when nothing did. Promotion refuses a prerelease and a withdrawn version. Withdrawing the stable release clears it.
- `selectRelease(index, { requested, prerelease })` is the one selection rule and returns `{ version, selection }` with `selection` one of `stable`, `exact`, or `prerelease`, or throws a `Refusal`: no stable release named, a withdrawn version, a prerelease without `--prerelease`, `--prerelease` without a version or with a plain version, or a string that is not a release version. `selectionFromArgs(args)` reads `[<version>] [--prerelease]` for `curia update`, and `renderSelection` prints the one line.
- `fetchStableIndex({ stdout, publicKey }, probes)` downloads through `stableProbes.stableIndex()`, verifies, prints one line, and returns `{ ok, index, error }`. A failed fetch carries the reason and no index, so a caller cannot select from a file that did not verify.

## The bootstrap

`deploy/bootstrap/curia-install.sh` is the script the operator downloads and runs on a host with no Node.js (#872). It is not part of this package: it is what acquires the package. It is one Bash file, the same for every release, published as the release asset `curia-install.sh` with only its own version stamped in by `deploy/bootstrap/render.mjs`, so `releases/latest/download/curia-install.sh` is the current one. The operator's view is [The bootstrap](https://github.com/alp82/curia/blob/main/docs/operator/bootstrap.md).

What it needs from this package:

- `curia.node` in `package.json`: the exact Node.js version to stage under `versions/<version>/node`, read with `sed`, so it stays one `x.y.z` on its own line. `daemon/test/bootstrap.test.mjs` keeps it equal to `sandbox.node_version` in `config/curia.yaml`, the pin the release images run on.
- `stable-index.pub`, `src/stable.mjs` (`fetchStableIndex`, `selectRelease`, `renderSelection`), `src/manifest.mjs` (`verifyStagedRelease`), and `src/exit.mjs` (`Refusal`): the script writes a small `verify.mjs` into its stage that imports these from the staged package and runs them on the files it downloaded, with probes that read those files instead of the network.
- `bin/curia.mjs`: the hand-off. The script runs `curia install` or `curia purge` on the staged runtime with `CURIA_ROOT` set, and for an installation `CURIA_STAGE` set to a directory that holds `node/`, `cli/`, `cli.tgz`, `bundle.tar.gz`, and `bundle.tar.gz.sha256`, the names `versionPaths` uses. The stage is removed when the command returns, so `curia install` copies what it keeps before it returns.

`daemon/test/bootstrap.test.mjs` runs the script against a local artifact server built from this package's sources and proves the hand-off, every refusal, and the purge dispatch without a network.

## Install and reinstall

`src/install.mjs` is `curia install` and `curia reinstall` (#873): one linear sequence of six named steps, `preflight`, `root`, `stage`, `activate`, `start`, and `health`, from the verified stage to a healthy Compose project and the app address. The operator's view is [Install and reinstall](https://github.com/alp82/curia/blob/main/docs/operator/install.md).

The interface:

- `runInstall(context, deps)` is the command. `context` is what `runCli` hands a command (`env`, `stdout`, `uid`, `gid`, `root`) plus `mode`, `install` or `reinstall`. `deps` are the boundaries a test replaces: `hostProbes` (the preflight's), `releaseProbes` (the manifest's), `docker` (the runner in `src/compose.mjs`), and `sleep` and `now` for the health wait. `installCommand(mode)` binds the mode for the command table.
- `INSTALL_STEPS` names the steps in order. Every step is idempotent by inspection: it reads what is there and does only what is missing, so a rerun lands at the step that failed with no persisted operation record. A failure is rethrown as `<step> failed: <cause>` plus the command that reruns it (the bootstrap before the launcher exists, the launcher after). A `Refusal` is rethrown as `<step>: <condition>` and stays a refusal.
- The version installed is `packageVersion`, this interface's own. With `CURIA_STAGE` set, `stage` verifies the stage through `verifyStagedRelease`, refuses a stage of another version, copies it into a sibling of `versions/<version>/`, and renames it into place, replacing the directory if it was there. Without `CURIA_STAGE`, `stage` verifies the retained artifacts already under `versions/<version>/` and moves on, or refuses when there is no complete version.
- `root` runs `ensureLayout`, then takes `withLifecycleLock` for the rest of the command, writes the record (a fresh ID for a fresh root, the existing record otherwise), and writes `initialOperatorConfig()` only when `config/config.yaml` is absent. `activate` writes the record with the version active, writes the launcher through `writeAtomically` at mode `0755`, and removes every other directory under `versions/`. `start` writes `run/compose.env`, creates the mount sources from `serviceLayout`, pulls, and brings the project up. `health` is `waitForHealth`.
- `APP_SERVE_PORT` is the Curia app's Serve port, which the completion line uses with the node's first `CertDomains` entry from the preflight facts. `daemon/test/preflightports.test.mjs` keeps it equal to `dashboard.serve_port` in `config/curia.yaml`.

`src/compose.mjs` is the one seam to Docker: `composeProject({ root, version })` names the env file and the bundle file and builds the `docker compose --env-file ... -f ...` argument list; `writeComposeEnvironment` writes the env file with `bundleEnvironment`; `startProject` runs `pull` then `up --detach --remove-orphans`; `serviceStates` reads `ps --all --format json` (one object per line, or one array on older Compose); and `waitForHealth` polls until every service in `SERVICES` is healthy, fails at once on one that exited or is unhealthy, and fails at `HEALTH_TIMEOUT_MS` on one still starting, naming the service and the `logs` command. `dockerRunner` is the real `docker`; every function takes a `docker` to replace it. `compose(project, verb, { docker })` is the one invocation every other verb goes through. `curia update` (#883 and #884), `curia rollback` (#885), `curia uninstall` (#886), and `curia purge` (#887) reuse this module for switching and teardown.

The tests are `test/install.test.mjs` and `test/compose.test.mjs`, against `test/fixtures/install.mjs`: one packaged release built the way the workflow builds one, the stage as the bootstrap leaves it, fake host probes, and a fake `docker` that records the Compose verbs and answers `ps`. They cover the clean install, the preserved-root reinstall, a failed activation and its rerun, a failed health wait and its launcher rerun without a stage, a failed pull, and every refusal. `daemon/test/installbundle.test.mjs` installs the real `deploy/bundle/compose.yaml` and has Docker Compose read the env file and the installed bundle; it skips where Docker is absent.

## Update

`src/update.mjs` is `curia update` (#883 and #884): one linear sequence of six named steps, `preflight`, `select`, `acquire`, `stage`, `validate`, and `switch`, from the signed stable-release index to a verified target staged beside the active version, the target's own reader validating the current operator configuration, and the switch of the live installation to it. The operator's view is [Update discovery, staging, and the switch](https://github.com/alp82/curia/blob/main/docs/operator/update.md).

The interface:

- `runUpdate(context, deps)` is the command. `context` is what `runCli` hands a command, with `args` holding `[<version>] [--prerelease]` (`selectionFromArgs` reads them; a `StableIndexError` there becomes a `UsageError`, exit `2`, before anything runs, and `commands.update.options` tells `runCli` to let the option through). `deps` are the boundaries a test replaces: `hostProbes`, `stableProbes` and `publicKey` (the index read and the pinned key), `acquireProbes` (the artifact downloads and the runtime's `--version`), `releaseProbes` (the manifest's), `validateTarget`, `docker`, `fetch` (the loopback reads of the service and the app), and `sleep` and `now` (the clock of the waits).
- `select` runs before the lock and refuses on any discovery failure with "The running installation is not affected". A selected version equal to the active one ends the command with `EXIT.ok` and nothing downloaded. A withdrawn active version is a printed warning, never a stop.
- `acquire` takes `withLifecycleLock` for the rest of the command and runs `acquireRelease` into `cache/update/<target>.<pid>/`, unless `versions/<target>/` is already complete, in which case `verifyRetained` proves it and nothing downloads. `stage` is `placeVersion` from `src/stage.mjs`, the same door `curia install` uses, lifted with a `version` parameter: the release verification, the copy into a sibling directory, and the rename. `validate` imports `src/config.mjs` from the staged package and calls its `readOperatorConfig` on `config/config.yaml`; a `ConfigError` fails the step with the contract's sentence. `switch` is `switchRelease` from `src/switch.mjs`, described next.
- Nothing rewrites the launcher: it reads the record, and the record is what the switch writes after acceptance. A failed switch leaves the record, the launcher, and `run/compose.env`'s content as they were, and keeps the staged target for the rerun.

### The switch

`src/switch.mjs` is `switchRelease({ root, from, to, record, environment, stdout }, { docker, fetch, sleep, now })` (#884, implementing #854): the one door from one installed release to another for a live installation, which `curia update` calls with the target and `curia rollback` (#885) calls with the retained previous release. Both releases are complete under `versions/`, the target is validated, and the caller holds the lock. The sequence:

1. `liveSessions` reads `GET /overview` on the service's loopback port and keeps every agent whose `tmux_live` is true.
2. `writeComposeEnvironment` rewrites `run/compose.env`, `pull` fetches the target's `CORE_SERVICES` (`daemon`, `dashboard`, `overseer`) by digest, and `up --detach --no-deps daemon dashboard overseer` on `composeProject({ root, version: to })` recreates those three. `tmux`, `ttyd`, and every agent container are never named, `--no-deps` keeps Compose off the runtime, and nothing removes orphans.
3. `waitForHealth` on the target project, then `GET /ping` on the service and on the app must both carry `version: to` (the daemon and the sidecar answer that route before any gate), then `GET /overview` is read until every live session is in `agents` with `tmux_live: true` or gone from tmux (ended on its own, reported), for `READOPTION_TIMEOUT_MS`. A session still in `untracked` at the deadline fails.
4. `writeInstallationRecord` names `to` active, atomically, and every directory under `versions/` other than `to` and `from` is removed.

A failure after the recreate runs the same `up` on `composeProject({ root, version: from })` once, proves that release the way the target was proven (`waitForHealth`, both `/ping` routes carrying `version: from`, and the same live sessions adopted back within `READOPTION_TIMEOUT_MS`), and throws a `SwitchError` that carries the cause, the switch back's outcome (`Switched back to <from>, which is healthy and re-adopted N live sessions.` or `The switch back to <from> failed too: <cause>` with the reinstall named), and the fact that the record still names `from`. Nothing retries the target and nothing runs the switch back twice (#885). The tests are the `a selected update` and `the switch` groups of `test/update.test.mjs`, against `fakeLoopback` in `test/fixtures/install.mjs`, which answers `/ping` and `/overview` for whichever bundle the last `up` recreated the core services from, and whose `readopt(session, bundle)` lets one release adopt what another does not.

`src/acquire.mjs` does what `deploy/bootstrap/curia-install.sh` does in the shell, in the same order and with the same proofs: the registry record and the tarball (SHA-512 against `dist.integrity`), the package unpacked and its version and `curia.node` read, `SHASUMS256.txt` and the runtime from nodejs.org (SHA-256, then `bin/node --version` equal to the pin), the manifest, the bundle, and the `.sha256` from the release (the bundle against both). `releaseUrls(version)` and `runtimeUrls(nodeVersion)` name the origins. Every failure is a `Refusal` that names the artifact and one action, and nothing prints an integrity value.

The tests are `test/update.test.mjs` (no update, a selected update with live agents and its reruns, an exact version, a withdrawn active version, retention after a second update, the switch with the overseer beside the service, polled re-adoption, an ended session, an unadopted session, failed health, a wrong version, a failed switch back, atomic activation, an exact prerelease with and without `--prerelease`, withdrawal, offline discovery and a foreign key, failed validation, a target without a reader, a refused release door, usage, a root with no installation, a refused host), `test/acquire.test.mjs` (every download and proof boundary), and `test/archive.test.mjs` (extraction with modes and links, and the entries that would escape the destination). The fixtures in `test/fixtures/install.mjs` build a release with its pinned runtime archive and the URL map the acquisition reads, so no test touches the network.

## Rollback

`src/rollback.mjs` is `curia rollback` (#885, implementing #854): four named steps, `preflight`, `select`, `validate`, and `switch`, printed as `[n/4] <step>` through `namedSteps` in `src/steps.mjs`. The operator's view is [Rollback](https://github.com/alp82/curia/blob/main/docs/operator/rollback.md).

The interface:

- `runRollback(context, deps)` is the command. `context` is what `runCli` hands a command; the command declares no options, so `runCli` refuses any as a usage error before it runs. `deps` are the boundaries a test replaces: `hostProbes`, `validateTarget` (defaults to `validateWithRelease`), `docker`, `fetch`, `sleep`, and `now`.
- `preflight` is `openRoot` (an installation is required) and the host preflight, which is also where the Docker group ID for `run/compose.env` comes from. `select` takes `withLifecycleLock` for the rest of the command and calls `rollbackRelease(root, active)`: the directories under `versions/` that are not a dot directory, not the active version, and complete by `isCompleteStage`. Exactly one is the rollback release; none or two is a `Refusal` that names them and the way out (finish the update, or remove the staged release). `validate` is `validateWithRelease` on the rollback release; an `IncompatibleRelease` becomes a `Refusal` (exit `3`) with the contract's sentence and the action that fits a rollback, and nothing has been touched. `switch` is `switchRelease` with `from: active` and `to: previous`, so the acceptance, the atomic record write, the switch back on failure, and the retention are the update's. After a rollback `versions/` holds the same two releases with the roles swapped.
- `validateWithRelease({ root, version, dir })` in `src/stage.mjs` imports `cli/src/config.mjs` from the installed version and calls its `readOperatorConfig` on `config/config.yaml`. It throws `IncompatibleRelease` with `reason` `configuration` (the release refuses the file; the message carries the `ConfigError`) or `reader` (the release carries no reader). `curia update` fails its `validate` step on one and `curia rollback` refuses on one; each adds its own action sentence.

The tests are `test/rollback.test.mjs`: the steps, `rollbackRelease` over real directories, a rollback with live sessions that proves the preserved directories byte for byte and prints no secret value, retention (an incomplete directory and a staging leftover removed, the next update moving forward, a second rollback going forward again), the refusals (an incompatible configuration through a fixture reader that refuses one key, a release without a reader, no rollback release, two candidates after a failed update, no installation, a refused host, an option), and the failures (failed health with the switch back and its re-adoption, an unadopted session, a switch back that fails too). `test/update.test.mjs` gained the switch back that fails its re-adoption proof. `daemon/test/journalforward.test.mjs` is the guard on the migration rule the rollback release depends on.

## The doctor

`src/doctor.mjs` is `curia doctor` (#881): one read-only pass over the direct checks an installed Curia has, printed in nine sections and summarized in one line. The operator's view is [Diagnostics with `curia doctor`](https://github.com/alp82/curia/blob/main/docs/operator/doctor.md).

The interface:

- `runDoctor(context, deps)` is the command. `context` is what `runCli` hands a command. `deps` are the boundaries a test replaces: `hostProbes` (the preflight's), `releaseProbes` (the manifest's), `docker` (the runner in `src/compose.mjs`), and `fetch` for the two loopback reads of the service and the one of the app. It returns `EXIT.ok` when nothing failed and `EXIT.failed` when a check failed or a host condition is refused. The one refusal it raises is `openRoot`'s.
- `DOCTOR_SECTIONS` names the sections in order: `host`, `installation`, `configuration`, `release`, `secrets`, `containers`, `service`, `integrations`, `app`. `SERVICE_PORT` and `APP_PORT` are the two loopback ports it reads; `daemon/test/preflightports.test.mjs` keeps the app port equal to `config/curia.yaml`.
- Every check is the shape the preflight and the release verification already produce, `{ name, status, observed, action }`, with `status` one of `passed`, `warning`, `failed`, or `refused`. The doctor composes the existing modules and adds no framework: `preflight` for the host, `openRoot` and `versionPaths` for the installation, `readOperatorConfig` for the configuration (the `ConfigError` message verbatim), `verifyInstalledRelease` for the release and its provenance, `secretsStatus` and `credentialsInEnvironment` for the secrets, `serviceStates` for the containers, and the service's own `GET /setup` and `GET /identity` for the integrations, so a card reads the same here and on the Setup screen.
- `redactDiagnostic(text)` is what every printed line passes through, and `scrubFacts(value)` drops string values under credential-named keys from every service answer before the doctor reads it. Neither knows a secret value: they work by shape (a Discord token, a provider key, a GitHub token, a private key block, a JWT, a bearer, a 64-hex agent or conversation token, a `code=` or `token=` value). A `sha256:` digest and the 32-hex installation ID stay.

The doctor writes nothing, takes no lock, and asks Docker for `ps` only. The tests in `test/doctor.test.mjs` install a root through the install fixtures, hand in a fake service, and cover the healthy, degraded, invalid-configuration, lost-integration, unhealthy-container, missing-installation, provenance, and secret-bearing cases with no network and no Docker.

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

The suite has no dependencies, reads no file outside its own temporary directories, and reaches no network. The stable-index tests sign with key pairs they generate. `test/package.test.mjs` runs `npm pack` and installs the tarball into an empty prefix, so it needs `npm` and `tar` on the path; the manifest and archive tests build their fixtures with the same `tar`. The launcher tests run the rendered script with `/bin/sh` against a fake version directory whose `node` is a shell script that reports how it was called.

There is no build step. `npm pack` produces the release artifact.
