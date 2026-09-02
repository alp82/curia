# Curia

Curia is a personal orchestration service. It watches GitHub trackers, dispatches AI agents on tickets, and keeps a human in the loop from any device. This file gives a fresh session or a dispatched agent the vocabulary and the layout of the system.

## Language

### Product and surfaces

**Curia app**:
Curia's browser interface. Use **the app** after the first reference.
_Avoid_: Atlas, dashboard in user-facing prose.

**Curia service**:
The long-running part of Curia that coordinates agents and holds the system state. Use **the service** after the first reference, and use **daemon** only for implementation identifiers and process-specific technical details.
_Avoid_: daemon in user-facing prose.

**Installation lifecycle**:
The operator's complete path from a fresh supported host through a proven Full loop, including upgrades, recovery, and removal.
_Avoid_: setup when referring to the complete lifecycle, onboarding when referring only to installation.

**Curia release**:
One immutable semantic version of the lifecycle interface, Compose bundle, configuration expectations, and exact container-image digests, bound by its release manifest. Components within a Curia release don't carry independent compatibility promises.
_Avoid_: release when referring to one component artifact or a mutable package or image tag.

**Stable release**:
A Curia release offered to normal installation and update flows. A prerelease remains available only by exact version and never enters normal version selection.
_Avoid_: stable channel, because the first supported lifecycle has no operator-selectable release channels.

**Release manifest**:
The immutable record that binds a Curia release to its lifecycle-interface version, Compose bundle checksum, and exact container-image digests.
_Avoid_: installation manifest, version tag.

**Live update**:
A Curia update that leaves agent containers and session runtimes running while it replaces the core services, then re-adopts the live sessions. New agents use the new Curia release, while agents already running keep their original image.
_Avoid_: zero-downtime update, which implies that every service and interaction remains continuously available.

**Rollback release**:
The one previous successful Curia release retained by an installation. Curia switches to it automatically after a failed update or when the operator runs `curia rollback`.
_Avoid_: rollback history, which implies support for multiple historical releases.

**Integration setup**:
The guided first-run flow that connects one installation to its required GitHub, Discord, Tailscale, and model-provider resources. The operator may complete these integrations in any order. The flow ends when every required integration passes its current verification check. Since [#874](https://github.com/alp82/curia/issues/874) it is the **Setup screen** of the Curia app: one rail of four fixed-height service cards, the selected card's configuration beside it, and the Full loop as the one dependent action under the rail. See [Integration setup](docs/operator/integration-setup.md).
_Avoid_: onboarding, integration wizard.

**Setup checkpoint**:
What integration setup keeps between a close and a reopen: `state/setup.json`, holding the selected card and a closed list of safe fields per card (`app_name`, `guild_id`, `channel`, `machine_name`, `provider`). The service writes it at mode `0600` and refuses any other key by name. It never holds a token and never holds a completion marker, because a card's connected state is this read's **integration verification** ([#874](https://github.com/alp82/curia/issues/874), implementing [#852](https://github.com/alp82/curia/issues/852)). `daemon/src/setup.mjs` is the one module: the four cards, the field list, the per-integration verifier seams, and the Full-loop gate seam. A verifier answers connected, failed, or unconnected (the integration's secret is not on disk yet, which is the plain card and never a failure), and may attach `detail`, the non-secret facts the card carries to the Full loop gate. The GitHub card's verifier is `daemon/src/githubsetup.mjs` ([#875](https://github.com/alp82/curia/issues/875)): it proves, on every read, that the App's installation covers a watched repository and that the service can mint the installation credential, and it reports a real discovered ticket or an honest zero. See [Connect GitHub](docs/operator/integration-setup.md#connect-github). The Discord card's verifier is `daemon/src/discordsetup.mjs` ([#876](https://github.com/alp82/curia/issues/876)): the token is submitted once with the operator's user ID and lands in `secrets/discord-bot-token` through `writeSecret`, the ID, the server, and the channel name land in `state/discord.json`, and every read proves over Discord's REST API that the operator is a member of the selected server, that the command channel exists top-level, that the bot holds the permissions the bridge uses in it, that the command manifest registers, and that a confirmation message of curia's own stands in the channel, found before it is posted. A verification read never picks a server and never creates a channel ([#891](https://github.com/alp82/curia/issues/891)): the panel waits, re-reading on the page's refresh interval, until the bot is in a server, and **Connect channel** is the one press that reuses or creates the channel. The token reaches no answer, log line, or refusal. See [Connect Discord](docs/operator/integration-setup.md#connect-discord). The Tailscale card's verifier is `daemon/src/tailscalesetup.mjs` ([#877](https://github.com/alp82/curia/issues/877)): Curia detects the host's Tailscale node and never installs it, logs it in, or changes the tailnet's policy; the node joined the tailnet in the `tailnet` step of `curia install` under the name the operator gave with `--name` ([#891](https://github.com/alp82/curia/issues/891)). The card's one field is the **node name**, prefilled with the name the node has (the owner's decision at the #891 rehearsal): the panel shows the identity Serve stamped on the request that opened the app and the node's name and address, and an explicit confirmation records the identity as the **allowed operator** in `state/tailscale.json` with the machine name. A confirmed name that equals the node's changes nothing; another name renames the node first, through `tailscale set --hostname` (the operator permission suffices; a refusal names `sudo tailscale set --operator=<user>`), waits for tailscaled to report the new MagicDNS name, asserts Curia's Serve route again, records the name, and answers the new address, which the page shows as a link with the word that the old address stops working. Every read proves that the node is online with a certificate, that Curia's own Serve route for the app stands (created when missing, recorded in the same file), and that the app admits the recorded login, timed. `curia doctor` reads the recorded name and warns when the node carries another one. See [Connect Tailscale](docs/operator/integration-setup.md#connect-tailscale). The model card holds one verifier per provider. The OpenAI verifier is `daemon/src/openaisetup.mjs` ([#878](https://github.com/alp82/curia/issues/878)): the sign-in is the dispatcher's own codex device login, so the credential lands in `secrets/codex-auth.json` by the same adoption `reauth openai` uses and there is no API-key path; every read proves the credential is on disk, readable, and unexpired, completes one minimal streamed request on the Codex backend, timed, and applies the **routing preset** when routing is not ready. It records the opaque account id, the plan, the model, the response id, the usage, and the timing, never the email or a token. See [Connect OpenAI](docs/operator/integration-setup.md#connect-openai).
_Avoid_: setup state, completion record, browser storage.

**Routing preset**:
What a connected model provider supplies so a fresh installation can run without model-by-model routing ([#878](https://github.com/alp82/curia/issues/878) and [#879](https://github.com/alp82/curia/issues/879), implementing [#852](https://github.com/alp82/curia/issues/852)). Routing is **ready** when every default row names an active model whose provider has a credential on disk and the connecting provider's models are on. When it is not, `daemon/src/modelrouting.mjs` moves the rows that cannot run onto the provider's first model (`gpt` for OpenAI, `fable` for Anthropic) with their own effort, switches models on and off by credential presence, and lands the result in the routing override (`state/routing.local.yaml` under an installation root, `routing.local.yaml` beside the tracked file otherwise) through the settings writer, applied in place. A ready routing is left alone, so an operator's own routing choice is never rewritten by a read. With both providers connected the preset covers both: the second provider's verification switches its models back on and moves no row that already runs. The `review` rows are covered too ([#891](https://github.com/alp82/curia/issues/891)): a cross-check row names the other provider's model, so with one provider the row that cannot run is dropped (`null` in the override, which the loader reads as no pairing) and comes back from the tracked file when the second provider connects.
_Avoid_: default routing, routing migration, model configuration.

**Integration verification**:
A fresh check that Curia can use an external resource with the authority required for the Full loop. A saved completion marker is not verification.
_Avoid_: connection test, completed step.

**Full-loop gate**:
The one readiness decision of integration setup ([#880](https://github.com/alp82/curia/issues/880), implementing [#852](https://github.com/alp82/curia/issues/852) and [#853](https://github.com/alp82/curia/issues/853)): `daemon/src/fullloopgate.mjs`, a function of the four cards' current verifications and nothing stored. Ready only when GitHub, Discord, Tailscale, and at least one model provider verified on this read and each connected card handed the fact the loop needs: a covered repository, a server and a command channel, a private address, a ready routing. Both providers are supported and one is enough; the provider that leads is the remembered one when it verified, else the first connected, and the other's state rides along so a second provider is shown honestly and stays optional. The gate answers `{ ready, reason, facts }`, and the facts are what the Full loop's run receives: the repository and the discovered ticket, the server, channel, confirmation, and bridge state, the address and the admitted operator, the leading provider with its request and routing rows. **Run Full loop** enables on that word alone, and a restart, a reconnection, and Try again recompute it. There is no workflow engine and no completion marker. See [The Full loop](docs/operator/integration-setup.md#the-full-loop).
_Avoid_: setup complete, readiness flag, workflow state.

**Command channel**:
The Discord text channel that an operator chooses during integration setup for Curia commands, conversations, and ticket threads. Its name is installation-specific. **Connect channel** on the Discord card of integration setup ([#876](https://github.com/alp82/curia/issues/876), [#891](https://github.com/alp82/curia/issues/891)) reuses a top-level text channel of that name when there is one and creates one otherwise, which is the same rule the bridge applies when it opens the channel at boot. A verification read only finds the channel and never creates it.
_Avoid_: `#curia` when referring to every installation.

**Unprivileged lifecycle**:
The installation lifecycle runs as the non-root operator and never escalates privileges. Curia may depend on host-managed Docker Engine and Tailscale installations, but it neither installs nor reconfigures them. Curia refuses lifecycle commands run as root.
_Avoid_: rootless installation, which can imply rootless Docker or a host with no root-managed prerequisites.

**Installation identity**:
The durable configuration, history, and long-lived credentials that make a Curia installation the same installation after recovery on another supported host. Renewable short-lived tokens are derived from the installation identity rather than part of it.

**Recovery backup**:
An encrypted, portable copy of the installation identity. It excludes resumable work, native agent sessions, caches, runtime files, and renewable short-lived tokens.
_Avoid_: journal backup, which describes only a copy of the event journal and cannot recover an installation.

**Resumable work**:
Worktrees and native agent session data that Curia preserves across same-host lifecycle operations. A recovery backup does not preserve resumable work. Before a planned backup, Curia salvages local-only work to GitHub and records live tickets as interrupted.

**Operator configuration**:
The documented, directly editable declaration of how one installation should behave: `config/config.yaml` in the installation root, and beside `curia.yaml` in the source deployment's `config/`. One module, `cli/src/config.mjs`, reads, validates, renders, and writes it for the lifecycle interface, the Curia service, and the Curia app ([#866](https://github.com/alp82/curia/issues/866)). It holds `max_concurrent`, `auto_dispatch`, `poll_interval_s`, `prototype_variations`, `messages_per_send`, `live_pane_cap`, and `watch`, every key optional, and a key it leaves out keeps the shipped answer. The Curia app and lifecycle interface validate it before an atomic, owner-only write. A running service rejects an invalid reload and keeps its loaded configuration in memory. Invalid configuration prevents the service from starting after a restart, and `curia doctor` reports the exact error: the path, the line, the key, and the rule. The first installation writes `max_concurrent: 4` and no other value. Generated state, release metadata, and secrets are not operator configuration. See [Operator configuration](docs/operator/configuration.md).

**Installation root**:
The one operator-owned directory that holds an installed Curia system. It defaults to `$XDG_DATA_HOME/curia`, or `~/.local/share/curia` when `XDG_DATA_HOME` is unset. Its boundaries are `config/` for operator configuration, `secrets/` for long-lived credentials, `state/` for durable service and lifecycle state, `work/` for resumable work, `versions/` for verified installed artifacts, `cache/` for rebuildable data, and `run/` for disposable runtime data. Docker owns its own images, containers, networks, and volumes outside this directory.
_Avoid_: workspace root, which names the current source deployment's mixed work and credential tree.

**Installation record**:
The atomic, owner-only `state/installation.json` file that identifies an installation root. It contains only a format version, a random installation ID, and the active Curia version. Lifecycle commands check ownership, permissions, and symbolic-link safety directly. The release manifest verifies installed artifacts separately.
_Avoid_: installation manifest, which can be confused with a release or version manifest.

**Lifecycle-operation lock**:
The `run/lifecycle.lock` file that serializes lifecycle commands on one installation root. A command takes it after the root boundary accepts the root and before it changes anything, and releases it on success or failure. A second command refuses while a live process holds the lock and takes over a lock whose process is gone. See [the command reference](docs/operator/command-reference.md#the-lifecycle-lock).

**Release image**:
One of the five container images a release builds and publishes by digest: `curia-daemon`, `curia-tmux` (the tmux runtime and the attach surface), `curia-dashboard`, `curia-overseer`, and `curia-agent`, under `ghcr.io/alp82`. Each service image is the `release` stage of its Dockerfile, which carries the checkout at `/opt/curia` read-only and assumes no uid and no host path. The agent image ([#891](https://github.com/alp82/curia/issues/891)) is the fifth: `deploy/agent/Dockerfile` built with the pins in `curia.yaml`, the image every agent container and model sign-in starts from. No Compose service runs it, so the bundle names it nowhere; the release manifest binds it, the lifecycle interface pulls it by digest beside the bundle's four, and under an installation root the daemon reads that reference from the installed manifest and never builds. The source deployment keeps building it on the box.
_Avoid_: tag as identity; a version tag exists for browsing only.

**Compose bundle**:
The one Compose file of a release, `deploy/bundle/compose.yaml` rendered with every image as an exact digest, unpacked to `versions/<version>/bundle/` and started by the lifecycle interface under the fixed project name `curia`. It labels every container, the network, and the volume with the installation ID under `sh.curia.installation`, declares a health check per service, runs every container as the operator's numeric uid and gid, and interpolates five run-time values that are paths and numbers, never a secret. `cli/src/bundle.mjs` is its contract.

**Release manifest**:
The one immutable file that identifies a Curia release: `curia-manifest-<version>.json` on the GitHub release and `manifest.json` inside the `@curia-sh/cli` package, binding the package version, the SHA-256 of the Compose bundle archive, the exact digest of each of the five release images (format `2`; format `1` bound four and is refused), and the source commit and workflow ([#870](https://github.com/alp82/curia/issues/870), implementing [#849](https://github.com/alp82/curia/issues/849) and [#854](https://github.com/alp82/curia/issues/854)). It holds no tag and no compatibility metadata. `cli/src/manifest.mjs` is its contract and its verification: before activation, the lifecycle interface proves the manifest, the version, the npm integrity of the package, the bundle checksum, every image digest, and the release copy of the manifest, and `curia doctor` repeats that on the retained artifacts and adds the build attestation of each image and the registry's provenance record for the package. Every check fails closed on a missing, malformed, substituted, or mismatched artifact. See [The release manifest and release verification](docs/operator/release-manifest.md).
_Avoid_: version manifest, installation manifest, and release index (the stable-release index is another file, which names a recommended release and never describes one).

**Stable-release index**:
The one signed file that says which published version an installation should run: `release/stable.json` on `main`, read raw from GitHub, naming the recommended stable release and the withdrawn versions with a sequence that rises on every change ([#871](https://github.com/alp82/curia/issues/871), implementing [#854](https://github.com/alp82/curia/issues/854)). It is signed with one Ed25519 key whose public half ships inside `@curia-sh/cli` as `stable-index.pub`, so an installed version trusts the key the verified package carries and nothing else. `cli/src/stable.mjs` is its contract and the one selection rule: `curia update` selects the stable release, an exact version as asked, a prerelease only with `--prerelease`, and a withdrawn version never. Promotion and withdrawal (`deploy/release/index.mjs` under `.github/workflows/stable-index.yml`) change this file and no artifact. See [Releases, the stable-release index, and version selection](docs/operator/releases.md).

**Update check**:
The service's daily read of the stable-release index on an installed host ([#883](https://github.com/alp82/curia/issues/883), implementing [#854](https://github.com/alp82/curia/issues/854)): at startup when the last successful check is older than 24 hours, then once a day, verified with the key of the active version's package under `versions/`, and recorded as one file, `state/update-check.json`, that holds the check result and nothing else. `GET /update` composes the app's **Update** section from it: installed and recommended versions, availability, release notes, and a withdrawal warning. A failed check is a fact in the file and a log line; the check downloads no release, switches nothing, and notifies nobody. `daemon/src/updatecheck.mjs` is its contract.
_Avoid_: auto-update, which Curia never does; update notification, which the first release doesn't send.

**Staged release**:
A complete version under `versions/<version>/` that is not the active one: the pinned runtime, the lifecycle interface, the retained artifacts, and the unpacked bundle, verified through the release door and made read-only by `placeVersion` (`cli/src/stage.mjs`), the one door `curia install` and `curia update` share. `curia update` ([#883](https://github.com/alp82/curia/issues/883)) acquires the target's artifacts with `cli/src/acquire.mjs` (the bootstrap's downloads and proofs in the package's own code), stages it beside the active version, and has the target's own configuration reader validate `config/config.yaml`; then switches to it ([#884](https://github.com/alp82/curia/issues/884)): `switchRelease` (`cli/src/switch.mjs`) reads the live sessions, recreates the service, the app, and the overseer from the target's bundle with `up --no-deps` while the tmux runtime, the attach surface, and every agent container keep running, accepts the target only when every service is healthy, the service and the app answer the target version on `/ping`, and every live session is adopted back by the boot reconcile, then writes the record atomically and keeps the release that was active as the one **rollback release**. A failed acceptance switches back once and leaves the record alone. See [Update discovery, staging, and the switch](docs/operator/update.md).
_Avoid_: pending update, installed version (that is the active one).

**Rollback release**:
The one release under `versions/` beside the active one after a switch: the release that was active before it ([#884](https://github.com/alp82/curia/issues/884), implementing [#854](https://github.com/alp82/curia/issues/854)). The switch removes every other version, so Curia keeps one step of history and no more. `curia rollback` ([#885](https://github.com/alp82/curia/issues/885), `cli/src/rollback.mjs`) finds it by looking (the one complete release under `versions/` that is not the active one, refusing none or two), has it validate `config/config.yaml` with its own reader (`validateWithRelease` in `cli/src/stage.mjs`, the door `curia update` validates through) and refuses an incompatible one without touching the running release, then switches back to it through the same door, after which the release rolled back from is the rollback release. A staged target that failed its switch is not one: it stays for the rerun and is removed by the next successful switch, and `curia rollback` refuses while it stands beside the rollback release. A failed switch, forward or back, switches back once, proves the release that was running (health, version, re-adoption), and never runs the target again. What keeps the rollback release able to read a newer minor's `state/` is the additive-migration rule in [Migrations and the rollback release](docs/operator/rollback.md#migrations-and-the-rollback-release), guarded by `daemon/test/journalforward.test.mjs`. See [Rollback](docs/operator/rollback.md).
_Avoid_: previous version (ambiguous with the release before that one), backup release.
_Avoid_: latest, which is npm's mutable tag and GitHub's release badge, neither of which Curia selects by; release index.

**Publication**:
The release workflow's ordered act of making one version available: the five images by digest, then the bundle and the manifest onto the draft release, then the release itself (the tag and the locked assets), then `@curia-sh/cli` last with the manifest inside, through npm trusted publishing ([#871](https://github.com/alp82/curia/issues/871), implementing [#849](https://github.com/alp82/curia/issues/849)). `deploy/release/publish.mjs` gates each step: an identity that exists with the same bytes is kept, so a rerun finishes the publication, and one that exists with different bytes refuses, so nothing published is ever replaced. Publication never names a stable release; that is promotion.
_Avoid_: deploy, which is the source box's own self-update; promotion, which is a change to the index and no artifact.

**Host preflight**:
The direct host checks that `curia install` and `curia update` run before they change anything, and that `curia doctor` reruns. `cli/src/preflight.mjs` reads the host through injectable probes into one facts object and evaluates it into one report, one result per check: `passed`, `warning`, or `refused` with what was observed and one corrective action ([#868](https://github.com/alp82/curia/issues/868), implementing [#850](https://github.com/alp82/curia/issues/850) and [#857](https://github.com/alp82/curia/issues/857)). A refused condition is a demonstrated incompatibility, such as another operating-system release, root execution, a busy required port, or a Docker daemon the operator can't reach. It stops the operation and there is no force flag. A warning is a nonblocking fact, such as a host below the recommended profile. Temporary probe resources are removed before the command continues. The Tailscale check asks only for the package and a running `tailscaled`, because those are what Curia never installs; the node's login, the operator permission, and the certificate belong to the `tailnet` step of `curia install` ([#891](https://github.com/alp82/curia/issues/891)). Curia supports Ubuntu 24.04 LTS and Debian 13 on x86-64 only. See [Supported hosts and preflight checks](docs/operator/supported-hosts.md).

**Secret file**:
An owner-only file under the installation root's `secrets/` boundary that holds one long-lived credential or private key. Curia gives each container read-only access to only the secret files that container consumes, and only the credential-owning service may replace one. Long-lived secrets never travel through environment variables, command arguments, logs, diagnostics, or browser responses.

**Session-bound capability**:
A generated token that identifies one resumable agent or overseer conversation. It lives with that session under `work/`, survives service and host restarts, reaches only its specific consumer, and is deleted when the session ends. It is neither an installation-identity secret nor disposable runtime data.

Renewable external tokens and one-turn secrets live under `run/` or in memory and are recreated after restart.

No Docker volume holds installation identity, durable state, or resumable work. Docker volumes contain only rebuildable caches or disposable runtime data, so Curia may recreate them without losing the installation.

**Ordinary uninstall**:
Removal of Curia's runnable system from one host while preserving operator configuration, secrets, durable state, and resumable work in the installation root. It reports the preserved root and the paths to reinstall or purge. External service resources remain untouched. `curia uninstall` ([#886](https://github.com/alp82/curia/issues/886)) is four named steps, `preflight`, `docker`, `routes`, and `files`: under the lifecycle lock it removes every container, network, and volume that carries the installation label, turns off the Serve routes recorded in `state/tailscale.json`, empties `versions/`, `cache/`, and `run/`, and removes the launcher; the container images stay for the confirmed purge. Every step reads before it removes, so a rerun finishes a partial cleanup. See [docs/operator/uninstall.md](docs/operator/uninstall.md).
_Avoid_: remove when it is unclear whether installation data survives.

**Confirmed purge**:
The explicit removal of the entire installation root and every Curia-labelled Docker resource after the operator confirms the exact local scope. External service resources remain separate cleanup work and are never silently deleted. `curia purge` ([#887](https://github.com/alp82/curia/issues/887)) is six named steps, `preflight`, `confirm`, `docker`, `routes`, `images`, and `root`: it prints the exact root with the warning, takes the one confirmation (the operator types the root on the terminal, or passes `--confirm <root>` without one), then under the lifecycle lock does uninstall's teardown by label, withdraws Curia's Serve routes, removes the release images found by their exact repositories that Docker proves unused (no container over them, no force), removes the launcher, and removes the root last with the installation record as the last file, so a rerun still finds the installation. The completion reports the external resources from stored identifiers only and says that deleting local secret files revoked nothing. See [docs/operator/purge.md](docs/operator/purge.md).
_Avoid_: uninstall when local installation data is also removed.

**Supported host**:
A host inside Curia's tested operating-system and architecture matrix that meets the minimum resource profile and passes every functional preflight check.

**Unsupported host**:
A host outside Curia's tested matrix or below its minimum resource profile that passes functional preflight. Installation may continue after a warning, without lifecycle guarantees.

**Refused condition**:
A functional incompatibility that makes installation unsafe or predictably broken. Installation stops until the operator removes the condition.
_Avoid_: unsupported when Curia has proved the installation cannot work.

**Host check**:
Curia's direct evaluation of host compatibility, prerequisites, and local service health during installation, update, or `curia doctor`. Curia doesn't persist findings or run a daily health subsystem. A service that can't start reports the dependency failure that prevents startup. `curia doctor` (`cli/src/doctor.mjs`, [#881](https://github.com/alp82/curia/issues/881)) is the one diagnostic surface: a read-only pass over the host preflight, the installation, the operator configuration, the installed release with its provenance, the secret files by presence, the containers, the service, the four integration cards and the Full-loop gate as the running service verifies them, and the Curia app, one line per check with one corrective action, every line redacted by shape. See [Diagnostics with `curia doctor`](docs/operator/doctor.md).
_Avoid_: host health check, which implies a persistent or scheduled subsystem.

### The loop

**Full loop**:
The one end-to-end pass through the system: frontier, dispatch, escalation and answer, review, merge, resolution, map update.
_Avoid_: golden thread (banned by the operator).

**Inner loop**:
The agent-side slice of the full loop: notify, a blocking question, the answer, resume, commit, result.

**Rehearsal**:
A scripted live run of the full loop on real repos. It proves every leg in one unbroken pass. The ticket a rehearsal spends carries the `rehearsal` label; the **Full-loop run** selects it by that label and nothing else.

**Full-loop run**:
The first real Full loop as an installation's acceptance ([#882](https://github.com/alp82/curia/issues/882), implementing [#857](https://github.com/alp82/curia/issues/857)): `daemon/src/fullloop.mjs`. **Run Full loop** takes this read's **Full-loop gate**, selects the covered repository and the ticket marked `rehearsal` on its frontier through the dispatcher's own frontier read, and dispatches it through the dispatcher's own `start`. Every later leg is judged from the journal rows the daemon already writes while the agent works, counted only after the run's spawn, only for the ticket's session, and only in order; a row from an earlier dispatch, another ticket, the reviewer, or out of order counts for nothing, and neither does the run's own completion row. Setup succeeds only when all eight legs complete in one pass; the completion state links the ticket, the pull request, the map, the Discord thread, and the channel, and reports the elapsed time. A failure names the leg, one cause, and one action, keeps the completed legs and the connected integrations, and **Try again** reruns the failed leg. Nothing is stored but the journal rows, so `curia doctor` keeps reading the gate. See [Run Full loop](docs/operator/integration-setup.md#run-full-loop).

### Tickets and maps

**Ticket**:
A GitHub issue in a watched repo. The unit of dispatch.
_Avoid_: task.

**Decision ticket**:
The vendored wayfinder skill's word for a map child whose resolution is a decision, not a slice of a build to execute. curia keeps it (#286). It is a subset of **Ticket**, never a synonym: a flat-lane ticket decides nothing, and a map whose Notes carry execution ships build tickets. Use it where the map plans.

**Map**:
A GitHub issue labeled `wayfinder:map`. It indexes decisions and points to the child tickets that hold their detail.

**Map child**:
A ticket whose parent issue is a map.

**Fog**:
The map section "Not yet specified": work that is coming but not yet sharp enough to state as a ticket. A heading, a blank line and an HTML comment inside that section are shape rather than fog, and `None` or `(empty)` is no fog at all.

**Empty map**:
An open, non-deferred map with at least one child and no open child left. No dispatch ever fires on it again, so the frontier read is the one thing that can notice it ([#485](https://github.com/alp82/curia/issues/485)) — and #316 sat that way for days because a line saying so is not an act. Curia asks the operator one durable question instead ([#698](https://github.com/alp82/curia/issues/698)): a ✅/❌ confirm carrying the map's fog, asked whether the fog is empty or not, journalled as `map_verdict_asked` so neither a second pass nor a restart asks twice. It is the one confirm a boot does not lapse, because it names a map rather than an agent instance. The answer posts a verdict comment on the map either way, and closes it only when the map as it stands THEN has no open child, no fog and no pause. A map that empties again after gaining a child is a new question.

**Charting**:
The map changes: new tickets, graduated fog, blocking edges, scope rulings. They land two ways. A ticket agent proposes them at the review gate and writes them after the approval. A charting agent writes them as its whole job.

**Map dispatch**:
`map <n>` on a map's own issue. The daemon spawns a charting agent instead of a ticket agent. It claims nothing. `start` on a map number is not this: it dispatches the map's next takeable ticket.

**New-map dispatch**:
`map [repo] <prose>` with no issue. The daemon spawns a charting agent that has no map. The agent settles the destination with the operator, then creates the `wayfinder:map` issue itself. The prose is mandatory here: it is the loose idea the charting starts from. The first word is the repo only when it names a watched repo, and it is the first word of the prose otherwise.

**Adoption**:
The act that gives a new-map dispatch its map. The agent calls `map_created` with the number. curia checks the issue is an open map in that repo, then takes it as the session's map: the thread moves onto it, `map <n>` on it is refused, and the charting summary lands there.

**Charting agent**:
The agent of a map dispatch. It edits the map and its tickets, and it never closes the map. On a new-map dispatch it creates the map first.
It also burns down the research tickets it just created, one `/research` subagent each. For those tickets it takes the ordinary ending: one pull request on `curia/<map>`, the review gate, the merge, then the close. It resolves nothing else, and it closes nothing before the merge.

**Burn-down**:
What a charting session does with the research tickets it just created. One `/research` subagent per ticket, claimed before its subagent starts and released if that subagent fails. Every subagent works in the charting agent's own worktree, writes one note under `docs/research/`, and never runs git. The charting agent commits once, writes the index rows itself, and reads the findings together before the gate.

**Charting write bound**:
`docs/research/` and nothing else on disk. The charting worktree is writable, narrowed to that one directory. Curia refuses a pull request from a charting agent whose branch touches any other file.

**Instruction**:
The operator's sentence on a map dispatch, in their own words. It rides the `map` verb last, and reaches the charting agent as the first thing it reads. It needs no separator: the arguments come first, and the sentence runs from the first plain word to the end of the line. On an existing map it is optional: with none, the agent asks what should change. On a new map it is mandatory, because nothing else says what to chart. No other verb takes one.

**Frontier**:
The takeable tickets of a watched repo, in map order.

**Two-level frontier**:
The frontier plus the tickets each of its members directly unblocks. One level, never a chain. On the wire it comes from the blocking edges the agent-only count already reads. The Curia app's Maps screen draws the same level from the map snapshot, whose takeable facts name the blocked children of their own map that they unblock, walked from the blocker edges the snapshot already holds.

**Frontier snapshot**:
The two-level frontier as reconcile last computed it, under the instant it did. Reconcile computes it, because that pass already holds the GitHub credentials and the app holds none. The stamp is what makes a served frontier honest: the page states the age of the reading.

**Takeable**:
Open, not a pull request, no open blockers, no assignee.

**Lane**:
The rule that computes a repo's frontier. The map lane takes the children of open maps. The flat lane takes open `ready-for-agent` issues. A repo whose maps are all closed or deferred gets an empty frontier, never the flat fallback.

**Claim**:
The assignee on a ticket. A claim removes the ticket from every frontier. The daemon claims before it spawns. No dispatch ever claims a map: a map is never on a frontier, so a claim on one says nothing true.

**Map lock**:
What stops a second charting agent from editing one map body: the session name. A charting agent on map #147 is `curia-147`, and `map 147` is refused while that session lives. The check asks tmux, so it survives a daemon restart. It is per box, and there is one box.
A charting session that researched holds this lock, and an agent slot, through its whole review. Charting is no longer a fast act. The operator accepted that price ([ADR-0008](docs/adr/0008-resolved-means-merged.md)).

**Watched repo**:
A repo on the watch list: `watch` in the operator configuration, or the shipped list in `config/curia.yaml` when the operator configuration leaves it out. Curia dispatches only against watched repos.

**Tracker doc**:
`docs/agents/issue-tracker.md` in a watched repo. It tells agents how that tracker expresses maps, blocking, and resolution. A map child does not dispatch without it.

**Resolve protocol**:
The agent's three tracker writes: a resolution comment, the close, one map pointer.

**Map pointer**:
One line in the map's "Decisions so far": the ticket title as a link, plus a one-line gist.

**Resolved**:
Merged. A ticket counts as resolved only when a human approved the work and the code is in the default branch.

### Dispatch and routing

**Dispatch**:
The ordered act: claim, prepare, spawn. A failure before the spawn releases the claim.

**Auto-dispatch**:
The `dispatch.auto_dispatch` flag. The dispatch tick runs either way, because the liveness sweep rides it. While the flag is true, that same tick also starts takeable tickets, the map lane first, up to `max_concurrent`. It ships false, so the operator's press is the only door from a ticket to an agent.
A takeable ticket whose worktree still stands is resumed, and never started: `start` recreates the worktree from origin and takes every uncommitted file with it. The path is the evidence, as it is for `resume` and `resume all`. The thread says curia resumed rather than started, and the journal records an `auto_resume`. See [#376](https://github.com/alp82/curia/issues/376).
A ticket that died at its spawn twice in a row is stepped over. See the failed-spawn step-over below.
It is also the only door a clock could use. curia refuses scheduled tickets for that reason: a schedule that files one is auto-dispatch with a calendar in front of it. The demand behind the idea is a watch, not a clock. A watch states one event at its own instant, where the operator reads it. See [#345](https://github.com/alp82/curia/issues/345).
_Avoid_: scheduler, cron.

**Routing rule**:
The label-based model choice. A `model:<x>` label wins, else the `wayfinder:<type>` default table. No intelligence sits in the dispatch path. `wayfinder:map` is a row in that table like any other type.

**Routing label**:
A key under `models:` in `routing.yaml`. It is the dispatch vocabulary that `model:<x>` and `/start <ticket> <label>` speak. It is not a model: the label `gpt` names the model `gpt-5.6-sol`.

**Model name**:
What curia tells a human is running. The status line uses the transcript model, then `models.<label>.id`, then the routing label. Cooling, fallback, and `status` keep the routing label.

**Model switch**:
The operator's move of a live agent to another routing label, from the `model` button on the Discord status line or the `model <n> <label>` command ([#717](https://github.com/alp82/curia/issues/717), on the [#561](https://github.com/alp82/curia/issues/561) evidence). The daemon refuses a cooled or cross-harness target before the pane is touched, and it names the hold and its reset. The composer is cut first and pasted back after, on every lane. claude switches in its own pane by `/model <id>` plus one confirm, so the process and the transcript stay; codex switches by a kill and `resume -m <id>`, because its picker lists only the built-in catalog. The effort belongs to the ticket type and survives the switch. The switch journals a whole spawn line (`agent_model_switched`), so a restart and a stall respawn read the model the agent is on.

**Harness**:
The program an agent runs under: claude or codex. It is a function of the model: `models.<x>.harness` states one value, and no command overrides it. A pin that disagreed with the model built `codex --model opus`, which is not a model.
_Avoid_: backend, lane.

**Selectable harness**:
A Harness that has proved Curia's complete agent lifecycle and may therefore receive a model through routing. Missing operator conveniences are allowed only when the Harness declares them and Curia refuses or hides the unavailable act before touching its pane.
_Avoid_: supported CLI, installed harness.

**Harness adapter**:
The one boundary that translates a Harness's native configuration, launch, pane, transcript, instruction, tool-channel, and completion behavior into the Selectable harness contract.
_Avoid_: harness row, harness branch.

**Cooling**:
A hold on a model or provider. Three triggers write three kinds of entry, and every start path steps the fallback chain over all three. Two of them end at a stated reset; a **credential hold** ends when a person acts.

A **landed** entry follows a usage-limit signal an agent hit. It survives a restart: the daemon journals every landed cap with its reset instant, and it seeds the hold back from the journal as it starts, before it takes a command. A hold whose reset passed while the daemon was down binds nothing. Only time ends a landed entry. No command clears one by hand, so a wrong hold stands until its reset, which is the stated instant or one hour for a guess.

A **predicted** entry follows a hot account reading, before any agent hits the wall. Any window at or past `COOL_PCT = 90` writes one, on that provider. It is a guess, so curia judges it again on every fresh reading. It lifts under 85, or when the window rolls. Its expiry is the window's `resetsAt`, which the wake timer already reads, and nothing seeds it at boot. A provider with no reading is never held. A `model:` label steps over a predicted entry, and never over a landed one. Three surfaces name a predicted hold: its own journal event, a Curia app banner and Discord `/status`. It narrows the reactive path and does not replace it. The reading refreshes every ten minutes at most, so a burst can cross from 89 to the wall between two readings. See [#339](https://github.com/alp82/curia/issues/339) and [#384](https://github.com/alp82/curia/issues/384).

A **credential hold** follows a refresh that proved a model credential dead ([#646](https://github.com/alp82/curia/issues/646)). It is the one kind with **no stated reset**, because it ends when someone finishes a login rather than at an instant. Cooling to an invented far-future date was refused: `earliestReset` becomes "back at HH:MM" in the Curia app banner and in Discord `/status`, and a fabricated reset time on a credentials surface is the class of lie the credential broker exists to remove. A landed cap never overwrites one, a `model:` label never steps over one, and nothing seeds it at boot - a restart spends one refresh to hear the same answer and re-arms it. Adoption of a fresh credential is the only thing that lifts it, and lifting it also uncools the lane. While it stands, the stall sweep skips every agent on that provider: see **Freeze in place**.

**Lane status**:
What a credential row says about the BOX rather than about a file ([#661](https://github.com/alp82/curia/issues/661)): whether the provider's lane is dispatching, and which live agents are on it. Every consumer row on the overview carries one. It exists because a dead credential is not a fact about a file - one lane stops dispatching and every live agent on it freezes mid-ticket - and no state word could carry that. It could not ride the pre-emptive hold's shape either: that structure is usage-shaped, a window, a percent and a reset instant, and a credential hold has none of the three. The wire states the two facts and every surface composes the sentence from them, so the word "frozen" is said in one voice. It carries **no second copy of the reason**: the row's own `held` and `why` hold that, and two accounts of one fault are free to disagree. Both anthropic rows answer the same, because one lane serves them both.

**Freeze in place**:
What curia does to live agents when their model credential dies ([#644](docs/live-checks/644-credential-swap-heals.md), [#646](https://github.com/alp82/curia/issues/646)). The pane, the claim, the worktree and the conversation are left exactly where they are, because a running codex process picks up a replaced `auth.json` with no restart, and killing to save the minutes an operator needs to open a link on a phone throws away hours of context. It is only freeze because the **stall ladder does not run**: a turn that died leaves the agent idle at the composer, which reads as a stall, so rung 1 would nudge a credential that cannot work and rung 2 would respawn - a kill, half an hour after a failure whose whole design was to keep the agent. The skip is journaled once per agent per hold. On recovery the fan-out heals the agent and the next sweep's nudge is what finishes it. It works on the claude lane too, and that is measurement rather than symmetry: [#659](docs/live-checks/659-claude-credential-file.md) found the channel #646 had inferred away, because the CLI also reads `<CLAUDE_CONFIG_DIR>/.credentials.json` and that directory is already a mount. Writing a good file into a running agent heals it with no restart, **including an agent spawned before [#648](https://github.com/alp82/curia/issues/648)**, its expired environment variable still in place - so no kill path was ever built. The overseer is not frozen at all: it re-reads its credential per turn, so a turn in flight fails and the next one is correct. **The whole recovery is measured end to end** ([#667](docs/live-checks/667-daemon-heals-a-real-agent.md)), on agents the daemon dispatched rather than containers built by hand: hold, freeze, the sweep's skip, a login curia started itself, adoption, the hold lifted and the fan-out on that same tick, then rung 1 fifteen minutes after the turn died - accepted in under two seconds, with the agent going back to the ticket it had been working, same conversation and same worktree. Nothing above rung 1 was needed. **The two lanes do not fail alike, and the asymmetry is in curia's favour:** the claude CLI reads its credential file per request, so a replacement takes effect on the next turn either way, while a codex process holds its access token in memory and returns to the file only when a call fails. So writing a credential into a healthy codex agent changes nothing until it needs it - a codex agent survives a rotation it never notices - and the fan-out can heal a codex agent but can never be the thing that breaks one.

**Stated reset**:
The instant a cooling ends. Two surfaces state it, and curia reads both: the anthropic pane text carries an epoch beside the reached-text, and the codex transcript carries `resets_at` beside the rate-limit window that is spent. A cap is account-level, so any live agent on that provider states it for the harness. With neither surface stating one, cooling holds for one hour.

**Exhaustion**:
The state where every candidate model is cooling. The frontier stays the queue, and a wake timer fires at the earliest reset. Exhaustion that stops a LIVE agent also arms a limit resume.

**Limit resume**:
The dispatch curia owes a ticket its own cooling stopped. Exhaustion kills the agent and releases the claim, and the worktree stands, so the resume is `resume` and never `start`: `start` recreates the worktree from origin and takes every uncommitted file with it. It is not gated on `auto_dispatch`, because that setting decides whether curia takes NEW work off the frontier and this puts back work the operator already ordered. A reviewer gets none, because the builder has already been told the reviewer ended. One arm buys one attempt, and a resume that walks back into the cap arms again from the fresh reset. The arm is journalled, so a daemon restart inside the window does not lose it. The thread carries the promise with the exhaustion and the outcome at the reset, and it says so when the resume cannot be made.

**Failed-spawn step-over**:
The rule that stops the auto loop taking a ticket that dies at every spawn. A dispatch that fails releases the claim, so the ticket is back on the frontier for the next tick, and nothing counted the repeat. Two failed spawns in a row, and the loop steps over the ticket.
A **failed spawn** is a dispatch that ended with the claim released and the agent silent on the tool channel. A broken image pin, a container that dies at once and an agent that died before it reported are each one. An agent that reached its curia tools clears the count, because that ticket does not die at its spawn, and [#376](https://github.com/alp82/curia/issues/376) resumes it with its files. Exhaustion never counts. Every lane cooling is not this ticket's fault, and the cooling is already its own throttle.
It binds the AUTO LOOP only. A `start` or a `resume` the operator types dispatches a stepped-over ticket at once, and clears the count with it, which is [#346](https://github.com/alp82/curia/issues/346)'s rule again: curia holds no order the operator did not repeat. The count lives in the journal, so a deploy inside the window does not lose it.
Three surfaces name it: the journal events `dispatch_failed` and `dispatch_held`, one line in the ticket thread at the instant the step-over arms, and a row in the Curia app Needs-you list beside a line in Discord `status`. It is COUNTED in Needs-you, where a cooling hold is not, because an operator act is the only thing that ends it. Two is the cap the operator settled on. One would park a ticket on a single GitHub blip, and the loop cannot tell a blip from a fault. See [#444](https://github.com/alp82/curia/issues/444).
_Avoid_: backoff, retry cap.

**Death-resume step-over**:
The rule that stops repeated automatic resumes after an agent reached the tool channel and died. The first released death gets one automatic resume. If that agent also dies after tool traffic, the auto loop steps over the ticket.
It binds only the auto loop. A `start` or `resume` command from the operator clears the count. The journal stores `agent_died_released` and `death_resume_held`, so a daemon restart does not lose the count. The thread states the hold once. Discord status and the Curia app Needs-you list keep the hold visible. See [#578](https://github.com/alp82/curia/issues/578).
_Avoid_: failed spawn (that agent never reached the tool channel).

**Stall watchdog**:
The recovery steps for a live agent whose transcript stops for 15 minutes. An open question, a parked agent, or an active pane prevents action.
The pane must show an API error or an idle prompt. Curia first sends one continue message and checks the pane. It retries once.
If the pane shows no active turn after both attempts, curia respawns the harness. It uses the configured resume command.
If the resumed agent stalls, curia stops automatic recovery. The ticket joins the Needs-you list until the operator dispatches it again.
The journal stores a start before curia acts and a completion after the effect. A restart retries an incomplete step.
Curia does not repeat a completed step. See [#574](https://github.com/alp82/curia/issues/574).

**Overseer**:
The command brain of curia. The standing design is one brain with three skins (Discord, text, voice). The shipped daemon uses a deterministic router instead.

**Overseer service**:
The container that hosts the overseer. One long-lived service beside the Curia app. It is one shared container and never one container per conversation. Since [ADR-0024](docs/adr/0024-the-overseer-chat-is-a-pane.md) it is no longer pane-less: each live conversation runs as a tmux pane whose process execs into this container, and a routine deploy kills those panes, which park and return by rehydration on the next message. It runs its own image, built from `deploy/overseer/Dockerfile`, which carries git, gh and a reading shell and no build toolchain — so the overseer reads every watched repo and runs no test suite. It is the one service off the host network: a shell in it reaches the daemon at `host.docker.internal` and no other surface on the box, and the daemon reaches it on one published loopback port. Compose owns its liveness, and the daemon only health-checks it. It serves two routes and no third: the health check, and one operator message. See [ADR-0015](docs/adr/0015-the-overseer-is-a-service.md), [#327](https://github.com/alp82/curia/issues/327) and [#314](https://github.com/alp82/curia/issues/314).

**Standing orders**:
The text the overseer model reads before every turn, plus the tool list that agrees with it. One function writes both, in `daemon/src/overseerprompt.mjs`, and a flag picks the posture: a shell for the overseer service, and the no-shell text the retired in-daemon host sent, kept as the pinned record. The shell posture states where the overseer checkouts are, that the checkout pass fetched them once before this turn, and that the overseer token cannot write. It is composed per turn, because the checkout path holds the workspace root and the watch list changes. It STATES the posture and enforces none of it, because a standing order cannot hold a shell. What enforces the posture is four controls: the read-only overseer token, the container, the ✅/❌ confirm on `cancel`, and the tool list. The rest are manners, and a shell undoes each in one command. The text never marks that difference itself, because a line naming an unenforced rule is a line hostile text can quote back. See [ADR-0014](docs/adr/0014-the-overseer-in-its-own-container.md) and [#328](https://github.com/alp82/curia/issues/328).
_Avoid_: system prompt (that names one of the two things this word covers, and the tool list is the other half).

**Conversation**:
One thread's exchange with the overseer. The daemon holds its state, so a conversation outlives the container that answers it. Every top-level Discord message opens a thread and starts a new conversation. The browser holds many of its own, and a new one is how the operator resets. Nothing expires a conversation on a timer. See [ADR-0016](docs/adr/0016-the-conversation-key.md).
_Avoid_: session (that names the tmux session, which is an agent's identity).

**Conversation key**:
The identity of one conversation. It keys the resume id, the notes waiting for the next turn, and the one-turn-at-a-time lock. It has two shapes that cannot collide: a Discord thread snowflake, which is all digits, and `console-<n>` for a browser conversation, which starts with a letter. A browser number is never reused, because a reused one would wake a deleted conversation's memory. The daemon owns the key, and the container never learns what one means. See [ADR-0016](docs/adr/0016-the-conversation-key.md).
_Avoid_: thread id (that names the Discord object, and only one shape of key is one).

**Pane message**:
One complete operator message into a live conversation pane. Three things ride in it, in this order: the checkout verdict, one line per watched repo from a pass the overseer container runs before every message; the notes curia queued between messages, each in its own `[curia: …]` line; and the operator's own words, last. A pane holds one system prompt for its whole life, so the per-message facts have nowhere else to be — which is why the whole message enters as one bracketed paste, with its newlines intact, instead of as typing that would submit each line as a turn. The send returns when the message is IN, not when the answer is out: the answer reaches the operator off the transcript, and the adapters read the completion signal below. A message the pane refuses puts its drained notes back on the queue. See [ADR-0024](docs/adr/0024-the-overseer-chat-is-a-pane.md) and [#708](https://github.com/alp82/curia/issues/708).
_Avoid_: overseer turn (that is the HTTP lane of ADR-0015, which Discord still takes).

**Completion signal**:
The one thing an adapter hangs "finished" off for a pane message. A pane ends no stream and writes no result message, so the pane text is the only witness: curia watches the harness start a turn and stop showing one, then emits exactly one signal — journalled as `overseer_pane_message_ended` and handed to whatever the host was built with. It fires on every ending, including the two failures that have no answer behind them: a pane that never picked the message up, and a harness still working when the message clock ran out. Silence is the one outcome an adapter cannot render. See [ADR-0024](docs/adr/0024-the-overseer-chat-is-a-pane.md) and [#708](https://github.com/alp82/curia/issues/708).

**Pane parking**:
Stopping an idle conversation's live pane while the conversation stays whole: the process ends, and the journal keeps the key, the resume id, the notes, the durable tool token and the transcript identity. The next operator message rehydrates the pane from the journalled session id, before any model work. Live panes have their own cap, `overseer.live_pane_cap`, which defaults to 3 and is separate from `dispatch.max_concurrent` — the two budgets measure different promises, and the cap bounds the cache rather than the number of conversations, which stays unlimited. At the cap curia parks the least recently used IDLE pane: a pane mid-message is skipped, and a cap where every pane is working parks nothing rather than cutting an answer off. The operator never reads about a park. A routine deploy is a forced park, and the daemon dies with those panes, so it records them on the way back: at boot, every conversation the journal still calls live whose tmux session is gone is parked as forced. A message that was in flight then is a killed turn and falls to the replay rules. See [ADR-0024](docs/adr/0024-the-overseer-chat-is-a-pane.md) and [#710](https://github.com/alp82/curia/issues/710).
_Avoid_: parked (that names a builder idle inside a cross-check gate).

**Single-use conversation thread**:
The rule that a conversation thread carries one thing. Work dispatched from a conversation takes over that same thread, renamed on purpose, rather than opening a second thread beside it. One exception stands: an issuing thread that already carries another ticket sends the work elsewhere, and breadcrumbs link both ends. The thread stays bound to the name the dispatch ran under for the whole session, so every line the agent says lands in it. curia charts a new map under a chat handle. The map number takes that thread through the journal when the session ends. See [#326](https://github.com/alp82/curia/issues/326).

**Turn**:
One operator message, answered. It is the unit the overseer works in, and nothing of the overseer runs between turns. One turn at a time per conversation, and no cap across conversations.
_Avoid_: using it for the model's own steps inside one message (`maxTurns` counts those).

**Turn request**:
How a message becomes a turn once the brain is in a container. The daemon posts one message to the overseer service on its published loopback port, and the container streams events back: the session id, the checkout verdict, then the answer. The container holds no conversation, because the resume id travels out with the message and the session id travels back. The model's verb tools reach the other way, over the same MCP side channel every agent container uses, so the daemon composes the canonical text itself and posts it to `/command`. Every effect crosses that one seam, and the ✅/❌ confirm on `cancel` survives the move. See [#314](https://github.com/alp82/curia/issues/314).
_Avoid_: turn (that is the operator's message, whoever answers it).

**Killed turn**:
A turn a restart ended before it answered. The routine deploy recreates the daemon and the overseer together, so both halves of a turn in flight die at once. The daemon journals the message when a turn starts and journals the end when it ends, so whatever is still open at a boot is what the restart killed.
_Avoid_: failed turn (that one ran and the model did not answer, and nothing is sent again for it).

**Replay**:
Sending a killed turn's message again, instead of asking the operator to type it twice. The test is the seam count: a turn that crossed `/command` zero times is sent again, and a turn that ran a verb is not — sending that one again would run the verb twice. curia sends one message again once, never twice, and it holds the replay if the conversation has already spoken, if the message is over fifteen minutes old, or if the container did not come back. Every turn it does not send again gets one line naming what that turn ran, and the operator decides. A Discord conversation reads that line in its thread. A browser conversation has no thread, so it reads it on its row in the Chat picker until it takes its next turn. See [ADR-0015](docs/adr/0015-the-overseer-is-a-service.md) and [#388](https://github.com/alp82/curia/issues/388).
_Avoid_: retry (that names the fallback the in-daemon host ran on a second model, and it is gone).

**Turn secret**:
What opens the daemon's verb tools to one turn of the overseer container. The daemon mints it per turn, hands it over inside the turn request, and forgets it when the turn ends. It is not an agent token: an agent's is a file, because a restarted daemon adopts the agents its predecessor spawned, and a turn survives no restart at all. See [#314](https://github.com/alp82/curia/issues/314).
_Avoid_: agent token (that one is per agent, on disk, and it opens a different route).

**Conversation token**:
What opens the daemon's verb tools to one overseer conversation hosted in a pane. The daemon mints one 32-byte secret per conversation into `daemon/data/overseer-tokens/<key>`, writes it into that pane's own `.mcp.json` file, and reads it back for every call the pane makes. It is durable where the turn secret is not, because a pane outlives many turns, a parking and a deploy, and a rehydrated pane must keep the identity it had. The token is the whole claim: the pane reaches `/overseer/mcp?conversation=<key>`, the daemon compares the stored secret in constant time, and only then loads the destination from the key. A pane that names another conversation presents the wrong secret for it. The pane is never told its key, so the connection settings land in a project directory named by the session id, which is the one handle both sides hold. Deleting a conversation revokes the token, and a sweep clears every token nothing addresses. It widens no authority: it opens the overseer verb catalogue, the daemon still composes every canonical command, and the ✅/❌ confirm stands. See [ADR-0024](docs/adr/0024-the-overseer-chat-is-a-pane.md) and [#701](https://github.com/alp82/curia/issues/701).
_Avoid_: turn secret (that one lives in memory for one turn of the HTTP turn lane), pane token.

**Overseer checkout**:
The overseer's own blobless clone of one watched repo, at `<workspace_root>/overseer/repos/<owner>__<repo>`. It is a mirror of origin and holds nothing of its own: no git identity, no local commit, no branch to commit onto. It carries every ref — every branch, so `curia/<n>` is there while an agent works, plus every pull-request head, which is what stays readable after a merge deletes the branch. See [ADR-0014](docs/adr/0014-the-overseer-in-its-own-container.md) and the [live checks](docs/live-checks/312-overseer-checkouts.md).
_Avoid_: private clone (that is an agent's, per ticket, and it is a place to commit).

**Checkout pass**:
What the overseer container runs at the start of every turn, before the model: clone every watched repo that is missing, delete the clone of one nobody watches, and fetch the rest in parallel. The per-owner git routing is rewritten just before it, off the same watch list, so a repo the pass has never seen is fetched with the right token rather than with none. It is the whole reason every read inside one turn is consistent. The daemon asserts nothing about this tree. A repo whose fetch fails does not refuse the turn — the pass returns a verdict per repo, and the turn tells the model which checkout is stale and how old it is.

**Overseer token**:
The read-only GitHub token the overseer container holds, one per resource owner. It is the control that replaces the seam: the container has a shell, and a shell cannot mint a token. The daemon mints it from the GitHub App at the read set of [ADR-0018](docs/adr/0018-the-daemon-is-a-github-app.md), and writes one file per owner into `<workspace_root>/overseer/tokens/<owner>`, which the container mounts read-only and which holds nothing else. The daemon rewrites each file on the dispatch tick, because an installation token lives one hour and this container runs for weeks. Each tool picks its owner differently, so the container installs two halves: git takes one `credential.https://github.com/<owner>.helper` line per owner, and `gh` takes a shim, because it reads a single `GH_TOKEN`. Both read the file at the moment they need it. The git half is written at container start and again at the start of every turn, off the watch list of that turn. Nothing here is held from the container's own boot, so watching a repo of a brand new owner is an ordinary save ([#392](https://github.com/alp82/curia/issues/392)). See [ADR-0014](docs/adr/0014-the-overseer-in-its-own-container.md) and the live checks for [#313](docs/live-checks/313-overseer-github-token.md) and [#392](docs/live-checks/392-overseer-minted-token.md).
_Avoid_: agent GitHub credential (that one is read-write, per agent, and it is a `gh` config dir the daemon rewrites).
`CURIA_OVERSEER_GH_TOKEN_<OWNER>` in `daemon/.env.overseer` was the PAT this replaced. The file and key are retired. Boot names legacy keys until the operator deletes the file ([#726](https://github.com/alp82/curia/issues/726)).

**GitHub App**:
Curia's one GitHub identity. The operator creates one app and installs it on each watched owner. The daemon holds its private key at `daemon/.curia-app.pem`, names it with `CURIA_GH_APP_ID` and `CURIA_GH_APP_KEY_FILE` in `daemon/.env.daemon`, and mints every GitHub token from it. The bot is `curia-sh[bot]`, and the app id is 4610603. Decided at [ADR-0018](docs/adr/0018-the-daemon-is-a-github-app.md). The operator's own steps are [docs/github-app.md](docs/github-app.md). Every holder has cut over: the AGENTS on [#389](https://github.com/alp82/curia/issues/389), the DAEMON on [#390](https://github.com/alp82/curia/issues/390), the OVERSEER on [#392](https://github.com/alp82/curia/issues/392). Every PAT retired with them, and the agents' last one went on [#466](https://github.com/alp82/curia/issues/466). So the app is required to dispatch an agent. The host `gh` login keeps three jobs: dev sessions, the deploy sibling, and the gate approval.
_Avoid_: OAuth app.

**Installation token**:
What the daemon mints from the app key, one per resource owner and per role. Two roles: read-write for agents, read-only for the overseer and for a cross-check reviewer. A minted token scopes down from what the installation grants, which is what lets one key hold both. It lives one hour, so a holder reads a file the daemon rewrites and never an environment variable frozen at spawn.
_Avoid_: app token (that name is the JWT the daemon signs, and a JWT mints installation tokens rather than reaching a repo).

**Agent GitHub credential**:
The file an agent reaches GitHub with, at `<workspace_root>/cfg/curia-<n>/gh/`. It is a `gh` config dir — `hosts.yml` beside a `config.yml` — and the container environment carries `GH_CONFIG_DIR` and no token at all. One file serves both tools, because git already reaches GitHub through `gh auth git-credential`. `config.yml` states `version: "1"` and `hosts.yml` carries a `users:` block, and both are load-bearing: without them `gh` runs a config migration that calls `GET /user`, which an installation token answers 403, and then refuses every command. The daemon writes it at spawn and rewrites it on the dispatch tick, because the token lives one hour and a ticket outlives it. Its presence is also the evidence that an agent is armed, which is what makes an adopted agent free to refresh. A mint that fails REFUSES the dispatch and releases the claim, because nothing stands behind it since [#466](https://github.com/alp82/curia/issues/466): an agent with no credential cannot read its own ticket. It goes with the config dir at every ending. See [#389](https://github.com/alp82/curia/issues/389) and the [live check](docs/live-checks/389-agent-minted-token.md).
_Avoid_: agent token (that one is the 32-byte secret on the daemon's loopback surface, #159), `GH_TOKEN` (the environment variable this replaced, retired with `CURIA_AGENT_GH_TOKEN_*` on #466).

**Daemon GitHub credential**:
What the daemon reaches GitHub with for its own work: the frontier reads, the claim, the clone, the pull request and the branch push. One minted write token per resource owner, put in the environment of the one `gh` or `git` child that needs it and never in the daemon's own. The repo the call names is what picks the owner, so nothing downstream holds a minter. It is `GH_TOKEN` rather than a `gh` config dir, because the daemon spawns its own children and has no container mount to serve. Two calls keep the HOST login, and both are the settings screen's repo picker: `viewerLogin()` and `gh api user/repos`. Neither names a repo, and an installation token answers neither. An owner the app is not installed on falls back to the host login, loudly. Lives in `daemon/src/daemongh.mjs`. See [#390](https://github.com/alp82/curia/issues/390).
_Avoid_: daemon token, host login (that one is the operator's own `gh`, which keeps dev sessions, the deploy sibling and the gate approval).

**Model credential**:
What an agent or the overseer reaches its model provider with. There are three consumers, and the word is consumer rather than harness because the overseer is one and is not the other: codex agent containers, claude agent containers, and the overseer. The daemon owns them ([ADR-0027](docs/adr/0027-the-daemon-owns-model-credentials.md)), and an agent holds a lease it never writes. On the codex lane the broker in `daemon/src/credentials.mjs` reads the access token's own `iat` and `exp` claims, refreshes on the dispatch tick once the token is inside the last quarter of its life, writes `<workspace_root>/home/.codex/auth.json` first, and then fans the result out to the config dirs of live agents at mode `0400`. Live agents only: a dead config dir holds nothing worth a live credential. The **store is keyed by provider, not by consumer**: two stores, three rows ([#648](https://github.com/alp82/curia/issues/648)). The claude containers and the overseer run on one value from one account, so both rows point at `<workspace_root>/credentials/anthropic.json` and say so - a store per consumer would be two copies of one token and two expiry answers free to disagree. The contract is **two tables**, and neither is keyed by harness: a provider contract of `credentialExpiry`, `refresh` and `reauth`, and a consumer contract of `provider`, `deliver` and `heal`. `config.mjs` refuses a boot where a configured harness names a provider with no contract row, or a consumer declares no delivery. The anthropic lane states `refresh: null`, because `setup-token` has no rotation and the `/login` shape that does was refused for handing every agent container the operator's full account scope; its expiry is the documented one year counted from a daemon-stamped `obtained_at`, labelled as an estimate, and `unknown` where the credential was seeded rather than adopted. What detects a dead one there is a quota-free `GET /v1/models/<id>` probe, so detection survives `account_bars: false` and an idle fleet ([#666](https://github.com/alp82/curia/issues/666)). It runs on a ten-minute schedule, and a **consumer whose model call just failed re-runs it at once** ([#678](https://github.com/alp82/curia/issues/678)): the overseer takes a turn whenever the operator speaks, so a failed turn is the earliest thing on the box that can know. The turn supplies only the timing - every failure the overseer container can have collapses into one `why` string by the time it crosses the boundary, and a string must never freeze the fleet, so the probe's typed verdict still decides. A triggered check skips the schedule's interval and nothing else, and names itself as `trigger` on the resulting hold so an operator can tell what curia found from what made it look. While the lane is held, a failed turn's line points at the sign-in without repeating its reason or its link. Delivery differs per consumer and neither shape is an environment variable: a claude agent gets `<cfgDir>/.credentials.json`, written at spawn and rewritten by the tick, and the overseer gets the store itself behind a read-only mount, re-read per turn. Subscription only, with no API-key path anywhere. A refresh that fails is classified before anything acts on it: HTTP 400 or 401 carrying `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`, or HTTP 400 carrying `invalid_grant`, is terminal, and everything else - an unrecognized 401 included - is transient until five consecutive failures make a terminal call anyway. Codex itself treats any 401 as permanent and curia deliberately does not, because a wrong transient call costs minutes of an outage already under way and a wrong terminal call wakes the operator for a network blip. A terminal call arms a **credential hold**, latches the broker off the wire, freezes the live agents in place, and starts a login in the same breath. See [#642](https://github.com/alp82/curia/issues/642), [#646](https://github.com/alp82/curia/issues/646), and the [failure evidence](docs/research/provider-credential-failures.md).
_Avoid_: model token, auth file (the second names one consumer's file shape, and there are three consumers).

**Re-authentication session**:
The tmux session a login runs in, named `curia-auth-<provider>` - by provider and not by consumer, because one anthropic login serves the claude containers and the overseer both. One session per provider, enforced by the fixed name, a window each lane declares for itself, and every outcome journaled, because a re-authentication that silently vanished is the same class of bug as the credential that silently vanished. **No sweep ever walks one**: not the liveness sweep, not the stall sweep, not reconcile, not the credential sweep, not the container sweep. The operator drives it from a phone through the ttyd attach surface, so the recovery from a dead credential has no ssh in it. One flow with **one lane per provider** ([#660](https://github.com/alp82/curia/issues/660)): the session naming, the window, the sweep guards and the teardown are shared, and only what to run, what the pane means, and what completion is vary. On the **codex** lane it runs `codex login --device-auth`, which prints a link and a one-time code whose lifetime curia READS off the pane - fifteen minutes at the time of writing, with fifteen as the lane's fallback for a frame that does not say ([#721](https://github.com/alp82/curia/issues/721)) - and needs nothing pasted back, and completion is the credential file appearing in the scratch config dir. On the **anthropic** lane it runs `claude setup-token`, which writes no credential file at all and prints the token once into a redrawing Ink TUI - so completion is the token appearing in the pane, and the operator pastes a code **in** rather than reading one out. That is a parsing contract with the CLI's output, which [ADR-0027](docs/adr/0027-the-daemon-owns-model-credentials.md) chose this surface to avoid, and it is made falsifiable rather than trusted: curia asks Anthropic whether the string it reassembled authenticates and adopts only on a `200`, so a misread frame ends the login as `failed` with the store untouched. Ink hard-wraps at the pane width and `capture-pane -J` cannot undo it, so a 108-character token arrives in pieces and is rejoined by width and charset together. The Curia app draws the link in a panel on the **Credentials screen** - plus the code on the codex lane - and degrades to "open the terminal" when the scrape misses. That fallback is a real link since [#661](https://github.com/alp82/curia/issues/661): the daemon composes it over the same publish-and-verify path `attach` uses, stamps it on the flow, and hands it to Discord and the panel both, so one composition serves two surfaces and a page never builds a URL it cannot vouch for. Where the surface cannot be published the panel says so rather than linking nowhere. Discord gets the alarm, a terminal link and a link to the Credentials screen, never the code. **The anthropic token reaches no surface at all**: it goes from the pane to the store, and the teardown on the adopting tick is what takes the last plaintext copy off the box. `reauth [provider]` is the verb, and bare means `openai`. **A restart does not end a login** ([#671](https://github.com/alp82/curia/issues/671)): the flow is process state and keeps no file, so the journal carries the one fact a restart cannot re-derive - one `reauth_started` line, one terminal line, and the next daemon reads what is left between them, the way [ADR-0015](docs/adr/0015-the-overseer-is-a-service.md) reads an overseer turn a restart killed. Only the clock comes back, because the session is named by its provider and the pane is scraped again on the same tick. Boot reconcile runs that poll rather than leaving the panel blank for a tick, and the ordinary poll decides the outcome: adopted, timed out, expired, or abandoned. **`expired` and `abandoned` are two endings** ([#721](https://github.com/alp82/curia/issues/721)), and the codex lane is why. Both present the same way - the session is gone and no credential arrived - so one word covered both, and the word blamed the operator for a clock they did not own: a codex login **exits by itself** when its code runs out (`device auth timed out after 15 minutes`, measured in [the live check](docs/live-checks/680-device-code-expiry.md)) and takes its session with it. The code's own lifetime, counted from `startedAt`, is the only thing on the box that can tell the two apart, because codex logs neither ending and the pane is gone before the next tick reads it. It fails toward calling an abandonment a timeout, which is the harmless direction. A lane with no code of its own states `null` and every vanished session there reads as an abandonment. **The 30-minute window is the anthropic lane's**: codex's fifteen always arrives first, so it has never fired on that lane, and both lanes state the number rather than sharing one that looks like a decision and is not. Every ending carries a sentence, which is what the credential card that already stands says about the login that disappeared. The session is the liveness and the record is not, so an open record whose session is gone never answers "already running" to an operator asking for a login. See [#642](https://github.com/alp82/curia/issues/642) and the live checks for [#644](docs/live-checks/644-credential-swap-heals.md), [#642](docs/live-checks/642-codex-reauth.md), [#659](docs/live-checks/659-claude-credential-file.md) and [#660](docs/live-checks/660-setup-token-frame.md).
_Avoid_: login session, auth pane.

**Claim login**:
The user a claim assigns, read from `dispatch.claim_login` in `config/curia.yaml`. A claim is an issue assignee and GitHub does not let an App be one, so the daemon calls as `curia-sh[bot]` and names a real person. Required, with no default: the boot refuses a config without it, because every other source for the name is a guess. It replaced `gh api user`, which answers nothing under an installation token. See [#390](https://github.com/alp82/curia/issues/390).
_Avoid_: viewer login (that name is now only the settings screen's repo picker).

**Credential watch**:
What tells the operator a GitHub token is dying, in time to mint a new one. The daemon probes every watched repo with the token that repo is read with, once at boot, once at every watch reload, and every six hours after that. It measures two facts and says both where the operator reads. The first is reach: a token that answers 404, 403 or 401 on a watched repo. The second is expiry, on a ladder of 14 days, 7, 3, 1 and expired. Each step is said once, in `#curia`, and it also stands in the Curia app Needs-you list until the reading clears. A step already said is never repeated, so a deploy is silent, and a line that did not reach Discord is re-said at the next pass and at bridge start. The expiry is keyed on the token and the reach on the token and the repo together, because one token covers every repo of an owner. It files no ticket and dispatches nothing, which is what keeps [#345](https://github.com/alp82/curia/issues/345)'s refusal of a scheduler intact. Lives in `daemon/src/tokenwatch.mjs`. See [#380](https://github.com/alp82/curia/issues/380).
_Avoid_: token alarm, expiry cron.
The expiry half is a PAT-only fact and it dies holder by holder as [ADR-0018](docs/adr/0018-the-daemon-is-a-github-app.md) cuts over: an installation token lives one hour and the daemon refreshes it, so its expiry is nothing the operator can act on and curia must never warn about one. The reach half survives for every holder and for the installation itself. The agents cut over at [#389](https://github.com/alp82/curia/issues/389) and their PAT is still warned about, correctly: it stayed as the fallback, so it is still a token that dies and takes an owner's dispatches with it. That warning stops when the key retires.

**The verbs**:
`tickets`, `next`, `status`, `start`, `map`, `cancel`, `resume`, `attach`, `review`. The whole command surface, identical over Discord and REST. Each verb has one meaning. `start` works a thing, and `map` updates a map.
_Avoid_: the five verbs (the pre-#81 count, wrong since `next`, `resume` and `review` joined).

**Typed command**:
A top-level message in the command channel that the parser accepts as a whole line. It runs on the router before any model turn: no conversation thread, and no overseer session. A line the parser refuses, and a line that only starts with a verb, are both prose, and prose opens a conversation. See [ADR-0022](docs/adr/0022-the-overseers-command-understanding.md) and [#692](https://github.com/alp82/curia/issues/692).
_Avoid_: slash command (that names the Discord manifest, which is another transport onto the same router).

**The map tools**:
The two tools the overseer reaches the `map` verb through. `map_update` requires an existing map's number. `map_new` has no number field at all and requires the operator's brief. Both compose the same `map` router text, so the grammar, the slash surface and the operator's usage catalogue don't change. The test of which shape to use is a schema rather than prompt prose, so the wrong shape is not a call the model can make. See [ADR-0022](docs/adr/0022-the-overseers-command-understanding.md) and [#692](https://github.com/alp82/curia/issues/692).

**Resume**:
A fresh agent on a ticket whose agent is gone. It inherits the surviving worktree, the model of the last spawn, which the journal states, and the inherited exchange (#374). It never inherits the conversation. A live agent refuses it: `cancel <n>` is the way to end one.

**Cancel**:
The one act that ends a running agent. It kills the session, captures anything in the clone that exists nowhere else onto a **salvage branch**, removes the worktree and releases the GitHub claim. A capture curia cannot make keeps the worktree instead, and the line says so - the session and the claim end either way, because that is what was ordered. It closes every open question of that agent, and the ticket goes back to the frontier. The word has one place: `cancel <n>` in the command channel. No button on a question ends anything.

### Agents

**Agent**:
One harness process, spawned per ticket, that works the ticket to its ending. It may spawn subagents of its own, which curia neither sees nor counts.
_Avoid_: worker (the old name, swept in #184).

**Session**:
The tmux session `curia-<n>`. The session name is an internal routing identifier. Discord messages use the `curia` identity.

**Chat handle**:
The name of an agent no issue answers for: `chat-1`, `chat-2`, the lowest free index at dispatch. It stands where a ticket number stands — the session `curia-chat-1`, the worktree, the thread, and the argument `attach`, `cancel` and `resume` take. Today one kind of agent uses it: the new-map dispatch. It names agents only. A browser conversation is keyed `console-<n>`, so the two never collide.

**Agent host**:
The layer that hosts agent sessions and their attach: tmux, one shared ttyd, Tailscale Serve. Each pane runs one `docker run`, never the harness directly.
_Avoid_: substrate (banned by the operator).

**Private clone**:
The agent's own blobless clone, per ticket, on branch `curia/<n>`. The one workspace shape (#195).
_Retired_: **worktree** (a per-ticket worktree cut from a shared **base clone**) was the bare path's shape. A container cannot use one, whose `.git` points into a base clone it never sees, so #195 deleted both with the bare path and the box was cleaned by hand.

**Published port**:
One of the three loopback ports an agent's container publishes, the same number inside and out. The prompt names them, an agent binds its dev server to `0.0.0.0` on one of them, and that preview's identity proxy points at it. They are the whole bound on `publish_preview` for a sandboxed agent.

**Config dir**:
The agent's private config home for its harness. It holds the prompt, the skills, the harness settings, and on the claude path nothing else. It holds no credentials.

**Tool namespace**:
The MCP servers an agent can reach: curia's own, and nothing else. Two settings keys in the config dir hold that line. One stops the fetch of the operator's account-level claude.ai connectors, which follow the shared credential rather than the config dir. The other admits curia's server alone. The line is closed by decision as well as by settings: a read-only MCP history server was proposed and refused (#344). History that ever reaches an agent arrives as tools on curia's own server, or it does not ship.

**Skills**:
The skill set curia symlinks into every agent's config dir, so an agent resolves in the same idiom as a hand session.

**Skill pointer**:
A small skill curia writes into the codex agent's config dir, one per skill codex hides from its own catalog (`wayfinder` and `implement` today). Codex lists a skill whose manifest sets `allow_implicit_invocation: false` nowhere, so the model never learns it exists. The pointer carries the real skill's own description, names the installed file, and restates none of it. Its point is the channel: the catalog is a developer message, so it is world state and it is restated every turn, where the old `$wayfinder` mention was one user message that went stale and could not be repeated without pasting the skill again (#360, #399). Curia patches no vendored byte, and it reads upstream's manifest to decide which skills need one, so a release that lists them stops the pointers by itself. The claude lane has none and needs none: `/wayfinder` is a slash command that expands the whole file into the first user message.
_Avoid_: patched manifest, catalog flip.

**Standing orders**:
Standing orders define the bounds, tools, and ending that hold for every ticket turn. They don't define general procedure. Installed skills define procedure. Prototype dispatches add their configured round rule here because curia doesn't patch vendored skills. The orders use the command-line interface global-memory file in the agent's config directory. Both harnesses load that file as instructions, while a user message becomes stale (#340).

**Spawn prompt**:
The parameters of one dispatch: the ticket, the map, the worktree, the ports and the inherited exchange. It states no bound and no procedure, and it points at the standing orders. On the claude lane it also carries the `/wayfinder` line, which loads the skill. The codex lane carries no such line since #399: a mention there pasted the whole skill into the conversation, and the skill pointer reaches it through the catalog instead.

**Bounds**:
The hard limits in the standing orders. Read anything. Write only inside the worktree, the ticket, and the map subtree. No browser. Never answer for the human. A failed call is not an answer, and silence is not an answer.

**Harness settings**:
What curia writes so the harness itself starts quietly and bounded: no onboarding, the worktree pre-trusted, the permission mode, and the tool namespace. They live in the config dir.

**Connection settings**:
What curia writes so an agent reaches the side channel and the Stop hook: the MCP server URL, the agent token, and the Stop-hook command. Where they land is the harness's business — the claude path puts them in the worktree, the codex path in the config dir.

**Sandbox**:
The boundary around an agent: one Docker container per agent, holding its own clone and cfg dir and nothing else of the box. It denies host HOME, the daemon's secrets and state, sibling worktrees, and the tmux socket. The network stays open. The pane runs the container, so every attach surface is unchanged.

**Sandbox switch**:
`harnesses.<name>.sandbox` in `routing.yaml`: `docker` or `none`. Per harness. The claude harness is on and soaking, the codex harness follows.

**Agent image**:
The one image every agent container runs. It carries every Selectable harness at a pinned version and nothing per-ticket: claude and codex ([#696](https://github.com/alp82/curia/issues/696)). The build asks each one for its version as the worker user and fails when the answer isn't the pin, so routing can never select a command line interface the container lacks. Its tag is a content address over the Dockerfile and the pins, so a bump names an image the box does not have and the daemon rebuilds.

**Image pin**:
A container named `curia-agent-pin`, created against the live agent image and never started. The box's nightly docker cleanup deletes every image no container references, and no label protects one, so the reference is what keeps the image alive overnight. The daemon checks the pin on every dispatch. A new tag moves the pin and then removes every superseded tag of the same repository. The pin is the source deployment's alone: under an installation root the agent image is a release image, pulled by digest and removed by `curia purge`, and a pin container would hold it against that. See [#337](https://github.com/alp82/curia/issues/337) and [#350](https://github.com/alp82/curia/issues/350).

**Cache volume**:
A Docker volume shared by every agent for what is too heavy to bake into the image: the npm cache and the Playwright browsers. Cross-agent poisoning is an accepted risk.

**Side channel**:
The daemon's structured channel to an agent: the MCP tools and the Stop hook. Curia never parses the terminal to learn agent state.

**Last contact**:
How long ago an agent last reached curia on the side channel. Every tool call moves it, and it lives in memory, because a call is traffic and the journal holds evidence. The daemon journals the FIRST call per agent and no other ([#194](https://github.com/alp82/curia/issues/194)).

It is a reading of the live daemon process. No contact is two different facts, and every surface states which one it is. An agent this process spawned has said nothing at all. An agent it adopted after a restart has said nothing yet, and that silence belongs to the restart. Curia decides between neither: a working agent and a deaf one are both silent, so the operator reads the row and judges the silence ([#341](https://github.com/alp82/curia/issues/341), [#370](https://github.com/alp82/curia/issues/370)).

**Spawn binding**:
The rule that an agent's repo and ticket come from the spawn record, never from the agent's own account.

**Exit marker**:
The nonce line the spawn wrapper echoes into the pane when the harness command ends, with its status. It is what tells a dead spawn apart from a slow one.

### The cross-check

**Cross-check**:
A second reading of a builder's diff by a model on the other provider. The operator asks for it. Nothing starts one by itself. See [ADR-0010](docs/adr/0010-the-cross-check.md).

**Builder**:
The agent that works a ticket, in the cross-check's vocabulary. It holds the ticket's claim and it stays alive while the reviewer reads.

**Reviewer**:
The agent of a cross-check. It reads the diff, the ticket and a checkout, runs the tests, and ends with the verdict. It writes nothing: no tracker write, no push, no merge, no gate, no preview and no question. Its session is `curia-review-<n>`, and it is attachable and sandboxed as any agent.

**Pairing table**:
The `review:` section of `routing.yaml`, keyed by the builder's provider. An anthropic builder gets `gpt`, an openai builder gets `opus`. A `review-model:<name>` label on the ticket beats it.

**Review checkout**:
The reviewer's own checkout, at `repos/<owner>__<repo>/review/<n>`. It is a detached HEAD at the pushed tip of `curia/<n>`, because git refuses the same branch in two worktrees. It carries no branch, so there is nothing in it to commit onto.

**Verdict**:
The reviewer's one output: its `report_result` call. It is typed (#421): a `headline`, a `summary` of what it read and ran, and one `finding` entry per finding, each with a severity of `blocker`, `concern` or `note` and a flag for one that sits beyond the ticket. curia derives the **grade** — `pass`, `concerns` or `fail` — from those severities, so the reviewer never writes it. The daemon composes the text once, captures it as `data/verdicts/<n>.json` beside the parts, and holds it for the return path. A verdict read on the builder's own provider carries the stamp "same provider — cross-provider was cooling" at its top, written by curia.

### Human in the loop

**Escalation**:
The durable record of one question from an agent to a human. It survives daemon restarts.

**ask_human**:
The blocking tool an agent calls to ask a question. Kinds: free-text, choice, approve-reject, preview-review. The call blocks until an answer arrives, hours included.

**Round**:
The unit of a HITL exchange, and what an agent asks in one `ask_human` call (#285). It holds every question whose answer does not depend on another question still open. The agent numbers them and gives each a recommended answer, and the `recommended` flag puts a ✅ All as recommended button on the card. One question is a round of one. A question the operator leaves unanswered returns in the next round, and it is never taken as recommended. [ADR-0019](docs/adr/0019-typed-payloads-and-the-lint-grades.md) retires that flag: a typed round carries `questions[]`, and curia renders the button when every question carries a recommendation.
_Avoid_: batch.

**Typed payload**:
The named fields an agent fills instead of one prose string (#413). One vocabulary serves every surface: `headline`, `question`, `option`, `consequence`, `example`, `picture`, `table`, `diagram`, `detail`. Each surface takes a subset and sets its own mandatory floor. The agent writes the parts and the bridge lays them out. Since the flip (#422) every floor is mandatory: a call that omits a required field is refused, and the untyped `prompt`, the bare string option and the top-level `recommended` are refused with it. A refused call still reaches the operator at the cap, as a flagged send. See [ADR-0019](docs/adr/0019-typed-payloads-and-the-lint-grades.md).
_Avoid_: structured payload, card schema.

**Composite send**:
One agent call that returns an ordered array of messages (#622). Each entry renders as its own Discord message, with its own typed format and its own optional attachments. At most one message decides, and it posts last, so the buttons sit at the thread bottom. A send carries at most four messages, a `curia.yaml` default with a settings row. The prose message holds the answer to an operator note at up to 1600 characters, and a question of a round may carry a 600-character background block. A message exists when a reader would want to skip it on its own (#640). `send.mjs` is the contract, `composite.mjs` is the one renderer, and both surfaces read it: Discord posts each rendered message, and the Curia app's Chat screen draws the same sequence from the call the transcript carries, with the deciding message drawn as the card from the record (#716). A prose message leads with its conclusion in bold. See [ADR-0026](docs/adr/0026-the-composite-send.md).
_Avoid_: multi-part response, message batch.

**The rail**:
The one small-print line that opens every message of a composite send: its number in the send, then a label (#640). curia writes the count, so the reader knows how far the send runs before it asks. The agent writes the label, at most 20 characters, plain and descriptive, with no article. A send of one message carries no rail. The rail exists because Discord groups consecutive messages from one sender, so a send of three renders as one block with no seams.
_Avoid_: message header, caption, title.

**Lint grade**:
Which rules of `voice.md` a typed field is held to. Grade A is inline decision text: a hard character cap, one line, no markdown structure and no link. Grade B is block prose: a cap, at most 25 words per sentence, and no heading, table or blockquote. The `picture`, `table` and `diagram` fields take neither, because none of them is prose. curia checks a table's and a diagram's width, height and fence.
_Avoid_: strict lint, soft lint.

**Visual**:
A message format of a composite send, and since #640 that is all the word names. Three fields carry the forms #414 measured, on any message and on the `visual` format alike: `picture` for an image the reader looks at in place, `table` for a code-block table, and `diagram` for an ASCII drawing. A table and a diagram run to at most 42 columns by 20 lines, which is the phone limit from #414, and that sits under `CODE_BLOCK_LIMIT` so the block cap the lint already ships passes (#432). curia writes the fence, never the agent. A visual earns its space by removing prose (#415). The old single `visual` field is retired: one field could not check that a table's columns line up, because a diagram has no columns.
_Avoid_: figure, chart, the `visual` field.

**Attachments**:
The files an agent hands the operator to download, as workspace paths (`attachments`, renamed from `images` at #640, because the field has accepted `.patch`, `.diff`, `.md`, `.txt` and `.log` since it shipped). A file rides the message it belongs to, and the `files` format is the message for an artifact that stands alone. An attachment is what a reader downloads. A `picture` is what a reader looks at in place.
_Avoid_: images, uploads.

**Inbound message text**:
What the operator said, as against what Discord kept in the message ([#697](https://github.com/alp82/curia/issues/697)). Discord's client turns a body past 2000 characters into a short message plus a `message.txt`, so reading `content` alone read the first half of a long request and lost the rest silently. One seam composes the whole thing: the message body first, then each supported text attachment in the order Discord listed it, each segment exactly once. Every inbound path reads it - a top-level turn, a thread turn, an operator note, and an escalation answer - so the four cannot drift. Two caps bound it, a megabyte per file and a megabyte of attached text per message, and past either the file is refused BY NAME rather than truncated, because half a diff read as a whole one is the worse failure. A refusal is visible and costs only its own file: the body and every other segment still arrive, and a line names what is missing. Images are not its business - they keep the disk-path route. Lives in `daemon/src/inbound.mjs`.
_Avoid_: message content (that names the Discord field, which is only one of the segments).

**Ending report**:
What `report_result` puts in the thread, in the agent's own voice, as the first of the ending's two messages (#253, #419). It is typed: `headline` says what the work came to in one line, `summary` says what changed, and a `table`, a `diagram` and a `detail` are the agent's judgment. curia lays the parts out and appends the pull-request link. The same headline leads the resolution comment curia writes, and it becomes the gist of the map pointer. A cross-check reviewer's report is a **verdict** instead: it is typed on its own fields (#421), and it wears the 🔎 signal rather than the ✅ of an ending.
_Avoid_: final summary, result message.

**Status line**:
What `notify` puts in the thread, in the agent's own voice, while the work goes on (#420). It is typed: `message` says what happened, and a `table`, a `diagram` and a `detail` are the agent's judgment. Its `kind` says what the operator must DO, never how the agent rates its own news. `progress` needs nothing from them, `look` puts a file or a page in front of their eyes now, and `ask` wants a reply nothing is blocked on. A status line asks for no decision, so an agent that cannot go on without the answer calls `ask_human` instead.
_Avoid_: status update, progress ping.

**Lint gate**:
The voice check on agent prose that reaches a human, and the rejection that enforces it (#416, #438). The daemon lints against `daemon/assets/voice.md` and refuses the call with the lint message. The agent rewrites its own text and calls again. The daemon never rewrites it. Three rejections is the cap, and the daemon counts them, because an agent miscounts its own. See [ADR-0005](docs/adr/0005-escalation-contract.md).
_Avoid_: voice gate, prose check.

**Flagged send**:
What the lint gate does at the cap (#416). curia takes the fourth text as it stands, sends it, and shows the operator which rule it broke. The tool result says the text went out flagged and tells the agent not to call again. A flagged send is a delivered question, so it is never a failure to report.
_Avoid_: fallback, degraded send.

**Stop-hook catch**:
The lever that makes a rejection unmissable on codex (#438). On codex 0.146.0 a tool call sits inside the `exec` script, so a rejection is only a return value and it never throws. An agent that threw the value away believes its question went out and moves to end its turn. The Stop hook fires there, refuses the stop with `{decision:"block", reason}`, and hands back the lint message. At the second stop block curia sends the flagged text itself, so an agent that never calls again still delivers its question. The tool description and the memory-file line reach the model earlier, and both are prose that can be ignored. This one is the guarantee. A refused status line is the one call this never holds a turn for (#420): nobody waits on one, so curia posts the held text itself, flagged, and lets the turn end.
_Avoid_: hook fallback.

**Review gate**:
The one approval before a merge, and its own escalation kind. Only the daemon opens it, and it composes every link from its own records. The ✅ press posts a real GitHub approval on the pull request (#391), under the host `gh` login, because an app cannot approve for a human and GitHub refuses a self-approval. What GitHub carries is what the journal calls approved: a press whose approval fails reads as not approved to the agent, to the Stop hook and to `/status`. Branch protection on the watched repo is what makes the press binding, and it is the operator's own optional act: curia requires no setting in a watched repo, and nothing in the daemon reads the rule.

**Preview expectation**:
What the review gate asks of a change that has a page to look at (#735). A task is applicable when its diff digest carries at least one **source** file that renders a page — markup, styles, a component or a template; tests, docs and generated files never count, and neither does server code, schema or config. Curia reads that off the digest it already measured, never off the agent's account of its own work. An applicable gate with no preview is bounced once, with the rule and two ways on: publish one, or say in the summary why there is nothing to see. The second call opens the gate either way and the card carries the absence in the link's place. A backend-only task never meets it, and a diff curia could not count never triggers it.
_Avoid_: preview requirement, mandatory preview.

**Cross-check**:
The operator's third choice at the review gate. Curia spawns a reviewer on the other provider, and the verdict returns to the builder. The press answers neither way: nothing merges and nothing is rejected.

**Reviewer**:
The agent a cross-check spawns. It reads the diff, the ticket, and a checkout it can run. It writes nothing and it ends with its verdict.
_Avoid_: checker.

**Verdict**:
The reviewer's findings on one diff. It reaches the builder on its note queue, and it lands as a pull-request comment.

**Judgement**:
The builder's reading of a verdict. It agrees or disagrees with each finding and recommends what to do. It reaches the operator as one `ask_human` round, one question per finding, each carrying the builder's recommendation (#421). It is a plain question and never a gate, and it lands as the second pull-request comment.

**Parked**:
A builder idle inside its own `request_review` or `report_result` call while a cross-check reads. It holds its claim, its worktree and its slot, and it wakes when the verdict lands. The park itself lives in one process and leaves no record, so the boot sweep rebuilds it from the journal (#499): one of `cross_check_requested`, `cross_check_rejoined` and `result_parked` opens it, `cross_check_returned` closes it, and the count of the two over the last daemon's life says whether a builder is still inside. The opener also says which call it sits in, because a builder sent back to a gate it has passed is the loop #48 refused.

**Start notice**:
The message curia queues at the builder the moment a reviewer spawns. It names the reviewer and holds the ending: no resolve, no merge and no `report_result` until the verdict lands. A cross-check pressed at the gate sends none, because the builder is already parked.

**First-valid-wins**:
The answer rule. The first valid answer closes the escalation atomically. Any device may answer. Later answers get a refusal that carries the first **Answer receipt**, so the surface that lost the race shows the mark and never a second question (#712).

**Answer receipt**:
The one mark an answered card carries on every surface: who answered, on which surface, when, and the answer's own words. The Discord card edits it on, the Chat room and Home read it from the record, and a second answer gets it back in place of an error. See [ADR-0025](docs/adr/0025-the-cards-under-the-one-voice.md) and [#712](https://github.com/alp82/curia/issues/712).

**Option band**:
Which control a choice card earns from its option count, the same on Discord and the Curia app: two to four options are buttons that say the marker and the per-option handle, five to 25 are one select, and past 25 the numbered list stays and a reply names a marker. Every control sends the option index, and the daemon resolves the index to the option's own words, so a typed reply, a Discord press and an app tap record one answer. The card body keeps every consequence. See [ADR-0025](docs/adr/0025-the-cards-under-the-one-voice.md) and [#712](https://github.com/alp82/curia/issues/712).

**Reply files**:
The files an answer carries. Every card names the path they land in, `data/attachments/<escalation id>/`, whether the reply came from a Discord thread or a browser. A browser reply sends them inline through the sidecar, the daemon writes them under the bridge's own naming, and the paths ride the answer as the agent's readable form. See [#712](https://github.com/alp82/curia/issues/712).

**Supersede**:
A re-asked question closes the older record and routes late answers to the live one. The key is the agent and the kind, never the wording (#336). A re-send that explains itself in its own words is the same call, so it closes the original at birth. A confirm keys on the target instance instead. It reaches OPEN records only, so a question that is already answered is handled by the recorded answer (#369).

**Recorded answer**:
An answer a human gave to a question no live call could receive. `settle` finds no resolver, so the daemon parks question and answer on the agent's note queue (#139). A question re-asked word for word takes that answer back at once, while the note is still unread, and no second card opens (#369). The note leaves with the answer, so one fact is said once. The tool result names the record, the person and the moment, so the agent knows the answer is a recorded one. At the review gate the same rule needs the diff digest to match, or a fresh gate opens.
_Avoid_: replay, cached answer.

**Goodbye**:
The tool error the daemon sends to every blocked call before it dies (#458, deciding #426). Three deaths say it: `POST /restart`, a SIGTERM from a deploy, and a fatal crash. A SIGKILL says nothing, and the boot sweep is what reaches those agents instead. It is an error and never a text result, because the retry ladder needs a failure to retry and a text result reads as an answer. The words say three things: curia is restarting, the question is not answered, and how long to wait before asking again. The record stays open, so the agent asks again and takes back the recorded answer if one landed. It wakes both wait registries: the escalation resolvers and the cross-check park. One `daemon_goodbye` event carries the reason and the count.
_Avoid_: shutdown notice, drain.

**Boot sweep**:
The keystrokes a rebooted daemon types into the pane of a codex agent a SIGKILL stranded (#489, on #457's reading). That agent is blocked in a call the last process died holding, and it reads nothing until `CODEX_TOOL_TIMEOUT_S`, a day out. The sweep sends Escape, then the words 1.5 seconds later, on one line. Escape alone frees the agent and says nothing. The words alone sit in the composer until the dead call returns. Only the pair works. It runs after boot reconcile, and six facts gate it: the last daemon wrote no goodbye, a call was blocked on the record, no resolver holds it, a live pane is adopted under the record's agent name, the harness is codex, and the agent has not spoken to this process. A record carries whether a call was ever blocked on it, because the flagged send and the confirm open records nobody waits on, and their agents are working rather than parked. The claude lane needs nothing, because that client aborts a dropped call in about 120 seconds. One Escape per pane, whatever the record count. Every swept agent gets one line in its own ticket thread. `daemon_boot` and `daemon_goodbye` are the two lines that make a silent death readable. It sweeps two sets in one pass (#499), and the second is the builders parked on a cross-check verdict.
_Avoid_: revival, wake-up, nudge.

**Inherited exchange**:
Every question a human has answered on a ticket, written into the next dispatch's spawn prompt (#374). A prior answer is a parameter of this dispatch, so it lands in the prompt's parameters and never in the standing orders. The key is the session, which is `curia-<n>` for the ticket's whole life, so the push reaches every dispatch the ticket has had. It carries the question and the answer whole, and every kind, the review gate included. A cancelled, lapsed or superseded record holds no answer and does not appear. The block is capped, the newest survive, and the prompt says the words are recorded rather than fresh. It cures the re-ask a `resume` caused. The recorded answer cures the re-ask inside one dispatch, and the two never meet.
_Avoid_: history, prior context.

**Stale question**:
An escalation still open when its own agent reports a result (#336). The result closes it, because nothing can read an answer to it any more. Reconcile runs the same rule over the journal, and it runs the ending a Stop hook deferred to such a record. Silence closes nothing: only the agent's own result or its next call does.

**Render retry**:
The escalation's own second try at a Discord render that failed (#261). It runs at 1 minute, 5 minutes and 15 minutes after the record opened, then never again. The offsets count from `esc_open`, not from the failure, so a restart re-arms only the tries still ahead. After the last one the record stays open and REST-answerable, and the Curia app shows it either way.
_Avoid_: nudge (the half-hour re-post of an open escalation, deleted whole by #261).

**Bridge**:
The Discord module. It renders and captures. It never interprets.

**Thread-per-ticket**:
One Discord thread per ticket. It carries the ticket's escalations, notifies, and answers. The binding outlives the agent: it releases only when the ticket itself closes, so a resumed agent lands back in the same thread. Every path that resolves a thread goes back to the ticket's last thread first, and one ticket resolves one thread at a time, so a re-dispatch adds no second thread (#257). The name carries the state at a glance: 🎫 bound, ⏳ waiting on the operator, 🔎 holding a review gate, ✅ finished, ⚰️ cancelled.

**Held clear**:
The wait before a thread name goes back to 🎫 (#277). Discord answers every rename with a system line, and no flag suppresses it. Putting ⏳ or 🔎 on the name is worth that line, because the reader is away. Taking it off is not, because the reader just answered. So a clear waits two minutes, and any newer state cancels it. A ticket that asks another question inside the window spends no rename at all. The wait dies with the daemon.

**Settling a thread name**:
Putting the terminal glyph on a thread whose ticket has ended (#257). A rename rides a budget of 2 per thread per 10 minutes, so a ✅ can wait, and the gate that holds it dies with the daemon. Two passes catch what is dropped. A release settles the ticket's last thread even when the binding is already gone. Every bridge start settles each active thread curia once labeled that is bound to nothing and still wears a live glyph.

**Voice ownership**:
The rule that gives a ticket thread one `curia` identity. Work prose uses first person. Mechanics use small print. No fact appears twice. See [ADR-0021](docs/adr/0021-the-thread-formatting-and-the-one-voice.md).

**Failure line**:
The daemon's own message about a failure it hit. It is one sentence of prose, and the thread hears it once (#256). The raw error stays in the journal and in the reply the failing agent reads. A retry loop inside the repeat window adds nothing to the thread. A loop that outlasts the window says the line again with a count.
_Avoid_: error message (that names the raw text, which never reaches the thread).

**Speaker name**:
The webhook username for every ticket-thread message: `curia`. Builders and reviewers share the bot avatar. Session names remain internal routing identifiers (#690).

**Notify**:
A fire-and-forget opening, working phase, or milestone for the ticket thread. Routine phase updates edit the status line.
_Avoid_: status line (that names the daemon's own line, below).

**Operator note**:
Text the operator sends to one agent while no escalation is open. It belongs to the instance it was sent to and dies with it. It has two delivery modes, and the operator picks. A note typed in Discord is keyed on the thread it was typed in. A note sent from the console names the agent, because a browser has no thread. Both keyings reach one queue.
_Avoid_: message, comment.

**Queued**:
The default delivery mode. The note rides the agent's next tool result, and nothing owes a reply. The receipt carries the "Ask now" button, and no drain receipt follows.

**Ask now**:
The other delivery mode, and the button under the receipt that picks it. The current tool call gets a grace of a few seconds, then the note goes into the pane as a user turn. The agent's own reply is the outcome. [ADR-0013](docs/adr/0013-one-voice-per-fact.md) names the mechanics an interrupt, and so do the code and the journal.
_Avoid_: interrupt on the operator's surfaces (it reads as an ending, and no button ends an agent).

**Take back**:
The operator's undo of one of their own sent messages, and never of what curia or an agent said. On every chat it is the harness rewind, with a correction where a rewind cannot land. [ADR-0024](docs/adr/0024-the-overseer-chat-is-a-pane.md) moved the overseer conversation onto the same rewind, and the journal append of ADR-0023 retired. The floor is the first message: no press removes the invocation of the work. Curia enforces the floor itself, because claude offers landings below it. The world keeps what ran, and the receipt quotes the taken-back text and carries the landing point. See [ADR-0021](docs/adr/0021-the-take-back-is-the-harness-rewind.md) and [ADR-0024](docs/adr/0024-the-overseer-chat-is-a-pane.md).

**Verdict carrier**:
The whole verdict, posted into the thread when no agent is left to read it. It names the reviewer, its model, its findings and the pull request that holds the full text. A verdict is never mourned in one line.

### The ending

**Ending**:
The ordered close-out of a ticket: commit, pull request, preview, review gate, merge, resolve, result. One structure drives both the prompt and the Stop hook checklist.

**Ending receipt**:
The status line's final edit. Small print joins the tracker result, session teardown, and final meters. Chat and ticket links remain. See [ADR-0020](docs/adr/0020-the-thread-story.md).

**Charting ending**:
The ending of a map dispatch. It forks on one fact: did the session write a file? A session that wrote none ends on two steps. It edits the map, then it reports the result. A session whose research subagents wrote findings takes the ordinary ending for them: commit, pull request, review gate, merge, then close those research tickets. The Stop hook holds a session whose findings sit uncommitted under `docs/research/`, because an uncommitted file dies with the workspace. Curia posts the summary on the map either way. That comment states whether the findings reached the default branch. No unassign, and the map itself never closes.

**New-map ending**:
The charting ending with one step in front: create the map, adopt it with `map_created`, then report the result. The Stop hook holds the agent to the adoption, because it is the one fact the daemon cannot read for itself. Its research tickets land the same way a map dispatch's do.

**Stop hook**:
The enforcement hook that fires at the end of every agent turn. It refuses a stop that leaves ending steps open, up to the stop budget, then lets go and reports the ticket unfinished.

**Stop budget**:
How many times the Stop hook may refuse one agent's stop (`stop_nudge_budget`).

**Landing**:
The daemon's push of `curia/<n>` and the open or update of the one pull request per ticket. Agents never push.

**Workspace lease**:
The hold on a worktree and branch until the pull request is positively merged. Every uncertain case keeps the workspace. What is merged has landed, so anything still uncommitted at the end of the lease is captured onto a **salvage branch** before the worktree goes.

**Local-only work**:
Work that exists in no place but one private clone. Two kinds, and they stay two named predicates rather than one widened one: **unpushed commits**, which `hasUnpushedCommits` answers from `git rev-list --count`, and **uncommitted changes**, which `hasUncommittedChanges` answers from `git status --porcelain`. Untracked files count as work; the repo's `.gitignore` and the clone's own `.git/info/exclude` are what separate work from noise. The distinction is load-bearing because the cross-check callers ask about the pushed tip only, and a dirty tree is no reason to refuse a cross-check. Every guard curia had before [#649](https://github.com/alp82/curia/issues/649) read the first kind and was blind to the second. See [ADR-0028](docs/adr/0028-local-only-work-is-salvaged-before-a-clone-dies.md).

**Salvage branch**:
Where local-only work goes before curia destroys the clone holding it: `curia/<n>-salvage-<stamp>`, committed by curia and pushed. It accumulates and never overwrites, because a salvage that destroys the previous salvage is the same loss one level up. Cancel and the workspace lease capture one and then proceed; the orphan sweep keeps the clone instead; `start <n>` and `map <n>` both refuse over a surviving clone and name `resume <n>`. A push that fails keeps the clone and says so. Nothing deletes a salvage branch. It is a branch on the tracker rather than a patch on the box because a patch is what nobody reads. See [ADR-0028](docs/adr/0028-local-only-work-is-salvaged-before-a-clone-dies.md) and [#649](https://github.com/alp82/curia/issues/649).

**Repair**:
The daemon's completion of resolve-protocol steps the agent missed, recorded as repairs.

### Surfaces

**Attach**:
Joining a live agent from a device. One verb, two handles: the timeline link and the terminal link.

**Terminal surface**:
The shared ttyd page over Tailscale Serve. The raw TUI, honest for one device at a time.

**Timeline**:
The grid-free attach surface. It reads the agent's transcript and writes with tmux send-keys. The timeline is where you drive. The terminal is where you go to see the TUI itself.
The operator renamed this surface to **Chat** on [#514](https://github.com/alp82/curia/issues/514), one name for agent sessions and overseer conversations alike. The new name lands with the UX build, and until then the code keeps the old word. See [ADR-0020](docs/adr/0020-the-thread-story.md).

**Transcript**:
The harness's own append-only run log. It carries no geometry, so any device lays it out at its own width. The harness names the file after the session id, and a resume keeps that id, so one run is one file for its whole life.

**Finding a transcript**:
Two ways. What the config dir holds decides which one is right. An agent gets a config dir of its own, so the newest file in it by mtime is that agent's run. A conversation shares one config dir with every other conversation, so only the session id its key is bound to names its file. A key with no session id has no transcript. The honest answer there is nothing, and it is never the newest file. See [ADR-0016](docs/adr/0016-the-conversation-key.md) and the [live checks](docs/live-checks/332-transcript-by-key.md).

**Driven session**:
A timeline session curia sends through a driver of its own rather than as bare keystrokes. It names its own config dir and the session id of the conversation it serves, and the driver decides what a message means. The console chat is the first one. Since [#708](https://github.com/alp82/curia/issues/708) its driver is the pane message below, so the words do reach a pane in the end — as one paste, through the adapter, never as raw typing. A driven session still has no dialog guard and takes no key.

**Console chat**:
One conversation open in the Curia app's Chat room, at `#chat/<session>`. Since [#711](https://github.com/alp82/curia/issues/711) the app draws the transcript and the composer itself and reads the daemon's timeline listener through the sidecar. The timeline's own Serve rule retired with that ticket. The Chat picker in front of the rooms has a Tickets section and an Overseer section. An ended agent stays readable there and takes no new message. A parked conversation shows no parked state and returns on its next message.
_Avoid_: timeline page (retired), Chat screen for the room (the picker and the room are two views of one page).

**Conversation picker**:
The Chat screen of the Curia app. It lists the browser conversations, opens one, and starts a new one. Each row carries the conversation's own context percent, which is the one signal that a conversation is getting long. It lives in the Curia app and not in the chat page, because an agent opens that same page and a conversation switcher there would put console words on the agent surface. It reads `GET /api/console` on arrival, never on the poll. See [#333](https://github.com/alp82/curia/issues/333).

**Browser conversation**:
An overseer conversation the console chat speaks to, keyed `console-<n>` rather than on a Discord thread. The browser holds many, and the Chat screen serves one as the session `curia-console-<n>`. One brain answers both surfaces. The answer is never posted, because the transcript already carries it to the page. Its verbs run with no origin thread, so a confirm goes where a REST press sends it. See [ADR-0016](docs/adr/0016-the-conversation-key.md).
_Avoid_: browser thread (there is no Discord thread behind it, and there is more than one).

**Spent number**:
A browser conversation number that is used up. The daemon journals every key it mints, and it never mints one twice, so a delete spends that number for good. This is the one rule that separates a conversation number from a **Chat handle**: an agent is torn down whole and its index comes back, and a conversation is memory, so a reused number would wake the deleted conversation's own transcript. A delete forgets the key and leaves the file on disk. See [#333](https://github.com/alp82/curia/issues/333).

**Global search**:
One query over the four indexed sources: the GitHub facts, the decisions a map records under `## Decisions so far`, the journal, and the local chat transcripts. Discord thread bodies stay out of the first index, because Discord is the alert surface and its text is a copy of what the journal and the transcripts already hold. The lens button in every screen header opens it. See [#589](https://github.com/alp82/curia/issues/589) and `daemon/src/search.mjs`.

**Landing target**:
Where a search result opens, as typed data rather than a URL. A ticket hit and a chat hit land on `chat`, a map hit on `maps`, a journal hit on `feed`, and a decision hit on `github`, at its resolution comment. The query names the surface and its key, and the screen does the routing. A result row shows its kind, a two-line snippet, its age, and its landing word, and the lens overlay takes no navigation slot. A row that asks something of the operator (`needs_you`, the tracker's `ready-for-human` and `needs-info` labels, the journal's `warning`) shows that attention word in place of its kind. `open` and `closed` are not attention, so those rows keep their kind. See [#713](https://github.com/alp82/curia/issues/713).

**Preview**:
A tailnet HTTPS link to an agent's running dev server. The daemon allocates the public port and composes the link.

**Serve rule**:
One `tailscale serve` handler. It lives in tailscaled and outlives the daemon, so reconcile sweeps stale rules.

**Identity check**:
The rule every surface curia publishes through Serve admits a caller by: not a Funnel request, a Host this box serves, and a `Tailscale-User-Login` on the allowlist. Tailscale Serve stamps that login and overwrites a forged one, so a tailnet client cannot fake it. It fails closed. One allowlist covers the terminal, the timeline, previews and the Curia app alike. In the source deployment the allowlist is `identity.allow` in `curia.yaml`, and the sidecar reads it with the daemon's own rule. Under an installation root the allowlist is the **allowed operator** recorded in `state/tailscale.json` by the Tailscale card ([#877](https://github.com/alp82/curia/issues/877)), which the daemon fills into its live set and the sidecar reads from the daemon's `GET /identity`, so `curia.yaml`'s list admits nobody there and the two processes still admit the same people.

**First-operator window**:
The state of a packaged installation before an operator is confirmed: no login is on the allowlist, so the Curia app admits the first tailnet identity that opens it, and only to the Setup screen and its routes. The terminal, the chat, the timeline, previews, and every verb stay refused. The window opens only on the daemon's own word (`first_operator: true`), never on an allowlist that is merely empty because the daemon has not answered, and it closes the moment the Tailscale card records an operator ([#877](https://github.com/alp82/curia/issues/877)).

**Identity proxy**:
The daemon's loopback proxy that carries the identity check for a surface with nowhere to put one. The terminal's Serve rule points at the proxy, never at ttyd. A preview rule points at one of its own, never at the dev server, and its port is derived from the preview's Serve port. The timeline applies the same check in-process.

**Escalation overlay**:
Open escalations shown on the timeline from the daemon's record, because a transcript is silent while a question blocks.

**Dialog guard**:
The timeline's refusal to send text while a native terminal dialog holds the pane.

**Overview**:
The daemon's one loopback read of itself, `GET /overview`. It joins every section the Curia app draws. Sections include agents, escalations, health, usage, model credentials, warnings, journal events, settings, and deploy status. The Overview also carries the frontier snapshot and a map snapshot. The frontier snapshot is the **takeable** reading and nothing more; the map snapshot is the whole map. Each map snapshot includes history, agents, frontier facts, blockers, fog, counts, and its latest event stamp. Journal events and each Overview poll invalidate the map snapshot. The reconcile pass carried a second copy of every map until [#700](https://github.com/alp82/curia/issues/700) retired it, so one map reading answers to one name.

The map snapshot uses indexed journal questions and GitHub reads. The sidecar polls the Overview without holding secrets or journal access. Each section is nullable, so an unreadable section doesn't hide other sections.

**App console**:
The browser console for the box, on loopback `4273` and Serve `8445`. It draws the overview behind the same identity check every other surface uses.

**Read screen**:
A Curia app screen whose facts all come from the overview: home, agents, frontier, feed and credentials. The settings screen is the one that reads its own files. Two rules hold across all of them. Color marks attention and nothing else, so a state, a ticket type and a repo are told in words. The Maps progress rail is the deliberate exception: muted color and texture separate its five adjacent stages, but every stage also carries its name and count, and attention still has to be stated in words. Null is not empty, so an unreadable fleet never renders as an idle box and an uncomputed frontier never renders as an empty one.

**Maps screen**:
The Curia app screen for the open maps. Every fact on it comes from the **map snapshot** and from nowhere else, because two readings of one map drift. A map is one selectable card with a proportional miniature of the full five-stage rail: done, running, frontier, blocked and fog. Each stage gets exactly its count's share of the rail, including fog, while the headline fraction remains done over ticket total. Maps needing the operator lead the list, and calm maps follow by their latest event.

A **paused map** - one labelled `wayfinder:deferred` - is listed like any other, because hiding a pause is how a pause becomes a disappearance. What the pause costs it is the **start control**: a pause is only ever ended by hand, so the one surface that could dispatch work on a paused map says why it will not.

The detail half repeats the proportional rail at full size and shows every stage from top to bottom. Frontier leads the hierarchy: its double-height rows carry the routed model and a start control. Running shows active work and states when it needs the operator. Blocked names **every** blocker against restrained horizontal stripes, while fog uses low-contrast diagonal stripes. An empty stage is a sentence saying where the way went, never a blank. See [#588](https://github.com/alp82/curia/issues/588).

**Map detail route**:
The maps detail is a hash of its own, `#maps/<owner>/<name>/<number>`. Desktop shows the full rail beside the list; the phone shows it instead of the list, and the route is what gives that view a back, a refresh, and a link an operator can send. Old group-suffixed hashes remain readable bookmarks, but the group no longer changes the detail and newly written routes are map-only. Both halves always render and CSS decides which the width shows, the same rule the **drill-in section frame** follows. Arriving from the nav is always the list. See [#700](https://github.com/alp82/curia/issues/700).

**Credentials screen**:
The Curia app screen for the model credentials, one row per consumer: state, expiry, last refresh, why, and one action. It answers the question no other surface could take - what is the state of all three? - because the attention list is built to be empty and `valid` and `expiring` are silent by design. `unowned` is a ROW there rather than an absence. Two of the three rows are anthropic and read one provider-keyed store, so each row names its provider and one Sign-in press is offered once for the rows it heals. The live login is a **panel above the table**, never a row inside it: a flow with a countdown, a link, a code and a terminal fallback is a panel whatever it is called. Every row **restacks as a card below 640 px** with the action full width, because a six-column table at 390 px pushes the one button off the screen - on the device the whole no-ssh requirement exists for. There is no API-key field on it, and there is no field on it at all. See [#661](https://github.com/alp82/curia/issues/661) and the prototype that settled the shape, [#645](https://github.com/alp82/curia/issues/645).

**Answer surface**:
The Needs-you list on the home screen. It is the one place a question or the review gate is answered from the console. The agents table states what an agent waits on and answers none of it, so no operator has to remember which of two surfaces they are looking at. A model credential is the one item on it that is a **pointer** rather than a card: the detail lives on the Credentials screen, and saying it in both places is how two surfaces drift apart. What no operator act can end does not belong here at all - a spent usage window was never answerable, and [#677](https://github.com/alp82/curia/issues/677) moved it to the **Spent-window banner**.

**Feed screen**:
The journal tail read as attention ([#523](https://github.com/alp82/curia/issues/523), [#704](https://github.com/alp82/curia/issues/704)): one stream, newest first, at two altitudes. News - a gate, an ask, a verdict, a death, a deploy, a hold - draws at full size with a second line naming the ticket, the agent and the age. Every other event is a mechanic, compressed between the news and folded into one named group when four or more run together. Nothing is dropped, only paced. A needs-you row carries the amber wash and the words "Needs you". A 24-hour density strip heads the screen, family chips narrow it to one family, and each entry lands on the owning Chat, map, or GitHub record. The since-you-left marker is drawn at the **feed read stamp**: the instant each operator login last opened the Feed, journalled as the silent `feed_read` event and carried on the overview as `feed_reads`, so a phone and a laptop under one login agree and a cleared browser forgets nothing. Opening the Feed draws the marker at the previous stamp and posts this visit, and the marker holds still until the next visit.

**Needs-you count**:
`needsYou`, the one function behind the nav badge, the tab title, the Home tile and the Needs-you list header. It counts what an **operator act** ends: escalations, review gates, GitHub credential warnings, dispatch holds, and - since [#661](https://github.com/alp82/curia/issues/661) - the model credentials. **The count IS the list** since [#677](https://github.com/alp82/curia/issues/677): one function, `attentionItems`, yields the items, `needsYou` is its length, and the column draws the same array. It was a sum beside the list before that, and the two drifted twice - once when the credential pointer reached the list and not the sum, once on the spent window. A member class cannot reach one surface alone now. A spent usage window is neither counted nor listed: it rolls on its own clock, nobody can answer it, and the **Answer surface** is where a question is answered - so it is a **Spent-window banner** at the top of Home instead. The credential term counts **pointers, not consumers**: three dead rows behind one provider are one act reached by one visit, and the list shows one line for them. Nothing is hidden by the collapse - the pointer names every consumer behind it, and the screen states each one's own row.

**Spent-window banner**:
The standing line at the top of Home for a usage window at or past the spent mark, beside the pre-emptive hold and harder-colored than it: the hold is curia choosing to wait, and this is the account refusing. It is a **promotion** from the Needs-you list, not a demotion off it - before [#677](https://github.com/alp82/curia/issues/677) the hold at 93% had a standing banner while the window actually spent had a feed line that scrolled away, so the harder failure was the quieter one. It names the spent window's **own** roll instant, never the provider's soonest, and the provider strip's hot note follows the same rule: a 5h window spent for another four hours must not read as a 7d window rolling in twenty minutes. The latest spent window is the instant the operator waits on, because every spent window has to roll before the lane is whole.

**Diff digest**:
What curia measured about a change: the file total, the added total, the deleted total, and a per-file list of path, added lines, deleted lines, status letter and hunk count. It is a measurement and never prose, so it never becomes a second account of the work beside the agent's own gate summary. The review gate counts it ONCE, in the agent's own worktree, at the instant the gate opens, and stores it on the escalation record and on the `review_requested` event. Discord gets one line from it. The console draws the whole list from the stored copy, so no poll re-counts anything and the digest survives the agent dying. Null is not empty: a worktree that is gone makes the digest null with its reason, and the card says curia could not count this diff. See [#355](https://github.com/alp82/curia/issues/355) and [#808](https://github.com/alp82/curia/issues/808).
_Avoid_: diff (the digest is the numbers, not the patch).

**Rank rule**:
The order the digest lists files in: source first, then tests, then docs, and generated or lock files last, largest first inside each class. It decides which file opens expanded and nothing else. Every changed file is on the card with its own numbers, so the rank hides nothing. The card states the rule in these words, because a rank the operator cannot read is a rank they cannot check.

**Hunks**:
The patch text of one file, fetched on demand and never on the poll. The browser names a review gate and a file only by its place in the digest curia measured. The daemon resolves the worktree itself. A worktree that is gone falls back to the pull request's own diff and says so. A long file stops at a cap, states how many lines it did not show, and puts the GitHub link beside it.

**Operator verb**:
An act the console carries: start, answer, and the review gate. Each one is a POST to the sidecar, which composes the daemon call from the fields the page sends. A browser never hands over a command line. Start goes through the command seam the slash verbs use, so a press from the console journals the same event a typed command does. The Agents page carries no verb of its own (#709): a note, a cancel or a terminal handoff on one agent is a Chat act. The overseer's typed verbs and Chat's terminal own those actions, so the sidecar carries no duplicate note, cancel, or teleport route (#808).

**Optimistic transition**:
The Curia app's immediate, visibly pending projection of a valid operator verb before shared daemon evidence arrives. It bridges that gap only; daemon evidence confirms, advances, refuses, or fails the act for every client.
_Avoid_: optimistic state (the projection isn't confirmed state), loading state (the operator already acted).

**Routed model**:
The model a takeable ticket gets if it starts now. Reconcile computes it with the daemon's own precedence rule and joins it onto each frontier item, so the console names the account a press spends before spending it. It states what routing decides, not what a spawn does: cooling is read at the spawn, and the feed reports the chain it walked.

**Who pressed**:
The operator's Tailscale login, taken from the header the sidecar's identity check already reads and passed to the daemon as the `by` of every verb. Before the console, every REST verb journalled the word `rest`. The feed now names a person rather than a transport.

**Sidecar**:
The process that serves the Curia app. It runs beside the daemon and never inside it, so it stays up while the daemon restarts. It holds no secret: its container mounts the code and the config directory, and neither the journal nor the `.env.daemon`.

**Drill-in section frame**:
The shape of a Curia app page that is a list of sections. One list of section rows, each with a gist, and one open section beside it. A phone shows the list, and a pick replaces it with that section and a back link. A desktop shows both, and the back link is the only thing a width changes: the same HTML serves either, and nothing in the page script measures a viewport. A page registers one ordered array of sections in `DRILL_PAGES` and draws itself with `drillIn`. A section states a key, a title, a gist, a body, an optional `?` explanation, and an optional `enter` hook that takes a read of its own on arrival rather than on every poll. Settings is the first page in it. See [#699](https://github.com/alp82/curia/issues/699) and the accepted prototype, [#525](https://github.com/alp82/curia/issues/525).

**Settings screen**:
The one Curia app screen that writes, drawn in the drill-in section frame. Four sections, Routing first, then Projects, Dispatch and Maintenance. It reads `curia.yaml` and `routing.yaml` off disk, never from the poll snapshot, and posts back only what the operator changed. Each section also owns its own half of the write: it folds its unsaved edits into the save patch, counts them in the operator's own units, and names the key paths in them that a save cannot apply live. So a row landing later is added inside one section, or as a fifth section, and nothing outside that array has to be told about it.

**Settings save**:
The write itself, in two halves since [#866](https://github.com/alp82/curia/issues/866). The operator half goes to `config/config.yaml` through the operator configuration contract: the file's keys plus the keys the save names, judged by the contract and then by the daemon's own loader as the layer the daemon will read, and landed by one atomic rename. The routing half goes to `routing.local.yaml` through the yaml document API, so every hand comment survives, validated as a layer over the tracked file and renamed into place. Neither lands unless both pass. A refused save answers the loader's own message and leaves every file as it was. It refuses one thing of its own: the removal of a watched repo while an agent runs on it, named. That repo would drop out of reconcile, and nothing would cover the agent's claim. Under an installation root the app mounts nothing, so the sidecar sends the same read and the same save to the service's `GET` and `POST /settings` ([#880](https://github.com/alp82/curia/issues/880)), which run the same two halves on the root's `config/config.yaml` and `state/routing.local.yaml`; the service's `config/` mount is read-write for that one file, and the reload that applies the save follows as before.

**Base config**:
`config/curia.yaml` and `config/routing.yaml`. Git tracks both. They carry the shipped answer to every key. A ticket that adds a key adds it here, so the box gets that key with the code that needs it.

**Override config**:
`config/curia.local.yaml` and `config/routing.local.yaml`, beside the base files. Git ignores both. They hold what this box answers differently, and nothing else. The merge rule is two sentences. A mapping merges key by key. A list or a scalar replaces whole. The settings screen writes `routing.local.yaml` and drops a value that comes back to the base answer, removing an override file that holds nothing. Nothing writes `curia.local.yaml` since [#866](https://github.com/alp82/curia/issues/866): the settings it carried are operator configuration now, and the daemon reads it only as a hand override under `config/config.yaml`.

**A clean checkout**:
What `git status` on the box says on an ordinary day, and the reason the override exists. A save leaves the checkout clean, so a dirty tree means one thing: somebody hand-edited a tracked file there. The `deploy` verb refuses a dirty tree and names the files, because a fast-forward would refuse it later and the rollback would discard it.

**Save dock**:
The settings screen's dock, at the bottom. A clean screen carries no save chrome at all. The dock rises on the first edit with the change count, Save, a discard, and the restart the pending edits will need. The dock names that restart before the press, so an operator never learns about one from the outcome. After the press it stays in the same place and states what the daemon did with the save. Applied is one sentence and no button. Declined names the key that needs a restart and carries the restart. A daemon that is not answering carries no button, because a restart is not the mitigation for a process that is already down. A refusal moved nothing on disk and keeps the draft on screen. See [#699](https://github.com/alp82/curia/issues/699).

**Live reload**:
`POST /reload` runs on the daemon. It rereads both config files with the daemon's loaders. It applies `dispatch.auto_dispatch`, `dispatch.max_concurrent`, `dispatch.poll_interval_s`, and `dispatch.prototype_variations`. It also applies `watch`, `overseer.live_pane_cap`, `routing.defaults.<type>`, and `routing.models.<name>.active`. That set is closed. What a browser can't write, a browser can't apply. A reload applies every change or no change. If a loader rejects a file, the daemon applies nothing and returns the loader message. When any other key changes, the daemon applies nothing and names the key. The sidecar requests a reload after a write lands, and the daemon journals what moved. A stopped daemon misses nothing because boot reads the files.

**Restart**:
`POST /restart` on the daemon. It journals the order, answers, and exits 75. The supervisor respawns it, because a nonzero exit is what `restart: on-failure` acts on. Agent panes live in the tmux container, so they survive it. The sidecar orders the restart and never takes it. It is a rare act about a hand edit since the live reload: it lives in the Maintenance section, and it is what applies every key outside the closed set. It restarts THE DAEMON AND NOTHING ELSE: the sidecar, the tmux server, ttyd and the overseer service each keep running. So a setting one of those reads at its own boot is not reached by this button, and the operator who hand-edited one takes a deploy instead. The overseer needs neither, because it re-reads its config every turn. The sidecar's own ports and `identity.allow` are the set that needs the deploy.

**Maintenance section**:
The fourth section of the settings screen, reading last. One line says whether the daemon runs the files. It reads the values that `GET /overview` reports and the time when the daemon read them. One restart button sits beside the line. The button turns red only while the daemon and the files disagree. The Settings navigation item shows the same marker. The marker makes a stale daemon visible without opening the section.

**Model switch**:
`active: false` on a model in `routing.yaml`, behind the settings screen's "n of m models active". The entry keeps its provider, harness, id and comments, and leaves the dispatch vocabulary: no `defaults` row and no `review` row may name it, a fallback chain steps over it, and a `model:<x>` label naming it is refused. An absent key means on.

**Restarting marker**:
What the Curia app shows while the daemon does not answer. The page keeps the last snapshot, states its age, and names the reason. A page that blanks is worst exactly when the box is worst.

**Poll interval**:
`dashboard.poll_interval_s`, the age at which the sidecar re-reads the overview. It is a ceiling, not a clock: the sidecar reads only when a page asks and the snapshot is older than this. A browser asks while its tab is visible and stops when it is hidden. So a forgotten tab costs nothing, and many open tabs still cost one read. One read costs no journal read at all: what the overview says about the recent past is reduced in memory as events are written, so the price of a poll does not rise with the history.

**Status line**:
One Discord message per agent, written by the daemon, that says what the agent is doing now. It carries a state icon and the meters. It names no session, because the thread already says which ticket this is, and the `working` state is the icon alone. It sits at the bottom of the thread. A state change reposts it there, and so does every other post the bridge makes into that thread. The bridge reports each post, keyed by the thread it lands in. The line's own post reports nothing, so a move never triggers itself. The meter tick edits in place (#480).

**Meter**:
A number the status line carries beside the state: the model name, its reasoning effort, the context percent, and the account usage bars. Each meter has its own source and drops alone when that source is silent. Meters drop from the tail when the line runs out of columns. The model is the exception: the escalation title is cut to keep it.

**Account bars**:
The 5-hour and 7-day usage windows. They are an account fact, not an agent fact, so every agent on a provider shows the same reading. The provider follows from the agent's harness, never from the routing label: a label is a spawn-time fact and a harness has on-disk evidence. A window whose reset has passed rolls over — the bar shows the fresh window at 0%, and that reading counts as stale at once, so the next probe measures it. Every window also carries the instant it rolls. The status line has no room for a clock time and shows the pace instead. The overview carries the instant, and the Curia app prints it.

**Pace**:
Usage measured against the time already gone from its window. A bar shows the window's clock as `┃` and renders spending past it as overshoot. The square before the bar states the same fact at a glance: 🟩 behind the clock, 🟨 on it, 🟥 ahead.
_Avoid_: usage (that is the raw percent, which says nothing about speed).

**Context percent**:
How full an agent's context window is. The numerator is the last request's input tokens from the transcript. The denominator comes from the best source that has one: the window the codex transcript states, then `max_input_tokens` from `GET /v1/models/<id>` for the model id the claude transcript names, then `models.<name>.context_window`. It is never clamped — a figure above 100% says the denominator is wrong, not that the agent is full.

### State and evidence

**Action**:
One locally validated operator attempt to change shared state. Its identity stays the same across retries and every surface that reports its outcome.
_Avoid_: mutation, operation, request.

**Action evidence**:
A daemon-owned fact that says an Action was accepted, advanced, confirmed, refused, or failed. A browser projection and a transport outcome are not Action evidence.
_Avoid_: action state, HTTP result.

**Journal**:
Curia's durable record of its own events, append-only and in time order. It is the daemon's only durable artifact, and the reduction is derived from it. It is a `node:sqlite` database at `daemon/data/events.db`. To journal an event is to write one row of that record.
_Avoid_: store, event store, log (#358).

The name follows the record and not the medium, so the database IS the journal. One table holds all 96 event types. A row keeps the written line verbatim in `body`, so the journal is a superset of the file it replaced. The daemon holds the only write connection, and every other process reads it read-only. It runs WAL with `synchronous=full`. `daemon/src/journal.mjs` holds the schema, the writer and the migration. See [ADR-0017](docs/adr/0017-the-journal-is-a-queryable-store.md), built on [the journal map (#316)](https://github.com/alp82/curia/issues/316) and shipped at [#407](https://github.com/alp82/curia/issues/407).

The daemon asks the journal fifteen **questions** about its own past: what a dispatch has done since it started, what a session was spawned on, which map it adopted, what its ending said. Each one is an indexed query in `daemon/src/questions.mjs`, and the dispatcher read the whole journal for every one of them until [#408](https://github.com/alp82/curia/issues/408). Nothing hands out the whole journal now. The rules a question runs under: the id is the order and never the stamp, a `(ticket or agent)` test is two `exists` because one disjunction drops both keyed indexes, and an agent-keyed question resets at that session's last spawn line. See [The schema and the fourteen queries (#321)](https://github.com/alp82/curia/issues/321) and [the prototype](prototypes/journal-schema/).

**Journal backup**:
A gzipped `.dump` of the journal, under `daemon/data/backups/`. The daemon writes one a day and keeps fourteen ([#357](https://github.com/alp82/curia/issues/357), shipped at [#436](https://github.com/alp82/curia/issues/436)). It is portable SQL text, so it restores into any SQLite. It stays on the box, so it bounds a corrupt journal and a bad Node upgrade. It does not survive the loss of the box. A restore is a hand recipe in [the daemon README](daemon/README.md#the-restore), and curia ships no verb for it. The fourteen are a backup count. They are not journal retention, which stays undecided.
_Avoid_: snapshot, archive.

**aistack sync**:
The daemon's recurring publish of the box's rolling 30-day harness usage to the operator's measured layer on aistack.to ([#695](https://github.com/alp82/curia/issues/695)). It runs on the dispatch tick rather than on a clock of its own, and only while a machine credential sits at `<workspace_root>/home/.config/aistack/credentials.json`. Each run builds `CLAUDE_CONFIG_DIR` from every active directory under `<workspace_root>/cfg/` and points `CODEX_HOME` at the newest codex root, because a torn-down config directory takes its transcripts with it. The command is pinned by `aistack.cli_version`. A success journals `aistack_sync` and says nothing. A failure journals `aistack_sync_failed` and names the two commands that repair it. The registration itself is a one-time operator ceremony, in [the daemon README](daemon/README.md#registering-the-box). Aggregate token counts travel. Transcripts, prompts, and paths never do.
_Avoid_: telemetry, upload.

**aistack registration**:
The one-time act that turns the box into an aistack machine, and the switch the **aistack sync** reads ([#706](https://github.com/alp82/curia/issues/706)). It is a device-code login on the box plus an approval in a signed-in browser, and it ends with a bearer token in the credential file that no response body ever carries. Settings runs the login and shows its code and approval link; the approval itself stays a human act somewhere else, which is what [#695](https://github.com/alp82/curia/issues/695) settled. A registration alone does not publish: the standing auto-sync permission is a second act, `sync --auto on`. Both are in [the daemon README](daemon/README.md#registering-the-box). Say registration for the login and permission for the opt-in; they fail differently and they are repaired differently.
_Avoid_: connecting, linking, signing in.

**Journal file**:
`daemon/data/events.jsonl`, the medium the journal used before the `node:sqlite` database. It never rotated, so it only grew. A historical term since the migration. Name it only where the migration is discussed, and never as a synonym for the journal. The migration left it on disk, unwritten, as the floor a rollback landed on ([#323](https://github.com/alp82/curia/issues/323)). [#427](https://github.com/alp82/curia/issues/427) deleted it from the box, so no such file remains. A rollback regenerates it from `body` by [the daemon README recipe](daemon/README.md#the-rollback).

**Reduction**:
The daemon's in-memory state, rebuilt from the journal at boot and kept current by every append after it. Run every journal event in order through one function, and what you hold at the end is the reduction. That function is the reducer, and it runs on every event alike, at boot and on every append. The boot act is a **rebuild**, never a replay. Replay names sending a killed turn's message again.

It holds the open escalations, the agent notes, the ticket-to-thread bindings and the console conversations. It also holds the event tail, the outcomes, the pull requests and the armed limit resumes. It is a disposable cache and never a state home. A surface that answers about the recent past reads it, and never the journal.

It is not a subset of the journal. Three of its fields keep rows verbatim: the event tail, the outcomes, and the last event per agent. Everything else is computed, so one escalation record folds the opened, superseded, answered and closed rows into a single object no row holds.
_Avoid_: store, state, projection (#358).

Curia writes one name for one thing, so "store" names nothing in this domain. It survives as an ordinary English word only, as in the shared credential store of [ADR-0007](docs/adr/0007-shared-credential-store.md). The class `Reduction` in `daemon/src/reduction.mjs` holds the reduction, the class `Journal` in `daemon/src/journal.mjs` holds the record, and `Reduction#journal` is how the daemon journals an event. The old names were `EscalationStore` in `daemon/src/store.mjs` and `logEvent`, and [#407](https://github.com/alp82/curia/issues/407) renamed both.

The rebuild survived the move to `node:sqlite`, and it reads the journal instead of the file. Three fields could be queries. Every other field folds many rows into an object no row holds, and the reducer runs on every append anyway, so a query at boot would state each rule twice. The rebuild reads `select id, body from events where id > ? order by id limit 1000`, page by page. It orders by `id` and never by the stamp, because stamps tie. It reads `body`, which is verbatim, so it is the last reader that runs the [#184](https://github.com/alp82/curia/issues/184) translation. `EscalationStore._replay` is now `Reduction#rebuild`. The boot stays proportional to the whole history: about 44 ms today and about 2.4 seconds at 250,000 events, and the medium moves neither number. See [The boot replay (#322)](https://github.com/alp82/curia/issues/322) and [the prototype](prototypes/boot-replay/README.md).

**State home**:
The one durable place a fact lives. GitHub holds ticket truth. The journal holds curia's events. Everything in memory is a disposable cache.

**Secret file**:
One long-lived credential as one owner-only file under `secrets/` in the installation root, mode `0600`, written atomically, read by the service alone ([#867](https://github.com/alp82/curia/issues/867), implementing [#851](https://github.com/alp82/curia/issues/851)). A credential reaches a consumer through a file and never through an environment variable, a Compose variable, an argument, a log, a diagnostic, or a browser response. A renewable token (an installation token, an agent token) and a session-bound capability are not secret files: they live under `run/` and `work/`. The catalogue is `cli/src/secrets.mjs`.
_Avoid_: env var, env file, credential store (for the file itself; the store is the daemon's object that owns one).

**Source cutover**:
The one-time move of the source deployment on the box into a packaged Curia on a separate Ubuntu 24.04 host ([#889](https://github.com/alp82/curia/issues/889), implementing [#856](https://github.com/alp82/curia/issues/856)). It is a manual runbook, [The source cutover runbook](docs/operator/source-cutover-runbook.md), kept as the record of that cutover, and one script, `deploy/cutover/cutover.mjs`, with four verbs: `admit` (the accepted commit, a clean tree, the expected layout, no retired env key, no live session), `inventory` (the stopped source's identity, journal integrity and row bounds, every preserved file's hash, the four credentials by name), `transform` (a copied source into an installed root's `config/`, `secrets/`, `state/`, and `work/`, plus `state/migration.json`), and `validate` (the root against the manifest and the absence of source paths). The operator stops and starts, copies over SSH, verifies the cards, and runs the Full loop that accepts. Rollback is restarting the unchanged source. `curia install` contains none of it, and no other source deployment is promised a migration.
_Avoid_: migration utility, migration product, legacy migration (for the runbook); the cutover is one operation on one deployment.

**Reconcile**:
The pass, at boot and on demand, that re-derives live state from GitHub, tmux, and the journal, and asserts the surfaces. An agent it re-adopts gets its spawn-time facts back from the journal: the routing label it runs on, and the harness under it.

**Epoch**:
A ticket's latest dispatch. Journal reads count only events from the latest epoch.

**Spawn line**:
An `agent_spawned` event. It describes the agent whole, as it runs from that moment. One dispatch writes more than one of them, because a respawn down the fallback chain writes another. A respawn states every dispatch-time fact again, so the last line wins for every reader.

**Orphan**:
A live `curia-` session that every watched repo positively disowns. Reconcile sweeps it, unless it holds a result or unpushed work.

**Dead claim**:
A claim with no live session and no close behind it. Reconcile releases it, unless an open pull request marks the ticket awaiting review.

**Evidence rule**:
A failed read is not evidence. Only a positive "absent" narrows a set. Anything else is indeterminate and fails the pass.

**Live check**:
A first-person report of what an agent experienced during a live run, committed under `docs/live-checks/`.

**Prototype**:
Throwaway code that answers one named question, under `prototypes/`. The `prototype` skill writes it, and curia uses that skill's word for it. It rides the ticket's own `curia/<n>` branch, and the merge lands it on main. A header names its ticket, and the ticket's resolution comment holds the verdict. See [ADR-0008](docs/adr/0008-resolved-means-merged.md).

## Components

One box runs everything. Phones and PCs are pure clients on the tailnet.

- **Daemon** (`daemon/`): one Node process, no build step. It owns dispatch, escalations, routing, previews, the attach surfaces, and reconcile.
- **Bridge**: the Discord module inside the daemon. Thread-per-ticket rendering, buttons, attachment passthrough both directions.
- **Router**: the deterministic command router inside the daemon. It parses the five verbs from Discord slash commands or REST.
- **Agents**: one harness process per ticket, in tmux sessions named `curia-<n>`. A cross-check adds a reviewer beside one, in `curia-review-<n>`.
- **Bootstrap** (`deploy/bootstrap/curia-install.sh`): the one Bash script an operator downloads and runs to install Curia on a host with no Node.js, or to purge an installation ([#872](https://github.com/alp82/curia/issues/872), implementing [#862](https://github.com/alp82/curia/issues/862) and [#855](https://github.com/alp82/curia/issues/855)). It is published as the release asset `curia-install.sh`, the same script on every release, and selects the version from the stable-release index. It refuses to run as root or from a pipe, downloads the package, the pinned Node.js runtime, the bundle, the checksum, the manifest, and the index completely into one temporary stage, proves each in the shell, then has the staged package prove the index signature, the selection, and the release manifest with its own code, and only then hands off to `curia install` or `curia purge` on the staged runtime with `CURIA_ROOT` (and, for an installation, `CURIA_STAGE`) set. The operator's view is [docs/operator/bootstrap.md](docs/operator/bootstrap.md).
- **Lifecycle interface** (`cli/`): the `@curia-sh/cli` package. It owns `curia install`, `reinstall`, `update`, `rollback`, `doctor`, `uninstall`, and `purge`, and it carries no service code. The stable launcher at `~/.local/bin/curia` reads the installation record and runs the lifecycle interface of the active version on that version's pinned runtime under `versions/<version>/`. `curia install` ([#873](https://github.com/alp82/curia/issues/873)) is seven named steps, `preflight`, `root`, `tailnet`, `stage`, `activate`, `start`, and `health`, each idempotent by inspection so a rerun lands at the step that failed, and `curia reinstall` is the same sequence over a recognized root, keeping its installation ID, `config/`, `secrets/`, `state/`, and `work/`. The `tailnet` step (`cli/src/tailnet.mjs`, [#891](https://github.com/alp82/curia/issues/891)) joins the tailnet during installation, before anything is downloaded: the operator names the node with `--name <machine-name>` (default `curia`, a MagicDNS label), a logged-in node is reported and not renamed there (the Tailscale card renames it later), a logged-out node is brought up with `tailscale up --hostname <name>` and the login link is printed on the terminal as the one action (the app is reachable only through Tailscale Serve, so the login cannot happen in the browser), and then the operator permission and the certificate are checked, each a refusal that names the exact `sudo tailscale set --operator=<user>` command or the tailnet's HTTPS setting. `curia reinstall`, `curia update`, and `curia rollback` run the same step inspect-only and log nothing in. `cli/src/compose.mjs` is the one seam to Docker Compose: `run/compose.env`, `pull`, `up`, and the health wait over the five services. `curia doctor` ([#881](https://github.com/alp82/curia/issues/881)) composes the same modules read-only into one report. `curia update` ([#883](https://github.com/alp82/curia/issues/883)) is six named steps, `preflight`, `select`, `acquire`, `stage`, `validate`, and `switch`: it selects from the stable-release index, acquires and proves every artifact of the target (`cli/src/acquire.mjs`), stages it beside the active version through the same `placeVersion` install uses (`cli/src/stage.mjs`), has the target validate the current configuration, and switches the live installation to it through `switchRelease` (`cli/src/switch.mjs`, [#884](https://github.com/alp82/curia/issues/884)), which recreates the three core services, proves health, version, and session re-adoption, activates atomically, and keeps one rollback release. `curia rollback` ([#885](https://github.com/alp82/curia/issues/885)) is four named steps, `preflight`, `select`, `validate`, and `switch`: the same door with the versions swapped, after the rollback release validated the configuration. `curia uninstall` ([#886](https://github.com/alp82/curia/issues/886)) is four named steps, `preflight`, `docker`, `routes`, and `files`: it removes the installation's Docker resources by the `sh.curia.installation` label through `cli/src/resources.mjs`, withdraws Curia's own Serve routes through `cli/src/tailscale.mjs` (which also holds the `state/tailscale.json` reader and writer the service uses), empties the three replaceable directories, removes the launcher, and prints the preserved root with the bootstrap commands that reinstall or purge it. `curia purge` ([#887](https://github.com/alp82/curia/issues/887)) is six named steps, `preflight`, `confirm`, `docker`, `routes`, `images`, and `root`: the same teardown after one confirmation that names the exact root, then the release images Docker proves unused (`removeReleaseImages` in `cli/src/resources.mjs`), the launcher, and the root last, with an identifier-only report of the external resources it never deletes. The operator's view is [docs/operator/command-reference.md](docs/operator/command-reference.md), [docs/operator/install.md](docs/operator/install.md), [docs/operator/update.md](docs/operator/update.md), [docs/operator/rollback.md](docs/operator/rollback.md), [docs/operator/uninstall.md](docs/operator/uninstall.md), and [docs/operator/purge.md](docs/operator/purge.md).
- **Sidecar** (`daemon/bin/curia-dashboard.mjs`): the Curia app's own Node process, in its own container. It imports the daemon's identity check, config rules and Serve helper, and reads the daemon over loopback.
- **Surfaces**: the shared ttyd terminal, the timeline and the Curia app, all published with Tailscale Serve. Previews take their own port range.
- **Config** (`config/`): the operator configuration and two shipped layers. `config.yaml` is the operator configuration, written by the settings screen and by hand, read through `cli/src/config.mjs`, and ignored by git. `curia.yaml` (watch list, dispatch, attach, dashboard, skills) and `routing.yaml` (models, defaults, fallbacks, the cross-check pairing) are the base, hand-edited and tracked in git. `curia.local.yaml` and `routing.local.yaml` beside them hold hand overrides, and git ignores them. The daemon reads a base file, the override over it, and for `curia.yaml` the operator configuration over both: a mapping merges key by key, a list or a scalar replaces whole. The settings screen writes `config.yaml` and `routing.local.yaml`, never a tracked file, which is what keeps the box's checkout clean. The tracked files are written in the form the yaml document API prints back unchanged, so an edit rewrites the lines it changed and no others. A trailing comment takes one space before the `#`, and a comment block belongs above its key rather than after it.

## State homes

- **GitHub**: ticket state, labels, claims, sub-issue parentage, map bodies, branches, pull requests. The source of truth.
- **Journal** (`daemon/data/events.db`): every durable curia event, in a `node:sqlite` database ([ADR-0017](docs/adr/0017-the-journal-is-a-queryable-store.md)). The daemon converted at its first boot on [#407](https://github.com/alp82/curia/issues/407), and it left `daemon/data/events.jsonl` on disk for the rollback ([#323](https://github.com/alp82/curia/issues/323)). [#427](https://github.com/alp82/curia/issues/427) deleted that file, so a rollback regenerates it from `body`. A daily gzipped `.dump` under `daemon/data/backups/` bounds what the journal itself can lose, and fourteen are kept ([#357](https://github.com/alp82/curia/issues/357), shipped at [#436](https://github.com/alp82/curia/issues/436)). That copy is a backup and never a second state home.
- **Verdicts** (`daemon/data/verdicts/`): one captured cross-check verdict per ticket, held for the return path.
- **Preview registry** (`daemon/data/previews.json`): each preview allocation. Boot recovery probes its dev server before it restores the identity proxy and Serve rule.
- **tmux**: the live agent sessions.
- **tailscaled**: the Serve rules for attach, timeline, the Curia app, and previews.
- **Workspace root** (`~/curia-work`): private clones, review checkouts, agent config dirs, the overseer's checkouts under `overseer/repos/`, and curia's own `HOME` under `home/`. The checkouts are a cache of origin and nothing else, so deleting one costs a re-clone and no work.
- **Curia's credential stores** (`<workspace_root>/home/.claude`, `.codex`, `.config/gh`, `.gitconfig`, `.config/aistack`): the daemon's own, and curia's rather than the operator's since [#473](https://github.com/alp82/curia/issues/473) — the compose stack reads no tree out of the box owner's home. No agent container reaches them, and how each consumer gets a credential instead is the **Model credential** entry above: the daemon writes the codex one into each live agent's config dir and refreshes it on the tick ([ADR-0027](docs/adr/0027-the-daemon-owns-model-credentials.md)), and writes the anthropic one into each live claude agent's config dir and into the overseer's on the same tick ([#648](https://github.com/alp82/curia/issues/648), [#867](https://github.com/alp82/curia/issues/867)). See [ADR-0007](docs/adr/0007-shared-credential-store.md).
- **Secret files** (`<root>/secrets/`): in an installed Curia, the four long-lived credentials as one owner-only file each — `discord-bot-token`, `github-app.json`, `anthropic.json`, `codex-auth.json` — read and written through `cli/src/secrets.mjs` and mounted into the service alone ([#867](https://github.com/alp82/curia/issues/867)). The service refuses to boot with a credential in its environment. `cfg.paths` (`daemon/src/paths.mjs`, from `cli/src/layout.mjs`) is where every process learns the paths: `state/` for the journal, `work/` as the workspace root, `cache/home` as `HOME`, `cache/overseer-repos`, `run/overseer-tokens`. The operator's page is [Secrets, mounts, and what survives](docs/operator/secrets.md).
- **docker**: the live agent containers and the two shared cache volumes.

Everything else is a cache that reconcile can rebuild.

## Docs

- `docs/adr/`: one file per standing decision, indexed at `docs/adr/README.md`.
- `docs/research/`: research notes, one per investigation, indexed at `docs/research/README.md`.
- `docs/operator/`: the operator guide for an installed Curia. `docs/operator/README.md` is the index, `docs/operator/guide/` holds the ten lifecycle topics in the accepted guided-lifecycle structure ([#888](https://github.com/alp82/curia/issues/888), implementing [#858](https://github.com/alp82/curia/issues/858)), and the pages beside the index are the reference pages the topics link to at the point of use. `daemon/test/operatorguide.test.mjs` keeps every relative link, anchor, command name, and option in those pages true to the tree and to `cli/src`.
- `docs/live-checks/`: first-person agent evidence.
- `docs/agents/`: tracker, triage, and domain-doc conventions for agents.
- `docs/full-loop.md`: the rehearsal record of the PoC map. History, not a live procedure.
- `docs/github-app.md`: the operator's own checklist for the GitHub App. Nothing on it can be done by an agent.

The tracker holds history. The docs hold what still constrains work.
